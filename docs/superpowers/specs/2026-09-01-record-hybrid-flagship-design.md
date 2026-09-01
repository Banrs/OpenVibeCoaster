# Record-Hybrid Flagship Design

## Status and decision

Approved direction: replace the compact default flagship with a credible
near-future record coaster inspired by Falcon's Flight's terrain-scale,
multi-launch pacing and Tormenta Rampaging Run's held beyond-vertical drop and
large inversions. Realistic energy, force, transition, braking, and terrain
requirements take priority over fitting the old footprint.

This is an original procedural design, not a replica. Falcon's Flight and
Tormenta are factual baselines and ride-experience references only.

## Alternatives considered

1. **Full record hybrid (selected).** Build a 5.2 km terrain coaster with a
   225 m cliff summit, 285 km/h measured speed, a held cliff dive, and large
   inversions. This satisfies the user's required 10–25% record margins while
   leaving room for realistic launches and recovery transitions.
2. **Style-only compact flagship (rejected).** Keep the existing 1.6–2.2 km,
   approximately 160 km/h envelope and borrow visual motifs. It would not break
   the named records.
3. **Uniform +25% escalation (rejected).** Raise every baseline by 25%. It
   produces a 244 m / 312.5 km/h machine and makes the current train power,
   aerodynamic, braking, and runtime budgets much harder to satisfy without
   inventing capabilities.

## Verified baselines and hard targets

Baselines are captured as source facts; targets are project engineering
requirements until generated geometry and simulation prove them.

| Metric | Verified baseline | Hard project target | Margin |
| --- | ---: | ---: | ---: |
| Track length | Falcon's Flight 4,325 m | 5,200–5,400 m | at least +20.2% |
| Ride height | Falcon's Flight 195 m | 225–235 m | at least +15.4% |
| Maximum speed | Falcon's Flight 250 km/h | 285–295 km/h | at least +14.0% |
| Inversion height | Spitfire 73 m | 90–92 m inverted top hat | at least +23.3% |
| Immelmann height | Tormenta 66 m | 80–82 m | at least +21.2% |
| Vertical-loop height | Tormenta 55 m | 66–68 m | at least +20.0% |

The held cliff drop targets approximately 210 m at 110 degrees from horizontal.
It is Tormenta-inspired but is not presented as a steepness record. Natural
terrain supplies most of the elevation, avoiding an implausible 225 m
freestanding lift structure.

Authoritative sources:

- Falcon's Flight official park/manufacturer facts: 195 m height, 250 km/h,
  4,325 m track; Intamin also documents three launch sections, a cliff summit,
  holding brakes, a final launch, a 165 m camelback, elongated high-speed
  elements, gentle banking, and recovery moments.
  <https://sixflagsqiddiyacity.com/en/explore/rides/falcons-flight>
  <https://www.intamin.com/project/falcons-flight/>
- Tormenta official park/manufacturer facts: 94 m height, 87 m drop at 95
  degrees, 140 km/h, 66 m Immelmann, 55 m loop, and 1,280 m length.
  <https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run>
  <https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run>
- Spitfire official inversion baseline: 73 m.
  <https://www.intamin.com/project/spitfire-six-flags-qiddiya/>

Implementation adds a dated `2026-09-01` source snapshot. It does not mutate
the existing `2026-08-29` snapshot.

## Ride narrative and physical allocation

The default route is approximately:

1. 180 m station and dispatch run.
2. First LSM rollout and rising transition into a roughly 60 m twisted drop.
3. A broad terrain-following warm-up with two banked direction changes and an
   airtime rise; no rapid succession of arbitrary elements.
4. A long second LSM climb to a 225–235 m cliff summit at a controlled speed.
5. An outward-banked summit turn and a short semantic brake zone targeting
   static hold for approximately three seconds.
6. A coefficient-backed 210 m, 110-degree cliff dive into a terrain trench.
7. A long third LSM section that uses the drop's existing kinetic energy to
   reach a measured 285–295 km/h under the configured force, power, drag, and
   train-mass assumptions.
8. A roughly 190 m camelback followed by long, low high-speed turns and hills
   that provide recovery between intensity peaks.
9. A 90–92 m inverted top hat, an 80–82 m Immelmann, and a 66–68 m vertical
   loop, separated by physically adequate transitions.
10. An overbank, zero-G roll, and stall as lower-speed finale elements.
11. A curved trim/brake turn, long magnetic braking, and open terminal station
    with semantic target speed 0 m/s.

The solver may lengthen launch, transition, and brake spans inside the
5,200–5,400 m envelope. It may not shrink record elements, silently relax a
hard target, clamp speed, or invent train power.

## Semantic geometry

The existing semantic library remains authoritative for station, launch,
boost, transition, top hat, airtime hill, overbanked turn, zero-G roll, stall,
and brake. Add only three record-profile elements:

- `diveDrop`: multi-span seventh-order geometry for the summit exit and
  beyond-vertical cliff drop. Parameters are physical drop height, angle,
  approach/exit radii, and bank. Holding is a preceding ordinary brake zone,
  not hidden inside geometry.
- `immelmann`: multi-span half-loop and roll with one global RMF and authored
  bank; height and exit heading are explicit.
- `verticalLoop`: force-shaped loop geometry with explicit height and reference
  speed; entrance/exit curvature and curvature-gradient seams remain hard.

Each element serializes its exact coefficient children. Every
`SerializedSolvedSpanV1.length` is the integrated physical length of that child;
semantic authored lengths remain in intent only. No renderer spline, sampled
repair, or post-compile smoothing is permitted.

Existing transitions, overbanks, and airtime hills form the terrain run and
camelback. No generic `terrainSwoop` or record-specific rendering model is
introduced.

## Energy, train, operations, and force realism

The default six-car, 9,000 kg loaded train and published project assumptions
remain unchanged: 14 kN per-car LSM force cap, 1.2 MW power cap, total
`CdA = 4.0 m²`, rolling coefficient `0.002`, air density `1.225 kg/m³`, and
18 kN per-car magnetic-brake force cap. The 210 m drop supplies most of the
energy before the final launch, so 285 km/h does not require an invented short,
high-power acceleration.

Launch and braking lengths are outputs of the real energy model. If the current
caps cannot reach or stop the train inside the physical envelope, generation
fails with exact work/energy and constraint diagnostics. The implementation
lengthens track before considering any explicit profile change.

Intensity targets are:

- brief vertical specific-force peaks of +4.8 to +5.0 g;
- negative vertical specific force down to approximately -1.1 g;
- lateral and longitudinal magnitude no greater than 1.5 g;
- jerk no greater than 15 m/s³;
- roll rate no greater than 1.5 rad/s.

These are editable `PROJECT_ENGINEERING_LIMIT` values, not ASTM values. ASTM
F2291 metadata stays `UNKNOWN_UNCONFIGURED`; without a licensed,
duration-dependent profile the app must not claim ASTM certification or
compliance. The record profile may approach project limits but never suppresses
or downgrades their diagnostics.

The summit hold is a real operational state. Signed speed, static hold,
rollback, and restart remain authoritative; the simulator may not pin the train
to the track position with an invisible clamp.

## Terrain and footprint

The default heightfield becomes a wide cliff-and-valley environment sized for
the 5.2 km route. Insta mode does not impose the former compact footprint.
Directed mode still honors user-supplied hard polygons and gates; an infeasible
record profile returns tested relaxations rather than leaving the footprint.

Clearance continues to use certified swept train-envelope and terrain bounds.
The larger terrain may require spatial-index and work-budget optimization, but
never sampled-only clearance or lower validation fidelity.

## Record validation and UI truth

The record profile flows through the existing single authority:

```text
source snapshot + record profile
  -> DesignIntentV1
  -> solved coefficient geometry
  -> CompiledTrackData
  -> RideTimeline
  -> record diagnostics and UI
```

Geometry validates physical total length, height, inversion height, Immelmann,
loop, drop, and seams. Simulation validates measured speed, launch/brake work,
forces, jerk, rollback, and operation timing. A result becomes a
"validated project record" only when every hard target passes in the same
authoritative result. Before that, the UI says "record target" and lists exact
shortfalls. It never says world record, certified, or ASTM-compliant based only
on authored intent.

Save/reload preserves the record profile version, dated research snapshot IDs,
semantic intent, exact coefficients, checksum, and editability. Loading
recompiles without re-solving.

## Rendering and sound

Rendering continues to consume only `CompiledTrackData`. The terrain scale,
camera clipping range, support spacing, and procedural atmosphere are adjusted
for the larger ride. The train may gain procedural windshield/body geometry to
communicate high speed, but no licensed assets or new runtime dependencies are
added. Ride cameras and audio consume measured timeline values; camera shake,
wind, and wheel sound scale from speed/forces and respect reduced motion/mute.

## Failure behavior

- A missed record metric is a hard diagnostic with target, actual, margin,
  physical location where meaningful, and related element IDs.
- Unreachable speed reports energy/LSM evidence; it is not clamped upward.
- Insufficient braking reports the end speed and required margin; the station
  target is not silently weakened.
- Seam, clearance, force, jerk, roll-rate, or work-budget failures remain hard.
- ASTM compliance remains unknown regardless of whether project limits pass.

## Verification

Focused tests must prove:

- exact record-profile parsing, source IDs, deltas, and hard/soft status;
- deterministic 5,200–5,400 m geometry across seeds and save/reload;
- at least 225 m physical height and 90 m inversion height;
- dive/Immelmann/loop endpoints, handedness, RMF continuity, all seam metrics,
  and infeasible variants;
- measured 285 km/h minimum without energy invention, plus launch and brake work
  accounting;
- force, jerk, roll-rate, hold, rollback, and restart behavior;
- terrain and swept-envelope clearance over the enlarged environment;
- operation zones never exceed compiled physical length;
- worker cancellation/transfer determinism for the larger buffers;
- browser record-target versus validated-state truth, ride cameras, plots,
  audio, reduced motion, portable `file://`, screenshots, and zero console
  errors;
- 3 warm-up + 50 deterministic seed benchmark with honest p50/p95 and no
  reduced validation.

All executable verification remains GitHub-CI-only until the user changes that
instruction. The final integration still requires the repository's complete
Node 24 gates and real-browser review before `main` is pushed.

## Scope boundaries

- No structural, wheel-contact, bogie, or licensed standards analysis.
- No backend, deployment, external runtime service, or new runtime dependency.
- One train remains the v1 operational scope.
- Visual supports remain non-structural.
- Record labels are dated comparisons, never permanent guarantees.
