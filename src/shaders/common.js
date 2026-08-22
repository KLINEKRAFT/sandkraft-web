// Shared GLSL, injected into every program.
//
// This is the web edition of Sandkraft/Shaders/Common.h, and it exists for the
// same reason that file does: the simulation and the renderer have to agree
// about where the ground is, or the water erodes sand that is somewhere else
// from the sand you can see.
//
// The numbers are ports, not inventions. The angle-of-repose curve especially —
// those constants are the difference between sand that behaves and sand that
// does not, and they are carried across exactly.

/// How much of the brush works at full strength, as a fraction of its radius.
///
/// This lives in JavaScript and is injected into the GLSL below because three
/// separate things have to agree about it: the solver shapes its falloff with
/// it, the terrain shader draws the inner ring of the cursor at it, and the UI
/// talks about it. A brush whose picture and whose effect disagree is worse
/// than no picture at all.
///
/// It used to be 0.30, which meant only nine per cent of the brush's area was
/// ever at full rate and the rest was a long apologetic shoulder — most of why
/// the tools felt like they were barely doing anything.
export const BRUSH_CORE = 0.55;

export const COMMON = /* glsl */ `
const float PI = 3.14159265359;

const float BRUSH_CORE = ${BRUSH_CORE.toFixed(2)};

/// Height between contour rings on the beach, in metres. About six of them from
/// the top of the working pad down to the hardpack, which is enough to count at
/// a glance and few enough not to read as a texture.
const float CONTOUR_METRES = 0.45;

/// The brush's strength at distance \`d\` from a stroke of radius \`r\`: flat 1
/// across the core, easing to 0 at the rim.
float brushFalloff(float d, float r) {
    return 1.0 - smoothstep(r * BRUSH_CORE, r, d);
}

// The simulated square, in metres. Sea toward +Z, dunes at -Z.
//
// 96 m on a side: four times the area of the first cut, which is what turns a
// diorama into somewhere you can lose a morning. The simulation resolution went
// up with it (see TIERS in main.js) so a texel is still about a third of a
// metre — the thing that has to stay constant is texel *size*, not texel count,
// because texel size is what decides how sharp an edge the sand can hold.
const vec4 DOMAIN = vec4(-48.0, -48.0, 96.0, 96.0);

// Half-width of the baked hardpack table. Same idea as the native build: the
// bedrock never moves, so it is derived once into a texture instead of being
// rebuilt nine times per texel per step. In a browser the trade is even better
// than it is in Metal — noise is relatively more expensive here.
//
// Comfortably past the domain corner (48·√2 ≈ 68 m) so the analytic fallback is
// only ever reached out on the far skirt.
const float BEDROCK_EXTENT = 72.0;

// ---------------------------------------------------------------- hash + noise

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ------------------------------------------------------------------- the shore

/// The working ground: where the shore is flat, where the loose sand is deep,
/// and where anything you build is worth counting. One function, so those three
/// can never drift apart from one another.
float buildPad(vec2 p) {
    return smoothstep(36.0, 24.0, length((p - vec2(0.0, -12.0)) * vec2(1.0, 0.92)));
}

/// Additive, and exactly zero outside its own footprint. A max() against this
/// would drag the whole sea floor up to zero, which is a very quiet way to
/// delete an ocean.
float rockDome(vec2 p, vec2 c, float r, float h) {
    vec2 q = (p - c) / vec2(r, r * 0.78);
    float k = 1.0 - dot(q, q);
    if (k <= 0.0) { return 0.0; }
    return h * pow(k, 0.62) * (0.80 + 0.36 * vnoise(p * 1.7));
}

// How deep the loose sand lies over the working ground, in metres. The hardpack
// drops by exactly this much under the same pad, so the *surface* is unchanged
// and what you gain is head-room to dig — see bedrock() and sandBed() below,
// which is why the number lives here rather than being written twice.
const float PAD_DEPTH = 2.9;

/// The hardpack. Five headlands, spread to the corners of the larger domain,
/// because an empty 96 m square reads as a car park rather than a bay.
float bedrock(vec2 p) {
    float z = p.y;
    float y = 1.55 - 0.0705 * (z + 24.0);

    // Landward dune ridge, pushed out past the working ground so the camera can
    // pull back over the whole of it without burying itself in a hill.
    y += 3.35 * smoothstep(-38.0, -47.0, z) * (0.85 + 0.4 * vnoise(p * 0.11));

    float pad = buildPad(p);

    // The hardpack dips away beneath the pad. The surface stays where it was;
    // what changes is how far down you can dig before you hit the bottom.
    y -= PAD_DEPTH * pad;

    // Longshore undulation.
    y += (0.42 * vnoise(p * 0.062) - 0.21) * (1.0 - 0.88 * pad);
    y += (0.13 * vnoise(p * 0.21) - 0.065) * (1.0 - 0.72 * pad);

    y += rockDome(p, vec2(-41.0,  12.0), 8.5, 4.20);
    y += rockDome(p, vec2( 43.0,  -4.0), 7.6, 3.60);
    y += rockDome(p, vec2(-36.0, -34.0), 9.0, 2.40);
    y += rockDome(p, vec2( 34.0, -38.0), 7.4, 2.90);
    y += rockDome(p, vec2( 46.0,  22.0), 5.2, 3.10);
    return y;
}

/// How bare the rock is here. Loose sand does not cling to a headland.
float domeMask(vec2 p, vec2 c, float r) {
    vec2 q = (p - c) / vec2(r, r * 0.78);
    return clamp(1.55 - dot(q, q) * 1.55, 0.0, 1.0);
}

float rockiness(vec2 p) {
    float m = domeMask(p, vec2(-41.0,  12.0), 8.5);
    m = max(m, domeMask(p, vec2( 43.0,  -4.0), 7.6));
    m = max(m, domeMask(p, vec2(-36.0, -34.0), 9.0));
    m = max(m, domeMask(p, vec2( 34.0, -38.0), 7.4));
    m = max(m, domeMask(p, vec2( 46.0,  22.0), 5.2));
    return m;
}

/// The loose sand last night's tide left behind.
float sandBed(vec2 p) {
    float pad = buildPad(p);
    // PAD_DEPTH exactly cancels the dip bedrock() just took, so the surface
    // lands where it always did — but there is now nearly three metres of sand
    // over it, which is enough to cut a moat you could lose a spade in and
    // enough that a deep hole reaches water rather than rock.
    float d = 0.55 + PAD_DEPTH * pad + 0.18 * vnoise(p * 0.33) + 0.08 * vnoise(p * 1.1);
    return max(d * (1.0 - rockiness(p)), 0.0);
}

// --------------------------------------------------------- the angle of repose
//
// The whole design rests on this one function.
//
//     bone dry        ->  about 33 degrees, a slope and never a wall
//     damp and packed ->  past vertical
//     saturated       ->  it runs like soup
//
// Everything you build here is an argument with this number. Water is one
// argument, the flat of your hand is another, and the sea is the rebuttal.

float repose(float moisture, float packing) {
    float wet  = smoothstep(0.035, 0.55, moisture);
    float over = smoothstep(0.90, 1.0, moisture);

    float s = mix(0.655, 3.9, wet);
    s *= (1.0 + 2.35 * packing);

    // Packed sand keeps its shape after it dries. The water is what let you
    // build the face; the packing is what holds it up, and packing does not
    // evaporate. Without this floor a tower moulded at noon slumps by teatime.
    s = max(s, 0.655 + 14.0 * packing * packing);

    // Soaking still ruins it. A floor for dry sand, not for soup.
    s *= (1.0 - 0.86 * over);

    return max(s, 0.38);
}

// ------------------------------------------------------------------ the tide

float seaLevelAt(float base, float t) {
    return base
         + 0.118 * sin(t * 0.5100)
         + 0.067 * sin(t * 0.2410 + 1.73)
         + 0.028 * sin(t * 1.0700 + 0.41);
}

/// A very short Gerstner-ish sum. Enough for a wave that visibly runs up the
/// beach and visibly takes sand back with it, which is the whole point.
float waveHeight(vec2 p, float t, float depth, float amp, out float breaking) {
    float shoal = 1.0 / sqrt(max(depth, 0.25));
    float a = 0.0;
    a += sin(p.y * 0.42 - t * 1.30) * 0.42;
    a += sin(p.y * 0.71 - t * 1.83 + p.x * 0.09) * 0.24;
    a += sin(p.y * 1.31 - t * 2.60 + p.x * 0.21) * 0.11;
    a *= amp * min(shoal, 2.6);
    // Steepness runs away as the water shallows — that is a wave breaking.
    breaking = clamp((abs(a) * min(shoal, 2.6) - 0.35) * 1.4, 0.0, 1.0);
    return a;
}

// ------------------------------------------------------- the baked hardpack

/// One tap of the baked table: .x is bedrock, .y is the loose bed on top.
///
/// The table is vertex-centred: texel 0 sits exactly on -BEDROCK_EXTENT and
/// texel N-1 exactly on +BEDROCK_EXTENT, so a lookup on the border lands on a
/// stored texel with a zero interpolation weight and meets the analytic
/// fallback at a number it computed itself.
///
/// The weights are smoothstepped, not linear. The terrain fragment rebuilds its
/// normal by *differencing this function*, and plain bilinear — whose gradient
/// is piecewise constant — would print the table's own texel grid onto the beach.
vec2 bedrockPair(sampler2D lut, vec2 p) {
    if (any(greaterThan(abs(p), vec2(BEDROCK_EXTENT)))) {
        return vec2(bedrock(p), sandBed(p));
    }

    float N = float(textureSize(lut, 0).x);

    // Normalise first, scale second, so the division is exact at both borders.
    vec2 g = (p + BEDROCK_EXTENT) / (2.0 * BEDROCK_EXTENT);
    vec2 t = g * (N - 1.0);
    vec2 i = floor(t), f = fract(t);
    f = f * f * (3.0 - 2.0 * f);

    ivec2 m = ivec2(N - 1.0);
    ivec2 i0 = clamp(ivec2(i),               ivec2(0), m);
    ivec2 i1 = clamp(ivec2(i) + ivec2(1, 0), ivec2(0), m);
    ivec2 i2 = clamp(ivec2(i) + ivec2(0, 1), ivec2(0), m);
    ivec2 i3 = clamp(ivec2(i) + ivec2(1, 1), ivec2(0), m);

    vec2 s00 = texelFetch(lut, i0, 0).rg;
    vec2 s10 = texelFetch(lut, i1, 0).rg;
    vec2 s01 = texelFetch(lut, i2, 0).rg;
    vec2 s11 = texelFetch(lut, i3, 0).rg;
    return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

float bedrockAt(sampler2D lut, vec2 p) { return bedrockPair(lut, p).x; }

// ------------------------------------------------------------ field sampling

vec2 worldToUV(vec2 p) { return (p - DOMAIN.xy) / DOMAIN.zw; }
vec2 uvToWorld(vec2 uv) { return DOMAIN.xy + uv * DOMAIN.zw; }

/// Bilinear by hand, with smoothstepped weights.
///
/// Doing it here rather than in the sampler is not fussiness: float textures are
/// not linearly filterable without an extension the phone may not have, and this
/// way the sampler never has to change between the solver and the renderer —
/// which removes a whole category of "why is the water one texel off the sand".
vec4 sandSmooth(sampler2D field, vec2 uv) {
    vec2 res = vec2(textureSize(field, 0));
    vec2 t = uv * res - 0.5;
    vec2 i = floor(t), f = fract(t);
    f = f * f * (3.0 - 2.0 * f);

    ivec2 m = ivec2(res) - 1;
    ivec2 i0 = clamp(ivec2(i),               ivec2(0), m);
    ivec2 i1 = clamp(ivec2(i) + ivec2(1, 0), ivec2(0), m);
    ivec2 i2 = clamp(ivec2(i) + ivec2(0, 1), ivec2(0), m);
    ivec2 i3 = clamp(ivec2(i) + ivec2(1, 1), ivec2(0), m);

    vec4 s00 = texelFetch(field, i0, 0);
    vec4 s10 = texelFetch(field, i1, 0);
    vec4 s01 = texelFetch(field, i2, 0);
    vec4 s11 = texelFetch(field, i3, 0);
    return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

/// Total ground height: hardpack plus whatever loose sand stands on it. Outside
/// the simulated square this falls back to the analytic bed, which is what lets
/// the skirt meet the domain without a step.
float groundY(sampler2D field, sampler2D lut, vec2 p) {
    vec2 uv = worldToUV(p);
    vec2 bed = bedrockPair(lut, p);
    bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    return bed.x + (inside ? sandSmooth(field, uv).r : bed.y);
}

/// The same height, by nearest texel: two fetches instead of eight.
///
/// The smoothed version above exists because the terrain shader rebuilds its
/// normal by *differencing* it, and a sampler whose gradient is piecewise
/// constant prints its own texel grid onto the beach. Nothing that marches
/// cares about that — a shadow ray asks this a dozen times and an occlusion
/// horizon two dozen more, and all any of them want is "is the ground above me
/// yet". Paying eight fetches a tap for an answer that gets thresholded anyway
/// is how a cheap idea becomes an expensive one.
float groundYPoint(sampler2D field, sampler2D lut, vec2 p) {
    vec2 g = clamp((p + BEDROCK_EXTENT) / (2.0 * BEDROCK_EXTENT), 0.0, 1.0);
    ivec2 ls = textureSize(lut, 0);
    vec2 bed = texelFetch(lut, ivec2(g * vec2(ls - ivec2(1)) + 0.5), 0).rg;

    vec2 uv = worldToUV(p);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        return bed.x + bed.y;               // off the square: the pristine bed
    }
    ivec2 fs = textureSize(field, 0);
    ivec2 fi = clamp(ivec2(uv * vec2(fs)), ivec2(0), fs - ivec2(1));
    return bed.x + texelFetch(field, fi, 0).r;
}

// ------------------------------------------------------------------ the light

/// The baked light over the beach: .x is how much of the sun reaches this
/// point, .y is how much of the sky.
///
/// One hardware-filtered tap, unlike every other sampler in this file. It can
/// be, because this map is RGBA8 rather than float — eight bits is more than
/// three-band shading can show — and because nothing differences it.
vec2 lightAt(sampler2D lightMap, vec2 p) {
    vec2 uv = worldToUV(p);
    vec2 L = textureLod(lightMap, clamp(uv, 0.0, 1.0), 0.0).rg;
    // Ease back to open sun and open sky just outside the simulated square.
    // Clamp-to-edge alone would smear a headland's shadow three hundred metres
    // out to sea along the skirt.
    vec2 d = min(uv, 1.0 - uv);
    return mix(vec2(1.0), L, smoothstep(-0.02, 0.008, min(d.x, d.y)));
}
`;
