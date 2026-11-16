/**
 * `/settings?section=modules&module=<id>`: Settings → Modules opened on
 * one module's card (EO-805), where a board column a module runs on sends
 * somebody who wants to see that module.
 *
 * By id, because that is what a module step's `entryAction` holds. An id
 * that matches nothing opens the catalog as it always opens.
 */
export const MODULE_FACET = "module";

export function moduleAddress(moduleId: string): string {
  return `/settings?section=modules&${MODULE_FACET}=${encodeURIComponent(moduleId)}`;
}
