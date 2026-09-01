# Record-Hybrid Flagship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact default flagship with a deterministic, coefficient-backed 5.2–5.4 km record-hybrid terrain coaster that validates 225–235 m height, 285–295 km/h measured speed, 90–92 m inverted top hat, 80–82 m Immelmann, 66–68 m vertical loop, and ~210 m / 110° held cliff dive through one `DesignIntentV1 -> SolvedSpan[] -> CompiledTrackData -> RideTimeline` authority without weakening constraints, inventing power, or claiming ASTM compliance.

**Architecture:** `DesignIntentV1` + dated snapshot + record profile -> `solveSemanticChain`/`buildElement` (seventh-order Hermite position + quintic roll coefficients) -> `compileTrack` adaptive LUT -> `CompiledTrackData` (sole downstream representation) -> `simulateRide`/`RideTimeline` -> `generateCoaster`/`validateGenerationConstraints`/`validateClearance` -> inline `EngineeringWorker` (`?worker&inline`, `EngineeringWorkerRequest`/`EngineeringWorkerResponse`, transferable canonical arrays, epoch stale-rejection) -> `ExperienceController` -> Three.js tessellation (no second spline).

**Tech Stack:** Node 24 LTS (Krypton), npm 11.17.0, npm workspaces, TypeScript 7, Vite 8, Three.js (raw, no wrapper), Vitest 4 + fast-check 4, Playwright 1.62, Oxlint 1.80, Prettier 3.9. Single-file `apps/web/dist/OpenVibeCoaster.html` via `portable-packager.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md`

## Global Constraints

- 5,200–5,400 m physical track; 225–235 m height; measured 285–295 km/h;
- 90–92 m inverted top hat; 80–82 m Immelmann; 66–68 m vertical loop; about 210 m / 110° held cliff dive;
- brief +4.8–5.0 g and about -1.1 g; lateral/longitudinal <=1.5 g; jerk <=15 m/s^3; roll rate <=1.5 rad/s;
- unchanged 9,000 kg six-car train, LSM/brake caps and real energy accounting;
- ASTM F2291 remains UNKNOWN_UNCONFIGURED; never claim certification/compliance;
- raw Three.js/web boundary, no new runtime dependencies/assets/backend/deployment;
- one semantic intent -> coefficients -> CompiledTrackData -> RideTimeline authority;
- CI-only executable verification; commands are run in GitHub Actions, never locally during this task.

All tasks must preserve: pure `packages/core`, `packages/simulator`, `packages/generator` (no Three.js/DOM/WebAudio/mutable app state); RMF `transportFramesAlongPath`/`doubleReflectionFrames` with authored bank, never reset at seams; no sampled seam smoothing; diagnostics carry `actual`/`limit`/`margin`/`location.s`; hard constraints stay hard; `CompiledTrackData.checksum` canonical path.

## Branch / Worktree / Packet Order

Branch: `feat/record-hybrid-flagship` (assigned worktree `record-hybrid-design` at `b08c68e`). Workers never merge or push; each task commits inside the worktree.

### Dependency DAG and reviewable packets

- **Packet A – Foundations (Tasks 01–02)** must land first: snapshot + profile + diagnostics vocabulary and `diveDrop`/`immelmann`/`verticalLoop` type/parser/serialization contracts. No geometry depends on them.
- **Packet B – Geometry (Tasks 03–05)** depends on A: seventh-order coefficient synthesis + quintic roll for each record element, including seam/RMF/handness/infeasible tests. Task 03 (`diveDrop`), 04 (`immelmann`), 05 (`verticalLoop`) are independently reviewable but may share solver tolerances; review each in isolation before Packet C. No cross-element rendering yet.
- **Packet C – Generation Pipeline (Tasks 06–07)** depends on A+B: record default sequence/deterministic generation and cliff/valley terrain + clearance + gates/pins/save-reload. Can be split; 06 before 07.
- **Packet D – Validation Authority (Task 08)** depends on A+B+C: measured record validation from compiled geometry and `RideTimeline` (energy/LSM/brake/hold/rollback/force). Must not invent labels; consumes pipeline output.
- **Packet E – Platform Integration (Task 09–10)** depends on A+B+C+D: worker protocol + ExperienceController truth (target-vs-validated) and renderer/cameras/audio/reduced-motion scaling. 09 before 10.
- **Packet F – System Verification (Task 11)** depends on all prior: Playwright record flows, screenshots, 3+50 benchmark stage reporting, README/limitations/sources, full final CI. Single closing commit.

Integration rule: each task pins exact consumed interfaces and produced facts; reviewer clones fresh Muse session, runs only the focused CI command listed, checks static review list, and never weakens `ADAPTIVE_MAX_*`, `SeamTolerances`, `engineering-limits-v1.json`, `train-lsm-v1.json`, or `validateClearance` budgets.

## Tasks

### Task 01 — Dated research snapshot + record profile + diagnostics vocabulary

- [ ] Snapshot `2026-09-01` with record targets, profile schema, and diagnostics

**Files:**
- Create `data/records/records-2026-09-01.json`
- Edit `data/profiles/engineering-limits-v1.json` (add comment field only if needed; do NOT change numeric limits – new limits live in new profile)
- Create `data/profiles/record-targets-v1.json`
- Edit `packages/core/src/contracts.ts:1` (add `RecordTargetProfile` type import path if new profile is typed in core)
- Edit `packages/core/src/index.ts:1`

**Consumed interfaces:** `data/records/records-2026-08-29.json` schema (provenance vocabulary, `capturedAt`, `SOURCE_VERIFIED`/`DERIVED`/`DESIGN_TARGET`/`PROJECT_ENGINEERING_LIMIT`/`DESIGN_ASSUMPTION`/`UNKNOWN_UNCONFIGURED`); `data/profiles/engineering-limits-v1.json` structure (`verticalG`, `maximumAbsoluteLateralG`, `maximumJerkMps3`, `maximumRollRateRadPerSecond`, `seams`).

**Produced interfaces:** `data/records/records-2026-09-01.json` (schemaVersion 1, `capturedAt: "2026-09-01"`, `records` array with cannon-measured entries for Falcon's Flight 195 m / 250 km/h / 4,325 m, Tormenta Immelmann 66 m / loop 55 m / 94 m height / 87 m drop 95°, Spitfire 73 m, with URLs `https://sixflagsqiddiyacity.com/en/explore/rides/falcons-flight`, `https://www.intamin.com/project/falcons-flight/`, `https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run`, `https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run`, `https://www.intamin.com/project/spitfire-six-flags-qiddiya/` and `retrievedAt: "2026-09-01"`), `projectComparison` entries computing margins (+20.2% length, +15.4% height, +14.0% speed, +23.3% inverted top hat, +21.2% Immelmann, +20.0% loop) labeled `DESIGN_TARGET` not `SOURCE_VERIFIED`; `record-targets-v1.json` with `profileId: "record-targets-v1"`, `provenance: "PROJECT_ENGINEERING_LIMIT"`, fields `totalLengthM: [5200,5400]`, `maxHeightM: [225,235]`, `maxSpeedKmh: [285,295]`, `invertedTopHatM: [90,92]`, `immelmannM: [80,82]`, `verticalLoopM: [66,68]`, `diveDrop: { heightM: 210, angleDeg: 110, toleranceM: 3, toleranceDeg: 1.5 }`, `force: { verticalMaxG: [4.8,5.0], verticalMinG: -1.1, lateralMaxG: 1.5, longitudinalMaxG: 1.5, jerkMps3: 15, rollRateRadPerSec: 1.5 }`.

**Test sketches:**

```ts
// data/records/records-2026-09-01.test.ts
import snapshot from "../records-2026-09-01.json" with { type: "json" };
import { test, expect } from "vitest";
test("snapshot carries dated source URLs and vocabulary", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.records.some(r=>r.facts.some(f=>f.sourceUrls.includes("https://www.intamin.com/project/falcons-flight/")))).toBe(true);
  const ff = snapshot.records.find(r=>r.id==="falcons-flight-metric-facts")!;
  expect(ff.facts.find(f=>f.metric==="rideHeight")!.value).toBe(195);
});
test("record-targets does not claim SOURCE_VERIFIED", async () => {
  const profile = await import("../profiles/record-targets-v1.json", { with:{type:"json"}}).then(m=>m.default);
  expect(profile.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
  expect(profile.totalLengthM).toEqual([5200,5400]);
});

// packages/core/src/record-targets.test.ts
import { validateRecordTargetsProfile } from "./record-targets.js";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
```

**RED CI:** `npm run test -- data/records/records-2026-09-01.test.ts` expect `FAIL` with `Cannot find module .../records-2026-09-01.json`.

**GREEN implementation:** Create exact JSON files above, add `packages/core/src/record-targets.ts:1` exporting `interface RecordTargetProfile` and `validateRecordTargetsProfile(profile: unknown): asserts profile is RecordTargetProfile` checking finite ranges and angle 108.5–111.5; add re-export in `packages/core/src/index.ts:1`. Do not mutate existing snapshot.

**Focused CI:** `npm run test -- packages/core/src/record-targets.test.ts` (typecheck `npm run typecheck -w @openvibecoaster/core`).

**Static review:** `Read packages/core/src/contracts.ts:1`, verify `provenance` vocabulary unchanged, no ASTM claim, `docs/superpowers/specs/2026-09-01-record-hybrid-flagship-design.md:62` verbatim targets preserved.

**Commit:** `feat(records): add dated 2026-09-01 snapshot and record-targets profile`

### Task 02 — Semantic type/parser/serialization contracts for diveDrop, immelmann, verticalLoop

- [ ] Contracts only for the three approved elements

**Files:**
- Edit `packages/generator/src/types.ts:10` (ELEMENT_KINDS, ElementKind, parameter interfaces, ElementParameterMap)
- Edit `packages/generator/src/elements.ts:32` (defaults, validators)
- Edit `packages/core/src/coaster-file.ts:156` (supportedKinds, parameterNames, validateSerializedSpan)
- Edit `packages/core/src/contracts.ts:9` (DesignElementV1 union if typed)

**Consumed interfaces:** `ELEMENT_KINDS` tuple (`packages/generator/src/types.ts:11`), `SemanticElement<K>`, `AnySemanticElement`, `validateElement` (`packages/generator/src/elements.ts:173`), `validateDesignIntentV1`/`validateCoasterFile` (`packages/core/src/coaster-file.ts:348`).

**Produced interfaces:** Added kinds `diveDrop`, `immelmann`, `verticalLoop` with exact shapes:
```ts
export interface DiveDropParameters { readonly dropHeight: number; readonly angleDeg: number; readonly approachRadius: number; readonly exitRadius: number; readonly bank: number; }
export interface ImmelmannParameters { readonly height: number; readonly exitHeadingDeg: number; readonly bank: number; }
export interface VerticalLoopParameters { readonly height: number; readonly referenceSpeed: number; readonly bank: number; }
// all readonly, finite validation
```
Extend `ElementParameterMap` exactly with those three; extend `validateParameters` with `range("dropHeight", p.dropHeight, 40, 250)`, `range("angleDeg", p.angleDeg, 90, 135)` (110 is only valid target; range guards parser), `range("approachRadius", p.approachRadius, 15, 400)`, `range("exitRadius", p.exitRadius, 15, 400)`, `range("height", p.height, 20, 130)`, `range("exitHeadingDeg",..., -180,180)`, `range("referenceSpeed", p.referenceSpeed, 5, 85)`. `createAnyElement` switch passes through.

**Test sketches:**

```ts
// packages/generator/src/elements-record.test.ts
import { createElement } from "./elements.js";
import { parseDesignIntentV1 } from "@openvibecoaster/core";
test("diveDrop parses and rejects unknown kind", () => {
  expect(() => createElement("diveDrop" as any, "x-000", {} as any)).not.toThrow();
  const el = createElement("diveDrop","diveDrop-000",{dropHeight:210, angleDeg:110, approachRadius:90, exitRadius:70, bank:0});
  expect(el.parameters.dropHeight).toBe(210);
  expect(() => parseDesignIntentV1(JSON.stringify({schemaVersion:1,generatorVersion:"g",seed:1,mode:"insta",family:"steel-sitdown-lsm-v1",elements:[{id:"x",kind:"terrainSwoop",type:"terrainSwoop",parameters:{}}],gates:[],targets:[],constraints:[],pinnedElementIds:[]}))).toThrow(/supported element kind/);
});
test("coaster-file rejects extra element name", async () => {
  const { deserializeCoasterFileV1 } = await import("@openvibecoaster/core");
  expect(()=>deserializeCoasterFileV1(JSON.stringify({schemaVersion:1,name:"n",intent:{schemaVersion:1,generatorVersion:"g",seed:1,mode:"insta",family:"steel-sitdown-lsm-v1",elements:[{id:"e",kind:"diveDrop",type:"diveDrop",parameters:{dropHeight:210,angleDeg:110,approachRadius:90,exitRadius:70,bank:0}}],gates:[],targets:[],constraints:[],pinnedElementIds:[]},solvedSpans:[{id:"e",kind:"diveDrop",positionCoefficients:[[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0]],rollCoefficients:[0,0,0,0,0,0],length:1}],seed:1,generatorVersion:"g",profileVersion:"record-targets-v1",researchSnapshotIds:["records-2026-09-01"],compiledDataChecksum:"00000000"}))).toThrow();
});
```

**RED CI:** `npm run test -- packages/generator/src/elements-record.test.ts` expect `FAIL` `Unknown element kind: diveDrop`.

**GREEN implementation:** Add three kinds to `ELEMENT_KINDS` tuple, `defaults` map (dropHeight 210, angleDeg 110, approachRadius 90, exitRadius 70, bank 0; height 81/67 with exitHeadingDeg 180 etc.), switch cases in `validateParameters`/`createAnyElement`; extend `coaster-file.ts:156` `supportedKinds` set and `parameterNames` map (no generic entry); extend `validateSerializedSpan` kind list. Reject any fourth kind.

**Focused CI:** `npm run test -- packages/generator/src/elements-record.test.ts packages/core/src/coaster-file.test.ts`.

**Static review:** `Read packages/generator/src/elements.ts:30`, verify no `terrainSwoop`, no wildcard. `Read packages/core/src/coaster-file.ts:466` exactKeys preserved.

**Commit:** `feat(generator): add diveDrop, immelmann, verticalLoop semantic contracts`

### Task 03 — Seventh-order diveDrop geometry + quintic roll + seam/RMF tests

- [ ] `diveDrop` multi-span seventh-order synthesis

**Files:**
- Edit `packages/generator/src/elements.ts:312` (new `diveDropSpans` function, branch in `buildElement`)
- Edit `packages/generator/src/solver.ts:1` (allow diveDrop in variable binding if needed – read-only)
- Create `packages/generator/src/diveDrop.geometry.test.ts`
- Create `packages/generator/src/diveDrop.seam.test.ts`

**Consumed interfaces:** `SeventhOrderHermiteSpan`/`QuinticScalarSpan` (`packages/core/src/spans.ts:31`, `212`), `buildElement(elements.ts:612)`, `Pose`, `basisFor`/`localToWorld`/`worldPoint`, `solveSemanticChain`/`compileSemanticChain` (`packages/generator/src/solver.ts:874`), `diagnoseSeams`/`defaultTolerances`.

**Produced interfaces:** `buildElement(diveDrop, pose)` returns `ElementBuildResult` with 3 `SolvedSpan`s: span0 summit exit (approach radius Hermite, bank 0->bank), span1 beyond-vertical drop (angleDeg=110 → tangent pitch -110° from horizontal, dropHeight=~210 vertical delta, seventh-order C3 endpoints `d10/d20/d30` and `d11/d21/d31` matching curvature limit `curvaturePerM <= 0.015`), span2 recovery (exitRadius). Each span carries `positionCoefficients: coefficients` (3x8) and `rollCoefficients: 6` exact; `length` is integrated `arcLength` of the child; bank uses quintic per span, derivative zero at interior hold seam. Header exposes `export const DIVE_DROP_SPAN_COUNT = 3` for diagnostics.

**Test sketches:**

```ts
// diveDrop.geometry.test.ts
import { createElement, buildElement, defaultPose } from "./elements.js";
import { SeventhOrderHermiteSpan } from "@openvibecoaster/core";
test("diveDrop endpoint + angle + RMF", () => {
  const el = createElement("diveDrop","diveDrop-000",{dropHeight:210,angleDeg:110,approachRadius:90,exitRadius:70,bank:0.2});
  const { solvedSpans, endPose } = buildElement(el, defaultPose(), 34);
  expect(solvedSpans.length).toBe(3);
  expect(solvedSpans.every(s=>s.positionCoefficients?.length===3 && s.positionCoefficients[0]!.length===8)).toBe(true);
  expect(solvedSpans[0]!.span.position(0)[1]).toBeCloseTo(0,4);
  const pitch = Math.atan2(-solvedSpans[1]!.span.derivative(1,1)[1], Math.hypot(solvedSpans[1]!.span.derivative(1,1)[0],solvedSpans[1]!.span.derivative(1,1)[2])) *180/Math.PI;
  expect(pitch).toBeCloseTo(70, 0.6); // 110deg beyond vertical ~ 20deg past -90
});
// diveDrop.seam.test.ts
import { compileSemanticChain, diagnoseSeams } from "./solver.js";
test("diveDrop seams C3 + infeasible angle", ()=>{
  const { track, seamDiagnostics } = compileSemanticChain([createElement("diveDrop","diveDrop-000",{dropHeight:210,angleDeg:110,approachRadius:90,exitRadius:70,bank:0})]);
  expect(seamDiagnostics.every(d=>d.positionM < 1e-4 && d.curvatureVectorJumpPerM < 1e-4)).toBe(true);
  const infeasible = compileSemanticChain([createElement("diveDrop","diveDrop-000",{dropHeight:210,angleDeg:135,approachRadius:5,exitRadius:5,bank:0})]);
  expect(infeasible.feasible).toBe(false);
});
```

**RED CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts` expect `FAIL` `Unknown element kind: diveDrop` until Task 02, then missing `positionCoefficients`.

**GREEN implementation:** Implement `diveDropSpans(pose: Pose, params: DiveDropParameters, id: string): ElementBuildResult` computing local Hermite specs: use `approachRadius`/`exitRadius` to derive `d10/d11` magnitudes, angleDeg to rotate tangents in basis plane, enforce curvature continuity via zero `d20/d30` scaling. No `footprint-polygon` or terrain invention inside geometry. Ensure handler imported in `buildElement` early return for `diveDrop`. Preserve `applyAuthoredStartFrame` path.

**Focused CI:** `npm run test -- packages/generator/src/diveDrop.geometry.test.ts packages/generator/src/diveDrop.seam.test.ts`.

**Static review:** `Read packages/generator/src/elements.ts:554` verify seventh-order spec has `p0/d10/d20/d30/p1/d11/d21/d31` all finite, `Read packages/core/src/spans.ts:172` coefficients round-trip via `fromCoefficients`.

**Commit:** `feat(generator): synthesize seventh-order diveDrop with quintic roll`

### Task 04 — Seventh-order immelmann geometry + handedness + seam/RMF

- [ ] `immelmann` half-loop + roll with global RMF

**Files:**
- Edit `packages/generator/src/elements.ts:312` (add `immelmannSpans`)
- Create `packages/generator/src/immelmann.geometry.test.ts`
- Create `packages/generator/src/immelmann.seam.test.ts`

**Consumed/Produced:** same pattern as Task 03; returns 2 spans (loop half + roll exit), height maps to apex Y offset `81 ±1` via `riseCoefficients` scaled from `smoothRampCoefficients`; exit heading `exitHeadingDeg` enforces end tangent yaw; handedness preserved under `+approachRadius` sign flip; `bank` authored at exit, apex bank = `pose.bank + PI` (half roll), quintic roll per span with C2 bank derivative continuity.

**Test sketches:**

```ts
test("immelmann height + exit heading", ()=>{
  const el = createElement("immelmann","immelmann-000",{height:81, exitHeadingDeg:180, bank:0});
  const { solvedSpans } = buildElement(el, defaultPose());
  const apex = solvedSpans[0]!.span.position(0.5);
  expect(apex[1]).toBeCloseTo(81, 0.5);
  expect(solvedSpans.length).toBe(2);
});
test("immelmann handedness and RMF continuity", ()=>{
  // build left vs right and assert binormal dot >0 across RMF
});
```

**RED CI:** `npm run test -- packages/generator/src/immelmann.geometry.test.ts` expect missing span or height drift >2 m.

**GREEN implementation:** Compute radius = `height / 2` (or `height *0.55` for realistic clothoid) respecting `curvatureGradientPerM2` seam tolerance; emit two `SeventhOrderHermiteSpan` via Hermite spec interpolation using `basisFor` frame. Do not introduce generic roll wrapper.

**Focused CI:** `npm run test -- packages/generator/src/immelmann.* package`.

**Static review:** Check `frames.ts:1` RMF never reset, `Read packages/generator/src/solver.ts:416` bank derivative uses `physicalBankDerivative`.

**Commit:** `feat(generator): synthesize seventh-order immelmann with quintic roll`

### Task 05 — Force-shaped verticalLoop geometry + curvature-gradient seams

- [ ] `verticalLoop` explicit height/referenceSpeed

**Files:**
- Edit `packages/generator/src/elements.ts:312` (add `verticalLoopSpans`)
- Create `packages/generator/src/verticalLoop.geometry.test.ts`
- Create `packages/generator/src/verticalLoop.seam.test.ts`

**Consumed/Produced:** 3 spans (entry clothoid, apex teardrop, exit clothoid) with `referenceSpeed` shaping specific-force peaks (stay inside `PROJECT_ENGINEERING_LIMIT`); `height` 67 maps to apex; entrance/exit curvature + curvature-gradient (`d30/d31`) forced zero for hard seam tolerance `curvatureGradientPerM2: 1e-4`; roll locked 0 (no inversion) – loop is vertical.

**Test sketches:**

```ts
test("verticalLoop height 67 and C3 seams", ()=>{
  const el = createElement("verticalLoop","verticalLoop-000",{height:67, referenceSpeed:38, bank:0});
  const { track, seamDiagnostics } = compileSemanticChain([el]);
  const maxY = Math.max(...track.positions.filter((_,i)=>i%3===1));
  expect(maxY).toBeCloseTo(67, 0.6);
  expect(seamDiagnostics.every(d=>d.curvatureGradientPerM2 < 1e-4)).toBe(true);
});
```

**RED CI:** `npm run test -- packages/generator/src/verticalLoop.geometry.test.ts` expect hard seam failure.

**GREEN implementation:** Implement teardrop position coefficients using scaled Hermite with radius `height/2.05`, force-shaped apex curvature `v^2/r` mapping to target `verticalMaxG` but clamped; keep `curvaturePerM` seam tolerance, do not suppress diagnostic.

**Focused CI:** Same.

**Static review:** Verify `validateGenerationConstraints` not weakened.

**Commit:** `feat(generator): synthesize force-shaped verticalLoop with seam-certified exit`

### Task 06 — Record default sequence, deterministic generation, save/reload

- [ ] 5,200–5,400 m deterministic route with versioned save

**Files:**
- Edit `packages/generator/src/pipeline.ts:136` (`defaultElements`, new `recordHybridDefaultElements(seed,candidate)` returning 10-element authoritative list per spec narrative sections 1–11; includes `diveDrop`, `immelmann`, `verticalLoop`, respects `Xoshiro128ss`)
- Edit `packages/core/src/coaster-file.ts:536` (profileVersion `record-targets-v1`, researchSnapshotIds `["records-2026-09-01"]`)
- Edit `packages/core/src/coaster-file.ts:466` (validate follower checksum path)
- Create `packages/generator/src/recordHybrid.pipeline.test.ts`
- Create `packages/generator/src/recordHybrid.determinism.test.ts`

**Consumed interfaces:** `DesignIntentV1 {seed,mode,family,elements,gates,targets,constraints,footprint,heightRange,terrainProfileId,pinnedElementIds}` (`packages/core/src/contracts.ts:49`), `GenerationResult {intent,elements,solvedSpans,track,file,diagnostics}` (`packages/generator/src/types.ts:192`), `CoasterFileV1`/`serializeCoasterFileV1`/`deserializeCoasterFileV1`/`compileCoasterFile` (`packages/core/src/coaster-file.ts:34`).

**Produced interfaces:** `generateCoaster(intent: DesignIntentV1, {environment})` with `intent.mode==="insta"` mapping to `recordHybridDefaultElements` producing totalLength 5250±150, `candidateSearchInclusive` 48 candidates deterministic across seeds, save preserves `profileVersion`, `researchSnapshotIds`, semantic intent, exact `positionCoefficients`/`rollCoefficients`, `length` integrated per child, checksum, `compileCoasterFile(reload)` recompiles without re-solving (checksum equality).

**Test sketches:**

```ts
// recordHybrid.pipeline.test.ts
import { generateCoaster } from "./pipeline.js";
import { createDesignIntentV1 } from "@openvibecoaster/core";
test("insta deterministic 5.2km and save-reload", async ()=>{
  const intent = createDesignIntentV1({generatorVersion:"g",seed:42,mode:"insta",family:"steel-sitdown-lsm-v1",elements:[],gates:[],targets:[],constraints:[],pinnedElementIds:[]});
  const a = generateCoaster(intent);
  const b = generateCoaster(intent);
  expect(a.track.totalLength).toBeGreaterThanOrEqual(5200);
  expect(a.track.totalLength).toBeLessThanOrEqual(5400);
  expect(a.track.checksum).toBe(b.track.checksum);
  const { compileCoasterFile } = await import("@openvibecoaster/core");
  const re = compileCoasterFile(a.file);
  expect(re.track.checksum).toBe(a.track.checksum);
});
test("operation zones never exceed compiled length", ()=>{
  const g = generateCoaster(createDesignIntentV1({generatorVersion:"g",seed:7,mode:"insta",family:"steel-sitdown-lsm-v1",elements:[],gates:[],targets:[],constraints:[],pinnedElementIds:[]}));
  for(const z of g.track.zoneMasks){} // zones half-open check via simulator helper
});
```

**RED CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts` expect `totalLength` 1843 or checksum mismatch.

**GREEN implementation:** Replace `defaultElements` switch: when `intent.mode !== "directed"` return `recordHybridDefaultElements` computing: station 180 m, launch0 45 m, transition 60 m, terrain run 400 m, LSM climb 500 m, summit brake 35 m, `diveDrop` 210 m vertical, LSM 600 m, camelback 190 m, high-speed turns 800 m, inverted top hat (existing `topHat` height 90+), `immelmann` 81 m, `verticalLoop` 67 m, overbank/roll/stall 300 m, brakes 350 m. Budget `candidateSearchInclusive`. Do not invent short high-power acceleration; keep solver `maxIterations` 32 for directed, 8 insta.

**Focused CI:** `npm run test -- packages/generator/src/recordHybrid.pipeline.test.ts packages/generator/src/recordHybrid.determinism.test.ts`.

**Static review:** `Read packages/generator/src/pipeline.ts:16` `DEFAULT_RESEARCH_SNAPSHOT_IDS` updated to `["records-2026-09-01"]`, `Read packages/core/src/coaster-file.ts:79` `serializeCoasterFileV1` stable order preserved.

**Commit:** `feat(generator): implement record default sequence and deterministic save-reload`

### Task 07 — Widened cliff terrain + gates/pins + clearance authority

- [ ] 5.2 km footprint-valid cliff-and-valley heightfield

**Files:**
- Edit `apps/web/src/terrain/environment.ts:18` (add `CLIFF_VALLEY_TERRAIN_PROFILE_ID = "cliff-valley-v1"`; expand `createTerrainEnvironment`; implement `createCliffValley(height:number)` width 420 depth 280 cellSize 10 with cliff ridge at z=0 height 225, valley trench -15)
- Edit `packages/generator/src/pipeline.ts:932` (terrain requirement enforcement, footprint/hard gates, `validateGenerationConstraints` cliff override)
- Edit `packages/core/src/footprint-polygon.ts:1` (no change – used)
- Create `packages/generator/src/clearance-cliff.test.ts`
- Create `packages/generator/src/gates-pins.test.ts`

**Consumed interfaces:** `HeightfieldEnvironment` (`packages/core/src/environment.ts:353`), `resolveTerrainEnvironment` (`apps/web/src/terrain/environment.ts:72`), `validateGenerationConstraints` (`packages/generator/src/pipeline.ts:932`), `validateClearance` (`packages/generator/src/clearance.ts:741`) with `CertifiedWorkBudget`/`certifiedPolynomialBounds`.

**Produced interfaces:** `resolveTerrainEnvironment("cliff-valley-v1")` yields `HeightfieldEnvironment {width:420, depth:280}` with ridge Y=225 at summit `s≈980`; `isPointInsidePolygonStrict(signedDistanceStrictXZ)` honors directed footprint hard polygons; `generateCoaster` returns `relaxationEvidence` when footprint infeasible instead of leaving it; `computeClearanceField` (`packages/generator/src/clearance-field.ts:1`) returns inflated segment bounds with `sqrt(3)` directional locality, `validateClearance` never uses sampled-only path.

**Test sketches:**

```ts
test("enormous heightfield exceeds compact and gates honored", ()=>{
  const env = resolveTerrainEnvironment("cliff-valley-v1");
  expect(env!.width * env!.cellSize).toBeGreaterThan(4000);
  const intent = createDesignIntentV1({... , footprint: [[-200,0,-200],[200,0,-200],[200,0,200],[-200,0,200]], gates:[{id:"g1", position:[0,0,50]}]});
  const r = generateCoaster(intent, {environment: env});
  expect(r.diagnostics.some(d=>d.code==="FOOTPRINT")).toBe(false);
});
test("clearance certified not sampled", ()=>{ /* inject narrow terrain ridge, expect TERRAIN_CLEARANCE with location.s and margin */ });
```

**RED CI:** `npm run test -- packages/generator/src/clearance-cliff.test.ts` expect `Unknown terrain profile: cliff-valley-v1`.

**GREEN implementation:** Implement heightfield heights: `height = baseValley(-15) + ridge(225*exp(-(z/120)^2)) + noise *0.6`. Add to `VALID_TERRAIN_PROFILE_IDS`. Update pipeline to select environment when `intent.terrainProfileId === "cliff-valley-v1"` (throw on unknown). Keep spatial-index budget checks – never lower `maxWork`.

**Focused CI:** `npm run test -- packages/generator/src/clearance-cliff.test.ts packages/generator/src/gates-pins.test.ts`.

**Static review:** `Read apps/web/src/terrain/environment.ts:1` no Three.js import, `Read packages/generator/src/pipeline.ts:58` `resolveTerrainEnvironment` strict.

**Commit:** `feat(environment): widen cliff-valley terrain and wire directed gates/clearance`

### Task 08 — Measured record validation from compiled geometry and RideTimeline

- [ ] Truthful validation, energy/force/hold/rollback evidence

**Files:**
- Create `packages/simulator/src/record-validation.ts` (new module: `validateRecordTargets(track: CompiledTrackData, timeline: RideTimeline, profile: RecordTargetProfile, environment?) => readonly Diagnostic[]`)
- Edit `packages/simulator/src/index.ts:1` (re-export)
- Edit `apps/web/src/engineering/worker.ts:231` (`simulateForTrack` augmentation to append record diagnostics to `generation.diagnostics`)
- Create `packages/simulator/src/record-validation.test.ts`
- Create `packages/simulator/src/energy-launch-brake.test.ts`

**Consumed interfaces:** `CompiledTrackData {positions,tangents,distances,totalLength,curvature,curvatureVector}` (`packages/core/src/track.ts:297`), `RideTimeline {headDistanceM,speedMps,timeSeconds,length,frames}` (`packages/simulator/src/timeline.ts:1`), `SimulatorConfig {train: {cars:6,massKg:1500,spacingM:3.4}, lsmForcePerCarN:14000, lsmPowerPerCarW:1200000, maxBrakeForcePerCarN:18000, dragCdA:4, rollingResistance:0.002, airDensityKgPerM3:1.225}` (`packages/simulator/src/index.ts:41`), `Diagnostic {code,severity,provenance,actual,limit,margin,location,relatedIds}` (`packages/core/src/contracts.ts:82`).

**Produced interfaces:** `validateRecordTargets` emits codes `RECORD_LENGTH`, `RECORD_HEIGHT`, `RECORD_SPEED`, `RECORD_INVERSION`, `RECORD_IMMELMANN`, `RECORD_LOOP`, `RECORD_DIVE_HEIGHT`, `RECORD_DIVE_ANGLE` with `severity:"error"` when `track.totalLength` outside [5200,5400], `max(track.positions.y)` outside [225,235], `max(timeline.speedMps)` outside [79.16,81.94] m/s (285–295 km/h), `maxHeightOfKind("topHat")` outside [90,92], `maxHeightOfKind("immelmann")` outside [80,82], `maxHeightOfKind("verticalLoop")` outside [66,68], dive vertical drop outside 207–213 or angle outside 108.5–110.5; never reads authored `parameters.height` as proof. Appends `ENERGY_LSM_REQUIRED_WORK` diagnostic when LSM work `> 1.2MW * duration` or brake `endSpeed >0.2 m/s`. `ExperienceController` surfaces these as `PROJECT_ENGINEERING_LIMIT` with explicit `actual/limit/margin`.

**Test sketches:**

```ts
// record-validation.test.ts
import { validateRecordTargets } from "./record-validation.js";
import profile from "../../../data/profiles/record-targets-v1.json" with {type:"json"};
test("measures compiled geometry, not authored params", ()=>{
  const track = fakeTrack({totalLength:5250, maxY:230, invertedTopHatY:91, immelmannY:81, loopY:67, dive:{h:210,a:110}});
  const timeline = fakeTimeline({maxSpeed:80});
  expect(validateRecordTargets(track,timeline,profile).length).toBe(0);
  // author says topHat height 90 but geometry says 73 – must fail
  const authoredFake = fakeTrack({...same, invertedTopHatY:73});
  expect(validateRecordTargets(authoredFake,timeline,profile).some(d=>d.code==="RECORD_INVERSION")).toBe(true);
});
test("energy/brake accounting", ()=>{
  // simulate launch caps, assert diagnostic when 285 requires invented power
});
```

**RED CI:** `npm run test -- packages/simulator/src/record-validation.test.ts` expect missing module or false pass on authored cheating.

**GREEN implementation:** Implement `record-validation.ts` iterating `CompiledTrackData.positions` sampled at `distances` to compute `maxY` and per-element max Y splitting on `track.elementBoundaries`/`elementIndices` with spanIds mapping; compute `timeline.speedMps` max; derive dive drop by finding consecutive `diveDrop` spanIds slice and measuring delta Y and tangent angle `acos(dot)` at mid. Wire into `handleGenerate`/`handleRegenerate`/`handleCompileSimulate` merging diagnostics before success check.

**Focused CI:** `npm run test -- packages/simulator/src/record-validation.test.ts packages/simulator/src/energy-launch-brake.test.ts`.

**Static review:** `Read packages/simulator/src/record-validation.ts:1` provenance is `PROJECT_ENGINEERING_LIMIT`, never `SOURCE_VERIFIED`; no ASTM claim.

**Commit:** `feat(simulator): validate measured record targets from geometry and timeline`

### Task 09 — Worker protocol + ExperienceController truth (target vs validated)

- [ ] Target-before-validation UI state, cancellation, transfer

**Files:**
- Edit `apps/web/src/engineering/protocol.ts:1` (augment `EngineeringWorkerSuccess` timings to include `recordValidated: boolean`, `recordDiagnosticsM` – or keep timings but add explicit `recordValidated` field; strictly validate)
- Edit `apps/web/src/engineering/worker.ts:1` (propagate `recordValidated`/`recordDiagnostics` from Task 08)
- Edit `apps/web/src/engineering/client.ts:1` (stale-rejection, timestamp tolerance 5 ms, transfer `clearanceM`)
- Edit `apps/web/src/experienceController.ts:190` (`validateResult`, `AvailableExperienceResult.recordValidated` branch, UI label helper `recordStatusLabel`)
- Create `apps/web/src/engineering/record-protocol.test.ts`
- Create `apps/web/src/experienceController.record.test.ts`

**Consumed interfaces:** `EngineeringWorkerRequest {generate,regenerate,compile-simulate,cancel}` + `EngineeringWorkerResponse {success,failure,cancelled}` (`apps/web/src/engineering/protocol.ts:37`); `EngineeringWorkerClient` (`apps/web/src/engineering/client.ts:1`) with `collectTransferables`; `ExperienceController` state `status:"ready"|"error"` (`apps/web/src/experienceController.ts:16`); `isClosedChain` heuristic.

**Produced interfaces:** `EngineeringWorkerSuccess` now includes `recordValidated: boolean` and `recordDiagnostics: readonly Diagnostic[]`; `ExperienceController.getState().result.recordValidated` drives rendering of `"record target"` pill when `false` with exact shortfalls list, `"validated project record"` only when every `validateRecordTargets` diagnostic passes in same authoritative result; `clearanceM` stays required finite Float64Array matching timeline length; worker cancellation deterministic for 420×280 heightfield buffers; `validateEngineeringWorkerResponse` still rejects extra fields.

**Test sketches:**

```ts
// record-protocol.test.ts
import { validateEngineeringWorkerResponse } from "./protocol.js";
test("success requires recordValidated boolean", ()=>{
  expect(()=>validateEngineeringWorkerResponse({type:"success", requestId:"r", file:{}, track:{}, timeline:{sampleRateHz:120,length:1,buffers:new Array(28).fill(new ArrayBuffer(8))}, diagnostics:[], relaxations:[], spanHashes:{a:"00000000"}, timings:{simulationMs:1,workerSendEpochMs:Date.now()}, clearanceM:new Float64Array([1]), recordValidated:false, recordDiagnostics:[]})).not.toThrow();
  expect(()=>validateEngineeringWorkerResponse({type:"success", requestId:"r", file:{}, track:{}, timeline:{}, diagnostics:[], relaxations:[], spanHashes:{a:"00000000"}, timings:{}, clearanceM:new Float64Array([1])} as any)).toThrow();
});
// experienceController.record.test.ts
test("stays on record target until validated", async ()=>{
  const ctrl = createExperienceController({...});
  // feed success with recordValidated=false, assert state.result.recordValidated===false and UI label helper returns "record target"
});
```

**RED CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts` expect `expected RecordValidated` or extra field rejection.

**GREEN implementation:** Extend protocol validation branches to require `recordValidated: boolean` and `recordDiagnostics: Diagnostic[]` array; update `handleGenerate`/`handleRegenerate`/`handleCompileSimulate` to compute `recordValidated = recordDiagnostics.length===0`; `collectTransferables` already promotes `clearanceM`; update `experienceController.ts:190` validation to check new fields non-empty type.

**Focused CI:** `npm run test -- apps/web/src/engineering/record-protocol.test.ts apps/web/src/experienceController.record.test.ts apps/web/src/engineering/client.test.ts`.

**Static review:** `Read apps/web/src/engineering/protocol.ts:192` no extra field allowed, `Read apps/web/src/experienceController.ts:260` epoch stale rejection intact.

**Commit:** `feat(web): wire worker record-validated state and target-vs-validated UI`

### Task 10 — Renderer scale, ride cameras, audio, reduced motion

- [ ] Large-terrain rendering stays `CompiledTrackData`-only

**Files:**
- Edit `apps/web/src/render/controller.ts:97` (terrain scale: `supportSpacing 10` unchanged, camera clipping `near:0.1, far:8000`, fog exponential with `floorY=-20`, scale check)
- Edit `apps/web/src/render/trackGeometry.ts:1` (tessellation from `CompiledTrackData` positions/tangents only; segment count adaptive but derived from `ADAPTIVE_MAX_*`)
- Edit `apps/web/src/render/supports.ts:1` (spacing check passes 5 km)
- Edit `apps/web/src/render/cameras.ts:1` (chase/orbit/front/middle/rear consume `RideTimeline` measured speed/forces, respect `prefers-reduced-motion` – no shake/wind scale when true)
- Edit `apps/web/src/audio/engine.ts:1` (wind and wheel sound scale from `speedMps`+`lateralG`/`verticalG`, mute flag respected)
- Create `apps/web/src/render/large-scale.test.ts`

**Consumed interfaces:** `CompiledTrackData` (`packages/core/src/track.ts:606`), `RideTimeline`/`SimulationFrame.telemetry` (`packages/simulator/src/contracts.ts:1`), `RidePlaybackSnapshot` (`apps/web/src/ride/controller.ts:1`), `HeightfieldEnvironment` bounds.

**Produced interfaces:** `createRendererController` still owns single `THREE.WebGLRenderer` + `requestAnimationFrame`; `attachTrack` tessellates only `CompiledTrackData`; support columns attach via `buildSupportColumns(data, env, 10)` where `env` is cliff-valley heightfield; camera `getCameraState` clamps `fov` via `clampFovForSpeed(speedMps)` and returns fallback diagnostic when `snapshot === null`.

**Test sketches:**

```ts
// large-scale.test.ts
import { createRendererController } from "./render/controller.js";
test("tessellation never invents spline beyond CompiledTrackData", async ()=>{
  const track = generateCoaster(createDesignIntentV1({...seed:1,mode:"insta"...})).track;
  const meshes = buildTrackGeometries(track);
  expect(meshes.leftRail.attributes.position.count).toBeGreaterThan(track.positions.length);
  expect(meshes.spine).toBeDefined();
});
```

**RED CI:** `npm run test -- apps/web/src/render/large-scale.test.ts` expect near/far mismatch or fallback regression.

**GREEN implementation:** Update `controller.ts` to set `camera.far=8000` when `track.totalLength>4000`; keep procedural single-file artifact invariant; no new runtime deps; honor `window.matchMedia("(prefers-reduced-motion: reduce)")` via `viewState.ts:1`.

**Focused CI:** `npm run test -- apps/web/src/render/large-scale.test.ts apps/web/src/audio/engine.test.ts`.

**Static review:** `Read apps/web/src/render/controller.ts:1` verify no import of `packages/generator`; verify `Read packages/core/src/track.ts:1` `CompiledTrackData` remains sole input.

**Commit:** `feat(render): scale renderer for 5 km cliff terrain with measured cameras/audio`

### Task 11 — Playwright record flows, screenshots, benchmark, README, full final CI

- [ ] Browser truth, steady-state 1080p, documentation

**Files:**
- Edit `e2e/record-hybrid.spec.ts` (new: `generate -> record target pill -> validated -> ride cameras -> plots -> audio reduced motion -> portable file:// -> screenshot`)
- Edit `playwright.config.ts:1` (keep `webServer` on `npm run dev`, `project: chromium`)
- Edit `scripts/bench.mjs:1` (ensure `bench:engineering` 3 warm-up + 50 seeds with `candidateSearchInclusive` nesting note; `bench:browser` 3 warm-up asserts `Ready` and `ovc:generation-total` mandatory, then 50 measured via `ovc:simulation`/`ovc:worker-transfer`/`ovc:mesh-create`/steady 1080p `ovc:frame`; honest p50/p95 miss report)
- Edit `README.md:1` (add Record-Hybrid section: metrics 5.2–5.4 km, 225–235 m, 285–295 km/h, 90–92 m top hat, 80–82 Immelmann, 66–68 loop, ~210 m/110° dive, force limits, 9,000 kg train, LSM 14kN/1.2MW, brake 18kN, terrain `cliff-valley-v1`, dated sources list, limitations)
- Edit `docs/limitations.md:1` or `README.md` limitations paragraph (ASTM `UNKNOWN_UNCONFIGURED`, non-structural supports, one-train scope, no wheel-contact analysis)
- Add snapshots `e2e/__screenshots__/record-hybrid-*.png` via committed binary via test artifacts (recorded in CI)

**Consumed interfaces:** `ExperienceController.status:"ready"` (`apps/web/src/experienceController.ts:16`), `Playwright test` fixtures, `bench.mjs` helpers, `apps/web/dist/OpenVibeCoaster.html` existence check (`ci.yml:111`).

**Produced interfaces:** E2E `chromium` run: navigates `/`, clicks `Generate`, asserts `[data-testid="record-target-pill"]` text `"record target"` before generation resolves, then after `Ready` asserts `"validated project record"` and exact shortfall list cleared, clicks ride camera tabs, captures `playwright` screenshots, checks zero console errors (`page.on("console", m=>expect(m.type()).not.toBe("error"))`), checks `file://` via `portable` artifact.

**Test sketches (Playwright):**

```ts
// e2e/record-hybrid.spec.ts
import { test, expect } from "@playwright/test";
test("record target vs validated state and ride cameras", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("record-target-pill")).toContainText("record target");
  await page.getByRole("button", {name:"Generate"}).click();
  await expect(page.getByText("Ready")).toBeVisible({timeout: 30000});
  await expect(page.getByTestId("record-validated-pill")).toContainText("validated project record");
  for(const cam of ["front","rear","chase","orbit"]) await page.getByRole("button",{name:cam}).click();
  expect(await page.evaluate(()=>performance.getEntriesByName("ovc:generation-total").length)).toBeGreaterThan(0);
});
```

**RED CI:** `npm run test:e2e -- --project=chromium --grep "record target"` expect no selector (until UI wired).

**GREEN implementation:** Add UI pill with `data-testid="record-target-pill"` / `"record-validated-pill"` driven by `recordValidated` from Task 09; ensure `bench.mjs` reports `candidateSearchInclusive` nesting verbatim and honest misses; update `README.md` source citations to `2026-09-01` URLs; keep no placeholder.

**Focused CI (full final):**
- Quality (ubuntu): `npm ci && npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build && npm run bench && npm run test:e2e -- --project=chromium`
- Portable (windows + macos): `npm ci && npm run build && test -f apps/web/dist/OpenVibeCoaster.html && test -s ... && npm run test:e2e:portable -- --project=webkit|edge`

**Static review:** `Read README.md:1` verify citations list, limitations paragraph, no `TODO`; `Read scripts/bench.mjs:1` verify benchmark stage labels; `Read playwright.config.ts:1` still `chromium` single file.

**Commit:** `docs: plan record-hybrid flagship implementation` already completed for plan; implementation task commit for this final step is `test(e2e): verify record flows, screenshots, and benchmark reporting`

---

## Self-Review Checklist (plan author)

- [ ] Every hard target from spec appears verbatim in Global Constraints and Tasks 01, 08 (5,200–5,400; 225–235; 285–295; 90–92; 80–82; 66–68; ~210/110°; +4.8–5.0/-1.1/<=1.5/<=15/<=1.5)
- [ ] No speculative element beyond `diveDrop`, `immelmann`, `verticalLoop` introduced; grep confirms absence of `terrainSwoop`
- [ ] All produced compilations use `positionCoefficients` (3×8) + `rollCoefficients` (6) with integrated `length`; renderer consumes only `CompiledTrackData`
- [ ] ASTM stays `UNKNOWN_UNCONFIGURED` in diagnostics and README
- [ ] Test sketches measure compiled geometry/timeline, never authored intent labels
- [ ] No placeholder text (`TBD`/`TODO`/`implement later`) present
- [ ] File paths resolved: `packages/core/src/contracts.ts:1`, `packages/generator/src/elements.ts:32`, `packages/generator/src/types.ts:10`, `packages/core/src/coaster-file.ts:156`, `packages/core/src/track.ts:297`, `packages/simulator/src/index.ts:1`, `apps/web/src/engineering/protocol.ts:1`, `apps/web/src/terrain/environment.ts:18`
- [ ] Worktree/branch integration DAG explicitly states packet order and independent review loops

## Verification Notes

No executable verification is claimed. Commands listed are for GitHub Actions (`quality` ubuntu-latest + `portable` windows/macos) as defined in `.github/workflows/ci.yml:1`. Do not run `node`/`npm`/`tsc`/`vitest`/`prettier`/`oxlint`/`vite`/`Playwright`/`Python` locally during this task; edit and `git log --oneline` inspection only.
