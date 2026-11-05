import type { ModuleTestCase, ModuleTestCaseResult, ModuleTestRun } from "@eo/core";

/**
 * How one of a module's test cases went, for both layouts' test lists
 * (EO-519). The classic list is `modules/ModuleTestList.tsx`, the chat
 * one `chat/modules/ModuleTestList.tsx`.
 */

export type CaseStatus = "passed" | "failed" | "not_run";

export function caseStatus(test: ModuleTestCase, run: ModuleTestRun | null, stale: boolean): { status: CaseStatus; result: ModuleTestCaseResult | null } {
  if (run === null || stale) return { status: "not_run", result: null };
  const result = run.cases.find((each) => each.testId === test.id) ?? null;
  if (result === null) return { status: "not_run", result: null };
  return { status: result.passed ? "passed" : "failed", result };
}
