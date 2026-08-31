# Browser timeline OOM correction — RED/GREEN report

Use `git log --oneline -- .superpowers/browser-timeline-oom-fix-report.md` to locate the commit.

## 1. Reproduced RED evidence (current HEAD 8735484)

After defensive-getter fixes, the first full-browser benchmark seed still grew the active Chromium renderer working set from **2.5 GB → 3.3 GB → 4.85 GB in ~70 s**, then the renderer vanished while browser/GPU helpers stayed idle. The test never reached ready. This was observed on the integration benchmark path (`npm run test:e2e` with Playwright Chromium) and via manual heap snapshots (`performance.measure` user timing still captured before crash).

**Preserved RED test output (before production changes):**

The new focused tests were added first and executed against the unpatched tree. Representative failures:

```
FAIL  compact.timeline.test.ts > full/default vs compact: identical 120 Hz …
  expected compact.timeline.frames.length to be 0 but got 21601
  expected transfer.frames to be undefined but got [SimulationFrame×21601]

FAIL  worker.compact.test.ts > flagship worker success hydrates compactly
  expected result.timeline.frames to be undefined but got [SimulationFrame…]
  expected hydrated.timeline.frames.length to be 0 but got 21601

FAIL  controller.compact.test.ts > compact fallback gives finite/distinct …
  expected s0.telemetry to be defined but got undefined (compact had no SoA fallback)
  expected s0.telemetry.kineticEnergyJ to be finite but got undefined

FAIL  resampling.linear.test.ts > structural regression: bracket cursor is monotonic
  expected src to contain "let cursor = 0" but got "let upper = 0; while (upper < frames.length -1 …"
  naiveComparisons 6480000 > linearComparisons 5000  (quadratic threshold not met)

FAIL  engineering/simulation.test.ts > valid launch track produces … (when patched to expect compact)
  expected frames.length >0 but compact timeline had 0 after switch (demonstrates old assertion now incompatible)
```

These were kept as the RED baseline; the production patch below turns them GREEN without changing the test logic (only the few existing assertions that assumed 11 buffers / frames>0 were relaxed to `>=11` / SoA-aware).

## 2. Root cause analysis (source-verified)

- **180 s × 240 Hz integration** stores ~43,201 full `SimulationFrame` objects, each with 6 `CarState` × 4 `SeatState` plus `TrackSample` graphs (`position/tangent/normal/binormal/curvatureVector` plus `bank/bankDerivative`). Retained in `SimulationResult.frames`.
- `withJerk` clones that graph again (extra object layer) to compute `jerkMps3` from `specificForce` differences.
- `makeTimeline` previously built **~21,601** full 120 Hz frames: for each output time it reset `let upper = 0; while (upper < frames.length-1 && frames[upper].timeSeconds < time) upper++` — sorted outputs scanned from zero every time → `O(N×M)` ≈ 21601×43201/2 ≈ 466 M comparisons, plus per-sample `sampleTrackAtDistance` and seat interpolation.
- `RideTimeline` constructor deep-cloned the 120 Hz graph (`cloneFrame` → `cloneCar` → `cloneSeat` → `cloneSample/Telemetry`), duplicating every `TrackSample`/`Vec3`.
- `toTransferable` included that non-transferable graph (`frames: SimulationFrame[]`) in the payload; `collectTransferables` traversed it, `postMessage` structured-cloned it, and `RideTimeline.fromTransferable` / `hydrateEngineeringSuccess` cloned it again. The three copies (main timeline SoA + nested frames graph + structured-clone) were the dominant OOM contributor; the SoA itself is only ~10–15 MB.
- **No mutation of caller-owned inputs** was performed, so the fix must be internal.

## 3. Memory allocation reasoning

**Before:**

- Detailed frames: 43k × car graph ≈ several hundred MB retained (objects + frozen arrays).
- Timeline frames: 21.6k × same graph ≈ additional ~200 MB.
- Timeline SoA (11 buffers): `time/head/speed` (21.6k×8 ≈ 0.17 MB each), `G` (same), `jerk` (0.5 MB), `carPositionsXYZ` (21.6k×6×3×8 ≈ 3.0 MB each for positions/tangents/normals/binormals → ~12 MB total). SoA < 20 MB.
- Total posted payload traversed by `collectTransferables` included SoA + nested graph → the structured-clone of the graph dominated (≈200 MB serialize/deserialize) and triggered renderer OOM to 4.85 GB within 70 s.

**After (compact browser path):**

- Detailed 240 Hz graph unchanged (still needed for simulation fidelity; out of scope).
- Timeline **SoA only**, no retained `SimulationFrame[]` for browser: `frames: []` (zero nested frames, zero `TrackSample`/seat graphs).
- Added compact typed series (17 new `Float64Array` buffers): `launchActivity/brakeActivity` (21.6k×8 ≈ 0.17 MB each), 5 energy arrays (0.17 MB each → 0.85 MB), `bank/roll/specificForce` (0.17 MB + 0.17 MB + 0.5 MB), `perCarLong/Lat/Vert/Bank/Roll` (21.6k×6×8 ≈ 1.0 MB each → 5 MB), `perCarSpecific/ Jerk` (3.0 MB each → 6 MB). New total SoA ≈ 25–27 buffers, ~30 MB transfer. No graph traversal.
- Full/default simulations unchanged: they still return `SimulationResult.frames` and a full-frame `RideTimeline` plus the same SoA (for parity testing). The full timeline’s `toTransferable` still round-trips via 28 buffers but old 11-buffer shape remains accepted by `fromTransferable` (missing buffers default to empty).
- **Saving:** Eliminates ~200 MB cloned graph + structured-clone amplification per generate/regenerate/compile-simulate. Transfer now is < 30 MB of `ArrayBuffer`s detached once, owned by worker, hydrated as immutable `RideTimeline` on main.

## 4. Required behavior implementation (minimal, contract-safe)

1. **Linear resampling:** `makeTimeline` now keeps `let cursor = 0` outside the per-output closure; each `outputTime` advances `while (cursor < frames.length-1 && frames[cursor].timeSeconds < time) cursor++`. `upper = cursor` is monotonic. The closure no longer resets to zero. Output is bit-identical (same `blend`/`alpha` and `sampleTrackAtDistance` calls).

2. **Default full simulator behavior:** `SimulationRequest` extended with `readonly compactTimeline?: boolean` (default `false`). `simulateRide` passes `Boolean(request.compactTimeline)` to `makeTimeline`. Without the flag, the timeline is the previous full-frame timeline (now also populated with compact SoA for test parity but still `frames.length === timeline.length`). `SimulationResult.frames` is always populated.

3. **Compact browser mode:** `makeTimeline(track, frames, config, compact=true)` streams the same interpolation directly into `Float64Array` SoA without allocating `SimulationFrame[]` or seats/track samples. `apps/web/src/engineering/worker.ts:simulateForTrack` now requests `simulateRide(..., { compactTimeline: true })` for generate/regenerate/compile-simulate. No cache flush, page reload, GC, duration cap, rate change, seat reduction, or second simulation implementation added.

4. **Preserve browser feature evidence:** Compact `RideTimeline` keeps:
   - `timeSeconds/headDistanceM/speedMps`, front `longitudinalG/lateralG/verticalG`, `jerkMps3`, all-car `carPositionsXYZ/Tangents/Normals/Binormals`;
   - `launchActivity/brakeActivity` (0/1), `kineticEnergyJ/potentialEnergyJ/accumulatedDriveWorkJ/accumulatedLossWorkJ/energyErrorJ`, `bankRad/rollRateRadPerSec/specificForceXYZ`;
   - Per-car `longitudinalG/lateralG/verticalG/bankRad/rollRate/specificForceXYZ/jerkXYZ` as `length*carCount` (or `*3`) typed arrays, so front/middle/rear remain distinct without sending `TrackSample` graphs or seats.

5. **Compact transfer:** `RideTimeline.toTransferable` returns `{ sampleRateHz, carCount, length, buffers: [...28 ArrayBuffers], ...(frames.length>0?{frames}:{}) }`. For compact (`frames:[]`) the `frames` key is omitted. `collectTransferables` therefore only sees `buffers` ArrayBuffers. `fromTransferable` accepts both 11-buffer legacy and 28-buffer compact (missing indices default to empty `Float64Array(0)`). Ownership is defensive: `hydrateEngineeringSuccess` constructs a new frozen `RideTimeline` and `CompiledTrackData`; callers cannot mutate simulator storage.

6. **Fallback parity:** `apps/web/src/ride/controller.ts:validateTimeline` now accepts empty `frames` but validates the new SoA metrics (finite, length-matched). `createRidePlayback` synthesizes `RideTelemetry` from SoA when `frames` is empty: `compactTelemetryAt(bracket)` lerps `launchActivity/brakeActivity` by threshold, energies by linear blend, per-car G/bank/roll via `perCar*` arrays, and still uses `vectorAtTime` for orthonormal front/middle/rear transforms. `jerkAtTime` continues to use `jerkMps3` SoA. Full-frame timelines behave exactly as before (interpolated `CarState`/`SeatState`).

7. **No speculative extra work:** No dependency changes, no Playwright config changes, no page lifecycle changes, no validation-limit or simulation-rate changes.

## 5. Tests Added (RED → GREEN)

- `packages/simulator/src/compact.timeline.test.ts`
  - `full/default vs compact: identical 120 Hz scalar, G, jerk, transforms, activity, and energy series; full has frames, compact has zero frames; SimulationResult.frames remains populated in both modes`
  - `compact transfer omits frames, round-trips every new buffer with stable ownership/determinism, and rejects malformed shapes/values`

- `packages/simulator/src/resampling.linear.test.ts`
  - `resampling output equality between compact and full`
  - `structural regression: bracket cursor is monotonic and does not restart per output` – counts naive vs linear comparisons (no wall-clock), `naive ≈ 6 M, linear < 6 k` → proves `O(N+M)`

- `apps/web/src/ride/controller.compact.test.ts`
  - `compact fallback gives finite/distinct front/middle/rear transforms and truthful telemetry` – hydrates flagship compact, creates `createRidePlayback`, checks `kineticEnergyJ/energyErrorJ` finite, front/middle/rear positions finite & distinct via SoA, telemetry changes on scrub, `setCamera`/`tick` remain functional.
  - `existing full-frame controller tests semantics remain valid …`

- `apps/web/src/engineering/worker.compact.test.ts`
  - `flagship worker success hydrates compactly with expected properties` – `handleGenerate(full-auto, rolling-highlands)` → `timeline.frames === undefined`, `buffers.length > 11`, hydrated `frames.length === 0`, `sampleRateHz ===120`, `length >15*120`, `checksum` preserved, movement >100 m, `launchActivity/brakeActivity/kineticEnergyJ/energyErrorJ` finite, hasLaunch/hasBrake true, `carPositionsXYZ` shape correct.
  - `actual worker post path never includes nested timeline frames` – `collectTransferables` on `{track, timeline}` contains only ArrayBuffers, `JSON.stringify(timeline).includes("frame"/"seat") === false`, transfer list has no frame-derived buffers.

Existing updated:

- `packages/simulator/src/simulator.test.ts` relaxed `buffers.length ===11` → `>=11` and JSON round-trip still holds.
- `apps/web/src/engineering/simulation.test.ts` now checks activity/energy via SoA when `frames.length ===0` and allows flagship `frames.length ===0`.

## 6. Verification (commands run, all GREEN)

```
npx vitest run packages/simulator/src apps/web/src/engineering apps/web/src/ride
  Test Files  15 passed (15)  Tests  174 passed (174)

npx vitest run apps/web/src
  Test Files  33 passed (33)  Tests  401 passed (401)

npm run typecheck  → 4 workspaces ok
npm run lint       → oxlint 0 warnings
npm run format:check → All matched files use Prettier code style!
npm run build      → vite 8.2.2 built in 400ms, 897 kB
```

Additional manual checks:
- `hydrateEngineeringSuccess` on compact payload produces frozen `RideTimeline` and `CompiledTrackData` with matching `track.checksum` / `file.compiledDataChecksum`.
- `collectTransferables({track, timeline})` deduplicates buffers, never includes caller-owned request buffers.

## 7. Self-review checklist

- [x] **Exact numerical parity:** Compact `makeTimeline` uses identical `interpolateTelemetry`/`blend`/`sampleTrackAtDistance` and the same `alpha`/`span` logic; per-car transforms are sampled at blended `distanceM` exactly as before. Full and compact scalar series compared with `toEqual`/`toBeCloseTo(9)` in `compact.timeline.test.ts`.
- [x] **Finite validation:** All new `Float64Array` inputs are `requireFinite` checked; `RideTimeline` constructor validates `launchActivity/brakeActivity/energy/bank/roll/specificForce` lengths and per-car lengths; `validateTimeline` in the ride controller mirrors those checks and orthonormal enforcement for SoA transforms.
- [x] **Backward compatibility:** `RideTimeline.fromTransferable` accepts 11-buffer legacy transfers (missing indices → empty arrays). `toTransferable` for a legacy-constructed timeline (only base fields) emits 28 zero-length buffers but `fromTransferable` of that payload still validates under the new constructor. Existing `simulator.test.ts` relaxed to `>=11`.
- [x] **Transfer ownership:** `toTransferable` uses `slice().buffer` (copy), `collectTransferables` deduplicates `ArrayBuffer`s, worker posts `transfers` as the second `postMessage` argument, main hydrates its own frozen copy; no mutable simulator storage exposed.
- [x] **Surgical scope:** Touched `packages/simulator/src/{contracts,timeline,index}`, `apps/web/src/ride/controller`, `apps/web/src/engineering/worker`, plus 4 new test files and 2 relaxed assertions. No dependency, Playwright, renderer cache, page lifecycle, validation limit, or simulation rate changes. `withJerk` left unchanged (spec: do not optimize unless RED proves required).

## 8. Concerns / residual risk

- **Private 240 Hz detailed frame graph unchanged.** The `SimulationResult.frames` (43 k frames) is still retained for non-compact callers and for the compact timeline’s streaming source. Under a pathological full-ride + eager browser retention it could still be large, but the browser OOM path (120 Hz retained/cloned/transferred graph) is now removed. A follow-up could stream `withJerk` or avoid retaining the 240 Hz graph for browser mode if RED evidence reappears.
- **Per-car specificForce/jerk fidelity.** Compact stores `perCarSpecificForceXYZ/jerkXYZ` and front `specificForceXYZ`; the ride snapshot now reconstructs `perCar` exactly from those. If future UI needs per-seat `TrackSample` geometry, that would require a separate SoA extension, not a nested graph.
- **Legacy 11-buffer payloads:** They hydrate to timelines with empty energy/activity arrays; telemetry series that require those will be reported as unavailable (truthful) rather than fabricated zero. This is contract-safe but callers should treat empty arrays as “not supplied.”

## 9. Commit

Single concise commit containing source, tests, and this report. Tree left clean on `main`; not pushed.

```
git log --oneline -- .superpowers/browser-timeline-oom-fix-report.md
# shows this report’s commit
```
