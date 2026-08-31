import {
  arcLength,
  footprintBounds,
  type DesignIntentV1,
  type FootprintPolygon,
} from "@openvibecoaster/core";
import {
  buildElement,
  createAnyElement,
  defaultPose,
  poseFromGate,
} from "./elements";
import type { AnySemanticElement, Pose } from "./types";
import { CertifiedWorkBudget, WorkBudgetExceeded } from "./polynomial-bounds";
import { certifyFootprintSpan } from "./footprint-certifier";

const R = 20;
const MARGIN = 22;
const SHORT_INITIAL = 30;

export const isRequirementStyleDirectedIntent = (
  intent: DesignIntentV1,
): boolean => {
  if (intent.mode !== "directed") return false;
  if (intent.footprint === undefined) return false;
  return intent.constraints.some((constraint) =>
    [
      "required-element",
      "required-footprint",
      "required-height-range",
      "terrain-profile",
    ].includes(constraint.kind),
  );
};

export const deriveGateStartPose = (
  intent: DesignIntentV1,
): Pose | undefined => {
  if (intent.gates.length === 0) return undefined;
  return poseFromGate(intent.gates[0]!);
};

const buildSwitchbackScaffold = (
  straightLength: number,
  laneCount: number,
  initialTurnSign: number,
  firstUSign: number,
  lanesAlongX: boolean,
): AnySemanticElement[] => {
  const lanes: AnySemanticElement[] = [];
  const laneKinds: Array<{
    kind: "launch" | "boost" | "brake" | "station";
    id: string;
  }> = [
    { kind: "launch", id: "launch-002" },
    { kind: "boost", id: "boost-004" },
    { kind: "brake", id: "brake-006" },
    { kind: "station", id: "station-008" },
  ];
  for (
    let index = 0;
    index < Math.min(laneCount, laneKinds.length);
    index += 1
  ) {
    const entry = laneKinds[index]!;
    if (
      entry.kind === "launch" ||
      entry.kind === "boost" ||
      entry.kind === "brake"
    ) {
      const targetSpeed = entry.kind === "brake" ? 8 : 25;
      lanes.push(
        createAnyElement(entry.kind, entry.id, {
          length: straightLength,
          targetSpeed,
          bank: 0,
        }),
      );
    } else {
      lanes.push(
        createAnyElement(entry.kind, entry.id, {
          length: straightLength,
          bank: 0,
          closed: false,
        }),
      );
    }
  }
  while (lanes.length < laneCount) {
    const id = `station-${String(100 + lanes.length).padStart(3, "0")}`;
    lanes.push(
      createAnyElement("station", id, {
        length: straightLength,
        bank: 0,
        closed: false,
      }),
    );
  }

  const scaffold: AnySemanticElement[] = [];
  scaffold.push(
    createAnyElement("station", "station-000", {
      length: SHORT_INITIAL,
      bank: 0,
      closed: false,
    }),
  );
  const entryAngle = lanesAlongX
    ? (initialTurnSign * Math.PI) / 2
    : initialTurnSign * Math.PI;
  scaffold.push(
    createAnyElement("overbankedTurn", "overbankedTurn-001", {
      radius: R,
      angle: entryAngle,
      bank: 0,
    }),
  );
  for (let index = 0; index < laneCount; index += 1) {
    scaffold.push(lanes[index]!);
    if (index < laneCount - 1) {
      const sign = index % 2 === 0 ? firstUSign : -firstUSign;
      scaffold.push(
        createAnyElement(
          "overbankedTurn",
          `overbankedTurn-${String(300 + index).padStart(3, "0")}`,
          { radius: R, angle: sign * Math.PI, bank: 0 },
        ),
      );
    }
  }
  const finalSign = laneCount % 2 === 0 ? firstUSign : -firstUSign;
  scaffold.push(
    createAnyElement("overbankedTurn", "overbankedTurn-007", {
      radius: R,
      angle: (finalSign * Math.PI) / 2,
      bank: 0,
    }),
  );
  scaffold.push(
    createAnyElement("topHat", "topHat-009", {
      width: 40,
      height: 80,
      bank: 0,
    }),
  );
  scaffold.push(
    createAnyElement("stall", "stall-010", { length: 32, height: 18, bank: 0 }),
  );
  return scaffold;
};

type FootprintFit = "fits" | "does-not-fit" | "uncertified";

const scaffoldFitsFootprint = (
  scaffold: readonly AnySemanticElement[],
  gate: DesignIntentV1["gates"][number] | undefined,
  footprint: DesignIntentV1["footprint"],
  budget: CertifiedWorkBudget,
): FootprintFit => {
  if (footprint === undefined) return "fits";
  const polygon = footprint as FootprintPolygon;
  const start: Pose = gate === undefined ? defaultPose() : poseFromGate(gate);
  let pose: Pose = start;
  for (const element of scaffold) {
    const built = buildElement(element, pose, 44);
    for (const span of built.solvedSpans) {
      try {
        const result = certifyFootprintSpan(span, polygon, {
          station: 0,
          budget,
          maxDepth: 32,
        });
        if (result.status === "outside") return "does-not-fit";
        if (result.status === "uncertified") return "uncertified";
      } catch (error) {
        if (error instanceof WorkBudgetExceeded) return "uncertified";
        throw error;
      }
    }
    pose = built.endPose;
  }
  return "fits";
};

const totalLengthForScaffold = (
  scaffold: readonly AnySemanticElement[],
): number => {
  let pose: Pose = defaultPose();
  let total = 0;
  for (const element of scaffold) {
    const built = buildElement(element, pose, 44);
    for (const span of built.solvedSpans) total += arcLength(span.span);
    pose = built.endPose;
  }
  return total;
};

export const selectSwitchbackScaffold = (
  footprint: DesignIntentV1["footprint"],
  targetLength: number | undefined,
  gate: DesignIntentV1["gates"][number] | undefined,
  budget: CertifiedWorkBudget,
): AnySemanticElement[] | undefined => {
  const bounds =
    footprint !== undefined
      ? footprintBounds(footprint as FootprintPolygon)
      : undefined;
  const widthX = bounds !== undefined ? bounds.max[0] - bounds.min[0] : 520;
  const depthZ = bounds !== undefined ? bounds.max[2] - bounds.min[2] : 360;
  const usableX = widthX - 2 * R - 2 * MARGIN;
  const usableZ = depthZ - 2 * R - 2 * MARGIN;
  const lanesAlongX = usableX >= usableZ;
  const laneUsableGlobal = lanesAlongX ? usableX : usableZ;
  const stackUsableGlobal = lanesAlongX ? usableZ : usableX;
  const clampedLaneUsable = Math.max(30, Math.min(500, laneUsableGlobal));

  const gateX = gate?.position[0] ?? 0;
  const gateZ = gate?.position[2] ?? 0;
  const footprintMinX = bounds?.min[0] ?? -260;
  const footprintMaxX = bounds?.max[0] ?? 260;
  const footprintMinZ = bounds?.min[2] ?? -180;
  const footprintMaxZ = bounds?.max[2] ?? 180;
  const distToMinX = gateX - footprintMinX - R - MARGIN;
  const distToMaxX = footprintMaxX - gateX - R - MARGIN;
  const distToMinZ = gateZ - footprintMinZ - R - MARGIN;
  const distToMaxZ = footprintMaxZ - gateZ - R - MARGIN;
  const effectiveLaneUsable = lanesAlongX
    ? Math.max(distToMinX, distToMaxX)
    : Math.max(distToMinZ, distToMaxZ);
  const laneLimit = Math.max(
    30,
    Math.min(500, Math.min(clampedLaneUsable, effectiveLaneUsable)),
  );

  if (targetLength === undefined || !Number.isFinite(targetLength)) {
    const straightLength = Math.min(80, laneLimit);
    return buildSwitchbackScaffold(straightLength, 4, 1, 1, lanesAlongX);
  }

  const laneOrder = [5, 4, 6, 7, 8];
  for (const laneCount of laneOrder) {
    const provisional = totalLengthForScaffold(
      buildSwitchbackScaffold(30, laneCount, 1, 1, lanesAlongX),
    );
    const requiredL = 30 + (targetLength - provisional) / laneCount;
    if (requiredL < 30 || requiredL > laneLimit) continue;
    const stackNeeded = lanesAlongX
      ? (laneCount - 1) * (2 * R) + SHORT_INITIAL
      : (laneCount - 1) * (2 * R);
    if (stackNeeded > stackUsableGlobal) continue;
    const clampedL = Math.max(30, Math.min(laneLimit, requiredL));
    const distToMinStack = lanesAlongX ? distToMinZ : distToMinX;
    const distToMaxStack = lanesAlongX ? distToMaxZ : distToMaxX;
    const preferPositive = distToMaxStack >= distToMinStack;
    const firstSignOptions = preferPositive ? [1, -1] : [-1, 1];
    const trySigns: Array<[number, number]> = [];
    for (const initialSign of firstSignOptions) {
      for (const firstUSign of firstSignOptions) {
        if (!lanesAlongX && initialSign === firstUSign) continue;
        trySigns.push([initialSign, firstUSign]);
      }
    }
    for (const [initialSign, firstUSign] of trySigns) {
      const scaffold = buildSwitchbackScaffold(
        clampedL,
        laneCount,
        initialSign,
        firstUSign,
        lanesAlongX,
      );
      const fit = scaffoldFitsFootprint(scaffold, gate, footprint, budget);
      if (fit !== "does-not-fit") {
        // uncertified deliberately skips only the ordering prefilter and the separate final validator remains authoritative
        return scaffold;
      }
    }
  }

  const provisional = totalLengthForScaffold(
    buildSwitchbackScaffold(30, 4, 1, 1, lanesAlongX),
  );
  const baseStraight = 30 + (targetLength - provisional) / 4;
  const straightLength = Math.max(30, Math.min(laneLimit, baseStraight));
  return buildSwitchbackScaffold(
    Math.max(30, Math.min(500, straightLength)),
    4,
    1,
    1,
    lanesAlongX,
  );
};
