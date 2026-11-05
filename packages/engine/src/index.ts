import type { Uuid } from "@eo/core";

/** Placeholder pure function proving packages/engine can consume @eo/core. */
export function isSameId(a: Uuid, b: Uuid): boolean {
  return a === b;
}

export * from "./archive.js";
export * from "./dag.js";
export * from "./scheduler.js";
export * from "./context.js";
export * from "./refineGraph.js";
export * from "./reviewCoverage.js";
export * from "./decide.js";
export * from "./routing.js";
export * from "./replies.js";
export * from "./pipelineValidation.js";
export * from "./entryRules.js";
export * from "./watch.js";
export * from "./templateMerge.js";
