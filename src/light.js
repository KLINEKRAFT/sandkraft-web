// Owns the light table and re-bakes it once a frame.
//
// Once a *frame*, not once at startup, because the thing casting the shadows is
// the thing you are digging: a moat has to darken as it deepens and a tower has
// to throw a shadow the moment it is turned out. That is only affordable because
// the table is small and screen-independent — see shaders/light.js.

import { program, colorTexture, framebuffer, bindTexture } from './gl.js';
import { FULLSCREEN_VS } from './shaders/sim.js';
import { LIGHT_FS } from './shaders/light.js';

export class SunLight {
    /// `resolution` is texels along one edge of the 96 m square. 256 is about
    /// 0.37 m per texel — coarser than the sand, on purpose. A cartoon shadow
    /// wants a soft edge, and the terrain samples this through a hardware
    /// bilinear tap that softens it further.
    constructor(gl, resolution = 256) {
        this.gl = gl;
        this.resolution = resolution;
        this.program = program(gl, FULLSCREEN_VS, LIGHT_FS, 'sun_light');
        this.texture = colorTexture(gl, resolution, resolution);
        this.fbo = framebuffer(gl, this.texture);
    }

    bake(sim, env) {
        const gl = this.gl;

        // This runs between the solver and the scene pass, so it inherits
        // whatever state either of them left. Say what it needs rather than
        // hope: the light table is a flat write with nothing to test against.
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.depthMask(false);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, this.resolution, this.resolution);
        gl.useProgram(this.program.handle);
        gl.uniform1f(this.program.uniforms.uResolution, this.resolution);
        gl.uniform3fv(this.program.uniforms.uSunDir, env.sunDir);
        bindTexture(gl, this.program, 'uField', 0, sim.front);
        bindTexture(gl, this.program, 'uBedrock', 1, sim.bedrock);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.depthMask(true);
    }
}
