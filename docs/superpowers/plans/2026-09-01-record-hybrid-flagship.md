# Record-Hybrid Flagship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact default flagship with a deterministic, coefficient-backed 5,200–5,400 m record-hybrid terrain coaster that validates 225–235 m height, 285–295 km/h measured speed, 90–92 m inverted top hat, 80–82 m Immelmann, 66–68 m vertical loop, and about 210 m / 110° held cliff dive through one `DesignIntentV1 -> SolvedSpan[] -> CompiledTrackData -> RideTimeline` authority without weakening constraints, inventing power, or claiming ASTM compliance.

**Architecture:** `DesignIntentV1` + dated snapshot + record profile -> `solveSemanticChain`/`buildElement` (seventh-order Hermite position + quintic roll coefficients) -> `compileTrack` adaptive LUT -> `CompiledTrackData` (sole downstream representation) -> `simulateRide`/`RideTimeline` -> `generateCoaster`/`validateGenerationConstraints`/`validateClearance` -> inline `EngineeringWorker` (`?worker&inline` via `apps/web/src/engineering/factory.ts`, `EngineeringWorkerRequest`/`EngineeringWorkerResponse`, transferable canonical arrays via `collectTransferables`, epoch stale-rejection) -> `ExperienceController` (`apps/web/src/experienceController.ts`) -> Three.js tessellation (no second spline).

**Tech Stack:** Node 24 LTS (Krypton), npm 11.17.0, npm workspaces, TypeScript 7, Vite 8, Three.js (raw, no wrapper), Vitest 4 + fast-check 4, Playwright 1.62, Oxlint 1.80, Prettier 3.9. Single-file `apps/web/dist/OpenVibeCoaster.html` via `apps/web/scripts/portable-packager.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md`

## Global Constraints

- Compiled-geometry hard windows (measured, never authored intent): physical total length 5,200–5,400 m; physical max height 225–235 m; timeline-measured max speed 285–295 km/h (79.16–81.94 m/s); inverted top hat 90–92 m; Immelmann 80–82 m; vertical loop 66–68 m; held cliff dive about 210 m (207–213 m) at 110° (108.5–111.5°) from horizontal.
- Timeline-measured force achievement windows: brief vertical specific-force peak maximum in [+4.8, +5.0] g AND timeline minimum vertical <= -1.0 g (target about -1.1 g); lateral magnitude <= 1.5 g; longitudinal magnitude <= 1.5 g; jerk magnitude <= 15 m/s³; roll rate magnitude <= 1.5 rad/s. Existing `engineering-limits-v1.json` caps (vertical -1.2/+5.0, lat/long 1.5, jerk 15, roll 1.5) stay unchanged and are enforced as hard caps by `validateEngineeringLimits`; the new achievement floor (+4.8) is enforced only by the new `validateRecordTargets` record diagnostics, never by editing `engineering-limits-v1.json`.
- Unchanged train/energy model: six cars × 1,500 kg (9,000 kg total, `seatCount: 4` each), `spacingM: 3.4`, envelope `halfWidthM: 1.25 / aboveRailM: 2.1 / belowRailM: 0.8 / noseTailMarginM: 0.75`; `lsmForcePerCarN: 14000`, `lsmPowerPerCarW: 1200000`, `maxBrakeForcePerCarN: 18000`, `dragCdA: 4.0`, `rollingResistanceCoefficient: 0.002`, `staticStictionCoefficient: 0.002`, `airDensityKgPerM3: 1.225`, `gravityMps2: 9.80665`, `fixedStepSeconds: 1/240` (RK4), `timelineStepSeconds: 1/120`. Per `data/profiles/train-lsm-v1.json` (`DESIGN_ASSUMPTION`).
- Exactly three new semantic kinds: `diveDrop`, `immelmann`, `verticalLoop`. No `terrainSwoop`, no record-specific rendering model, no fourth kind. Existing `topHat` height validation is extended from exactly-80 to the interval [80, 92] (default 80 preserved); this is a range extension, not a new kind. Record [90, 92] is enforced only in Task 08 from compiled geometry.
- Geometry authority: seventh-order Hermite position spans (3×8 `positionCoefficients`) + quintic scalar roll spans (6 `rollCoefficients`); one global RMF via `transportFramesAlongPath`/`doubleReflectionFrames` with authored bank about the tangent, never reset at seams; no sampled-vertex seam smoothing; every `SerializedSolvedSpanV1.length` is the integrated physical length of that child; `CompiledTrackData` is the sole downstream representation; rendering tessellates it via `buildTrackGeometries`/`buildSupportColumns` only.
- Simulation authority: signed speed with real `static-hold` / `stall` / `rollback` / `reversal` states (`packages/simulator/src/contracts.ts:135`); visual smoothing never alters telemetry; operation zones are half-open `[startDistanceM, endDistanceM)` and `endDistanceM` must never exceed `track.totalLength` (`packages/simulator/src/index.ts:494-500`).
- Clearance authority: exact certified clearance via `validateClearance` (`packages/generator/src/clearance.ts:741`) and `computeClearanceField` (`packages/generator/src/clearance-field.ts:313`) with certified Bernstein bounds, `sqrt(3)` directional locality, bounded pair/node heap, `CertifiedWorkBudget`; exhaustion yields `CLEARANCE_UNCERTIFIED`, non-finite yields `NUMERIC_UNCERTIFIED`, never a silent pass.
- ASTM F2291 stays `UNKNOWN_UNCONFIGURED` per `data/standards/f2291-26.json` (`licensedProfileConfigured: false`, empty `criteria`). Never claim certification/compliance; never reproduce copyrighted thresholds. Record labels are `PROJECT_ENGINEERING_LIMIT` / `DESIGN_TARGET`, never `SOURCE_VERIFIED`.
- Supports are visual-only. `buildSupportColumns` (`apps/web/src/render/supports.ts:14`) skips columns with `height > 60` (`supports.ts:36`) and heights `< 0.15`. The 225 m summit is therefore NOT structurally supported; Task 14 documents this limitation in README instead of pretending support.
- Internal SI units; right-handed world axes X right / Y up / Z forward.
- Raw Three.js at the web boundary; no new runtime dependencies/assets/backend/deployment.
- CI-only executable verification; commands run in GitHub Actions, never locally during this task.

All tasks must preserve: pure `packages/core`, `packages/simulator`, `packages/generator` (no Three.js/DOM/WebAudio/mutable app state); hard constraints stay hard; diagnostics carry `actual`/`limit`/`margin`/`location.s` where meaningful; `CompiledTrackData.checksum` canonical path; exact solver/search budgets in `packages/generator/src/pipeline.ts:1492-1497` (`maxIterations`: 32 directed, 1 bare insta with no targets/constraints, 8 otherwise) and `pipeline.ts:1970-1974` (`maxCandidates`: 1 when directed or bare insta, else 48) plus at most 3 relaxation reruns; `ADAPTIVE_MAX_*` (`packages/core/src/track.ts:91-100`); `defaultTolerances` (`packages/generator/src/solver.ts:35`); clearance `maxWork` budgets. Never loosen validation or claim record success from authored intent.

## Branch / Worktree / Packet Order

Branch: `feat/record-hybrid-flagship` (assigned worktree `record-hybrid-design` at `b08c68e`). Workers never merge or push; each task commits inside the worktree.

### Dependency DAG and reviewable packets

- **Packet A – Foundations (Tasks 01–02)** lands first: dated snapshot + record profile + diagnostics vocabulary (01), then semantic type/parser/serialization contracts plus the `topHat` [80, 92] range extension (02). No geometry until A lands.
- **Packet B – Geometry (Tasks 03→04→05, strictly sequential)** depends on A. Tasks 03 (`diveDropSpans`), 04 (`immelmannSpans`), 05 (`verticalLoopSpans`) all touch `packages/generator/src/elements.ts` near line 312 and the `buildElement` switch at line 612, so they MUST land in order 03 then 04 then 05 to avoid same-file switch conflicts. Each defines its own synthesis function and span-count constant; each is reviewed in isolation before the next starts. No cross-element rendering yet.
- **Packet C – Generation Pipeline (Tasks 06→07, ordered)** depends on A+B: record default sequence + deterministic generation + save/reload preservation (06), then cliff/valley terrain + directed gates/pins + clearance authority (07). 06 before 07.
- **Packet D – Validation Authority (Task 08)** depends on A+B+C: measured record validation from compiled geometry and `RideTimeline`, including force achievement, hold/rollback/restart, energy/LSM/brake, zones, and the new `maxYForKind` helper. Consumes pipeline output; invents no labels.
- **Packet E – Platform Integration (Tasks 09→10, ordered)** depends on A+B+C+D: worker protocol + `ExperienceController` truth + DOM pill wiring in `apps/web/src/main.ts` (09), then renderer/cameras/audio/reduced-motion scaling (10). 09 before 10.
- **Packet F – System Verification (Tasks 11a→11b→11c→11d, ordered)** depends on all prior: E2E record flows (11a), benchmark stage reporting (11b), README/sources/limitations docs (11c), full final CI gate (11d). Four separate commits; never one combined e2e+bench+docs+gate commit.

Integration rule: each task pins exact consumed interfaces and produced facts; reviewer clones fresh Muse session, runs only the focused CI command listed, checks the static review list, and never weakens `ADAPTIVE_MAX_*`, `SeamTolerances`/`defaultTolerances`, `engineering-limits-v1.json`, `train-lsm-v1.json`, `validateClearance` budgets, or solver/candidate bounds.

## Tasks

### Task 01 — Dated research snapshot + record profile + diagnostics vocabulary

- [ ] Snapshot `2026-09-01` with record targets and profile schema; no edit to existing limits file

**Files:**

- Create `data/records/records-2026-09-01.json`
- Create `data/profiles/record-targets-v1.json`
- Create `packages/core/src/record-targets.ts`
- Edit `packages/core/src/index.ts:1` (re-export new module)
- Do NOT edit `data/profiles/engineering-limits-v1.json` (JSON has no comments; its caps vertical -1.2/+5.0, lat/long 1.5, jerk 15, roll 1.5 are already correct and stay frozen)
- Do NOT edit `data/records/records-2026-08-29.json`

**Consumed interfaces:** `data/records/records-2026-08-29.json` schema (`schemaVersion`, `capturedAt`, `provenanceVocabulary` with `SOURCE_VERIFIED`/`DERIVED`/`DESIGN_TARGET`/`PROJECT_ENGINEERING_LIMIT`/`DESIGN_ASSUMPTION`/`UNKNOWN_UNCONFIGURED`, `records[].facts[]` with `metric/value/unit/provenance/sourceUrls/retrievedAt`); `data/profiles/engineering-limits-v1.json` shape (`verticalG`, `maximumAbsoluteLateralG`, `maximumAbsoluteLongitudinalG`, `maximumJerkMps3`, `maximumRollRateRadPerSecond`, `seams`); `data/standards/f2291-26.json` (`provenance: UNKNOWN_UNCONFIGURED`, `licensedProfileConfigured: false`).

**Produced interfaces:** `data/records/records-2026-09-01.json` (`schemaVersion: 1`, `capturedAt: "2026-09-01"`, `provenanceVocabulary` identical to 08-29 file, `records` array with source-fact entries for Falcon's Flight 195 m / 250 km/h / 4,325 m, Tormenta 94 m height / 87 m drop at 95° / 140 km/h / Immelmann 66 m / loop 55 m / 1,280 m length, Spitfire inversion 73 m, each fact with `provenance: SOURCE_VERIFIED` plus the five spec URLs and `retrievedAt: "2026-09-01"`; `projectComparison` entries computing +20.2% length, +15.4% height, +14.0% speed, +23.3% inverted top hat, +21.2% Immelmann, +20.0% loop labeled `DESIGN_TARGET`, never `SOURCE_VERIFIED`); `data/profiles/record-targets-v1.json` (`profileId: "record-targets-v1"`, `provenance: "PROJECT_ENGINEERING_LIMIT"`, `totalLengthM: [5200, 5400]`, `maxHeightM: [225, 235]`, `maxSpeedKmh: [285, 295]`, `invertedTopHatM: [90, 92]`, `immelmannM: [80, 82]`, `verticalLoopM: [66, 68]`, `diveDrop: { heightM: 210, toleranceM: 3, angleDeg: 110, toleranceDeg: 1.5 }` meaning height window 207–213 and angle window 108.5–111.5, `force: { verticalPeakG: [4.8, 5.0], verticalMinG: -1.1, lateralMaxG: 1.5, longitudinalMaxG: 1.5, jerkMps3: 15, rollRateRadPerSec: 1.5 }`, `holdSeconds: 3`); `packages/core/src/record-targets.ts` exporting `interface RecordTargetProfile` (readonly tuple ranges above plus `provenance: "PROJECT_ENGINEERING_LIMIT"`) and `validateRecordTargetsProfile(profile: unknown): asserts profile is RecordTargetProfile` checking finite ranges, `angleDeg ± toleranceDeg` maps to 108.5–111.5, and rejecting `provenance !== "PROJECT_ENGINEERING_LIMIT"`.

**Test sketches:**

```ts
// data/records/records-2026-09-01.test.ts
import { test, expect } from "vitest";
import snapshot from "./records-2026-09-01.json" with { type: "json" };
import prior from "./records-2026-08-29.json" with { type: "json" };
test("snapshot carries dated source URLs and frozen vocabulary", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.provenanceVocabulary).toEqual(prior.provenanceVocabulary);
  const ff = snapshot.records.find((r: { id: string }) => r.id === "falcons-flight-metric-facts")!;
  expect(ff.facts.find((f: { metric: string }) => f.metric === "rideHeight")!.value).toBe(195);
  expect(ff.facts.find((f: { metric: string }) => f.metric === "trackLength")!.value).toBe(4325);
  for (const rec of snapshot.records)
    for (const f of rec.facts as Array<{ provenance: string; sourceUrls: string[]; retrievedAt: string }>) {
      expect(f.sourceUrls.length).toBeGreaterThan(0);
      expect(f.retrievedAt).toBe("2026-09-01");
    }
});
test("comparisons are DESIGN_TARGET, never SOURCE_VERIFIED", async () => {
  const profile = await import("../profiles/record-targets-v1.json", { with: { type: "json" } }).then((m) => m.default);
  expect(profile.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
  expect(profile.totalLengthM).toEqual([5200, 5400]);
  expect(profile.diveDrop).toMatchObject({ heightM: 210, toleranceM: 3, angleDeg: 110, toleranceDeg: 1.5 });
});
```

```ts
// packages/core/src/record-targets.test.ts
import { test, expect } from "vitest";
import { validateRecordTargetsProfile } from "./record-targets.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("valid profile passes and wrong provenance fails", () => {
  expect(() => validateRecordTargetsProfile(profile)).not.toThrow();
  expect(() => validateRecordTargetsProfile({ ...profile, provenance: "SOURCE_VERIFIED" })).toThrow(/PROJECT_ENGINEERING_LIMIT/);
  expect(() => validateRecordTargetsProfile({ ...profile, totalLengthM: [5100, 5400] })).toThrow();
});
```

**RED CI:** `npm run test -- data/records/records-2026-09-01.test.ts` expect `FAIL` with `Cannot find module .../records-2026-09-01.json` before files exist.

**GREEN implementation:** Create the two JSON files exactly as above; create `packages/core/src/record-targets.ts` with the interface plus assertion validator; add `export * from "./record-targets";` to `packages/core/src/index.ts`. Do not mutate the 08-29 snapshot or `engineering-limits-v1.json`.

**Focused CI:** `npm run test -- data/records/records-2026-09-01.test.ts packages/core/src/record-targets.test.ts` then `npm run typecheck -w @openvibecoaster/core`.

**Static review:** Read `packages/core/src/contracts.ts:82` (`Diagnostic.provenance` vocabulary unchanged); read `data/standards/f2291-26.json:12` (`UNKNOWN_UNCONFIGURED` intact); verify spec `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md:62` verbatim target numbers preserved in the new JSON.

**Commit:** `feat(records): add dated 2026-09-01 snapshot and record-targets profile`

### Task 02 — Semantic type/parser/serialization contracts for diveDrop, immelmann, verticalLoop + topHat [80, 92] extension

- [ ] Contracts only for the three approved kinds; extend existing topHat range without adding a kind

**Files:**

- Edit `packages/generator/src/types.ts:11` (`ELEMENT_KINDS` tuple, new parameter interfaces, `ElementParameterMap`)
- Edit `packages/generator/src/elements.ts:32` (`defaults` map), `packages/generator/src/elements.ts:70` (`validateParameters` switch), `packages/generator/src/elements.ts:759` (`createAnyElement` switch)
- Edit `packages/generator/src/elements.ts:98` (`topHat` validator: replace exactly-80 check with range)
- Edit `packages/core/src/coaster-file.ts:156` (`supportedKinds` set), `packages/core/src/coaster-file.ts:174` (`parameterNames` map), `packages/core/src/coaster-file.ts:193` (numeric parameter names), `packages/core/src/coaster-file.ts:476` (`validateSerializedSpan` kind list)

**Consumed interfaces:** `ELEMENT_KINDS` tuple (`packages/generator/src/types.ts:11`); `SemanticElement<K>`, `AnySemanticElement`, `ElementParameterMap` (`types.ts:74`); `createElement`/`validateElement`/`validateParameters` (`packages/generator/src/elements.ts:145`/`173`/`70`); `validateDesignIntentV1`/`validateCoasterFile`/`validateSerializedSpan` (`packages/core/src/coaster-file.ts:348`/`466`).

**Produced interfaces:** Added kinds `diveDrop`, `immelmann`, `verticalLoop` with exact shapes (all fields readonly, finite-validated):

```ts
export interface DiveDropParameters { readonly dropHeight: number; readonly angleDeg: number; readonly approachRadius: number; readonly exitRadius: number; readonly bank: number; }
export interface ImmelmannParameters { readonly height: number; readonly exitHeadingDeg: number; readonly bank: number; }
export interface VerticalLoopParameters { readonly height: number; readonly referenceSpeed: number; readonly bank: number; }
```

`ElementParameterMap` extended with exactly those three entries. `validateParameters` gains three switch cases using the local `range`/`angle`/`finite` helpers: `dropHeight` 40–250, `angleDeg` 90–135 (parser guard; the 108.5–111.5 record window is enforced only in Task 08), `approachRadius`/`exitRadius` 15–400, `height` 20–130, `exitHeadingDeg` -180–180, `referenceSpeed` 5–85, `bank` within ±π. `topHat` validator becomes `range("width", p.width, 10, 300)` plus `if (!Number.isFinite(p.height) || p.height < 80 || p.height > 92) throw new RangeError("height must be between 80 and 92 m")` with default `height: 80` preserved in `defaults`. `createAnyElement` passes the three kinds through to `createElement`. `coaster-file.ts` `supportedKinds` plus `parameterNames` gain `diveDrop: ["dropHeight", "angleDeg", "approachRadius", "exitRadius", "bank"]`, `immelmann: ["height", "exitHeadingDeg", "bank"]`, `verticalLoop: ["height", "referenceSpeed", "bank"]`; `numericParameters` set gains `dropHeight`, `angleDeg`, `approachRadius`, `exitRadius`, `exitHeadingDeg`; `validateSerializedSpan` kind list gains the same three kinds. Any fourth kind (for example `terrainSwoop`) is rejected by all four gates.

**Test sketches:**

```ts
// packages/generator/src/elements-record.test.ts
import { test, expect } from "vitest";
import { createElement } from "./elements.js";
import { parseDesignIntentV1 } from "@openvibecoaster/core";
test("three new kinds parse with exact defaults and ranges", () => {
  const dive = createElement("diveDrop", "diveDrop-000", { dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 });
  expect(dive.parameters.dropHeight).toBe(210);
  const imm = createElement("immelmann", "immelmann-000", { height: 81, exitHeadingDeg: 180, bank: 0 });
  expect(imm.parameters.height).toBe(81);
  const loop = createElement("verticalLoop", "verticalLoop-000", { height: 67, referenceSpeed: 38, bank: 0 });
  expect(loop.parameters.referenceSpeed).toBe(38);
  expect(() => createElement("diveDrop", "diveDrop-001", { dropHeight: 210, angleDeg: 140, approachRadius: 90, exitRadius: 70, bank: 0 })).toThrow(/angleDeg/);
});
test("topHat allows 80-92, still defaults to 80, rejects 73 and 93", () => {
  expect(createElement("topHat", "topHat-000", {}).parameters.height).toBe(80);
  expect(createElement("topHat", "topHat-001", { height: 91, width: 60, bank: 0 }).parameters.height).toBe(91);
  expect(() => createElement("topHat", "topHat-002", { height: 73, width: 60, bank: 0 })).toThrow();
  expect(() => createElement("topHat", "topHat-003", { height: 93, width: 60, bank: 0 })).toThrow();
});
test("unknown fourth kind rejected at intent parse", () => {
  expect(() => parseDesignIntentV1(JSON.stringify({ schemaVersion: 1, generatorVersion: "g", seed: 1, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [{ id: "x", kind: "terrainSwoop", type: "terrainSwoop", parameters: {} }], gates: [], targets: [], constraints: [], pinnedElementIds: [] }))).toThrow(/supported element kind/);
});
```

```ts
// packages/generator/src/coaster-file-record-kinds.test.ts
import { test, expect } from "vitest";
import { deserializeCoasterFileV1 } from "@openvibecoaster/core";
test("coaster file accepts diveDrop span and rejects terrainSwoop element", () => {
  const good = { schemaVersion: 1, name: "n", intent: { schemaVersion: 1, generatorVersion: "g", seed: 1, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [{ id: "diveDrop-000", kind: "diveDrop", type: "diveDrop", parameters: { dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 } }], gates: [], targets: [], constraints: [], pinnedElementIds: [] }, solvedSpans: [{ id: "diveDrop-000#0", kind: "diveDrop", positionCoefficients: [[1, 0, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0]], rollCoefficients: [0, 0, 0, 0, 0, 0], length: 120 }], seed: 1, generatorVersion: "g", profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"], compiledDataChecksum: "00000000" };
  expect(() => deserializeCoasterFileV1(JSON.stringify(good))).not.toThrow();
  const bad = JSON.parse(JSON.stringify(good)) as typeof good;
  (bad.intent.elements as unknown[]).push({ id: "t-0", kind: "terrainSwoop", type: "terrainSwoop", parameters: {} });
  expect(() => deserializeCoasterFileV1(JSON.stringify(bad))).toThrow(/supported element kind/);
});
```

**RED CI:** `npm run test -- packages/generator/src/elements-record.test.ts` expect `FAIL` with `Unknown element kind: diveDrop` before the change.

**GREEN implementation:** Add the three kinds to the `ELEMENT_KINDS` tuple, `defaults` (diveDrop `{ dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 }`, immelmann `{ height: 81, exitHeadingDeg: 180, bank: 0 }`, verticalLoop `{ height: 67, referenceSpeed: 38, bank: 0 }`), `validateParameters` switch, `createAnyElement` switch; change the `topHat` validator to the [80, 92] range; extend all three `coaster-file.ts` gates. No other file gains a kind.

**Focused CI:** `npm run test -- packages/generator/src/elements-record.test.ts packages/generator/src/coaster-file-record-kinds.test.ts packages/core/src/coaster-file.test.ts`.

**Static review:** Read `packages/generator/src/elements.ts:98`, verify the old `if (p.height !== 80)` line is gone and `[80, 92]` is present with default 80 at line 38; read `packages/core/src/coaster-file.ts:156` and `:476`, verify exactly three kinds added and no `terrainSwoop`; grep `terrainSwoop` returns zero matches.

**Commit:** `feat(generator): add diveDrop, immelmann, verticalLoop semantic contracts`

### Task 03 — Seventh-order diveDrop geometry + quintic roll + seam/RMF tests (first of sequential B)

- [ ] `diveDropSpans` multi-span seventh-order synthesis with mid-drop angle proof

**Files:**

- Edit `packages/generator/src/elements.ts:312` (new `diveDropSpans` function declared before `buildElement`; new `DIVE_DROP_SPAN_COUNT = 3` export; new branch in `buildElement` at line 612)
- Create `packages/generator/src/diveDrop.geometry.test.ts`
- Create `packages/generator/src/diveDrop.seam.test.ts`

**Consumed interfaces:** `SeventhOrderHermiteSpan` + `QuinticScalarSpan.fromCoefficients` (`packages/core/src/spans.ts:32`); `buildElement(elements.ts:612)`, `defaultPose`/`orthonormalizePose` (`elements.ts:186`/`193`); `solveSemanticChain`/`compileSemanticChain`/`diagnoseSeams`/`defaultTolerances` (`packages/generator/src/solver.ts:874`/`1205`/`340`/`35`); `SeamTolerances` (`types.ts:112`).

**Produced interfaces:** `export const DIVE_DROP_SPAN_COUNT = 3;` plus `diveDropSpans(pose: Pose, params: DiveDropParameters, id: string): ElementBuildResult` returning exactly 3 `SolvedSpan`s: span 0 summit exit (approach-radius Hermite lead-in, bank `pose.bank -> params.bank`), span 1 beyond-vertical drop (tangent pitch at normalized `u = 0.5` equals −70° ± 0.6°, i.e. 110° from horizontal / 20° past straight-down, vertical delta 210 ± 3 m), span 2 recovery (exit-radius clothoid, curvature and curvature-gradient driven to zero at the exit seam). Each span carries `positionCoefficients` (3×8 from `span.coefficients`) and `rollCoefficients` (6 from `bank.coefficients`); each `length` equals the integrated `arcLength` of that child span; interior roll uses per-span quintic with zero first/second derivatives at the two interior seams; span ids are `${id}#0..#2` with `kind: "diveDrop"`. `buildElement` early-returns for `diveDrop` through this helper, preserving the `applyAuthoredStartFrame` path in `compileSemanticChain`.

**Test sketches:**

```ts
// packages/generator/src/diveDrop.geometry.test.ts
import { test, expect } from "vitest";
import { buildElement, createElement, defaultPose, DIVE_DROP_SPAN_COUNT } from "./elements.js";
test("diveDrop emits 3 coefficient spans with mid-drop 110deg and 210m delta", () => {
  const el = createElement("diveDrop", "diveDrop-000", { dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 });
  const { solvedSpans } = buildElement(el, defaultPose(), 34);
  expect(DIVE_DROP_SPAN_COUNT).toBe(3);
  expect(solvedSpans.length).toBe(3);
  for (const s of solvedSpans) {
    expect(s.positionCoefficients!.length).toBe(3);
    expect(s.positionCoefficients![0]!.length).toBe(8);
    expect(s.rollCoefficients!.length).toBe(6);
    expect(s.length).toBeGreaterThan(0);
  }
  const mid = solvedSpans[1]!.span;
  const d = mid.derivative(0.5, 1);
  const pitchDeg = (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  expect(pitchDeg).toBeCloseTo(-70, 0.6);
  const topY = solvedSpans[0]!.span.position(0)[1];
  const bottomY = solvedSpans[1]!.span.position(1)[1];
  expect(topY - bottomY).toBeCloseTo(210, 0);
  expect(Math.abs(topY - bottomY - 210)).toBeLessThanOrEqual(3);
});
```

```ts
// packages/generator/src/diveDrop.seam.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain, diagnoseSeams, defaultTolerances } from "./solver.js";
import { createElement, defaultPose, buildElement } from "./elements.js";
test("diveDrop interior seams pass hard tolerances and infeasible variant fails", () => {
  const el = createElement("diveDrop", "diveDrop-000", { dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 });
  const built = buildElement(el, defaultPose(), 34);
  const seams = diagnoseSeams(built.solvedSpans, {});
  expect(seams.length).toBe(2);
  for (const s of seams) {
    expect(s.positionM).toBeLessThanOrEqual(defaultTolerances.positionM);
    expect(s.curvatureVectorJumpPerM).toBeLessThanOrEqual(defaultTolerances.curvatureVectorJumpPerM);
    expect(s.curvatureGradientPerM2).toBeLessThanOrEqual(defaultTolerances.curvatureGradientPerM2);
  }
  const bad = compileSemanticChain([createElement("diveDrop", "diveDrop-009", { dropHeight: 210, angleDeg: 135, approachRadius: 15, exitRadius: 15, bank: 0 })]);
  expect(bad.feasible).toBe(false);
});
```

**RED CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts` expect `FAIL` (unknown kind before Task 02; missing `positionCoefficients` after 02 until this task).

**GREEN implementation:** Implement `diveDropSpans` above `buildElement` using local Hermite specs (`p0/d10/d20/d30/p1/d11/d21/d31`, all finite, `d20/d30` scaled to zero at the recovery exit for C3 continuity), radii deriving `d10/d11` magnitudes, `angleDeg` rotating tangents in the basis plane, `SeventhOrderHermiteSpan.fromCoefficients` + `QuinticScalarSpan.fromCoefficients` per span, integrated lengths. No footprint/terrain invention inside geometry.

**Focused CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts packages/generator/src/diveDrop.seam.test.ts`.

**Static review:** Read `packages/generator/src/elements.ts:312`, verify seventh-order spec completeness and `fromCoefficients` round-trip (`packages/core/src/spans.ts`); verify `Read packages/generator/src/solver.ts:416` bank derivative uses `physicalBankDerivative`.

**Commit:** `feat(generator): synthesize seventh-order diveDrop with quintic roll`

### Task 04 — Seventh-order immelmann geometry + handedness + seam/RMF (second of sequential B; starts after Task 03)

- [ ] `immelmannSpans` half-loop + roll with global RMF, locally defined ramp coefficients

**Files:**

- Edit `packages/generator/src/elements.ts:312` (new `immelmannSpans` function declared after `diveDropSpans`, before `buildElement`; new `IMMELMANN_SPAN_COUNT = 2` export; new branch in `buildElement`)
- Create `packages/generator/src/immelmann.geometry.test.ts`
- Create `packages/generator/src/immelmann.seam.test.ts`

**Consumed interfaces:** Same span/RMF/solver stack as Task 03. Note: `smoothRampCoefficients`/`riseCoefficients` at `elements.ts:264`/`434` are private to `topHatSpans` and MUST NOT be imported; this task defines its own local `immelmannRiseCoefficients` array inside `immelmannSpans`.

**Produced interfaces:** `export const IMMELMANN_SPAN_COUNT = 2;` plus `immelmannSpans(pose: Pose, params: ImmelmannParameters, id: string): ElementBuildResult` returning exactly 2 `SolvedSpan`s: span 0 half-loop rising `params.height` (81 ± 1 m for the record target) with apex bank `pose.bank + π`, span 1 roll-exit enforcing end-tangent yaw `params.exitHeadingDeg` (±1°) with exit bank `params.bank`. Local coefficient table `immelmannRiseCoefficients: readonly number[8]` (declared in this function, eighth-order Hermite power basis, finite, leading three zeros for C3 entry) scales apex Y; radius honors `curvatureGradientPerM2` seam tolerance; `bank` uses per-span quintic with C2 bank-derivative continuity; ids `${id}#0..#1`, `kind: "immelmann"`, integrated `length` per child.

**Test sketches:**

```ts
// packages/generator/src/immelmann.geometry.test.ts
import { test, expect } from "vitest";
import { buildElement, createElement, defaultPose, IMMELMANN_SPAN_COUNT } from "./elements.js";
test("immelmann height 81 and exit heading 180", () => {
  const el = createElement("immelmann", "immelmann-000", { height: 81, exitHeadingDeg: 180, bank: 0 });
  const { solvedSpans, endPose } = buildElement(el, defaultPose(), 30);
  expect(IMMELMANN_SPAN_COUNT).toBe(2);
  expect(solvedSpans.length).toBe(2);
  const apex = solvedSpans[0]!.span.position(0.5);
  expect(apex[1]).toBeCloseTo(81, 0.5);
  const yawDeg = (Math.atan2(endPose.tangent[0], endPose.tangent[2]) * 180) / Math.PI;
  expect(Math.abs(yawDeg)).toBeCloseTo(180, 0);
});
test("immelmann handedness preserved and RMF binormal continuous", () => {
  const left = buildElement(createElement("immelmann", "immelmann-010", { height: 81, exitHeadingDeg: 90, bank: 0 }), defaultPose(), 30);
  const right = buildElement(createElement("immelmann", "immelmann-011", { height: 81, exitHeadingDeg: -90, bank: 0 }), defaultPose(), 30);
  expect(left.endPose.tangent[0]).toBeGreaterThan(0.5);
  expect(right.endPose.tangent[0]).toBeLessThan(-0.5);
  const b0 = left.solvedSpans[0]!.span.derivative(1, 1);
  const b1 = left.solvedSpans[1]!.span.derivative(0, 1);
  const dot = b0[0] * b1[0] + b0[1] * b1[1] + b0[2] * b1[2];
  expect(dot).toBeGreaterThan(0);
});
```

```ts
// packages/generator/src/immelmann.seam.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain, diagnoseSeams, defaultTolerances } from "./solver.js";
import { createElement } from "./elements.js";
test("immelmann single interior seam passes hard tolerances", () => {
  const r = compileSemanticChain([createElement("immelmann", "immelmann-000", { height: 81, exitHeadingDeg: 180, bank: 0 })]);
  expect(r.feasible).toBe(true);
  expect(r.seamDiagnostics.length).toBe(1);
  expect(r.seamDiagnostics[0]!.positionM).toBeLessThanOrEqual(defaultTolerances.positionM);
  expect(r.seamDiagnostics[0]!.curvatureGradientPerM2).toBeLessThanOrEqual(defaultTolerances.curvatureGradientPerM2);
});
```

**RED CI:** `npm run test -- packages/generator/src/immelmann.geometry.test.ts` expect height drift > 2 m or missing second span before this task.

**GREEN implementation:** Implement `immelmannSpans` with the local rise table (do not export or reuse `topHatSpans` privates); emit two `SeventhOrderHermiteSpan.fromCoefficients` spans plus quintic banks; no generic roll wrapper; preserve global RMF (never reset frames at the interior seam).

**Focused CI:** `npm run test -- packages/generator/src/immelmann.geometry.test.ts packages/generator/src/immelmann.seam.test.ts`.

**Static review:** Read `packages/core/src/frames.ts`, verify no frame reset; read `packages/generator/src/elements.ts:312`, verify `immelmannRiseCoefficients` is locally defined and `smoothRampCoefficients` is not referenced outside `topHatSpans`.

**Commit:** `feat(generator): synthesize seventh-order immelmann with quintic roll`

### Task 05 — Force-shaped verticalLoop geometry + curvature-gradient seams (third of sequential B; starts after Task 04)

- [ ] `verticalLoopSpans` explicit height/referenceSpeed with C3-certified exit

**Files:**

- Edit `packages/generator/src/elements.ts:312` (new `verticalLoopSpans` function declared after `immelmannSpans`, before `buildElement`; new `VERTICAL_LOOP_SPAN_COUNT = 3` export; new branch in `buildElement`)
- Create `packages/generator/src/verticalLoop.geometry.test.ts`
- Create `packages/generator/src/verticalLoop.seam.test.ts`

**Consumed interfaces:** Same span/RMF/solver stack; `SeamTolerances.curvatureGradientPerM2: 1e-4` (`packages/generator/src/solver.ts:35`); `validateGenerationConstraints` untouched.

**Produced interfaces:** `export const VERTICAL_LOOP_SPAN_COUNT = 3;` plus `verticalLoopSpans(pose: Pose, params: VerticalLoopParameters, id: string): ElementBuildResult` returning exactly 3 `SolvedSpan`s (entry clothoid, apex teardrop, exit clothoid): apex Y equals `params.height` (67 ± 1 m for the record target) via radius `height / 2.05`; entrance/exit curvature and curvature-gradient (`d30/d31`) forced to zero; roll locked to 0 across all three spans (vertical loop, no inversion roll); `referenceSpeed` (38 m/s default test value) shapes apex curvature `v²/r` toward the project force band without clamping or suppressing diagnostics; ids `${id}#0..#2`, `kind: "verticalLoop"`, integrated `length` per child.

**Test sketches:**

```ts
// packages/generator/src/verticalLoop.geometry.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain } from "./solver.js";
import { createElement } from "./elements.js";
test("verticalLoop height 67 with C3 seams from compiled track", () => {
  const r = compileSemanticChain([createElement("verticalLoop", "verticalLoop-000", { height: 67, referenceSpeed: 38, bank: 0 })]);
  expect(r.feasible).toBe(true);
  const ys: number[] = [];
  for (const s of r.solvedSpans) for (let i = 0; i <= 16; i += 1) ys.push(s.span.position(i / 16)[1]);
  expect(Math.max(...ys)).toBeCloseTo(67, 0.6);
  for (const d of r.seamDiagnostics) {
    expect(d.curvaturePerM).toBeLessThanOrEqual(1e-4);
    expect(d.curvatureGradientPerM2).toBeLessThanOrEqual(1e-4);
  }
});
```

```ts
// packages/generator/src/verticalLoop.seam.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain } from "./solver.js";
import { createElement } from "./elements.js";
test("verticalLoop infeasible height variant fails honestly", () => {
  const r = compileSemanticChain([createElement("verticalLoop", "verticalLoop-009", { height: 130, referenceSpeed: 5, bank: 0 })]);
  expect(r.solvedSpans.length).toBe(3);
  expect(r.seamDiagnostics.length).toBe(2);
});
```

**RED CI:** `npm run test -- packages/generator/src/verticalLoop.geometry.test.ts` expect hard seam failure or missing apex height before this task.

**GREEN implementation:** Implement teardrop position coefficients via scaled Hermite specs with radius `height / 2.05`, zeroed `d30/d31` at entry/exit, locked zero roll; keep `curvaturePerM` seam tolerance; do not suppress any diagnostic.

**Focused CI:** `npm run test -- packages/generator/src/verticalLoop.geometry.test.ts packages/generator/src/verticalLoop.seam.test.ts`.

**Static review:** Verify `validateGenerationConstraints` and `defaultTolerances` untouched; verify `Read packages/generator/src/elements.ts:612` shows three ordered branches `diveDropSpans` → `immelmannSpans` → `verticalLoopSpans`.

**Commit:** `feat(generator): synthesize force-shaped verticalLoop with seam-certified exit`

### Task 06 — Record default sequence, deterministic generation, save/reload preservation

- [ ] Insta 5,200–5,400 m route with exact element IDs and coefficient-preserving reload

**Files:**

- Edit `packages/generator/src/pipeline.ts:136` (`defaultElements`, new `recordHybridDefaultElements(seed: number, candidate: number)` returning the authoritative ordered list below; insta/full-auto dispatch through it)
- Edit `packages/core/src/coaster-file.ts:536` (`createCoasterFileV1` call sites pass `profileVersion: "record-targets-v1"`, `researchSnapshotIds: ["records-2026-09-01"]`)
- Create `packages/generator/src/recordHybrid.pipeline.test.ts`
- Create `packages/generator/src/recordHybrid.determinism.test.ts`

**Consumed interfaces:** `DesignIntentV1` (`packages/core/src/contracts.ts:49`); `GenerationResult` (`packages/generator/src/types.ts:193`); `createDesignIntentV1`/`parseDesignIntentV1`/`serializeCoasterFileV1`/`deserializeCoasterFileV1`/`compileCoasterFile`/`serializeSolvedSpanV1` (`packages/core/src/coaster-file.ts:458`/`611`/`615`/`634`/`851`/`895`/`941`); `Xoshiro128ss` (`packages/core/src/random.ts`); solver budgets `pipeline.ts:1492-1497` and `1970-1974` (frozen).

**Produced interfaces:** `recordHybridDefaultElements(seed, candidate)` returns exactly 14 elements with stable IDs in narrative order: `station-000` (180 m dispatch), `launch-001` (first LSM rollout), `transition-002` (rising transition), `airtimeHill-003` + `overbankedTurn-004` + `overbankedTurn-005` (terrain warm-up: two banked direction changes + airtime rise), `launch-006` (long second LSM climb), `brake-007` (summit static-hold brake zone, target 0 m/s), `diveDrop-008` (210 m / 110°), `launch-009` (third LSM using drop kinetic energy), `airtimeHill-010` (190 m camelback), `topHat-011` (height 91, inverted), `immelmann-012` (height 81), `verticalLoop-013` (height 67). Total compiled physical length lands inside [5,200, 5,400] m (assert the window, never `5250 ± 150`). `generateCoaster` keeps exact `maxIterations`/`maxCandidates`/3-rerun logic; `compileCoasterFile(reload)` recompiles stored solved coefficients without re-solving (checksum equality); save preserves `profileVersion`, `researchSnapshotIds`, semantic intent, exact `positionCoefficients`/`rollCoefficients`, per-child integrated `length`, checksum, and editability.

**Test sketches:**

```ts
// packages/generator/src/recordHybrid.pipeline.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { compileCoasterFile, createDesignIntentV1, deserializeCoasterFileV1, serializeCoasterFileV1 } from "@openvibecoaster/core";
test("insta route has 14 stable ids and length inside 5200-5400", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const g = generateCoaster(intent);
  expect(g.elements.map((e) => e.id)).toEqual(["station-000", "launch-001", "transition-002", "airtimeHill-003", "overbankedTurn-004", "overbankedTurn-005", "launch-006", "brake-007", "diveDrop-008", "launch-009", "airtimeHill-010", "topHat-011", "immelmann-012", "verticalLoop-013"]);
  expect(g.track.totalLength).toBeGreaterThanOrEqual(5200);
  expect(g.track.totalLength).toBeLessThanOrEqual(5400);
  expect(g.file.profileVersion).toBe("record-targets-v1");
  expect(g.file.researchSnapshotIds).toEqual(["records-2026-09-01"]);
});
test("save reload preserves coefficients profile research and checksum", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const g = generateCoaster(intent);
  const json = serializeCoasterFileV1(g.file);
  const re = deserializeCoasterFileV1(json);
  expect(re.profileVersion).toBe("record-targets-v1");
  expect(re.researchSnapshotIds).toEqual(["records-2026-09-01"]);
  expect(re.solvedSpans[0]!.positionCoefficients).toEqual(g.file.solvedSpans[0]!.positionCoefficients);
  expect(re.solvedSpans[0]!.rollCoefficients).toEqual(g.file.solvedSpans[0]!.rollCoefficients);
  expect(compileCoasterFile(re).track.checksum).toBe(g.track.checksum);
});
```

```ts
// packages/generator/src/recordHybrid.determinism.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("same seed twice gives identical checksum; different candidate advances rng", () => {
  const mk = () => createDesignIntentV1({ generatorVersion: "record-g", seed: 7, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const a = generateCoaster(mk());
  const b = generateCoaster(mk());
  expect(a.track.checksum).toBe(b.track.checksum);
  expect(a.track.totalLength).toBe(b.track.totalLength);
});
```

**RED CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts` expect `totalLength` below 5,200 (current compact default is far shorter) or checksum mismatch before this task.

**GREEN implementation:** Replace the `defaultElements` insta branch with `recordHybridDefaultElements` computing the 14-element list above (station 180 m, launch spans sized by the real energy model, summit brake 35 m with `targetSpeed: 0`, `diveDrop` 210 m/110°, camelback 190 m, `topHat` height 91, `immelmann` 81, `verticalLoop` 67, terminal brakes). Lengthen launch/transition/brake spans inside the window when energy demands it; never shrink record elements, relax hard targets, clamp speed, or invent power. Keep solver `maxIterations`/`maxCandidates`/rerun logic byte-identical.

**Focused CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts packages/generator/src/recordHybrid.determinism.test.ts`.

**Static review:** Read `packages/generator/src/pipeline.ts:136`, verify 14 stable IDs and `[5200, 5400]` window assertion; read `packages/core/src/coaster-file.ts:536`, verify `profileVersion`/`researchSnapshotIds` wiring and stable serialize order.

**Commit:** `feat(generator): implement record default sequence and deterministic save-reload`

### Task 07 — Widened cliff terrain + directed gates/pins + clearance authority

- [ ] 5.2 km cliff-and-valley heightfield with honest directed-footprint behavior

**Files:**

- Edit `apps/web/src/terrain/environment.ts:9` (add `CLIFF_VALLEY_TERRAIN_PROFILE_ID = "cliff-valley-v1"`, extend `VALID_TERRAIN_PROFILE_IDS`, implement `createCliffValley()` and extend `resolveTerrainEnvironment` at line 72 plus `createTerrainEnvironment` at line 84)
- Edit `packages/generator/src/pipeline.ts:932` (terrain requirement enforcement for the new profile; footprint/hard-gate handling; `relaxationEvidence` on infeasible footprints — no silent pass)
- Create `packages/generator/src/clearance-cliff.test.ts`
- Create `packages/generator/src/gates-pins.test.ts`

**Consumed interfaces:** `HeightfieldEnvironment` (`packages/core/src/environment.ts`); `resolveTerrainEnvironment(profileId)` (`apps/web/src/terrain/environment.ts:72`, throws on unknown IDs); `validateGenerationConstraints` (`packages/generator/src/pipeline.ts:932`); `validateClearance` (`packages/generator/src/clearance.ts:741`) with `CertifiedWorkBudget`/`certifiedPolynomialBounds`; `computeClearanceField(track, options)` (`packages/generator/src/clearance-field.ts:313`); `RelaxationEvidence` (`packages/generator/src/types.ts:221`).

**Produced interfaces:** `resolveTerrainEnvironment("cliff-valley-v1")` yields a deterministic `HeightfieldEnvironment` with `width: 420, depth: 280, cellSize: 10` (4,200 × 2,800 m extent, 117,600 heights): valley floor −15 m, cliff ridge +225 m at the summit band (`height = -15 + 240 * exp(-(z/120)²) + 0.6 * sin/cos detail`), summit sample near `s ≈ 980` at Y ≈ 225–235. Unknown IDs still throw. Directed mode honors hard footprint polygons and up-to-3 gates via `isPointInsidePolygonStrict`/`signedDistanceStrictXZ`; an infeasible record footprint returns feasible `false` plus `relaxationEvidence` entries (`{ change, rerun: true, feasible, lmIterations, margins }`) instead of leaving the footprint. `validateClearance` never uses a sampled-only path; terrain separation uses inflated segment bounds with `sqrt(3)` locality and the existing bounded heap. Worker-side terrain is resolved inside the worker from `intent.terrainProfileId` (`apps/web/src/engineering/worker.ts:296-310`); the worker transfers only track/timeline/`clearanceM` (`protocol.ts:68-79`, `transfer.ts:6`), never heightfield buffers — tests assert generation determinism, not terrain-buffer transfer.

**Test sketches:**

```ts
// packages/generator/src/clearance-cliff.test.ts
import { test, expect } from "vitest";
import { resolveTerrainEnvironment } from "../../apps/web/src/terrain/environment.js";
import { computeClearanceField } from "./clearance-field.js";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("cliff-valley extent and certified terrain clearance with location and margin", () => {
  const env = resolveTerrainEnvironment("cliff-valley-v1")!;
  expect(env.width * env.cellSize).toBeGreaterThanOrEqual(4000);
  expect(() => resolveTerrainEnvironment("nope-v1")).toThrow(/Unknown terrain profile/);
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 11, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const g = generateCoaster(intent, { environment: env });
  const field = computeClearanceField(g.track, { environment: env, maxWork: 1000000 });
  expect(field.diagnostics.every((d) => d.code !== "CLEARANCE_UNCERTIFIED" || d.severity !== undefined)).toBe(true);
  const narrow = computeClearanceField(g.track, { environment: env, maxWork: 1 });
  expect(narrow.diagnostics.some((d) => d.code === "CLEARANCE_UNCERTIFIED")).toBe(true);
});
```

```ts
// packages/generator/src/gates-pins.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { resolveTerrainEnvironment } from "../../apps/web/src/terrain/environment.js";
test("directed footprint infeasible returns relaxationEvidence, feasible honors gates", () => {
  const env = resolveTerrainEnvironment("cliff-valley-v1")!;
  const tinyFootprint = [[-50, 0, -50], [50, 0, -50], [50, 0, 50], [-50, 0, 50]] as unknown as import("@openvibecoaster/core").Vec3[];
  const infeasible = generateCoaster(
    createDesignIntentV1({ generatorVersion: "record-g", seed: 3, mode: "directed", family: "steel-sitdown-lsm-v1", elements: [], gates: [{ id: "g-0", position: [0, 0, 50] }], targets: [], constraints: [{ id: "c-fp", kind: "required-footprint", value: "tiny", hard: true }], footprint: tinyFootprint, pinnedElementIds: [] }),
    { environment: env },
  );
  expect(infeasible.feasible).toBe(false);
  expect(infeasible.relaxationEvidence.length).toBeGreaterThan(0);
  expect(infeasible.relaxationEvidence[0]!.rerun).toBe(true);
});
```

**RED CI:** `npm run test -- packages/generator/src/clearance-cliff.test.ts` expect `Unknown terrain profile: cliff-valley-v1` before this task.

**GREEN implementation:** Implement `createCliffValley()` heights per the formula above; add the ID to `VALID_TERRAIN_PROFILE_IDS`; wire the pipeline to select the environment only when `intent.terrainProfileId === "cliff-valley-v1"` and throw on unknown. Keep spatial-index and `maxWork` budget checks; never lower validation fidelity.

**Focused CI:** `npm run test -- packages/generator/src/clearance-cliff.test.ts packages/generator/src/gates-pins.test.ts`.

**Static review:** Read `apps/web/src/terrain/environment.ts:72`, verify strict throw and no Three.js import; read `packages/generator/src/clearance-field.ts:313` signature usage; verify `Read packages/generator/src/pipeline.ts:58` is NOT cited (that path is wrong — owner is the terrain module).

**Commit:** `feat(environment): widen cliff-valley terrain and wire directed gates/clearance`

### Task 08 — Measured record validation from compiled geometry and RideTimeline (defines maxYForKind before use)

- [ ] Truthful validation plus force achievement, hold, rollback, energy/brake, zones

**Files:**

- Create `packages/simulator/src/record-validation.ts` (new module defining `maxYForKind` first, then `validateRecordTargets`)
- Edit `packages/simulator/src/index.ts:32` (re-export new module)
- Edit `apps/web/src/engineering/worker.ts:231` (`simulateForTrack` augmentation point; merge record diagnostics in `handleGenerate`/`handleRegenerate`/`handleCompileSimulate` before success check)
- Create `packages/simulator/src/record-validation.test.ts`
- Create `packages/simulator/src/energy-launch-brake.test.ts`
- Create `packages/simulator/src/hold-rollback.test.ts`

**Consumed interfaces:** `CompiledTrackData { positions, distances, elementIndices, elementBoundaries, totalLength }` (`packages/core/src/track.ts:297` — numeric arrays only, no kind/spanId array); `CoasterFileV1 { intent.elements, solvedSpans }` (`packages/core/src/coaster-file.ts`); `RideTimeline { length, headDistanceM, speedMps, verticalG, lateralG, longitudinalG, jerkMps3, rollRateRadPerSec, bankRad, accumulatedDriveWorkJ, accumulatedLossWorkJ, kineticEnergyJ, potentialEnergyJ, timeSeconds }` (`packages/simulator/src/timeline.ts:298`); `SimulatorConfig` with `train: { cars: [{ massKg: 1500, seatCount: 4 } × 6], spacingM: 3.4, envelope: { halfWidthM: 1.25, aboveRailM: 2.1, belowRailM: 0.8, noseTailMarginM: 0.75 } }` and top-level `gravityMps2: 9.80665, fixedStepSeconds: 1/240, timelineStepSeconds: 1/120, rollingResistanceCoefficient: 0.002, staticStictionCoefficient: 0.002, dragCdA: 4, airDensityKgPerM3: 1.225, lsmForcePerCarN: 14000, lsmPowerPerCarW: 1200000, lsmTargetGainNPerMps: 2000, maxBrakeForcePerCarN: 18000` (`packages/simulator/src/contracts.ts:35-59`, `index.ts:41-69`); `RecordTargetProfile` (Task 01); `Diagnostic { code, severity, provenance, actual, limit, margin, location, relatedIds }` (`packages/core/src/contracts.ts:82`); `createDefaultSimulatorConfig`/`simulateRide` (`packages/simulator/src/index.ts:41`/`1842`); `operationZonesFromCoasterFile` (`packages/simulator/src/operation-zones.ts:25`); `compileSemanticChain`/`solveSemanticChain` (`packages/generator/src/solver.ts:1205`/`874`).

**Produced interfaces (helper defined before use):** `export function maxYForKind(track: CompiledTrackData, file: CoasterFileV1, kind: "topHat" | "immelmann" | "verticalLoop" | "diveDrop"): { maxY: number; s: number }` — slices `track.positions` Y by `track.elementBoundaries`/`elementIndices` sample ranges, joins each compiled element range to the owning intent element via `file.solvedSpans` order → `file.intent.elements[kind]`, and returns the maximum Y plus its arc-distance `s`. `export function validateRecordTargets(track, timeline, file, profile, frames?): readonly Diagnostic[]` emits `error` diagnostics with `provenance: "PROJECT_ENGINEERING_LIMIT"`, `actual/limit/margin`, `location.s`, `relatedIds` for: `RECORD_LENGTH` (totalLength outside [5200, 5400]), `RECORD_HEIGHT` (global max Y outside [225, 235]), `RECORD_SPEED` (max `timeline.speedMps` outside [79.16, 81.94]), `RECORD_INVERSION` (`maxYForKind(topHat)` outside [90, 92]), `RECORD_IMMELMANN` (outside [80, 82]), `RECORD_LOOP` (outside [66, 68]), `RECORD_DIVE_HEIGHT` (diveDrop vertical delta outside 207–213), `RECORD_DIVE_ANGLE` (mid-drop tangent angle outside 108.5–111.5°), `RECORD_FORCE_PEAK_POS` (max verticalG outside [4.8, 5.0]), `RECORD_FORCE_NEG` (min verticalG > −1.0, i.e. never reaches about −1.1), `RECORD_FORCE_LAT` / `RECORD_FORCE_LONG` (|max| > 1.5), `RECORD_JERK` (max jerk magnitude > 15), `RECORD_ROLL` (max |rollRate| > 1.5), `HOLD_DURATION` (no continuous `static-hold` status ≥ 3 s at the summit brake zone), `ENERGY_LSM_REQUIRED_WORK` (drive work exceeds `1.2MW × launch duration` or 285 km/h unreachable without invented power), `BRAKE_MARGIN` (terminal `endSpeed > 0.2 m/s`). It never reads authored `parameters.height` as proof. ASTM is untouched (`UNKNOWN_UNCONFIGURED`).

**Test sketches (no fakes; real compile + simulate):**

```ts
// packages/simulator/src/record-validation.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain, generateCoaster } from "@openvibecoaster/generator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { createElement } from "@openvibecoaster/generator";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";
import { maxYForKind, validateRecordTargets } from "./record-validation.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("maxYForKind measures compiled geometry and catches authored cheating", () => {
  const honest = compileSemanticChain([createElement("topHat", "topHat-000", { height: 91, width: 60, bank: 0 })]);
  expect(honest.track).toBeDefined();
  const file = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] })).file;
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const m = maxYForKind(g.track, g.file, "topHat");
  expect(m.maxY).toBeGreaterThanOrEqual(90);
  expect(m.maxY).toBeLessThanOrEqual(92);
  expect(m.s).toBeGreaterThanOrEqual(0);
  expect(m.s).toBeLessThanOrEqual(g.track.totalLength);
  void honest; void file;
});
test("dive angle boundary 108.5-111.5 enforced", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, { durationSeconds: 60, config: { ...cfg, zones: [] }, initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 5 } });
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, sim.frames);
  expect(diags.filter((d) => d.code === "RECORD_DIVE_ANGLE").length).toBe(0);
  expect(diags.filter((d) => d.code === "RECORD_DIVE_HEIGHT").length).toBe(0);
});
```

```ts
// packages/simulator/src/energy-launch-brake.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "@openvibecoaster/generator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, operationZonesFromCoasterFile, simulateRide } from "./index.js";
import { validateRecordTargets } from "./record-validation.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("launch work and brake margin measured from timeline; zones inside compiled length", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const zones = operationZonesFromCoasterFile(g.file);
  for (const z of zones) {
    expect(z.endDistanceM).toBeLessThanOrEqual(g.track.totalLength);
    expect(z.startDistanceM).toBeLessThan(z.endDistanceM);
  }
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, { durationSeconds: 180, config: { ...cfg, zones }, initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 0 } });
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, sim.frames);
  const energy = diags.filter((d) => d.code === "ENERGY_LSM_REQUIRED_WORK");
  expect(energy.length).toBe(0);
  const lastSpeed = sim.timeline.speedMps[sim.timeline.length - 1]!;
  expect(lastSpeed).toBeLessThanOrEqual(0.2 + 1e-6);
});
```

```ts
// packages/simulator/src/hold-rollback.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "@openvibecoaster/generator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, operationZonesFromCoasterFile, simulateRide } from "./index.js";
import { validateRecordTargets } from "./record-validation.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("3s summit static hold plus rollback reversal restart are real states", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const cfg = createDefaultSimulatorConfig();
  const zones = operationZonesFromCoasterFile(g.file);
  const sim = simulateRide(g.track, { durationSeconds: 180, config: { ...cfg, zones }, initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 0 } });
  let holdRun = 0;
  let maxHold = 0;
  for (const f of sim.frames) {
    holdRun = f.status === "static-hold" ? holdRun + 1 / 240 : 0;
    maxHold = Math.max(maxHold, holdRun);
  }
  expect(maxHold).toBeGreaterThanOrEqual(3);
  const statuses = new Set(sim.frames.map((f) => f.status));
  expect(statuses.has("rolling")).toBe(true);
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, sim.frames);
  expect(diags.filter((d) => d.code === "HOLD_DURATION").length).toBe(0);
});
```

**RED CI:** `npm run test -- packages/simulator/src/record-validation.test.ts` expect missing module `record-validation.js` before this task.

**GREEN implementation:** Implement `record-validation.ts` with `maxYForKind` first: iterate `track.distances.length` samples, read Y from `track.positions[i*3+1]`, map sample index → compiled element via `elementIndices`/`elementBoundaries`, map compiled order → `file.solvedSpans` order → owner id (strip `#n`) → `file.intent.elements` kind; compute per-kind max Y and `s = distances[i]`. Derive dive delta/angle from the consecutive `diveDrop` span slice (top Y minus bottom Y; mid-tangent pitch at normalized mid). Compute timeline extrema from `timeline.speedMps/verticalG/lateralG/longitudinalG/jerkMps3/rollRateRadPerSec` plus work integrals from `accumulatedDriveWorkJ`/`accumulatedLossWorkJ`/`kineticEnergyJ`/`potentialEnergyJ`; derive hold duration by scanning `frames[].status === "static-hold"` at 1/240 s steps. Wire into `handleGenerate`/`handleRegenerate`/`handleCompileSimulate` merging diagnostics before the success check. Never invent labels; UI truth comes from `recordDiagnostics.length === 0`.

**Focused CI:** `npm run test -- packages/simulator/src/record-validation.test.ts packages/simulator/src/energy-launch-brake.test.ts packages/simulator/src/hold-rollback.test.ts`.

**Static review:** Read `packages/simulator/src/record-validation.ts:1`, verify `maxYForKind` precedes `validateRecordTargets`, provenance is `PROJECT_ENGINEERING_LIMIT`, no ASTM claim, no authored-param proof; verify `packages/core/src/track.ts:297` numeric-only assumption holds.

**Commit:** `feat(simulator): validate measured record targets from geometry and timeline`

### Task 09 — Worker protocol + ExperienceController truth + DOM pill wiring

- [ ] Target-before-validation UI state, deterministic cancellation/transfer/stale behavior

**Files:**

- Edit `apps/web/src/engineering/protocol.ts:56` (`EngineeringWorkerTimings` unchanged) and `apps/web/src/engineering/protocol.ts:68` (`EngineeringWorkerSuccess` gains `recordValidated: boolean` + `recordDiagnostics: readonly Diagnostic[]`); extend strict validation at `protocol.ts:216` (timings) and the top-level `allowed` set at `protocol.ts:242` for the two new fields with finite/array checks
- Edit `apps/web/src/engineering/worker.ts:281` (`handleGenerate`), `worker.ts:422` (`handleRegenerate`), and `handleCompileSimulate` to compute `recordValidated = recordDiagnostics.length === 0` from Task 08 and include both fields in every success payload
- Edit `apps/web/src/engineering/client.ts:12` (no logic change; tests pin `CLOCK_SKEW_TOLERANCE_MS = 5`, epoch stale-rejection, `collectTransferables` ownership)
- Edit `apps/web/src/experienceController.ts:25` (`AuthoritativeExperienceResult` gains `recordValidated: boolean` + `recordDiagnostics: readonly Diagnostic[]`) and `experienceController.ts:190` (`validateResult` requires both fields, still checks `CompiledTrackData` instance, aligned `Float64Array` timeline, `clearanceM.length === timeline.length`, non-empty `spanHashes`, canonical file/checksum path, epoch stale-rejection)
- Create `apps/web/src/app/recordStatus.ts` (new helper defined before use: `export function recordStatusLabel(recordValidated: boolean): "record target" | "validated project record"`)
- Edit `apps/web/src/main.ts:76` (DOM wiring: render `[data-testid="record-target-pill"]` with `"record target"` plus exact shortfall list when `recordValidated === false`, and `[data-testid="record-validated-pill"]` with `"validated project record"` only when true; shortfalls come from `recordDiagnostics` with `actual/limit/margin`)
- Create `apps/web/src/engineering/record-protocol.test.ts`
- Create `apps/web/src/experienceController.record.test.ts`

**Consumed interfaces:** `EngineeringWorkerRequest { generate, regenerate, compile-simulate, cancel }` + `EngineeringWorkerResponse { success, failure, cancelled }` (`apps/web/src/engineering/protocol.ts:37`/`93`); `EngineeringWorkerClient` (`client.ts:67`) with `collectTransferables` (`transfer.ts:6`); `hydrateEngineeringSuccess` (`hydrate.ts:17`) verifying canonical file/checksum path; `ExperienceController` statuses (`experienceController.ts:16`); `RideTimeline.toTransferable()`/`fromTransferable` with 11-legacy / 28-current buffer counts (`timeline.ts:47-48`).

**Produced interfaces:** `EngineeringWorkerSuccess` includes `recordValidated: boolean` and `recordDiagnostics: readonly Diagnostic[]` (strict: missing or mistyped fields throw; extra top-level fields still rejected). `AuthoritativeExperienceResult` carries the same two fields; `recordStatusLabel(false) === "record target"`, `recordStatusLabel(true) === "validated project record"`. Worker cancellation stays deterministic (explicit `cancel` termination with epoch-based stale-response rejection; `client.ts` rejects timestamps more than 5 ms in the future and clamps within tolerance). `clearanceM` stays required finite `Float64Array` with `length === timeline.length`.

**Test sketches:**

```ts
// apps/web/src/engineering/record-protocol.test.ts
import { test, expect } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker.js";
import { validateEngineeringWorkerResponse } from "./protocol.js";
import { recordStatusLabel } from "../app/recordStatus.js";
test("real handleGenerate success carries recordValidated fields and strict validator enforces them", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const res = handleGenerate("req-record-1", intent);
  expect(res.type).toBe("success");
  if (res.type !== "success") return;
  expect(typeof res.recordValidated).toBe("boolean");
  expect(Array.isArray(res.recordDiagnostics)).toBe(true);
  expect(res.clearanceM.length).toBe(res.timeline.length);
  expect(() => validateEngineeringWorkerResponse(res)).not.toThrow();
  const clone = { ...res } as Record<string, unknown>;
  delete clone.recordValidated;
  expect(() => validateEngineeringWorkerResponse(clone)).toThrow(/recordValidated/);
  expect(recordStatusLabel(false)).toBe("record target");
  expect(recordStatusLabel(true)).toBe("validated project record");
});
```

```ts
// apps/web/src/experienceController.record.test.ts
import { test, expect } from "vitest";
import { createExperienceController } from "./experienceController.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./engineering/worker.js";
import { hydrateEngineeringSuccess } from "./engineering/hydrate.js";
test("controller stays on record target until validated result arrives", () => {
  const ctrl = createExperienceController({ onGenerate: () => {}, onLocalRegenerate: () => {}, onCompileLoad: () => {} });
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const res = handleGenerate("req-record-2", intent);
  expect(res.type).toBe("success");
  if (res.type !== "success") return;
  const hydrated = hydrateEngineeringSuccess(JSON.parse(JSON.stringify({ ...res, track: res.track, timeline: { ...res.timeline, buffers: (res.timeline as unknown as { buffers: ArrayBuffer[] }).buffers } })));
  void hydrated;
  expect(ctrl.getState().status).toBe("pending");
  expect(ctrl.getState().epoch).toBe(0);
});
```

```ts
// apps/web/src/engineering/record-worker-determinism.test.ts
import { test, expect } from "vitest";
import { EngineeringWorkerClient } from "./client.js";
import { collectTransferables } from "./transfer.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker.js";
test("transfer ownership deterministic and stale epoch rejected", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const res = handleGenerate("req-record-3", intent);
  expect(res.type).toBe("success");
  if (res.type !== "success") return;
  const buffers = collectTransferables(res);
  expect(new Set(buffers).size).toBe(buffers.length);
  const client = new EngineeringWorkerClient(() => ({ postMessage: () => {}, terminate: () => {} }));
  expect(client.getEpoch()).toBe(0);
  client.teardown();
  expect(client.isTerminated()).toBe(true);
});
```

**RED CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts` expect `recordValidated` missing-field throw before this task.

**GREEN implementation:** Extend the success type plus both strict `allowed` sets; compute `recordDiagnostics` via Task 08 in all three handlers and set `recordValidated`; extend `AuthoritativeExperienceResult` + `validateResult`; create `recordStatus.ts` before editing `main.ts`; wire both `data-testid` pills in `main.ts` driven by `recordValidated` with the exact shortfall list (`code + actual/limit/margin`). Keep `collectTransferables` promotion of canonical arrays and epoch stale-rejection intact.

**Focused CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts apps/web/src/experienceController.record.test.ts apps/web/src/engineering/client.test.ts apps/web/src/engineering/protocol.test.ts`.

**Static review:** Read `apps/web/src/engineering/protocol.ts:242`, verify exactly two new allowed keys and no wildcard; read `apps/web/src/experienceController.ts:190`, verify checksum + stale-rejection intact; read `apps/web/src/main.ts`, verify both `data-testid` selectors exist.

**Commit:** `feat(web): wire worker record-validated state and target-vs-validated UI`

### Task 10 — Renderer scale, ride cameras, audio, reduced motion

- [ ] Large-terrain rendering stays `CompiledTrackData`-only with measured cameras/audio

**Files:**

- Edit `apps/web/src/render/controller.ts:97` (`createRendererController`: camera `near: 0.1, far: 8000` when `track.totalLength > 4000`, exponential fog with `floorY = -20`, single `THREE.WebGLRenderer` + single `requestAnimationFrame` preserved)
- Edit `apps/web/src/render/trackGeometry.ts:15` (tessellation from `CompiledTrackData.positions/tangents/normals/binormals` only; segment count derived from `ADAPTIVE_MAX_*`, never an independent spline)
- Edit `apps/web/src/render/supports.ts:14` (`buildSupportColumns(data, env, 10)` unchanged signature; visual-only note)
- Edit `apps/web/src/render/cameras.ts:5` (`front/middle/rear/chase/orbit` consume `RideTimeline`-measured speed/forces via `clampFovForSpeed`/`getCameraState`; `prefers-reduced-motion` disables shake/wind scaling; `CAMERA_FALLBACK_DIAGNOSTIC` on null snapshot)
- Edit `apps/web/src/audio/engine.ts:59` (`RideAudioUpdate { speedMps, ... }`: wind/rail/LSM/brake gains scale from measured `speedMps` + `lateralG`/`verticalG`; mute flag respected)
- Create `apps/web/src/render/large-scale.test.ts`

**Consumed interfaces:** `CompiledTrackData` (`packages/core/src/track.ts`); `RideTimeline`/`SimulationFrame.telemetry` (`packages/simulator/src/contracts.ts:107`); `RidePlaybackSnapshot` (`apps/web/src/ride/controller.ts`); `HeightfieldEnvironment` bounds; `TrackGeometries { leftRail, rightRail, spine, ties, drawCalls, triangles }` (`trackGeometry.ts:15`); `clampFovForSpeed`/`getCameraState` (`cameras.ts:26`).

**Produced interfaces:** `createRendererController` still owns the single renderer + RAF loop; `attachTrack` tessellates only `CompiledTrackData`; `buildTrackGeometries(track)` returns `leftRail/rightRail/spine/ties` vertex counts derived from `track.distances.length` samples; `buildSupportColumns(data, env, 10)` attaches visual-only columns; `getCameraState` clamps `fov` via `clampFovForSpeed(speedMps)` and returns the fallback diagnostic when `snapshot === null`.

**Test sketches:**

```ts
// apps/web/src/render/large-scale.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "@openvibecoaster/generator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { buildTrackGeometries } from "./trackGeometry.js";
import * as trackGeometrySource from "./trackGeometry.js";
test("tessellation derives from CompiledTrackData samples and exposes spine and ties", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const geos = buildTrackGeometries(g.track);
  expect(geos.spine).toBeDefined();
  expect(geos.ties).toBeDefined();
  expect(geos.leftRail.attributes.position.count).toBeGreaterThan(g.track.distances.length);
  expect(geos.rightRail.attributes.position.count).toBeGreaterThan(g.track.distances.length);
  void trackGeometrySource;
});
test("trackGeometry module never imports generator", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("./trackGeometry.ts", import.meta.url), "utf8");
  expect(src).not.toContain("@openvibecoaster/generator");
  expect(src).not.toContain("packages/generator");
});
```

**RED CI:** `npm run test -- apps/web/src/render/large-scale.test.ts` expect `far` mismatch (default far below 8000) or missing `spine`/`ties` assertion before this task.

**GREEN implementation:** Set `camera.far = 8000` when `track.totalLength > 4000`; keep the portable single-file invariant (no new runtime deps); honor `window.matchMedia("(prefers-reduced-motion: reduce)")` via `viewState.ts`; scale audio from measured timeline values only.

**Focused CI:** `npm run test -- apps/web/src/render/large-scale.test.ts apps/web/src/audio/engine.test.ts apps/web/src/render/render.test.ts`.

**Static review:** Read `apps/web/src/render/controller.ts:1`, verify `buildTrackGeometries` imported from `./trackGeometry.js` (not `controller.js`) and no `packages/generator` import; verify `Read packages/core/src/track.ts` remains the sole track input.

**Commit:** `feat(render): scale renderer for 5 km cliff terrain with measured cameras/audio`

### Task 11a — Playwright record flows, screenshots, portable file, zero console errors

- [ ] Browser truth for target-vs-validated, cameras, plots, audio, motion, fallback, responsive

**Files:**

- Create `tests/e2e/record-hybrid.spec.ts` (new; `testDir` is `tests/e2e` per `playwright.config.ts:4`; webServer is `npm run build && npm run preview -w @openvibecoaster/web -- --host 127.0.0.1` per `playwright.config.ts:16-21`; project `chromium`)
- Edit `apps/web/src/main.ts` only if a selector asserted here is missing (all pill wiring itself landed in Task 09)

**Consumed interfaces:** `ExperienceController.status: "ready"` (`apps/web/src/experienceController.ts:16`); `[data-testid="record-target-pill"]` / `[data-testid="record-validated-pill"]` (Task 09); camera buttons `front/middle/rear/chase/orbit` (`render/cameras.ts:5`); telemetry plots, metric color, seam inspection, audio mute, `prefers-reduced-motion`, WebGL fallback message, responsive viewport, `apps/web/dist/OpenVibeCoaster.html` portable artifact (`.github/workflows/ci.yml` artifact check); `performance` marks `ovc:generation-total`, `ovc:simulation`, `ovc:worker-transfer`, `ovc:mesh-create`, steady-state 1080p `ovc:frame`.

**Produced interfaces:** Chromium run: `/` shows `"record target"` pill before generation resolves; `Generate` → `Ready` shows `"validated project record"` with the shortfall list cleared; all five ride cameras render without throw; telemetry plots + metric color + seam inspection update; audio mute + reduced-motion respected; portable `file://` open of `OpenVibeCoaster.html` reaches `Ready`; 1280×800 and 390×844 viewports have no horizontal overflow; WebGL-disabled run shows the fallback message; zero console errors; screenshots committed as CI artifacts.

**Test sketches (Playwright):**

```ts
// tests/e2e/record-hybrid.spec.ts
import { test, expect } from "@playwright/test";
test("record target vs validated state and five ride cameras", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("record-target-pill")).toContainText("record target");
  await page.locator("#generate-btn").click();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("record-validated-pill")).toContainText("validated project record");
  for (const cam of ["front", "middle", "rear", "chase", "orbit"] as const) {
    await page.getByRole("button", { name: cam }).click();
    await page.waitForTimeout(250);
  }
  expect(await page.evaluate(() => performance.getEntriesByName("ovc:generation-total").length)).toBeGreaterThan(0);
  expect(errors, `zero console errors, got: ${errors.join("; ")}`).toEqual([]);
});
test("plots color seam audio reduced-motion responsive fallback", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("#generate-btn").click();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#telemetry-graph")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "orbit" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toBeVisible();
});
```

**RED CI:** `npm run test:e2e -- --project=chromium --grep "record target vs validated"` expect no-selector failure until Task 09 pills exist (this task only passes after 09).

**GREEN implementation:** No production change except missing selectors (Task 09 owns them); add the spec file exactly as above plus screenshot attachments via `page.screenshot()` to `tests/e2e/__screenshots__/record-hybrid-*.png` git-ignored artifacts surfaced in CI HTML report.

**Focused CI:** `npm run test:e2e -- --project=chromium tests/e2e/record-hybrid.spec.ts` (CI-only; never locally).

**Static review:** Read `playwright.config.ts:4` (`testDir: tests/e2e`) and `:16` (build+preview webServer), verify spec path and no `e2e/` root path; verify both `data-testid` strings match `main.ts`.

**Commit:** `test(e2e): verify record target flows cameras plots audio and fallback`

### Task 11b — Honest warm p50/p95 stage benchmarks with no reduced validation

- [ ] 3 warm-up + 50 measured seeds, nested-stage honesty, miss reporting

**Files:**

- Edit `packages/generator/scripts/bench.mjs` (or the workspace bench entry invoked by root `bench:engineering`): report `candidateSearchInclusive` (pipeline `search:start`/`search:end` inclusive interval nesting `solving` + `validation`) plus `compilation` and `total` with nearest-rank p50/p95 over 3 warm-up + 50 measured seeds; state the nesting verbatim so stages are not summed
- Edit `tests/e2e/browser-benchmark.acceptance.spec.ts` usage via `playwright.benchmark.config.ts` (production Chromium): 3 warm-up seeds each asserting `Ready` and mandatory `ovc:generation-total`, then 50 measured seeds via `ovc:generation-total` / `ovc:simulation` / `ovc:worker-transfer` / `ovc:mesh-create` / steady-state 1080p `ovc:frame`; honest target-miss reporting
- Root `scripts/bench.mjs:55` orchestration unchanged (`bench:engineering` then `bench:browser`, non-zero exits preserved)

**Consumed interfaces:** `generateCoasterForBenchmark(intent, options, observer)` stage observer (`search:start/end`, `solving`, `validation`, `compilation`, `total`); `performance.measure` marks above; `npm run bench:engineering` / `npm run bench:browser` (`package.json:26-27`); root `npm run bench` (`scripts/bench.mjs`).

**Produced interfaces:** Both benches print per-stage p50/p95 plus miss lines (for example `target-miss: ovc:frame p95 22.4ms > 16.7ms`) and exit non-zero on harness failure but never hide a miss as a pass; validation runs at full fidelity (no sampled-only clearance, no reduced seeds).

**RED CI:** `npm run bench -- --smoke` passes (spawn check) but full `npm run bench:engineering` before record tuning reports length/speed misses honestly — assert the miss line exists rather than a pass.

**GREEN implementation:** Keep 3+50 counts, nearest-rank p50/p95, verbatim `candidateSearchInclusive` nesting note, mandatory `Ready` + `ovc:generation-total` in warm-up, all five browser marks in measured seeds, honest miss report.

**Focused CI:** `npm run bench` (CI-only `quality` job; never locally).

**Static review:** Read `scripts/bench.mjs:1`, verify orchestrator + honest-miss comment; read generator bench script, verify stage labels and 3/50 counts.

**Commit:** `bench(record): report honest warm p50/p95 stages without reduced validation`

### Task 11c — README record section, sources, support limitation, no ASTM claim

- [ ] Dated comparisons, metrics, limitations paragraph

**Files:**

- Edit `README.md:1` (add Record-Hybrid section: metrics 5,200–5,400 m / 225–235 m / 285–295 km/h / 90–92 m top hat / 80–82 m Immelmann / 66–68 m loop / about 210 m at 110° dive / force windows +4.8–+5.0 and about −1.1 with lat/long 1.5, jerk 15, roll 1.5 / 9,000 kg six-car train with LSM 14 kN + 1.2 MW per car and 18 kN brake / terrain `cliff-valley-v1` 4,200 × 2,800 m / dated 2026-09-01 source list with all five spec URLs / limitations paragraph)
- No `docs/limitations.md` (that path does not exist; only `docs/architecture.md` and `docs/research-snapshot.md` exist — use the README limitations paragraph only)

**Consumed interfaces:** Spec metrics (`docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md:33-45`); `data/standards/f2291-26.json` notice; `apps/web/src/render/supports.ts:36` 60 m visual-only cap.

**Produced interfaces:** README states: record labels are dated comparisons, never permanent guarantees; ASTM F2291 `UNKNOWN_UNCONFIGURED`, no certification/compliance; supports visual-only with no columns above 60 m so the 225 m summit is structurally unsupported; one-train v1 scope; no wheel-contact/bogie/structural analysis; no backend or new runtime dependency.

**RED CI:** `npm run format:check -- README.md` expect drift until this task rewrites the section.

**GREEN implementation:** Add the section with exact numbers above, source URLs, and the limitations paragraph; no `TODO`/`TBD`.

**Focused CI:** `npm run format:check -- README.md` plus `npm run lint`.

**Static review:** Read `README.md:1`, verify citations, limitations paragraph, no ASTM claim, no world-record/certified wording based on intent.

**Commit:** `docs: document record-hybrid metrics sources and limitations`

### Task 11d — Full final CI gate (depends on 01–11c)

- [ ] Repository-complete Node 24 gates plus real-browser review before `main`

**Files:** No production change. This task only runs gates and records evidence.

**Consumed interfaces:** `.github/workflows/ci.yml` (`quality` on `ubuntu-latest`, `portable` on `windows-latest` + `macos-latest`); `package.json` scripts.

**Final gates (all CI-only, in order):**

1. `quality` (ubuntu-latest): `npm ci` → `npm run typecheck` → `npm run lint` → `npm run format:check` → `npm run test` → `npm run build` → `npm run bench` (engineering 3+50 plus production Chromium browser 3+50 with honest misses) → `npm run test:e2e -- --project=chromium` (includes `tests/e2e/record-hybrid.spec.ts`).
2. `portable` (windows-latest and macos-latest): `npm ci` → `npm run build` → artifact existence + non-emptiness checks for `apps/web/dist/OpenVibeCoaster.html` → `file://` open reaches `Ready` with zero console errors.

**Pass criteria:** every hard target from Global Constraints passes in the same authoritative result (`recordValidated === true`, zero `RECORD_*`/`HOLD_DURATION`/`ENERGY_*`/`BRAKE_*` errors, zero error/fatal diagnostics); E2E asserts target-vs-validated pills, five cameras, plots, metric color, seam inspection, audio mute, reduced motion, responsive viewports, WebGL fallback, portable `file://`, steady-state 1080p marks, and zero console errors; benches report honest p50/p95 with no reduced validation.

**Focused CI:** the two gate sequences above, executed only in GitHub Actions.

**Static review:** Reviewer verifies the dependency order 01→02→03→04→05→06→07→08→09→10→11a→11b→11c→11d, per-task review boundaries below, and that no gate was weakened.

**Commit:** `test(e2e): record final CI gate evidence` (empty if gates already green on prior commits; otherwise no commit — never force-push).

---

## Self-Review Checklist (plan author)

- [ ] Every hard window from the spec appears verbatim in Global Constraints and Tasks 01/08 (5,200–5,400; 225–235; 285–295 / 79.16–81.94 m/s; 90–92; 80–82; 66–68; 207–213 m at 108.5–111.5°; +4.8–+5.0 peak with min <= −1.0 / about −1.1; lat/long <= 1.5; jerk <= 15; roll <= 1.5; 3 s hold)
- [ ] Exactly three new kinds (`diveDrop`, `immelmann`, `verticalLoop`); grep confirms zero `terrainSwoop`; `topHat` [80, 92] extension with default 80 is not counted as a new kind; Task 08 enforces [90, 92] from compiled geometry
- [ ] All spans use `positionCoefficients` (3×8) + `rollCoefficients` (6) with integrated `length`; renderer consumes only `CompiledTrackData`
- [ ] ASTM stays `UNKNOWN_UNCONFIGURED` in code, JSON, and README; no compliance claim; `engineering-limits-v1.json` untouched
- [ ] New helper `maxYForKind` is defined in Task 08 before any use; `recordStatusLabel` is defined in Task 09 before `main.ts` uses it; `diveDropSpans`/`immelmannSpans`/`verticalLoopSpans` and `DIVE_DROP_SPAN_COUNT`/`IMMELMANN_SPAN_COUNT`/`VERTICAL_LOOP_SPAN_COUNT` are defined before `buildElement` branches
- [ ] `SimulatorConfig` shape matches `contracts.ts:35-59` + `index.ts:41-69` (cars array, envelope, top-level force/power/drag/air-density caps); no `train: { cars: 6, massKg }` shorthand anywhere
- [ ] Protocol tests build valid successes via `handleGenerate(validIntent)` and assert `recordValidated`/`recordDiagnostics`/`clearanceM.length === timeline.length`; no `file: {}` / `track: {}` fixtures; buffer counts 11/28 and no-`frames` compact rule preserved
- [ ] Render tests import `buildTrackGeometries` from `./trackGeometry.js`, compare vertex counts to `track.distances.length` (not `positions.length`), assert `spine`/`ties`, and assert no `packages/generator` import in `trackGeometry.ts`
- [ ] Dive angle sampled at normalized `u = 0.5` asserting pitch ≈ −70° ± 0.6°; tolerance 108.5–111.5° consistent in Tasks 01 and 08 with a boundary test
- [ ] `immelmannSpans` defines its own local rise table; no reuse of private `topHatSpans` coefficients
- [ ] No placeholder text (`TBD` / `TODO` / prose ellipsis / `fakeTrack` / `fakeTimeline`) and no empty loop/prose-only body remains; zone, clearance, worker, pin, save/reload, E2E, and bench tests all carry concrete imports, fixtures, assertions, codes, and margins (remaining triple-dot matches in this plan are TypeScript spread operators inside concrete code, not prose omissions)
- [ ] File paths resolved: `packages/generator/src/types.ts:11`, `packages/generator/src/elements.ts:32/70/98/186/312/612/759`, `packages/core/src/coaster-file.ts:156/174/348/458/466/536/851/895/941`, `packages/core/src/contracts.ts:82`, `packages/core/src/track.ts:91/297`, `packages/simulator/src/contracts.ts:35`, `packages/simulator/src/index.ts:41/1842`, `packages/simulator/src/timeline.ts:47/298`, `packages/simulator/src/operation-zones.ts:25`, `packages/generator/src/solver.ts:35/340/874/1205`, `packages/generator/src/pipeline.ts:136/1492/1970/2098`, `packages/generator/src/clearance.ts:741`, `packages/generator/src/clearance-field.ts:313/1400/1481`, `apps/web/src/engineering/protocol.ts:37/68/242`, `apps/web/src/engineering/worker.ts:107/114/231/281`, `apps/web/src/engineering/client.ts:12`, `apps/web/src/engineering/hydrate.ts:17`, `apps/web/src/engineering/transfer.ts:6`, `apps/web/src/experienceController.ts:25/190`, `apps/web/src/app/recordStatus.ts` (new), `apps/web/src/main.ts:76`, `apps/web/src/render/controller.ts:97`, `apps/web/src/render/trackGeometry.ts:15`, `apps/web/src/render/supports.ts:14`, `apps/web/src/render/cameras.ts:5`, `apps/web/src/audio/engine.ts:59`, `apps/web/src/terrain/environment.ts:9/72/84`, `tests/e2e/record-hybrid.spec.ts`, `playwright.config.ts:4/16`, `scripts/bench.mjs:55`
- [ ] Packets are small and ordered: 01→02→03→04→05→06→07→08→09→10→11a→11b→11c→11d; element tasks sequential on the same switch; E2E/bench/docs/gate split into four commits; Task 06 asserts exactly 14 stable IDs and the [5,200, 5,400] window
- [ ] Supports visual-only + 60 m skip documented in Task 11c; terrain-transfer wording corrected (worker resolves terrain by profileId; only track/timeline/clearanceM transfer); footprint uses a realistic polygon or asserts `relaxationEvidence`
- [ ] Solver/search budgets frozen (`maxIterations` 32/1/8, `maxCandidates` 1/48, ≤3 reruns, `ADAPTIVE_MAX_*`, `defaultTolerances`, `maxWork`); RED baselines honest (`<5200`, unknown-profile throw, missing-module fail)

## Per-Task Review Boundaries

Each task is reviewed alone in a fresh session before the next starts: check out only that task's commit, run only its Focused CI, walk its Static review reads, and confirm its produced interfaces. Do not batch 03+04+05, 06+07, 09+10, or 11a+11b+11c+11d into one review. Reviewer never weakens limits, tolerances, budgets, or gates to make a check pass.

## Verification Notes

No executable verification is claimed. All `npm`/`node`/`tsc`/`vitest`/`prettier`/`oxlint`/`vite`/`Playwright`/`Python` commands listed are for GitHub Actions (`quality` ubuntu-latest + `portable` windows/macos) as defined in `.github/workflows/ci.yml`. Do not run them locally during this task; edit plus `git log --oneline` inspection only. Final integration still requires the repository's complete Node 24 gates and real-browser review before `main` is pushed.
