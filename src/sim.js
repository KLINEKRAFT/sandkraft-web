// The Swift side of Sim.metal, in JavaScript: owns the two sand textures, bakes
// the hardpack once, and drives the substeps.

import { program, floatTexture, framebuffer, bindTexture } from './gl.js';
import { FULLSCREEN_VS, BEDROCK_BAKE_FS, SIM_INIT_FS, SIM_STEP_FS } from './shaders/sim.js';

export const TOOL = {
    none: 0, dig: 1, pour: 2, pack: 3, wet: 4, wall: 5, flatten: 6,
    // Not solver tools — handled entirely on the CPU, but they live in the same
    // enum so the UI has one vocabulary.
    mould: 20, prop: 21, erase: 22,
};

export const MOULD_SHAPE = { tower: 0, block: 1, cone: 2 };

export class SandSim {
    /// `resolution` is texels along one edge of the 48 m square. The native
    /// build runs 256-640 by quality tier; on a phone in a browser, 256 is the
    /// honest ceiling for a 60 Hz frame with four substeps.
    constructor(gl, floatRenderable, resolution = 256) {
        this.gl = gl;
        this.resolution = resolution;
        this.floatRenderable = floatRenderable;

        // The hardpack table, 144 m across. At 768 texels that is 187 mm —
        // finer than the simulation grid at every tier, which is the only
        // relationship that matters.
        this.bedrockResolution = 768;

        this.pBake = program(gl, FULLSCREEN_VS, BEDROCK_BAKE_FS, 'bedrock_bake');
        this.pInit = program(gl, FULLSCREEN_VS, SIM_INIT_FS, 'sim_init');
        this.pStep = program(gl, FULLSCREEN_VS, SIM_STEP_FS, 'sim_step');

        this.bedrock = floatTexture(gl, this.bedrockResolution, this.bedrockResolution, floatRenderable);
        this.bedrockFBO = framebuffer(gl, this.bedrock);

        this.front = floatTexture(gl, resolution, resolution, floatRenderable);
        this.back = floatTexture(gl, resolution, resolution, floatRenderable);
        this.frontFBO = framebuffer(gl, this.front);
        this.backFBO = framebuffer(gl, this.back);

        // The stroke, as a segment. `ax,az` is where it was last step and
        // `bx,bz` where it is now; the solver sweeps between them.
        this.stroke = {
            ax: 0, az: 0, bx: 0, bz: 0,
            radius: 3.0, strength: 0, tool: TOOL.none,
            shape: 0,                 // 0 round, 1 square
            baseY: 0,                 // ground height where the stroke began
            parameter: 1.2,           // wall height, mostly
        };

        this.stamp = null;
        this.stampArmed = false;

        this.bakeBedrock();
    }

    /// The hardpack never changes, so it is derived once and read back for the
    /// rest of the session. Baked here rather than on the first reset because
    /// `sim_init` reads it, and so does every pass in every frame — a table that
    /// only becomes correct after a beach has been laid down is a trap.
    bakeBedrock() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bedrockFBO);
        gl.viewport(0, 0, this.bedrockResolution, this.bedrockResolution);
        gl.useProgram(this.pBake.handle);
        gl.uniform1f(this.pBake.uniforms.uResolution, this.bedrockResolution);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Keep a copy on the CPU while the framebuffer is still bound.
        //
        // This is what the picking ray marches against, and reading the baked
        // table back is why the CPU never has to reimplement the noise — a
        // second copy of `bedrock()` in JavaScript would drift from the GLSL one
        // the first time either was touched, and the symptom would be sand
        // appearing a metre from your finger.
        const N = this.bedrockResolution;
        this.heightMirror = null;
        try {
            const buf = new Float32Array(N * N * 4);
            gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, buf);
            if (gl.getError() === gl.NO_ERROR) { this.heightMirror = buf; }
        } catch (e) {
            // Half-float fallback devices may refuse a FLOAT read. Picking drops
            // to a fixed plane, which is worse but not broken.
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /// Ground height at a world position, from the CPU mirror.
    ///
    /// This is the *pristine* shore — hardpack plus the bed the tide left — not
    /// the live field, so a tower you built yourself is not in it. That is the
    /// honest limit of picking without a readback per frame, and it costs
    /// nothing where the game is actually played: the working pad is flat.
    groundAt(x, z) {
        const mirror = this.heightMirror;
        if (!mirror) { return 1.0; }

        const N = this.bedrockResolution;
        const E = 72.0;                       // must match BEDROCK_EXTENT in common.js
        const gx = ((x + E) / (2 * E)) * (N - 1);
        const gz = ((z + E) / (2 * E)) * (N - 1);
        if (!(gx >= 0 && gz >= 0 && gx <= N - 1 && gz <= N - 1)) { return 0.0; }

        const i0 = Math.floor(gx), j0 = Math.floor(gz);
        const i1 = Math.min(i0 + 1, N - 1), j1 = Math.min(j0 + 1, N - 1);
        const fx = gx - i0, fz = gz - j0;

        // .r is the hardpack and .g the loose bed; their sum is the surface.
        const at = (i, j) => {
            const k = (j * N + i) * 4;
            return mirror[k] + mirror[k + 1];
        };

        return (at(i0, j0) * (1 - fx) + at(i1, j0) * fx) * (1 - fz)
             + (at(i0, j1) * (1 - fx) + at(i1, j1) * fx) * fz;
    }

    /// Lay down a fresh beach.
    reset(seaBase = -0.35) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFBO);
        gl.viewport(0, 0, this.resolution, this.resolution);
        gl.useProgram(this.pInit.handle);
        gl.uniform1f(this.pInit.uniforms.uResolution, this.resolution);
        gl.uniform1f(this.pInit.uniforms.uSeaBase, seaBase);
        bindTexture(gl, this.pInit, 'uBedrock', 0, this.bedrock);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /// Advance the solver. `dt` is the whole frame's worth of time, divided
    /// across the substeps internally.
    step(dt, substeps, env) {
        const gl = this.gl;

        // Cap the frame's simulated time. A stall — a phone call, the app coming
        // back from the background — must not deliver half a second of avalanche
        // in one go and knock the castle over while nobody was looking.
        const clamped = Math.min(dt, 1 / 20);
        const sub = clamped / substeps;

        gl.viewport(0, 0, this.resolution, this.resolution);
        gl.useProgram(this.pStep.handle);

        const u = this.pStep.uniforms;
        const s = this.stroke;
        gl.uniform1f(u.uResolution, this.resolution);
        gl.uniform1f(u.uDt, sub);
        gl.uniform1f(u.uSeaBase, env.seaBase);
        gl.uniform1f(u.uWaveAmp, env.waveAmplitude);
        gl.uniform1f(u.uErosion, env.erosion);
        gl.uniform4f(u.uBrushA, s.ax, s.az, s.radius, s.strength);
        gl.uniform4f(u.uBrushB, s.bx, s.bz, s.baseY, s.parameter);
        gl.uniform1i(u.uTool, s.tool > 6 ? 0 : s.tool);
        gl.uniform1i(u.uBrushShape, s.shape);

        const st = this.stampArmed ? this.stamp : null;

        for (let i = 0; i < substeps; i++) {
            gl.uniform1f(u.uTime, env.time + sub * i);

            // The mould lands on exactly one substep. Firing it on every substep
            // would turn out four towers a millimetre apart, which reads as one
            // very strange tower.
            if (st && i === 0) {
                gl.uniform4f(u.uStamp, st.x, st.z, st.radius, st.height);
                gl.uniform4f(u.uStamp2, st.shape, st.rotation, 1, st.baseY);
            } else {
                gl.uniform4f(u.uStamp, 0, 0, 0, 0);
                gl.uniform4f(u.uStamp2, 0, 0, 0, 0);
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.backFBO);
            bindTexture(gl, this.pStep, 'uField', 0, this.front);
            bindTexture(gl, this.pStep, 'uBedrock', 1, this.bedrock);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // Ping-pong. The just-written texture becomes the one everybody
            // reads, so the renderer never sees a half-solved field.
            [this.front, this.back] = [this.back, this.front];
            [this.frontFBO, this.backFBO] = [this.backFBO, this.frontFBO];
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        if (st) { this.stampArmed = false; this.stamp = null; }

        // The stroke's tail catches up with its head, so the next frame sweeps
        // from here rather than from wherever the finger first went down.
        s.ax = s.bx;
        s.az = s.bz;
    }

    // ------------------------------------------------------------------ input

    /// Begin a stroke. `baseY` is the ground height under the first touch, and
    /// it is what Wall builds up from and Flatten levels toward — sampled once,
    /// so a wall stays at one height instead of following the ground it is
    /// crossing.
    beginStroke(x, z, { tool, radius, shape = 0, parameter = 1.2, baseY = 0 }) {
        const s = this.stroke;
        s.ax = s.bx = x;
        s.az = s.bz = z;
        s.tool = tool;
        s.radius = radius;
        s.shape = shape;
        s.parameter = parameter;
        s.baseY = baseY;
        s.strength = 0;             // eased in by extendStroke
    }

    /// Continue a stroke. `ramp` is 0..1 and is what stops a tap from gouging:
    /// the tool arrives over about a fifth of a second instead of at full rate
    /// on the first frame.
    extendStroke(x, z, ramp = 1) {
        const s = this.stroke;
        s.bx = x;
        s.bz = z;
        s.strength = Math.max(0, Math.min(1, ramp));
    }

    endStroke() {
        this.stroke.strength = 0;
        this.stroke.tool = TOOL.none;
    }

    /// Arm a mould to be turned out on the next step.
    armMould({ x, z, radius, height, shape, rotation = 0 }) {
        this.stamp = { x, z, radius, height, shape, rotation, baseY: this.surfaceAt(x, z) };
        this.stampArmed = true;
    }

    /// The *live* surface height at a world point: baked hardpack from the CPU
    /// mirror, plus a one-texel readback of the sand standing on it.
    ///
    /// A one-pixel readPixels stalls the pipeline, which is why this is never
    /// called per frame — only when a mould is placed, which is once per tap.
    /// It is worth the stall: without it a tower stamped on top of an existing
    /// mound sinks into it, because the mirror only knows the pristine shore.
    surfaceAt(x, z) {
        const gl = this.gl;
        const base = this.groundAt(x, z);          // hardpack + pristine bed
        if (!this.floatRenderable) { return base; }

        const uvx = (x + 48) / 96, uvz = (z + 48) / 96;
        if (uvx < 0 || uvx > 1 || uvz < 0 || uvz > 1) { return base; }

        const tx = Math.min(this.resolution - 1, Math.max(0, Math.floor(uvx * this.resolution)));
        const tz = Math.min(this.resolution - 1, Math.max(0, Math.floor(uvz * this.resolution)));

        try {
            const px = new Float32Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFBO);
            gl.readPixels(tx, tz, 1, 1, gl.RGBA, gl.FLOAT, px);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (gl.getError() !== gl.NO_ERROR) { return base; }
            // The mirror's .r is the hardpack; swap its pristine bed for the
            // live depth we just read.
            return this.bedrockAt(x, z) + px[0];
        } catch (e) {
            return base;
        }
    }

    /// Hardpack alone, from the CPU mirror.
    bedrockAt(x, z) {
        const mirror = this.heightMirror;
        if (!mirror) { return 0; }
        const N = this.bedrockResolution, E = 72.0;
        const gx = Math.round(((x + E) / (2 * E)) * (N - 1));
        const gz = Math.round(((z + E) / (2 * E)) * (N - 1));
        if (gx < 0 || gz < 0 || gx > N - 1 || gz > N - 1) { return 0; }
        return mirror[(gz * N + gx) * 4];
    }

    // ------------------------------------------------------------ save / load

    /// The whole field, for a save slot. RGBA32F, resolution² texels.
    snapshot() {
        const gl = this.gl;
        if (!this.floatRenderable) { return null; }
        const n = this.resolution;
        const buf = new Float32Array(n * n * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.frontFBO);
        gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, buf);
        const ok = gl.getError() === gl.NO_ERROR;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return ok ? buf : null;
    }

    /// Put a saved field back. Refuses a mismatched resolution rather than
    /// uploading it at the wrong stride and shredding the shore.
    restore(field, resolution) {
        if (resolution !== this.resolution) { return false; }
        const gl = this.gl;
        const n = this.resolution;
        if (!field || field.length !== n * n * 4) { return false; }
        gl.bindTexture(gl.TEXTURE_2D, this.front);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RGBA, gl.FLOAT,
                         field instanceof Float32Array ? field : new Float32Array(field));
        gl.bindTexture(gl.TEXTURE_2D, null);
        return true;
    }
}
