import type { CustomModule, ModuleManifest } from "@eo/core";

/**
 * One kept version of a module, as the validator is told about it
 * (EO-770, ARCHITECTURE.md, "Modules: a step that is a script").
 *
 * As data, for the reason the module catalog is: `packages/engine` is
 * pure (invariant #2). The manifest is what a step pinning this version
 * is judged against, and `approvedAt` is the approval that gates it —
 * the version's own, not the module's, which an edit withdraws while the
 * version a pipeline pins stays approved.
 */
export interface ModuleVersionFacts {
  moduleId: string;
  number: number;
  manifest: ModuleManifest;
  approvedAt: number | null;
}

/**
 * A module as a pin makes it: its catalog row, with the manifest and the
 * approval of the version the pin names (EO-770).
 *
 * `missing` where the pin names a version this module does not keep. No
 * pin, or no versions to resolve one against, is the module as it
 * stands — what every step ran before pins, and what a caller judging a
 * draft's shape with no versions to hand asks about.
 */
export function moduleAtPin<M extends Pick<CustomModule, "id" | "manifest" | "approvedAt">>(
  module: M,
  version: number | null | undefined,
  versions: readonly ModuleVersionFacts[] | undefined,
): { module: M; missing: boolean } {
  if (version === null || version === undefined || versions === undefined) return { module, missing: false };
  const found = versions.find((each) => each.moduleId === module.id && each.number === version);
  if (found === undefined) return { module, missing: true };
  return { module: { ...module, manifest: found.manifest, approvedAt: found.approvedAt }, missing: false };
}
