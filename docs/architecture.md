# OpenVibeCoaster architecture

## Authoritative pipeline

```text
DesignIntentV1
  -> semantic element and transition solve
  -> SolvedSpan[]
  -> immutable CompiledTrackData
  -> simulation and validation
  -> worker transfer
  -> Three.js rendering, DOM editor, telemetry, and ride cameras
```

`@openvibecoaster/core`, `@openvibecoaster/simulator`, and
`@openvibecoaster/generator` are browser-independent, pure TypeScript. They may
not import Three.js, DOM APIs, Web Audio, or mutable application state.

`CompiledTrackData` is the only downstream track representation. Rendering may
tessellate it but must never maintain an independent spline. Camera smoothing
and playback interpolation are visual only and do not change simulation data.

## Numerical conventions

- SI units internally; unit brands at public boundaries.
- Right-handed world coordinates: X right/east, Y up, Z forward/north.
- One rotation-minimizing frame transported over the whole track, with authored
  roll applied about the tangent. Frames never reset at element seams.
- General transitions use seventh-order Hermite position spans; authored roll
  uses quintic spans.
- No sampled-vertex seam smoothing is permitted. Failed hard constraints return
  diagnostics and suggested relaxations.
- Simulation uses signed speed and fixed train spacing. Rollback and reversal
  are real states.

## Packages

- `core`: units, vector math, analytic spans, frames, arc length, compiled track,
  environments, diagnostics, and coaster files.
- `simulator`: train dynamics, operation zones, forces, telemetry, and energy.
- `generator`: semantic elements, solving, deterministic search, clearance,
  local regeneration, and worker messages.
- `web`: browser worker, rendering, UI, plots, cameras, audio, and persistence.
