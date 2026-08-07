// The things you leave on a beach.
//
// Each prop is one camera-facing quad with its shape drawn by signed distance
// in the fragment shader. That sounds like a cop-out and is actually the right
// call for this look: a cartoon prop is a flat silhouette with two or three
// flat colours, so modelling it in 3D would cost geometry, normals and a
// lighting path to arrive somewhere less crisp than a hand-drawn shape.
//
// Two details make them sit in the world rather than on top of it:
//
//   · the ground height comes from a vertex texture fetch of the *live*
//     simulation, so a flag planted on a tower rides up with the tower and
//     drops when the sea takes it away. Nothing is stored but XZ.
//   · they billboard around Y only. A fully camera-facing quad lies down as you
//     tilt the camera over, and a beach umbrella lying on its side is worse
//     than one that is slightly wrong.

import { COMMON } from './common.js';

export const PROP_VS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}

uniform mat4      uViewProj;
uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform sampler2D uProps;     // two texels per prop
uniform sampler2D uLight;
uniform vec3      uCamRight;

out vec2  vUV;
out float vKind;
out float vTint;
out float vSun;

void main() {
    int inst = gl_InstanceID;
    vec4 a = texelFetch(uProps, ivec2(inst * 2,     0), 0);   // x, z, rotation, kind
    vec4 b = texelFetch(uProps, ivec2(inst * 2 + 1, 0), 0);   // size, tint, _, _

    int v = gl_VertexID;
    // Two triangles, corners from the vertex index. No buffers, as everywhere.
    vec2 c = vec2((v == 1 || v == 3 || v == 4) ? 1.0 : 0.0,
                  (v == 2 || v == 4 || v == 5) ? 1.0 : 0.0);
    vUV = c;

    float size = b.x;
    // The quad's own frame: horizontal along the camera's right, vertical along
    // world up. Anchored at the bottom edge so the prop stands on the sand.
    vec3 right = normalize(vec3(uCamRight.x, 0.0, uCamRight.z));
    float gy = groundY(uField, uBedrock, a.xy);

    vec3 world = vec3(a.x, gy, a.y)
               + right * (c.x - 0.5) * size
               + vec3(0.0, 1.0, 0.0) * c.y * size;

    vKind = a.w;
    vTint = b.y;
    // Sampled once at the foot rather than per fragment: a prop is a metre or
    // two of flat silhouette, so one answer for the whole thing is the right
    // number of answers, and it is the ground it is standing on that decides it.
    vSun = lightAt(uLight, a.xy).x;
    gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const PROP_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2  vUV;
in float vKind;
in float vTint;
in float vSun;

uniform vec3 uSunDir;

out vec4 outColor;

// ------------------------------------------------------------------ shapes
//
// All of these work in a 0..1 square with the origin at the bottom centre, so
// (0.5, 0) is where the prop meets the sand.

float sdCircle(vec2 p, vec2 c, float r) { return length(p - c) - r; }

float sdBox(vec2 p, vec2 c, vec2 h) {
    vec2 d = abs(p - c) - h;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdTriangle(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b - a, e1 = c - b, e2 = a - c;
    vec2 v0 = p - a, v1 = p - b, v2 = p - c;
    vec2 p0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 p1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 p2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(p0, p0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(p1, p1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(p2, p2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}

/// A five-armed star, for the starfish.
float sdStar(vec2 p, vec2 c, float r) {
    p -= c;
    float a = atan(p.y, p.x);
    float k = 3.14159265 / 5.0;
    float wedge = mod(a + k * 0.5, 2.0 * k) - k;
    float rr = r * (0.52 + 0.48 * cos(wedge * 5.0 * 0.5 + 0.0));
    // Cheap and shapely rather than exact — this is a 20-pixel starfish.
    float petal = r * mix(0.42, 1.0, pow(abs(cos(a * 2.5)), 0.6));
    return length(p) - petal;
}

/// Composite a layer over the accumulating colour, keeping a coverage mask.
void layer(inout vec3 col, inout float cov, float d, vec3 c, float aa) {
    float a = 1.0 - smoothstep(-aa, aa, d);
    col = mix(col, c, a);
    cov = max(cov, a);
}

void main() {
    vec2 p = vUV;
    int kind = int(vKind + 0.5);

    // Antialias width from screen-space derivatives, so a prop is equally crisp
    // near and far without any mip chain.
    float aa = max(fwidth(p.x), fwidth(p.y)) * 0.9;

    vec3 col = vec3(0.0);
    float cov = 0.0;

    // A palette that stays inside the beach's own colour world. Saturated, few
    // steps, and no shading gradients anywhere.
    vec3 ink   = vec3(0.196, 0.145, 0.114);
    vec3 red   = vec3(0.945, 0.353, 0.286);
    vec3 blue  = vec3(0.259, 0.596, 0.851);
    vec3 yellow= vec3(0.988, 0.792, 0.290);
    vec3 cream = vec3(0.984, 0.945, 0.874);
    vec3 pink  = vec3(0.960, 0.686, 0.667);
    vec3 teal  = vec3(0.298, 0.749, 0.710);

    vec3 main1 = (vTint < 0.5) ? red : ((vTint < 1.5) ? blue : ((vTint < 2.5) ? yellow : teal));

    if (kind == 0) {
        // Flag: a pole with a pennant.
        layer(col, cov, sdBox(p, vec2(0.44, 0.42), vec2(0.030, 0.42)), cream, aa);
        layer(col, cov, sdTriangle(p, vec2(0.47, 0.84), vec2(0.47, 0.56), vec2(0.86, 0.72)), main1, aa);
        layer(col, cov, sdCircle(p, vec2(0.44, 0.87), 0.055), main1, aa);
    } else if (kind == 1) {
        // Bucket: a tapered body, a rim and a handle.
        float body = sdTriangle(p, vec2(0.24, 0.62), vec2(0.76, 0.62), vec2(0.5, 0.0));
        body = min(body, sdBox(p, vec2(0.5, 0.30), vec2(0.24, 0.30)));
        layer(col, cov, max(body, -sdBox(p, vec2(0.5, 0.80), vec2(0.5, 0.22))), main1, aa);
        layer(col, cov, sdBox(p, vec2(0.5, 0.60), vec2(0.29, 0.055)), cream, aa);
        float handle = abs(sdCircle(p, vec2(0.5, 0.60), 0.27)) - 0.022;
        layer(col, cov, max(handle, -sdBox(p, vec2(0.5, 0.40), vec2(0.5, 0.42))), cream, aa);
    } else if (kind == 2) {
        // Spade: a blade and a shaft with a T-grip, stuck in at an angle.
        float s = sin(0.22), c2 = cos(0.22);
        vec2 q = vec2(c2 * (p.x - 0.5) - s * (p.y - 0.5), s * (p.x - 0.5) + c2 * (p.y - 0.5)) + 0.5;
        layer(col, cov, sdTriangle(q, vec2(0.34, 0.34), vec2(0.66, 0.34), vec2(0.5, 0.02)), main1, aa);
        layer(col, cov, sdBox(q, vec2(0.5, 0.30), vec2(0.16, 0.10)), main1, aa);
        layer(col, cov, sdBox(q, vec2(0.5, 0.62), vec2(0.038, 0.30)), cream, aa);
        layer(col, cov, sdBox(q, vec2(0.5, 0.90), vec2(0.15, 0.045)), cream, aa);
    } else if (kind == 3) {
        // Shell: a fan with ribs.
        float fan = sdCircle(p, vec2(0.5, 0.10), 0.42);
        fan = max(fan, -sdBox(p, vec2(0.5, -0.10), vec2(0.5, 0.16)));
        layer(col, cov, fan, pink, aa);
        for (int i = -2; i <= 2; ++i) {
            float a = float(i) * 0.30;
            vec2 dir = vec2(sin(a), cos(a));
            float rib = sdBox(p - vec2(0.5, 0.10) - dir * 0.22,
                              vec2(0.0), vec2(0.016, 0.20));
            layer(col, cov, max(rib, fan + 0.02), cream * 0.92, aa);
        }
    } else if (kind == 4) {
        // Starfish, lying flat-ish on the sand.
        layer(col, cov, sdStar(p, vec2(0.5, 0.30), 0.40), main1, aa);
        layer(col, cov, sdCircle(p, vec2(0.5, 0.30), 0.07), cream * 0.9, aa);
    } else {
        // Umbrella: a canopy in alternating panels over a pole.
        layer(col, cov, sdBox(p, vec2(0.5, 0.34), vec2(0.026, 0.34)), cream, aa);
        float canopy = sdCircle(p, vec2(0.5, 0.44), 0.46);
        canopy = max(canopy, -sdBox(p, vec2(0.5, 0.16), vec2(0.5, 0.28)));
        layer(col, cov, canopy, main1, aa);

        // Alternating panels, from the angle about the canopy centre.
        //
        // Masked against the canopy's coverage rather than smuggled in as a
        // tiny signed distance. The tiny-distance trick works until the prop is
        // small on screen, at which point fwidth exceeds the offset and the
        // stripes dissolve into a flat wash — which is exactly when you are
        // most likely to be looking at a beach full of them.
        vec2 d = p - vec2(0.5, 0.44);
        float stripe = step(0.5, fract(atan(d.x, -d.y) * 0.9549 + 0.5));   // 6 panels
        float inCanopy = 1.0 - smoothstep(-aa, aa, canopy);
        col = mix(col, cream, stripe * inCanopy);
        cov = max(cov, inCanopy);

        layer(col, cov, sdCircle(p, vec2(0.5, 0.90), 0.045), cream, aa);   // finial
    }

    // Everything outside every shape is nothing at all. Discarding rather than
    // blending is what lets props write depth, which is what lets the ink pass
    // find their silhouettes.
    if (cov < 0.5) { discard; }

    // One flat shading step, keyed off the sun's height rather than a normal —
    // props have no normals, and inventing one per shape would buy nothing a
    // cartoon audience would notice.
    //
    // Times the sun the sand under it is getting, and shifted toward the same
    // violet the beach shades with, so a bucket in a tower's shadow goes with
    // the shadow instead of glowing out of the middle of it.
    float key = smoothstep(0.05, 0.45, uSunDir.y) * vSun;
    col *= mix(vec3(0.66, 0.64, 0.83), vec3(1.0), key);

    outColor = vec4(col, 1.0);
}`;
