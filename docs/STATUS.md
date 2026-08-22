# Where the project actually is

A handoff document. Read this first in a new session; `PLAN.md` is the original
technical design and `ROADMAP.md` is what happens next and why. This file is
the current state of the machine — what exists, how it is put together, what is
known to be wrong, and which invariants must not be broken.

Last updated at the end of the ground-detail polish pass.

---

## The one-paragraph version

The planet, the simulation, and the interface all work. Below about a kilometre
a settlement is now a real place — streets, buildings, fields, people — instead
of a coloured marker. A tap opens whatever is under it. Great works get built,
outlive the states that built them, and stand over the ruins afterwards.
Nothing in the game ships as an art asset: every model, texture and sprite is
generated at start-up from code.

---

## What runs

```bash
npm run dev            # then open the printed LAN address on a phone
npm run build          # type-check and bundle to dist/

npm run soak           # 120 worlds x 3000 years, headless, with assertions
npm run verify-save    # prove a reloaded world is the same world
npm run verify-motion  # prove the sea still moves
npm run verify-camera  # prove the planet follows your finger
npm run shot           # render the reference screenshots headlessly
npm run history        # print one world's chronicle as a player would read it
```

**Run `soak`, `verify-save` and `build` before every commit.** The soak is the
only thing standing between a plausible-looking economy tweak and a planet
where every civilization dies in year 400.

### Screenshots are the main development tool

There is no way to judge this project by reading its code. `npm run shot`
drives a real browser through fixed viewpoints and writes to `docs/shots/`.
Useful flags:

| | |
|---|---|
| `npm run shot -- city city-close` | just those viewpoints |
| `TAG=try2` | suffix the filenames, so two runs can be compared |
| `CLOUDS=0` | clear sky, when cloud shadows are confusing the read |
| `KIT=all npm run shot -- kit-low` | the model catalogue instead of the world |
| `KIT=2 npm run shot -- kit-prop` | one row of six, close enough to judge |
| `SETTLE_MS=20000` | give up waiting for LOD sooner; the images are fine |
| `VW=1200 VH=700` | viewport size |

Everything renders under software rasterisation here, so `fps` in these shots
is meaningless and `TIMEOUT` on the settle check is normal and harmless.

**The kit sheet (`?kit=`) is how models get judged.** In a town a model is
small, half-occluded, at whatever angle the street put it, and lit by whatever
the sun was doing — a wrong roof pitch survives a dozen screenshots. Lined up
on a grid at a known distance it is obvious in one frame. Rows are
`kit=0`..`kit=4`, six models each, grouped by era; `kit=all` is everything.

---

## Architecture, in the order things happen

```
src/
  core/          rng, noise — deterministic, no dependencies
  planet/        the terrain function, cube-sphere LOD, quality tiers
  sim/           the simulation. No DOM, no three.js — runs in Node too
  workers/       terrain meshing pool, simulation worker
  game/          main-thread handle on the sim worker, persistence
  render/        materials, camera rig, post pipeline, settlement markers
  render/ground/ everything below a kilometre: towns, roads, plants, people
  ui/            HUD and inspector, plain DOM over the canvas
```

### The simulation

One tick is one year. Runs in its own worker on its own clock, so history
advances at the same rate whether the renderer is managing 60 fps or 20. It is
**deterministic**: a world is completely described by its seed plus the list of
times the player moved a dial, which is what makes saves 145 bytes and the soak
harness possible.

There are no citizen agents. Population is a scalar per cell. The people you
see walking about are renderer decoration, which is what lets a century of
absence resolve in milliseconds.

**Settlement tiers were rescaled this pass.** They ran to 180,000 people on a
graph where one cell is ~1,500 km² and tops out near 9,000, so half of every
planet was a hamlet and the other half a village — *town*, *city*, *great city*
and *metropolis* could never be true of anywhere. Now `[420, 1400, 2600, 4200,
6000, 7800]`, which gives roughly 330 hamlets / 250 villages / 225 towns / 130
cities / 60 great cities / 1–2 metropolises per planet.

**Wonders** are owned by the *cell*, not the settlement or the state, because
the whole point is that they outlive both. A rich, stable state with 22k people
raises one at its largest city without one, spends 1500 treasury, and waits 320
years. Five to thirty per world in three thousand years.

### The ground detail system

`src/render/ground/` — the largest thing built this pass.

| File | What it does |
|---|---|
| `kit.ts` | `MeshBuilder`: boxes, prisms, cones, gables. Bakes per-vertex AO |
| `archetypes.ts` | The catalogue: 29 models, authored at real size in metres |
| `style.ts` | Era palettes, street layout, road width, coursing, lamp strength |
| `plan.ts` | Lays out one town: streets first, then buildings on the frontage |
| `showcase.ts` | The kit sheet (`?kit=`) |
| `buildings.ts` | Instanced draw, one call per archetype. Owns the shadow layer |
| `shadows.ts` | A sheared footprint quad per building |
| `roads.ts` | Ribbon geometry draped on the height field |
| `props.ts` | Crossed quads: trees, crops, scrub |
| `people.ts` | Animated billboards |
| `textures.ts` | The two procedural atlases |
| `wilderness.ts` | Vegetation outside towns, one disc following the camera |
| `detail.ts` | Chooses which towns exist, budgets planning, uploads |

**Streets before buildings, always.** Scattering buildings and connecting them
afterwards gives a road network that looks like a road network and a town that
does not look like a town. A settlement is frontage on a route.

**A building's transform is not a matrix.** It is an origin, an angle and three
scales; the frame is rebuilt in the vertex shader from the origin, because on a
sphere "up" is a function of where you are standing.

**LOD bands are nested, not equal.** Roads appear first (1500 m) because a road
reads from far higher than the buildings beside it, then buildings (1100),
then plants (620), then people (260). All scale by the quality tier's
`detailRange`.

---

## Invariants — do not break these

1. **Determinism.** Nothing in `src/sim/` or world generation may call
   `Math.random()`. Every draw comes from a seeded generator. `npm run soak`
   asserts a replayed history hashes identically.
2. **The simulation package has no DOM and no three.js.** It has to run in Node
   for the balance tools.
3. **The cell graph is never drawn.** Territory is a painted field; borders are
   curves the shader finds where two colour fields meet.
4. **Nothing ships as an asset.** Models, textures and sprites are generated at
   start-up. This is what keeps the build a couple of hundred kilobytes.
5. **Instance basis handedness.** With `east × north = up`, the model frame
   must be `(-(east*c + north*s), up, fwd)`. The un-negated version has
   determinant −1 — a mirror, not a rotation — and every model renders inside
   out with its normals pointing inward. It presents as a lighting bug.
6. **Buildings need indirect light terrain does not.** Terrain is draped over a
   sphere so nearly all of it faces the sky; a building is four vertical walls
   and one always faces away from the sun. Without skylight and a ground-bounce
   term that wall is not shadowed, it is black.
7. **GLSL `smoothstep(hi, lo, x)` is undefined.** Write
   `1.0 - smoothstep(lo, hi, x)`. The reversed form works on some drivers and
   returns zero on others, which reads as "the feature does not render".

---

## Things known to be wrong

Ordered by how much fixing them would buy. The next pass brief in
`NEXT-PASS.md` covers the first four in detail.

1. **Buildings congest and overlap.** Collision is a circle test at 78% of the
   footprint radius, which is too generous for the setback the planner uses.
2. **Roads are placed per-town with no cohesion.** Layouts are generated blind
   to terrain and to each other; nothing connects one town to the next.
3. **A tier change reshuffles the entire town.** The plan RNG is seeded with
   `cell * 7919 + era * 31 + tier`, so growing from village to town regenerates
   every building in a new place. This is the "a whole section of city
   disappears and a new section comes up" pop-in.
4. **Simulation speed does not drive anything visual.** `Environment.dayLength`
   is a fixed 240 real seconds and cloud drift runs on real time, so at 9× the
   sun still takes four minutes to cross the sky while centuries pass.
5. **A primitive coastal town can get a lighthouse.** `plan.ts` picks it on
   `req.coastal && rng.chance(0.35)` with no era gate.
6. **Night lighting is window emission at every era.** A primitive village
   glows dimly from windows rather than from fires.
7. **Masonry detail fades out by ~460 m**, so a town at mid zoom is flat
   colour. Correct for cost, still a gap.
8. **Vegetation only exists near the camera** — one disc, not a planet-wide
   scatter tied to the terrain LOD patches.
9. **Shadows are a sheared footprint quad**, which shows on a low sun.
10. **Wars are invisible.** The chronicle says two states are at war; nothing
    on the planet does.

---

## Persistence is deliberately off

`PERSIST_BY_DEFAULT = false` in `src/game/save.ts`. Persistence works and
`verify-save` proves it on every run — but resuming was landing every reload
back in the same late-stage world, and the part under construction is how a
civilization *grows*. With it off the seed cannot stay fixed either, or "a new
world" is the same history replayed identically, so an unseeded session
generates a fresh planet.

- `?seed=name` pins a planet worth returning to
- `?save=1` resumes the stored world
- press **H** for the debug HUD, which shows the current seed

Flipping the one constant makes it the default again; nothing else changes.

---

## URL parameters

| Parameter | Effect |
|---|---|
| `seed=name` | World seed. Omit and every load is a new planet |
| `save=1` | Resume the stored world |
| `quality=low\|medium\|high` | Override the auto-detected tier |
| `detail=0.5` | How far out ground detail is built. Zero switches it off |
| `kit=all\|0..4` | Draw the model catalogue instead of the world |
| `hud=1` | Performance HUD (or press `H`) |
| `lat` `lon` `altitude` `heading` `sun` `tilt` | Jump to a viewpoint |
| `speed=20` | Years of history per real second |
| `cells=8192` | Simulation graph resolution |
| `scale=0.75` | Internal render resolution multiplier |
| `bloom` `clouds` | Override post-processing strength |

---

## Two traps worth knowing before you debug anything

**The camera frames its target, or it does not.** The rig hangs above its
target and looks along its heading, so the target is centred only when looking
straight down. By a couple of hundred metres the tilt has opened past half the
field of view and the thing you asked to look at is below the bottom of the
frame. `CameraRig.frameOn` / `flyTo` walk the nadir back by
`altitude × tan(tilt)` as an angle on the sphere. Screenshots that seem to show
"nothing was built" have usually been aimed at the ground under the camera.

**Freeboard is not "above sea level".** The sea has three bands of wave
geometry over it and a surf line reaching three metres of *depth*. Ground half
a metre proud of the datum is ground the water is standing on. Buildings need
1.8 m, roads 1.5 m. This produced a town scattered across a tidal flat that
read as a dark patch of ground rather than as a bug — and it took disabling
the shadow layer to prove it was not the shadow layer.
