import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type DependencyWait, type IpcRequest, type ItemDetail } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { Button, Chip, Select } from "../../kit";
import { ItemRef, RefText } from "../items/ItemReference";
import { EditorActions, StatusLine } from "./parts";

type Dependency = ItemDetail["dependsOn"][number];

/** The three rules a person chooses between, in the words the picker offers them. */
const WAITS: { value: DependencyWait; label: string }[] = [
  { value: "finished", label: "Until finished" },
  { value: "reached", label: "Until it reaches a step" },
  { value: "none", label: "Don't wait" },
];

/**
 * What releases an item from one of its dependencies (EO-778), as its
 * row says it. Read with a default: a detail from a build before rules
 * carries none, and an edge without one waits for its dependency to finish.
 */
function gateLine(wait: DependencyWait | undefined, stepName: string | null | undefined): string {
  if (wait === "none") return "Doesn't wait";
  if (wait === "reached") return `Until it reaches ${stepName ?? "a step that no longer exists"}`;
  return "Until it finishes";
}

/**
 * One item this item waits for, with the rule it waits by (EO-779):
 * until it finishes, until it first reaches a step of its own pipeline,
 * or not at all.
 *
 * The rule is said in words on every row, in EO-778's words. Changing it is offered only
 * where the item may change (`editable`, the main process's
 * `refuseIfUntouchable` and the group step's holder): an editor that
 * could only be refused is not offered, and one already open closes when
 * the item stops being changeable — a run starts, it moves to review.
 * A refusal that still arrives —
 * the item moved between the read and the save — is said under the
 * editor, and the row keeps the rule it had, because the row is drawn
 * from the item as read, never from the draft.
 *
 * The step picker lists the dependency's own pipeline, not this item's:
 * a dependency may be on another pipeline entirely. It is the list the
 * save judges against (`items:waitSteps`): every step but the terminal
 * one — reaching that is finishing, which is the first rule — including
 * steps the board draws no column for.
 */
export function DependencyRow({ itemId, dependency, editable, onChanged }: { itemId: string; dependency: Dependency; editable: boolean; onChanged: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [wait, setWait] = useState<DependencyWait>(dependency.wait);
  const [stepId, setStepId] = useState<string>(dependency.waitStepId ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  // Asked when the editor opens, by the dependency's id: its pipeline is
  // read where the save will read it.
  const steps = useQuery({
    queryKey: ["items:waitSteps", dependency.id],
    queryFn: () => ipcQuery("items:waitSteps", { itemId: dependency.id }),
    enabled: editing,
  });
  const reachable = steps.data?.steps ?? [];
  // A dependency on no pipeline has no step to reach.
  const noSteps = steps.isSuccess && reachable.length === 0;

  // The item stopped being changeable while the editor was open: close
  // it rather than leave a control the save would only refuse.
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);

  const save = useMutation({
    mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input),
    onSuccess: async (result) => {
      setProblem(result.problem);
      if (result.problem !== null) return;
      await onChanged();
      setEditing(false);
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const open = (): void => {
    setWait(dependency.wait);
    setStepId(dependency.waitStepId ?? "");
    setProblem(null);
    setEditing(true);
  };

  const unchanged = wait === dependency.wait && (wait !== "reached" || stepId === (dependency.waitStepId ?? ""));
  const submit = (): void => {
    if (unchanged) {
      setEditing(false);
      return;
    }
    setProblem(null);
    save.mutate({ itemId, updateDependsOn: [{ item: dependency.id, wait, ...(wait === "reached" ? { step: stepId } : {}) }] });
  };

  return (
    <li className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        {/* By id, so a dependency on another project still links. */}
        <ItemRef itemKey={dependency.key} itemId={dependency.id} className="shrink-0 font-mono text-[12px] text-ink-subtle" />
        <span className="min-w-0 flex-1 truncate text-ink">{dependency.title}</span>
        {/* What releases this item: the edge's rule (EO-778), changed beside it. */}
        <span className="shrink-0 text-[12px] text-ink-subtle">{gateLine(dependency.wait, dependency.waitStepName)}</span>
        {/* Its own pipeline's step name, which travels with it. */}
        <Chip>{dependency.stepName}</Chip>
        {editable && !editing ? (
          <Button size="sm" variant="ghost" aria-label={`Change how this waits for ${dependency.key}`} onClick={open}>
            Change
          </Button>
        ) : null}
      </div>
      {editing && editable ? (
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select aria-label={`Wait for ${dependency.key}`} value={wait} disabled={save.isPending} onChange={(event) => setWait(event.target.value as DependencyWait)} className="w-auto">
              {WAITS.map((option) => (
                <option key={option.value} value={option.value} disabled={option.value === "reached" && noSteps}>
                  {option.label}
                </option>
              ))}
            </Select>
            {wait === "reached" ? (
              <Select aria-label={`Step of ${dependency.key} to wait for`} value={stepId} disabled={save.isPending || steps.isLoading} onChange={(event) => setStepId(event.target.value)} className="w-auto">
                {/* Nobody has chosen yet: starting on the first step would choose for them. */}
                <option value="">Choose a step…</option>
                {reachable.map((step) => (
                  <option key={step.id} value={step.id}>
                    {step.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
          <EditorActions>
            <Button size="sm" variant="primary" disabled={save.isPending || (wait === "reached" && stepId === "")} onClick={submit}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setEditing(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </EditorActions>
        </div>
      ) : null}
      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}
    </li>
  );
}
