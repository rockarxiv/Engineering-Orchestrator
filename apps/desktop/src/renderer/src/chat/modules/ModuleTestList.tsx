import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ModuleTestCase, ModuleTestRun } from "@eo/core";
import { cn } from "@eo/ui";
import { caseStatus, type CaseStatus } from "../../shared/modules/moduleTestList";
import { Button, Chip, type Tone } from "../kit";

/**
 * A module's test cases, each by its description and how it went (EO-354),
 * in the chat layout's terms.
 *
 * Three states and no fourth: passed, failed, or not run against the code
 * saved now — a run taken before the code or a case changed (`stale`)
 * reads "Not run" on every case rather than reporting a pass earned by
 * different code. Opening a case shows its source read-only, and the
 * failure when it failed. `onDelete` is optional: where a list is only
 * being read, there is no delete to offer.
 */

export { caseStatus, type CaseStatus };

const STATUS_CHIP: Record<CaseStatus, { tone: Tone; label: string }> = {
  passed: { tone: "running", label: "Passed" },
  failed: { tone: "danger", label: "Failed" },
  not_run: { tone: "neutral", label: "Not run" },
};

export function ModuleTestList({
  tests,
  run,
  stale,
  onDelete,
  deleting = false,
}: {
  tests: ModuleTestCase[];
  run: ModuleTestRun | null;
  stale: boolean;
  onDelete?: (test: ModuleTestCase) => void;
  deleting?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  /** The case whose Delete is armed. Two clicks, the same shape as removing a step. */
  const [armedId, setArmedId] = useState<string | null>(null);

  if (tests.length === 0) return <p className="text-[12.5px] text-ink-subtle">No test cases yet.</p>;

  return (
    <ul aria-label="Test cases" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
      {tests.map((test) => {
        const { status, result } = caseStatus(test, run, stale);
        const chip = STATUS_CHIP[status];
        const open = openId === test.id;
        const armed = armedId === test.id;
        return (
          <li key={test.id} className="flex min-w-0 flex-col gap-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : test.id)}
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 text-left hover:bg-canvas-raised"
              >
                <ChevronRight aria-hidden size={13} className={cn("shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
                <Chip tone={chip.tone}>{chip.label}</Chip>
                <span className="min-w-0 truncate text-[13px] text-ink">{test.description}</span>
              </button>
              {onDelete ? (
                <Button
                  size="sm"
                  variant={armed ? "danger" : "ghost"}
                  disabled={deleting}
                  aria-label={armed ? `Confirm deleting ${test.description}` : `Delete ${test.description}`}
                  onClick={() => {
                    if (!armed) {
                      setArmedId(test.id);
                      return;
                    }
                    setArmedId(null);
                    onDelete(test);
                  }}
                  onBlur={() => setArmedId(null)}
                >
                  {armed ? "Confirm delete" : "Delete"}
                </Button>
              ) : null}
            </div>
            {open ? (
              <div className="flex min-w-0 flex-col gap-2 pl-2">
                {status === "failed" && result?.failure ? (
                  <pre
                    aria-label={`Failure of ${test.description}`}
                    className="whitespace-pre-wrap break-words rounded-[10px] bg-danger/12 px-3 py-2 font-mono text-[12px] text-danger"
                  >
                    {result.failure}
                  </pre>
                ) : null}
                <pre
                  aria-label={`Source of ${test.description}`}
                  className="max-h-80 overflow-auto relative rounded-[10px] bg-canvas-raised px-3 py-2 font-mono text-[12px] text-ink"
                >
                  <code>{test.source}</code>
                </pre>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
