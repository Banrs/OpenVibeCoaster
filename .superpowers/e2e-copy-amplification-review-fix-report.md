# e2e copy amplification – review-fix RED/GREEN report

## Summary
Review feedback required two surgical corrections on top of `e0bc9b8a`:
1) Every defensive-getter spy in `telemetry.test.ts` and `render.test.ts` must restore prototype descriptors via `try/finally` (including two sequential `CompiledTrackData` spies) so no test can leave `RideTimeline.prototype` / `CompiledTrackData.prototype` wrapped if the consumer or an assertion throws.
2) `trackGeometry.ts` must be lazy for `elementIndices`: 0 reads when `selectedElementIndex` is `undefined`, ≤1 when enabled. Strengthen the disabled-case test to expect exactly 0, capture RED, then fix.

## RED – strengthened disabled-case expectation (expected failure before lazy fix)

Run (after strengthening test + try/finally wrapping, before lazy fix):
`npx vitest run apps/web/src/render/render.test.ts --reporter=verbose`

Output (abridged, preserved verbatim):

```
× render – defensive-copy amplification regression > buildTrackGeometries snapshots tangents once per build and elementIndices once when selection enabled
  → expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ apps/web/src/render/render.test.ts:556:42
      expect(spy1.counts.elementIndices).toBe(0);
```

```
Test Files  1 failed (1)
     Tests  1 failed | 20 passed (21)
```

Full log: `C:\Users\danie\AppData\Local\Temp\opencode\red_render.txt` (captured 2026-08-31).

Explanation: `buildTrackGeometries` eagerly did `const elementIndicesArr = data.elementIndices` even when `selectedElementIndex` was `undefined`, causing 1 defensive copy. The strengthened test now requires 0.

## GREEN – after corrections

### Code changes (surgical)

- `apps/web/src/telemetry.test.ts` – wrapped every `spyTimelineGetters` usage in `try { ... } finally { spy.restore(); }`. Covers 5 regression tests; sequential `verticalG/lateralG` test wraps each spy (`spy` and `spy2`) in its own `try/finally` so no descriptor leak.
- `apps/web/src/render/render.test.ts` – wrapped every `spyTrackGetters` usage in `try/finally`:
  - `buildSupportColumns` and `supports fallback`: single spy wrapped.
  - `buildTrackGeometries`: two sequential spies (`spy1` disabled, `spy2` enabled) each wrapped in its own `try/finally`. Strengthened disabled assertion: `expect(spy1.counts.elementIndices).toBe(0)` (was missing / `≤1`).
- `apps/web/src/render/trackGeometry.ts` – lazy `elementIndices`: removed eager `const elementIndicesArr = data.elementIndices`; added `let elementIndicesArr: Uint32Array | null = null;` and `isSelected` now does:

```ts
if (options.selectedElementIndex === undefined) return false;
if (elementIndicesArr === null) elementIndicesArr = data.elementIndices;
return elementIndicesArr[idx] === options.selectedElementIndex;
```

Result: `selectedElementIndex === undefined` → 0 reads; enabled → 1 read cached for the whole build (no per-sample copy).

No other numerical/rendering behavior changed. No signature extraction broadening or unrelated test rewrites.

### Verification

Run: `npx vitest run apps/web/src/render/render.test.ts apps/web/src/telemetry.test.ts apps/web/src/experienceController.test.ts --reporter=verbose`

Result (GREEN):
```
Test Files  3 passed (3)
     Tests  62 passed (62)
```

Counts after fix (GREEN):
- `buildTrackGeometries` disabled: `elementIndices` 0, `tangents` ≤1
- `buildTrackGeometries` enabled: `elementIndices` 1, `tangents` 1
- `telemetry gForce`: vertical/lateral/longitudinal each 1
- `telemetry speed`: 1
- `telemetry rollRate fallback`: headDistanceM 1, speedMps 1
- `computeTelemetrySignature`: speedMps 1, headDistanceM 1, timeSeconds 1
- `supports`: positions 1
- `experienceController validateResult`: each getter 1

Broader:
```
npx vitest run apps/web/src
→ 397 passed (31 test files)

npm run typecheck → pass
npm run lint → pass
npm run format:check → pass
npm run build → pass (vite build 67 modules, 880 kB)
```

All prototype spies now own `try/finally`; `git diff` shows only the 3 surgical files above plus this report.

## Files changed

- `apps/web/src/telemetry.test.ts` – try/finally around every spy
- `apps/web/src/render/render.test.ts` – try/finally around every spy + strengthen `elementIndices` disabled expectation to `toBe(0)`
- `apps/web/src/render/trackGeometry.ts` – lazy `elementIndices` snapshot (0 when disabled, 1 when enabled)

Report added:
- `.superpowers/e2e-copy-amplification-review-fix-report.md` (this file)

## Tests run

```
npx vitest run apps/web/src/render/render.test.ts apps/web/src/telemetry.test.ts apps/web/src/experienceController.test.ts
npx vitest run apps/web/src
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Commit

This report is included in the same commit as the correction; resolve it with git log --oneline -- .superpowers/e2e-copy-amplification-review-fix-report.md.

Message: `fix(web): restore spies via try/finally and lazy elementIndices read`

## Concerns

- `RideTimeline`/`CompiledTrackData` remain frozen/copying – no buffer exposure.
- Lazy `elementIndices` keeps ≤1 copy when enabled; no per-sample amplification.
- No additional runtime dependencies, renderer flushes, batching, or gate relaxations.
