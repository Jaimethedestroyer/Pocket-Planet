# Where Pocket Planet goes next

Ordered by what it buys, not by what is interesting to build. The planet and the
simulation both work; almost everything below is about closing the gap between *a
world that runs* and *a game someone wants to keep on their phone*.

Each item carries a rough size — **S** is a sitting, **M** is a day or two, **L** is a
week — and what it actually gets you.

---

## The one big gap

**You cannot touch your world.** Every interaction today goes through six sliders. You
cannot tap a city, follow a war, or look at the empire that just collapsed. That is the
difference between a simulation you watch and a place you visit, and it is worth more
than any amount of extra shader work.

---

## Tier 1 — do these next

### 1. Timeline scrubber: replay the whole history · **M**

Drag through three thousand years and watch borders bloom, fracture and reform. Sun
sweeping, cities lighting up, empires eating each other, in twenty seconds.

This is the trailer shot, the contest submission's first fifteen seconds, and the thing
nobody else's entry has — and it is *nearly free*, because the simulation is already
deterministic and already replayable. It is the payoff for a property that has so far
only been a correctness guarantee.

Mechanism: the worker keeps a ring of keyframes — the owner array (8 KB), the settlement
list, and the tick — every 25 years. Two and a half megabytes covers three thousand
years. Scrubbing repaints the territory field from a keyframe instead of re-simulating,
so it is instant and smooth in both directions. Only the *display* rewinds; the
simulation itself never moves backwards.

### 2. Tap to inspect · **M**

Tap a city: its name, founding year, population, who rules it, what it has lived
through. Tap open ground: the terrain, the climate, who claims it. Tap a chronicle line:
the camera flies to where it happened.

Ray-cast the tap against the sea sphere for a world direction, then find the nearest
simulation cell — cheap, and exactly what the invisible cell graph is already for. The
fly-to camera is the same rig with an eased target.

This turns the chronicle from a ticker into a set of doorways.

### 3. Clouds · **M**

There is a cloud layer in the quality settings and nothing behind it. From orbit — the
game's main viewing angle — this is the largest remaining visual gap, and weather
systems drifting over a planet is a strong idle-game texture.

An animated noise shell above the surface, lit by the same sun and shadowing the ground
below it. Later it can be driven by the simulation's own moisture field, so a drought
looks like one.

### 4. Trade routes and roads · **M**

At mid zoom there is nothing between "coloured territory blob" and "dot of a city". Arcs
between trading settlements — thin, glowing at night, thickening with volume, dimming
when a war closes them — fill that gap and make the Trade dial visible for the first
time.

Needs trade routes to become real objects in the simulation rather than an aggregate
number, which is worth doing anyway.

### 5. Named rulers and dynasties · **S**

"Under Queen Vashti the Elder, the granaries were filled." Best chronicle quality per
hour of work in the whole project. Names already generate per culture; a ruler needs a
name, a reign, and one trait that nudges a policy.

---

## Tier 2 — real gains, less urgent

### Rivers · **M**
Planned in the original design and never built. Flow accumulation over the cell graph,
rendered as a line network. Improves terrain believability *and* gives settlements a
reason to be where they are — river mouths and confluences instead of "wherever
habitability was highest".

### Sea ice at the poles · **S**
Right now the ocean runs to the pole unfrozen while the land beside it is under snow. A
temperature-driven white overlay on the water fixes an obvious wrongness cheaply.

### City lights by era · **S**
They already read well. Firelight orange for primitive, lamp yellow for medieval, a cold
white-blue for industrial — so the *age* of a civilization is legible from orbit at a
glance, at nearly zero cost.

### Wonders and ruins as landmarks · **M**
Great works that persist through collapse and show as distinct markers. Excellent
chronicle material, gives ruins a reason to be found, and makes a planet's history
visible in its geography.

### Ground detail: buildings and billboard citizens · **L**
The milestone deliberately left alone. Instanced buildings and animated sprite citizens
at the closest LOD band. High effort, and it only pays off at maximum zoom — but it is
the thing that makes the last part of the descent worth doing, and it is where the
sprite-sheet plan fits.

### Terrain detail textures · **M**
Procedural grain gets the ground surprisingly far, but triplanar grass, rock and sand at
close range would sharpen everything below about two hundred metres.

---

## Tier 3 — shipping

### Real-device performance pass · **M** · *do this before Tier 1 finishes*
Every number in this repo was measured under software rasterisation. Nothing is known
about how it behaves on an actual mid-range Android phone: thermal throttling, fill rate
on the atmosphere raymarch, worker scheduling, memory. This is the single largest
unknown in the project, and it gets more expensive to discover the longer it waits.

### Capacitor wrap and Play internal test · **M**
The build is already a static site. Wrapping it is mostly configuration, an icon set,
and a signing key. Worth doing early for the same reason as above: to find out what
breaks.

### Local notifications · **S**
"143 years have passed. The Northern Empire has collapsed." This is what makes a
put-it-down game a come-back-to game, and it needs the Capacitor wrap.

### RevenueCat · **S**
Required for Shipaton. The honest monetization here is cosmetic — planet themes, more
simultaneous worlds, a longer offline cap — not anything that gates the simulation.

### Onboarding · **S**
Sixty seconds explaining that you set priorities rather than give orders, that collapse
is not failure, and that the world keeps running when you leave.

---

## Deliberately not doing

- **More eras** (Modern, Atomic, Spacefaring). Tempting, cheap-looking, and wrong: the
  four existing eras are not yet distinct enough to justify a fifth.
- **Units and armies you can move.** It would make this a different, worse, much larger
  game.
- **An LLM.** Still out. See `PLAN.md`.
- **Multiplayer.** Not at any price.

---

## Suggested order

1. Real-device performance pass — before building anything else on top of unknowns
2. Timeline scrubber — the demo, and nearly free
3. Tap to inspect — closes the interaction gap
4. Clouds — the biggest remaining visual gap from the main viewing angle
5. Named rulers — cheapest chronicle improvement available
6. Capacitor wrap, notifications, onboarding — make it a thing people can actually keep
7. Trade routes, rivers, wonders — depth, in whatever order stays interesting
