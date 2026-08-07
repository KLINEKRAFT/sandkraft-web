// The solver.
//
// WebGL2 has no compute shaders, so this is fragment-shader ping-pong between
// two float textures — which is how the physics ran originally, before the
// native build moved it to Metal compute. The numerics did not change.
//
// Two invariants. Every edit to this file has to preserve both:
//
//   1. Every pair transfer is exactly antisymmetric. Sand is conserved to the
//      last grain. This is what makes an undermined wall fall over without
//      anybody scripting it.
//   2. No cell gives away more than 1/9 of what it owns per step. Eight
//      neighbours pull on the same cell in the same pass. Let each take an
//      eighth and a cell under a breaking wave is asked for more sand than
//      exists, goes negative, gets clamped at zero — and that clamp quietly
//      *mints* sand. Left alone it grows dunes out of nothing during a storm.

import { COMMON } from './common.js';

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
    // Buffer-less fullscreen triangle. No vertex data, nothing to upload.
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/// Fill the hardpack table. Run once, at startup.
///
/// The bake takes its resolution as a uniform because it has nothing to sample —
/// and it is vertex-centred to match `bedrockPair`: floor(gl_FragCoord) / (N-1)
/// puts the first and last samples exactly on the borders rather than half a
/// texel inside them, which is the property the analytic fallback meets.
export const BEDROCK_BAKE_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform float uResolution;
out vec4 outColor;
void main() {
    vec2 g = floor(gl_FragCoord.xy) / (uResolution - 1.0);
    vec2 p = mix(vec2(-BEDROCK_EXTENT), vec2(BEDROCK_EXTENT), g);
    outColor = vec4(bedrock(p), sandBed(p), 0.0, 1.0);
}`;

/// The shore as the tide left it.
export const SIM_INIT_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uBedrock;
uniform float uResolution;
uniform float uSeaBase;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 wp = uvToWorld(uv);

    vec2 bed = bedrockPair(uBedrock, wp);
    float depth = bed.y;

    // Wetness follows the *surface*, not the hardpack — the top of a deep bed
    // dries in the sun exactly like a shallow one does.
    float wet = smoothstep(0.55, -0.35, bed.x + depth - uSeaBase);
    float m = clamp(wet * 0.92 + 0.06 + 0.05 * vnoise(wp * 0.6), 0.0, 1.0);

    outColor = vec4(depth, m, 0.0, 0.0);
}`;

/// One step of the solver, with the brush folded in.
export const SIM_STEP_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}

uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform float uResolution;
uniform float uDt;
uniform float uTime;
uniform float uSeaBase;
uniform float uWaveAmp;
uniform float uErosion;

// The stroke, as a swept segment rather than a point.
//
// uBrushA: xy = where the stroke was last frame, z = radius, w = strength 0..1
// uBrushB: xy = where it is now,  z = reference ground height, w = tool parameter
//
// Sweeping matters more than it sounds. A point brush stamped once per frame
// leaves a dotted line the moment a finger moves faster than radius-per-frame,
// and the faster you drag the more it looks like the tool is broken. Measuring
// distance to the *segment* costs four extra instructions and the tool becomes
// continuous at any speed.
uniform vec4  uBrushA;
uniform vec4  uBrushB;
uniform int   uTool;          // 0 none · 1 dig · 2 pour · 3 pack · 4 wet
                              // 5 wall · 6 flatten
uniform int   uBrushShape;    // 0 round, 1 square

// The mould, fired on exactly one substep.
// uStamp:  xy = centre, z = radius, w = height
// uStamp2: x = shape, y = rotation, z = armed 0/1, w = base surface height
uniform vec4  uStamp;
uniform vec4  uStamp2;

out vec4 outColor;

/// Distance to a swept segment, in L².
float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * t);
}

/// The same swept stroke measured in L∞ instead of L².
///
/// The isolines of max(|x|, |y|) are concentric squares, so this one metric
/// switch turns a round spade into a square one without any tool having to know
/// about it — every mode below is written against the falloff, not against the
/// distance.
float segDistSquare(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    vec2 q = abs(pa - ba * t);
    return max(q.x, q.y);
}

/// How tall the mould stands above its base at this point, or -1 outside it.
float mouldHeight(vec2 p, vec4 st, vec4 st2) {
    vec2 d = p - st.xy;
    float c = cos(st2.y), s = sin(st2.y);
    d = vec2(c * d.x - s * d.y, s * d.x + c * d.y);

    int shape = int(st2.x + 0.5);
    float r = max(st.z, 0.05), h = st.w;

    if (shape == 1) {
        // A block. Square footprint, flat top, crisp sides — the shape you get
        // from an upturned box rather than a bucket.
        float q = max(abs(d.x), abs(d.y));
        if (q > r) { return -1.0; }
        return h * (1.0 - smoothstep(r * 0.93, r, q));
    }
    if (shape == 2) {
        // A cone.
        float q = length(d);
        if (q > r) { return -1.0; }
        return h * (1.0 - q / r);
    }

    // A tower: near-vertical sides with a raised rim, which is what a bucket
    // actually turns out — the rim is the lip of the pail and it is the detail
    // that makes the shape read as moulded rather than as a lump.
    float q = length(d) / r;
    if (q > 1.0) { return -1.0; }
    float body = h * (1.0 - smoothstep(0.88, 1.0, q));
    float rim  = h * 0.14 * smoothstep(0.60, 0.78, q) * (1.0 - smoothstep(0.78, 0.93, q));
    return body + rim;
}

/// How hard the sea is working this cell, right now.
float waveWork(vec2 wp, float groundHeight) {
    if (uErosion <= 0.0) { return 0.0; }

    float sl = seaLevelAt(uSeaBase, uTime);
    float still = sl - groundHeight;

    // The wave is depth-limited, so anything above still water is untouched —
    // and skipping it here is what keeps the whole solver cheap.
    if (still <= 0.0) { return 0.0; }

    float brk = 0.0;
    float wy = sl + waveHeight(wp, uTime, still, uWaveAmp, brk);
    float depth = wy - groundHeight;
    if (depth <= 0.0) { return 0.0; }

    float thin = exp(-max(depth, 0.0) * 1.25) * smoothstep(0.0, 0.045, depth);
    return clamp((0.30 + 1.85 * brk) * thin * uErosion, 0.0, 2.2);
}

const ivec2 OFF[8] = ivec2[8](
    ivec2( 1,  0), ivec2(-1,  0), ivec2( 0,  1), ivec2( 0, -1),
    ivec2( 1,  1), ivec2(-1,  1), ivec2( 1, -1), ivec2(-1, -1)
);

void main() {
    ivec2 gid = ivec2(gl_FragCoord.xy);
    int R = int(uResolution);

    vec2 uv = (vec2(gid) + 0.5) / uResolution;
    vec2 wp = uvToWorld(uv);

    vec4 S = texelFetch(uField, gid, 0);
    float h = S.r, m = S.g, c = S.b;

    float b0 = bedrockAt(uBedrock, wp);
    float H0 = b0 + h;
    float cellSize = DOMAIN.z / uResolution;

    float wa   = waveWork(wp, H0);
    float rep0 = repose(m, c);

    // Wet, packed sand resists being fluidised. Loose dry sand does not.
    float resist = 1.0 / (1.0 + 3.4 * c + 1.1 * m);
    rep0 *= (1.0 - 0.93 * clamp(wa * resist, 0.0, 1.0));

    float rate = 0.115 + 0.42 * clamp(wa, 0.0, 1.0);

    float dSand = 0.0, mAcc = 0.0, cAcc = 0.0, wAcc = 0.0;
    float mDiff = 0.0;

    for (int i = 0; i < 8; ++i) {
        ivec2 n = gid + OFF[i];
        if (n.x < 0 || n.y < 0 || n.x >= R || n.y >= R) { continue; }

        vec4 Sn = texelFetch(uField, n, 0);
        vec2 nwp = uvToWorld((vec2(n) + 0.5) / uResolution);

        float bn = bedrockAt(uBedrock, nwp);
        float Hn = bn + Sn.r;
        mDiff += (Sn.g - m);

        float dist = length(vec2(OFF[i])) * cellSize;

        float wan  = waveWork(nwp, Hn);
        float repn = repose(Sn.g, Sn.b);
        repn *= (1.0 - 0.93 * clamp(wan / (1.0 + 3.4 * Sn.b + 1.1 * Sn.g), 0.0, 1.0));
        float rep = 0.5 * (rep0 + repn);

        // Relaxation rate for this pair, with a hard ceiling. Under a breaking
        // wave this term reaches four times the stable limit without the clamp,
        // and the shoreline comes out as a row of alternating one-cell spikes —
        // a picket fence that is the solver oscillating, not the sea eroding.
        float rt = min(0.5 * (rate + 0.115 + 0.42 * clamp(wan, 0.0, 1.0)), 0.118);

        float dH  = H0 - Hn;
        float thr = rep * dist;
        float t = 0.0;
        if (dH > thr)       { t = -(dH - thr); }
        else if (dH < -thr) { t =  (-dH - thr); }
        t *= rt;

        // Symmetric clamp — the identical expression evaluated from either
        // side, so the pair transfer stays exactly antisymmetric. Invariant 1,
        // and the 0.111 is invariant 2.
        if (t < 0.0) { t = -min(-t, h * 0.111); }
        else         { t =  min( t, Sn.r * 0.111); }

        dSand += t;
        if (t > 0.0) { mAcc += Sn.g * t; cAcc += Sn.b * t; wAcc += t; }
    }

    float nh = max(h + dSand, 0.0);

    // Arriving sand brings its own moisture and packing with it.
    if (wAcc > 1e-6 && nh > 1e-6) {
        float f = clamp(wAcc / nh, 0.0, 1.0);
        m = mix(m, mAcc / wAcc, f);
        c = mix(c, cAcc / wAcc, f);
    }
    h = nh;

    // Moisture diffuses, the sun dries it, and the sea soaks it.
    m += mDiff * 0.045 * uDt * 12.0;
    m -= 0.020 * uDt * (1.0 - clamp(wa, 0.0, 1.0));
    m += wa * uDt * 1.6;

    // Being knocked about loosens packed sand.
    c -= wa * uDt * 0.55;

    // ------------------------------------------------------------- the brush
    //
    // Every rate below is metres (or units) per second at the centre of the
    // stroke. The first cut of this game multiplied by twelve and a tap took a
    // crater out of the beach; the correction overshot the other way, and for a
    // long time a spade held down for a full second moved less sand than the
    // avalanche put back — so the tool read as broken rather than as gentle.
    //
    // These are the rates that make a hole appear while you are still watching
    // it. They are still well short of the original: the 0.2 s arrival ramp in
    // main.js is what keeps a tap from gouging, and it does that job whatever
    // these numbers are.
    if (uTool != 0 && uBrushA.w > 0.0) {
        float d = (uBrushShape == 1)
            ? segDistSquare(wp, uBrushA.xy, uBrushB.xy)
            : segDist(wp, uBrushA.xy, uBrushB.xy);

        float r = max(uBrushA.z, 0.05);
        // Flat across the core, easing to nothing at the rim. The soft edge is
        // most of what makes the tool feel like sand rather than like a cursor —
        // but the core has to be wide enough that the middle of the brush is
        // actually doing the advertised work. See BRUSH_CORE in common.js; the
        // ring the renderer draws is the same number.
        float w = brushFalloff(d, r);
        w *= uBrushA.w;

        if (w > 0.0) {
            float k = w * uDt;

            if (uTool == 1) {
                // Dig. Cannot take what is not there — the hardpack is the floor.
                //
                // 2.4 m/s at the core, against about 2.9 m of loose sand over
                // the working pad: roughly a second and a half of holding to
                // reach the bottom, and visibly deeper every frame on the way.
                // The old 0.90 lost that race to the avalanche in dry sand,
                // which is why digging felt like polishing.
                h = max(h - k * 2.40, 0.0);
                m = min(m + k * 0.10, 1.0);       // turned-over sand is damper
            } else if (uTool == 2) {
                // Pour, at the moisture of the pail. Kept a little under the
                // spade — a bucket should not out-run a shovel.
                float add = k * 1.60;
                float total = h + add;
                if (total > 1e-6) { m = mix(m, 0.62, add / total); }
                h = total;
            } else if (uTool == 3) {
                // Pack, with the flat of a hand. This is what buys a vertical face.
                c = min(c + k * 1.55, 1.0);
            } else if (uTool == 4) {
                m = min(m + k * 1.35, 1.0);
            } else if (uTool == 5) {
                // Wall. Raises the surface toward a ridge of the requested
                // height above where the stroke started, and packs as it goes —
                // a rampart you drag out rather than one you pile up by hand.
                float target = uBrushB.z + uBrushB.w;
                float want = max(target - b0, 0.0);
                if (want > h) { h = mix(h, want, clamp(k * 4.4, 0.0, 1.0)); }
                m = min(m + k * 1.20, 1.0);
                c = min(c + k * 1.80, 1.0);
            } else if (uTool == 6) {
                // Flatten toward the height the stroke started at. The one tool
                // that is about taking away *and* adding, and the fastest way to
                // get a clean base to build on.
                float want = max(uBrushB.z - b0, 0.0);
                h = mix(h, want, clamp(k * 3.2, 0.0, 1.0));
            }
        }
    }

    // -------------------------------------------------------------- the mould
    //
    // Fired on exactly one substep. Two would turn out two towers a millimetre
    // apart, which reads as one very strange tower.
    if (uStamp2.z > 0.5) {
        float add = mouldHeight(wp, uStamp, uStamp2);
        if (add >= 0.0) {
            float want = max(uStamp2.w + add - b0, 0.0);
            if (want > h) {
                h = want;
                // Damp and hard-packed, which is the whole point: the repose
                // floor at this packing is past vertical, so the moulded face
                // stands instead of slumping the instant it appears.
                m = max(m, 0.60);
                c = max(c, 0.88);
            }
        }
    }

    outColor = vec4(h, clamp(m, 0.0, 1.0), clamp(c, 0.0, 1.0), 0.0);
}`;
