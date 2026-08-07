// Undo.
//
// The whole state of a beach is one float texture and a short list of props, so
// a step of history is a copy of both. The copy is the interesting part: the
// obvious way to take it is `sim.snapshot()`, which is already written and which
// would be a disaster here — it is a `readPixels` of a megabyte and a half, it
// stalls the pipeline until the GPU catches up, and it would run on *every*
// stroke whether or not anybody ever pressed undo.
//
// `blitFramebuffer` copies GPU-side and the CPU never waits. It is the one thing
// WebGL2 has that WebGL1 did not which makes this feature free.
//
// Depth is a handful of steps, not unlimited: each slot is the size of the sand
// field, and a phone is not the place to keep a hundred of them.

import { floatTexture, framebuffer } from './gl.js';

export class History {
    constructor(gl, resolution, floatRenderable, depth = 8) {
        this.gl = gl;
        this.resolution = resolution;
        this.floatRenderable = floatRenderable;
        this.depth = Math.max(1, depth);

        this.stack = [];        // oldest first; the last entry is the next undo
        this.free = [];         // slots to reuse, so undo does not churn textures
    }

    get length() { return this.stack.length; }

    makeSlot() {
        const tex = floatTexture(this.gl, this.resolution, this.resolution, this.floatRenderable);
        return { texture: tex, fbo: framebuffer(this.gl, tex), props: [] };
    }

    /// Remember the beach as it is right now. Call this *before* the thing that
    /// changes it, and once per user action rather than once per frame — a
    /// stroke is one undo, not two hundred.
    push(sim, props) {
        const slot = this.stack.length >= this.depth
            ? this.stack.shift()                       // the oldest falls off the back
            : (this.free.pop() || this.makeSlot());

        this.blit(sim.frontFBO, slot.fbo);
        slot.props = props.snapshot();
        this.stack.push(slot);
    }

    /// Put the most recent remembered beach back. False if there is none.
    pop(sim, props) {
        const slot = this.stack.pop();
        if (!slot) { return false; }

        this.blit(slot.fbo, sim.frontFBO);
        props.replaceAll(slot.props);

        // Anything the mould was still queuing belongs to the action being
        // undone. Leaving it would let a block land on the beach a frame after
        // it was taken away.
        sim.stampQueue.length = 0;

        this.free.push(slot);
        return true;
    }

    /// Throw away the newest entry without restoring it. For an action that
    /// captured a step and then turned out not to change anything.
    drop() {
        const slot = this.stack.pop();
        if (slot) { this.free.push(slot); }
    }

    clear() {
        this.free.push(...this.stack);
        this.stack.length = 0;
    }

    blit(from, to) {
        const gl = this.gl;
        const n = this.resolution;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
        gl.blitFramebuffer(0, 0, n, n, 0, 0, n, n, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
}
