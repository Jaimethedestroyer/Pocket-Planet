# The next pass

Written at the end of the ground-detail polish pass, from watching the thing
run. `STATUS.md` is where the project is; this is what to do next and why, in
the order that buys the most.

The through-line: the world is now *built* but it is not yet *coherent*. Towns
are dense but congested, roads are everywhere and connect nothing, and the
whole planet changes in discrete jumps that no amount of detail hides.

---

## 1. Building placement — congestion

**What it looks like.** Past about tier 3, buildings crowd and interpenetrate.
Walls pass through walls. A dense quarter reads as a heap rather than as a
street of houses.

**Where it comes from.** `plan.ts`:

- Collision is a circle test at `half * 0.78`, where `half` is
  `max(width, depth) / 2`. For anything not square — a warehouse is 13.5 × 21,
  a terrace 13.6 × 8 — the circle is far larger than the building in one axis
  and far smaller in the other. Buildings that are actually clear get rejected;
  buildings that actually overlap get accepted.
- Setback is `street.width/2 + rng(0.7, 2.0) + model.depth/2`, measured from
  the *street centreline*. Two buildings on opposite sides of a narrow lane can
  therefore end up closer than either is wide.
- Nothing considers rotation. A building is placed facing the street and then
  collision-tested as a circle, which throws that information away.

**What to do.** Replace the circle with an oriented-rectangle overlap test —
the models are boxes, their footprints are rectangles, and separating-axis on
two rotated rectangles is about fifteen lines. Then the margin can come *down*
rather than up: real streets are tight, and the reason this looks bad is
overlap, not density. Add a small explicit gap (0.6–1.2 m) between neighbours
so terraces read as separate houses.

Worth doing at the same time: give each building a plot rather than a point.
Walking the frontage and allocating a run of it per building, instead of
sampling points and testing collision, is both cheaper and produces the
terraced look that a street actually has.

---

## 2. Road placement — cohesion

**What it looks like.** Roads are laid out per town with no relationship to the
terrain or to anything outside the town. Streets run up slopes they should
contour around; at the centre several converge into an undifferentiated paved
slab; and no road ever leaves a settlement, so a continent of towns has no
network at all.

**What to do, in order of payoff:**

- **Roads between towns.** The single largest legibility win available. The
  roadmap already wants trade routes as real simulation objects
  (`ROADMAP.md`, Tier 1); a road drawn between two settlements that trade is
  the visible half of that. Even without the simulation change, connecting each
  town to its nearest two or three neighbours of the same polity would
  transform how a region reads from 600 m.
- **Let terrain shape the streets.** The layouts are generated on a flat disc
  and lifted afterwards, so they are blind to slope. Sampling the height field
  while routing — and preferring contours over falls — is what makes a hill
  town look like a hill town.
- **A square, not a slab.** Where streets converge at the centre, make that an
  explicit plaza with a known boundary, rather than the accidental union of
  several overlapping ribbons. The civic building and the great work already go
  there; give them a forecourt.
- **Junctions.** Two crossing ribbons currently double-blend their soft
  shoulders. A junction should be a piece of geometry, not an overlap.

---

## 3. Pop-in — the world changing in jumps

**What it looks like.** At 1× speed, watching a single town, a whole quarter
vanishes and a different one appears. Not a fade — a substitution.

**Where it comes from.** This one has a specific and fixable cause. In
`plan.ts`:

```ts
const rng = makeRng(mixSeed(worldSeed, req.cell * 7919 + req.era * 31 + req.tier));
```

The plan's random seed contains **the tier**. So the moment a settlement grows
from village to town, every street moves, every building is redrawn somewhere
else, and the town you were looking at is replaced by a different town of the
same name. The same happens on an era change.

**What to do.** Seed the plan from the cell alone. Growth should then be
*additive*: the same streets, the same buildings, plus more of both. Concretely:

- Seed with `cell` only, and derive tier-dependent decisions from a stream that
  is stable as tier increases — generate the layout for the *largest* tier the
  town will ever plausibly reach, then reveal the first N buildings by tier.
- Era changes are genuinely a rebuild — a town does move from huts to mudbrick
  — but it should be staged, not instantaneous. Replacing a fraction of the
  buildings per decade would read as a town rebuilding itself, which is what is
  actually happening.
- Buildings already **grow in** with distance rather than fading. The same
  mechanism can serve here: a newly-planned building rises out of the ground
  over a second or two instead of appearing.

Also worth checking: `MAX_TOWNS = 40` in `detail.ts` means the 41st-nearest
town pops in and out as the camera moves. A hysteresis band on that list would
cost nothing.

---

## 4. Time should mean time

**What it looks like.** Pressing 9× makes centuries pass in seconds while the
sun still takes four real minutes to cross the sky and the clouds drift at the
same lazy pace. The world is sped up; the *day* is not.

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

## 5. Wars you can see

The chronicle says two states are at war and nothing on the planet does. This
is the biggest gap between what the simulation knows and what the player sees.

Ordered cheapest first:

- **Contested borders.** The territory field already knows who holds what; a
  border between two states at war could pulse, redden, or thicken. Nearly
  free, and legible from orbit, which is where wars are watched from.
- **Burning settlements.** A settlement that changes hands or loses population
  sharply gets a smoke column for a few decades. Uses the smoke sprite from
  `ASSET-STYLE.md`, and it is visible at exactly the altitude wars are watched
  from.
- **Ruins from war**, distinct from ruins from abandonment — blackened, not
  merely weathered.
- **Projectiles between besieging positions.** What was asked for, and the
  right thing to do *last*: it only reads at close range, where the player
  rarely is during a war, and it needs an arc, a lifetime and a pooled
  instanced layer. Do the three above first and see whether it is still wanted.

---

## 6. Night by era

**What it looks like.** Every settlement glows from window emission, scaled by
an era `lamps` value (primitive 0.30 → industrial 1.0). So a primitive village
reads as a dim modern town rather than as a handful of fires in the dark.

**What to do.**

- Add a **fire layer**: additive billboards at hearths, gates and the town
  centre, using the fire sheet from `ASSET-STYLE.md`. Flickering, warm, few.
- Make primitive and ancient settlements light *only* from fires, with window
  emission scaled to nearly nothing.
- Medieval: fires plus dim windows plus the odd torch.
- Industrial: keep what exists, and the roadmap's "city lights by era" note
  applies — a cold white-blue at the industrial end, so the age of a
  civilization is legible from orbit at night.

**Also a bug:** `plan.ts` gives a lighthouse to any coastal town on
`req.coastal && rng.chance(0.35)` with no era gate. A primitive fishing village
should not have one. Gate it to Ancient and later — and a *primitive* coastal
settlement wanting a navigation light should get a beacon fire, which is both
correct and better looking.

---

## Smaller things, if there is time

- **Masonry detail dies at ~460 m**, so a town at mid zoom is flat colour.
  Correct for the cost; a coarser mid-range variation term would help.
- **Vegetation is one disc following the camera.** The planet-wide version
  wants a scatter hung off the terrain LOD patches — free of extra terrain
  sampling, since patch vertices already carry height, moisture and
  temperature, but it has to stay stable as patches split and merge.
- **Shadows are a sheared footprint quad** and show it on a low sun.
- **Building heights do not vary within an archetype.** Per-instance storey
  count for houses would break up a skyline cheaply.
- **`plan.ts` is about 700 lines** and now does streets, buildings, fields,
  people and ruins. It is coherent but it is at the size where the next feature
  should probably split it.

---

## How to work on this

Every item above is judged by looking, not by reading. The loop is:

```bash
npm run build
CLOUDS=0 TAG=try1 npm run shot -- city city-close city-street
```

then look at `docs/shots/`, change one thing, shoot again with a new `TAG`, and
compare. Read `STATUS.md` § *Screenshots are the main development tool* first —
particularly the note about the camera framing its target, which has cost more
debugging time than any actual bug in this project.

And run `npm run soak` and `npm run verify-save` before committing anything
that touches `src/sim/`.
