import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { MODULE_COVERAGE_BAR } from "@eo/core";
import { ipcQuery } from "../../query/client";
import type { ModuleApproval } from "../../shared/modules/moduleApproval";
import { ConfirmDialog } from "../kit";

/**
 * Approving a module, the one way every screen does it (EO-353) — the
 * classic hook's contract exactly, with its confirmation window drawn in
 * the chat layout's terms.
 *
 * `modules:approve` runs the module's tests and decides; this only carries
 * the answer. A refusal comes back as `problem`, naming each failing case.
 * Line coverage under the bar is the one answer that is a question: it
 * opens the window with the figure, and confirming asks again with
 * `acknowledgeLowCoverage`, which runs the tests again too.
 */
export type { ModuleApproval };

interface Asking {
  id: string;
  name: string;
  lineCoverage: number;
}

export function useModuleApproval({ onApproved }: { onApproved?: (moduleId: string) => void } = {}): ModuleApproval {
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { id: string; name: string; acknowledgeLowCoverage: boolean }) =>
      ipcQuery("modules:approve", { id: input.id, acknowledgeLowCoverage: input.acknowledgeLowCoverage }),
    onSuccess: (result, input) => {
      if (result.approved) {
        setAsking(null);
        setProblem(null);
        onApproved?.(input.id);
        return;
      }
      if (result.coverageAcknowledgementNeeded && result.lineCoverage !== null) {
        setProblem(null);
        setAsking({ id: input.id, name: input.name, lineCoverage: result.lineCoverage });
        return;
      }
      setAsking(null);
      setProblem(result.problem ?? "It was not approved.");
    },
    onError: (error: Error) => {
      setAsking(null);
      setProblem(error.message);
    },
  });

  const dialog: ReactNode =
    asking === null ? null : (
      <ConfirmLowCoverage
        name={asking.name}
        lineCoverage={asking.lineCoverage}
        busy={mutation.isPending}
        onConfirm={() => mutation.mutate({ ...asking, acknowledgeLowCoverage: true })}
        onCancel={() => {
          setAsking(null);
          setProblem(`Not approved. Line coverage of "${asking.name}" is ${asking.lineCoverage}%, under the ${MODULE_COVERAGE_BAR}% bar.`);
        }}
      />
    );

  return {
    approve: (module) => {
      setProblem(null);
      mutation.mutate({ id: module.id, name: module.name, acknowledgeLowCoverage: false });
    },
    approving: mutation.isPending,
    problem,
    dialog,
  };
}

/**
 * Every case passed, and the code they reach is under the bar. A warning
 * and not a wall, with the figure stated — "approve anyway" means
 * something only next to the number it is anyway of.
 */
export function ConfirmLowCoverage({
  name,
  lineCoverage,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  lineCoverage: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open
      title={`Approve ${name}?`}
      confirmLabel={busy ? "Running its tests…" : "Approve anyway"}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>
        Every test case passed, but they cover <strong className="font-semibold text-paused">{lineCoverage}%</strong> of its lines — under the{" "}
        {MODULE_COVERAGE_BAR}% bar. The lines no case reaches are lines nobody has seen run.
      </p>
    </ConfirmDialog>
  );
}
