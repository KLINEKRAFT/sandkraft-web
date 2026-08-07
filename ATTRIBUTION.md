# Attribution

This game's physics did not start here, and the chain matters.

**Tidewright** by winchxyz (<https://github.com/winchxyz/tidewright>) is an
MIT-licensed WebGL2 sandcastle simulator. **Sandkraft**
(<https://github.com/KLINEKRAFT/Sandkraft>) is a Metal/SwiftUI app for iOS and
macOS that was written after studying it, carrying the model across and
rewriting everything above it. This repository is the web edition of Sandkraft,
which brings that model back to the browser it came from.

So the sand in this repository is, by descent, Tidewright's sand.

## What travelled

- The **angle-of-repose curve** — the moisture and packing response, including
  the floor that lets packed sand keep its shape after it dries.
- The **eight-neighbour avalanche relaxation**, and both of its invariants: the
  exactly antisymmetric pair transfer, and the one-ninth per-step limit that
  stops a clamped cell minting sand under a breaking wave.
- The **beach profile** — the shore's shape, the build pad, the loose bed.
- The **depth-limited breaking** and the shape of the wave work term.

Those constants are carried across unchanged, because they are the difference
between sand that behaves and sand that does not.

## What did not

- **None of the interface.** The tools, the cartoon look, the ink pass, the
  props, the save slots and the whole UI were written for this project.
- **None of the prose.**
- **None of the rendering.** Tidewright's renderer, Sandkraft's Metal renderer
  and this one are three different programs.

## Licence

Tidewright is MIT-licensed. Sandkraft is MIT-licensed. This work is MIT-licensed
— see `LICENSE`. Tidewright's own notice covers the model it contributed.
