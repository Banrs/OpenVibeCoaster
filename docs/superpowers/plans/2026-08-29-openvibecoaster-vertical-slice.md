# OpenVibeCoaster Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Every behavioral change follows test-first red/green/refactor.

**Goal:** Deliver a deterministic, editable, analysable, and ridable modern LSM coaster in the browser.

**Architecture:** Pure TypeScript engineering packages compile semantic design into one immutable arc-length track. A native worker generates, simulates, and validates it; raw Three.js and DOM UI consume the transferred data.

**Tech Stack:** Node 24 LTS, npm workspaces, TypeScript, Vite, Three.js, Vitest, fast-check, Playwright, Oxlint, Prettier.

**Spec:** `docs/architecture.md` plus the approved task requirements in the root conversation.

## Global Constraints

- Do not inspect, restore, or port any parent-repository C# history.
- No Three.js or browser types in engineering packages.
- No post-sample geometry smoothing, fabricated telemetry, or ASTM compliance claims.
- All randomness is seeded and all hard constraints remain hard.
- Agents work only in assigned worktrees, commit their task, and never merge or push.

## Tasks

1. Core math, geometry, frames, compilation, schema, and tests.
2. Viewport-first web shell and accessible controls against canonical fixtures.
3. Multi-car simulator, operations, telemetry, energy accounting, and analytic tests.
4. Semantic elements, transition solving, seam diagnostics, and regressions.
5. Three.js track/train/terrain/support rendering and ride cameras.
6. Deterministic generation, directed constraints, terrain/clearance, and local regeneration.
7. Worker integration, editor, telemetry plots, metric coloring, audio, and persistence.
8. Browser automation, benchmarks, documentation, accessibility, visual QA, and final verification.
