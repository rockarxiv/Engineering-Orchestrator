import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModuleTestCase, ModuleView } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { moduleTestsKey, modulesKey } from "../../query/hooks";
import { caseWriteWithdrawsApproval, caseWriteWithdrewApproval, isApprovedNow, scenarioChatWritesDirectly, type CaseWriteGuard, type CaseWriteRequest } from "../../shared/modules/caseApproval";
import { Button, Chip, ConfirmDialog, ErrorLine } from "../kit";
import { CoverageBadge } from "./CoverageBadge";
import { ModuleTestList } from "./ModuleTestList";
import { NotFullyTested } from "./NotFullyTested";
import { AddScenario } from "./ScenarioChat";
import { useModuleApproval } from "./useModuleApproval";

/**
 * The Tests panel of a module (EO-354), in the chat layout's terms: the
 * cases with how each went, the coverage badge, and "Run tests".
 *
 * Deleting a case re-runs the tests in the background (EO-352) and the run
 * ends with `config:changed`, which `useModules` hears — so the coverage
 * figure follows a delete by itself. Adding a case is not a form here:
 * "+ Add scenario" opens a conversation with the system agent (EO-356).
 *
 * Any change to an approved module's cases withdraws its approval
 * (EO-498), so on one the panel asks first, naming the module and what
 * stops (EO-500), in front of both writes it leads to: Delete, and "Add
 * scenario" — whose chat saves the cases the agent writes or fixes with
 * no further question, so opening it, and each turn started in it while
 * the module carries an approval nobody has agreed to lose, is the last
 * word the person has before that write. Cancelling writes nothing and opens nothing. Once a
 * write has withdrawn the approval, the panel says so and offers Approve,
 * without the screen reloading. The classic layout's panel does the same.
 */
export function ModuleTests({ module }: { module: ModuleView }) {
  const queryClient = useQueryClient();
  const tests = useQuery({ queryKey: moduleTestsKey(module.id), queryFn: () => ipcQuery("moduleTests:list", { moduleId: module.id }) });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: modulesKey });

  /** The `approvedAt` a write here withdrew, while that module has not been approved again. */
  const [withdrawnFrom, setWithdrawnFrom] = useState<number | null>(null);
  /**
   * The `approvedAt` the person agreed to lose to the scenario chat.
   * Asked once per approval, at whichever comes first — opening the chat
   * or a turn in it — and again once the module carries a newer approval,
   * however that came about: the chat may be open across it. The agent's
   * first write withdraws it, and the panel follows the module list to
   * say so.
   */
  const [consentedFrom, setConsentedFrom] = useState<number | null>(null);
  /** The write waiting on the person, on an approved module. */
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const approved = isApprovedNow(module.approvedAt, withdrawnFrom);
  const withdrawn = (withdrawnFrom !== null && !approved) || (consentedFrom !== null && module.approvedAt === null);

  const approval = useModuleApproval({
    onApproved: () => {
      setWithdrawnFrom(null);
      setConsentedFrom(null);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => ipcQuery("moduleTests:delete", { id }),
    onSuccess: (result) => {
      setConfirming(null);
      if (result.approvalWithdrawn && module.approvedAt !== null) setWithdrawnFrom(module.approvedAt);
      refresh();
    },
    onError: () => setConfirming(null),
  });

  const deleteCase = (test: ModuleTestCase) => {
    if (approved) {
      setConfirming({ kind: "delete", test });
      return;
    }
    remove.mutate(test.id);
  };

  const guardCaseWrites: CaseWriteGuard = (request) => {
    if (approved && consentedFrom !== module.approvedAt) {
      setConfirming({ kind: "scenario", request });
      return;
    }
    request.proceed();
  };

  const cancelConfirming = () => {
    if (confirming?.kind === "scenario") confirming.request.cancel();
    setConfirming(null);
  };

  const confirm = () => {
    if (confirming === null) return;
    if (confirming.kind === "delete") {
      remove.mutate(confirming.test.id);
      return;
    }
    setConsentedFrom(module.approvedAt);
    setConfirming(null);
    confirming.request.proceed();
  };

  const run = useMutation({
    mutationFn: () => ipcQuery("moduleTests:run", { moduleId: module.id }),
    onSuccess: refresh,
  });

  const problem = tests.data?.problem ?? remove.data?.problem ?? run.data?.problem ?? null;
  const cases = tests.data?.tests ?? [];

  return (
    <section aria-label={`Tests of ${module.name}`} className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-medium text-ink">Tests</h4>
        <CoverageBadge run={module.testRun} testCount={module.testCount} />
        <NotFullyTested module={module} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <AddScenario module={module} guardCaseWrites={guardCaseWrites} />
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Running…" : "Run tests"}
          </Button>
        </span>
      </div>
      {/* Said, so "Not run" on every case reads as a re-run that is due
          rather than a module nobody has tested. */}
      {module.testsStale && !run.isPending ? (
        <p className="text-[12px] text-ink-subtle">The code or the cases changed since the last run; the tests are re-running against what is saved now.</p>
      ) : null}
      {withdrawn ? (
        <div role="status" className="flex min-w-0 flex-wrap items-center gap-2 rounded-[10px] bg-paused/10 px-2.5 py-2">
          <Chip tone="paused">Not approved</Chip>
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-muted">{caseWriteWithdrewApproval(module.name)}</p>
          <Button variant="primary" size="sm" disabled={approval.approving} onClick={() => approval.approve(module)}>
            {approval.approving ? "Running its tests…" : "Approve"}
          </Button>
        </div>
      ) : null}
      {/* One line per failing case when approval was refused, so kept as written. */}
      {withdrawn && approval.problem ? (
        <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
          {approval.problem}
        </p>
      ) : null}
      <ModuleTestList tests={cases} run={module.testRun} stale={module.testsStale} onDelete={deleteCase} deleting={remove.isPending} />
      {problem ? <ErrorLine>{problem}</ErrorLine> : null}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? confirmTitle(confirming, module.name) : ""}
        confirmLabel={confirming ? confirmLabel(confirming, remove.isPending) : ""}
        cancelLabel="Keep it"
        tone="danger"
        busy={remove.isPending}
        onConfirm={confirm}
        onCancel={cancelConfirming}
      >
        <p>{caseWriteWithdrawsApproval(module.name)}</p>
        {confirming?.kind === "scenario" ? <p>{scenarioChatWritesDirectly(module.name)}</p> : null}
      </ConfirmDialog>
      {approval.dialog}
    </section>
  );
}

/** What the confirmation is in front of: deleting one case, or the scenario chat opening or starting a turn. */
type Confirming = { kind: "delete"; test: ModuleTestCase } | { kind: "scenario"; request: CaseWriteRequest };

function confirmTitle(confirming: Confirming, moduleName: string): string {
  return confirming.kind === "delete" ? `Delete "${confirming.test.description}"?` : confirming.request.what === "open"
      ? `Add a scenario to ${moduleName}?`
      : `Send this to the scenario chat?`;
}

function confirmLabel(confirming: Confirming, deleting: boolean): string {
  if (confirming.kind === "delete") return deleting ? "Deleting…" : "Delete and withdraw approval";
  return confirming.request.what === "open" ? "Open the scenario chat" : "Send and withdraw approval";
}
