# OpenVibeCoaster

OpenVibeCoaster is a browser-native roller-coaster engineering simulator and
ride experience. It is intended to make a seeded coaster design editable,
analysable, and ridable while keeping engineering calculations deterministic
and separate from presentation.

This is a game/simulation foundation, not professional design, safety, or ride
certification software. Project limits are editable assumptions. The
ASTM F2291-26 record in this repository contains public catalog metadata only
and is not a licensed standards profile.

## Architecture and authoritative data flow

The repository has four workspaces: `@openvibecoaster/core`,
`@openvibecoaster/simulator`, `@openvibecoaster/generator`, and
`@openvibecoaster/web`. The one authoritative track representation is
`CompiledTrackData`:

```text
DesignIntentV1
  -> semantic elements and transition solve
  -> SolvedSpan[]
  -> immutable CompiledTrackData
  -> simulation and validation
  -> inline browser worker (generate/regenerate/compile-simulate) with cancellation and transferable canonical arrays
  -> Three.js rendering, DOM editor, telemetry, and ride cameras
```

Rendering may tessellate `CompiledTrackData`, but it must not create a second
spline. Engineering values use SI units internally; the world is right-handed
(X right, Y up, Z forward). Frames are rotation-minimizing across the complete
track with authored bank about the tangent. See
[the architecture note](docs/architecture.md) for package boundaries,
seventh/quintic spans, environment/clearance, and deterministic bounds.

## Development

Use Node.js 24 LTS (Krypton, the CI baseline) or Node.js 26 with npm 11.17.0.
Install exact dependencies, then run the commands below from the repository
root:

```text
npm ci
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm run test
npx playwright install --with-deps chromium
npm run test:e2e
npm run build
npm run bench
npm run verify
```

`npm run verify` runs `typecheck && lint && format:check && test && build`.
`npm run bench` runs the complete benchmark gate: the deterministic engineering benchmark (3 warm-up + 50 measured seeds, p50/p95 for `candidateSearchInclusive`/`searchOverhead`/`solving`/`compilation`/`validation`/`total` – `candidateSearchInclusive` nests `solving` and `validation` and is not additive with them) plus the production Chromium browser benchmark (3 warm-up seeds each asserting `Ready` and mandatory `ovc:generation-total`, then 50 measured seeds reporting p50/p95 for `ovc:generation-total`, `ovc:simulation`, `ovc:worker-transfer`, `ovc:mesh-create`, and steady-state 1080p `ovc:frame`); target misses are reported honestly. Use `npm run bench:engineering` or `npm run bench:browser` for the individual gates. The production preview server is used for the browser gate; `npm run test:e2e` remains the full E2E gate.
The GitHub Actions CI enforces Node 24 and npm 11.17.0 with shell-native
assertions, runs the quality gate (typecheck, lint, format, unit tests, build,
bench, Playwright Chromium) on `ubuntu-latest`, and verifies the portable
artifact on `windows-latest` and `macos-latest`. Build-time npm dependencies
(Node 24, npm 11.17.0, Vite, TypeScript, Vitest, Playwright, Oxlint, Prettier)
are disclosed in `package.json` and `apps/web/package.json`. Three.js is
bundled into `OpenVibeCoaster.html` at build time as the runtime rendering
code; no runtime package install, CDN, server, or network fetch is required.

## Portable build and offline use

On Windows and macOS, after `npm run build`, open the portable artifact
directly in a current built-in browser:

```text
apps/web/dist/OpenVibeCoaster.html
```

Double-click the file or use File > Open in Edge, Chrome, Safari, or Firefox.
No server (`vite preview` is not required), `npm install` at runtime, account,
backend, CDN, web fonts, or media download is required. The rendering code
(Three.js) is already bundled inside the HTML by
`apps/web/scripts/portable-packager.mjs`, which inlines CSS and JS so the
output is a single-file offline artifact. The inline browser worker is
Vite-inlined and Blob-backed (`apps/web/src/engineering/factory.ts` via
`?worker&inline`) so the portable file has no runtime network, backend, or
install requirement on current Windows/macOS browsers. The project does not
produce a native executable; the only distribution is this HTML file.

## Flagship intent and default train

The flagship design intent is an 80 m inverted top-hat target. It is a
`DESIGN_TARGET`, not evidence that an unvalidated generated track achieves
80 m. The dated records on 2026-08-29 document Spitfire at 73 m and
127 km/h, and Falcons Flight at 195 m, 250 km/h, and 4,325 m length. Each
official metric fact carries its official `sourceUrls` with a nearby
`relatedSourceUrls` pointing to the corresponding RCDB entry
(21313 for Spitfire, 21315 for Falcons Flight) and a note that RCDB
source-native values are recorded separately and are not asserted as
conversions; RCDB source-native facts carry the inverse. The snapshot
compares the 80 m target with the source-verified 73 m Spitfire height as a
derived 7 m difference (`80 m - 73 m`); this is not a safety or record claim.

The default generation sequence (seeded, deterministic) is:
`station` (120 m) -> `launch` (260 m, 44 m/s) -> `topHat` (width 220 m) ->
`overbankedTurn` (r 75 m, 0.75 pi, bank 0.6 pi) -> `airtimeHill` (130 m +
variation, force-driven height, 1.15 g) -> `boost` (220 m, 44 m/s) ->
`zeroGRoll` (28 m, 2 pi) -> `stall` (100 m, 18 m) -> `brake` (220 m, 8 m/s) ->
`brake` (110 m, 5 m/s) -> `station` (160 m). The 80 m target remains
unvalidated until a generated result passes hard-constraint diagnostics.

The default train profile is a six-car steel sit-down LSM train. Its values
are `DESIGN_ASSUMPTION`: 1,500 kg loaded mass per car, 3.4 m car pitch,
0.002 rolling resistance, 4.0 drag CdA, 1.225 kg/m3 air density,
14,000 N maximum LSM force per car, 1,200,000 W maximum LSM power per car,
18,000 N maximum brake force per car, and envelope
`halfWidthM: 1.25, aboveRailM: 2.1, belowRailM: 0.8, noseTailMarginM: 0.75`
in [the train profile](data/profiles/train-lsm-v1.json).

Project diagnostic limits in
[engineering-limits-v1.json](data/profiles/engineering-limits-v1.json) are
`PROJECT_ENGINEERING_LIMIT`: vertical -1.2 to 5.0 g, absolute lateral 1.5 g,
absolute longitudinal 1.5 g, jerk 15 m/s3, roll rate 1.5 rad/s, clearance
margin 0.5 m, and seam tolerances (position 0.0001 m, tangent 0.00001 rad,
etc.). They are editable project thresholds, not standards.

The workflow is to choose a seed and design intent, generate a track via the
inline browser worker (`generate`/`regenerate`/`compile-simulate`) with
explicit cancellation and transferable canonical arrays, inspect diagnostics
and telemetry, ride it, and save or load a JSON coaster file.
`ExperienceController` (`apps/web/src/experienceController.ts`) is the single
authority for the accepted result, last-good result, selection, pins, local
edits/regeneration, save/load, and stale-response rejection. Generated tracks
render with telemetry, seam/metric inspection, ride cameras (front, middle,
rear, chase, orbit), procedural audio, directed controls, diagnostics/
relaxations, and a WebGL fallback. Loading recompiles stored solved
coefficients without re-solving and verifies the canonical file/checksum path;
only a validated result becomes ready.

## Provenance and research data

Machine-readable research lives in
[the dated records snapshot](data/records/records-2026-08-29.json), with
source URLs and retrieval dates beside each fact. `sourceUrls` is reserved for
sources that actually support the stated value; nearby `relatedSourceUrls`
with a concise note provides context-only URLs (e.g., RCDB entries beside
official metric facts and vice versa) without claiming a corroborating
conversion. The focused source notes are in
[docs/research-snapshot.md](docs/research-snapshot.md).

The repository distinguishes these labels:

- `SOURCE_VERIFIED`: value or metadata recorded from the cited source.
- `DERIVED`: arithmetic or conversion produced from recorded values.
- `DESIGN_TARGET`: authored intent that still needs validation.
- `PROJECT_ENGINEERING_LIMIT`: editable project diagnostic limit, not a
  standards threshold.
- `DESIGN_ASSUMPTION`: model input chosen for the default train.
- `UNKNOWN_UNCONFIGURED`: no licensed ASTM criteria are configured.

The ASTM F2291-26 file at `https://store.astm.org/standards/f2291` stores
only designation, title, status (Active), last updated 2026-07-15, DOI, and
source. It intentionally contains no proprietary acceleration thresholds and
makes no compliance or certification claim. Every external fact carries its
source URL and `retrievedAt: 2026-08-29` without copying copyrighted text.

## Browser requirements and persistence

Use a current browser with JavaScript, WebGL, and hardware acceleration
available. The viewport provides a fallback message when WebGL is unavailable;
Playwright Chromium is the automated browser baseline. No backend, account, or
network service is required for the intended local workflow.

Save/Export downloads the canonical `CoasterFileV1` (design intent, stored
solved coefficients, versions, and checksum) via the controller's save/load
path; telemetry is re-derived on load. Load accepts a JSON coaster file
through the browser file picker and recompiles stored solved coefficients
without re-solving, verifying the canonical file/checksum path before a
result becomes ready.

All redistributable visual assets are procedural unless redistribution rights
are recorded. The repository does not depend on proprietary ride or standards
assets and does not fetch fonts, media, or additional code from a CDN at
runtime; all required runtime code is already bundled in the portable HTML.

## v1 limitations

The v1 scope is deliberately small: constrained point-train dynamics,
heightfield terrain, one train, visual-only supports, no bogie/wheel-contact
model, no structural analysis, no licensed standards profile, and a small
semantic element library. These limitations are part of the current design
boundary, not claims about a finished commercial engineering tool.
