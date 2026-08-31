# Browser timeline OOM review fix — truthful RED/GREEN report

Review correction applied on `main` at `575484b` per `.superpowers/browser-timeline-oom-review-fix.md`. Work as sole writer, no push, no full browser benchmark in this task.

## 1. Corrections applied

1. **Production-exercising linearity regression** — Extracted `createMonotonicBracketLocator` in `packages/simulator/src/index.ts` used by both compact and full `makeTimeline` paths, eliminating duplicated cursor loops. Replaced false-proof test in `packages/simulator/src/resampling.linear.test.ts` with instrumentation via `timeSeconds` getters/proxies on the exact production helper, asserting total reads `O(frames+outputs)` (`reads < frames+outputs*2`, `reads < 12000`) and retaining full vs compact output equality.

2. **Authoritative compact analysis series** — `apps/web/src/telemetry.ts`: `rollRate` now prefers finite exact-length snapshot of `timeline.rollRateRadPerSec` before full-frame and geometric fallbacks; `energyResidual` prefers finite exact-length snapshot of `timeline.energyErrorJ` before full-frame fallback. Each defensive getter snapshotted at most once per series request. Added frame-empty compact regression tests proving exact transferred values are returned and getter counts bounded, plus legacy empty-compact unavailable test.

3. **Strict transfer schema and validation** — Exported `TIMELINE_LEGACY_BUFFER_COUNT=11` and `TIMELINE_CURRENT_BUFFER_COUNT=28` from `packages/simulator/src/timeline.ts`. Added central `validateRideTimelineTransfer` using `byteLength` views without copying payload, shared by `RideTimeline.fromTransferable` and `apps/web/src/engineering/protocol.ts`. Validation rejects: any buffer count other than 11 or 28; non-positive/non-finite `sampleRateHz`, invalid `carCount`, declared `length` inconsistent with buffer 0; wrong scalar/vector/per-car byte lengths (allowing 0 for optional empty); non-finite contents; nested `timeline.frames` on engineering success responses. Legacy 11-buffer hydration remains supported (new series empty). Protocol fixtures updated to genuinely valid 28-buffer timeline.

4. **Truthful compact ride telemetry** — `apps/web/src/ride/controller.ts:compactTelemetryAt` now only synthesizes when complete current 28-buffer schema has exact shapes (all activity/energy/bank/roll/specificForce and per-car arrays). Legacy 11-buffer zero-frame timelines return `undefined` rather than fabricated zeros or duplicated front-car evidence. Complete 28-buffer compact timelines retain truthful interpolation without seat buffers.

5. **Complete parity and honest tests/report** — Table-drove compact-vs-full equality for every authoritative series (normals, binormals, bank, roll, specificForce, all energy/activity, all per-car scalar/vector). Assert exactly 28 buffers, table-drive round-trip/shape/non-finite rejection for new fields, ownership via mutating actual transfer `ArrayBuffer` after hydration. Renamed worker test to `compact payload transfer-list contract: timeline buffers are 28 ArrayBuffers and collectTransferables contains only buffers`. Renamed controller test from false full-frame claim to `compact zero-frame timeline without telemetry still yields finite front position via SoA and undefined telemetry`. Fresh output asserts exactly 28; legacy compatibility is separate exact-11 test.

## 2. Verification (commands run, all GREEN)

```
npx vitest run packages/simulator/src apps/web/src/engineering apps/web/src/ride apps/web/src/telemetry.test.ts
  Test Files  16 passed (16)  Tests  202 passed (202)

npx vitest run apps/web/src
  Test Files  33 passed (33)  Tests  404 passed (404)

npm run typecheck  → 4 workspaces ok
npm run lint       → oxlint 0 warnings
npm run format:check → All matched files use Prettier code style!
npm run build      → vite 8.2.2 built in 235ms, 900.53 kB
```

No full browser E2E benchmark or Chromium renderer heap measurement was run in this writer task.

## 3. Self-review

- Monotonic helper is called by both production paths; test instruments its `timeSeconds` getter, not source text or wall-clock.
- Telemetry rollRate/energyResidual snapshots are single-copy per request, verified by spy counts ≤1.
- Transfer validation uses `byteLength` views and shared validator; per-car and vector lengths checked with allowance for 0-length optional empty arrays for minimal timelines.
- Compact telemetry returns `undefined` for legacy shape, avoiding zero fabrication and front-car duplication.
- Parity and ownership tests use exact 28-buffer assertions and buffer mutation.

## 4. Concerns / residual risk

- 240 Hz detailed `SimulationResult.frames` graph remains retained for fidelity; browser path no longer retains/clones/transfers 120 Hz graph, reducing transfer to ~30 MB, but detailed graph size is unchanged.
- Real Chromium OOM proof is still pending root rerun of the full browser benchmark with Playwright Chromium after fresh review.

## 5. Commit

Single concise review-fix commit containing source/tests/report, tree left clean on `main`, not pushed, not amending `575484b`, no embedded SHA, no seed/target/rate changes.
