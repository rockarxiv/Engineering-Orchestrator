import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { moduleMachineSpecificWarnings, type MachineSpecificWarning } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { moduleTestsKey } from "../../query/hooks";

/**
 * The `needs.bin` of a manifest still being typed, or none.
 *
 * Lenient where the save is strict: half-typed JSON, or a manifest the
 * schema would refuse, still has binaries worth advising about — and
 * whether it parses is the save's to say, beside the field.
 */
function draftBins(manifest: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const needs: unknown = (parsed as { needs?: unknown }).needs;
  if (typeof needs !== "object" || needs === null) return [];
  const bin: unknown = (needs as { bin?: unknown }).bin;
  return Array.isArray(bin) ? bin.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Machine-specific values in a module editor's draft (EO-449): the code
 * and manifest in the textareas, read on every keystroke as the import
 * scan is, and the module's test cases.
 *
 * The cases are the ones a save would leave the module with — a
 * restore's when `restoring` carries them, otherwise those the module
 * has now. The editor has no field for a case: they are written by the
 * scenario chat and saved one at a time, so what the editor shows is
 * what is there.
 */
export function useDraftMachineSpecific(draft: {
  id?: string;
  code: string;
  manifest: string;
  restoring?: { tests: readonly { description: string; source: string }[] };
}): MachineSpecificWarning[] {
  const moduleId = draft.id;
  const saved = useQuery({
    queryKey: moduleTestsKey(moduleId ?? ""),
    queryFn: () => ipcQuery("moduleTests:list", { moduleId: moduleId ?? "" }),
    enabled: moduleId !== undefined && draft.restoring === undefined,
  });
  const tests = draft.restoring?.tests ?? saved.data?.tests;
  return useMemo(
    () => moduleMachineSpecificWarnings({ code: draft.code, manifest: { needs: { bin: draftBins(draft.manifest) } }, tests: tests ?? [] }),
    [draft.code, draft.manifest, tests],
  );
}
