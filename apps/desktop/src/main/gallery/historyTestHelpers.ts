import { compareTemplateVersions, loadTemplateHistory, type TemplateHistory } from "./history.js";

/**
 * The bundled history as it stood when `version` of `slug` was the newest
 * that template shipped: every version of it up to that one, and every
 * other template's as shipped.
 *
 * For tests about how an update is compared, held, announced or resolved,
 * which were written around one version's graph and stay about that
 * mechanism when a later version changes the graph (EO-763, 1.4 of the
 * software template).
 */
export function templateHistoryUpTo(directory: string, slug: string, version: string): TemplateHistory {
  const shipped = loadTemplateHistory(directory);
  return new Map([...shipped].map(([each, versions]) => [each, each === slug ? versions.filter((entry) => compareTemplateVersions(entry.version, version) <= 0) : versions]));
}
