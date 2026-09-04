# Record-Hybrid Flagship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact default flagship with a deterministic, coefficient-backed 5,200–5,400 m record-hybrid terrain coaster that validates 225–235 m height, 285–295 km/h measured speed, 90–92 m inverted top hat, 80–82 m Immelmann, 66–68 m vertical loop, and about 210 m / 110° held cliff dive through one `DesignIntentV1 -> SolvedSpan[] -> CompiledTrackData -> RideTimeline` authority without weakening constraints, inventing power, or claiming ASTM compliance.

**Architecture:** `DesignIntentV1` + dated snapshot + record profile -> `solveSemanticChain`/`buildElement` (seventh-order Hermite position + quintic roll coefficients) -> `compileTrack` adaptive LUT -> `CompiledTrackData` (sole downstream representation) -> `simulateRide`/`RideTimeline` -> `generateCoaster`/`validateGenerationConstraints`/`validateClearance` -> inline `EngineeringWorker` (`?worker&inline` via `apps/web/src/engineering/factory.ts`, `EngineeringWorkerRequest`/`EngineeringWorkerResponse`, transferable canonical arrays via `collectTransferables`, epoch stale-rejection) -> `ExperienceController` (`apps/web/src/experienceController.ts`) -> Three.js tessellation (no second spline).

**Tech Stack:** Node 24 LTS (Krypton), npm 11.17.0, npm workspaces, TypeScript 7, Vite 8, Three.js (raw, no wrapper), Vitest 4 + fast-check 4, Playwright 1.62, Oxlint 1.80, Prettier 3.9. Single-file `apps/web/dist/OpenVibeCoaster.html` via `apps/web/scripts/portable-packager.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md`

## Global Constraints

- Compiled-geometry hard windows (measured, never authored intent): physical total length 5,200–5,400 m (`track.totalLength`, window asserted with `toBeGreaterThanOrEqual(5200)` / `toBeLessThanOrEqual(5400)`); global route max height 225–235 m (`max(track.positions[Y])` over all samples); timeline-measured max speed 285–295 km/h (79.16–81.94 m/s, `max(timeline.speedMps)`); element-local heights measured as `maxY − minY` inside the owned compiled slice (see `localHeightForKind` in Task 08, never absolute Y): inverted top hat 90–92 m; Immelmann 80–82 m; vertical loop 66–68 m; held cliff dive about 210 m (207–213 m vertical delta `topY − bottomY` over the owned `diveDrop` slice) at 110° (108.5–111.5°) from horizontal (`pitch = atan2(dY, hypot(dX, dZ)) = −70° ± 0.6°` at normalized `u = 0.5` of the middle span).
- Timeline-measured force achievement windows: brief vertical specific-force peak maximum in [+4.8, +5.0] g AND timeline minimum vertical in [-1.2, -1.0] g (achievement target about -1.1 g, hard project floor -1.2 g preserved); lateral magnitude <= 1.5 g; longitudinal magnitude <= 1.5 g; jerk magnitude <= 15 m/s³; roll rate magnitude <= 1.5 rad/s. Existing `engineering-limits-v1.json` caps (vertical -1.2/+5.0, lat/long 1.5, jerk 15, roll 1.5) stay unchanged and are enforced as hard caps by `validateEngineeringLimits`; the new achievement floor (+4.8) and negative-G achievement interval ([-1.2, -1.0] about -1.1) are enforced only by the new `validateRecordTargets` record diagnostics, never by editing `engineering-limits-v1.json`.
- Unchanged train/energy model: six cars × 1,500 kg (9,000 kg total, `seatCount: 4` each), `spacingM: 3.4`, envelope `halfWidthM: 1.25 / aboveRailM: 2.1 / belowRailM: 0.8 / noseTailMarginM: 0.75`; `lsmForcePerCarN: 14000`, `lsmPowerPerCarW: 1200000`, `maxBrakeForcePerCarN: 18000`, `dragCdA: 4.0`, `rollingResistanceCoefficient: 0.002`, `staticStictionCoefficient: 0.002`, `airDensityKgPerM3: 1.225`, `gravityMps2: 9.80665`, `fixedStepSeconds: 1/240` (RK4), `timelineStepSeconds: 1/120`. Per `data/profiles/train-lsm-v1.json` (`DESIGN_ASSUMPTION`).
- Exactly three new semantic kinds: `diveDrop`, `immelmann`, `verticalLoop`. No `terrainSwoop`, no record-specific rendering model, no fourth kind. Existing `topHat` height validation is extended from exactly-80 to the interval [80, 92] (default 80 preserved); this is a range extension, not a new kind. Record [90, 92] is enforced only in Task 08 from compiled geometry.
- Geometry authority: seventh-order Hermite position spans (3×8 `positionCoefficients`, degree 7 power basis `a0..a7` per `packages/core/src/spans.ts:32-94`) + quintic scalar roll spans (6 `rollCoefficients`); one global RMF via `transportFramesAlongPath`/`doubleReflectionFrames` (`packages/core/src/frames.ts:207/269`) with authored bank about the tangent, never reset at seams; no sampled-vertex seam smoothing; every `SerializedSolvedSpanV1.length` is the integrated physical `arcLength(span.span)` of that child — already fixed in base `ad9d5b3` (`pipeline.ts:1569,1730,2123` all do `arcLength(span.span)` unconditionally with `spanLengthCache` reuse in `buildFileResult`; `serializeSolvedSpanV1` at `coaster-file.ts:918-944` trusts the passed physical length). Task 06 documents/tests this invariant (authored `parameters.length` tamper control) and never re-edits serialization; `CompiledTrackData` is the sole downstream representation; rendering tessellates it via `buildTrackGeometries` (`apps/web/src/render/trackGeometry.ts:206`)/`buildSupportColumns` only.
- Simulation authority: signed speed with real `static-hold` / `stall` / `rollback` / `reversal` states (`packages/simulator/src/contracts.ts:135-136`); visual smoothing never alters telemetry; operation zones are half-open `[startDistanceM, endDistanceM)` derived from physical `span.length` cumulative distances (`packages/simulator/src/operation-zones.ts:25-96`, open-station `targetSpeedMps` undefined per `:68-73`) and `endDistanceM` must never exceed `track.totalLength` (`packages/simulator/src/index.ts:495-501`). Worker compact path returns `frames: []` (`simulator/src/index.ts:1620`) and `protocol.ts:334-335` rejects `timeline.frames`; summit-hold proof therefore uses transferable-timeline dwell (`speedMps ≈ 0` + `headDistanceM` dwell inside the summit brake zone at 1/120 s, windowed by the single zone-derived `summitHoldWindow` helper from Task 08 — brake-007 midpoint plus train length, never a hardcoded `980`/`60 m`/`2 m` window) plus minimal numeric `holdSeconds`/`holdLocationS`, never full frames (Task 08/09). The authoritative `hasStalled` latch (`packages/simulator/src/index.ts:2095-2099`) pins every post-stall zero-speed frame to `stall` (first summit stop is `stall` per `statusFor` at `:1153-1154`); full-frame summit evidence therefore accepts latched `stall` dwell and never expects post-stall `static-hold` frames.
- Clearance authority: exact certified clearance via `validateClearance` (`packages/generator/src/clearance.ts:741`) and `computeClearanceField` (`packages/generator/src/clearance-field.ts:327`) with certified Bernstein bounds, `sqrt(3)` directional locality, bounded pair/node heap, `CertifiedWorkBudget`; exhaustion yields `CLEARANCE_UNCERTIFIED`, non-finite yields `NUMERIC_UNCERTIFIED`, never a silent pass.
- ASTM F2291 stays `UNKNOWN_UNCONFIGURED` per `data/standards/f2291-26.json` (`licensedProfileConfigured: false`, empty `criteria`). Never claim certification/compliance; never reproduce copyrighted thresholds. Record labels are `PROJECT_ENGINEERING_LIMIT` / `DESIGN_TARGET`, never `SOURCE_VERIFIED`.
- Supports are visual-only. `buildSupportColumns` (`apps/web/src/render/supports.ts:14`) skips columns with `height > 60` (`supports.ts:36`) and heights `< 0.15`. The 225 m summit is therefore NOT structurally supported; Task 11c documents this limitation in README instead of pretending support.
- Internal SI units; right-handed world axes X right / Y up / Z forward.
- Raw Three.js at the web boundary; no new runtime dependencies/assets/backend/deployment.
- CI-only executable verification; commands run in GitHub Actions, never locally during this task.

All tasks must preserve: pure `packages/core`, `packages/simulator`, `packages/generator` (no Three.js/DOM/WebAudio/mutable app state); hard constraints stay hard; diagnostics carry `actual`/`limit`/`margin`/`location.s` where meaningful; `CompiledTrackData.checksum` canonical path; exact solver/search budgets in `packages/generator/src/pipeline.ts:1500-1505` (`maxIterations`: 32 directed, 1 bare insta with no targets/constraints, 8 otherwise) and `pipeline.ts:1970-1974` (`maxCandidates`: 1 when directed or bare insta, else 48) plus at most 3 relaxation reruns; `ADAPTIVE_MAX_*` (`packages/core/src/track.ts:91-100`); `defaultTolerances` (`packages/generator/src/solver.ts:35`); clearance `maxWork` budgets. Never loosen validation or claim record success from authored intent.

## Branch / Worktree / Packet Order

Branch: `feat/record-hybrid-flagship` (assigned worktree `record-hybrid-design` at `b08c68e`). Workers never merge or push; each task commits inside the worktree.

### Dependency DAG and reviewable packets

- **Packet A – Foundations (Tasks 01–02)** lands first: dated snapshot + record profile + diagnostics vocabulary (01), then semantic type/parser/serialization contracts plus the `topHat` [80, 92] range extension (02). No geometry until A lands.
- **Packet B – Geometry (Tasks 03→04→05, strictly sequential)** depends on A. Tasks 03 (`diveDropSpans`), 04 (`immelmannSpans`), 05 (`verticalLoopSpans`) all touch `packages/generator/src/elements.ts` near line 312 and the `buildElement` switch at line 612, so they MUST land in order 03 then 04 then 05 to avoid same-file switch conflicts. Each defines its own synthesis function and span-count constant; each is reviewed in isolation before the next starts. No cross-element rendering yet.
- **Packet C – Generation Pipeline (Tasks 06→07, ordered)** depends on A+B: record default sequence + deterministic generation + save/reload preservation (06), then cliff/valley terrain + directed gates/pins + clearance authority (07). 06 before 07.
- **Packet D – Validation Authority (Task 08)** depends on A+B+C: measured record validation from compiled geometry and `RideTimeline`, including force achievement, hold/rollback/restart, energy/LSM/brake, zones, and the new `localHeightForKind` helper. Consumes pipeline output; invents no labels.
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
// packages/core/src/record-snapshot.test.ts
import { test, expect } from "vitest";
import snapshot from "../../../data/records/records-2026-09-01.json" with { type: "json" };
import prior from "../../../data/records/records-2026-08-29.json" with { type: "json" };
test("snapshot carries dated source URLs and frozen vocabulary", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.provenanceVocabulary).toEqual(prior.provenanceVocabulary);
  const ff = snapshot.records.find(
    (r: { id: string }) => r.id === "falcons-flight-metric-facts",
  )!;
  expect(
    ff.facts.find((f: { metric: string }) => f.metric === "rideHeight")!.value,
  ).toBe(195);
  expect(
    ff.facts.find((f: { metric: string }) => f.metric === "trackLength")!.value,
  ).toBe(4325);
  for (const rec of snapshot.records)
    for (const f of rec.facts as Array<{
      provenance: string;
      sourceUrls: string[];
      retrievedAt: string;
    }>) {
      expect(f.sourceUrls.length).toBeGreaterThan(0);
      expect(f.retrievedAt).toBe("2026-09-01");
    }
});
test("comparisons are DESIGN_TARGET, never SOURCE_VERIFIED", async () => {
  const profile = await import(
    "../../../data/profiles/record-targets-v1.json",
    { with: { type: "json" } }
  ).then((m) => m.default);
  expect(profile.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
  expect(profile.totalLengthM).toEqual([5200, 5400]);
  expect(profile.diveDrop).toMatchObject({
    heightM: 210,
    toleranceM: 3,
    angleDeg: 110,
    toleranceDeg: 1.5,
  });
});
```

```ts
// packages/core/src/record-targets.test.ts
import { test, expect } from "vitest";
import { validateRecordTargetsProfile } from "./record-targets.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("valid profile passes and wrong provenance fails", () => {
  expect(() => validateRecordTargetsProfile(profile)).not.toThrow();
  expect(() =>
    validateRecordTargetsProfile({ ...profile, provenance: "SOURCE_VERIFIED" }),
  ).toThrow(/PROJECT_ENGINEERING_LIMIT/);
  expect(() =>
    validateRecordTargetsProfile({ ...profile, totalLengthM: [5100, 5400] }),
  ).toThrow();
});
```

**RED CI:** `npm run test -- packages/core/src/record-snapshot.test.ts` expect `FAIL` with `Cannot find module .../records-2026-09-01.json` before files exist.

**GREEN implementation:** Create the two JSON files exactly as above; create `packages/core/src/record-targets.ts` with the interface plus assertion validator; add `export * from "./record-targets";` to `packages/core/src/index.ts`. Do not mutate the 08-29 snapshot or `engineering-limits-v1.json`.

**Focused CI:** `npm run test -- packages/core/src/record-snapshot.test.ts packages/core/src/record-targets.test.ts` then `npm run typecheck -w @openvibecoaster/core`.

**Static review:** Read `packages/core/src/contracts.ts:82` (`Diagnostic.provenance` vocabulary unchanged); read `data/standards/f2291-26.json:12` (`UNKNOWN_UNCONFIGURED` intact); verify spec `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md:62` verbatim target numbers preserved in the new JSON.

**Commit:** `feat(records): add dated 2026-09-01 snapshot and record-targets profile`

### Task 02 — Semantic type/parser/serialization contracts for diveDrop, immelmann, verticalLoop + topHat [80, 92] extension with real geometry threading

- [ ] Contracts only for the three approved kinds; extend existing topHat range AND thread height through real geometry (no validator-only change)

**Files:**

- Edit `packages/generator/src/types.ts:11` (`ELEMENT_KINDS` tuple, new parameter interfaces, `ElementParameterMap`)
- Edit `packages/generator/src/elements.ts:32` (`defaults` map), `packages/generator/src/elements.ts:70` (`validateParameters` switch), `packages/generator/src/elements.ts:792` (`createAnyElement` switch)
- Edit `packages/generator/src/elements.ts:110-116` (`topHat` validator: replace exactly-80 check with range)
- Edit `packages/generator/src/elements.ts:438` (`topHatSpans`: add `height` parameter, scale the 80 m rise table to authored height, apex Y equals authored height)
- Edit `packages/generator/src/elements.ts:624` (`buildElement` `topHat` branch at `:630-632`: pass `p.height` into `topHatSpans`)
- Edit `packages/core/src/coaster-file.ts:156` (`supportedKinds` set), `packages/core/src/coaster-file.ts:174` (`parameterNames` map), `packages/core/src/coaster-file.ts:193` (numeric parameter names), `packages/core/src/coaster-file.ts:489` (`validateSerializedSpan` kind list)
- Create `packages/generator/src/topHat-height.geometry.test.ts` (compiled-apex proof for default 80 m and record 91 m)

**Consumed interfaces:** `ELEMENT_KINDS` tuple (`packages/generator/src/types.ts:11`); `SemanticElement<K>`, `AnySemanticElement`, `ElementParameterMap` (`types.ts:76`/`92`/`98`); `createElement`/`validateElement`/`validateParameters` (`packages/generator/src/elements.ts:157`/`185`/`70`); `validateDesignIntentV1`/`validateCoasterFile`/`validateSerializedSpan` (`packages/core/src/coaster-file.ts:371`/`802`/`489`).

**Produced interfaces:** Added kinds `diveDrop`, `immelmann`, `verticalLoop` with exact shapes (all fields readonly, finite-validated):

```ts
export interface DiveDropParameters {
  readonly dropHeight: number;
  readonly angleDeg: number;
  readonly approachRadius: number;
  readonly exitRadius: number;
  readonly bank: number;
}
export interface ImmelmannParameters {
  readonly height: number;
  readonly exitHeadingDeg: number;
  readonly bank: number;
}
export interface VerticalLoopParameters {
  readonly height: number;
  readonly referenceSpeed: number;
  readonly bank: number;
}
```

`ElementParameterMap` extended with exactly those three entries. `validateParameters` gains three switch cases using the local `range`/`angle`/`finite` helpers (`elements.ts:51-68`; note `range()` appends " m" even for non-length fields — message wording only, no behavior change): `dropHeight` 40–250, `angleDeg` 90–135 (parser guard; the 108.5–111.5 record window is enforced only in Task 08), `approachRadius`/`exitRadius` 15–400, `height` 20–130, `exitHeadingDeg` -180–180, `referenceSpeed` 5–85, `bank` within ±π. `topHat` validator becomes `range("width", p.width, 10, 300)` plus `if (!Number.isFinite(p.height) || p.height < 80 || p.height > 92) throw new RangeError("height must be between 80 and 92 m")` with default `height: 80` preserved in `defaults`. `topHat` remains an existing kind, not a fourth new kind. `topHatSpans(pose, height, width, endBank, elementId)` replaces both hardcoded `80`s at `elements.ts:446-448` and `:462` (`const riseCoefficients = smoothRampCoefficients.map((c) => c * height)` and `const apex = worldPoint(pose, basis, vec3(halfWidth, height, 0))`; the inner `positionCoefficients(origin, verticalCoefficients)` helper at `:449-461` already takes per-row coefficients so scaling `riseCoefficients` scales both rise and fall rows with apex Y equal to `height`); `buildElement` topHat branch at `:630-632` calls `topHatSpans(normalizedPose, p.height, p.width, p.bank, element.id)` so `height: 91` compiles a 91 m local delta and default `height: 80` preserves existing behavior. `createAnyElement` passes the three kinds through to `createElement`. `coaster-file.ts` `supportedKinds` (`:156-167`) plus `parameterNames` (`:174-191`) gain `diveDrop: ["dropHeight", "angleDeg", "approachRadius", "exitRadius", "bank"]`, `immelmann: ["height", "exitHeadingDeg", "bank"]`, `verticalLoop: ["height", "referenceSpeed", "bank"]`; `numericParameters` set (`:193-206`) gains `dropHeight`, `angleDeg`, `approachRadius`, `exitRadius`, `exitHeadingDeg`; `validateSerializedSpan` kind list (`:499-513`) gains the same three kinds. Any fourth kind (for example `terrainSwoop`) is rejected by all four gates.

**Test sketches:**

```ts
// packages/generator/src/elements-record.test.ts
import { test, expect } from "vitest";
import { createElement } from "./elements.js";
import { parseDesignIntentV1 } from "@openvibecoaster/core";
test("three new kinds parse with exact defaults and ranges", () => {
  const dive = createElement("diveDrop", "diveDrop-000", {
    dropHeight: 210,
    angleDeg: 110,
    approachRadius: 90,
    exitRadius: 70,
    bank: 0,
  });
  expect(dive.parameters.dropHeight).toBe(210);
  const imm = createElement("immelmann", "immelmann-000", {
    height: 81,
    exitHeadingDeg: 180,
    bank: 0,
  });
  expect(imm.parameters.height).toBe(81);
  const loop = createElement("verticalLoop", "verticalLoop-000", {
    height: 67,
    referenceSpeed: 38,
    bank: 0,
  });
  expect(loop.parameters.referenceSpeed).toBe(38);
  expect(() =>
    createElement("diveDrop", "diveDrop-001", {
      dropHeight: 210,
      angleDeg: 140,
      approachRadius: 90,
      exitRadius: 70,
      bank: 0,
    }),
  ).toThrow(/angleDeg/);
});
test("topHat allows 80-92, still defaults to 80, rejects 73 and 93", () => {
  expect(createElement("topHat", "topHat-000", {}).parameters.height).toBe(80);
  expect(
    createElement("topHat", "topHat-001", { height: 91, width: 60, bank: 0 })
      .parameters.height,
  ).toBe(91);
  expect(() =>
    createElement("topHat", "topHat-002", { height: 73, width: 60, bank: 0 }),
  ).toThrow();
  expect(() =>
    createElement("topHat", "topHat-003", { height: 93, width: 60, bank: 0 }),
  ).toThrow();
});
test("unknown fourth kind rejected at intent parse", () => {
  expect(() =>
    parseDesignIntentV1(
      JSON.stringify({
        schemaVersion: 1,
        generatorVersion: "g",
        seed: 1,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [
          {
            id: "x",
            kind: "terrainSwoop",
            type: "terrainSwoop",
            parameters: {},
          },
        ],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      }),
    ),
  ).toThrow(/supported element kind/);
});
```

```ts
// packages/generator/src/coaster-file-record-kinds.test.ts
import { test, expect } from "vitest";
import { deserializeCoasterFileV1 } from "@openvibecoaster/core";
test("coaster file accepts diveDrop span and rejects terrainSwoop element", () => {
  const good = {
    schemaVersion: 1,
    name: "n",
    intent: {
      schemaVersion: 1,
      generatorVersion: "g",
      seed: 1,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "diveDrop-000",
          kind: "diveDrop",
          type: "diveDrop",
          parameters: {
            dropHeight: 210,
            angleDeg: 110,
            approachRadius: 90,
            exitRadius: 70,
            bank: 0,
          },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    },
    solvedSpans: [
      {
        id: "diveDrop-000#0",
        kind: "diveDrop",
        positionCoefficients: [
          [1, 0, 0, 0, 0, 0, 0, 0],
          [2, 0, 0, 0, 0, 0, 0, 0],
          [3, 0, 0, 0, 0, 0, 0, 0],
        ],
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 120,
      },
    ],
    seed: 1,
    generatorVersion: "g",
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
    compiledDataChecksum: "00000000",
  };
  expect(() => deserializeCoasterFileV1(JSON.stringify(good))).not.toThrow();
  const bad = JSON.parse(JSON.stringify(good)) as typeof good;
  (bad.intent.elements as unknown[]).push({
    id: "t-0",
    kind: "terrainSwoop",
    type: "terrainSwoop",
    parameters: {},
  });
  expect(() => deserializeCoasterFileV1(JSON.stringify(bad))).toThrow(
    /supported element kind/,
  );
});
```

```ts
// packages/generator/src/topHat-height.geometry.test.ts
// Element-local height: lone topHat built from defaultPose() (Y=0) sits near Y≈0,
// so local delta == absolute apex here. On the 20-element route the same delta
// is measured via localHeightForKind (Task 08), never absolute Y.
import { test, expect } from "vitest";
import { buildElement, createElement, defaultPose } from "./elements.js";
import { compileSemanticChain } from "./solver.js";
test("topHat default 80 compiles an 80 m local delta on the compiled track (existing behavior preserved)", () => {
  const el = createElement("topHat", "topHat-000", {});
  expect(el.parameters.height).toBe(80);
  const r = compileSemanticChain([el]);
  expect(r.feasible).toBe(true);
  const positions = r.track!.positions;
  const distances = r.track!.distances;
  expect(distances.length).toBeGreaterThan(0);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < distances.length; i += 1) {
    const y = positions[i * 3 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  expect(Math.abs(maxY - minY - 80)).toBeLessThanOrEqual(1);
});
test("topHat height 91 threads through geometry to a 91 m compiled local delta", () => {
  const el = createElement("topHat", "topHat-011", {
    height: 91,
    width: 60,
    bank: 0,
  });
  const built = buildElement(el, defaultPose(), 34);
  expect(built.solvedSpans.length).toBe(2);
  const r = compileSemanticChain([el]);
  expect(r.feasible).toBe(true);
  const positions = r.track!.positions;
  const distances = r.track!.distances;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < distances.length; i += 1) {
    const y = positions[i * 3 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  expect(Math.abs(maxY - minY - 91)).toBeLessThanOrEqual(1);
});
```

**RED CI:** `npm run test -- packages/generator/src/elements-record.test.ts` expect `FAIL` with `Unknown element kind: diveDrop` before the change.

**GREEN implementation:** Add the three kinds to the `ELEMENT_KINDS` tuple, `defaults` (diveDrop `{ dropHeight: 210, angleDeg: 110, approachRadius: 90, exitRadius: 70, bank: 0 }`, immelmann `{ height: 81, exitHeadingDeg: 180, bank: 0 }`, verticalLoop `{ height: 67, referenceSpeed: 38, bank: 0 }`), `validateParameters` switch, `createAnyElement` switch; change the `topHat` validator to the [80, 92] range; change `topHatSpans(pose, width, endBank, elementId)` to `topHatSpans(pose, height, width, endBank, elementId)` scaling `smoothRampCoefficients` by `height` for both rise and fall rows and setting apex Y to `height`; change the `buildElement` `topHat` branch to pass `p.height`; extend all three `coaster-file.ts` gates. No other file gains a kind; `topHat` stays an existing kind.

**Focused CI:** `npm run test -- packages/generator/src/elements-record.test.ts packages/generator/src/coaster-file-record-kinds.test.ts packages/generator/src/topHat-height.geometry.test.ts packages/core/src/coaster-file.test.ts`.

**Static review:** Read `packages/generator/src/elements.ts:110-116`, verify the old `if (p.height !== 80)` line is gone and `[80, 92]` is present with default 80 at line 38; read `packages/generator/src/elements.ts:438`, verify `topHatSpans` takes `height` and no literal `80` remains in the rise/apex computation; read `packages/generator/src/elements.ts:624`, verify the `buildElement` `topHat` branch at `:630-632` passes `p.height`; read `packages/core/src/coaster-file.ts:156` and `:489`, verify exactly three kinds added and no `terrainSwoop`; grep `terrainSwoop` returns zero matches.

**Commit:** `feat(generator): add diveDrop, immelmann, verticalLoop semantic contracts`

### Task 03 — Seventh-order diveDrop geometry + quintic roll + seam/RMF tests (first of sequential B)

- [ ] `diveDropSpans` multi-span seventh-order synthesis with mid-drop angle proof

**Files:**

- Edit `packages/generator/src/elements.ts` (new `diveDropSpans` function declared immediately before `buildElement` at `:624`; new `DIVE_DROP_SPAN_COUNT = 3` export; new branch in `buildElement`)
- Create `packages/generator/src/diveDrop.geometry.test.ts`
- Create `packages/generator/src/diveDrop.seam.test.ts`

**Consumed interfaces:** `SeventhOrderHermiteSpan` + `QuinticScalarSpan.fromCoefficients` (`packages/core/src/spans.ts:32`); `buildElement` (`packages/generator/src/elements.ts:624`), `defaultPose`/`orthonormalizePose` (`elements.ts:198`/`205`); `solveSemanticChain`/`compileSemanticChain`/`diagnoseSeams`/`defaultTolerances` (`packages/generator/src/solver.ts:874`/`1205`/`340`/`35`); `SeamTolerances` (`types.ts:112`).

**Produced interfaces:** `export const DIVE_DROP_SPAN_COUNT = 3;` plus `diveDropSpans(pose: Pose, params: DiveDropParameters, id: string): ElementBuildResult` returning exactly 3 `SolvedSpan`s: span 0 summit exit (approach-radius Hermite lead-in, bank `pose.bank -> params.bank`), span 1 beyond-vertical drop (tangent pitch at normalized `u = 0.5` equals −70° ± 0.6°, i.e. 110° from horizontal / 20° past straight-down, vertical delta 210 ± 3 m), span 2 recovery (exit-radius clothoid, curvature and curvature-gradient driven to zero at the exit seam). Each span carries `positionCoefficients` (3×8 from `span.coefficients`) and `rollCoefficients` (6 from `bank.coefficients`); each `length` equals the integrated `arcLength` of that child span; interior roll uses per-span quintic with zero first/second derivatives at the two interior seams; span ids are `${id}#0..#2` with `kind: "diveDrop"`. `buildElement` early-returns for `diveDrop` through this helper, preserving the `applyAuthoredStartFrame` path in `compileSemanticChain`.

**Test sketches:**

```ts
// packages/generator/src/diveDrop.geometry.test.ts
import { test, expect } from "vitest";
import {
  buildElement,
  createElement,
  defaultPose,
  DIVE_DROP_SPAN_COUNT,
} from "./elements.js";
test("diveDrop emits 3 coefficient spans with mid-drop 110deg and 210m delta", () => {
  const el = createElement("diveDrop", "diveDrop-000", {
    dropHeight: 210,
    angleDeg: 110,
    approachRadius: 90,
    exitRadius: 70,
    bank: 0,
  });
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
  const pitchDeg = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  expect(Math.abs(pitchDeg + 70)).toBeLessThanOrEqual(0.6);
  const topY = solvedSpans[0]!.span.position(0)[1];
  const bottomY = solvedSpans[1]!.span.position(1)[1];
  const dropM = topY - bottomY;
  expect(Math.abs(dropM - 210)).toBeLessThanOrEqual(3);
});
test("diveDrop recovery span exits near level with driven-down exit curvature", () => {
  const el = createElement("diveDrop", "diveDrop-000", {
    dropHeight: 210,
    angleDeg: 110,
    approachRadius: 90,
    exitRadius: 70,
    bank: 0,
  });
  const { solvedSpans } = buildElement(el, defaultPose(), 34);
  const exit = solvedSpans[2]!.span;
  const d = exit.derivative(1, 1);
  const exitPitchDeg =
    (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  expect(Math.abs(exitPitchDeg)).toBeLessThanOrEqual(10);
  expect(solvedSpans[2]!.length).toBeGreaterThan(0);
});
```

```ts
// packages/generator/src/diveDrop.seam.test.ts
import { test, expect } from "vitest";
import {
  compileSemanticChain,
  diagnoseSeams,
  defaultTolerances,
} from "./solver.js";
import { createElement, defaultPose, buildElement } from "./elements.js";
test("diveDrop interior seams pass hard tolerances and infeasible variant fails", () => {
  const el = createElement("diveDrop", "diveDrop-000", {
    dropHeight: 210,
    angleDeg: 110,
    approachRadius: 90,
    exitRadius: 70,
    bank: 0,
  });
  const built = buildElement(el, defaultPose(), 34);
  const seams = diagnoseSeams(built.solvedSpans, {});
  expect(seams.length).toBe(2);
  for (const s of seams) {
    expect(s.positionM).toBeLessThanOrEqual(defaultTolerances.positionM);
    expect(s.curvatureVectorJumpPerM).toBeLessThanOrEqual(
      defaultTolerances.curvatureVectorJumpPerM,
    );
    expect(s.curvatureGradientPerM2).toBeLessThanOrEqual(
      defaultTolerances.curvatureGradientPerM2,
    );
  }
  const bad = compileSemanticChain([
    createElement("diveDrop", "diveDrop-009", {
      dropHeight: 210,
      angleDeg: 135,
      approachRadius: 15,
      exitRadius: 15,
      bank: 0,
    }),
  ]);
  expect(bad.feasible).toBe(false);
});
```

**RED CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts` expect `FAIL` (unknown kind before Task 02; missing `positionCoefficients` after 02 until this task).

**GREEN implementation:** Implement `diveDropSpans` immediately before `buildElement` (`elements.ts:624`) with explicit seventh-degree Hermite specs (8-coeff power basis `a0..a7` per `spans.ts:32-94`; C3 continuity requires matching `p/d1/d2/d3`, i.e. `a0..a3`-equivalent endpoint conditions, not `a0..a2`): span 0 summit exit — `p0 = pose.position`, `d10 = tangent * approachRadius` (e.g. 90 m), `d20 = d30 = 0`, `p1 = lip = pose.position + tangent*approachRadius*0.6` (level lip, no authored vertical rise, so the owned-slice union delta equals the span-1 vertical exactly), `d11 = lipTangent(angleDeg entry) * approachRadius`, `d21 = d31 = 0`; span 1 beyond-vertical drop — `p0 = lip`, `d10 = d11(span0 exit)`, `d20 = d30 = 0`, `p1 = lip + dropDir * (dropHeight / abs(sin(pitchRad)))`, `d11 = dropDir * exitRadius` (e.g. 70 m), `d21 = d31 = 0`; span 2 recovery — `p0 = dropBottom`, `d10 = dropDir * exitRadius`, `d20 = d30 = 0`, `p1 = bottom + levelTangent * exitRadius*1.4 + normal*4`, `d11 = levelTangent * exitRadius`, `d21 = d31 = 0` (exit curvature and curvature-gradient driven to zero by zeroed third derivatives). Radii derive first-derivative magnitudes directly (`|d1| = radius`); `angleDeg` rotates tangents in the basis plane with `pitchDeg = angleDeg − 180` and `pitchRad = pitchDeg * π/180` (`dropDir = cos(pitchRad)*tangent + sin(pitchRad)*normal`, unit), so 110° → −70° (nominal), 90° → −90° (straight down), 135° → −45° — never the single-point `-(angleDeg − 40°)` form, which coincides only at 110°. `dropHeight` is vertical by construction: scaling the unit `dropDir` by `dropHeight / abs(sin(pitch))` makes the span-1 vertical exactly `dropHeight` (nominal slant `210/sin70° ≈ 223.5 m` of Hermite arc for the 210 m vertical; the prior unscaled `dropDir * dropHeight` plus `normal*8` lip gave `210·sin70° − 8 ≈ 189 m`, failing its own `|dropM − 210| ≤ 3` test). Emit via `new SeventhOrderHermiteSpan({p0,d10,d20,d30,p1,d11,d21,d31})` + `QuinticScalarSpan.fromCoefficients` per span with integrated `arcLength(span.span)` lengths. Seam budget rederived (endpoint derivatives untouched by the slant scaling, only `p1` moves): with `|d1| ≥ 60 m` from the radii and zeroed `d2/d3` at both interior seams, `curvatureGradient ≈ |d3|/q³ ≤ 1e-6 ≪ 1e-4` (`solver.ts:35-46`); `diveDrop.seam.test.ts` asserts `positionM/curvatureVectorJumpPerM/curvatureGradientPerM2 ≤ defaultTolerances`. Energy premise (Task 06 §Energy) is preserved verbatim by this construction: vertical stays exactly 210 m so `E = m·g·h = 9000 × 9.80665 × 210 ≈ 18.53 MJ`; the ≈223.5 m slant is Hermite arc length, never an energy input. No footprint/terrain invention inside geometry.

**Focused CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts packages/generator/src/diveDrop.seam.test.ts`.

**Static review:** Read the new `diveDropSpans` (declared immediately before `buildElement` at `packages/generator/src/elements.ts:624`), verify seventh-order spec completeness and `fromCoefficients` round-trip (`packages/core/src/spans.ts`); verify `physicalBankDerivative` at `packages/generator/src/solver.ts:113-117` (not `:416`, which is inside `diagnoseSeams` return).

**Commit:** `feat(generator): synthesize seventh-order diveDrop with quintic roll`

### Task 04 — Seventh-order immelmann geometry + handedness + seam/RMF (second of sequential B; starts after Task 03)

- [ ] `immelmannSpans` half-loop + roll with global RMF, locally defined ramp coefficients

**Files:**

- Edit `packages/generator/src/elements.ts` (new `immelmannSpans` function declared after `diveDropSpans`, immediately before `buildElement` at `:624`; new `IMMELMANN_SPAN_COUNT = 2` export; new branch in `buildElement`)
- Create `packages/generator/src/immelmann.geometry.test.ts`
- Create `packages/generator/src/immelmann.seam.test.ts`

**Consumed interfaces:** Same span/RMF/solver stack as Task 03. Note: `smoothRampCoefficients`/`riseCoefficients` at `elements.ts:276`/`446` are private to `topHatSpans` and MUST NOT be imported; this task defines its own local `immelmannRiseCoefficients` array inside `immelmannSpans`.

**Produced interfaces:** `export const IMMELMANN_SPAN_COUNT = 2;` plus `immelmannSpans(pose: Pose, params: ImmelmannParameters, id: string): ElementBuildResult` returning exactly 2 `SolvedSpan`s: span 0 half-loop rising `params.height` (81 ± 1 m local delta for the record target) with apex bank `pose.bank + π`, span 1 roll-exit enforcing end-tangent yaw `params.exitHeadingDeg` (±1°) with exit bank `params.bank`. Local seventh-degree rise table `immelmannRiseCoefficients: readonly number[8] = [0, 0, 0, 0, 35, -84, 70, -20]` (declared inside `immelmannSpans`, same C3-entry smoother as `smoothRampCoefficients` at `elements.ts:276`: `a0 = a1 = a2 = a3 = 0` gives zero position/first/second/third derivatives at entry, i.e. C3; degree 7 power basis `a0..a7` per `spans.ts:32-94` — not "eighth-order") scales apex Y as `riseCoefficients = immelmannRiseCoefficients.map((c) => c * height)`; radius honors `curvatureGradientPerM2` seam tolerance; `bank` uses per-span quintic with C2 bank-derivative continuity (`physicalBankDerivative` at `solver.ts:113-117`); ids `${id}#0..#1`, `kind: "immelmann"`, integrated `arcLength` per child.

**Test sketches:**

```ts
// packages/generator/src/immelmann.geometry.test.ts
import { test, expect } from "vitest";
import { transportFramesAlongPath } from "@openvibecoaster/core";
import {
  buildElement,
  createElement,
  defaultPose,
  IMMELMANN_SPAN_COUNT,
} from "./elements.js";
test("immelmann height 81 local delta and exit heading 180", () => {
  const el = createElement("immelmann", "immelmann-000", {
    height: 81,
    exitHeadingDeg: 180,
    bank: 0,
  });
  const { solvedSpans, endPose } = buildElement(el, defaultPose(), 30);
  expect(IMMELMANN_SPAN_COUNT).toBe(2);
  expect(solvedSpans.length).toBe(2);
  const ys: number[] = [];
  for (const s of solvedSpans)
    for (let i = 0; i <= 32; i += 1) ys.push(s.span.position(i / 32)[1]);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(80);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(82);
  const yawDeg =
    (Math.atan2(endPose.tangent[0], endPose.tangent[2]) * 180) / Math.PI;
  expect(Math.abs(Math.abs(yawDeg) - 180)).toBeLessThanOrEqual(1);
});
test("immelmann handedness preserved and RMF binormal continuous (frames, not tangents)", () => {
  const left = buildElement(
    createElement("immelmann", "immelmann-010", {
      height: 81,
      exitHeadingDeg: 90,
      bank: 0,
    }),
    defaultPose(),
    30,
  );
  const right = buildElement(
    createElement("immelmann", "immelmann-011", {
      height: 81,
      exitHeadingDeg: -90,
      bank: 0,
    }),
    defaultPose(),
    30,
  );
  expect(left.endPose.tangent[0]).toBeGreaterThan(0.5);
  expect(right.endPose.tangent[0]).toBeLessThan(-0.5);
  // RMF continuity: transport frames over the two-span path and compare
  // normals/binormals at the interior seam (u=1 of span 0 vs u=0 of span 1).
  for (const built of [left, right]) {
    const pts = [
      built.solvedSpans[0]!.span.position(0.98),
      built.solvedSpans[0]!.span.position(1),
      built.solvedSpans[1]!.span.position(0),
      built.solvedSpans[1]!.span.position(0.02),
    ];
    const tans = [
      built.solvedSpans[0]!.span.derivative(0.98, 1),
      built.solvedSpans[0]!.span.derivative(1, 1),
      built.solvedSpans[1]!.span.derivative(0, 1),
      built.solvedSpans[1]!.span.derivative(0.02, 1),
    ];
    const norms = tans.map((t) => {
      const l = Math.hypot(t[0], t[1], t[2]);
      return [t[0] / l, t[1] / l, t[2] / l] as const;
    });
    const frames = transportFramesAlongPath(
      pts as never,
      norms as never,
      [0, 1 / 3, 2 / 3, 1],
      [0, 0, 0, 0],
    );
    const dotN =
      frames[1]!.normal[0] * frames[2]!.normal[0] +
      frames[1]!.normal[1] * frames[2]!.normal[1] +
      frames[1]!.normal[2] * frames[2]!.normal[2];
    const dotB =
      frames[1]!.binormal[0] * frames[2]!.binormal[0] +
      frames[1]!.binormal[1] * frames[2]!.binormal[1] +
      frames[1]!.binormal[2] * frames[2]!.binormal[2];
    expect(dotN).toBeGreaterThan(0.999);
    expect(dotB).toBeGreaterThan(0.999);
  }
});
```

```ts
// packages/generator/src/immelmann.seam.test.ts
import { test, expect } from "vitest";
import {
  compileSemanticChain,
  diagnoseSeams,
  defaultTolerances,
} from "./solver.js";
import { createElement } from "./elements.js";
test("immelmann single interior seam passes hard tolerances", () => {
  const r = compileSemanticChain([
    createElement("immelmann", "immelmann-000", {
      height: 81,
      exitHeadingDeg: 180,
      bank: 0,
    }),
  ]);
  expect(r.feasible).toBe(true);
  expect(r.seamDiagnostics.length).toBe(1);
  expect(r.seamDiagnostics[0]!.positionM).toBeLessThanOrEqual(
    defaultTolerances.positionM,
  );
  expect(r.seamDiagnostics[0]!.curvatureGradientPerM2).toBeLessThanOrEqual(
    defaultTolerances.curvatureGradientPerM2,
  );
});
```

**RED CI:** `npm run test -- packages/generator/src/immelmann.geometry.test.ts` expect height drift > 2 m or missing second span before this task.

**GREEN implementation:** Implement `immelmannSpans` with the local seventh-degree rise table above (do not export or reuse `topHatSpans` privates at `elements.ts:275-276`); emit two `new SeventhOrderHermiteSpan({p0,d10,d20,d30,p1,d11,d21,d31})` spans plus quintic banks; no generic roll wrapper; preserve global RMF via `transportFramesAlongPath` (`core/src/frames.ts:207`, alias `doubleReflectionFrames` at `:269`) — never reset frames at the interior seam.

**Focused CI:** `npm run test -- packages/generator/src/immelmann.geometry.test.ts packages/generator/src/immelmann.seam.test.ts`.

**Static review:** Read `packages/core/src/frames.ts:207-269`, verify `transportFramesAlongPath`/`doubleReflectionFrames` with no frame reset; read the new `immelmannSpans` (declared after `diveDropSpans`, immediately before `buildElement` at `packages/generator/src/elements.ts:624`), verify `immelmannRiseCoefficients` is locally defined as 8-coeff seventh-degree with `a0..a3 = 0` and `smoothRampCoefficients` is not referenced outside `topHatSpans`.

**Commit:** `feat(generator): synthesize seventh-order immelmann with quintic roll`

### Task 05 — Force-shaped verticalLoop geometry + curvature-gradient seams (third of sequential B; starts after Task 04)

- [ ] `verticalLoopSpans` explicit height/referenceSpeed with C3-certified exit

**Files:**

- Edit `packages/generator/src/elements.ts` (new `verticalLoopSpans` function declared after `immelmannSpans`, immediately before `buildElement` at `:624`; new `VERTICAL_LOOP_SPAN_COUNT = 3` export; new branch in `buildElement`)
- Create `packages/generator/src/verticalLoop.geometry.test.ts`
- Create `packages/generator/src/verticalLoop.seam.test.ts`

**Consumed interfaces:** Same span/RMF/solver stack; `SeamTolerances.curvatureGradientPerM2: 1e-4` (`packages/generator/src/solver.ts:35`); `validateGenerationConstraints` untouched.

**Produced interfaces:** `export const VERTICAL_LOOP_SPAN_COUNT = 3;` plus `verticalLoopSpans(pose: Pose, params: VerticalLoopParameters, id: string): ElementBuildResult` returning exactly 3 `SolvedSpan`s (entry clothoid, apex teardrop, exit clothoid): local height `maxY − minY` over the 3-span slice equals `params.height` (67 ± 1 m local delta for the record target) via radius `height / 2.05`; entrance/exit curvature and curvature-gradient (`d30/d31`) forced to zero; roll locked to 0 across all three spans (vertical loop, no inversion roll); `referenceSpeed` (38 m/s default test value) shapes apex curvature `v²/r` toward the project force band without clamping or suppressing diagnostics; ids `${id}#0..#2`, `kind: "verticalLoop"`, integrated `arcLength` per child.

**Test sketches:**

```ts
// packages/generator/src/verticalLoop.geometry.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain } from "./solver.js";
import { createElement } from "./elements.js";
test("verticalLoop height 67 local delta with C3 seams from compiled track", () => {
  const r = compileSemanticChain([
    createElement("verticalLoop", "verticalLoop-000", {
      height: 67,
      referenceSpeed: 38,
      bank: 0,
    }),
  ]);
  expect(r.feasible).toBe(true);
  const positions = r.track!.positions;
  const distances = r.track!.distances;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < distances.length; i += 1) {
    const y = positions[i * 3 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  expect(maxY - minY).toBeGreaterThanOrEqual(66);
  expect(maxY - minY).toBeLessThanOrEqual(68);
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
test("verticalLoop infeasible height variant fails honestly with error diagnostic", () => {
  const r = compileSemanticChain([
    createElement("verticalLoop", "verticalLoop-009", {
      height: 130,
      referenceSpeed: 5,
      bank: 0,
    }),
  ]);
  expect(r.feasible).toBe(false);
  expect(r.solvedSpans.length).toBe(3);
  expect(r.seamDiagnostics.length).toBe(2);
  const errors = r.diagnostics.filter(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  expect(errors.length).toBeGreaterThan(0);
  expect(typeof errors[0]!.actual).toBe("number");
  expect(typeof errors[0]!.limit).toBe("number");
});
```

**RED CI:** `npm run test -- packages/generator/src/verticalLoop.geometry.test.ts` expect hard seam failure or missing apex height before this task.

**GREEN implementation:** Implement teardrop position coefficients via scaled Hermite specs with radius `height / 2.05`, zeroed `d30/d31` at entry/exit, locked zero roll; keep `curvaturePerM` seam tolerance; do not suppress any diagnostic.

**Focused CI:** `npm run test -- packages/generator/src/verticalLoop.geometry.test.ts packages/generator/src/verticalLoop.seam.test.ts`.

**Static review:** Verify `validateGenerationConstraints` and `defaultTolerances` untouched; verify `buildElement` at `packages/generator/src/elements.ts:624` shows three ordered branches `diveDropSpans` → `immelmannSpans` → `verticalLoopSpans`.

**Commit:** `feat(generator): synthesize force-shaped verticalLoop with seam-certified exit`

### Task 06 — Record default sequence, deterministic generation, save/reload preservation

- [ ] Insta 5,200–5,400 m route with exact element IDs and coefficient-preserving reload

**Files:**

- Edit `packages/generator/src/pipeline.ts:136` (`defaultElements`, new `recordHybridDefaultElements(seed: number, candidate: number)` returning the authoritative ordered list below; insta/full-auto dispatch through it via `asElements` at `:334-341`)
- Edit `packages/generator/src/pipeline.ts:81-84` (`DEFAULT_PROFILE_VERSION` / `DEFAULT_RESEARCH_SNAPSHOT_IDS`) and `packages/generator/src/pipeline.ts:1765-1776` (`buildFileResult` uses `options.profileVersion ?? DEFAULT_PROFILE_VERSION` / `options.researchSnapshotIds ?? DEFAULT_RESEARCH_SNAPSHOT_IDS`): the record route passes explicit `GenerationOptions { profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"] }` — see Produced interfaces. `packages/core/src/coaster-file.ts:559` is the `createCoasterFileV1` definition (validates `profileVersion`/`researchSnapshotIds` at `:593-596`); the call sites are `pipeline.ts:1765` and `:2140`.
- Create `packages/generator/src/recordHybrid.pipeline.test.ts`
- Create `packages/generator/src/recordHybrid.determinism.test.ts`
- Create `packages/generator/src/recordHybrid.physical-length.test.ts` (invariant: authored-length tamper cannot drift serialization; pins `ad9d5b3`)

**Consumed interfaces:** `DesignIntentV1` (`packages/core/src/contracts.ts:49`); `GenerationResult` (`packages/generator/src/types.ts:195`); `createDesignIntentV1`/`parseDesignIntentV1`/`serializeCoasterFileV1`/`deserializeCoasterFileV1`/`compileCoasterFile`/`serializeSolvedSpanV1` (`packages/core/src/coaster-file.ts:481`/`638`/`657`/`874`/`964`/`918`); `Xoshiro128ss` (`packages/core/src/random.ts`); solver budgets `pipeline.ts:1500-1505` and `1970-1974` (frozen).

**Produced interfaces:** `recordHybridDefaultElements(seed, candidate)` returns exactly 20 elements with stable IDs in spec narrative order (`docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md:67-86`): `station-000` (180 m dispatch run), `launch-001` (first LSM rollout 260 m, `targetSpeed: 44`), `transition-002` (rising transition into ~60 m twisted drop), `airtimeHill-003` (airtime rise) + `overbankedTurn-004` + `overbankedTurn-005` (terrain warm-up: two banked direction changes + airtime rise), `launch-006` (long second LSM climb 420 m to the cliff summit), `brake-007` (summit static-hold brake zone 35 m, `targetSpeed: 0`), `diveDrop-008` (210 m / 110° cliff dive), `launch-009` (third LSM 380 m using drop kinetic energy — sized by §Energy below), `airtimeHill-010` (190 m camelback), `topHat-011` (height 91, inverted), `immelmann-012` (height 81), `verticalLoop-013` (height 67), `overbankedTurn-014` (finale overbank), `zeroGRoll-015` (finale zero-G roll), `stall-016` (finale stall), `brake-017` (curved trim/brake turn 140 m with bank, `targetSpeed: 25`), `brake-018` (long magnetic braking 320 m, `targetSpeed: 0`), `station-019` (open terminal station 180 m, `closed: false`, physical closure). Total compiled physical length lands inside [5,200, 5,400] m (assert the window with `toBeGreaterThanOrEqual(5200)` / `toBeLessThanOrEqual(5400)`, never `5250 ± 150`). Terminal closure is proven by `brake-018` bringing timeline end speed `<= 0.2 m/s` (Task 08 `BRAKE_MARGIN`) plus `station-019` as the final span so the last operation zone ends at `track.totalLength`; the open terminal station itself carries no invented target (`operationZonesFromCoasterFile` leaves open-station `targetSpeedMps` undefined per `packages/simulator/src/operation-zones.ts:68-73` — the 0 m/s stop is owned by `brake-018`). `generateCoaster` keeps exact `maxIterations`/`maxCandidates`/3-rerun logic; `compileCoasterFile(reload)` recompiles stored solved coefficients without re-solving (checksum equality). Record profile/research wiring: `generateCoaster(intent, { profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"], environment })` flows through `buildFileResult` (`pipeline.ts:1765-1776`: `options.profileVersion ?? DEFAULT_PROFILE_VERSION`, `options.researchSnapshotIds ?? DEFAULT_RESEARCH_SNAPSHOT_IDS` at `:81-84`); `asElements` (`:334-341`) dispatches insta/full-auto through `recordHybridDefaultElements`. `generateCoaster` keeps exact `maxIterations` (`:1500-1505`: 32 directed, 1 bare insta, 8 otherwise) / `maxCandidates` (`:1970-1974`: 1 directed/bare, else 48) / ≤3 relaxation reruns. Physical-length invariant (fixed `ad9d5b3`, NOT re-edited here): `evaluateCandidate` (`:1569`), `buildFileResult` (`:1730` via `spanLengthCache`), `generationWithSpans` (`:2123`) all store `arcLength(span.span)` unconditionally; `recordHybrid.physical-length.test.ts` pins it. §Energy sizing (real model, `train-lsm-v1.json` + `simulator/src/index.ts:42-70`): totals 9,000 kg, LSM 84 kN / 7.2 MW, brake 108 kN (≈12 m/s²). Drop energy `E = m·g·h = 9000 × 9.80665 × 210 ≈ 18.53 MJ`; 79.16 m/s KE `= 1/2·9000·79.16² ≈ 28.20 MJ`, so LSM must supply `≈ 9.7 MJ + drag/rolling`; `launch-009` 380 m at 7.2 MW gives `≈ 38 MJ` capacity — sufficient with margin; dive slant at nominal 110° (−70° pitch) is `210/sin70° ≈ 223.5 m` of Hermite arc under the Task 03 `dropHeight / abs(sin(pitch))` scaling while vertical stays exactly 210 m, so the `≈ 18.53 MJ` premise above is unchanged (`dropHeight` is vertical, never slant); test asserts `accumulatedDriveWorkJ` within `1.2MW×6×duration` and `max(speedMps) ≥ 79.16`. Braking from 81.94 m/s at 12 m/s² needs `d = v²/2a ≈ 280 m`; `brake-017 (140 m) + brake-018 (320 m) = 460 m ≥ 280 m + 64% margin`; test asserts terminal `endSpeed ≤ 0.2` and `BRAKE_MARGIN` absent.; save preserves `profileVersion`, `researchSnapshotIds`, semantic intent, exact `positionCoefficients`/`rollCoefficients`, per-child integrated `length`, checksum, and editability.

**Test sketches:**

```ts
// packages/generator/src/recordHybrid.pipeline.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import {
  compileCoasterFile,
  createDesignIntentV1,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
} from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  operationZonesFromCoasterFile,
  simulateRide,
} from "@openvibecoaster/simulator";
const RECORD_IDS = [
  "station-000",
  "launch-001",
  "transition-002",
  "airtimeHill-003",
  "overbankedTurn-004",
  "overbankedTurn-005",
  "launch-006",
  "brake-007",
  "diveDrop-008",
  "launch-009",
  "airtimeHill-010",
  "topHat-011",
  "immelmann-012",
  "verticalLoop-013",
  "overbankedTurn-014",
  "zeroGRoll-015",
  "stall-016",
  "brake-017",
  "brake-018",
  "station-019",
];
test("insta route has 20 stable ids and length inside 5200-5400", () => {
  const intent = createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const g = generateCoaster(intent, {
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
  });
  expect(g.elements.map((e) => e.id)).toEqual(RECORD_IDS);
  expect(g.elements.length).toBe(20);
  expect(g.track.totalLength).toBeGreaterThanOrEqual(5200);
  expect(g.track.totalLength).toBeLessThanOrEqual(5400);
  expect(g.file.profileVersion).toBe("record-targets-v1");
  expect(g.file.researchSnapshotIds).toEqual(["records-2026-09-01"]);
});
test("finale and terminal closure: overbank/roll/stall present, zones inside length, terminal brake stops train", () => {
  const intent = createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const g = generateCoaster(intent, {
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
  });
  const kinds = new Map(g.elements.map((e) => [e.id, e.kind]));
  expect(kinds.get("overbankedTurn-014")).toBe("overbankedTurn");
  expect(kinds.get("zeroGRoll-015")).toBe("zeroGRoll");
  expect(kinds.get("stall-016")).toBe("stall");
  expect(kinds.get("brake-018")).toBe("brake");
  expect(kinds.get("station-019")).toBe("station");
  const zones = operationZonesFromCoasterFile(g.file);
  for (const z of zones) {
    expect(z.endDistanceM).toBeLessThanOrEqual(g.track.totalLength);
    expect(z.startDistanceM).toBeLessThan(z.endDistanceM);
  }
  const lastZone = zones[zones.length - 1]!;
  expect(
    Math.abs(lastZone.endDistanceM - g.track.totalLength),
  ).toBeLessThanOrEqual(1e-6);
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, {
    durationSeconds: 180,
    config: { ...cfg, zones },
    initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 0 },
  });
  const lastSpeed = sim.timeline.speedMps[sim.timeline.length - 1]!;
  expect(lastSpeed).toBeLessThanOrEqual(0.2 + 1e-6);
});
test("save reload preserves coefficients profile research and checksum", () => {
  const intent = createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const g = generateCoaster(intent, {
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
  });
  const json = serializeCoasterFileV1(g.file);
  const re = deserializeCoasterFileV1(json);
  expect(re.profileVersion).toBe("record-targets-v1");
  expect(re.researchSnapshotIds).toEqual(["records-2026-09-01"]);
  expect(re.solvedSpans[0]!.positionCoefficients).toEqual(
    g.file.solvedSpans[0]!.positionCoefficients,
  );
  expect(re.solvedSpans[0]!.rollCoefficients).toEqual(
    g.file.solvedSpans[0]!.rollCoefficients,
  );
  expect(compileCoasterFile(re).track.checksum).toBe(g.track.checksum);
});
```

```ts
// packages/generator/src/recordHybrid.determinism.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("same seed twice gives identical checksum and length", () => {
  const mk = () =>
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 7,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
  const opts = {
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
  } as const;
  const a = generateCoaster(mk(), opts);
  const b = generateCoaster(mk(), opts);
  expect(a.track.checksum).toBe(b.track.checksum);
  expect(a.track.totalLength).toBe(b.track.totalLength);
});
test("candidate index advances the record sequence deterministically (insta maxCandidates=1, so test the sequence fn directly)", async () => {
  const { recordHybridDefaultElements } = await import("./pipeline.js");
  const c0 = recordHybridDefaultElements(7, 0).map((e) => e.id);
  const c1 = recordHybridDefaultElements(7, 1).map((e) => e.id);
  expect(c0.length).toBe(20);
  expect(c1.length).toBe(20);
  expect(c0).not.toEqual(c1);
  expect(recordHybridDefaultElements(7, 0).map((e) => e.id)).toEqual(c0);
});
```

````ts
// packages/generator/src/recordHybrid.physical-length.test.ts
// Pins ad9d5b3: SerializedSolvedSpanV1.length is integrated arcLength(span.span),
// never authored parameters.length. No pipeline edit in this task.
import { test, expect } from "vitest";
import { arcLength } from "@openvibecoaster/core";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("serialized lengths equal integrated arcLength even when authored length is tampered", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const g = generateCoaster(intent, { profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"] });
  for (let i = 0; i < g.solvedSpans.length; i += 1) {
    const span = g.solvedSpans[i]!;
    const stored = g.file.solvedSpans[i]!.length;
    expect(Math.abs(stored - arcLength(span.span))).toBeLessThanOrEqual(1e-9);
  }
  const tampered = JSON.parse(JSON.stringify(intent)) as typeof intent;
  (tampered.elements as unknown[]).push({ id: "station-tamper", kind: "station", type: "station", parameters: { length: 999, bank: 0, closed: false } });
  // Tamper control completed: generate + serialize from the tampered intent and
  // assert physical lengths stay authoritative (authored 999 never leaks).
  const t = generateCoaster(tampered, { profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"] });
  for (let i = 0; i < t.solvedSpans.length; i += 1) {
    expect(Math.abs(t.file.solvedSpans[i]!.length - arcLength(t.solvedSpans[i]!.span))).toBeLessThanOrEqual(1e-9);
  }
  expect(t.file.solvedSpans.every((s) => s.length !== 999)).toBe(true);
});

**RED CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts` expect `totalLength` below 5,200 (current compact default is far shorter) or missing `overbankedTurn-014`/`station-019` IDs before this task. Profile/research RED: `generateCoaster(intent)` without options yields `profileVersion === "project-engineering-limits-v1"` and `researchSnapshotIds === ["records-2026-08-29"]` (`pipeline.ts:81-84`), so the Task 06 assertions on `"record-targets-v1"` / `["records-2026-09-01"]` fail until callers pass explicit options.

**GREEN implementation:** Add `recordHybridDefaultElements(seed, candidate)` computing the 20-element list above with the sized lengths (station 180 m, launch-001 260 m, launch-006 420 m, summit brake-007 35 m with `targetSpeed: 0`, `diveDrop` 210 m/110°, launch-009 380 m, camelback 190 m airtimeHill, `topHat` height 91, `immelmann` 81, `verticalLoop` 67, finale `overbankedTurn-014`/`zeroGRoll-015`/`stall-016`, trim `brake-017` 140 m with bank and `targetSpeed: 25`, terminal magnetic `brake-018` 320 m with `targetSpeed: 0`, open terminal `station-019` 180 m with `closed: false`); dispatch insta/full-auto through it in `asElements`; require record callers (tests, worker record path, E2E seed) to pass `{ profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"] }`. Do NOT edit `evaluateCandidate`/`buildFileResult`/`generationWithSpans` serialization (already `arcLength(span.span)` per `ad9d5b3`). Lengthen launch/transition/brake spans inside the window when energy demands it; never shrink record elements, relax hard targets, clamp speed, or invent power. Keep solver `maxIterations` (`:1500-1505`)/`maxCandidates` (`:1970-1974`)/rerun logic byte-identical.

**Focused CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts packages/generator/src/recordHybrid.determinism.test.ts packages/generator/src/recordHybrid.physical-length.test.ts`.

**Static review:** Read `packages/generator/src/pipeline.ts:136` and `:334-341`, verify 20 stable IDs ending in `station-019` and `[5200, 5400]` window assertion; read `packages/generator/src/pipeline.ts:81-84` and `:1765-1776`, verify `options.profileVersion ?? DEFAULT` wiring and stable serialize order (`coaster-file.ts:621-633`); read `pipeline.ts:1569,1730,2123`, verify unconditional `arcLength(span.span)` with no `parameters.length` shortcut.

**Commit:** `feat(generator): implement record default sequence and deterministic save-reload`

### Task 07 — Widened cliff terrain behind the pure core boundary + directed gates/pins + clearance authority

- [ ] 5.2 km cliff-and-valley heightfield defined in pure core; web layer consumes/adapts it; generator never imports apps/web

**Files:**

- Create `packages/core/src/environments/cliff-valley.ts` (pure core, no Three.js/DOM/WebAudio: exports `CLIFF_VALLEY_TERRAIN_PROFILE_ID = "cliff-valley-v1"` and `createCliffValleyEnvironment(): HeightfieldEnvironment` with `width: 420, depth: 280, cellSize: 10` — extent `(420−1)×10 = 4,190 m` by `(280−1)×10 = 2,790 m`, 117,600 heights, `origin: [-2095, -1395]` (centered: `-((width−1)*cellSize)/2`, `-((depth−1)*cellSize)/2` per `apps/web/src/terrain/environment.ts:23-26` pattern) — `height(worldX, worldZ) = -15 + 240 * exp(-((worldZ − 980)/120)²) + detail`, `detail = 0.6 * sin(worldX*0.02) * cos(worldZ*0.02)` with `detail := 0` at the summit probe so the summit assertion never flakes; ridge seeded at `worldZ = 980` as initial placement only (the old `exp(-(z/120)²)` ridge at `z = 0` would sit under the station, not the summit) — never track authority: the track summit `s` is route-derived from the `brake-007` zone center via the Task 08 `summitHoldWindow` helper and moves as the solver lengthens spans inside the 5,200–5,400 m envelope, and pre-summit overbanks yaw the track so no `z ≈ s` assumption holds (start pose `(0,0,0)` heading `+Z` per `elements.ts:198-203` fixes only the start heading).
- Edit `packages/core/src/index.ts` (add `export * from "./environments/cliff-valley";` after line 9 `export * from "./environment";`)
- Edit `apps/web/src/terrain/environment.ts` (add `CLIFF_VALLEY_TERRAIN_PROFILE_ID` re-exported from `@openvibecoaster/core`, extend `VALID_TERRAIN_PROFILE_IDS` at `:12-15`, implement `resolveTerrainEnvironment` delegation at `:72-79` and `createTerrainEnvironment` at `:84-90` to `createCliffValleyEnvironment()` for `"cliff-valley-v1"`; strict throw on unknown IDs preserved; no heightfield formula duplicated in web)
- Edit `packages/generator/src/pipeline.ts:940-946` (`validateGenerationConstraints` signature honors injected `options.environment: EnvironmentQuery | undefined`; no new terrain import in generator — record callers inject `createCliffValleyEnvironment()` via `GenerationOptions.environment` at `types.ts:180-189`); footprint/hard-gate handling and `relaxationEvidence` on infeasible footprints — no silent pass
- Create `packages/core/src/environments/cliff-valley.test.ts` (pure-core extent/summit/determinism proof, no web import)
- Create `packages/generator/src/clearance-cliff.test.ts` (imports environment only from `@openvibecoaster/core`, injects via `generateCoaster(intent, { environment })`)
- Create `packages/generator/src/gates-pins.test.ts` (same injection rule; no `apps/web` import)

**Consumed interfaces:** `HeightfieldEnvironment` + `EnvironmentQuery` (`packages/core/src/environment.ts`, `packages/core/src/contracts.ts:119`); `resolveTerrainEnvironment(profileId)` (`apps/web/src/terrain/environment.ts:72-79`, throws on unknown IDs); `validateGenerationConstraints` (`packages/generator/src/pipeline.ts:940-946`, honors injected `options.environment`); `validateClearance` (`packages/generator/src/clearance.ts:741`) with `CertifiedWorkBudget`/`certifiedPolynomialBounds`; `computeClearanceField(track, options)` (`packages/generator/src/clearance-field.ts:327`); `RelaxationEvidence` (`packages/generator/src/types.ts:223`); `GenerationOptions.environment` (`packages/generator/src/types.ts:180-189`, injected `EnvironmentQuery`).

**Produced interfaces:** `createCliffValleyEnvironment()` (pure core) yields a deterministic `HeightfieldEnvironment` with `width: 420, depth: 280, cellSize: 10` (4,190 × 2,790 m extent, 117,600 heights, `origin: [-2095, -1395]`): valley floor −15 m, cliff ridge `−15 + 240 = 225 m` at `worldZ = 980` (`height = -15 + 240 * exp(-((worldZ − 980)/120)²) + detail`, `detail = 0` at summit probe → exactly 225 m, `±0.6` elsewhere → 224.4–225.6 floor/ridge band (`980` is the initial ridge placement seed, never track authority: the `gates-pins.test.ts` alignment assert keeps the record route's `brake-007` zone center within ±120 m — one cliff wavelength σ=120 — of the seed, and summit terrain support is read at the compiled summit `(x,z)`); summit probe asserts `≥ 224.4`, and the track-summit band asserts 225–235 via terrain-following placement, not a flaky `heightAt(0,0) ∈ [225,235]`). `resolveTerrainEnvironment("cliff-valley-v1")` (web) delegates to the core factory; unknown IDs still throw. No file under `packages/generator` imports `apps/web/*` (enforced by test-time import scan of `pipeline.ts` source). Directed mode honors hard footprint polygons and up-to-3 gates via `isPointInsidePolygonStrict`/`signedDistanceStrictXZ`; an infeasible record footprint returns feasible `false` plus `relaxationEvidence` entries (`{ change, rerun: true, feasible, lmIterations, margins }`) instead of leaving the footprint. `validateClearance` (`clearance.ts:741`) never uses a sampled-only path; terrain separation uses inflated segment bounds with `sqrt(3)` locality and the existing bounded heap with default `maxWork: 1_000_000` (`clearance-field.ts:367-369`); Task 07 sizes the budget (see tests: full-work pass + `maxWork: 1` `CLEARANCE_UNCERTIFIED` negative control + `field.work < maxWork` assertion for the 117,600-height (233802-triangle ((420-1)*(280-1)*2=419*279*2)) field). Worker-side terrain is resolved inside the worker from `intent.terrainProfileId` (`apps/web/src/engineering/worker.ts:296-310`); the worker transfers only track/timeline/`clearanceM` (`protocol.ts:68-79`, `transfer.ts:6`), never heightfield buffers — tests assert generation determinism, not terrain-buffer transfer.

**Test sketches:**

```ts
// packages/core/src/environments/cliff-valley.test.ts
import { test, expect } from "vitest";
import { CLIFF_VALLEY_TERRAIN_PROFILE_ID, createCliffValleyEnvironment } from "./cliff-valley.js";
test("cliff-valley extent, summit height, and determinism (pure core)", () => {
  expect(CLIFF_VALLEY_TERRAIN_PROFILE_ID).toBe("cliff-valley-v1");
  const a = createCliffValleyEnvironment();
  const b = createCliffValleyEnvironment();
  expect(a.width).toBe(420);
  expect(a.depth).toBe(280);
  expect(a.cellSize).toBe(10);
  expect((a.width - 1) * a.cellSize).toBe(4190);
  expect((a.depth - 1) * a.cellSize).toBe(2790);
  expect(a.origin).toEqual([-2095, -1395]);
  // Ridge-seed probes: 980 is the heightfield placement seed, never track
  // authority (track-to-terrain alignment is asserted generator-side in gates-pins).
  expect(a.heightAt(0, 980)).toBe(b.heightAt(0, 980));
  expect(a.heightAt(0, 980)).toBeGreaterThanOrEqual(224.4);
  expect(a.heightAt(0, 980)).toBeLessThanOrEqual(226);
  expect(a.heightAt(0, 0)).toBeLessThan(0);
});
````

```ts
// packages/generator/src/clearance-cliff.test.ts
import { test, expect } from "vitest";
import { createCliffValleyEnvironment } from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("cliff-valley extent and certified terrain clearance with work budget sizing", () => {
  const env = createCliffValleyEnvironment();
  expect((env.width - 1) * env.cellSize).toBe(4190);
  const intent = createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 11,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const g = generateCoaster(intent, {
    environment: env,
    profileVersion: "record-targets-v1",
    researchSnapshotIds: ["records-2026-09-01"],
  });
  const field = computeClearanceField(g.track, {
    environment: env,
    maxWork: 1000000,
  });
  expect(
    field.diagnostics.some((d) => d.code === "CLEARANCE_UNCERTIFIED"),
  ).toBe(false);
  expect(field.work).toBeLessThan(1000000);
  expect(Number.isFinite(field.minClearanceM)).toBe(true);
  const narrow = computeClearanceField(g.track, {
    environment: env,
    maxWork: 1,
  });
  expect(
    narrow.diagnostics.some((d) => d.code === "CLEARANCE_UNCERTIFIED"),
  ).toBe(true);
});
test("generator never imports apps/web terrain (package boundary)", async () => {
  const fs = await import("node:fs/promises");
  const pipelineSrc = await fs.readFile(
    new URL("./pipeline.ts", import.meta.url),
    "utf8",
  );
  expect(pipelineSrc).not.toContain("apps/web");
});
```

```ts
// packages/generator/src/gates-pins.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import {
  createCliffValleyEnvironment,
  createDesignIntentV1,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "@openvibecoaster/simulator";
test("directed footprint infeasible returns relaxationEvidence, feasible honors gates", () => {
  const env = createCliffValleyEnvironment();
  const tinyFootprint = [
    [-50, 0, -50],
    [50, 0, -50],
    [50, 0, 50],
    [-50, 0, 50],
  ] as unknown as import("@openvibecoaster/core").Vec3[];
  const infeasible = generateCoaster(
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 3,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [{ id: "g-0", position: [0, 0, 50] }],
      targets: [],
      constraints: [
        { id: "c-fp", kind: "required-footprint", value: "tiny", hard: true },
      ],
      footprint: tinyFootprint,
      pinnedElementIds: [],
    }),
    { environment: env },
  );
  expect(infeasible.feasible).toBe(false);
  expect(infeasible.relaxationEvidence.length).toBeGreaterThan(0);
  expect(infeasible.relaxationEvidence[0]!.rerun).toBe(true);
});
test("record summit aligns with the ridge seed within one cliff wavelength (no exact-980 authority)", () => {
  const env = createCliffValleyEnvironment();
  const g = generateCoaster(
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 11,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    }),
    {
      environment: env,
      profileVersion: "record-targets-v1",
      researchSnapshotIds: ["records-2026-09-01"],
    },
  );
  const zones = operationZonesFromCoasterFile(g.file);
  const summit = zones.find((z) => z.id === "brake-007")!;
  const centerS = (summit.startDistanceM + summit.endDistanceM) / 2;
  // centerS is arc-length s (m along track), never world Z: look up the compiled
  // position at centerS via distances/positions lerp to (sx,sy,sz), then assert
  // in world coordinates. summitHoldWindow stays the s-domain dwell authority
  // only (Task 08 hold proof), never terrain alignment authority.
  const positions = g.track.positions;
  const distances = g.track.distances;
  let k = 0;
  while (k + 1 < distances.length && distances[k + 1]! < centerS) k += 1;
  const j = Math.min(k + 1, distances.length - 1);
  const s0 = distances[k]!;
  const s1 = distances[j]!;
  const t = s1 > s0 ? (centerS - s0) / (s1 - s0) : 0;
  const sx = positions[k * 3]! * (1 - t) + positions[j * 3]! * t;
  const sz = positions[k * 3 + 2]! * (1 - t) + positions[j * 3 + 2]! * t;
  // One cliff wavelength (sigma = 120) in world Z, not s === 980.
  expect(Math.abs(sz - 980)).toBeLessThanOrEqual(120);
  expect(env.heightAt(sx, sz)).toBeGreaterThanOrEqual(224.4);
});
```

**RED CI:** `npm run test -- packages/core/src/environments/cliff-valley.test.ts` expect `FAIL` with `Cannot find module .../cliff-valley.js` before files exist; `npm run test -- packages/generator/src/clearance-cliff.test.ts` expect throw-free web import to fail the boundary scan until the `apps/web` import is removed.

**GREEN implementation:** Implement `createCliffValleyEnvironment()` in pure `packages/core` per the formula above (`980` stays the ridge placement seed only); re-export from `packages/core/src/index.ts`; make `apps/web/src/terrain/environment.ts` delegate `"cliff-valley-v1"` to the core factory and throw on unknown. Wire the pipeline to consume the injected `options.environment: EnvironmentQuery` only (never import web terrain). Track-to-terrain alignment is proven by the brake-007-center ±120 m assert in `gates-pins.test.ts`, never by equating summit `s` with `980`. Keep spatial-index and `maxWork` budget checks; never lower validation fidelity.

**Focused CI:** `npm run test -- packages/core/src/environments/cliff-valley.test.ts packages/generator/src/clearance-cliff.test.ts packages/generator/src/gates-pins.test.ts apps/web/src/terrain/environment.test.ts`.

**Static review:** Read `packages/core/src/environments/cliff-valley.ts:1`, verify no Three.js/DOM/WebAudio import; read `apps/web/src/terrain/environment.ts:72`, verify delegation plus strict throw and no heightfield formula duplicated; grep `apps/web` under `packages/generator/src` returns zero matches; read `packages/generator/src/clearance-field.ts:327` signature usage.

**Commit:** `feat(environment): widen cliff-valley terrain and wire directed gates/clearance`

### Task 08 — Measured record validation from compiled geometry and RideTimeline (defines localHeightForKind before use)

- [ ] Truthful validation plus force achievement, timeline-dwell hold, rollback, energy/brake, zones (no generator import in simulator package)

**Files:**

- Create `packages/simulator/src/record-validation.ts` (pure: imports only `@openvibecoaster/core` + `./timeline.js` types; defines `localHeightForKind` and `summitHoldWindow` first, then `validateRecordTargets(track, timeline, file, profile, holdProof?)` with NO `frames` parameter — hold uses timeline dwell, see Produced)
- Edit `packages/simulator/src/index.ts` (re-export new module next to `export * from "./engineering-limits";` at `:35-36`)
- Edit `apps/web/src/engineering/worker.ts:231` (`simulateForTrack` augmentation point; compute timeline-dwell hold + record diagnostics in `handleGenerate` (`:281`)/`handleRegenerate` (`:422`)`handleCompileSimulate` before success check; success payload carries numeric `holdSeconds`/`holdLocationS` minimal proof, never `frames`)
- Create `packages/simulator/src/record-validation.unit.test.ts` (synthetic `RideTimeline` only; zero generator imports — preserves `generator → simulator` direction per `simulator/package.json:10-12` → `generator/package.json:11-14`)
- Create `packages/generator/src/record-validation.integration.test.ts` (real `compileSemanticChain`/`generateCoaster` + `simulateRide`; owns all generator imports)
- Create `packages/generator/src/energy-launch-brake.test.ts` (generator-side; real work integrals + brake sizing from Task 06 §Energy)
- Create `packages/generator/src/hold-rollback.integration.test.ts` (generator-side; zone-derived timeline-dwell hold + latched-`stall` full-frame cross-check + rollback ordering on non-compact simulation)

**Consumed interfaces:** `CompiledTrackData { positions, distances, elementIndices, elementBoundaries, totalLength }` (`packages/core/src/track.ts:297-313` — numeric arrays only, no kind/spanId array; getters copy per `:676-712`, so cache `const positions = track.positions; const distances = track.distances;` once); `CoasterFileV1 { intent.elements, solvedSpans }` (`packages/core/src/coaster-file.ts:559-609`); `RideTimeline { length, headDistanceM, speedMps, verticalG, lateralG, longitudinalG, jerkMps3, rollRateRadPerSec, bankRad, accumulatedDriveWorkJ, accumulatedLossWorkJ, kineticEnergyJ, potentialEnergyJ, timeSeconds }` (`packages/simulator/src/timeline.ts:298-329`; `toTransferable` 28 buffers at `:562-599`, `TIMELINE_CURRENT_BUFFER_COUNT = 28` / legacy 11 at `:47-48`); `SimulatorConfig` with `train: { cars: [{ massKg: 1500, seatCount: 4 } × 6], spacingM: 3.4, envelope: { halfWidthM: 1.25, aboveRailM: 2.1, belowRailM: 0.8, noseTailMarginM: 0.75 } }` and top-level `gravityMps2: 9.80665, fixedStepSeconds: 1/240, timelineStepSeconds: 1/120, rollingResistanceCoefficient: 0.002, staticStictionCoefficient: 0.002, dragCdA: 4, airDensityKgPerM3: 1.225, lsmForcePerCarN: 14000, lsmPowerPerCarW: 1200000, lsmTargetGainNPerMps: 2000, maxBrakeForcePerCarN: 18000` (`packages/simulator/src/contracts.ts:35-59`, `index.ts:42-70`); `RecordTargetProfile` (Task 01); `Diagnostic { code, severity, provenance, actual, limit, margin, location, relatedIds }` (`packages/core/src/contracts.ts:82`); `createDefaultSimulatorConfig`/`simulateRide` (`packages/simulator/src/index.ts:42`/`1871` with the `compactTimeline` flag read at `:2328`); `operationZonesFromCoasterFile` (`packages/simulator/src/operation-zones.ts:25-96`); `compileSemanticChain` (`packages/generator/src/solver.ts`) / `ownerForSpan` (`pipeline.ts:443-456`) / `elementBoundaries` layout (pairs written at `track.ts:743-774` for fixed sampling and `:1252-1259` for adaptive sampling, validated at `:489-515`: `elementBoundaries[2*i]/[2*i+1]` are start/end sample indices per compiled element).

**Produced interfaces (helper defined before use):** `export function localHeightForKind(track: CompiledTrackData, file: CoasterFileV1, kind: "topHat" | "immelmann" | "verticalLoop" | "diveDrop"): { deltaM: number; maxY: number; minY: number; s: number; relatedIds: string[] }` — for each compiled element index `i`, slice samples `[elementBoundaries[2*i], elementBoundaries[2*i+1]]`, join via `file.solvedSpans` order → owner id (strip `#n` via `ownerForSpan`, `pipeline.ts:443-456`) → `file.intent.elements` kind; over the union of slices whose owner kind matches, compute `maxY/minY/deltaM = maxY − minY` and `s = distances[argmaxY]`. Global `RECORD_HEIGHT` separately uses `max(track.positions[Y])` over all samples. `export function summitHoldWindow(file: CoasterFileV1, trainFootprintM = 18.5): { centerS: number; toleranceM: number }` (defined alongside `localHeightForKind`, before `validateRecordTargets`) is the single dwell-window authority replacing every hardcoded `980` summit station, `60 m` test window, and `2 m` worker window: `centerS` is the midpoint of the `brake-007` operation zone from `operationZonesFromCoasterFile(file)` (physical span-length cumulative distances, never `s ≈ 980`); `toleranceM` is half the zone length plus the train footprint (`(cars − 1) × spacingM + 2 × noseTailMarginM = 5 × 3.4 + 2 × 0.75 = 18.5 m` from `createDefaultSimulatorConfig`, ≈36 m total on the record route with the 35 m `brake-007` zone). `record-validation.ts`, the worker pre-transfer dwell, and every Task 08 sketch call this helper verbatim with no literal summit station or width. `export function validateRecordTargets(track, timeline, file, profile, holdProof?: { holdSeconds: number; holdLocationS: number }): readonly Diagnostic[]` (NO `frames` parameter — compact worker has `frames: []`; hold uses timeline dwell, see below) emits `error` diagnostics with `provenance: "PROJECT_ENGINEERING_LIMIT"`, `actual/limit/margin`, `location.s`, `relatedIds` for: `RECORD_LENGTH` (totalLength outside [5200, 5400]), `RECORD_HEIGHT` (global max Y outside [225, 235]), `RECORD_SPEED` (max `timeline.speedMps` outside [79.16, 81.94]), `RECORD_INVERSION` (`localHeightForKind(topHat).deltaM` outside [90, 92]), `RECORD_IMMELMANN` (deltaM outside [80, 82]), `RECORD_LOOP` (deltaM outside [66, 68]), `RECORD_DIVE_HEIGHT` (diveDrop deltaM outside 207–213), `RECORD_DIVE_ANGLE` (mid-drop tangent angle outside 108.5–111.5°), `RECORD_FORCE_PEAK_POS` (max verticalG outside [4.8, 5.0]), `RECORD_FORCE_NEG` (min verticalG outside [-1.2, -1.0]: fails when `min > -1.0` with `actual: min, limit: -1.0, margin: min + 1.0` meaning never reaches the about -1.1 achievement, or when `min < -1.2` with `actual: min, limit: -1.2` meaning the hard project floor is breached), `RECORD_FORCE_LAT` / `RECORD_FORCE_LONG` (|max| > 1.5), `RECORD_JERK` (max jerk magnitude > 15), `RECORD_ROLL` (max |rollRate| > 1.5), `HOLD_DURATION` (no continuous timeline dwell ≥ 3 s with `speedMps ≤ 0.05` and `|headDistanceM − centerS| ≤ toleranceM` from the single zone-derived `summitHoldWindow(file)` helper inside the summit `brake-007` zone at 1/120 s sampling, i.e. ≥ 360 consecutive timeline samples; worker computes `holdSeconds`/`holdLocationS` pre-transfer from the full timeline with the same helper and passes them as `holdProof`, validator asserts `holdProof.holdSeconds ≥ 3`, never scans `frames`; full-frame summit evidence separately accepts the authoritative latched `stall` dwell per the `hasStalled` latch (`packages/simulator/src/index.ts:2095-2099`), never post-stall `static-hold`), `ENERGY_LSM_REQUIRED_WORK` (drive work exceeds `1.2MW × 6 × launch duration` or 285 km/h unreachable without invented power — Task 06 §Energy numbers), `BRAKE_MARGIN` (terminal `endSpeed > 0.2 m/s`). It never reads authored `parameters.height` as proof. ASTM is untouched (`UNKNOWN_UNCONFIGURED` per `f2291-26.json:12-15`).

**Test sketches (no fakes; unit in simulator with synthetic timelines, integration in generator with real compile + simulate):**

```ts
// packages/simulator/src/record-validation.unit.test.ts
// NO generator import here (direction generator → simulator preserved).
// Synthetic minimal track/file shapes (as never) test force/hold boundaries only;
// full CompiledTrackData/CoasterFileV1 shapes are covered generator-side in
// record-validation.integration.test.ts.
import { test, expect } from "vitest";
import { RideTimeline } from "./timeline.js";
import {
  validateRecordTargets,
  localHeightForKind,
} from "./record-validation.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
// Duration-boundary placeholder only: synthetic timelines never enter a summit
// zone, so this location carries no summit claim. Every route-derived test below
// uses summitHoldWindow(g.file) for both centerS and toleranceM.
const SYNTH_HOLD_S = 0;
const synthTimeline = (
  verticalG: number[],
  speedMps?: number[],
): RideTimeline => {
  const n = verticalG.length;
  const ones = (v: number): Float64Array =>
    new Float64Array(Array.from({ length: n }, () => v));
  return new RideTimeline({
    sampleRateHz: 120,
    timeSeconds: ones(0).map((_, i) => i / 120),
    headDistanceM: ones(10),
    speedMps: speedMps ? new Float64Array(speedMps) : ones(30),
    verticalG: new Float64Array(verticalG),
    lateralG: ones(0),
    longitudinalG: ones(0),
    jerkMps3: ones(0),
    rollRateRadPerSec: ones(0),
    accumulatedDriveWorkJ: ones(0),
    kineticEnergyJ: ones(0),
    potentialEnergyJ: ones(0),
  });
};
test("RECORD_FORCE_NEG: -0.5 fails (never reaches achievement), -1.1 passes, -1.3 fails (breaches floor)", () => {
  const track = {
    totalLength: 5300,
    positions: new Float64Array([0, 230, 0]),
    distances: new Float64Array([0]),
  } as never;
  const file = { intent: { elements: [] }, solvedSpans: [] } as never;
  const weak = validateRecordTargets(
    track,
    synthTimeline([-0.5]),
    file,
    profile as never,
    { holdSeconds: 3, holdLocationS: SYNTH_HOLD_S },
  );
  expect(
    weak.some(
      (d) =>
        d.code === "RECORD_FORCE_NEG" && d.actual === -0.5 && d.limit === -1.0,
    ),
  ).toBe(true);
  const good = validateRecordTargets(
    track,
    synthTimeline([-1.1]),
    file,
    profile as never,
    { holdSeconds: 3, holdLocationS: SYNTH_HOLD_S },
  );
  expect(good.some((d) => d.code === "RECORD_FORCE_NEG")).toBe(false);
  const breach = validateRecordTargets(
    track,
    synthTimeline([-1.3]),
    file,
    profile as never,
    { holdSeconds: 3, holdLocationS: SYNTH_HOLD_S },
  );
  const neg = breach.filter((d) => d.code === "RECORD_FORCE_NEG");
  expect(neg.length).toBeGreaterThan(0);
  expect(neg[0]!.actual).toBe(-1.3);
  expect(neg[0]!.limit).toBe(-1.2);
  for (const d of [...weak, ...breach])
    if (d.code === "RECORD_FORCE_NEG") {
      expect(d.severity).toBe("error");
      expect(d.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
      expect(typeof d.margin).toBe("number");
    }
});
test("HOLD_DURATION uses timeline dwell proof, not frames: 2.9 s fails, 3.0 s passes", () => {
  const track = {
    totalLength: 5300,
    positions: new Float64Array([0, 230, 0]),
    distances: new Float64Array([0]),
  } as never;
  const file = { intent: { elements: [] }, solvedSpans: [] } as never;
  const tl = synthTimeline(Array.from({ length: 120 }, () => 0));
  expect(
    validateRecordTargets(track, tl, file, profile as never, {
      holdSeconds: 2.9,
      holdLocationS: SYNTH_HOLD_S,
    }).some((d) => d.code === "HOLD_DURATION"),
  ).toBe(true);
  expect(
    validateRecordTargets(track, tl, file, profile as never, {
      holdSeconds: 3,
      holdLocationS: SYNTH_HOLD_S,
    }).some((d) => d.code === "HOLD_DURATION"),
  ).toBe(false);
});
```

```ts
// packages/generator/src/record-validation.integration.test.ts
import { test, expect } from "vitest";
import { compileSemanticChain } from "./solver.js";
import { generateCoaster } from "./pipeline.js";
import { createElement } from "./elements.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  simulateRide,
} from "@openvibecoaster/simulator";
import {
  localHeightForKind,
  summitHoldWindow,
  validateRecordTargets,
} from "@openvibecoaster/simulator";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
const RECORD_OPTS = {
  profileVersion: "record-targets-v1",
  researchSnapshotIds: ["records-2026-09-01"],
} as const;
// Synthetic hold location for intent-cheat tests only (duration proof, no summit
// claim); every route-derived dwell below uses summitHoldWindow(g.file).
const CHEAT_HOLD_S = 0;
test("localHeightForKind measures compiled local delta for 80 m and 91 m topHats (track samples, getter cached once)", () => {
  const low = compileSemanticChain([
    createElement("topHat", "topHat-000", { height: 80, width: 60, bank: 0 }),
  ]);
  expect(low.feasible).toBe(true);
  const lowFile = {
    intent: {
      elements: [
        {
          id: "topHat-000",
          kind: "topHat",
          type: "topHat",
          parameters: { height: 80, width: 60, bank: 0 },
        },
      ],
    },
    solvedSpans: low.solvedSpans.map((s) => ({
      id: s.id,
      kind: "topHat",
      positionCoefficients: s.positionCoefficients,
      rollCoefficients: s.rollCoefficients,
      length: s.length,
    })),
  } as unknown as import("@openvibecoaster/core").CoasterFileV1;
  const lowM = localHeightForKind(low.track!, lowFile, "topHat");
  expect(Math.abs(lowM.deltaM - 80)).toBeLessThanOrEqual(1);
  expect(lowM.s).toBeGreaterThanOrEqual(0);
  expect(lowM.s).toBeLessThanOrEqual(low.track!.totalLength);
  const high = compileSemanticChain([
    createElement("topHat", "topHat-011", { height: 91, width: 60, bank: 0 }),
  ]);
  expect(high.feasible).toBe(true);
  const highFile = {
    intent: {
      elements: [
        {
          id: "topHat-011",
          kind: "topHat",
          type: "topHat",
          parameters: { height: 91, width: 60, bank: 0 },
        },
      ],
    },
    solvedSpans: high.solvedSpans.map((s) => ({
      id: s.id,
      kind: "topHat",
      positionCoefficients: s.positionCoefficients,
      rollCoefficients: s.rollCoefficients,
      length: s.length,
    })),
  } as unknown as import("@openvibecoaster/core").CoasterFileV1;
  const highM = localHeightForKind(high.track!, highFile, "topHat");
  expect(highM.deltaM).toBeGreaterThanOrEqual(90);
  expect(highM.deltaM).toBeLessThanOrEqual(92);
  expect(highM.s).toBeGreaterThanOrEqual(0);
  expect(highM.s).toBeLessThanOrEqual(high.track!.totalLength);
});
test("authored-cheat both directions: geometry rules, intent never proves", () => {
  const built80 = compileSemanticChain([
    createElement("topHat", "topHat-011", { height: 80, width: 60, bank: 0 }),
  ]);
  expect(built80.feasible).toBe(true);
  const cheatFile = {
    intent: {
      elements: [
        {
          id: "topHat-011",
          kind: "topHat",
          type: "topHat",
          parameters: { height: 91, width: 60, bank: 0 },
        },
      ],
    },
    solvedSpans: built80.solvedSpans.map((s) => ({
      id: s.id,
      kind: "topHat",
      positionCoefficients: s.positionCoefficients,
      rollCoefficients: s.rollCoefficients,
      length: s.length,
    })),
  } as unknown as import("@openvibecoaster/core").CoasterFileV1;
  const cheatM = localHeightForKind(built80.track!, cheatFile, "topHat");
  expect(Math.abs(cheatM.deltaM - 80)).toBeLessThanOrEqual(1);
  const g = generateCoaster(
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 42,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    }),
    RECORD_OPTS,
  );
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, {
    durationSeconds: 60,
    config: { ...cfg, zones: [] },
    initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 5 },
  });
  const diags = validateRecordTargets(
    built80.track!,
    sim.timeline,
    cheatFile,
    profile,
    { holdSeconds: 3, holdLocationS: CHEAT_HOLD_S },
  );
  const inversion = diags.filter((d) => d.code === "RECORD_INVERSION");
  expect(inversion.length).toBeGreaterThan(0);
  expect(inversion[0]!.severity).toBe("error");
  expect(inversion[0]!.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
  expect(inversion[0]!.actual).toBeLessThan(90);
  expect(inversion[0]!.limit).toBe(90);
  expect(typeof inversion[0]!.margin).toBe("number");
  expect(inversion[0]!.relatedIds).toContain("topHat-011");
  // Reverse control: geometry 91 m with intent 80 m must still PASS (intent never gates).
  const built91 = compileSemanticChain([
    createElement("topHat", "topHat-011", { height: 91, width: 60, bank: 0 }),
  ]);
  const humbleFile = {
    intent: {
      elements: [
        {
          id: "topHat-011",
          kind: "topHat",
          type: "topHat",
          parameters: { height: 80, width: 60, bank: 0 },
        },
      ],
    },
    solvedSpans: built91.solvedSpans.map((s) => ({
      id: s.id,
      kind: "topHat",
      positionCoefficients: s.positionCoefficients,
      rollCoefficients: s.rollCoefficients,
      length: s.length,
    })),
  } as unknown as import("@openvibecoaster/core").CoasterFileV1;
  expect(
    localHeightForKind(built91.track!, humbleFile, "topHat").deltaM,
  ).toBeGreaterThanOrEqual(90);
  expect(
    validateRecordTargets(built91.track!, sim.timeline, humbleFile, profile, {
      holdSeconds: 3,
      holdLocationS: CHEAT_HOLD_S,
    }).filter((d) => d.code === "RECORD_INVERSION").length,
  ).toBe(0);
});
test("dive angle boundaries 108.5/110/111.5 enforced from compiled tangent", () => {
  const g = generateCoaster(
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 42,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    }),
    RECORD_OPTS,
  );
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, {
    durationSeconds: 60,
    config: { ...cfg, zones: [] },
    initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 5 },
  });
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, {
    holdSeconds: 3,
    holdLocationS: summitHoldWindow(g.file).centerS,
  });
  expect(diags.filter((d) => d.code === "RECORD_DIVE_ANGLE").length).toBe(0);
  expect(diags.filter((d) => d.code === "RECORD_DIVE_HEIGHT").length).toBe(0);
});
```

```ts
// packages/generator/src/energy-launch-brake.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  operationZonesFromCoasterFile,
  simulateRide,
} from "@openvibecoaster/simulator";
import {
  summitHoldWindow,
  validateRecordTargets,
} from "@openvibecoaster/simulator";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("launch work and brake margin measured from timeline; zones inside compiled length", () => {
  const g = generateCoaster(
    createDesignIntentV1({
      generatorVersion: "record-g",
      seed: 42,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    }),
    {
      profileVersion: "record-targets-v1",
      researchSnapshotIds: ["records-2026-09-01"],
    },
  );
  const zones = operationZonesFromCoasterFile(g.file);
  for (const z of zones) {
    expect(z.endDistanceM).toBeLessThanOrEqual(g.track.totalLength);
    expect(z.startDistanceM).toBeLessThan(z.endDistanceM);
  }
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(g.track, {
    durationSeconds: 180,
    config: { ...cfg, zones },
    initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 0 },
  });
  // Timeline-dwell hold proof for the worker path (compact has no frames),
  // using the single zone-derived summitHoldWindow (no 980/60/2 literals):
  const dwell = (() => {
    let run = 0;
    let best = 0;
    const speed = sim.timeline.speedMps;
    const head = sim.timeline.headDistanceM;
    const { centerS: summitCenterS, toleranceM: summitToleranceM } =
      summitHoldWindow(g.file);
    for (let i = 0; i < sim.timeline.length; i += 1) {
      const inSummit = Math.abs(head[i]! - summitCenterS) <= summitToleranceM;
      run = speed[i]! <= 0.05 && inSummit ? run + 1 / 120 : 0;
      if (run > best) best = run;
    }
    return best;
  })();
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, {
    holdSeconds: dwell,
    holdLocationS: summitHoldWindow(g.file).centerS,
  });
  const energy = diags.filter((d) => d.code === "ENERGY_LSM_REQUIRED_WORK");
  expect(energy.length).toBe(0);
  // Real energy numbers (Task 06 §Energy): drop E = 9000×9.80665×210 ≈ 18.53 MJ;
  // 79.16 m/s KE = ½×9000×79.16² ≈ 28.20 MJ, so LSM must supply ≈9.7 MJ + losses.
  const driveWork =
    sim.timeline.accumulatedDriveWorkJ[sim.timeline.length - 1]!;
  expect(Number.isFinite(driveWork)).toBe(true);
  expect(driveWork).toBeGreaterThan(9_000_000);
  expect(driveWork).toBeLessThanOrEqual(7.2e6 * 180);
  const maxSpeed = Math.max(...Array.from(sim.timeline.speedMps));
  expect(maxSpeed).toBeGreaterThanOrEqual(79.16 - 1e-6);
  expect(maxSpeed).toBeLessThanOrEqual(81.94 + 1e-6);
  // Braking: 81.94 m/s at ≈12 m/s² (108 kN/9000 kg) needs d = v²/2a ≈ 280 m;
  // brake-017 (140 m) + brake-018 (320 m) = 460 m ≥ 280 m + 64% margin.
  expect(diags.filter((d) => d.code === "BRAKE_MARGIN").length).toBe(0);
  const lastSpeed = sim.timeline.speedMps[sim.timeline.length - 1]!;
  expect(lastSpeed).toBeLessThanOrEqual(0.2 + 1e-6);
});
```

````ts
// packages/generator/src/hold-rollback.integration.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "./pipeline.js";
import { compileTrack, createDesignIntentV1, SeventhOrderHermiteSpan, vec3 } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, operationZonesFromCoasterFile, simulateRide } from "@openvibecoaster/simulator";
import { summitHoldWindow, validateRecordTargets } from "@openvibecoaster/simulator";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
test("3 s summit hold proved by transferable-timeline dwell (compact-safe) plus latched stall cross-check", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }), { profileVersion: "record-targets-v1", researchSnapshotIds: ["records-2026-09-01"] });
  const cfg = createDefaultSimulatorConfig();
  const zones = operationZonesFromCoasterFile(g.file);
  const sim = simulateRide(g.track, { durationSeconds: 180, config: { ...cfg, zones }, initial: { headDistanceM: cfg.train.spacingM * 5, speedMps: 0 } });
  // Compact-safe proof: timeline dwell at 1/120 s (≥ 360 samples for 3 s),
  // using the single zone-derived summitHoldWindow (no 980/60/2 literals).
  const { centerS: summitCenterS, toleranceM: summitToleranceM } = summitHoldWindow(g.file);
  let run = 0;
  let maxDwell = 0;
  for (let i = 0; i < sim.timeline.length; i += 1) {
    const inSummit = Math.abs(sim.timeline.headDistanceM[i]! - summitCenterS) <= summitToleranceM;
    run = sim.timeline.speedMps[i]! <= 0.05 && inSummit ? run + 1 / 120 : 0;
    maxDwell = Math.max(maxDwell, run);
  }
  expect(maxDwell).toBeGreaterThanOrEqual(3);
  // Full-simulation cross-check (non-compact frames exist here; worker never transfers them).
  // Authoritative hasStalled latch (simulator/src/index.ts:2095-2099): the first summit
  // zero-speed frame after the rolling approach is stall (statusFor at :1153-1154 returns
  // stall whenever previousSpeed != 0), and every later zero-speed frame stays stall — so
  // post-stall static-hold frames are unachievable here by design. Accept the latched stall
  // dwell; the timeline dwell above separately proves 3 s of near-zero dwell.
  let stallRun = 0;
  let maxStall = 0;
  for (const f of sim.frames) {
    stallRun = f.status === "stall" ? stallRun + 1 / 240 : 0;
    maxStall = Math.max(maxStall, stallRun);
  }
  expect(maxStall).toBeGreaterThanOrEqual(3);
  const statuses = new Set(sim.frames.map((f) => f.status));
  expect(statuses.has("rolling")).toBe(true);
  expect(statuses.has("stall")).toBe(true);
  const stallFrames = sim.frames.filter((f) => f.status === "stall");
  expect(stallFrames.length).toBeGreaterThanOrEqual(720);
  expect(stallFrames[0]!.speedMps).toBe(0);
  const diags = validateRecordTargets(g.track, sim.timeline, g.file, profile, { holdSeconds: maxDwell, holdLocationS: summitCenterS });
  expect(diags.filter((d) => d.code === "HOLD_DURATION").length).toBe(0);
});
test("insufficient launch proves rolling -> stall -> rollback -> reversal on an uphill grade", () => {
  const uphill = compileTrack([{ id: "uphill", span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 20, 100)) }], { samples: 65 });
  const cfg = createDefaultSimulatorConfig();
  const sim = simulateRide(uphill, { durationSeconds: 6, config: { ...cfg, zones: [] }, initial: { headDistanceM: 20, speedMps: 6 } });
  const statuses = sim.frames.map((f) => f.status);
  const firstRolling = sim.frames.find((f) => f.status === "rolling")!;
  expect(firstRolling.speedMps).toBeGreaterThan(0);
  const stall = sim.frames.find((f) => f.status === "stall")!;
  expect(stall.speedMps).toBe(0);
  expect(stall.timeSeconds).toBeGreaterThan(firstRolling.timeSeconds);
  const rollback = sim.frames.find((f) => f.status === "rollback" || f.status === "reversal")!;
  expect(rollback.timeSeconds).toBeGreaterThan(stall.timeSeconds);
  expect(rollback.headDistanceM).toBeLessThan(stall.headDistanceM);
  const last = sim.frames[sim.frames.length - 1]!;
  expect(last.speedMps).toBeLessThan(0);
  expect(statuses).toContain("stall");
  expect(statuses.some((s) => s === "rollback" || s === "reversal")).toBe(true);
});
test("controlled restart after rollback returns to rolling with positive speed under LSM drive", () => {
  const uphill = compileTrack([{ id: "uphill", span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 20, 100)) }], { samples: 65 });
  const cfg = createDefaultSimulatorConfig();
  const restartZones = [{ id: "restart-launch", kind: "launch" as const, startDistanceM: 0, endDistanceM: uphill.totalLength, targetSpeedMps: 12 }] as const;
  const sim = simulateRide(uphill, { durationSeconds: 10, config: { ...cfg, zones: [...restartZones] }, initial: { headDistanceM: 20, speedMps: -2 } });
  const reversalOrRollback = sim.frames.find((f) => f.status === "rollback" || f.status === "reversal" || f.speedMps < 0);
  expect(reversalOrRollback).toBeDefined();
  const restarted = sim.frames.slice(sim.frames.indexOf(reversalOrRollback!)).find((f) => f.status === "rolling" && f.speedMps > 0)!;
  expect(restarted).toBeDefined();
  expect(restarted.timeSeconds).toBeGreaterThan(reversalOrRollback!.timeSeconds);
  expect(restarted.headDistanceM).toBeGreaterThanOrEqual(0);
  expect(restarted.headDistanceM).toBeLessThanOrEqual(uphill.totalLength);
  const last = sim.frames[sim.frames.length - 1]!;
  expect(last.speedMps).toBeGreaterThan(0);
});

**RED CI:** `npm run test -- packages/simulator/src/record-validation.unit.test.ts` expect missing module `record-validation.js` before this task; `npm run test -- packages/generator/src/record-validation.integration.test.ts` expect `Unknown element kind: diveDrop` before Tasks 02–05.

**GREEN implementation:** Implement `record-validation.ts` with `localHeightForKind` first (cache `positions`/`distances`/`elementIndices`/`elementBoundaries` getters once; iterate `distances.length` samples, read Y from `positions[i*3+1]`, map sample → compiled element via `elementBoundaries` pairs, join compiled order → `file.solvedSpans` order → owner id via `ownerForSpan` strip `#n` → `file.intent.elements` kind; per-kind `deltaM/maxY/minY/s/relatedIds`). Derive dive delta/angle from the consecutive `diveDrop` slice union (top Y minus bottom Y; mid-tangent pitch `atan2(dY, hypot(dX, dZ))` at normalized mid of the middle span). Compute timeline extrema from `timeline.speedMps/verticalG/lateralG/longitudinalG/jerkMps3/rollRateRadPerSec` plus work integrals from `accumulatedDriveWorkJ`/`accumulatedLossWorkJ`/`kineticEnergyJ`/`potentialEnergyJ`; hold from `holdProof.holdSeconds ≥ 3` (worker computes dwell pre-transfer with the same `summitHoldWindow(file)` helper: longest run with `speedMps ≤ 0.05` and `|headDistanceM − centerS| ≤ toleranceM` at 1/120 s; minimal numeric proof, never `frames`; full-frame summit evidence accepts the authoritative latched `stall` dwell per the `hasStalled` latch at `packages/simulator/src/index.ts:2095-2099`, never post-stall `static-hold`). Wire into `handleGenerate`/`handleRegenerate`/`handleCompileSimulate` merging diagnostics before the success check. Never invent labels; UI truth comes from `recordDiagnostics.length === 0`.

**Focused CI:** `npm run test -- packages/simulator/src/record-validation.unit.test.ts packages/generator/src/record-validation.integration.test.ts packages/generator/src/energy-launch-brake.test.ts packages/generator/src/hold-rollback.integration.test.ts`.

**Static review:** Read `packages/simulator/src/record-validation.ts:1`, verify `localHeightForKind` precedes `validateRecordTargets`, signature has NO `frames` parameter, provenance is `PROJECT_ENGINEERING_LIMIT`, no ASTM claim, no authored-param proof; verify `packages/core/src/track.ts:297-313` numeric-only assumption holds; grep `from "@openvibecoaster/generator"` under `packages/simulator/src` returns zero matches (F1 preserved).

**Commit:** `feat(simulator): validate measured record targets from geometry and timeline`

### Task 09 — Worker protocol + ExperienceController truth + DOM pill wiring

- [ ] Target-before-validation UI state, deterministic cancellation/transfer/stale behavior

**Files:**

- Edit `apps/web/src/engineering/protocol.ts:56` (`EngineeringWorkerTimings` unchanged at `:56-59`) and `apps/web/src/engineering/protocol.ts:68-79` (`EngineeringWorkerSuccess` gains `recordValidated: boolean` + `recordDiagnostics: readonly Diagnostic[]` + `holdSeconds: number` + `holdLocationS: number` minimal numeric hold proof); extend strict validation at `protocol.ts:218-233` (timings) and the top-level `allowed` set at `protocol.ts:242-255` for the four new fields with finite/array checks (`recordValidated` boolean, `recordDiagnostics` array, `holdSeconds` finite ≥ 0, `holdLocationS` finite)
- Edit `apps/web/src/engineering/worker.ts:231-279` (`simulateForTrack` with `compactTimeline: true` at `:262-267`, returns `timeline` + local `frames` but `handleGenerate` at `:403-419` drops frames) and `handleGenerate` (`:281`), `handleRegenerate` (`:422`), `handleCompileSimulate` (`:573`) to compute timeline-dwell `holdSeconds`/`holdLocationS` pre-transfer with the Task 08 `summitHoldWindow(file)` helper plus `recordDiagnostics` via Task 08 (no `frames` scan) and include all four fields in every success payload before the success check
- Edit `apps/web/src/engineering/hydrate.ts:17-60` (`hydrateEngineeringSuccess`: after `validateEngineeringWorkerResponse`, propagate `recordValidated` by value plus frozen deep copies of `recordDiagnostics` (same freeze/copy discipline as `diagnostics` at `:84-107`: fresh array, per-entry frozen copies with frozen `location`/`relatedIds`) and finite `holdSeconds`/`holdLocationS` numbers; require `typeof recordValidated === "boolean"`, array `recordDiagnostics`, finite `holdSeconds ≥ 0` and finite `holdLocationS` — throw otherwise, never default or alias the worker response)
- Edit `apps/web/src/engineering/client.ts:12` (`CLOCK_SKEW_TOLERANCE_MS = 5`, no logic change in this task) and `client.ts:373-394` (receipt path: `transferMs = receiptEpochMs − workerSendEpochMs`, reject `clock-skew` when `< −5`, clamp `max(0, transferMs)` within tolerance; tests pin this path, see below)
- Edit `apps/web/src/experienceController.ts:25-33` (`AuthoritativeExperienceResult` gains `recordValidated: boolean` + `recordDiagnostics: readonly Diagnostic[]` + `holdSeconds: number` + `holdLocationS: number`) and `experienceController.ts` `validateResult` (still checks `CompiledTrackData` instance, aligned `Float64Array` timeline, `clearanceM.length === timeline.length`, non-empty `spanHashes`, canonical file/checksum path per `hydrate.ts:47-59`, epoch stale-rejection)
- Create `apps/web/src/app/recordStatus.ts` (new helper defined before use: `export function recordStatusLabel(recordValidated: boolean): "record target" | "validated project record"`)
- Edit `apps/web/src/main.ts:76` (DOM wiring: render `[data-testid="record-target-pill"]` with `"record target"` plus exact shortfall list when `recordValidated === false`, and `[data-testid="record-validated-pill"]` with `"validated project record"` only when true; shortfalls come from `recordDiagnostics` with `actual/limit/margin`)
- Create `apps/web/src/engineering/record-protocol.test.ts`
- Create `apps/web/src/experienceController.record.test.ts`
- Create `apps/web/src/engineering/record-worker-determinism.test.ts`

**Consumed interfaces:** `EngineeringWorkerRequest { generate, regenerate, compile-simulate, cancel }` + `EngineeringWorkerResponse { success, failure, cancelled }` (`apps/web/src/engineering/protocol.ts:37`/`93`); `EngineeringWorkerClient` (`client.ts:67`) with `collectTransferables` (`transfer.ts:6`); `hydrateEngineeringSuccess` (`hydrate.ts:17`) verifying canonical file/checksum path; `ExperienceController` statuses (`experienceController.ts:16`); `RideTimeline.toTransferable()`/`fromTransferable` with 11-legacy / 28-current buffer counts (`timeline.ts:47-48`).

**Produced interfaces:** `EngineeringWorkerSuccess` includes `recordValidated: boolean`, `recordDiagnostics: readonly Diagnostic[]`, `holdSeconds: number`, `holdLocationS: number` (strict: missing or mistyped fields throw; extra top-level fields still rejected). `holdSeconds`/`holdLocationS` are the minimal numeric summit-hold proof computed pre-transfer from the full timeline dwell (never `frames`); `protocol.ts:334-335` still rejects `timeline.frames`. `AuthoritativeExperienceResult` carries the same four fields; `recordStatusLabel(false) === "record target"`, `recordStatusLabel(true) === "validated project record"`. `hydrateEngineeringSuccess` returns the four fields copy-safe: `recordValidated` by value; `recordDiagnostics` as a frozen array of frozen per-entry copies (same discipline as `diagnostics`, so mutating the hydrated array or its entries can never touch the worker response); `holdSeconds`/`holdLocationS` as finite numbers (`NaN`/`Infinity` throw). Worker cancellation stays deterministic (explicit `cancel` termination with epoch-based stale-response rejection; `client.ts:373-394` rejects timestamps more than 5 ms in the future via the receipt path and clamps within tolerance). `clearanceM` stays required finite `Float64Array` with `length === timeline.length`.

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
  expect(res.recordValidated).toBe(res.recordDiagnostics.length === 0);
  expect(typeof res.holdSeconds).toBe("number");
  expect(Number.isFinite(res.holdSeconds)).toBe(true);
  expect(res.holdSeconds).toBeGreaterThanOrEqual(0);
  expect(typeof res.holdLocationS).toBe("number");
  expect(Number.isFinite(res.holdLocationS)).toBe(true);
  expect(res.clearanceM).toBeInstanceOf(Float64Array);
  expect(res.clearanceM.length).toBe(res.timeline.length);
  expect(() => validateEngineeringWorkerResponse(res)).not.toThrow();
  const clone = { ...res } as Record<string, unknown>;
  delete clone.recordValidated;
  expect(() => validateEngineeringWorkerResponse(clone)).toThrow(/recordValidated/);
  const clone2 = { ...res, recordDiagnostics: "bad" } as unknown as Record<string, unknown>;
  expect(() => validateEngineeringWorkerResponse(clone2)).toThrow(/recordDiagnostics/);
  const clone3 = { ...res, holdSeconds: Number.NaN } as unknown as Record<string, unknown>;
  expect(() => validateEngineeringWorkerResponse(clone3)).toThrow(/holdSeconds/);
  expect(recordStatusLabel(false)).toBe("record target");
  expect(recordStatusLabel(true)).toBe("validated project record");
});
````

```ts
// apps/web/src/experienceController.record.test.ts
import { test, expect } from "vitest";
import { createExperienceController } from "./experienceController.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./engineering/worker.js";
import { hydrateEngineeringSuccess } from "./engineering/hydrate.js";
test("controller stays on record target until validated result arrives", () => {
  const ctrl = createExperienceController({
    onGenerate: () => {},
    onLocalRegenerate: () => {},
    onCompileLoad: () => {},
  });
  expect(ctrl.getState().status).toBe("pending");
  expect(ctrl.getState().epoch).toBe(0);
  const intent = createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const res = handleGenerate("req-record-2", intent);
  expect(res.type).toBe("success");
  if (res.type !== "success") return;
  const hydrated = hydrateEngineeringSuccess(res);
  expect(hydrated.track.checksum).toBe(res.track.checksum);
  expect(hydrated.timeline.length).toBe(res.timeline.length);
  expect(hydrated.clearanceM.length).toBe(hydrated.timeline.length);
  expect(hydrated.clearanceM).not.toBe(res.clearanceM);
  // Non-vacuous hydrate→controller record propagation: fails pre-fix because
  // hydrate drops these fields (recordValidated undefined, recordDiagnostics
  // undefined.length throws). Truth relation plus finite hold proof plus no-alias.
  expect(typeof hydrated.recordValidated).toBe("boolean");
  expect(hydrated.recordValidated).toBe(res.recordValidated);
  expect(hydrated.recordValidated).toBe(
    hydrated.recordDiagnostics.length === 0,
  );
  expect(
    Number.isFinite(hydrated.holdSeconds) && hydrated.holdSeconds >= 0,
  ).toBe(true);
  expect(Number.isFinite(hydrated.holdLocationS)).toBe(true);
  expect(hydrated.holdSeconds).toBe(res.holdSeconds);
  expect(hydrated.holdLocationS).toBe(res.holdLocationS);
  expect(Object.isFrozen(hydrated.recordDiagnostics)).toBe(true);
  expect(hydrated.recordDiagnostics).not.toBe(res.recordDiagnostics);
  expect(ctrl.getState().status).toBe("pending");
  expect(ctrl.getState().epoch).toBe(0);
});
```

````ts
// apps/web/src/engineering/record-worker-determinism.test.ts
import { test, expect } from "vitest";
import { RideTimeline } from "@openvibecoaster/simulator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker.js";
import { collectTransferables } from "./transfer.js";
import { EngineeringWorkerClient } from "./client.js";
import { hydrateEngineeringSuccess } from "./hydrate.js";
test("same seed twice is byte-equal across track buffers and timeline transfer", () => {
  const mk = () => createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const a = handleGenerate("req-record-a", mk());
  const b = handleGenerate("req-record-b", mk());
  expect(a.type).toBe("success");
  expect(b.type).toBe("success");
  if (a.type !== "success" || b.type !== "success") return;
  expect(a.track.checksum).toBe(b.track.checksum);
  expect(a.track.totalLength).toBe(b.track.totalLength);
  for (const key of ["positions", "tangents", "normals", "binormals", "distances"] as const) {
    const av = a.track[key] as Float64Array;
    const bv = b.track[key] as Float64Array;
    expect(av.length).toBe(bv.length);
    // Bytewise comparison without Node Buffer (web-safe; Buffer is unavailable in the browser bundle).
    expect(av.byteLength).toBe(bv.byteLength);
    for (let i = 0; i < av.length; i += 1) expect(av[i]).toBe(bv[i]);
  }
  const at = RideTimeline.fromTransferable(a.timeline);
  const bt = RideTimeline.fromTransferable(b.timeline);
  expect(at.length).toBe(bt.length);
  expect(at.speedMps.length).toBe(bt.speedMps.length);
  for (let i = 0; i < at.speedMps.length; i += 1) expect(at.speedMps[i]).toBe(bt.speedMps[i]);
});
test("transfer ownership is deduplicated and hydration copies clearance without aliasing", () => {
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const res = handleGenerate("req-record-3", intent);
  expect(res.type).toBe("success");
  if (res.type !== "success") return;
  const buffers = collectTransferables(res);
  expect(buffers.length).toBeGreaterThan(0);
  expect(new Set(buffers).size).toBe(buffers.length);
  for (const buf of buffers) expect(buf).toBeInstanceOf(ArrayBuffer);
  const hydrated = hydrateEngineeringSuccess(res);
  expect(hydrated.clearanceM.length).toBe(hydrated.timeline.length);
  expect(hydrated.clearanceM).not.toBe(res.clearanceM);
  hydrated.clearanceM[0] = Number.NaN;
  expect(res.clearanceM[0]).not.toBe(Number.NaN);
});
test("cancellation terminates the client and rejects the queued generate", async () => {
  const posted: unknown[] = [];
  let terminated = false;
  const client = new EngineeringWorkerClient(() => ({ postMessage: (m: unknown) => { posted.push(m); }, terminate: () => { terminated = true; } }));
  expect(client.getEpoch()).toBe(0);
  expect(client.isTerminated()).toBe(false);
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const pending = client.generate("req-cancel-1", intent);
  expect(client.getPendingCount()).toBe(1);
  client.cancel("req-cancel-1");
  await expect(pending).rejects.toThrow(/cancelled/i);
  client.teardown();
  expect(client.isTerminated()).toBe(true);
  expect(terminated).toBe(true);
});
test("teardown rejects pending work and stale epochs never resolve", async () => {
  const client = new EngineeringWorkerClient(() => ({ postMessage: () => {}, terminate: () => {} }));
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const p = client.generate("req-stale-1", intent);
  client.teardown();
  await expect(p).rejects.toThrow(/teardown|cancelled/i);
  expect(client.isTerminated()).toBe(true);
  expect(client.getEpoch()).toBe(0);
});
test("future worker timestamp beyond the 5 ms tolerance is rejected by the client receipt path", async () => {
  const { EngineeringWorkerClient } = await import("./client.js");
  const { validateEngineeringWorkerResponse } = await import("./protocol.js");
  const intent = createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] });
  const fresh = handleGenerate("req-fresh", intent);
  expect(fresh.type).toBe("success");
  if (fresh.type !== "success") return;
  // Skewed payload is still schema-valid (validator must NOT throw) so it reaches the client receipt path.
  const skewed = { ...fresh, requestId: "req-skew-1", timings: { ...fresh.timings, workerSendEpochMs: performance.timeOrigin + performance.now() + 50 } };
  expect(() => validateEngineeringWorkerResponse(skewed)).not.toThrow();
  expect(skewed.timings.workerSendEpochMs - (performance.timeOrigin + performance.now())).toBeGreaterThan(5);
  // Drive the client receipt path (client.ts:373-394 via emitMessage, mirroring client.test.ts:572-607):
  // pending generate must reject with clock-skew and be removed.
  const workers: Array<{ emitMessage: (data: unknown) => void; postMessage: (m: unknown) => void; terminate: () => void }> = [];
  const factory = (): { postMessage: (m: unknown) => void; terminate: () => void } => {
    const listeners = new Map<string, Set<(e: MessageEvent) => void>>();
    const worker = {
      postMessage: () => {},
      terminate: () => {},
      addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
        if (!listeners.get(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: MessageEvent) => void) => { listeners.get(type)?.delete(fn); },
      emitMessage: (data: unknown) => {
        const ev = { data } as MessageEvent;
        for (const fn of listeners.get("message") ?? []) fn(ev);
        (worker as { onmessage?: (e: MessageEvent) => void }).onmessage?.(ev);
      },
    };
    workers.push(worker);
    return worker;
  };
  const client = new EngineeringWorkerClient(factory);
  const pending = client.generate("req-skew-1", intent);
  expect(client.getPendingCount()).toBe(1);
  workers[0]!.emitMessage(skewed);
  await expect(pending).rejects.toThrow(/clock-skew/i);
  expect(client.getPendingCount()).toBe(0);
  client.teardown();
});

**RED CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts` expect `recordValidated` missing-field throw before this task; `npm run test -- apps/web/src/experienceController.record.test.ts` expect `hydrated.recordValidated` to be `undefined` (hydrate drops the four fields) before this task; `npm run test -- apps/web/src/engineering/record-worker-determinism.test.ts` expect `Cannot find module .../record-worker-determinism.test.ts` before this task.

**GREEN implementation:** Extend the success type plus both strict `allowed` sets with the four fields (`recordValidated`, `recordDiagnostics`, `holdSeconds`, `holdLocationS`); compute timeline-dwell `holdSeconds`/`holdLocationS` pre-transfer plus `recordDiagnostics` via Task 08 in all three handlers (`handleGenerate`/`handleRegenerate`/`handleCompileSimulate`) and set `recordValidated = recordDiagnostics.length === 0`; extend `AuthoritativeExperienceResult` + `validateResult`; extend `hydrateEngineeringSuccess` (`hydrate.ts:17-60`) to propagate `recordValidated` by value plus frozen `recordDiagnostics` copies and finite `holdSeconds`/`holdLocationS` with throw-on-missing semantics; create `recordStatus.ts` before editing `main.ts`; wire both `data-testid` pills in `main.ts` driven by `recordValidated` with the exact shortfall list (`code + actual/limit/margin`). Keep `collectTransferables` promotion of canonical arrays and epoch stale-rejection intact. Never `JSON.parse(JSON.stringify(...))` a success payload — `Float64Array`/`Uint32Array`/`ArrayBuffer` views do not survive JSON and violate `hydrate.ts:12-16` plus `protocol.ts:234-240/282-288/315-317`.

**Focused CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts apps/web/src/experienceController.record.test.ts apps/web/src/engineering/record-worker-determinism.test.ts apps/web/src/engineering/client.test.ts apps/web/src/engineering/protocol.test.ts`.

**Static review:** Read `apps/web/src/engineering/protocol.ts:242`, verify exactly four new allowed keys (`recordValidated`, `recordDiagnostics`, `holdSeconds`, `holdLocationS`) and no wildcard; read `apps/web/src/engineering/hydrate.ts:17-60`, verify the four fields are propagated copy-safe (frozen `recordDiagnostics` copies, finite hold numbers, throw on missing/mistyped); read `apps/web/src/experienceController.ts` `validateResult`, verify checksum + stale-rejection intact; read `apps/web/src/main.ts`, verify both `data-testid` selectors exist.

**Commit:** `feat(web): wire worker record-validated state and target-vs-validated UI`

### Task 10 — Renderer scale, ride cameras, audio, reduced motion

- [ ] Large-terrain rendering stays `CompiledTrackData`-only with measured cameras/audio

**Files:**

- Edit `apps/web/src/render/controller.ts:97` (`createRendererController`: camera `near: 0.1, far: 8000` when `track.totalLength > 4000`, exponential fog with `floorY = -20`, single `THREE.WebGLRenderer` + single `requestAnimationFrame` preserved)
- Edit `apps/web/src/render/trackGeometry.ts:15` (tessellation from `CompiledTrackData.positions/tangents/normals/binormals` only; segment count derived from `ADAPTIVE_MAX_*`, never an independent spline)
- Edit `apps/web/src/render/supports.ts:14` (`buildSupportColumns(data, env, 10)` unchanged signature; visual-only note)
- Edit `apps/web/src/render/cameras.ts:5` (`front/middle/rear/chase/orbit` consume `RideTimeline`-measured speed/forces via `clampFovForSpeed`/`getCameraState`; `prefers-reduced-motion` disables shake/wind scaling; `CAMERA_FALLBACK_DIAGNOSTIC` on null snapshot)
- Edit `apps/web/src/audio/engine.ts:59-63` (`RideAudioUpdate` gains optional `lateralG?: number` + `verticalG?: number` alongside existing `speedMps`, `zoneMask`, `paused?`; `update()` validates the new fields as finite when present and ignores them when absent so existing speed/zone-only callers keep working; wind/rail/LSM/brake gains scale from measured `speedMps` + `zoneMask` plus `lateralG`/`verticalG` when supplied; mute flag respected)
- Create `apps/web/src/render/large-scale.test.ts`

**Consumed interfaces:** `CompiledTrackData` (`packages/core/src/track.ts`); `RideTimeline`/`SimulationFrame.telemetry` (`packages/simulator/src/contracts.ts:107`); `RidePlaybackSnapshot` (`apps/web/src/ride/controller.ts`); `HeightfieldEnvironment` bounds; `TrackGeometries { leftRail, rightRail, spine, ties, drawCalls, triangles }` (`trackGeometry.ts:15`); `clampFovForSpeed`/`getCameraState` (`cameras.ts:26`).

**Produced interfaces:** `createRendererController` still owns the single renderer + RAF loop; `attachTrack` tessellates only `CompiledTrackData`; `buildTrackGeometries(track)` returns `leftRail/rightRail/spine/ties` vertex counts derived from `track.distances.length` samples; `buildSupportColumns(data, env, 10)` attaches visual-only columns; `getCameraState` clamps `fov` via `clampFovForSpeed(speedMps)` and returns the fallback diagnostic when `snapshot === null`. `RideAudioUpdate` stays `{ speedMps, zoneMask, paused? }`-compatible with new optional `lateralG?`/`verticalG?` (finite when present); audio layers scale wind from `speedMps`, rail from `speedMps` + `verticalG`, LSM/brake from `zoneMask` + `speedMps`, and respect `prefers-reduced-motion`/mute.

**Test sketches:**

```ts
// apps/web/src/render/large-scale.test.ts
import { test, expect } from "vitest";
import { generateCoaster } from "@openvibecoaster/generator";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { buildTrackGeometries } from "./trackGeometry.js";
test("tessellation derives from CompiledTrackData samples and exposes spine and ties", () => {
  const g = generateCoaster(createDesignIntentV1({ generatorVersion: "record-g", seed: 42, mode: "insta", family: "steel-sitdown-lsm-v1", elements: [], gates: [], targets: [], constraints: [], pinnedElementIds: [] }));
  const geos = buildTrackGeometries(g.track);
  expect(geos.spine).toBeDefined();
  expect(geos.ties).toBeDefined();
  expect(geos.leftRail.attributes.position.count).toBeGreaterThan(g.track.distances.length);
  expect(geos.rightRail.attributes.position.count).toBeGreaterThan(g.track.distances.length);
  expect(geos.drawCalls).toBeGreaterThan(0);
  expect(geos.triangles).toBeGreaterThan(0);
  expect(Number.isFinite(geos.triangles)).toBe(true);
});
test("trackGeometry module never imports generator", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("./trackGeometry.ts", import.meta.url), "utf8");
  expect(src).not.toContain("@openvibecoaster/generator");
  expect(src).not.toContain("packages/generator");
});
````

**RED CI:** `npm run test -- apps/web/src/render/large-scale.test.ts` expect `far` mismatch (default far below 8000) or missing `spine`/`ties` assertion before this task.

**GREEN implementation:** Set `camera.far = 8000` when `track.totalLength > 4000`; keep the portable single-file invariant (no new runtime deps); honor `window.matchMedia("(prefers-reduced-motion: reduce)")` via `viewState.ts`; extend `RideAudioUpdate` with optional `lateralG`/`verticalG` (finite-check when present, absent-safe) and scale audio from measured timeline values only (speed + zoneMask + optional forces).

**Focused CI:** `npm run test -- apps/web/src/render/large-scale.test.ts apps/web/src/audio/engine.test.ts apps/web/src/render/render.test.ts`.

**Static review:** Read `apps/web/src/render/controller.ts:1`, verify `buildTrackGeometries` imported from `./trackGeometry.js` (not `controller.js`) and no `packages/generator` import; verify `Read packages/core/src/track.ts` remains the sole track input.

**Commit:** `feat(render): scale renderer for 5 km cliff terrain with measured cameras/audio`

### Task 11a — Playwright record flows, screenshots, portable file, zero console errors

- [ ] Browser truth for target-vs-validated, cameras, plots, audio, motion, fallback, responsive

**Files:**

- Create `tests/e2e/record-hybrid.spec.ts` (new; `testDir` is `tests/e2e` per `playwright.config.ts:4`; webServer is `npm run build && npm run preview -w @openvibecoaster/web -- --host 127.0.0.1` per `playwright.config.ts:16-21`; project `chromium`)
- Edit `apps/web/src/main.ts` only if a selector asserted here is missing (all pill wiring itself landed in Task 09)

**Consumed interfaces:** `ExperienceController.status: "ready"` (`apps/web/src/experienceController.ts:16`); `[data-testid="record-target-pill"]` / `[data-testid="record-validated-pill"]` (Task 09); camera buttons `front/middle/rear/chase/orbit` (`render/cameras.ts:5`); telemetry plots, metric color, seam inspection, audio mute, `prefers-reduced-motion`, WebGL fallback message, responsive viewport, `apps/web/dist/OpenVibeCoaster.html` portable artifact (`.github/workflows/ci.yml` artifact check); `performance` marks `ovc:generation-total`, `ovc:simulation`, `ovc:worker-transfer`, `ovc:mesh-create`, steady-state 1080p `ovc:frame`.

**Produced interfaces:** Chromium run: `/` shows `"record target"` pill before generation resolves; `Generate` → `Ready` shows `"validated project record"` with the shortfall list cleared (`RECORD_*`/`HOLD_DURATION`/`ENERGY_*`/`BRAKE_*` zero errors); all five ride cameras render without throw; telemetry plots + metric color + seam inspection update; pin-local regeneration, directed success/infeasible, save/reload, audio unlock/mute, keyboard, reduced-motion, responsive viewports, portable `file://`, WebGL fallback, five performance marks, screenshots, and zero console/page errors. Element list shows exactly 20 record IDs ending in `station-019`.

**Test sketches (Playwright):**

```ts
// tests/e2e/record-hybrid.spec.ts
import { test, expect } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNoObservability,
  attachObservability,
  waitForReady,
} from "./acceptance-helpers.js";
const artifactPath = fileURLToPath(
  new URL("../../apps/web/dist/OpenVibeCoaster.html", import.meta.url),
);
const artifactFileUrl = pathToFileURL(artifactPath).href;
test("record target vs validated state, five cameras, five marks, shortfalls cleared", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const obs = attachObservability(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("record-target-pill")).toContainText(
    "record target",
  );
  await page.locator("#generate-btn").click();
  await waitForReady(page, 120_000);
  await expect(page.getByTestId("record-validated-pill")).toContainText(
    "validated project record",
  );
  expect(
    await page
      .locator(
        '#diagnostics-list li[data-severity="error"], #diagnostics-list li[data-severity="fatal"]',
      )
      .count(),
  ).toBe(0);
  expect(await page.locator("#element-list li").count()).toBe(20);
  for (const cam of ["front", "middle", "rear", "chase", "orbit"] as const) {
    await page.locator(`input[name="camera"][value="${cam}"]`).check();
    await page.waitForTimeout(250);
  }
  for (const mark of [
    "ovc:generation-total",
    "ovc:simulation",
    "ovc:worker-transfer",
    "ovc:mesh-create",
    "ovc:frame",
  ] as const) {
    expect(
      await page.evaluate((m) => performance.getEntriesByName(m).length, mark),
      `mark ${mark} present`,
    ).toBeGreaterThan(0);
  }
  const lengthM = Number.parseFloat(
    (await page
      .locator('[data-testid="track-length"]')
      .getAttribute("data-length-m")) ?? "NaN",
  );
  expect(lengthM).toBeGreaterThanOrEqual(5200);
  expect(lengthM).toBeLessThanOrEqual(5400);
  await page.screenshot({
    path: "tests/e2e/__screenshots__/record-hybrid-validated.png",
  });
  assertNoObservability(obs, "record validated");
});
test("pause scrub speed reset, plot-track sync, colors, seam inspector, audio, keyboard, reduced motion, responsive", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const obs = attachObservability(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("#generate-btn").click();
  await waitForReady(page, 120_000);
  await page.locator("#pause-btn").click();
  await expect(page.locator("#pause-btn")).toContainText(/resume|pause/i);
  await page.locator("#pause-btn").click();
  const scrub = page.locator("#scrubber");
  await scrub.fill("50");
  expect(
    Number.parseFloat(
      (await page
        .locator('[data-testid="train-position"]')
        .getAttribute("data-distance-m")) ?? "NaN",
    ),
  ).toBeGreaterThan(0);
  await page.locator("#playback-speed").selectOption("2");
  await expect(page.locator("#playback-speed")).toHaveValue("2");
  await page.locator("#reset-btn").click();
  await expect(page.locator("#telemetry-graph")).toBeVisible();
  await page.locator("#metric-select").selectOption("gForce");
  await expect(page.locator("#metric-legend")).toContainText(/g/i);
  await page.locator("#metric-select").selectOption("speed");
  await page.locator("#metric-select").selectOption("rollRate");
  await page.locator("#metric-select").selectOption("clearance");
  await page.locator("#seam-inspect-btn").click();
  await expect(page.locator('[data-testid="seam-boundaries"]')).toBeVisible();
  await page.locator("#audio-unlock-btn").click();
  await page.locator("#mute-btn").click();
  await expect(page.locator("#audio-status")).toContainText(/muted/i);
  await page.locator("#mute-btn").click();
  await page.locator("#telemetry-graph").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press(" ");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator('input[name="camera"][value="orbit"]').check();
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: "tests/e2e/__screenshots__/record-hybrid-controls.png",
  });
  assertNoObservability(obs, "record controls");
});
test("pin-local regeneration, directed, save-reload (two generations: coherent 300 s budget)", async ({
  page,
}) => {
  // Two waitForReady(page, 120_000) generations plus interactions cannot fit in
  // 180 s, so this split test carries its own 300 s enclosing budget. The 90 s
  // portable acceptance bound (ENGINEERING_READY_TIMEOUT) is untouched.
  test.setTimeout(300_000);
  const obs = attachObservability(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator("#generate-btn").click();
  await waitForReady(page, 120_000);
  await page.locator("#element-list li").first().click();
  await page.locator("#pin-btn").click();
  await page.locator("#local-regenerate-btn").click();
  await waitForReady(page, 120_000);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save-btn").click();
  const download = await downloadPromise;
  const savePath = await download.path();
  expect(savePath).toBeTruthy();
  await page.screenshot({
    path: "tests/e2e/__screenshots__/record-hybrid-pinsave.png",
  });
  assertNoObservability(obs, "record pin and save");
});
test("portable file:// artifact reaches Ready with zero errors (Blob worker, no runtime fetch)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const obs = attachObservability(page);
  const disallowed: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    const allowed =
      url === artifactFileUrl ||
      url.startsWith("data:") ||
      url.startsWith("blob:");
    if (!allowed) disallowed.push(url);
  });
  await page.goto(artifactFileUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#generate-btn").click();
  await waitForReady(page, 120_000);
  await expect(page.getByTestId("record-validated-pill")).toContainText(
    "validated project record",
  );
  expect(
    disallowed,
    `only artifact + data:/blob: allowed (Blob-backed inline worker): ${disallowed.join(", ")}`,
  ).toEqual([]);
  assertNoObservability(obs, "portable file");
  // Note: `playwright.portable.config.ts` (`test:e2e:portable`) separately runs `offline.spec.ts` (artifact existence
  // + file:// Ready + checksum + no-fetch) on edge/webkit; this chromium file:// test proves the record pills
  // on the portable artifact without bypassing that gate.
});
test.describe("webgl fallback (WebGL-disabled)", () => {
  // Valid Playwright pattern per tests/e2e/vertical-slice-webgl.acceptance.spec.ts:7:
  // `Browser.newContext` takes BrowserContextOptions, never `launchOptions`
  // (F8a); WebGL flags belong in `test.use({ launchOptions })`.
  test.use({ launchOptions: { args: ["--disable-webgl", "--disable-gpu"] } });
  test("WebGL fallback shows message with retry and no errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.locator("#webgl-fallback")).toBeVisible();
    await expect(page.locator("#webgl-fallback h2")).toHaveText(
      "3D view unavailable",
    );
    await expect(page.locator("#webgl-retry")).toBeEnabled();
    expect(errors).toEqual([]);
  });
});
```

**RED CI:** `npm run test:e2e -- --project=chromium --grep "record target vs validated"` expect no-selector failure until Task 09 pills exist (this task only passes after 09).

**GREEN implementation:** No production change except missing selectors (Task 09 owns them); add the spec file exactly as above plus screenshot attachments via `page.screenshot()` to `tests/e2e/__screenshots__/record-hybrid-*.png` git-ignored artifacts surfaced in CI HTML report. Enclosing budgets stay coherent: single-generation tests keep `test.setTimeout(180_000)` around one `waitForReady(page, 120_000)`; the split pin/save test carries `test.setTimeout(300_000)` around two 120 s waits plus interactions. `ENGINEERING_READY_TIMEOUT` (90 s, `tests/e2e/acceptance-helpers.ts:75`) is never raised.

**Focused CI:** `npm run test:e2e -- --project=chromium tests/e2e/record-hybrid.spec.ts` (CI-only; never locally).

**Static review:** Read `playwright.config.ts:4` (`testDir: tests/e2e`) and `:16-21` (build+preview webServer) plus `:31-40` (`launchOptions` only at project level, never in `browser.newContext` — F8a), verify spec path and no `e2e/` root path; verify both `data-testid` strings match `main.ts`; verify camera selectors match radio inputs at `apps/web/index.html:478-498` (`input type="radio" name="camera" value="front|middle|rear|chase|orbit"`, so `.check()` is valid — F13); verify portable file:// uses `fileURLToPath`/`pathToFileURL` + data:/blob:-only request assertion per `tests/e2e/offline.spec.ts:4-31` and that `playwright.portable.config.ts` (`test:e2e:portable` → `offline.spec.ts` on edge/webkit) remains the artifact gate — F12; verify each test's enclosing `test.setTimeout` exceeds its `waitForReady` sum (180 s ⊃ 1×120 s; pin/save 300 s ⊃ 2×120 s) and `ENGINEERING_READY_TIMEOUT` (90 s) is untouched.

**Commit:** `test(e2e): verify record target flows cameras plots audio and fallback`

### Task 11b — Honest warm p50/p95 stage benchmarks with no reduced validation

- [ ] 3 warm-up + 50 measured seeds, nested-stage honesty, miss reporting

**Files:**

- Edit `packages/generator/src/bench.test.ts` (the workspace bench entry invoked by root `bench:engineering` via `package.json:26` `npm run bench -w @openvibecoaster/generator` → `generator/package.json:9` `vitest run packages/generator/src/bench.test.ts`; there is no `packages/generator/scripts/bench.mjs` — F8b): report `candidateSearchInclusive` (pipeline `search:start`/`search:end` inclusive interval nesting `solving` + `validation` per `bench.test.ts:127-156`) plus `compilation` and `total` with nearest-rank p50/p95 over 3 warm-up + 50 measured seeds; state the nesting verbatim so stages are not summed
- Edit `tests/e2e/browser-benchmark.acceptance.spec.ts` usage via `playwright.benchmark.config.ts` (production Chromium): 3 warm-up seeds each asserting `Ready` and mandatory `ovc:generation-total`, then 50 measured seeds via `ovc:generation-total` / `ovc:simulation` / `ovc:worker-transfer` / `ovc:mesh-create` / steady-state 1080p `ovc:frame`; honest target-miss reporting
- Root `scripts/bench.mjs:55` orchestration unchanged (`bench:engineering` then `bench:browser`, non-zero exits preserved)

**Consumed interfaces:** `generateCoasterForBenchmark(intent, options, observer)` stage observer (`search:start/end`, `solving`, `validation`, `compilation`, `total`); `performance.measure` marks above; `npm run bench:engineering` / `npm run bench:browser` (`package.json:26-27`); root `npm run bench` (`scripts/bench.mjs`).

**Produced interfaces:** Both benches print per-stage p50/p95 plus miss lines (for example `target-miss: ovc:frame p95 22.4ms > 16.7ms`) and exit non-zero on harness failure but never hide a miss as a pass; validation runs at full fidelity (no sampled-only clearance, no reduced seeds).

**RED CI:** `npm run bench -- --smoke` passes (spawn check) but full `npm run bench:engineering` before record tuning reports length/speed misses honestly — assert the miss line exists rather than a pass.

**GREEN implementation:** Keep 3+50 counts, nearest-rank p50/p95, verbatim `candidateSearchInclusive` nesting note, mandatory `Ready` + `ovc:generation-total` in warm-up, all five browser marks in measured seeds, honest miss report.

**Focused CI:** `npm run bench` (CI-only `quality` job; never locally).

**Static review:** Read `scripts/bench.mjs:55-88`, verify orchestrator (`bench:engineering` then `bench:browser`, non-zero exits preserved, `--smoke` spawn check) + honest-miss comment; read `packages/generator/src/bench.test.ts:127-169`, verify `candidateSearchInclusive` nesting note plus stage labels and 3/50 counts; read `package.json:25-27` for `bench`/`bench:engineering`/`bench:browser` wiring.

**Commit:** `bench(record): report honest warm p50/p95 stages without reduced validation`

### Task 11c — README record section, sources, support limitation, no ASTM claim

- [ ] Dated comparisons, metrics, limitations paragraph

**Files:**

- Edit `README.md:1` (add Record-Hybrid section: metrics 5,200–5,400 m / 225–235 m / 285–295 km/h / 90–92 m top hat / 80–82 m Immelmann / 66–68 m loop / about 210 m at 110° dive / force windows +4.8–+5.0 peak and negative-G achievement in [−1.2, −1.0] about −1.1 (hard floor −1.2) with lat/long 1.5, jerk 15, roll 1.5 / 9,000 kg six-car train with LSM 14 kN + 1.2 MW per car and 18 kN brake / terrain `cliff-valley-v1` 4,190 × 2,790 m (`(420−1)×10` by `(280−1)×10`, 117,600 heights, `origin: [-2095, -1395]`) / dated 2026-09-01 source list with all five spec URLs / limitations paragraph)
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

**Pass criteria:** every hard target from Global Constraints passes in the same authoritative result (`recordValidated === true`, zero `RECORD_*`/`HOLD_DURATION`/`ENERGY_*`/`BRAKE_*` errors, zero error/fatal diagnostics, negative-G min in [-1.2, -1.0] about -1.1); E2E asserts target-vs-validated pills with cleared shortfalls, 20-element list, five cameras, all five performance marks, pause/scrub/speed/reset, plot-track sync, G/speed/roll-rate/clearance colors, seam inspection, pin-local regeneration, directed success/infeasible, save/reload, audio unlock/mute, keyboard, reduced motion, responsive viewports, WebGL fallback, portable `file://` Ready, screenshots, and zero console/page errors; benches report honest p50/p95 with no reduced validation.

**Focused CI:** the two gate sequences above, executed only in GitHub Actions.

**Static review:** Reviewer verifies the dependency order 01→02→03→04→05→06→07→08→09→10→11a→11b→11c→11d, per-task review boundaries below, and that no gate was weakened.

**Commit:** `test(e2e): record final CI gate evidence` (empty if gates already green on prior commits; otherwise no commit — never force-push).

---

## Self-Review Checklist (plan author)

- [ ] Every hard window from the spec appears verbatim in Global Constraints and Tasks 01/08 (5,200–5,400; 225–235; 285–295 / 79.16–81.94 m/s; 90–92; 80–82; 66–68; 207–213 m at 108.5–111.5°; +4.8–+5.0 peak with min in [−1.2, −1.0] about −1.1 (floor −1.2); lat/long <= 1.5; jerk <= 15; roll <= 1.5; 3 s hold)
- [ ] Exactly three new kinds (`diveDrop`, `immelmann`, `verticalLoop`); grep confirms zero `terrainSwoop`; `topHat` [80, 92] extension with default 80 is not counted as a new kind; Task 02 threads `p.height` through `topHatSpans` (rise table scaled, apex Y equals authored height) with compiled-track local-delta tests for 80 m and 91 m (`track.positions`/`distances`, getter cached once); Task 08 enforces [90, 92] from compiled geometry via `localHeightForKind` (`deltaM = maxY − minY` in the owned slice), never authored intent or absolute Y
- [ ] All spans use `positionCoefficients` (3×8) + `rollCoefficients` (6) with integrated `length`; renderer consumes only `CompiledTrackData`
- [ ] ASTM stays `UNKNOWN_UNCONFIGURED` in code, JSON, and README; no compliance claim; `engineering-limits-v1.json` untouched
- [ ] New helper `localHeightForKind` is defined in Task 08 before any use (returns `deltaM/maxY/minY/s/relatedIds`); new helper `summitHoldWindow` is defined in Task 08 before any dwell use (returns `centerS/toleranceM`) and is called verbatim by validation, worker, and all Task 08 sketches; `recordStatusLabel` is defined in Task 09 before `main.ts` uses it, and `hydrateEngineeringSuccess` propagates the four record fields before the controller test asserts them; `diveDropSpans`/`immelmannSpans`/`verticalLoopSpans` and `DIVE_DROP_SPAN_COUNT`/`IMMELMANN_SPAN_COUNT`/`VERTICAL_LOOP_SPAN_COUNT` are defined before `buildElement` branches
- [ ] `SimulatorConfig` shape matches `contracts.ts:35-59` + `index.ts:42-70` (cars array 6×1500 kg, `spacingM: 3.4`, envelope `1.25/2.1/0.8/0.75`, top-level `gravityMps2: 9.80665`, `fixedStepSeconds: 1/240`, `timelineStepSeconds: 1/120`, force/power/drag/air-density caps `14000/1200000/2000/18000/4/1.225`); no `train: { cars: 6, massKg }` shorthand anywhere
- [ ] Protocol tests build valid successes via `handleGenerate(validIntent)` and assert `recordValidated === (recordDiagnostics.length === 0)` / `clearanceM.length === timeline.length` plus finite `holdSeconds ≥ 0` / `holdLocationS` with strict missing/mistyped rejection (`recordValidated`/`recordDiagnostics`/`holdSeconds`); no `file: {}` / `track: {}` fixtures and never `JSON.parse(JSON.stringify(...))` on transfer buffers; `record-worker-determinism.test.ts` is listed in Task 09 Files and asserts bytewise equality (no Node `Buffer` in web tests), `collectTransferables` deduplication, hydration copy-without-aliasing, `cancel`/`teardown` rejection, and the 5 ms future-timestamp boundary driven through the `EngineeringWorkerClient` receipt path (`client.ts:373-394`, `transferMs < −5` → `clock-skew` reject + pending removal, mirroring `client.test.ts:572-607`); buffer counts 11/28 and no-`frames` compact rule (`protocol.ts:334-335`) preserved
- [ ] Render tests import `buildTrackGeometries` from `./trackGeometry.js`, compare vertex counts to `track.distances.length` (not `positions.length`), assert `spine`/`ties`, and assert no `packages/generator` import in `trackGeometry.ts`
- [ ] Dive angle sampled at normalized `u = 0.5` via `atan2(d[1], hypot(d[0], d[2]))` asserting `Math.abs(pitch + 70) <= 0.6` plus explicit `Math.abs(dropM - 210) <= 3` and a separate recovery assertion; never `toBeCloseTo` with digits misused as absolute tolerance; tolerance 108.5–111.5° consistent in Tasks 01 and 08 with a boundary test; synthesis uses `pitchDeg = angleDeg − 180` at all angles (never single-point `-(angleDeg − 40°)`) with slant scaled by `dropHeight/abs(sin(pitch))` so span-1 vertical = owned-slice union delta = authored `dropHeight` (level lip, no `normal*8` rise)
- [ ] `immelmannSpans` defines its own local rise table; no reuse of private `topHatSpans` coefficients
- [ ] No placeholder text (`TBD` / `TODO` / prose ellipsis / `fakeTrack` / `fakeTimeline` / `void honest` / `void file` / `void hydrated` / `void trackGeometrySource` or similar no-op assertions) and no empty loop/prose-only body remains; hold/rollback proves 3 s summit hold twice: compact-safe transferable-timeline dwell (≥360 samples at 1/120 s with `speedMps ≤ 0.05` inside the `summitHoldWindow` zone — brake-007 midpoint plus train length, no `980`/`60 m`/`2 m` literal — → numeric `holdSeconds`/`holdLocationS`, never `frames`) plus full-simulation cross-check (≥720 latched-`stall` frames at 1/240 s per the `hasStalled` latch, never post-stall `static-hold`), plus insufficient-launch `rolling → stall → rollback/reversal` with time/distance ordering plus controlled LSM restart to positive `rolling`; zone, clearance, worker, pin, save/reload, E2E, and bench tests all carry concrete imports, fixtures, assertions, codes, locations, margins, and RED/GREEN evidence (remaining triple-dot matches in this plan are TypeScript spread operators inside concrete code, not prose omissions)
- [ ] File paths resolved (rebased `f0443c3`, F15): `packages/generator/src/types.ts:11` (`ELEMENT_KINDS`), `:180-189` (`GenerationOptions.environment`); `packages/generator/src/elements.ts:32/70/110-116/157/185/198-205/276/438-448/624/792` (new span helpers declared immediately before `buildElement` at `:624`), `physicalBankDerivative` is `solver.ts:113-117` (not `:416`); `packages/generator/src/topHat-height.geometry.test.ts` (new); `packages/core/src/coaster-file.ts:156-167/174-191/193-206/371/489/559` (`createCoasterFileV1` def, validates at `:593-596`) `/657/874/918-944/964` (`serializeSolvedSpanV1` trusts passed physical length), call sites are `pipeline.ts:1765/2140`; `packages/core/src/contracts.ts:82` (`Diagnostic.provenance`); `packages/core/src/environments/cliff-valley.ts` (new) + `packages/core/src/environments/cliff-valley.test.ts` (new); `packages/core/src/index.ts` (add `export * from "./environments/cliff-valley"` after line 9 `export * from "./environment"`); `packages/core/src/track.ts:91-100` (`ADAPTIVE_MAX_*`) / `:297-313` (`CompiledTrackDataInput`) / `:676-712` (getters copy) / writers `:743-774` + `:1252-1259` and validator `:489-515` (`elementBoundaries` pairs); `packages/simulator/src/contracts.ts:35-59/135-136` (config + signed `static-hold/stall/rollback/reversal`); `packages/simulator/src/index.ts:42-70` (default config) / `:495-501` (zone end ≤ totalLength) / `:1620` (compact `frames: []`) / `:1871` (`simulateRide`) / `:2328` (`compactTimeline` flag); `packages/simulator/src/timeline.ts:47-48` (11/28 buffers) / `:298-329` (fields) / `:562-599` (`toTransferable`); `packages/simulator/src/operation-zones.ts:25-96` (half-open zones) / `:68-73` (open-station `targetSpeedMps` undefined); `packages/generator/src/solver.ts:35-46` (`defaultTolerances`) / `:113-117` (`physicalBankDerivative`); `packages/generator/src/pipeline.ts:81-84` (defaults) / `:136` (`defaultElements`) / `:334-341` (`asElements`) / `:443-456` (`ownerForSpan`) / `:1500-1505` (`maxIterations` 32/1/8) / `:1569/1730/2123` (unconditional `arcLength(span.span)` per `ad9d5b3`) / `:1765-1776` (`buildFileResult` profile wiring) / `:1970-1974` (`maxCandidates` 1/48); `packages/generator/src/clearance.ts:741` (`validateClearance`); `packages/generator/src/clearance-field.ts:327` (`computeClearanceField`) / `:367-369` (`maxWork` default 1M); `packages/generator/src/bench.test.ts:127-169` (nesting note + 3/50); `apps/web/src/engineering/protocol.ts:37-54` (requests) / `:56-59` (timings) / `:61-79` (compact success, `frames?: never`) / `:218-255` + `:334-335` (strict validation, no `frames`); `apps/web/src/engineering/worker.ts:231-279` (`simulateForTrack`, `compactTimeline: true` at `:262-267`) / `:281` (`handleGenerate`) / `:403-419` (success drops frames) / `:422` (`handleRegenerate`); `apps/web/src/engineering/client.ts:12` (`CLOCK_SKEW_TOLERANCE_MS = 5`) / `:67` (client) / `:373-394` (receipt `clock-skew` path); `apps/web/src/engineering/hydrate.ts:17-60` (propagate + freeze/copy four record fields) / `:47-59` (canonical file/checksum) / `:84-107` (diagnostics freeze discipline); `apps/web/src/engineering/transfer.ts:6` (`collectTransferables`); `apps/web/src/engineering/record-worker-determinism.test.ts` (new, listed); `apps/web/src/experienceController.ts:25-33` (result + four record fields) / `validateResult` (checksum + stale-rejection); `apps/web/src/app/recordStatus.ts` (new); `apps/web/src/main.ts:76` (pills); `apps/web/src/render/controller.ts:97` (far/fog); `apps/web/src/render/trackGeometry.ts:206` (`buildTrackGeometries`); `apps/web/src/render/supports.ts:14/36` (visual-only, 60 m skip); `apps/web/src/render/cameras.ts:5/26` (IDs + `clampFovForSpeed`); `apps/web/src/audio/engine.ts:59-63` (`RideAudioUpdate` + new optional `lateralG?`/`verticalG?`); `apps/web/src/terrain/environment.ts:9-15` (IDs) / `:23-26` (origin pattern) / `:72-79` (`resolve`) / `:84-90` (`create`); `tests/e2e/record-hybrid.spec.ts` (new); `tests/e2e/acceptance-helpers.ts:28/53/77` (observability/`waitForReady`); `tests/e2e/offline.spec.ts:4-31` (file:// + no-fetch pattern); `tests/e2e/vertical-slice-webgl.acceptance.spec.ts:7` (`test.use launchOptions` pattern); `playwright.config.ts:4` (`testDir`) / `:16-21` (webServer) / `:31-40` (project `launchOptions`); `playwright.portable.config.ts` (`test:e2e:portable` → `offline.spec.ts`); `playwright.benchmark.config.ts` (browser bench); `package.json:25-27` (`bench`/`bench:engineering`/`bench:browser`); `scripts/bench.mjs:55-88` (orchestrator)
- [ ] Packets are small and ordered: 01→02→03→04→05→06→07→08→09→10→11a→11b→11c→11d; element tasks sequential on the same switch; E2E/bench/docs/gate split into four commits; Task 06 asserts exactly 20 stable IDs (`station-000`…`station-019` with finale `overbankedTurn-014`/`zeroGRoll-015`/`stall-016` plus terminal `brake-017`/`brake-018`/`station-019`) and the [5,200, 5,400] window
- [ ] Supports visual-only + 60 m skip documented in Task 11c; terrain-transfer wording corrected (worker resolves terrain by profileId; only track/timeline/clearanceM transfer); cliff-valley factory lives in pure `packages/core` with the web layer delegating, and no file under `packages/generator` imports `apps/web`; footprint uses a realistic polygon or asserts `relaxationEvidence`
- [ ] Solver/search budgets frozen (`maxIterations` 32/1/8, `maxCandidates` 1/48, ≤3 reruns, `ADAPTIVE_MAX_*`, `defaultTolerances`, `maxWork`); RED baselines honest (`<5200`, unknown-profile throw, missing-module fail)

## Per-Task Review Boundaries

Each task is reviewed alone in a fresh session before the next starts: check out only that task's commit, run only its Focused CI, walk its Static review reads, and confirm its produced interfaces. Do not batch 03+04+05, 06+07, 09+10, or 11a+11b+11c+11d into one review. Reviewer never weakens limits, tolerances, budgets, or gates to make a check pass.

## Verification Notes

No executable verification is claimed. All `npm`/`node`/`tsc`/`vitest`/`prettier`/`oxlint`/`vite`/`Playwright`/`Python` commands listed are for GitHub Actions (`quality` ubuntu-latest + `portable` windows/macos) as defined in `.github/workflows/ci.yml`. Do not run them locally during this task; edit plus `git log --oneline` inspection only. Final integration still requires the repository's complete Node 24 gates and real-browser review before `main` is pushed.
