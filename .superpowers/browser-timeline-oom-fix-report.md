# Browser timeline OOM review fix — truthful RED/GREEN report

Review correction applied on `main` at `575484b` per `.superpowers/browser-timeline-oom-review-fix.md`. Work as sole writer, no push, no full browser benchmark in this task.
Final boundary hardening applied on `main` at `8d22d3f` per `.superpowers/timeline-boundary-final-fix.md` — sole writer, no push, no browser E2E.

## 1. Corrections applied (575484b)

1. **Production-exercising linearity regression** — Extracted `createMonotonicBracketLocator` in `packages/simulator/src/index.ts` used by both compact and full `makeTimeline` paths, eliminating duplicated cursor loops. Replaced false-proof test in `packages/simulator/src/resampling.linear.test.ts` with instrumentation via `timeSeconds` getters/proxies on the exact production helper, asserting total reads `O(frames+outputs)` (`reads < frames+outputs*2`, `reads < 12000`) and retaining full vs compact output equality.

2. **Authoritative compact analysis series** — `apps/web/src/telemetry.ts`: `rollRate` now prefers finite exact-length snapshot of `timeline.rollRateRadPerSec` before full-frame and geometric fallbacks; `energyResidual` prefers finite exact-length snapshot of `timeline.energyErrorJ` before full-frame fallback. Each defensive getter snapshotted at most once per series request. Added frame-empty compact regression tests proving exact transferred values are returned and getter counts bounded, plus legacy empty-compact unavailable test.

3. **Strict transfer schema and validation** — Exported `TIMELINE_LEGACY_BUFFER_COUNT=11` and `TIMELINE_CURRENT_BUFFER_COUNT=28` from `packages/simulator/src/timeline.ts`. Added central `validateRideTimelineTransfer` using `byteLength` views without copying payload, shared by `RideTimeline.fromTransferable` and `apps/web/src/engineering/protocol.ts`. Validation rejects: any buffer count other than 11 or 28; non-positive/non-finite `sampleRateHz`, invalid `carCount`, declared `length` inconsistent with buffer 0; wrong scalar/vector/per-car byte lengths (allowing 0 for optional empty); non-finite contents; nested `timeline.frames` on engineering success responses. Legacy 11-buffer hydration remains supported (new series empty). Protocol fixtures updated to genuinely valid 28-buffer timeline.

4. **Truthful compact ride telemetry** — `apps/web/src/ride/controller.ts:compactTelemetryAt` now only synthesizes when complete current 28-buffer schema has exact shapes (all activity/energy/bank/roll/specificForce and per-car arrays). Legacy 11-buffer zero-frame timelines return `undefined` rather than fabricated zeros or duplicated front-car evidence. Complete 28-buffer compact timelines retain truthful interpolation without seat buffers.

5. **Complete parity and honest tests/report** — Table-drove compact-vs-full equality for every authoritative series (normals, binormals, bank, roll, specificForce, all energy/activity, all per-car scalar/vector). Assert exactly 28 buffers, table-drive round-trip/shape/non-finite rejection for new fields, ownership via mutating actual transfer `ArrayBuffer` after hydration. Renamed worker test to `compact payload transfer-list contract: timeline buffers are 28 ArrayBuffers and collectTransferables contains only buffers`. Renamed controller test from false full-frame claim to `compact zero-frame timeline without telemetry still yields finite front position via SoA and undefined telemetry`. Fresh output asserts exactly 28; legacy compatibility is separate exact-11 test.

## 1b. Final boundary hardening (8d22d3f → this commit)

6. **Generic `RideTimeline` boundary** — `packages/simulator/src/timeline.ts:50` removed `carCount <=6` project limit from `validateRideTimelineTransfer`; now requires `Number.isSafeInteger(carCount) && carCount >=0` and same safe-integer rule for `length`. No seat buffers added; default seat offsets remain zero.

7. **Direct `fromTransferable` hardening** — Added explicit `Array.isArray(buffers)` and `instanceof ArrayBuffer` checks, safe-integer dimension checks, and safe non-negative integer checks for every expected byte-size multiplication (`length*8`, `length*3*8`, `length*carCount*8`, `length*carCount*3*8`). Non-finite view checks remain via `Float64Array` without copying payload.

8. **Strict-current engineering boundary** — `apps/web/src/engineering/protocol.ts` reuses centralized validator in `strictCurrent` mode: a 28-buffer `EngineeringWorkerSuccess` response requires every scalar/vector/per-car buffer to have its exact complete byte length (zero not accepted when expected nonzero); exactly-11 legacy responses remain accepted; nested `frames` continues to be rejected. Validation also requires `carCount`/`length` safe integers and `ArrayBuffer` members.

9. **Compact transfer type** — Narrowed `EngineeringWorkerSuccess.timeline` to `RideTimelineCompactTransfer` (`Omit<RideTimelineTransfer,"frames"> & { frames?: never }`), so TypeScript contract matches runtime compact-only validation. General `RideTimelineTransfer` unchanged for simulator/full/legacy uses.

10. **Zero-car telemetry** — `apps/web/src/ride/controller.ts:compactTelemetryAt` handles `carCount=0` without dereferencing `perCarTelemetry[0]`; `perCar` is empty and top-level G/bank/roll/energy telemetry is interpolated from global compact series (`longitudinalG/lateralG/verticalG/bankRad/rollRateRadPerSec/...`). Regression added.

11. **Table-driven hardening coverage** — Added malformed-buffer tests table-driven across scalar/vec3/car-vec3/per-car-scalar/per-car-vec3 groups plus non-finite contents; seven-car exact round-trip via generic transfer; unsafe integer/product rejections; protocol tests for emptied required compact buffer, unsafe dimensions, non-ArrayBuffer member, nested frames, and legacy 11 acceptance.

## 2. Verification (commands run, all GREEN)

```
npx vitest run packages/simulator/src apps/web/src/engineering apps/web/src/ride apps/web/src/telemetry.test.ts
  Test Files  16 passed (16)  Tests  210 passed (210)

npx vitest run apps/web/src
  Test Files  33 passed (33)  Tests  408 passed (408)

npm run typecheck  → 4 workspaces ok
npm run lint       → oxlint 0 warnings
npm run format:check → All matched files use Prettier code style!
npm run build      → vite 8.2.2 built in 227ms, 902.21 kB
```

RED evidence (pre-fix, reproduced then fixed):
- `seven-car exact round-trip should succeed` → `RangeError: RideTimeline carCount must be integer 0..6` at `timeline.ts:57`
- `carCount=0 complete compact timeline does not dereference perCar[0]` → `TypeError: Cannot read properties of undefined (reading 'longitudinalG')` at `controller.ts:966`
- `rejects 28-buffer response with emptied required compact buffer` → expected throw but did not throw (generic validator allowed zero)

All RED cases GREEN after fixes above. No full browser E2E benchmark or Chromium renderer heap measurement was run in this writer task.

## 3. Self-review

- Monotonic helper is called by both production paths; test instruments its `timeSeconds` getter, not source text or wall-clock.
- Telemetry rollRate/energyResidual snapshots are single-copy per request, verified by spy counts ≤1.
- Transfer validation uses `byteLength` views and shared validator; per-car and vector lengths checked with allowance for 0-length optional empty arrays for minimal timelines (generic), strict-current forbids zero when expected nonzero.
- Compact telemetry returns `undefined` for legacy shape, avoiding zero fabrication and front-car duplication; zero-car case returns empty perCar with global series telemetry.
- Parity and ownership tests use exact 28-buffer assertions and buffer mutation; seven-car generic round-trip proves no 6-car limit in serialization type.

## 4. Concerns / residual risk

- 240 Hz detailed `SimulationResult.frames` graph remains retained for fidelity; browser path no longer retains/clones/transfers 120 Hz graph, reducing transfer to ~30 MB, but detailed graph size is unchanged.
- Real Chromium OOM proof is still pending root rerun of the full browser benchmark with Playwright Chromium after fresh review.

## 5. Commit

Single concise final-hardening commit containing source/tests/report, tree left clean on `main`, not pushed, not amending `575484b`/`8d22d3f`, no seat buffers, no embedded SHA, no seed/target/rate/dependency/browser-harness changes.
