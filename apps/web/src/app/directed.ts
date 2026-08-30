import {
  parseUint32Seed,
  type DirectedEditorInput,
  type DirectedGateInput,
  type DirectedTargetInput,
  type ElementKind,
} from "../directedInput.js";

function directedEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function quaternionFromYawPitch(
  yawDeg: number,
  pitchDeg: number,
): readonly [number, number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const w = cy * cp;
  const x = cy * sp;
  const y = sy * cp;
  const z = -sy * sp;
  const len = Math.hypot(x, y, z, w);
  if (len < 1e-12) return [0, 0, 0, 1];
  return [x / len, y / len, z / len, w / len];
}

export function buildDirectedInputFromDom(
  seedInputValue: string,
  pinnedElementIds: readonly string[],
): { editorInput: DirectedEditorInput; parsedSeed: number | null } {
  const seedStr = seedInputValue.trim();
  const parsedSeed = parseUint32Seed(seedStr);
  const gates: DirectedGateInput[] = [];
  for (let i = 0; i < 3; i++) {
    const enabledEl = directedEl(
      `gate-${i}-enabled`,
    ) as HTMLInputElement | null;
    if (!enabledEl?.checked) continue;
    const xEl = directedEl(`gate-${i}-x`) as HTMLInputElement | null;
    const yEl = directedEl(`gate-${i}-y`) as HTMLInputElement | null;
    const zEl = directedEl(`gate-${i}-z`) as HTMLInputElement | null;
    const yawEl = directedEl(`gate-${i}-yaw`) as HTMLInputElement | null;
    const pitchEl = directedEl(`gate-${i}-pitch`) as HTMLInputElement | null;
    const x = Number.parseFloat(xEl?.value ?? "0");
    const y = Number.parseFloat(yEl?.value ?? "0");
    const z = Number.parseFloat(zEl?.value ?? "0");
    const yaw = Number.parseFloat(yawEl?.value ?? "0");
    const pitch = Number.parseFloat(pitchEl?.value ?? "0");
    const orientation = quaternionFromYawPitch(yaw, pitch);
    gates.push({
      position: [x, y, z],
      orientation,
    });
  }

  const minX = Number.parseFloat(
    (directedEl("footprint-min-x") as HTMLInputElement | null)?.value ?? "-260",
  );
  const maxX = Number.parseFloat(
    (directedEl("footprint-max-x") as HTMLInputElement | null)?.value ?? "260",
  );
  const minZ = Number.parseFloat(
    (directedEl("footprint-min-z") as HTMLInputElement | null)?.value ?? "-180",
  );
  const maxZ = Number.parseFloat(
    (directedEl("footprint-max-z") as HTMLInputElement | null)?.value ?? "180",
  );
  const minY = Number.parseFloat(
    (directedEl("height-min") as HTMLInputElement | null)?.value ?? "0",
  );
  const maxY = Number.parseFloat(
    (directedEl("height-max") as HTMLInputElement | null)?.value ?? "100",
  );
  const polygon: [number, number][] = [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
  const terrainProfileId =
    (directedEl("terrain-profile") as HTMLSelectElement | null)?.value ??
    "rolling-highlands-v1";

  const requiredMap: Record<string, ElementKind> = {
    "required-top-hat": "topHat",
    "required-overbank": "overbankedTurn",
    "required-airtime-hill": "airtimeHill",
    "required-zero-g-roll": "zeroGRoll",
    "required-stall": "stall",
    "required-braked-turn": "brake",
  };
  const requiredElements: ElementKind[] = [];
  for (const [id, kind] of Object.entries(requiredMap)) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el?.checked) requiredElements.push(kind);
  }

  const requiresStall =
    (document.getElementById("required-stall") as HTMLInputElement | null)
      ?.checked ?? false;

  const hardTargets: DirectedTargetInput[] = [];
  const softTargets: DirectedTargetInput[] = [];
  const totalLengthValEl = directedEl(
    "target-total-length-value",
  ) as HTMLInputElement | null;
  const totalLengthClassEl = directedEl(
    "target-total-length-class",
  ) as HTMLSelectElement | null;
  const endYValEl = directedEl("target-end-y-value") as HTMLInputElement | null;
  const endYClassEl = directedEl(
    "target-end-y-class",
  ) as HTMLSelectElement | null;
  if (totalLengthValEl && totalLengthValEl.value.trim() !== "") {
    const v = Number.parseFloat(totalLengthValEl.value);
    if (Number.isFinite(v)) {
      const hard = (totalLengthClassEl?.value ?? "soft") === "hard";
      const entry: DirectedTargetInput = {
        id: "total-length",
        kind: "total-length",
        value: v,
        hard,
      };
      if (hard) hardTargets.push(entry);
      else softTargets.push(entry);
    }
  }
  if (endYValEl && endYValEl.value.trim() !== "") {
    const v = Number.parseFloat(endYValEl.value);
    if (Number.isFinite(v)) {
      const hard = (endYClassEl?.value ?? "soft") === "hard";
      const entry: DirectedTargetInput = {
        id: "end-y",
        kind: "end-y",
        value: v,
        hard,
      };
      if (hard) hardTargets.push(entry);
      else softTargets.push(entry);
    }
  }

  const editorInput: DirectedEditorInput = {
    seed: parsedSeed ?? 0,
    gates,
    footprint: { polygon, maxHeightM: maxY, minHeightM: minY },
    terrainProfileId,
    requiredElements,
    requiresStall: requiresStall ? true : false,
    hardTargets,
    softTargets,
    pinnedElementIds: [...pinnedElementIds],
  };

  return { editorInput, parsedSeed };
}
