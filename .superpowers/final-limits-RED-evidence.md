# RED evidence – final limits

## Before fix (RED)
`handleGenerate("regression-over-limit", validIntent, strictProfile)` returned `type: "success"` even though timeline contained:

- Jerk magnitude 426.79 m/s³ > limit 15 (margin -411.79)
- Provenance PROJECT_ENGINEERING_LIMIT missing

Existing worker tests expected `success` for `validIntent` (station-launch-brake-station) and `flagship` (full-auto rolling-highlands) without any engineering-limits check. The audited blocker was `data/profiles/engineering-limits-v1.json` thresholds not enforced.

Captured in `apps/web/src/engineering/engineering-limits.regression.test.ts` first assertion:

```
expect(result.type).toBe("failure") // was "success" before fix
// diagnostics[0].code === "ENGINEERING_LIMIT_JERK", actual 426.79, limit 15, provenance PROJECT_ENGINEERING_LIMIT, location s/time/position
```

## After fix (GREEN)
- `packages/simulator/src/engineering-limits.ts` implements pure deterministic `validateEngineeringLimits(timeline, track, profile)` with:
  - per-car and ride SoA series for vertical min/max, |lateral|, |longitudinal|, |jerk| (hypot), |rollRate|
  - earliest time, smallest carIndex tie handling, exact `timeSeconds`, `s=headDistanceM`, `position=carPositionsXYZ`, `elementIndex` via `track.distances/elementIndices`
  - `actual`/`limit`/`margin` (margin = limit-abs(actual) or actual-limit for vertical min), `location: {s, position}`, `relatedIds: [car-*, element-*]`, `provenance: "PROJECT_ENGINEERING_LIMIT"`, `severity: "error"`
  - missing/empty timeline → fatal `ENGINEERING_LIMITS_UNCERTIFIED`, no fabrication
- `apps/web/src/engineering/worker.ts` calls `validateEngineeringLimits` with explicit typed `ProjectEngineeringLimits` at worker boundary (not reading JSON from simulator). Worker `handleGenerate/handleRegenerate/handleCompileSimulate` now accept optional `engineeringLimits` and return `failure` when any limit diagnostic is error/fatal, consistent with hard errors.
- `apps/web/src/main.ts` passes `defaultProjectEngineeringLimits` explicitly from simulator (typed, not fs read) for production generate/regenerate/compileSimulate.
- `apps/web/src/engineering/protocol.ts` adds optional `engineeringLimits?: ProjectEngineeringLimits` to worker requests with strict validation.
- `apps/web/src/engineering/client.ts` forwards explicit profile.
- Tests: `packages/simulator/src/engineering-limits.test.ts` covers below-limit, vertical max/min boundary, lateral/longitudinal, jerk, roll, multiple limits, deterministic tie, missing data, explicit profile override. `apps/web/src/engineering/engineering-limits.regression.test.ts` covers production-path over-limit RED→GREEN and permissive control.

## Verification
- `npm run typecheck` – pass
- `npm run lint` – pass (fixed unused param)
- `npm run format:check` – pass (prettier write)
- `npm run test` – 58 files, 747 tests pass (including new 13+3)
- `npm run build` – vite build 68 modules, 916k JS, portable packager ok
- `npm run verify` – full pass
