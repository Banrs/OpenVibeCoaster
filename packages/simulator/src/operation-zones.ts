import type { CoasterFileV1 } from "@openvibecoaster/core";
import type { OperationZone } from "./contracts";

const OPERATION_KINDS = new Set<OperationZone["kind"]>([
  "station",
  "launch",
  "boost",
  "brake",
]);

function semanticOwner(id: string): string {
  const match = id.match(/#\d+$/);
  if (match) return id.slice(0, -match[0].length);
  return id;
}

export function operationZonesFromCoasterFile(
  file: CoasterFileV1,
): readonly OperationZone[] {
  const intentElements = file.intent.elements;
  const intentById = new Map<string, (typeof intentElements)[number]>();
  for (const element of intentElements) {
    intentById.set(element.id, element);
  }

  const zonesByOwner = new Map<string, OperationZone>();
  const mutableByOwner = new Map<string, OperationZone & Record<string, unknown>>();

  let cumulative = 0;
  let lastOwner: string | undefined;

  for (const span of file.solvedSpans) {
    const start = cumulative;
    const end = cumulative + span.length;
    cumulative = end;

    const owner = semanticOwner(span.id);
    const element = intentById.get(owner);
    if (!element) {
      lastOwner = owner;
      continue;
    }
    const rawKind = (element.kind ?? element.type) as string | undefined;
    if (!rawKind || !OPERATION_KINDS.has(rawKind as OperationZone["kind"])) {
      lastOwner = owner;
      continue;
    }
    const kind = rawKind as OperationZone["kind"];

    const existing = mutableByOwner.get(owner);
    if (existing) {
      if (lastOwner !== owner) {
        throw new RangeError(
          `Operation zone owner "${owner}" appears in separated non-contiguous spans`,
        );
      }
      existing.endDistanceM = end;
    } else {
      const params = (element.parameters ?? {}) as Record<string, unknown>;
      const rawTarget = params.targetSpeed;
      let targetSpeedMps: number | undefined;
      if (typeof rawTarget === "number" && Number.isFinite(rawTarget)) {
        targetSpeedMps = rawTarget;
      } else if (kind === "station" && params.closed === true) {
        targetSpeedMps = 0;
      }

      const zone: OperationZone = {
        id: owner,
        kind,
        startDistanceM: start,
        endDistanceM: end,
        ...(targetSpeedMps !== undefined ? { targetSpeedMps } : {}),
      } as OperationZone;

      const mutable = zone as unknown as OperationZone & Record<string, unknown>;
      mutableByOwner.set(owner, mutable);
      zonesByOwner.set(owner, zone);
    }
    lastOwner = owner;
  }

  const zones = [...zonesByOwner.values()].sort(
    (a, b) => a.startDistanceM - b.startDistanceM,
  );

  for (const zone of zones) {
    Object.freeze(zone);
  }
  return Object.freeze(zones);
}
