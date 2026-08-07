# Sandkraft — web edition

A cartoon-styled sandcastle sandbox that runs in a phone browser. Dig, mould,
wall, flatten, pack, wet, decorate — and watch the tide take it back.

96 m of beach, about three metres of loose sand over the working ground, nine
tools, six props and three save slots.

**Play it:** <https://sandkraft.vercel.app>

This is the web edition of [Sandkraft](https://github.com/KLINEKRAFT/Sandkraft),
a Metal/SwiftUI app for iOS and macOS. It is not a port of that app — it is a
much smaller thing that shares its physics. The angle-of-repose curve, the
eight-neighbour avalanche relaxation and the beach profile came across with
their constants intact, because those numbers are the difference between sand
that behaves and sand that does not.

Which makes this a homecoming: Sandkraft's model was itself learned from
**Tidewright**, an MIT-licensed WebGL2 sandcastle simulator, so bringing it back
to the browser returns it to where it started. See `ATTRIBUTION.md`.

## Running it

Any static server. There is no build step and no dependencies — the browser
loads ES modules directly.

```
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying to Vercel

The whole thing is static and lives at the root of this repository, so there is
nothing to configure: import the repo in Vercel, leave the framework preset on
**Other**, leave the build command empty, and the `vercel.json` here does the
rest. Every push to `main` deploys; every pull request gets a preview.

`vercel.json` marks `/src/*` as `must-revalidate`. The shader modules *are* the
app, and a cached `main.js` against a freshly deployed `shaders/` is a black
screen with no error in the console. (The rule is not a comment in that file
because Vercel validates `vercel.json` strictly and JSON has no comments — an
unknown key fails the deploy.)

Adding it to an iPhone Home Screen gives you a full-screen launcher with no
Safari chrome, which is most of the way to feeling like an app without being
one. It is still a web page: no App Store listing, no push, no haptics.

## Controls

**One finger works the sand, two fingers move the camera.** A sandbox where the
first thing a finger does is spin the world is a sandbox nobody digs in. On a
mouse: left-drag to work, right-drag or Shift-drag to orbit, middle-drag or
Ctrl-drag to pan, wheel to zoom. Two-finger pan is a toggle in the menu, because
a phone has no modifier key to hold.

## The tools

| | |
|---|---|
| **Dig** | Takes sand away, down to the hardpack and no further |
| **Pour** | Adds damp sand from the pail |
| **Mould** | Turns out a tower, a block or a cone — packed hard, so it stands |
| **Wall** | Drags out a packed rampart at one height |
| **Flatten** | Levels toward wherever the stroke began |
| **Pack** | The flat of a hand. This is what buys a vertical face |
| **Wet** | Water. The other thing that buys a vertical face, until it is too much |
| **Place** / **Pick up** | Flags, buckets, spades, shells, starfish, umbrellas |

Every stroke is a *swept segment*, not a stamped point, so a fast drag is
continuous rather than dotted. Strength eases in over about a fifth of a second,
which is what stops a tap from gouging.

## How a frame is built

1. **Bake the hardpack** — once, at startup, into an RG float table over ±72 m.
   `bedrock()` is several noise evaluations describing ground that never moves,
   and the solver would otherwise ask for it nine times per texel per step.
2. **Step the solver** — two or three substeps of fragment-shader ping-pong
   between two float textures. WebGL2 has no compute shaders, so this is the
   original architecture rather than the app's Metal kernels.
3. **Draw sky, beach, props, sea** into an offscreen colour + depth target.
   The fine grid goes down before the skirt, so the skirt's fragments over the
   playable square are depth-rejected instead of shaded twice.
4. **Ink and composite** — silhouettes found in screen space from depth.

There are no vertex buffers anywhere. Positions are decoded from `gl_VertexID`
and the height comes from a vertex texture fetch of the live simulation, so the
geometry cannot lag the sand by a frame.

## What "cartoon" means here

Four decisions, not a filter over a realistic renderer:

- light is quantised into three bands rather than smoothly integrated;
- shadow is a **hue shift** toward violet rather than the same colour multiplied
  down — that single change is most of what separates a cartoon from an
  underexposed photograph;
- every silhouette on the playable square gets an ink line;
- the sea is two tones and a band of foam, with no specular at all.

## The two invariants

Inherited from the app, and every edit to `src/shaders/sim.js` has to preserve
both:

1. **Every pair transfer is exactly antisymmetric.** Sand is conserved to the
   last grain. This is what makes an undermined wall fall over without anybody
   scripting it.
2. **No cell gives away more than 1/9 of what it owns per step.** Eight
   neighbours pull on the same cell in the same pass. Let each take an eighth
   and a cell under a breaking wave is asked for more sand than exists, goes
   negative, gets clamped at zero — and that clamp quietly *mints* sand.

## Requirements, honestly

- **WebGL2** and one of `EXT_color_buffer_float` or
  `EXT_color_buffer_half_float`. In practice: iOS 15+, and any current desktop
  browser. Without a float render target the solver cannot run, and the page
  says so rather than showing a black canvas.
- Full float is asked for first. Sand depth is a length in metres and half float
  runs out of mantissa around a millimetre, which shows up as drift in a tall
  wall.

## Known limits

Written down rather than left to be discovered:

- **Picking marches the *pristine* shore, not the live field.** The ray
  converges against the baked table — hardpack plus the bed the tide left — so
  the cursor drifts a little when you work on top of your own castle. Moulds do
  not have this problem: placing one costs a single-texel readback of the live
  field, which is affordable once per tap and not once per frame.
- **Past ±72 m the beach falls back to evaluating the profile per pixel.** That
  is most of the distant frame, and it is the largest remaining cost.
- **No score and no particles.** The native app has both. This does not.
- **The frame-time watchdog only steps down.** If a device cannot hold 30 fps it
  drops the pixel ratio once, then once more, and stays there. A watchdog that
  also steps back up oscillates, and a picture that pulses between two
  sharpnesses is worse than one that is simply softer.
- The sea fills any depression below sea level whether or not it is connected to
  the water. On a real beach that is groundwater and looks right; in a deep
  moat cut inland it is a coincidence that happens to look right.

## Licence

MIT — see `LICENSE`. The physics carries Tidewright's MIT lineage, recorded in
`ATTRIBUTION.md`.
