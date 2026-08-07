// The picture.
//
// Cartoon here means four specific things, and each one is a decision rather
// than a filter laid over a realistic renderer:
//
//   · light is quantised into three bands, not smoothly integrated;
//   · the palette is flat and saturated, and shadow is a *hue shift* toward
//     violet rather than the same colour multiplied down — that one change is
//     most of what separates "cartoon" from "underexposed";
//   · every silhouette gets an ink line, found in screen space from depth;
//   · the sea is two tones and a band of foam, with no specular at all.
//
// There are no vertex buffers. Positions come out of gl_VertexID and the height
// comes from a vertex texture fetch of the live simulation, so the geometry
// cannot lag the sand by a frame and there is nothing to upload.

import { COMMON } from './common.js';

const GRID = /* glsl */ `
/// vertex_id -> a cell and a corner; two counter-clockwise triangles per cell.
/// The divisor is (edge - 1) so the grid corners land on the domain corners
/// rather than on texel centres.
vec2 gridUV(int vid, int edge) {
    int quad = vid / 6;
    int k    = vid - quad * 6;
    int W    = max(edge, 2) - 1;
    int cx   = quad % W;
    int cy   = quad / W;

    ivec2 o;
    if      (k == 0) { o = ivec2(0, 0); }
    else if (k == 1) { o = ivec2(1, 0); }
    else if (k == 2) { o = ivec2(0, 1); }
    else if (k == 3) { o = ivec2(1, 0); }
    else if (k == 4) { o = ivec2(1, 1); }
    else             { o = ivec2(0, 1); }

    return vec2(ivec2(cx, cy) + o) / float(W);
}

/// The power-warped sheet that carries the world out past the playable square.
/// Shared by the beach skirt and the sea so the two can never disagree about
/// where the world ends. The exponent concentrates triangles near the player.
vec2 skirtPosition(vec2 uv) {
    vec2 s = uv * 2.0 - 1.0;
    return vec2(0.0, -8.0) + sign(s) * pow(abs(s), vec2(2.6)) * 380.0;
}
`;

// ------------------------------------------------------------------- terrain

export const TERRAIN_VS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
${GRID}

uniform mat4  uViewProj;
uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform int   uEdge;
uniform float uOuter;        // 0 inner grid, 1 skirt

out vec3 vWorld;
out vec3 vSand;              // depth, moisture, packing
out float vInside;

void main() {
    vec2 uv = gridUV(gl_VertexID, uEdge);
    vec2 wp;
    vec4 S = vec4(0.0);
    float drop = 0.0;
    bool offField = false;

    if (uOuter > 0.5) {
        // The skirt. Inside the domain it samples the *same* field as the inner
        // grid, so the two can never diverge; and it is sunk below the real
        // surface over the last couple of metres of the border, so its coarse
        // triangles cannot saw up through the fine ones at the shoreline.
        wp = skirtPosition(uv);
        vec2 duv = worldToUV(wp);
        bool ins = all(greaterThan(duv, vec2(0.0))) && all(lessThan(duv, vec2(1.0)));
        if (ins) { S = sandSmooth(uField, clamp(duv, 0.0, 1.0)); }
        else     { offField = true; }
        vec2 dd = min(duv, 1.0 - duv);
        drop = 0.55 * smoothstep(0.0, 0.045, max(0.0, min(dd.x, dd.y)));
        vInside = ins ? 1.0 : 0.0;
    } else {
        wp = uvToWorld(uv);
        S = sandSmooth(uField, uv);
        vInside = 1.0;
    }

    // One tap, taken after wp is settled, serving both the hardpack and — off
    // the simulated square — the loose bed standing on it.
    vec2 bed = bedrockPair(uBedrock, wp);
    if (offField) { S.r = bed.y; }

    float y = bed.x + S.r - drop;

    vWorld = vec3(wp.x, y, wp.y);
    vSand  = S.rgb;
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const TERRAIN_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}

uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform vec3  uSunDir;
uniform vec3  uCamera;
uniform float uSeaBase;
uniform float uTime;
uniform float uCell;
uniform float uOuter;

// The tool cursor.
//
// uCursor:     xy = centre in world metres, z = radius, w = opacity 0..1
// uCursor2:    x = footprint (0 round, 1 square), y = 1 while the tool is
//              actually working, z = tap flare 0..1
// uCursorTint: the tool's colour
uniform vec4 uCursor;
uniform vec4 uCursor2;
uniform vec3 uCursorTint;

in vec3 vWorld;
in vec3 vSand;
in float vInside;

out vec4 outColor;

/// Three bands with soft shoulders. Hard steps alias into a staircase along
/// every dune crest; a narrow smoothstep at each edge costs nothing and the
/// picture still reads as flat colour.
float bands(float x) {
    float b = 0.0;
    b += smoothstep(0.16, 0.22, x);
    b += smoothstep(0.46, 0.52, x);
    b += smoothstep(0.74, 0.80, x);
    return b / 3.0;
}

void main() {
    vec2 wp = vWorld.xz;

    // Macro normal, rebuilt by central-differencing the smoothed field. No
    // vertex normals exist anywhere in this renderer — the geometry is faceted
    // at texel scale while the shading stays continuous, and that combination is
    // what makes a heightfield read as sand rather than as a mesh.
    float e = max(uCell, 1e-3);
    float hl = groundY(uField, uBedrock, wp - vec2(e, 0.0));
    float hr = groundY(uField, uBedrock, wp + vec2(e, 0.0));
    float hd = groundY(uField, uBedrock, wp - vec2(0.0, e));
    float hu = groundY(uField, uBedrock, wp + vec2(0.0, e));
    vec3 N = normalize(vec3(hl - hr, 2.0 * e, hd - hu));

    float moisture = vSand.g;
    float packing  = vSand.b;

    // Off the simulated square there is no field, only a moisture that rises as
    // the ground nears the waterline — so the skirt wets and dries with the tide.
    if (vInside < 0.5) {
        moisture = smoothstep(0.45, -0.30, vWorld.y - uSeaBase);
        packing = 0.0;
    }

    float wet = clamp(moisture * 1.05, 0.0, 1.0);

    // ------------------------------------------------------------- palette
    vec3 dry    = vec3(0.976, 0.831, 0.549);
    vec3 dryAlt = vec3(0.929, 0.741, 0.451);
    vec3 damp   = vec3(0.760, 0.545, 0.361);

    // A little large-scale mottling so a flat beach is not a flat fill. One
    // noise lookup, quantised into the same bands as the light.
    float mottle = bands(vnoise(wp * 0.24));
    vec3 albedo = mix(dry, dryAlt, mottle * 0.65);
    albedo = mix(albedo, damp, wet * 0.85);

    // Packed sand reads slightly cooler and denser.
    albedo = mix(albedo, albedo * vec3(0.93, 0.93, 0.98), packing * 0.35);

    // -------------------------------------------------------------- light
    float NoL = max(dot(N, uSunDir), 0.0);
    float key = bands(NoL);

    // Shadow as a hue shift, not a multiply. Violet in the dark, warm in the
    // light — this is the single biggest difference between a cartoon and a
    // photograph with the exposure pulled down.
    vec3 lit   = albedo * vec3(1.06, 1.02, 0.94);
    vec3 shade = albedo * vec3(0.62, 0.62, 0.82);
    vec3 col = mix(shade, lit, key);

    // A rim of sky along every upward edge. Cheap, and it separates a dune from
    // the sea behind it without needing an outline there.
    vec3 V = normalize(uCamera - vWorld);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += vec3(0.24, 0.34, 0.42) * rim * 0.5;

    // The swash line: a band of darker, shinier sand right at the waterline,
    // which is what tells you where the sea has just been.
    float sl = seaLevelAt(uSeaBase, uTime);
    float swash = smoothstep(0.55, 0.0, abs(vWorld.y - sl - 0.06));
    col = mix(col, col * vec3(0.72, 0.76, 0.84), swash * 0.55);

    // ---------------------------------------------------------- the tool ring
    //
    // Painted onto the sand rather than drawn as a separate overlay pass, which
    // buys three things for free: it lies over dunes and down into holes instead
    // of floating flat above them, the sea covers it where the sea covers the
    // sand, and it costs one branch in a shader that is already running.
    //
    // What it shows, from the outside in: the rim is the edge of the brush, the
    // inner ring is BRUSH_CORE — where the tool is at full strength — and the
    // pip is where the stroke is aimed.
    if (uCursor.w > 0.01) {
        vec2 dv = wp - uCursor.xy;
        float d = (uCursor2.x > 0.5) ? max(abs(dv.x), abs(dv.y)) : length(dv);
        float r = max(uCursor.z, 0.25);

        // A tap flares the ring outward and then it settles back.
        float q = d / (r * (1.0 + 0.11 * uCursor2.z));

        // One pixel wide in q, whatever the camera is doing. Without this the
        // ring crawls with moire the moment you pull the camera back.
        float aa = max(fwidth(q), 0.0015);
        // The band is about a third of a metre wide in world terms whatever the
        // radius, so a nine-metre brush does not come with a nine-metre hoop.
        float band = clamp(0.34 / r, 0.020, 0.11);

        float t = abs(q - 1.0);
        float rim = 1.0 - smoothstep(band - aa, band + aa, t);
        float ink = max((1.0 - smoothstep(band * 1.8 - aa, band * 1.8 + aa, t)) - rim, 0.0);

        float ct = abs(q - BRUSH_CORE);
        float core = 1.0 - smoothstep(band * 0.6 - aa, band * 0.6 + aa, ct);
        float coreFill = 1.0 - smoothstep(BRUSH_CORE - aa, BRUSH_CORE + aa, q);
        float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, q);
        float pip = 1.0 - smoothstep(band * 1.3 - aa, band * 1.3 + aa, q);

        float live = uCursor2.y;
        float a = uCursor.w;

        // A wash over the footprint, doubled over the core, brightening while
        // the tool is down so you can tell aiming from working at a glance.
        col = mix(col, uCursorTint, (disc * 0.09 + coreFill * 0.13) * a * (0.5 + 0.5 * live));
        col = mix(col, uCursorTint, core * 0.42 * a);
        col = mix(col, uCursorTint, rim * (0.68 + 0.32 * live) * a);
        col = mix(col, vec3(0.196, 0.145, 0.114), ink * 0.72 * a);
        col = mix(col, uCursorTint, pip * 0.8 * a);
    }

    // Alpha is not opacity here — it is the ink mask, and it is the whole reason
    // the scene target has an alpha channel.
    //
    // The skirt overlaps the fine grid and is pushed back with a depth bias to
    // lose the argument. That bias is a depth discontinuity along the domain
    // border, and the outline pass — which finds edges in depth and cannot know
    // why one is there — drew a hard line straight across the beach. Marking the
    // playable square as the only inkable surface fixes it at the source
    // instead of trying to tune a threshold around it.
    outColor = vec4(col, uOuter > 0.5 ? 0.0 : 1.0);
}`;

// --------------------------------------------------------------------- water

export const WATER_VS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
${GRID}

uniform mat4  uViewProj;
uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform int   uEdge;
uniform float uTime;
uniform float uSeaBase;
uniform float uWaveAmp;

out vec3  vWorld;
out float vDepth;
out float vBreaking;

void main() {
    vec2 uv = gridUV(gl_VertexID, uEdge);
    vec2 p = skirtPosition(uv);

    float sl = seaLevelAt(uSeaBase, uTime);
    float ground = groundY(uField, uBedrock, p);
    float depth = max(sl - ground, 0.0);

    float brk = 0.0;
    float y = sl + waveHeight(p, uTime, depth, uWaveAmp, brk) * step(0.001, depth);

    vWorld = vec3(p.x, y, p.y);
    vDepth = depth;
    vBreaking = brk;
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const WATER_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}

uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform float uTime;
uniform float uSeaBase;

in vec3  vWorld;
in float vDepth;
in float vBreaking;

out vec4 outColor;

void main() {
    // Coverage is the soft waterline. A hard discard gives a stair-stepped
    // shoreline that no amount of anti-aliasing will fix.
    float ground = groundY(uField, uBedrock, vWorld.xz);
    float wedge = vWorld.y - ground;
    if (wedge <= 0.0) { discard; }
    // A wide-ish ramp on purpose. The sand field is 25 cm per texel, and a tight
    // coverage threshold turns that grid into a staircase along every waterline.
    float coverage = smoothstep(0.0, 0.14, wedge);

    // Two tones, stepped on depth. No specular, no reflection, no refraction —
    // a cartoon sea is a colour and a shape.
    vec3 shallow = vec3(0.400, 0.839, 0.867);
    vec3 deep    = vec3(0.114, 0.435, 0.612);
    float band = smoothstep(0.15, 0.30, vDepth) * 0.5
               + smoothstep(0.80, 1.10, vDepth) * 0.5;
    vec3 col = mix(shallow, deep, band);

    // Foam, from three sources that read as three different things on a beach:
    // breaking crests, the shallow wedge where a wave runs out of water beneath
    // it, and the lace at the very top of the run.
    float crest = smoothstep(0.30, 0.85, vBreaking);
    float lace  = smoothstep(0.22, 0.0, wedge) * smoothstep(0.0, 0.03, wedge);
    float scud  = vnoise(vWorld.xz * 1.6 + vec2(0.0, -uTime * 0.9));
    float foam  = clamp(crest * 1.1 + lace * 1.5, 0.0, 1.0);
    foam *= smoothstep(0.32, 0.62, scud + crest * 0.35);

    col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0));

    outColor = vec4(col, coverage);
}`;

// ----------------------------------------------------------------------- sky

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uViewport;
out vec4 outColor;

void main() {
    float h = vUV.y;
    vec3 top = vec3(0.298, 0.694, 0.886);
    vec3 mid = vec3(0.596, 0.851, 0.945);
    vec3 low = vec3(0.945, 0.906, 0.808);
    vec3 col = mix(low, mid, smoothstep(0.0, 0.45, h));
    col = mix(col, top, smoothstep(0.35, 1.0, h));
    outColor = vec4(col, 0.0);      // alpha 0: never ink the sky
}`;

// ------------------------------------------------------------------- outline

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2  uTexel;
uniform float uOutline;

out vec4 outColor;

/// Linearise so the edge test behaves the same near the camera and far from it.
/// Raw depth-buffer differences are enormous at the near plane and vanishing at
/// the far one, which gives thick ink at your feet and none at the headland.
float linearDepth(vec2 uv, float n, float f) {
    float z = texture(uDepth, uv).r * 2.0 - 1.0;
    return (2.0 * n * f) / (f + n - z * (f - n));
}

void main() {
    vec3 col = texture(uColor, vUV).rgb;

    // The ink mask, written into alpha by the terrain pass and cleared to zero
    // by the sea. Only the playable square gets a line.
    float mask = texture(uColor, vUV).a;

    if (uOutline > 0.0 && mask > 0.5) {
        const float n = 0.35, f = 400.0;
        float c = linearDepth(vUV, n, f);
        float l = linearDepth(vUV - vec2(uTexel.x, 0.0), n, f);
        float r = linearDepth(vUV + vec2(uTexel.x, 0.0), n, f);
        float d = linearDepth(vUV - vec2(0.0, uTexel.y), n, f);
        float u = linearDepth(vUV + vec2(0.0, uTexel.y), n, f);

        // Second difference rather than a gradient: a plain Sobel inks every
        // receding surface, so a beach seen at a glancing angle comes out as a
        // solid smear. The Laplacian only fires where depth actually breaks.
        float edge = abs(l + r + d + u - 4.0 * c) / max(c, 1.0);
        float ink = smoothstep(0.010, 0.035, edge) * uOutline;

        col = mix(col, vec3(0.196, 0.145, 0.114), clamp(ink, 0.0, 0.85));
    }

    // A whisper of vignette. Cartoons are printed, and print has edges.
    vec2 q = vUV - 0.5;
    col *= 1.0 - dot(q, q) * 0.35;

    outColor = vec4(col, 1.0);
}`;
