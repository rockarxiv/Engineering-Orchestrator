import type { ReactNode } from "react";
import { VirtuosoMockContext } from "react-virtuoso";

/** How tall a row is taken to be, in pixels, under `RowsViewport`. */
export const ROW_HEIGHT = 40;

/**
 * A viewport for `VirtualRows` in a test (EO-565).
 *
 * jsdom lays nothing out, so a virtual list in it has no viewport and
 * mounts no rows at all. This tells react-virtuoso how tall the viewport
 * is — `fits` rows of `ROW_HEIGHT` — and the real list does the rest.
 * Left at its default the viewport holds ten thousand rows, so a test
 * about what the rows say has every one of them in the document; a test
 * about virtualising asks for a short one.
 */
export function RowsViewport({ fits = 10_000, children }: { fits?: number; children: ReactNode }) {
  return <VirtuosoMockContext.Provider value={{ viewportHeight: fits * ROW_HEIGHT, itemHeight: ROW_HEIGHT }}>{children}</VirtuosoMockContext.Provider>;
}
