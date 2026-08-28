# OpenVibeCoaster agent guide

## Commands

Use Node.js 24 LTS or Node.js 26 and npm 11.

```text
npm ci
npm run dev
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:e2e
npm run bench
```

Run `npm run verify` before committing a completed integration task. Behavioral
work follows test-first red/green/refactor; preserve the failing-test evidence in
the task report.

## Architectural boundaries

- `packages/core`, `packages/simulator`, and `packages/generator` are pure,
  deterministic TypeScript. They must not import Three.js, DOM, Web Audio, or
  application state.
- `CompiledTrackData` from core is the sole downstream track representation.
  Rendering may tessellate it but may not invent or maintain another spline.
- Internal engineering values use SI units. World axes are right-handed: X right,
  Y up, Z forward.
- Frames are rotation-minimizing across the complete track with authored bank
  about the tangent. Never reset frames at seams or smooth sampled joins.
- Signed train speed, stalls, and rollback are authoritative. Visual smoothing
  cannot alter telemetry.
- Hard constraints stay hard. Diagnostics must identify exact failures and label
  source-verified facts, project limits, assumptions, and unknown criteria.
- Never claim ASTM compliance without a complete licensed profile.

## Repository workflow

- This folder is a standalone repository. Never inspect, restore, or port the
  deleted parent C# repository or its Git history.
- Agent writers use ignored `.worktrees/<task>` directories and `codex/<task>`
  branches. They stay inside their assigned file scope, never merge or push, and
  never spawn their own agents.
- The root controller owns task briefs, the ignored SDD ledger, reviews, rulings,
  rebases, fast-forward merges, integration verification, and the final push.
- Keep changes surgical. Do not weaken root verification gates or broadly ignore
  source/config/documentation paths to make checks pass.
- Procedural assets only unless redistribution rights are recorded.
