// The sun and the sky, baked over the beach.
//
// A heightfield does not need a shadow map. The occluder and the receiver are
// the same function, so you can walk toward the sun and ask whether the ground
// has got above you yet — no second camera, no depth pass, no bias tuning, and
// no resolution mismatch between what casts and what receives.
//
// It is baked into a small world-space table rather than evaluated per pixel
// for the reason every other table in this project exists: the cost then stops
// depending on how many pixels the phone has. At 256 texels over 96 m this is
// one 65k-fragment pass whatever the display is doing, against a terrain shader
// that runs over a million fragments at 2x on a modern iPhone. Doing the same
// marching per pixel would have cost twenty times as much for a picture that is
// softer anyway — a cartoon shadow wants to be soft.
//
// Two terms, and they answer different questions:
//
//   · sun visibility is *directional*. It is what makes a tower throw a shape
//     across the sand, and it is the thing whose absence makes a moulded castle
//     look like a sticker.
//   · sky occlusion is *ambient*. It is what puts the dark in the bottom of a
//     hole — which no amount of normal-based shading can do, because the normal
//     at the bottom of a hole points straight up at the sky it cannot see.

import { COMMON } from './common.js';

export const LIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}

uniform sampler2D uField;
uniform sampler2D uBedrock;
uniform float uResolution;
uniform vec3  uSunDir;

out vec4 outColor;

/// How much of the sun this point can see.
///
/// Steps grow geometrically: fine detail close in, where a moulded lip shades
/// its own foot and a spade cut shades its own wall, and enough reach — about
/// thirty metres — for a headland to throw a shadow across the bay. A linear
/// march fine enough for the first metre would need two hundred steps to get
/// there and would spend nearly all of them on empty sand.
float sunVisibility(vec2 p, float h) {
    float vis = 1.0;
    float t = 0.35;
    for (int i = 0; i < 12; ++i) {
        vec3 q = vec3(p.x, h, p.y) + uSunDir * t;
        float over = groundYPoint(uField, uBedrock, q.xz) - q.y;
        if (over > 0.0) {
            // The penumbra widens with distance from the receiver, which is the
            // whole difference between a shadow that looks drawn and one that
            // looks stencilled: a tower's own edge stays crisp, and the dune
            // ridge forty metres back goes soft.
            vis = min(vis, 1.0 - clamp(over / (0.22 + 0.30 * t), 0.0, 1.0));
        }
        t *= 1.33;
    }
    return vis;
}

/// How much of the sky this point can see, by horizon angle.
///
/// In each of eight directions, find the steepest thing on the skyline. The
/// sine of its elevation is the fraction of that direction's sky it takes away;
/// average the eight and invert. Eight directions rather than four because four
/// prints a visible cross around every isolated bump, and a fixed set rather
/// than a jittered one because a rotation per texel turns smooth occlusion into
/// grain that the three-band shading then quantises into speckle.
float horizonAO(vec2 p, float h) {
    float lost = 0.0;
    for (int d = 0; d < 8; ++d) {
        float a = float(d) * 0.7853981634;          // two pi over eight
        vec2 dir = vec2(cos(a), sin(a));
        float steepest = 0.0;
        float t = 0.42;
        for (int i = 0; i < 3; ++i) {
            steepest = max(steepest, (groundYPoint(uField, uBedrock, p + dir * t) - h) / t);
            t *= 3.0;
        }
        steepest = max(steepest, 0.0);
        lost += steepest * inversesqrt(1.0 + steepest * steepest);   // sin(atan(s))
    }
    return clamp(1.0 - lost * 0.125, 0.0, 1.0);
}

void main() {
    vec2 uv = (floor(gl_FragCoord.xy) + 0.5) / uResolution;
    vec2 wp = uvToWorld(uv);

    // The point sampler for the receiver too, not the smoothed one. Mixing the
    // two puts a sub-texel disagreement between where this point thinks it is
    // and where the first march step thinks the ground is, and that disagreement
    // is exactly the shape of shadow acne.
    float h = groundYPoint(uField, uBedrock, wp);

    outColor = vec4(sunVisibility(wp, h), horizonAO(wp, h), 0.0, 1.0);
}`;
