import type {
  CoasterFileV1,
  Diagnostic,
  DesignElementV1,
} from "@openvibecoaster/core";
import {
  canonicalJson,
  compileCoasterFile,
  createCoasterFileV1,
  createDesignIntentV1,
} from "@openvibecoaster/core";
import type { LocalRegenerateRequest } from "../experienceController.js";

export type PinnedRegenerationPreparation =
  | {
      readonly kind: "proceed";
      readonly workerFile: CoasterFileV1;
      readonly targetId: string;
      readonly restoreId: string | null;
      readonly originalPinnedIds: readonly string[];
    }
  | { readonly kind: "fatal"; readonly diagnostic: Diagnostic };

function areParametersEqual(
  a: DesignElementV1 | undefined,
  b: DesignElementV1 | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aParams = a.parameters ?? {};
  const bParams = b.parameters ?? {};
  return canonicalJson(aParams) === canonicalJson(bParams);
}

function findNearestUnpinned(
  fileElements: readonly DesignElementV1[],
  pinned: readonly string[],
  targetId: string | null,
): string | null {
  if (!targetId) {
    const firstUnpinned = fileElements.find((el) => !pinned.includes(el.id));
    return firstUnpinned?.id ?? null;
  }
  const idx = fileElements.findIndex((el) => el.id === targetId);
  if (idx === -1) {
    const firstUnpinned = fileElements.find((el) => !pinned.includes(el.id));
    return firstUnpinned?.id ?? null;
  }
  let nearest: string | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < fileElements.length; i++) {
    const id = fileElements[i]!.id;
    if (pinned.includes(id)) continue;
    const dist = Math.abs(i - idx);
    if (dist < bestDist && dist > 0) {
      bestDist = dist;
      nearest = id;
    }
  }
  return nearest;
}

export function preparePinnedRegeneration(
  request: LocalRegenerateRequest,
): PinnedRegenerationPreparation {
  const baseFile = request.baseResult.file;
  const draftFile = request.file;
  const selectedId = request.selectedElementId;
  const draftPinned = draftFile.intent.pinnedElementIds;

  // Iterate the current draft pin set (authoritative) and compare each draft-pinned ID's base vs draft parameters
  const changedPinnedIds: string[] = [];
  for (const pinnedId of draftPinned) {
    const baseEl = baseFile.intent.elements.find((e) => e.id === pinnedId);
    const draftEl = draftFile.intent.elements.find((e) => e.id === pinnedId);
    if (!areParametersEqual(baseEl, draftEl)) {
      changedPinnedIds.push(pinnedId);
    }
  }

  if (changedPinnedIds.length === 0) {
    // No pinned changes: preserve existing nearest-unpinned fallback for pinned selection
    let targetId = selectedId;
    const pinned = draftPinned;
    const fileElements = draftFile.intent.elements;
    if (targetId && pinned.includes(targetId)) {
      const nearest = findNearestUnpinned(fileElements, pinned, targetId);
      if (nearest) targetId = nearest;
      else {
        return {
          kind: "fatal",
          diagnostic: {
            code: "LOCAL_REGENERATION",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: "All elements pinned, no eligible regenerate target",
            relatedIds: [...pinned],
          },
        };
      }
    }
    if (!targetId) {
      const firstUnpinned = fileElements.find((el) => !pinned.includes(el.id));
      if (!firstUnpinned) {
        return {
          kind: "fatal",
          diagnostic: {
            code: "LOCAL_REGENERATION",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: "No unpinned element for local regenerate",
            relatedIds: [...pinned],
          },
        };
      }
      targetId = firstUnpinned.id;
    }
    return {
      kind: "proceed",
      workerFile: draftFile,
      targetId,
      restoreId: null,
      originalPinnedIds: [...draftPinned],
    };
  }

  if (
    changedPinnedIds.length === 1 &&
    changedPinnedIds[0] === selectedId &&
    selectedId !== null
  ) {
    // Exactly the selected pinned element changed: deliberate override
    const restoreId = selectedId;
    // Create worker file with only that selected ID temporarily removed from that draft pin set
    const newPinned = draftPinned.filter((id) => id !== restoreId);
    const newIntent = createDesignIntentV1({
      ...draftFile.intent,
      pinnedElementIds: [...newPinned],
    });
    const workerFile = createCoasterFileV1({
      name: draftFile.name,
      intent: newIntent,
      solvedSpans: [...draftFile.solvedSpans],
      seed: draftFile.seed,
      generatorVersion: draftFile.generatorVersion,
      profileVersion: draftFile.profileVersion,
      researchSnapshotIds: [...draftFile.researchSnapshotIds],
      compiledDataChecksum: draftFile.compiledDataChecksum,
    });
    // Validate via compile (do not re-solve)
    compileCoasterFile(workerFile);
    return {
      kind: "proceed",
      workerFile,
      targetId: restoreId,
      restoreId,
      originalPinnedIds: [...draftPinned],
    };
  }

  // Any remotely changed pinned ID: fatal
  return {
    kind: "fatal",
    diagnostic: {
      code: "LOCAL_REGENERATION",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        changedPinnedIds.length === 1
          ? `Pinned element ${changedPinnedIds[0]} was edited but is not the current selection`
          : `Pinned elements ${changedPinnedIds.join(", ")} were edited but are not the current selection`,
      relatedIds: [...changedPinnedIds],
    },
  };
}

export function restorePinnedFileAfterRegeneration(
  resultFile: CoasterFileV1,
  restoreId: string | null,
  originalPinnedIds: readonly string[],
): CoasterFileV1 {
  if (!restoreId) return resultFile;
  // If result already has the restored pin, return as is
  if (resultFile.intent.pinnedElementIds.includes(restoreId)) {
    return resultFile;
  }
  const newIntent = createDesignIntentV1({
    ...resultFile.intent,
    pinnedElementIds: [...originalPinnedIds],
  });
  const rebuilt = createCoasterFileV1({
    name: resultFile.name,
    intent: newIntent,
    solvedSpans: [...resultFile.solvedSpans],
    seed: resultFile.seed,
    generatorVersion: resultFile.generatorVersion,
    profileVersion: resultFile.profileVersion,
    researchSnapshotIds: [...resultFile.researchSnapshotIds],
    compiledDataChecksum: resultFile.compiledDataChecksum,
  });
  compileCoasterFile(rebuilt);
  return rebuilt;
}
