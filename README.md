# OpenVibeCoaster

OpenVibeCoaster is a browser-native roller-coaster engineering simulator and
ride experience built with TypeScript and raw Three.js. A single canonical
track drives simulation, validation, rendering, telemetry, editing, and ride
cameras.

This project is a game/simulation foundation, not professional design or ride
certification software. Project engineering limits are documented assumptions;
an unconfigured ASTM profile is never presented as compliance.

## Development

Node.js 24 LTS or Node.js 26 is required.

```text
npm ci
npm run dev
npm run verify
npm run test:e2e
npm run bench
```

The repository intentionally contains no backend, accounts, multiplayer, park
management, guest simulation, structural support analysis, or licensed ride
standards.
