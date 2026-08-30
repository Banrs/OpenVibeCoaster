# OpenVibeCoaster agent guide

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

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

## Collaboration

- This folder is a standalone repository. Never inspect, restore, or port the
  deleted parent C# repository or its Git history.
- Keep changes surgical. Do not weaken root verification gates or broadly ignore
  source/config/documentation paths to make checks pass.
- Procedural assets only unless redistribution rights are recorded.
- Teams may choose an appropriate local or parallel workflow, keep scopes
  explicit, avoid conflicting edits, verify before integration, and preserve
  repository safety and architecture.
