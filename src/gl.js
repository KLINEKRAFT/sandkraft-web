// The thin layer over WebGL2 that everything else takes.
//
// Deliberately small: this is a game, not an engine. It knows how to build a
// program, make a float texture, and hand back a framebuffer.

export class GLError extends Error {}

export function getContext(canvas) {
    const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,        // we resolve our own edges with the ink pass
        depth: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
    });
    if (!gl) {
        throw new GLError('This browser has no WebGL2. On iPhone that means iOS 15 or newer.');
    }

    // Rendering *to* a float texture is an extension even in WebGL2, and the
    // solver cannot work without one of these two. Full float is worth asking
    // for first: sand depth is a length in metres, and half float runs out of
    // mantissa around a millimetre, which is visible as drift in a tall wall.
    const full = gl.getExtension('EXT_color_buffer_float');
    const half = full ? null : gl.getExtension('EXT_color_buffer_half_float');
    if (!full && !half) {
        throw new GLError('This GPU cannot render to floating-point textures, which the sand solver needs.');
    }

    return { gl, floatRenderable: !!full };
}

function compile(gl, type, source, label) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || '';
        // Number the lines. A GLSL error that says "line 214" is useless when
        // the shader was assembled from template literals.
        const numbered = source.split('\n')
            .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
            .join('\n');
        throw new GLError(`${label} failed to compile:\n${log}\n\n${numbered}`);
    }
    return shader;
}

export function program(gl, vertexSource, fragmentSource, label = 'program') {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label} (vertex)`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} (fragment)`);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new GLError(`${label} failed to link:\n${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Cache uniform locations up front. Looking them up per frame is a string
    // hash per uniform per draw, and it shows on a phone.
    const uniforms = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
        uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { handle: p, uniforms, label };
}

/// A texture the solver can both read and be rendered into.
export function floatTexture(gl, width, height, floatRenderable) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internal = floatRenderable ? gl.RGBA32F : gl.RGBA16F;
    const type = floatRenderable ? gl.FLOAT : gl.HALF_FLOAT;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null);
    // NEAREST throughout, on purpose. Every filtered read in this project is
    // done by hand in the shader, which means the sampler never has to change
    // between the solver and the renderer.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
}

/// An 8-bit colour target the hardware will filter for you.
///
/// Deliberately not a float texture. What goes in here is two occlusion terms
/// in 0..1, and eight bits is more resolution than three-band shading can show.
/// What it buys is that RGBA8 is both colour-renderable *and* linearly
/// filterable everywhere — which the float textures in this project are not,
/// and which is the whole reason every other sampler here reimplements bilinear
/// by hand. One `texture()` tap instead of four `texelFetch`es, in a shader
/// that already samples the ground four times to rebuild its normal.
export function colorTexture(gl, width, height) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
}

export function framebuffer(gl, texture) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new GLError(`Framebuffer incomplete (0x${status.toString(16)}).`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
}

/// Colour + depth, for the scene pass. The depth attachment is a *texture*
/// rather than a renderbuffer because the ink pass has to read it.
export function sceneTarget(gl, width, height) {
    const color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0,
                  gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new GLError(`Scene framebuffer incomplete (0x${status.toString(16)}).`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { fbo, color, depth, width, height };
}

export function bindTexture(gl, prog, name, unit, texture) {
    const loc = prog.uniforms[name];
    if (loc == null) { return; }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc, unit);
}
