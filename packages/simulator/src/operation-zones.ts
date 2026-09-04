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

type MutableOperationZone = {
  id: string;
  kind: OperationZone["kind"];
  startDistanceM: number;
  endDistanceM: number;
  targetSpeedMps?: number;
  holdSeconds?: number;
  releaseTargetSpeedMps?: number;
};

export function operationZonesFromCoasterFile(
  file: CoasterFileV1,
): readonly OperationZone[] {
  const intentElements = file.intent.elements;
  const intentById = new Map<string, (typeof intentElements)[number]>();
  for (const element of intentElements) {
    intentById.set(element.id, element);
  }

  const zonesByOwner = new Map<string, MutableOperationZone>();

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
    const params = (element.parameters ?? {}) as Record<string, unknown>;
    const trimSpeed = params.trimSpeed;
    const isTrimBrake =
      rawKind === "airtimeHill" &&
      typeof trimSpeed === "number" &&
      Number.isFinite(trimSpeed);
    if (
      !rawKind ||
      (!OPERATION_KINDS.has(rawKind as OperationZone["kind"]) && !isTrimBrake)
    ) {
      lastOwner = owner;
      continue;
    }
    const kind = isTrimBrake
      ? ("brake" as const)
      : (rawKind as OperationZone["kind"]);

    const existing = zonesByOwner.get(owner);
    if (existing) {
      if (lastOwner !== owner) {
        throw new RangeError(
          `Operation zone owner "${owner}" appears in separated non-contiguous spans`,
        );
      }
      existing.endDistanceM = end;
    } else {
      const rawTarget = isTrimBrake ? trimSpeed : params.targetSpeed;
      const rawHoldSeconds = params.holdSeconds;
      const rawReleaseSpeed = params.releaseSpeed;
      let targetSpeedMps: number | undefined;
      if (typeof rawTarget === "number" && Number.isFinite(rawTarget)) {
        targetSpeedMps = rawTarget;
      } else if (kind === "station" && params.closed === true) {
        targetSpeedMps = 0;
      }

      const zone: MutableOperationZone = {
        id: owner,
        kind,
        startDistanceM: start,
        endDistanceM: end,
        ...(targetSpeedMps !== undefined ? { targetSpeedMps } : {}),
        ...(typeof rawHoldSeconds === "number" &&
        Number.isFinite(rawHoldSeconds)
          ? { holdSeconds: rawHoldSeconds }
          : {}),
        ...(typeof rawReleaseSpeed === "number" &&
        Number.isFinite(rawReleaseSpeed)
          ? { releaseTargetSpeedMps: rawReleaseSpeed }
          : {}),
      };

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
  return Object.freeze(zones) as readonly OperationZone[];
}
