# Pocket Planet — Technical Plan

A persistent civilization simulation on a living planet. Rotate a world, nudge a
civilization's priorities, and come back later to read the history it wrote while you
were gone.

**Web first.** The game is a browser app, deployed to Vercel, playable on a phone from a
URL. Capacitor wraps the same build into an Android AAB later, once the game is worth
installing. That ordering is deliberate: it makes every change testable on a real phone
in seconds instead of through a native build, and it means there is always something to
show.

This document is the build contract. The **Out of scope** list is as binding as the
**In scope** list.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Target | **Web → Vercel**, Capacitor → Android later | Instant deploys, real-device testing from a link, one codebase |
| Render | **three.js, WebGL2** | The whole planet is a few hundred thousand triangles; this is well within reach |
| Language | **TypeScript**, strict | The simulation has to run in the browser, in a worker, and in Node for the headless tools |
| UI | React or plain DOM **over** the canvas | Text and panels belong in DOM. Never build UI inside the 3D scene |
| Build | **Vite** | Fast HMR against a phone over LAN |
| Sim | **Pure TS, no dependencies, in a Web Worker** | No DOM, no three.js. Runs identically in Node for the balance harness |
| Test | **Vitest** + headless soak runner + Playwright screenshots | See §6 and §7 |

**No LLM anywhere in the game.** It was in an earlier draft of this plan and it is out.
The chronicle is generated from a template grammar: deterministic, instant, free, offline,
and with no per-player cost. Nothing about the game needs a model at runtime, and a
contest entry that phones an API to write flavour text is weaker, not stronger.

### Performance budget

Target **60 fps on a mid-range Android phone**, 30 fps floor on low-end.

- Terrain patches visible: **under ~280** (enforced adaptively, see §3)
- Triangles: **under ~400k**
- Draw calls: **under ~250**
- Sim tick: **under 4 ms** at full civilization count
- Cold start to a visible planet: **under 3 s**

---

## 2. The planet is continuous, not tiled

There are no hexes and no visible cells. The terrain is a **pure function of position on
the unit sphere** — noise, evaluated anywhere, at any detail level. That is what makes it
possible to zoom continuously from orbit down to a person standing in a field without the
world ever resolving into a board.

### Terrain function

Ordered, all seeded from the world seed:

1. **Domain warp** — a gentle low-frequency offset of the sample position. This is the
   cheapest trick that turns blobby noise islands into coastlines with peninsulas, bays
   and archipelagos. Turned up too far it shears continents into marbled swirls, so it
   stays gentle.
2. **Continent field** — a low-frequency, fast-decaying fBm for a handful of large
   landmasses, plus a small high-frequency term that perturbs only the coastline. Split
   this way, the continents stay whole while the shore stays interesting.
3. **Ocean floor** — abyssal plains deepening away from the shelf, with mid-ocean ridges
   lifting long welts back through them.
4. **Land base** — a rolling plateau field.
5. **Mountain belts** — ridged multifractal, gated by a separate low-frequency *orogeny*
   mask so ranges form in bands across a continent instead of studding it evenly.
6. **Hills and surface detail** — faded out near the waterline, or fine detail crosses sea
   level constantly and peppers every coastal plain with sub-metre puddles.
7. **Climate** — temperature from latitude and a mild lapse rate; moisture from
   circulation bands, distance inland, and rain shadow.

### Band-limiting

Every octave fades out once its features approach the vertex spacing of the mesh being
built, and the loop exits early once nothing coarser remains. Without this, a coarse patch
samples high-frequency noise at random phase and the terrain visibly boils as LOD levels
swap. With it, detail fades in smoothly and the silhouette never moves.

*Verified*: `tools/probe-terrain.ts` shows height converging to within 0.002 m as sample
spacing falls from 64 m to 0.25 m.

---

## 3. Chunked-LOD terrain

Six quadtrees, one per face of a **cube-sphere** (spherified, not normalised, so vertices
spread evenly). Subdivision is driven by **screen-space error in pixels**, not world
distance — the same setting then behaves correctly on a phone and a monitor, at any field
of view, with no retuning.

- Patch meshes are built in a **worker pool**, ~4 ms each, and recycled through a geometry
  pool so a flight from orbit to ground allocates almost nothing after the first seconds.
- Normals come from a **one-vertex halo** around each patch rather than extra height
  samples: 12% more vertices instead of 200% more.
- Vertices are stored **relative to the patch centre**, so float32 keeps centimetre
  precision at ground level.
- A node keeps drawing its own mesh until all four children arrive, so a fast zoom never
  opens holes.
- **Skirts** plug LOD cracks, kept short: a skirt is a vertical wall, and at the horizon
  it is seen edge on.
- **Horizon culling** by angle, because frustum culling alone leaves the entire far side of
  the planet in the draw list whenever the camera looks along the surface.
- An **adaptive governor** trims the error budget to hold the patch count near target. A
  fixed pixel error is right for image quality but says nothing about cost: looking along
  a mountain range at low altitude asks for several times the geometry of looking straight
  down from orbit.

---

## 4. Rendering

Deferred-ish, four passes:

```
scene ──► HDR colour + depth
       ──► composite   (ocean, atmosphere, stars)
       ──► bloom       (bright pass, two blurs, quarter resolution)
       ──► final       (bloom add, ACES tone map, vignette, dither, sRGB)
```

### The ocean is not geometry

The sea is a perfect sphere of known radius, so the view ray is **intersected with it
analytically, per pixel**, in the composite pass. The waterline is therefore exact at
every zoom — no tessellation to pick, no polygonal coastline when you fly down to a beach,
no transparency sorting. Water depth comes from the scene depth buffer, which is what lets
shallows show the sea floor through them and deeps swallow it.

### Atmosphere

Single-scattering Rayleigh and Mie, raymarched, bounded by the same depth buffer — so one
piece of code fogs distant mountains and rims the limb from orbit.

**The one genuinely hard problem here**, and the reason it is written down: how far you can
see before the air whites out, and how blue the sky is overhead, are not independent. Their
ratio is `distance / scaleHeight`. Earth gets away with an 8 km scale height because that
is comparable to how far we care to see. This planet has a **one-kilometre radius**, so a
scale height scaled to match would be metres — and standing on a hill, the next hill two
hundred metres away would vanish in white haze while the zenith stayed clear. Scale it up
instead and the halo from orbit swells into a fuzzy blue bubble.

The fix: **the scale height follows the camera, but the product `beta × H` is held
constant**, pinning the vertical optical depth at the usual 0.35 in blue. The sky is the
same colour and brightness at both ends; only the horizontal reach of the air changes. You
never see the limb from the ground nor the ground from orbit, so nobody sees it move.

Sunlight is separately reddened and dimmed by the air it crossed to reach the ground, which
is what produces golden hour. The scattering pass must use the **unextincted** solar colour,
never the reddened one — feeding it pre-extincted light applies the same absorption twice
and turns the dusk sky olive.

### Surface shading

Biomes are a **continuous function** of temperature, moisture, altitude and slope — never a
lookup into a tile type. A rainforest thins into savanna over kilometres instead of
switching at a cell boundary. Beaches, exposed rock on steep ground, a snow line driven by
temperature, and large-scale mineral variation that shows through arid ground and hides
under vegetation.

Fragment-level detail noise fades by **how large a pixel is on that surface**, not by camera
altitude: at 150 m up, terrain near the horizon is kilometres away, and detail sized for the
ground underfoot is pure aliasing out there.

---

## 5. The simulation

The product. The graphics are the packaging.

### Two hard rules

1. **Fully deterministic.** Seeded PRNG threaded explicitly. No `Math.random`, no
   `Date.now`, nothing unordered inside the sim package. Same seed plus the same player
   event log reproduces a history byte for byte — which makes saves a few KB after
   millennia, makes worlds shareable, and makes the balance harness possible at all.
2. **No citizen agents.** Population is a scalar. The people you see are renderer
   decoration driven by statistics. This is what makes "143 years passed while you were
   away" resolvable in milliseconds, and at phone zoom nobody can tell.

The simulation runs on an **invisible** cell graph over the sphere — points distributed by
a Fibonacci spiral, with adjacency for spread and flow. It is never drawn. Territory is
painted as a smooth field, so borders are soft curves, not cell edges.

### Entities

| Entity | Count | Holds |
|---|---|---|
| `Cell` | ~4000 | terrain sample, owner, population, development, fertility |
| `Settlement` | 10–200 | cell, population, tier, founded tick |
| `Polity` | 2–12 | treasury, tech, stability, legitimacy, policies, relations |
| `Culture` / `Religion` | 1–20 | traits, name pool, parent, birth and death tick |
| `Event` | append-only | type, structured parameters, tick |

`Culture` and `Religion` are **independent of polities and outlive them**. That single
choice is what makes a 2000-year history feel like history rather than a scoreboard.

### Tick

**One tick = one year.** Ordered pure phases: environment → food → population → migration
and expansion → economy → knowledge → culture and religion → stability → diplomacy and war
→ crisis → collapse and succession → event emission.

### Player input

Six policy dials sharing a fixed budget: **Trade, War, Education, Expansion, Conservation,
Culture**. That is all. The player is a pressure, not a commander — and a small typed input
set is exactly what keeps deterministic replay tractable.

### Collapse

Stability reaching zero is never game over. It resolves as **fragmentation** (settlements
k-means clustered into successor states), **wasteland** (ruins, resettleable centuries later
with a tech bonus), or **conquest** (absorbing a restive minority that suppresses stability
for generations). Cultures and religions survive all three.

### Offline progress

One tick per 30 real seconds, capped around 2000 ticks. Server time when online, monotonic
with a backwards-clock guard otherwise. On resume, catch-up runs in the worker behind a
progress bar and presents a "while you were away" digest.

---

## 6. The balance harness — at M2, not at the end

The hard problem in this genre is not rendering. It is that long-horizon economies drift
into degenerate equilibria: everything grows forever, or everything dies by year 300.

`tools/soak` runs **500 seeds × 3000 ticks headless** and asserts no NaN, no negative
population, no unbounded treasury; that 20–60% of civilizations reach Industrial by year
2000; that collapse occurs in 40–80% of runs; and that tick time stays under budget. It
runs in CI on every change to the sim.

This is simultaneously what keeps the game fun and the strongest engineering artifact in
the project.

---

## 7. Visual regression harness

`npm run shot` builds the app, serves it, drives the camera through a fixed set of
viewpoints, waits for the LOD system to report it has nothing left to build, and captures
each one. Deterministic seed and a pinned sun make two runs comparable.

This has already earned itself several times over. It caught a snow line that keyed off
maximum elevation and so froze every temperate continent; ocean absorption tuned for
Earth's bathymetry on a planet whose deepest trench is 22 m; a detail-normal gradient
missing its division by the sample epsilon, which threw specular hotspots across the whole
landscape; and a sun angle in the harness itself that was shooting "mountains at dawn" on
the night side of the planet.

It is also worth recording what it *disproved*: a stair-stepped planet limb that looked
exactly like an LOD bug survived an eightfold increase in tessellation unchanged, and
turned out to be the harness upscaling a reduced-resolution buffer across a high-contrast
edge. Shots now always render 1:1.

---

## 8. Scope

### In (MVP)

Continuous procedural planet, orbit to ground · analytic ocean with depth, foam and glint ·
scattering atmosphere with golden hour · starfield, bloom, tone mapping · ~4000-cell
invisible sim graph · 3 starting polities · 6 policy dials · 4 eras · settlements with
per-era sprites · soft painted territory · culture and religion spread and schism · 4 crisis
types · collapse with fragmentation, wasteland and conquest · resettleable ruins · template
chronicle with a timeline · offline catch-up and digest · save/load · quality tiers ·
ground-level buildings and billboard citizens.

### Out (explicitly)

Citizen agents · unit-level armies · roads · Modern, Futuristic and Spacefaring eras ·
zombies · nuclear war · multiple planets · multiplayer · **any LLM** · cloud save · iOS ·
monetization.

Adding anything from the right column means cutting something from the left.

---

## 9. Status

| Milestone | State |
|---|---|
| M0 Web app shell, deployable | **done** |
| M1 Planet: terrain, cube-sphere LOD, worker meshing | **done** |
| M2 Rendering: ocean, atmosphere, bloom, golden hour | **done** |
| M3 Camera: orbit-to-ground, touch and mouse input | **done** |
| M4 Visual regression harness | **done** |
| M5 Simulation core and soak harness | **done** |
| M6 Settlements, territory, night lights | **done** |
| M7 Interface: priorities, chronicle feed, time controls | **done** |
| M8 Save/load and offline catch-up | next |
| M9 Ground detail: buildings, billboard citizens | |
| M10 Capacitor wrap, Play Store internal test | |

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Phone GPU performance | Quality tiers, adaptive patch governor, half-resolution bloom. Test on a real budget device before M8, not after |
| Sim drifting to degenerate states | The soak harness, at M5, gating CI |
| Scope creep | §8's Out list is a contract. Trade, do not add |
| Determinism silently broken | CI replays a fixed seed and diffs the final state hash |
| Ground-level detail costing more than it is worth | It is the last milestone for a reason; the planet has to stand on its own first |
