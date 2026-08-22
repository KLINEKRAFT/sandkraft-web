# Sandkraft — web edition

A cartoon-styled sandcastle sandbox that runs in a phone browser. Dig, mould,
wall, flatten, pack, wet, decorate — and watch the tide take it back.

96 m of beach, about three metres of loose sand over the working ground, nine
tools, six props and three save slots.

**Play it:** <https://sandkraft-web.vercel.app>

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

## On the Home Screen

Adding it to an iPhone Home Screen gives you a full-screen launcher with no
Safari chrome, which is most of the way to feeling like an app without being
one. It is still a web page: no App Store listing, no push, no haptics.

Three things have to agree for that to actually be full-screen, and getting only
some of them right installs a *framed* web app instead — one iOS insets inside
the safe area, painting the page's background colour into the margins above and
below. That shows up as a band of flat colour where the beach should be.

- the `apple-mobile-web-app-*` metas, which older iOS reads;
- `manifest.webmanifest` with `display: standalone`, which current iOS reads;
- `viewport-fit=cover`, which is what lets the canvas run under the status bar
  and the home indicator rather than stopping at them.

`body` also carries a two-stop gradient — sky at the top, sand at the bottom —
rather than a flat colour. It is never seen when the above is working. It is
there because when it is *not* working, that background is exactly what iOS
paints into the margins, and two stops that match what the renderer draws at
those edges make the seam invisible instead of a bright stripe.

**iOS caches an installed app's metadata at the moment you add it.** Changing any
of this does nothing to an app already on a Home Screen — it has to be removed
and re-added.

`icon-180.png` exists because without an `apple-touch-icon` iOS puts a
*screenshot of the page* on the Home Screen. It is the one place this project
spends a second request on something that is not the game.

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
| **Mould** | Turns out a tower, a block or a cone — packed hard, so it stands. Tap for one; **drag to lay a run** |
| **Wall** | Drags out a packed rampart at one height |
| **Flatten** | Levels toward wherever the stroke began |
| **Pack** | The flat of a hand. This is what buys a vertical face |
| **Wet** | Water. The other thing that buys a vertical face, until it is too much |
| **Place** / **Pick up** | Flags, buckets, spades, shells, starfish, umbrellas |

Every stroke is a *swept segment*, not a stamped point, so a fast drag is
continuous rather than dotted. Strength eases in over about a fifth of a second,
which is what stops a tap from gouging.

**Dragging the mould lays a run.** Every shape in the run stands on the height
the run *started* at, which is what makes a line of blocks come out as one wall
with a level top instead of a row of lumps following the beach down to the sea.
Blocks turn to face along the drag and overlap heavily so the run reads as solid;
towers and cones stand further apart, so dragging those gives you a row of
turrets. A tap keeps the heading the last drag ended on, so a wall you extend one
block at a time stays square to the wall it is extending.

**Undo** (↺, top left) goes back a step at a time — eight on a phone, fourteen on
a desktop. One entry per action: a stroke is one undo, a dragged run of forty
blocks is one undo, and so is starting a new beach. The copy is
`blitFramebuffer`, GPU to GPU, so taking it costs nothing on the strokes nobody
ever undoes. `sim.snapshot()` would have been the obvious way and is the wrong
one: it is a `readPixels` of a megabyte and a half that stalls the pipeline, on
every stroke, whether or not the feature is used.

**Snap** (⊞, beside the size slider) is two things under one switch, because they
are one idea — stop the beach depending on how steady your thumb is:

- the tool lands on a one-metre grid, so two towers placed a minute apart line
  up. One metre rather than something derived from the brush, because a grid that
  changes size when you move a slider is not a grid you can build a symmetry on;
- a **mould run or a wall drag locks to one of the eight compass headings** and
  runs dead straight from where it began, however much the finger wanders. The
  heading is *latched* once the drag is a metre and a half long, not re-derived
  as you go: a hand wobbling across the boundary between two headings would
  otherwise make the far end of the wall jump between two rays and the run would
  fill in the gap each time. What you get then is not a wall, it is a ploughed
  field.

The ring on the sand is the tool. Its rim is the edge of the brush, its inner
ring is the part working at full strength (`BRUSH_CORE` in `shaders/common.js` —
the same number the solver shapes its falloff with, so the picture and the effect
cannot drift apart), and the pip is where the stroke is aimed. It is painted by
the terrain shader rather than drawn as an overlay, which is why it lies over
dunes, down into holes, and under the sea. It appears when you touch the beach,
when you move the size slider, and when you change tool, and it fades on its own
a beat after you let go. The colour is the tool's; the metre reading beside the
slider is what that tool will actually use, which is not always the slider's own
number.

## How a frame is built

1. **Bake the hardpack** — once, at startup, into an RG float table over ±72 m.
   `bedrock()` is several noise evaluations describing ground that never moves,
   and the solver would otherwise ask for it nine times per texel per step.
2. **Step the solver** — two or three substeps of fragment-shader ping-pong
   between two float textures. WebGL2 has no compute shaders, so this is the
   original architecture rather than the app's Metal kernels.
3. **Bake the light** — one small world-space pass over the playable square,
   holding how much of the sun and how much of the sky reach each point. See
   below.
4. **Draw sky, beach, props, sea** into an offscreen colour + depth target.
   The fine grid goes down before the skirt, so the skirt's fragments over the
   playable square are depth-rejected instead of shaded twice.
5. **Ink and composite** — silhouettes found in screen space from depth.

There are no vertex buffers anywhere. Positions are decoded from `gl_VertexID`
and the height comes from a vertex texture fetch of the live simulation, so the
geometry cannot lag the sand by a frame.

## Sun and sky

A heightfield does not need a shadow map. The occluder and the receiver are the
same function, so you can walk toward the sun and ask whether the ground has got
above you yet — no second camera, no depth pass, no bias to tune, and no
resolution mismatch between what casts and what receives.

`src/shaders/light.js` marches that walk and writes two terms into a small RGBA8
table over the playable square:

- **sun visibility**, directional, with a penumbra that widens with distance from
  the receiver — a moulded lip stays crisp at its own foot and a headland goes
  soft across the bay. This is the term whose absence made a castle look like a
  sticker lying on the beach.
- **sky visibility**, ambient, by horizon angle in eight directions. This is the
  one no amount of normal-based shading can fake: the normal at the bottom of a
  hole points straight up at the sky it cannot see, so without it a moat is as
  bright as open sand and reads as a painted circle.

Baked into a table rather than evaluated per pixel because the cost then stops
depending on how many pixels the phone has — 256² is one 65k-fragment pass
whatever the display is doing, against a terrain shader running over a million
fragments at 2x. It is re-baked every frame, not once, because the thing casting
the shadows is the thing you are digging.

Two rules about how it is *applied*, and both matter more than they look:

- the cast shadow folds into the lambert term **before** the banding, so a shadow
  edge lands in the same three tones as everything else. A quantised key light
  multiplied by a smooth shadow puts a fourth, ungraded value on the beach and
  the picture stops reading as flat colour.
- occlusion goes **into the shade colour**, not on top of the result. Ambient
  occlusion describes sky light that never arrives, and the shade tone is where
  the sky light is. Laid over the top it double-darkens everything that is both
  turned away from the sun and enclosed — which is most of a sandcastle — and a
  moulded tower comes out looking like grey plastic.

## What "cartoon" means here

Five decisions, not a filter over a realistic renderer:

- light is quantised into three bands rather than smoothly integrated — and so
  is everything that modulates it, including both occlusion terms;
- shadow is a **hue shift** toward violet rather than the same colour multiplied
  down — that single change is most of what separates a cartoon from an
  underexposed photograph;
- cast shadow and ambient occlusion are both real and both cheap, because the
  ground is a function rather than a mesh;
- relief carries **contour lines**, at 45 cm, on ground sloped enough to have
  something to say. The camera looks along the beach at about thirty-five
  degrees, which foreshortens a trench seen down its own length into a dark
  smear — shading can tell you a slope is there but not how far down it goes.
  Contours can, which is why maps have them. They band out at both ends: flat
  beach has no depth to report, and a near-vertical face crowds them into
  stripes that turn a moulded tower into a layer cake;
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
