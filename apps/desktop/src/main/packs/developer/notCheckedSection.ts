import { REVIEW_ACTION } from "@eo/core";
import type { SectionRenderer } from "@eo/engine";
import type { Db } from "../../db/client.js";
import { getItemByKey, listRunsForItem } from "../../db/repos/index.js";
import { notCheckedSteps } from "./workspace/verify.js";

/** The action whose run the git kind verifies, and so the one whose `runs.verification` lists the checks. */
const IMPLEMENT_ACTION = "implement";

function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * What a reviewer is told when the verification it stands on checked
 * less than its instructions say (EO-927).
 *
 * The reviewer's prompt says the engine has already established that the
 * configured checks pass. On a repository with no test command that is
 * true and proves nothing: verification skips a check it has no command
 * for, so the run passes having run no tests. This says so, on the review
 * of exactly such a branch, read off the latest implement run that
 * succeeded — the verification the item reached review on.
 *
 * Volatile, because it is state: a person may configure the command
 * between one review round and the next, and a resumed reviewer thread
 * must not keep believing no tests ran, or start believing it.
 */
export function notCheckedSectionRenderers(db: Db): SectionRenderer[] {
  return [
    {
      id: "notChecked",
      after: "task",
      volatile: true,
      render: ({ action, item, packAction }) => {
        if (!packAction || action !== REVIEW_ACTION) return null;
        const itemId = getItemByKey(db, item.key)?.id;
        if (itemId === undefined) return null;
        const verified = listRunsForItem(db, itemId)
          .filter((run) => run.action === IMPLEMENT_ACTION && run.status === "succeeded" && run.verification !== null)
          .at(-1);
        const notChecked = notCheckedSteps(verified?.verification);
        if (notChecked.length === 0) return null;

        const others = notChecked.filter((name) => name !== "test");
        if (others.length === notChecked.length) {
          return [
            "## Checks EO did not run",
            "",
            `This repository has no ${listed(others)} command configured, so EO's verification of this branch did not check ${others.length === 1 ? "it" : "them"}. The checks your instructions say passed do not include ${others.length === 1 ? "that one" : "those"}.`,
          ].join("\n");
        }
        return [
          "## No tests were run",
          "",
          "EO verified this branch without running any tests: this repository has no test command configured. Where your instructions say the configured checks pass, that covers no tests here, so nothing EO ran has shown that this change works.",
          ...(others.length === 0 ? [] : ["", `There is no ${listed(others)} command configured either, so ${others.length === 1 ? "that was" : "those were"} not checked.`]),
          "",
          "If you run any of the repository's tests yourself in the worktree, say in your verdict which, and what they showed.",
        ].join("\n");
      },
    },
  ];
}
