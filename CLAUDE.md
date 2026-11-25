# CLAUDE.md — HBFCity

## Project

HBFCity is an explorable 3D city of a GPU package with High Bandwidth Flash
(HBF) stacks, aimed at LLM serving. It is derived from PGSimCity
(github.com/NikolayS/PGSimCity) and keeps its engineering rules in reduced
form. Step 1 built the structure; step 2 added the serving simulator.

This repository is public. Implement only published mechanisms (OCP spec,
HBFlex, FlashAccel, ...). Unpublished research policies stay out of it.

## Architecture

```text
src/core/     types (SceneState, ComponentDef), bus, registry, theme, hbf-spec
src/sim/      models, workload, store (KV placement, policies), sim (serving loop)
src/world/    layout.ts (single source of geography), package, gpu, hbf-stack,
              die-material (floor-plan shader), occupancy (block atlas),
              sim-view (store -> atlas), activity, flow-material, sky
src/engine/   renderer, camera, labels, picker
src/ui/       hud, panel (inspector), content (sourced notes), dom
```

- `src/core/hbf-spec.ts` is the only place a device number is defined, and it
  says where each one came from. Never hard-code a device number elsewhere.
- `src/world/layout.ts` owns geography. Districts read positions from it.
- World modules read `SceneState`; only the UI and `main.ts` write it.
- `src/sim` must not import three.js. The world reads the simulator; it never
  mutates it.
- Every simulator number shown to the reader is simulated, and the UI says so.
  Keep `store.check()` and the serving tests green: they guard the page and
  erase accounting that the wear view depends on.

## Rules carried over from PGSimCity

- **The model must be honest.** Geometry, colour and prose are claims. A
  number shown to the reader needs a source in `SOURCES` or is labelled
  `derived` or `estimate`. A simplification that could change the lesson goes
  in the component's `caveats` and is never hidden by CSS.
- **Colour is semantic.** At night only meaning glows (block state, SRAM,
  links, compute); structure stays matte. Do not reuse a meaning's colour for
  decoration.
- **Frame loops allocate nothing.** Reuse vectors, boxes and matrices.
- **Code must be wired.** An unimported module is not delivered.
- **Verify the deliverable.** Run `npm test`, `npm run typecheck` and
  `npm run build`, and look at the result in a browser before handing off.
  `?settle=1` jumps animations so a screenshot shows the final state.

## Stack

TypeScript (strict), three.js r185 (only runtime dependency), Vite, Vitest.
`npm install --legacy-peer-deps` works around an npm 10 peer-resolution crash.
