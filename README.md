# Pocket Planet

A persistent 3D civilization simulation for Android. Rotate a living planet, nudge a
civilization's priorities, and come back later to read the history it wrote while you
were gone.

> *143 years have passed. The Northern Empire collapsed after a prolonged famine.
> Three successor kingdoms have formed.*

## What it is

Somewhere between a god game, a virtual pet, and an idle simulation. You don't command
units — you set broad priorities (trade, war, education, expansion, conservation,
culture) and watch a civilization rise, spread, stagnate, fracture, and sometimes fall.
Collapse isn't game over: empires split into successor states, cultures and religions
outlive the polities that founded them, and ruins get resettled centuries later. The same
planet can run indefinitely.

## Stack

Capacitor (Android) · three.js / WebGL2 · TypeScript · Web Worker simulation · Vite

The simulation is a pure, deterministic, dependency-free TypeScript package that runs
identically in the browser worker and in Node. Seed + player-event log fully reproduces
any history.

## Status

**Planning.** No code yet.

See [`docs/PLAN.md`](docs/PLAN.md) for the full technical plan — architecture, the tick
pipeline, rendering approach, scope boundaries, milestones, and risks.
