// The prop list, and the data texture the vertex shader reads it out of.
//
// A uniform array would have been simpler and is the wrong shape: GLES3
// guarantees only 256 vertex uniform vectors, two of which every prop would
// claim, so a uniform array puts a hard and rather low ceiling on how much you
// can decorate a beach. A data texture has no such limit and costs one
// texelFetch per vertex.

import { floatTexture, framebuffer } from './gl.js';

export const PROP_KINDS = [
    { id: 'flag',     glyph: '🚩', size: 1.9 },
    { id: 'bucket',   glyph: '🪣', size: 1.2 },
    { id: 'spade',    glyph: '🥄', size: 1.5 },
    { id: 'shell',    glyph: '🐚', size: 0.9 },
    { id: 'starfish', glyph: '⭐', size: 1.0 },
    { id: 'umbrella', glyph: '⛱️', size: 3.2 },
];

export const MAX_PROPS = 192;

export class Props {
    constructor(gl) {
        this.gl = gl;
        this.list = [];
        this.dirty = true;

        // RGBA32F, two texels per prop. Not renderable and never rendered into —
        // it is only ever uploaded to, so the format needs no extension.
        this.data = new Float32Array(MAX_PROPS * 2 * 4);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_PROPS * 2, 1, 0,
                      gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    get count() { return this.list.length; }

    add(kindIndex, x, z) {
        if (this.list.length >= MAX_PROPS) { this.list.shift(); }
        const kind = PROP_KINDS[kindIndex] || PROP_KINDS[0];
        this.list.push({
            kind: kindIndex,
            x, z,
            rotation: 0,
            // Size and colour wobble a little per prop. Six identical flags in a
            // row look placed; six slightly different ones look left.
            size: kind.size * (0.85 + Math.random() * 0.3),
            tint: Math.floor(Math.random() * 4),
        });
        this.dirty = true;
    }

    /// Remove whatever is nearest the point, within `radius`. The undo a
    /// placement tool actually needs.
    removeNear(x, z, radius = 2.5) {
        let best = -1, bestD = radius * radius;
        for (let i = 0; i < this.list.length; i++) {
            const p = this.list[i];
            const d = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) { this.list.splice(best, 1); this.dirty = true; return true; }
        return false;
    }

    clear() { this.list.length = 0; this.dirty = true; }

    replaceAll(entries) {
        this.list = entries.slice(0, MAX_PROPS).map((p) => ({
            kind: p.kind | 0,
            x: +p.x, z: +p.z,
            rotation: +p.rotation || 0,
            size: +p.size || 1,
            tint: +p.tint || 0,
        }));
        this.dirty = true;
    }

    /// Serialisable form, for the save slots.
    snapshot() {
        return this.list.map((p) => ({
            kind: p.kind, x: p.x, z: p.z, rotation: p.rotation, size: p.size, tint: p.tint,
        }));
    }

    upload() {
        if (!this.dirty) { return; }
        const gl = this.gl;
        for (let i = 0; i < this.list.length; i++) {
            const p = this.list[i];
            const k = i * 8;
            this.data[k + 0] = p.x;
            this.data[k + 1] = p.z;
            this.data[k + 2] = p.rotation;
            this.data[k + 3] = p.kind;
            this.data[k + 4] = p.size;
            this.data[k + 5] = p.tint;
            this.data[k + 6] = 0;
            this.data[k + 7] = 0;
        }
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_PROPS * 2, 1,
                         gl.RGBA, gl.FLOAT, this.data);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.dirty = false;
    }
}
