# OpenVibeCoaster architecture

## Authoritative pipeline

```text
DesignIntentV1
  -> semantic element and transition solve
  -> SolvedSpan[]
  -> immutable CompiledTrackData
  -> simulation and validation
  -> inline browser worker (generate/regenerate/compile-simulate) with cancellation and transferable canonical arrays
  -> Three.js rendering, DOM editor, telemetry, and ride cameras
```

`@openvibecoaster/core`, `@openvibecoaster/simulator`, and
`@openvibecoaster/generator` are browser-independent, pure TypeScript. They
may not import Three.js, DOM APIs, Web Audio, or mutable application state.

`CompiledTrackData` is the only downstream track representation. Rendering may
tessellate it but must never maintain an independent spline. Camera smoothing
and playback interpolation are visual only and do not change simulation data.

## Workspaces

- `core`: units, vector math, analytic spans, frames, arc length, compiled
  track, environments, diagnostics, and coaster files.
- `simulator`: train dynamics, operation zones, forces, telemetry, energy, and
  the transferable `RideTimeline`.
- `generator`: semantic elements, solving, deterministic search, clearance,
  local regeneration, and worker message contracts.
- `web`: inline browser worker, `ExperienceController`, rendering, UI, plots,
  cameras, audio, and persistence.

## Numerical conventions

- SI units internally; unit brands at public boundaries.
- Right-handed world coordinates: X right/east, Y up, Z forward/north.
- One rotation-minimizing frame (RMF) transported over the whole track via
  `transportFramesAlongPath`/`doubleReflectionFrames`, with authored roll
  applied about the tangent. Frames never reset at element seams.
- General transitions use seventh-order Hermite position spans; authored roll
  uses quintic scalar spans. The degree-seven coefficients are the certified
  representation.
- No sampled-vertex seam smoothing is permitted. Failed hard constraints return
  diagnostics with `actual`, `limit`, `margin`, and `location.s`.
- Simulation uses signed speed and fixed train spacing. Rollback and reversal
  are real states; visual smoothing cannot alter telemetry.

## Generation, compilation, and deterministic bounds

`DesignIntentV1` (seeded `Xoshiro128ss`) is solved via `solveSemanticChain`
into `SolvedSpan` values that carry `positionCoefficients` (3x8) and
`rollCoefficients` (6). `compileTrack` produces immutable `CompiledTrackData`
with arc-length samples and checksums. The search is deterministic: up to 48
candidates are evaluated; hard targets/constraints produce up to three
relaxation reruns with evidence.

Bounds are certified, not sampled. `certifiedPolynomialBounds` computes
Bernstein-hull intervals with outward rounding (`nextUp`/`nextDown`) and a
`CertifiedWorkBudget`. `validateGenerationConstraints` checks footprint and
height range against those bounds; `validateClearance` certifies track
self-separation and terrain separation using inflated segment bounds,
directional locality (`sqrt(3)`), and a bounded pair/node heap. Exhaustion or
non-finite evidence yields `CLEARANCE_UNCERTIFIED` or
`NUMERIC_UNCERTIFIED` diagnostics, not a silent pass.

## Simulation and environment

The simulator is a constrained point-train model with fixed `dt = 1/240 s`
(RK4) and timeline sampling at `1/120 s`. Forces per car are gravity,
rolling resistance, aerodynamic drag, LSM drive (force and power limited), and
brake. Operation zones (`station`, `block`, `launch`, `boost`, `brake`) are
half-open intervals. Energy accounting tracks kinetic, potential, drive work,
loss work, and residual error.

Environments are `HeightfieldEnvironment` heightfields. The environment
provides `signedDistance`, `sampleSolid`, `bounds`, `heightAt`, `normalAt`,
and `raycast` with adaptive-exact predicates and finite checks. Clearance
validation consumes the environment but remains deterministic and budget-bound.

## Worker and transfer

`apps/web/src/engineering/protocol.ts` defines `EngineeringWorkerRequest`
(`generate` | `regenerate` | `compile-simulate` | `cancel`) and
`EngineeringWorkerResponse` (`success` | `failure` | `cancelled`) with strict
validation and timings. `apps/web/src/engineering/worker.ts` runs
generation, regeneration, and compile-simulate off the main thread with
`Transferable` promotion of canonical arrays and explicit `cancel`
termination with epoch-based stale-response rejection;
`EngineeringWorkerClient` (`apps/web/src/engineering/client.ts`) rejects
stale responses and clamps future timestamps within its 5 ms tolerance and
rejects timestamps beyond that tolerance. `collectTransferables`
collects owned `ArrayBuffer` views for zero-copy transfer. `RideTimeline` is
transferable: `toTransferable()` exposes `ArrayBuffer` views and
`fromTransferable` reconstitutes them. `apps/web/src/engineering/hydrate.ts`
hydrates `CompiledTrackData` and `RideTimeline` from transferables and
verifies the canonical file/checksum path; loading via `compile-simulate`
recompiles stored solved coefficients without re-solving. The worker is
created via `createEngineeringWorker` (`?worker&inline`) for a Blob-backed
inline worker suitable for the single-file artifact.

## Rendering and portable artifact

`apps/web` owns the single WebGL2 `THREE.WebGLRenderer`, lifecycle, and
`requestAnimationFrame` loop. Track geometry, train meshes, terrain, and
supports tessellate `CompiledTrackData`; supports are visual-only. Ride
cameras (front, middle, rear, chase, orbit) smooth visually and respect
`prefers-reduced-motion`. Telemetry plots and procedural audio consume the
simulation timeline and do not invent data.

`npm run build` invokes `vite build` and then
`apps/web/scripts/portable-packager.mjs`, which inlines linked stylesheets and
scripts (including the bundled Three.js rendering code) into
`apps/web/dist/OpenVibeCoaster.html`. The inline worker is Vite-inlined and
Blob-backed via `apps/web/src/engineering/factory.ts` (`?worker&inline`),
satisfying `PORTABLE_WORKER_INVARIANT` so the single-file artifact is
preserved. The portable file opens directly in a current built-in browser on
Windows and macOS with no server, CDN, fonts, media, backend, install, or
runtime network fetch; all runtime code is already bundled in the artifact.

## CI and tooling

The baseline is Node.js 24 LTS (Krypton) and npm 11.17.0, enforced with
shell-native `node -p` assertions per OS in `.github/workflows/ci.yml`.

- `quality` on `ubuntu-latest`: `npm ci`, `typecheck`, `lint`,
  `format:check`, `test`, `build`, `bench`, Playwright Chromium `test:e2e`.
- `portable` on `windows-latest` and `macos-latest`: `npm ci`, `build`,
  artifact existence and non-emptiness checks for
  `apps/web/dist/OpenVibeCoaster.html`.

Tooling is `npm workspaces`, `TypeScript`, `Vite`, `Three.js`, `Vitest` with
`fast-check`, `Playwright`, `Oxlint`, and `Prettier`.

## Repository data boundaries

The JSON artifacts under `data/` are inputs and research records, not a second
track model:

- `data/records/records-2026-08-29.json` stores dated, source-scoped facts and
  labels the 80 m inversion comparison as a design target plus derived math.
- `data/profiles/engineering-limits-v1.json` stores editable project
  diagnostic limits under `PROJECT_ENGINEERING_LIMIT`.
- `data/profiles/train-lsm-v1.json` stores the default train model under
  `DESIGN_ASSUMPTION`.
- `data/standards/f2291-26.json` stores public ASTM catalog metadata with
  `UNKNOWN_UNCONFIGURED` criteria state. It is not a substitute for a licensed
  standards profile.

Every external research fact carries its source URL and retrieval date. A
source fact, a derived comparison, a project limit, and a model assumption
must not be presented as interchangeable evidence.

## Experience authority and rendering

`apps/web/src/experienceController.ts` is the single authority for the
accepted result, last-good result, selection, pins, local edits/regeneration,
save/load, and stale-response rejection. It validates `CompiledTrackData` and
`RideTimeline` alignment and the canonical file/checksum path; only a
validated result becomes `ready`.

Generated tracks render via `apps/web/src/render/controller.ts` and
`lifecycle.ts` (single WebGL2 `THREE.WebGLRenderer` and single
`requestAnimationFrame`). Track geometry, train meshes, terrain, and supports
tessellate `CompiledTrackData`; supports are visual-only. Telemetry plots and
procedural audio (`apps/web/src/audio`) consume the simulation timeline and do
not invent data. Ride cameras (front, middle, rear, chase, orbit) smooth
visually and respect `prefers-reduced-motion`; seam/metric inspection and
directed controls are data-gated to the ready state, with diagnostics/
relaxations surfaced. The viewport provides a WebGL fallback message when
WebGL is unavailable. Diagnostics stay hard: they identify exact failures and
label source-verified facts, project limits, assumptions, and unknown
criteria.
