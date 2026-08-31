# e2e copy amplification – RED/GREEN report

## Summary
Defensive-copy getters on `RideTimeline` and `CompiledTrackData` deliberately return fresh typed arrays. Hot loops indexed those getters every iteration, turning O(N) work into O(N) allocations (≈11 GB for a 21 600-sample timeline). Fix snapshots each required getter once before its consuming loop.

## RED – failing accessor-count regression (expected)

Run: `npx vitest run apps/web/src/experienceController.test.ts apps/web/src/telemetry.test.ts apps/web/src/render/render.test.ts --reporter=verbose`

Output (abridged, preserved verbatim):

```
× ExperienceController – defensive-copy amplification regression > validateResult snapshots timeline getters once per validation (not per sample)
  → expected 14 to be less than or equal to 1

× telemetry – defensive-copy amplification regression > gForce path snapshots vertical/lateral/longitudinal G once each, not per sample
  → expected 5 to be less than or equal to 1

× telemetry – defensive-copy amplification regression > speed metric copies speedMps exactly once (not twice for length check + Array.from)
  → expected 2 to be less than or equal to 1

× telemetry – defensive-copy amplification regression > rollRate fallback reuses distances snapshot and does not re-read headDistanceM per sample
  → expected 5 to be less than or equal to 1

× telemetry – defensive-copy amplification regression > verticalG/lateralG/longitudinalG do not double-copy when frames fallback not needed
  → expected 2 to be less than or equal to 1

× telemetry – defensive-copy amplification regression > computeTelemetrySignature snapshots speedMps/headDistanceM/timeSeconds once per 64-sample hash (not 128 copies)
  → expected 64 to be less than or equal to 1

× render – defensive-copy amplification regression > buildSupportColumns snapshots positions once, not three times per support
  → expected 12 to be less than or equal to 1

× render – defensive-copy amplification regression > buildTrackGeometries snapshots tangents once per build and elementIndices once when selection enabled
  → expected 15 to be less than or equal to 1

× render – defensive-copy amplification regression > supports fallback also snapshots positions once
  → expected 3 to be less than or equal to 1

Test Files  3 failed (3)
      Tests  9 failed | 53 passed (62)
```

Full log preserved from run at 2026-08-31 21:57 UTC (see `C:\Users\danie\AppData\Local\Temp\opencode\red_output.txt` snapshot).

## Getter call counts – before (RED)

| File | Consumer | Getter | Count (RED) | Expected after fix | Notes |
|------|----------|--------|-------------|--------------------|-------|
| `experienceController.ts:validateResult` | loop over `timeline.length=12` | `headDistanceM` | **14** | 1 | 2 (instanceof+aligned) +12 loop |
|  |  | `timeSeconds` | **14** | 1 | same |
|  |  | `speedMps` | **14** | 1 | same |
| `telemetry.ts:gForce` | `length=4` | `verticalG` | **5** | 1 | 1 length check +4 per-sample |
|  |  | `lateralG` | **5** | 1 | |
|  |  | `longitudinalG` | **5** | 1 | |
| `telemetry.ts:speed` | `length=5` | `speedMps` | **2** | 1 | length check + Array.from |
| `telemetry.ts:verticalG` (single) | `length=4` | `verticalG` | **2** | 1 | double copy |
| `telemetry.ts:rollRate fallback` | `length=4` | `headDistanceM` | **5** | 1 | 1 via arraysFromTimeline +4 per-sample fallback |
|  |  | `speedMps` | **1**→**2** observed | 1 | speed snapshot 1, head dist amplifies |
| `telemetry.ts:computeTelemetrySignature` | `len=70` (64 iter) | `speedMps` | **64** | 1 | 64 copies in loop |
|  |  | `headDistanceM` | **64** | 1 | 64 copies |
|  |  | `timeSeconds` | **1** | 1 | single for duration |
| `render/supports.ts` | `count≈31`, `interval=10` → 4 supports | `positions` | **12** | 1 | 3 per support |
| `render/supports.ts` fallback | 1 fallback | `positions` | **3** | 1 | 3 per fallback |
| `render/trackGeometry.ts` | `count≈31`, `tieCount=5` | `tangents` | **15** | 1 | 3 per tie |
| `render/trackGeometry.ts` | `count≈31` with selection | `elementIndices` | **31** (inferred) → measured 15 for tangents, selection path 31 per sample | 1 | per-sample via isSelected |

All counts measured via prototype-getter spies on real `RideTimeline`/`CompiledTrackData` instances (instances are frozen, so prototype wrapping).

## GREEN – after fix

Run: `npx vitest run apps/web/src/experienceController.test.ts apps/web/src/telemetry.test.ts apps/web/src/render/render.test.ts --reporter=verbose`

Result: **62 passed, 0 failed** (all 9 amplification regressions now pass with counts ≤1).

Broader: `npx vitest run apps/web/src` → **397 passed** (31 test files).
`npm run typecheck` → pass
`npm run lint` → pass (removed unused RideTimeline import)
`npm run format:check` → pass
`npm run build` → pass (vite build 67 modules, 880 kB)

### Counts after fix (GREEN)

All spied getters ≤1 per invocation:

- `experienceController validateResult`: 1 each
- `telemetry gForce`: 1 each (vertical/lateral/longitudinal)
- `telemetry speed`: 1
- `telemetry verticalG/lateralG`: 1
- `telemetry rollRate fallback`: `headDistanceM` 1 (reuses `distances` from `arraysFromTimeline`), `speedMps` 1
- `computeTelemetrySignature`: `speedMps` 1, `headDistanceM` 1, `timeSeconds` 1 (was 128 copies for 64-sample loop)
- `supports`: `positions` 1
- `trackGeometry`: `tangents` 1, `elementIndices` 1

## Files changed

Production (snapshot-once, no buffer exposure):
- `apps/web/src/experienceController.ts` – snapshot `headDistanceM/timeSeconds/speedMps` before validation loop
- `apps/web/src/render/supports.ts` – snapshot `positions` once (`const positions = data.positions`)
- `apps/web/src/render/trackGeometry.ts` – snapshot `tangents` + `elementIndices` once; `isSelected` and tie loop use locals
- `apps/web/src/telemetry.ts` – per-metric lazy snapshots for `speedMps/verticalG/lateralG/longitudinalG`; `gForce` 3 getters once; `rollRate` fallback reuses `distances` snapshot
- `apps/web/src/app/telemetrySignature.ts` **(new)** – extracted pure `computeTelemetrySignature` and snapshots `timeSeconds/speedMps/headDistanceM` once (was 128 copies for 64 samples); `apps/web/src/main.ts` now imports it

Tests (focused accessor-count regressions, prototype-spy, real instances):
- `apps/web/src/experienceController.test.ts`
- `apps/web/src/telemetry.test.ts` (also covers signature via imported `computeTelemetrySignature`)
- `apps/web/src/render/render.test.ts`

## Tests run

```
npx vitest run apps/web/src/experienceController.test.ts apps/web/src/telemetry.test.ts apps/web/src/render/render.test.ts
npx vitest run apps/web/src
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Commit

SHA: _to be filled after commit_ – concise message: `fix(web): snapshot defensive getters to eliminate copy amplification`

## Concerns

- `RideTimeline`/`CompiledTrackData` remain frozen/copying – no internal buffer exposure, no immutability change.
- `frames` intentionally not snapshotted (non-typed-array).
- `telemetry` keeps lazy per-metric copying: only the requested series is snapshotted, not all.
- `trackGeometry` snapshots `elementIndices` even when selection disabled (1 copy vs 0) – acceptable single-copy cost vs per-sample amplification; could be made lazy if desired.
- `telemetrySignature` extraction adds a new pure file (`apps/web/src/app/telemetrySignature.ts`) to make `computeTelemetrySignature` testable without DOM side effects; `main.ts` now imports it – numerical/UI output unchanged.
- No renderer `info.reset`, flush, `forceContextLoss`, batching, or relaxed targets added – those remain separate hypotheses.

