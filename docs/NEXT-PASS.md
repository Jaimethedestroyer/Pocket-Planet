# The next pass

Written at the end of the town-planning pass, from watching the thing run.
`STATUS.md` is where the project is; this is what to do next and why, in the
order that buys the most.

The through-line has moved. The world is now built *and* coherent — towns are
laid out rather than heaped, they grow instead of being replaced, and roads run
between them. What it is not yet is **alive**: everything the simulation knows
about happening happens invisibly, and the presentation runs on its own clock
regardless of what the player has asked history to do.

---

## What the sprite pass did, so it is not done twice

The ten pre-rendered sheets in `src/assets/sprites/` are all in the game, and
the two procedural atlases they replaced are gone. `render/ground/sheets.ts` is
the only place a sheet is loaded; `docs/ASSET-STYLE.md` now states the contract
the shaders actually implement, which is not the one it originally asked for —
these are finished colour, not masks, and two of its non-negotiables were
reversed to take them.

- **§3 *Night by era* is done.** `ground/fires.ts` draws campfires, torches,
  braziers and chimney plumes off one instance buffer; `style.ts` decides how
  many of each an era keeps, and window emission at the primitive and ancient
  end is down to almost nothing. One material serves both the additive flames
  and the lit smoke, via premultiplied blending. **Not** done: the beacon fire
  on a primitive coastal headland. It wants a search around the town rim for
  ground that faces the sea, and it is the one thing in that section that could
  not be hung off a building.
- **§2 *Wars you can see* is half done.** Burning settlements, and projectiles,
  which were the second and last items on the list. `detail.ts` infers the front
  as the closest pair of settlements across a war, so exactly the two towns the
  war is over burn rather than every settlement of a belligerent. **Not** done,
  and still worth doing in this order: contested borders pulsing in the
  territory field, war ruins distinct from abandonment ruins, and roads that
  close between belligerents.
- **Banners** are new and were not on any list: a pennant on a mast over the
  civic building and the great work, tinted at upload rather than in the plan,
  so conquest repaints them without replanning the town.
- **People are dressed by era** — four walk cycles stacked into one atlas, era
  picking the row. It is the clearest reading of a civilization's age there is
  at street level, and it costs one attribute.

---

## What the pass before that did, so it is not done twice

- Building overlap is a separating-axis test on rotated rectangles
  (`ground/plot.ts`), not a circle. Plots are allocated as *runs of frontage*
  along each street rather than sampled and rejected, which is where the
  terraces came from.
- A town's layout is drawn once at its ultimate size (`ground/layout.ts`) and
  the tier only reveals a fraction of it, so growth is additive. `npm run
  probe-town` asserts that and fails the build of anyone who breaks it.
- Streets slide onto their contour where the ground falls across them, and are
  left to climb where it falls along them.
- The town centre is an explicit square with a boundary, and the ground under it
  is reserved from the start whether or not anything is standing on it yet.
- `ground/network.ts` routes roads between settlements, cached per pair of cells
  and budgeted per frame like town planning.
- Roads carry their own LOD range, nested inside the road layer's: a route
  between towns appears first on a descent, a back lane last.
- The lighthouse is gated to Ancient and later.

---

## 1. Time should mean time

**What it looks like.** Pressing 9× makes centuries pass in seconds while the
sun still takes four real minutes to cross the sky and the clouds drift at the
same lazy pace. The world is sped up; the *day* is not. This is now the largest
gap between what the player asked for and what they are shown.

**Where it comes from.** `Environment.dayLength` is a fixed 240 real seconds
and `angle += dt / dayLength`. Cloud drift runs on `uTime`, which is real
seconds. Neither has ever known what the simulation speed is.

**What to do.** Give the environment a **time scale** driven by the speed
control, and apply it to:

- the sun's angle — the obvious one, and the one that makes speeding up feel
  like speeding up
- cloud drift and cloud evolution
- the shoreline surge and wave animation
- people's walk speed

Two cautions. First, do not make this linear: at 45 years a second a literal
day/night cycle would strobe. Something like `dayLength / sqrt(speedRatio)` —
fast enough to read as accelerated, slow enough not to flicker — and clamp the
floor at a few seconds per day. Second, the *simulation* clock must stay
exactly where it is; this is presentation only, and coupling them would break
determinism.

A related nicety: at high speed, borders and settlements changing every frame
is the interesting part. Consider fading the ground detail out above some speed
and leaning on the territory field, which is what the player is actually
reading at 9×.

---

## 2. Wars you can see

*Partly done — see the top of this file. What follows is what is left.*

The chronicle says two states are at war and the planet now says so at the front
line. What it does not yet say is anything at all from orbit, which is where
wars are actually watched from.

Ordered cheapest first:

- **Contested borders.** The territory field already knows who holds what; a
  border between two states at war could pulse, redden, or thicken. Nearly
  free, and legible from orbit, which is where wars are watched from.
- ~~**Burning settlements.**~~ Done, in `ground/war.ts`. Driven by the front
  line rather than by a population drop, which is a cheaper signal and a better
  one: it is the town being fought over that burns. Worth revisiting if the
  simulation ever reports a sack directly.
- **Ruins from war**, distinct from ruins from abandonment — blackened, not
  merely weathered.
- **Roads that close.** The chronicle already says "the roads are closed" when
  plague spreads. `network.ts` knows which pairs of towns are joined and by
  which polities; a route between two states at war could simply not be drawn.
  Nearly free, and it makes the network mean something.
- ~~**Projectiles between besieging positions.**~~ Done, in `ground/war.ts`,
  and it turned out cheaper than feared: an instance is a *shot* that repeats,
  so the arc, the stretch along the velocity, the dust at the far end and the
  wait before the next one are all a function of time and a phase. The arrow
  pass and the impact pass share one instance buffer read at two different
  points in the cycle. The caution stands, though — it only reads in the last
  hundred metres, and the three items above it are still what a war looks like
  from where a war is watched.

---

## 3. Night by era

*Done, apart from the last item — see the top of this file.*

What is left of it:

- A **primitive coastal settlement** should get a beacon fire on the headland,
  which is the thing the lighthouse gate took away from it. Everything else in
  this section hangs off a building the planner already placed; this one does
  not, and wants a search around the town rim for ground that faces the sea.
- The roadmap's **"city lights by era"** note still applies at the orbital end:
  a cold white-blue at the industrial end, so the age of a civilization is
  legible from orbit at night. The fire layer only reaches to 780 m.

---

## 4. An era change is still a redraw

Growth within an era is now additive: a village becoming a town keeps every
building it had. Crossing an era boundary is still instantaneous — every
building in the settlement is replaced in one frame, because the era decides
what the models *are*.

That one is genuinely a rebuild, but it should be staged rather than sudden. A
town does move from huts to mudbrick, and it takes it a century.

**What to do.** The plot list is already stable across eras — `layout.ts` is
seeded from the cell, and only the *style* it is handed changes. So each plot
can carry a stable draw deciding *when* in the era transition it is rebuilt, and
the planner can then hold a mixed town: some houses in the old material, some in
the new. Replacing a fraction of the buildings per decade would read as a town
rebuilding itself, which is what is actually happening.

Worth doing at the same time: buildings already **grow in** with distance
rather than fading. The same mechanism can serve here — a newly-built building
rises out of the ground over a second or two instead of appearing.

---

## 5. Junctions

Two crossing ribbons still double-blend their soft shoulders, and the result is
a bright cross wherever two streets meet. The square at the town centre is now
a piece of geometry with a boundary; a crossroads should be too.

The cheap version: where two street polylines cross within a town, emit a small
paved patch — the same fan `roads.ts` already builds for a square — and let the
ribbons run into it. `layout.ts` has every street in flat metres, so finding the
crossings is a segment-intersection sweep over a few dozen polylines and costs
nothing.

---

## Smaller things, if there is time

- **`MAX_TOWNS = 40`** in `detail.ts` means the 41st-nearest town pops in and
  out as the camera moves. A hysteresis band on that list would cost nothing.
- **Masonry detail dies at ~460 m**, so a town at mid zoom is flat colour.
  Correct for the cost; a coarser mid-range variation term would help.
- **Vegetation is one disc following the camera.** The planet-wide version
  wants a scatter hung off the terrain LOD patches — free of extra terrain
  sampling, since patch vertices already carry height, moisture and
  temperature, but it has to stay stable as patches split and merge.
- **Shadows are a sheared footprint quad** and show it on a low sun.
- **Building heights do not vary within an archetype** beyond a per-instance
  vertical stretch. A real per-instance storey count for houses would break up
  a skyline cheaply.
- **Ruins are still scattered, not planned.** A ruined settlement draws rubble
  at random points inside its radius rather than on the streets of the town
  that was there. `layout.ts` would give it those streets for free, and a ruin
  that still has a street plan is a far stronger image than a heap.

---

## How to work on this

Every item above is judged by looking, not by reading. The loop is:

```bash
npm run build
CLOUDS=0 TAG=try1 npm run shot -- city city-close city-street region
```

then look at `docs/shots/`, change one thing, shoot again with a new `TAG`, and
compare. Read `STATUS.md` § *Screenshots are the main development tool* first —
particularly the note about the camera framing its target, which has cost more
debugging time than any actual bug in this project.

There is one thing screenshots cannot judge, and it now has its own harness:

```bash
npm run probe-town
```

A town that grows must not redraw itself. Run this after anything that touches
`render/ground/`, and read the invariant in `STATUS.md` before assuming a
failure is a small one — every way this has broken so far looked like something
else.

And run `npm run soak` and `npm run verify-save` before committing anything
that touches `src/sim/`.
