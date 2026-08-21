# Pocket Planet — Technical Plan

A persistent 3D civilization simulation for Android. Rotate a living planet, nudge a
civilization's priorities, and come back later to read the history it wrote while you
were gone.

This document is the build contract. The **Out of scope** list is as binding as the
**In scope** list.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Capacitor 6 → Android AAB** | Real Chrome WebView: full WebGL2, Web Workers, IndexedDB, USB devtools. Native plugins for notifications, storage, billing. One codebase. |
| Render | **three.js (WebGL2)** | Requested, and comfortably sufficient — the whole planet is ~15k triangles. |
| Language | **TypeScript**, strict | Sim must be portable between browser, worker, and Node. |
| HUD/UI | **React + DOM overlay** on the canvas | Text, panels, and lists in DOM. Never build UI inside the 3D scene. |
| Build | **Vite** | Fast HMR against a device over LAN. |
| Sim | **Pure TS, zero deps, in a Web Worker** | No DOM, no three.js. Runs identically in Node for the balance harness. |
| Persistence | **IndexedDB** (snapshots), Capacitor Preferences (settings) | Snapshots are binary ArrayBuffers; IDB handles them natively. |
| Test | **Vitest** (unit) + headless soak runner (balance) | See §7. |

### Rejected alternatives

- **React Native + expo-gl** — partial WebGL implementation, fragile three.js compat,
  awkward Worker story. Capacitor gives a full modern browser engine instead.
- **Unity / Unreal** — Unreal on mobile solo is a trap (binary size, iteration time).
  Unity is defensible but discards the three.js requirement for no gain at this scale.
- **TWA / PWA-only** — no native notifications control, weaker offline story, harder
  billing.

### Performance budget

Target: **60 fps on a mid-range 2021 Android device**, 30 fps floor on low-end.

- Full sim tick: **< 4 ms** at 2562 tiles (measured in the soak harness, p99).
- Draw calls: **< 25** total.
- Triangles: **< 60k** including sprites and ambient life.
- Cold start to interactive: **< 3 s** from a snapshot.
- Catch-up of 2000 ticks: **< 4 s** in the worker, behind a progress bar.

---

## 2. The planet

### Geometry

A **Goldberg polyhedron**: the dual of a subdivided icosahedron. Every tile is a hexagon
except exactly 12 pentagons at the original icosahedron vertices. Tile count is
`10 · 4ᴺ + 2`:

| Subdiv N | Tiles | Use |
|---|---|---|
| 3 | 642 | Low-end / fast mode |
| **4** | **2562** | **Default planet** |
| 5 | 10242 | Stretch goal only |

Built once at world-gen from the seed. We store, per tile: centroid (unit vector), corner
ring, and a fixed-arity neighbour list (5 or 6).

### Data layout — struct of arrays

**Non-negotiable.** All tile state lives in parallel typed arrays, never in an array of
objects:

```ts
interface TileArrays {
  elevation:   Float32Array; // -1..1, 0 = sea level
  moisture:    Float32Array; // 0..1
  temperature: Float32Array; // 0..1, from latitude + elevation
  biome:       Uint8Array;   // enum
  owner:       Uint16Array;  // polity id, 0 = unclaimed
  population:  Float32Array;
  development: Float32Array; // infrastructure / land improvement
  fertility:   Float32Array; // degrades with over-farming, recovers slowly
  pollution:   Float32Array;
  flags:       Uint8Array;   // RIVER | RUINS | COAST | ...
}
```

This gives us cache-friendly ticks, trivially cheap snapshots (one `ArrayBuffer` per
field), and zero-copy transfer to the render thread.

### Terrain generation

Ordered pipeline, all seeded:

1. **Plates** — scatter K ≈ 9 plate seeds on the sphere, assign each a random tangential
   drift vector, Voronoi-assign every tile to its nearest seed. At plate boundaries,
   compute relative motion: convergent → mountain ridge, divergent → rift/ocean trench,
   transform → mild fault. This is ~150 lines and it is the single biggest reason a
   generated planet reads as *believable* rather than as noise.
2. **Elevation** — plate boundary contribution + 3-octave 3D simplex noise, smoothed once
   over the tile graph.
3. **Sea level** — threshold tuned so land is ~28–34% of tiles. Reject and re-roll the
   seed if outside that band.
4. **Temperature** — latitude curve minus elevation lapse rate.
5. **Moisture** — ocean tiles seed moisture 1.0; diffuse inland over the tile graph with
   distance decay, attenuated hard when crossing a large elevation gain (rain shadow).
6. **Biome** — Whittaker-style 2D lookup on (temperature, moisture), overridden by
   elevation for alpine/ice. ~12 biomes: ocean, coast, ice, tundra, taiga, temperate
   forest, grassland, steppe, desert, savanna, tropical forest, alpine.
7. **Rivers** — sort land tiles by elevation descending; each pushes its accumulated flux
   to its lowest neighbour. Tiles above a flux threshold get the `RIVER` flag. Rivers
   raise local fertility and act as trade/movement corridors in the sim.

Everything above runs in the worker at start, once, in well under a second.

### Rendering — 3D geometry, 2D art

The honest answer to "3D or sprites?" is **both, on purpose**:

- **Terrain** — one merged `BufferGeometry` for all land tiles, fanned from each tile
  centroid. Per-vertex colour from the biome palette, multiplied in a custom shader by a
  tiling detail/grain texture so it doesn't read as flat vector art. One draw call.
- **Ocean** — a slightly smaller sphere with a cheap scrolling-normal shader, plus a
  shoreline foam band derived from coast tiles.
- **Borders** — a `LineSegments` geometry built from tile edges where
  `owner[a] !== owner[b]`, coloured per polity. Rebuilt only when ownership actually
  changes (typically a handful of ticks per century), not per frame.
- **Settlements** — **instanced 2D billboard sprites** from a per-era atlas: hut,
  hamlet, village, town, city, metropolis, arcology. Scale by population, swap by era.
  Hand-drawn sprites at this size look dramatically better than low-poly models and cost
  essentially nothing. One draw call for all settlements.
- **Ambient life** — instanced billboard particles (caravans, war bands, ships) animated
  along great-circle arcs between settlements. **Purely decorative, never simulated** —
  spawn rate driven by trade volume and war state. Hard cap ~200, culled by zoom.
- **Atmosphere** — a fresnel rim shader on a slightly larger back-face sphere. Trivial
  cost, enormous perceived-quality payoff.
- **Clouds** — a slowly counter-rotating alpha sphere with a seamless noise texture.
- **Night side** — emissive city lights where population exceeds a threshold, blended
  against the sun direction. The strongest single visual moment in the game for near-zero
  cost, and it makes progress *visible*: a dark planet slowly lighting up over centuries.

### Camera and LOD

Orbit + pinch zoom, clamped. Zoom drives three bands:

| Band | Shows |
|---|---|
| Far | Terrain, borders, clouds, atmosphere, night lights |
| Mid | + settlement sprites |
| Near | + ambient life, settlement labels, tile inspector on tap |

---

## 3. The simulation

This is the product. The graphics are the packaging.

### Two hard rules

1. **Fully deterministic.** Seeded PRNG (xoshiro128\*\*) threaded explicitly through the
   tick. No `Math.random`, no `Date.now`, no floating-point iteration over unordered map
   keys, anywhere inside `packages/sim`. Same seed + same player-event log ⇒ byte-identical
   history, forever.
2. **No citizen agents.** Population is a scalar per tile and per settlement. The little
   people you see moving are renderer decoration derived from statistics. This is what
   makes 143 years of offline progress resolvable in milliseconds, and nobody can tell the
   difference.

### Entity hierarchy

| Entity | Count | Holds |
|---|---|---|
| `Tile` | 2562 | terrain, owner, pop, development, fertility, pollution |
| `Settlement` | ~10–200 | tile, pop, tier, buildings level, founded tick |
| `Polity` | 2–12 | treasury, tech, stability, legitimacy, policies, relations, culture, religion |
| `Culture` | 1–20 | traits, name pool, parent culture, birth/death tick |
| `Religion` | 0–12 | traits, tolerance, spread rate, parent, birth/death tick |
| `Event` | append-only | type + structured params + tick |

`Culture` and `Religion` are **independent of polities and outlive them**. That single
design choice is what makes a 2000-year history feel like history rather than a scoreboard.

### Tick pipeline

**One tick = one year.** Ordered, pure phases over the state:

1. **Environment** — climate drift, pollution accumulation and decay, fertility
   depletion/recovery.
2. **Food** — per settlement: `biome yield × tech multiplier × fertility × policy`.
3. **Population** — logistic growth toward a carrying capacity set by food and
   development; starvation decline when food < demand.
4. **Migration & expansion** — settlements over pressure threshold claim the best adjacent
   unclaimed tile, or found a new settlement. Cost scales with distance from capital
   (over-extension is a real penalty).
5. **Economy** — production, trade routes between settlements and across polity borders,
   treasury income and upkeep.
6. **Knowledge** — tech accumulates from `population × education policy × trade contact ×
   stability`. Crossing thresholds unlocks era transitions and tech nodes.
7. **Culture & religion** — spread across adjacency and trade links, weighted by policy
   and by the source polity's prestige. Schisms fork a new religion when tolerance is low
   and spread is high.
8. **Stability** — reduced by inequality, famine, war weariness, over-extension, religious
   tension, pollution; raised by prosperity, culture policy, legitimacy.
9. **Diplomacy & war** — abstract resolution. Army strength = `f(pop, tech, treasury, war
   policy, terrain)`. Wars are multi-tick states with attrition, not instant coin flips.
10. **Crisis roll** — famine, plague, civil war, invasion. Probability derived from state
    (low food → famine; low stability + high inequality → civil war; high trade contact +
    high density → plague), never from raw randomness alone.
11. **Collapse & succession** — see below.
12. **Event emission** — anything a human would notice becomes a structured `Event`.

### Player input

Six policy dials sharing a fixed budget (100 points):

**Trade · War · Education · Expansion · Conservation · Culture**

That's it. No unit orders, no building placement. The player is a *pressure*, not a
commander — and constraining input to a small set of typed events is exactly what keeps
the deterministic replay tractable. Every dial change is appended to the player-event log
with its tick.

### Collapse and succession — the signature feature

When a polity's stability reaches zero, it does **not** game-over. It resolves into one of:

- **Fragmentation** — settlements are k-means clustered on the sphere into 2–4 successor
  polities. They inherit culture and religion, retain partial tech, start with low
  legitimacy and hostile relations. The map redraws into a plausible set of rump states.
- **Wasteland** — settlements are abandoned, tiles gain the `RUINS` flag, biome degrades,
  fertility craters. Ruins are resettleable centuries later and grant a small tech bonus
  to whoever excavates them.
- **Conquest** — a neighbouring polity absorbs the territory, importing a restive
  minority culture that suppresses stability for generations.

Cultures and religions persist through all three. A dead empire's religion spreading
through its conquerors 400 years later is the kind of moment that makes this game worth
building.

### Eras

Gated on **tech thresholds, not elapsed time**, so a stagnant civilization genuinely
stagnates.

`Primitive → Ancient → Medieval → Industrial` **(MVP)** — later: `Modern → Futuristic`.

Each era swaps the settlement sprite set, adjusts growth and trade curves, and unlocks new
crisis types (Industrial unlocks pollution and ecological collapse).

### Offline progress

- Rate: **1 tick per 30 real seconds**, capped at **2000 ticks** (~16 h of real time).
- Time source: server timestamp when online; monotonic clock otherwise, with an explicit
  "clock moved backwards" guard so setting the device date forward does nothing.
- On resume: run catch-up in the worker behind a progress bar, then present a
  **"While you were away"** digest — the 5 highest-weight events, plus the map diff.
- One daily local notification carrying the single most significant event.

### Save format

```
Save = { version, seed, tickCount, playerEventLog[], snapshot? }
```

- The **seed + player-event log** is the canonical save, and it is tiny (a few KB after
  millennia).
- A **binary snapshot** (all SoA arrays concatenated into one `ArrayBuffer`) is written
  every 250 ticks purely as a load accelerator. Cold start = load latest snapshot + replay
  the tail.
- Because the sim is deterministic, a corrupt snapshot is recoverable by full replay, and
  a save file is a shareable *world* — "seed 8829471, year 1840" reproduces exactly.

---

## 4. Where an LLM actually earns its place

Not per-event flavour text — templates beat it there on consistency, latency, and cost.
Three uses that are genuinely worth it, all **bounded, cached, and optional**:

1. **The Historian's Account.** Once per era transition or major collapse (~every 150–250
   years), send the structured event log for that span and get back a titled, 3-paragraph
   narrative history with named figures, causal framing, and a period voice. One call per
   couple of centuries, cached permanently into the save. This produces something a
   grammar cannot, and it is the feature people will screenshot.
2. **Culture name generation.** When a culture is born, generate ~200 coherent toponyms,
   ruler names, and religion names in one call, then cache and draw from the pool
   deterministically forever. One call per culture. Markov chains work but are visibly
   worse.
3. **Ask your Chronicler** (stretch). A Q&A over the event log — "why did the Vashti
   Empire fall?" — answered strictly from retrieved structured events, not invented.

**Cost control is a design constraint, not an afterthought:** every call is behind a
feature flag, results are cached into the save, the template path is always a complete
fallback, and the whole feature sits behind the paid tier so spend tracks revenue. The
game must be fully playable and fully readable with the network off.

---

## 5. Threading

```
┌─ Main thread ──────────┐        ┌─ Worker ────────────────┐
│ three.js renderer      │◀──────▶│ worldgen                │
│ React HUD              │ post   │ sim tick loop           │
│ input, camera          │ Message│ event log               │
│ animation/interpolation│        │ snapshot serialisation  │
└────────────────────────┘        └─────────────────────────┘
```

- The worker sends a compact **render delta** per tick: changed tile owners, the settlement
  list, new events. Transferable `ArrayBuffer`s, zero copy.
- The renderer interpolates between ticks and **never reads sim internals**. This boundary
  is what lets the identical sim run headless in Node.
- Main thread never blocks, even during a 2000-tick catch-up.

---

## 6. Repository layout

```
packages/
  sim/         pure TS simulation — no DOM, no three.js, no I/O
  worldgen/    sphere mesh, plates, terrain, biomes, rivers (browser + node)
  render/      three.js scene, shaders, sprite atlases, camera
  chronicle/   event → text grammar; optional LLM adapter
apps/
  game/        Vite + React HUD, worker wiring, Capacitor entry
tools/
  soak/        headless balance harness
android/       Capacitor Android project
docs/          this plan, ADRs, art notes
```

`packages/sim` importing anything from `render` or the DOM is a build error. Enforce it
with an ESLint boundary rule from day one.

---

## 7. The balance harness — build it at M2, not at the end

The hard problem in this genre is not rendering. It is that long-horizon economies drift
into degenerate equilibria: everything grows forever, or everything dies by year 300.

`tools/soak` runs **500 seeds × 3000 ticks headless** and asserts:

- No `NaN`, no negative population, no unbounded treasury, in any run.
- 20–60% of civilizations reach Industrial by year 2000.
- At least one collapse event occurs in 40–80% of runs.
- No run reaches zero polities before year 500.
- p99 tick time under budget.
- Distribution histograms for population, tech, polity count, collapse cause.

It runs in CI on every push to `packages/sim`. This is simultaneously the thing that keeps
the game fun and the strongest engineering artifact in the whole project.

---

## 8. Scope

### In (MVP)

Planet of 2562 tiles · plate-driven terrain, biomes, rivers · 3 starting polities · 6 policy
dials · 4 eras · ~20 tech nodes · settlements with per-era sprites · borders · culture and
religion spread and schism · 4 crisis types · collapse with fragmentation / wasteland /
conquest · resettleable ruins · template chronicle with a timeline scrubber · offline
catch-up + "while you were away" digest · one daily notification · save/load · settings ·
low-end 642-tile mode.

### Out (explicitly, for MVP)

Individual citizen agents · unit-level armies · roads · 3D building models · Modern /
Futuristic / Spacefaring eras · zombies · nuclear war · multiple planets · multiplayer ·
LLM features (built behind a flag, shipped later) · monetization · cloud save · iOS.

Adding anything from the right column requires cutting something from the left.

---

## 9. Milestones

| # | Week | Deliverable | Done when |
|---|---|---|---|
| M0 | 1 | Capacitor + three.js shell | A lit sphere spins at 60 fps on a physical device, installed from an AAB |
| M1 | 2 | Worldgen | Goldberg sphere, plates, elevation, biomes, rivers. It looks like a planet |
| M2 | 3–4 | Sim core in worker | Pop, food, settlements, expansion, borders. **Soak harness green** |
| M3 | 5 | Tech, eras, policies, HUD | Player can shift dials and see divergent 500-year outcomes |
| M4 | 6 | Culture, religion, crises, collapse | A civ can fall and successor states appear on the map |
| M5 | 7 | Chronicle, timeline, offline catch-up, notifications | Close the app, return, read what happened |
| M6 | 8 | Visual pass | Atmosphere, clouds, night lights, sprites, ambient life |
| M7 | 9 | Hardening & release | Save/load, low-end mode, perf pass, Play Store internal test track |

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| WebView perf on low-end devices | 642-tile mode, sprite caps, LOD bands. Test on a real budget device at M0, not M7 |
| Tick cost grows past budget as systems land | Tick time asserted in the soak harness from M2; it fails CI |
| Balance drift into degenerate states | The soak harness is the whole answer, which is why it exists at M2 |
| Scope creep | §8's Out list is a contract. Trade, don't add |
| Determinism silently broken | A CI test replays a fixed seed + event log and diffs the final state hash |
| Save migration across versions | Version the save; the seed + event log is canonical, so migration means replay, not surgery |
| LLM cost | Bounded call sites, permanent caching, full template fallback, paid-tier gate |

---

## 11. Immediate next steps

1. Scaffold the monorepo (pnpm workspaces) with the boundary lint rule.
2. M0: Capacitor Android project + three.js sphere on a real device. Prove the pipeline
   before writing any simulation.
3. Stand up `tools/soak` as an empty harness that already runs in CI, so the sim can never
   be written without it.
