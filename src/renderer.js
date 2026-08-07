// One frame: sky, beach, sea, ink.
//
// Everything draws into an offscreen colour+depth target, and the ink pass reads
// that depth back to find silhouettes. That is the only reason the scene is not
// drawn straight to the canvas.

import { program, sceneTarget, bindTexture } from './gl.js';
import { FULLSCREEN_VS } from './shaders/sim.js';
import {
    TERRAIN_VS, TERRAIN_FS,
    WATER_VS, WATER_FS,
    SKY_FS, COMPOSITE_FS,
} from './shaders/render.js';
import { PROP_VS, PROP_FS } from './shaders/props.js';

const gridVertexCount = (edge) => (edge - 1) * (edge - 1) * 6;

export class Renderer {
    constructor(gl, quality) {
        this.gl = gl;
        this.quality = quality;

        this.pSky = program(gl, FULLSCREEN_VS, SKY_FS, 'sky');
        this.pTerrain = program(gl, TERRAIN_VS, TERRAIN_FS, 'terrain');
        this.pWater = program(gl, WATER_VS, WATER_FS, 'water');
        this.pComposite = program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
        this.pProps = program(gl, PROP_VS, PROP_FS, 'props');

        // WebGL2 refuses to draw without a bound vertex array, even when the
        // shaders read no attributes at all. One empty VAO for the whole app.
        this.vao = gl.createVertexArray();

        this.scene = null;
        this.outline = 1.0;
    }

    resize(width, height) {
        const gl = this.gl;
        if (this.scene && this.scene.width === width && this.scene.height === height) { return; }
        if (this.scene) {
            gl.deleteFramebuffer(this.scene.fbo);
            gl.deleteTexture(this.scene.color);
            gl.deleteTexture(this.scene.depth);
        }
        this.scene = sceneTarget(gl, width, height);
    }

    draw(sim, camera, env, props, cursor, light) {
        const gl = this.gl;
        const { width, height } = this.scene;
        const domainSpan = 96;

        gl.bindVertexArray(this.vao);

        // The light table first, before anything is bound to the screen. It
        // reads the same sand texture the beach is about to be drawn from, so
        // baking it here rather than last frame is what stops a tower's shadow
        // arriving a frame after the tower.
        light.bake(sim, env);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
        gl.viewport(0, 0, width, height);
        // Alpha clears to zero because alpha is the ink mask, not opacity.
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // --- Sky. Depth writes off; it is the background and everything else
        //     is allowed to draw over it.
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.useProgram(this.pSky.handle);
        gl.uniform2f(this.pSky.uniforms.uViewport, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);       // the sand is a sheet; both sides count

        const viewProj = camera.viewProj;
        const cell = domainSpan / sim.resolution;

        // --- Beach. The skirt first, depth-biased back so its coarse triangles
        //     lose every argument with the fine ones at the border.
        gl.useProgram(this.pTerrain.handle);
        const t = this.pTerrain.uniforms;
        gl.uniformMatrix4fv(t.uViewProj, false, viewProj);
        gl.uniform3fv(t.uSunDir, env.sunDir);
        gl.uniform3fv(t.uCamera, camera.eye);
        gl.uniform1f(t.uSeaBase, env.seaBase);
        gl.uniform1f(t.uTime, env.time);
        gl.uniform1f(t.uCell, cell);

        // The tool ring. Set once for both terrain draws — the fine grid and
        // the skirt share this program, and the ring should not stop at the
        // border of the playable square.
        if (cursor && cursor.alpha > 0.01) {
            gl.uniform4f(t.uCursor, cursor.x, cursor.z, cursor.radius, cursor.alpha);
            gl.uniform4f(t.uCursor2, cursor.shape, cursor.active, cursor.pulse, 0);
            gl.uniform3fv(t.uCursorTint, cursor.tint);
        } else {
            gl.uniform4f(t.uCursor, 0, 0, 1, 0);
            gl.uniform4f(t.uCursor2, 0, 0, 0, 0);
        }

        bindTexture(gl, this.pTerrain, 'uField', 0, sim.front);
        bindTexture(gl, this.pTerrain, 'uBedrock', 1, sim.bedrock);
        bindTexture(gl, this.pTerrain, 'uLight', 2, light.texture);

        // Inner grid FIRST, skirt second — which is the opposite of the obvious
        // order and roughly halves the fragment cost over the middle of the
        // screen.
        //
        // The two overlap: the skirt is a full sheet and the fine grid sits
        // inside it, so every pixel of the playable square used to be shaded
        // twice. Drawing the fine grid first and then biasing the skirt *away*
        // means the skirt's fragments over that square fail the depth test and
        // are rejected before the fragment shader runs — and this shader is
        // expensive, four ground samples per pixel to rebuild the normal. The
        // picture is identical because the fine grid won those pixels anyway.
        gl.uniform1i(t.uEdge, this.quality.terrainGrid);
        gl.uniform1f(t.uOuter, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, gridVertexCount(this.quality.terrainGrid));

        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2.0, 4.0);
        gl.uniform1i(t.uEdge, this.quality.skirtGrid);
        gl.uniform1f(t.uOuter, 1.0);       // also clears this pass's ink mask
        gl.drawArrays(gl.TRIANGLES, 0, gridVertexCount(this.quality.skirtGrid));
        gl.polygonOffset(0, 0);
        gl.disable(gl.POLYGON_OFFSET_FILL);

        // --- Props. Before the sea and with depth writes on, so a bucket
        //     standing in the shallows is correctly drowned by it rather than
        //     floating on top. Alpha-tested, never blended.
        if (props && props.count > 0) {
            props.upload();
            gl.useProgram(this.pProps.handle);
            const pu = this.pProps.uniforms;
            gl.uniformMatrix4fv(pu.uViewProj, false, viewProj);
            gl.uniform3fv(pu.uSunDir, env.sunDir);
            gl.uniform3fv(pu.uCamRight, camera.right);
            bindTexture(gl, this.pProps, 'uField', 0, sim.front);
            bindTexture(gl, this.pProps, 'uBedrock', 1, sim.bedrock);
            bindTexture(gl, this.pProps, 'uProps', 2, props.texture);
            bindTexture(gl, this.pProps, 'uLight', 3, light.texture);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, props.count);
        }

        // --- Sea. Alpha blended over the beach, depth-tested but not written,
        //     so the foam edge stays a soft ramp instead of a stair.
        gl.enable(gl.BLEND);
        // Colour blends normally; alpha is forced to zero wherever the sea
        // covers something, because alpha is the ink mask and inking a wave
        // silhouette against the sand it is washing over looks like a mistake.
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ZERO);
        gl.depthMask(false);
        gl.useProgram(this.pWater.handle);
        const w = this.pWater.uniforms;
        gl.uniformMatrix4fv(w.uViewProj, false, viewProj);
        gl.uniform1i(w.uEdge, this.quality.waterGrid);
        gl.uniform1f(w.uTime, env.time);
        gl.uniform1f(w.uSeaBase, env.seaBase);
        gl.uniform1f(w.uWaveAmp, env.waveAmplitude);
        bindTexture(gl, this.pWater, 'uField', 0, sim.front);
        bindTexture(gl, this.pWater, 'uBedrock', 1, sim.bedrock);
        bindTexture(gl, this.pWater, 'uLight', 2, light.texture);
        gl.drawArrays(gl.TRIANGLES, 0, gridVertexCount(this.quality.waterGrid));

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        // --- Ink and out.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(this.pComposite.handle);
        const c = this.pComposite.uniforms;
        gl.uniform2f(c.uTexel, 1 / width, 1 / height);
        gl.uniform1f(c.uOutline, this.outline);
        bindTexture(gl, this.pComposite, 'uColor', 0, this.scene.color);
        bindTexture(gl, this.pComposite, 'uDepth', 1, this.scene.depth);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindVertexArray(null);
    }
}
