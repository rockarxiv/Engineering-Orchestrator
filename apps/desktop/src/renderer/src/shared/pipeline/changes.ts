/**
 * What the address says when the configure screen is being read rather
 * than edited (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Beside `STEP_ID_FACET` in spirit but not in `@eo/core`: the board's
 * facets are a saved view's vocabulary, matched by `matchesBoardQuery`
 * in the main process as well as here. This one narrows nothing and is
 * read by one route.
 */
export const CHANGES_FACET = "changes";
