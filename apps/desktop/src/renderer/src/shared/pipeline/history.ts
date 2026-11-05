import type { IpcResponse } from "@eo/core";

/** One version's graph as `pipeline:versions` sends it back for a restore. */
export type RestoredGraph = NonNullable<IpcResponse<"pipeline:versions">["graph"]>;

/**
 * Every `pipeline:versions` answer about one pipeline, as a query-key
 * prefix: its history and each comparison a Changes view drew. What a
 * configuration push invalidates (EO-524), since a publish, a restore or
 * discarding local edits changes all of them at once.
 */
export const pipelineVersionsKey = (pipelineId: string) => ["pipeline-versions", pipelineId] as const;

/** Which pipeline's history, as a query key — shared with the Changes screen's prefix. */
export const pipelineHistoryKey = (pipelineId: string) => [...pipelineVersionsKey(pipelineId), "history"] as const;
