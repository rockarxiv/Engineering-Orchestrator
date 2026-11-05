import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { deleteModuleTest, getModule, listModuleTests, saveModuleTest } from "../db/repos/index.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";

/**
 * A module's test cases, over IPC and so over `eo_admin` (EO-352).
 *
 * Every write asks the runner to re-run the module's tests in the
 * background: the stored result is about the cases as they were, and a
 * save is exactly what makes it stale. The answer does not wait for
 * that run — `moduleTests:run` is the call that does.
 *
 * A write that changes an approved module's cases withdraws its approval
 * (EO-498, in the repo, so it holds through every door), and the answer
 * says whether it did.
 */

export function listModuleTestsCommand(db: Db, input: IpcPayload<"moduleTests:list">): IpcResponse<"moduleTests:list"> {
  if (!getModule(db, input.moduleId)) return { tests: [], problem: "That module no longer exists." };
  return { tests: listModuleTests(db, input.moduleId), problem: null };
}

export function saveModuleTestCommand(db: Db, runner: ModuleTestRunner, input: IpcPayload<"moduleTests:save">): IpcResponse<"moduleTests:save"> {
  const result = saveModuleTest(db, {
    ...(input.id === undefined ? {} : { id: input.id }),
    moduleId: input.moduleId,
    description: input.description,
    source: input.source,
  });
  if (!result.ok) return { saved: false, test: null, problem: result.reason, approvalWithdrawn: false };
  runner.schedule(input.moduleId);
  return { saved: true, test: result.test, problem: null, approvalWithdrawn: result.approvalWithdrawn };
}

export function deleteModuleTestCommand(db: Db, runner: ModuleTestRunner, input: IpcPayload<"moduleTests:delete">): IpcResponse<"moduleTests:delete"> {
  const deleted = deleteModuleTest(db, input.id);
  if (deleted === null) return { deleted: false, problem: "That test case no longer exists.", approvalWithdrawn: false, moduleId: null };
  runner.schedule(deleted.moduleId);
  return { deleted: true, problem: null, approvalWithdrawn: deleted.approvalWithdrawn, moduleId: deleted.moduleId };
}

export async function runModuleTestsCommand(runner: ModuleTestRunner, input: IpcPayload<"moduleTests:run">): Promise<IpcResponse<"moduleTests:run">> {
  const answer = await runner.run(input.moduleId);
  return answer.run === null ? answer : { run: answer.run, problem: null };
}
