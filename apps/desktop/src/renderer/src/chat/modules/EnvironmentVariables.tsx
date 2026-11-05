import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MODULE_ENV_NAME_MESSAGE, MODULE_ENV_NAME_PATTERN } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { environmentVariablesKey, environmentVariablesRootKey, mcpServersKey, moduleSecretsKey, moduleSecretsRootKey } from "../../query/hooks";
import { variableStatus, type StatusLine } from "../../shared/modules/environmentVariableStatus";
import { Button, TextInput } from "../kit";

/**
 * The environment variables list (EO-486, ARCHITECTURE.md §14.2), in the
 * chat layout's terms — held to the classic layout's copy
 * (`modules/EnvironmentVariables.tsx`) by the same tests.
 *
 * The other list beside `ModuleSecrets`, and the other way round from
 * it: a variable is not secret, so its value is listed, shown in full in
 * a plain text box and edited in place. One component for Settings (the
 * shared values, with a row to add one) and a module step's inspector
 * (that step's own values over the shared ones, one row per declared
 * name).
 *
 * **Mount one per scope**, as `ModuleSecrets` is: what is typed is held
 * by name, and a caller swapping `stepId` under a live mount would carry
 * one step's typing to the next.
 */

export interface EnvironmentVariablesProps {
  /** Which step these values belong to, or null for the shared ones. A step's value wins, name by name. */
  stepId?: string | null;
  /**
   * The names the module declares in `needs.env`, which are then the rows.
   *
   * Null lists the variables that are set: in Settings the shared ones;
   * on an agent step (EO-487), every shared one and every one the step
   * sets, since an agent run is given them all — each row saying whether
   * the step uses the shared value or its own, and the add row adding
   * one to the step.
   */
  declared?: string[] | null;
  /** Why a step cannot hold values yet — an unpublished step has no row to file them against. */
  unavailable?: string | null;
  className?: string;
}

const TONE: Record<StatusLine["tone"], string> = { own: "text-running", inherited: "text-ink-subtle", missing: "text-danger" };

interface Pending {
  name: string;
  value: string;
  fromAddRow: boolean;
}

/** A copy without one name. */
function without(drafts: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  const next = new Map(drafts);
  next.delete(key);
  return next;
}

export function EnvironmentVariables({ stepId = null, declared = null, unavailable = null, className }: EnvironmentVariablesProps) {
  const queryClient = useQueryClient();
  // What the person has typed over a row's stored value, by name. A row
  // nobody has touched shows what is stored. A Map rather than an object:
  // a variable may be called `__proto__` or `constructor`, and a plain
  // object answers those with what it inherits.
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const scope = stepId ?? null;
  const list = useQuery({
    queryKey: environmentVariablesKey(scope),
    queryFn: () => ipcQuery("environmentVariables:list", { stepId: scope }),
    enabled: unavailable === null,
  });
  // Only where there are declared names: it is what says a name is filled
  // from the Secrets list instead, which Settings' own list never needs.
  const secrets = useQuery({
    queryKey: moduleSecretsKey(scope),
    queryFn: () => ipcQuery("moduleSecrets:list", { stepId: scope }),
    enabled: unavailable === null && declared !== null,
  });

  // Both prefixes: a step's list holds the shared values too, and the
  // Secrets list's lines read which names are variables. And the MCP
  // server list (EO-488), whose rows say "From environment variables"
  // for a declared name a shared variable fills.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: environmentVariablesRootKey }),
      queryClient.invalidateQueries({ queryKey: moduleSecretsRootKey }),
      queryClient.invalidateQueries({ queryKey: mcpServersKey }),
    ]);

  const set = useMutation({
    mutationFn: (pending: Pending) => ipcQuery("environmentVariables:set", { name: pending.name, value: pending.value, stepId: scope }),
    onSuccess: async (result, pending) => {
      // A refusal leaves what was typed in its box, with the sentence
      // saying why under it.
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      setProblem(null);
      // After the refetch, so the box goes from what was typed straight
      // to what is now stored rather than flashing the old value.
      await invalidate();
      if (pending.fromAddRow) {
        setNewName("");
        setNewValue("");
      } else {
        setTyped((current) => without(current, pending.name));
      }
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const clear = useMutation({
    mutationFn: (name: string) => ipcQuery("environmentVariables:clear", { name, stepId: scope }),
    onSuccess: async (_result, name) => {
      setProblem(null);
      await invalidate();
      setTyped((current) => without(current, name));
    },
    onError: (error: Error) => setProblem(error.message),
  });

  /** Checked here in the words `needs.env` uses, so a bad name is refused with what was typed still in place. */
  const save = (pending: Pending) => {
    if (!MODULE_ENV_NAME_PATTERN.test(pending.name)) {
      setProblem(MODULE_ENV_NAME_MESSAGE);
      return;
    }
    set.mutate(pending);
  };

  if (unavailable !== null) return <p className={cn("text-[12.5px] text-ink-subtle", className)}>{unavailable}</p>;

  const variables = list.data?.variables ?? [];
  const ownScope = scope === null ? "shared" : "step";
  const own = (name: string) => variables.find((variable) => variable.name === name && variable.scope === ownScope) ?? null;
  // On an agent step a name the step alone sets has no shared value to go
  // back to, so its button removes it; a module step's may still fall back
  // to a shared secret, so it keeps "Use shared".
  const removes = (name: string) => scope === null || (declared === null && !variables.some((variable) => variable.name === name && variable.scope === "shared"));
  const rows =
    declared ??
    [...new Set(variables.filter((variable) => scope !== null || variable.scope === "shared").map((variable) => variable.name))].sort();
  // Settings' rows are all set, so they need no line; a step's say where each value comes from.
  const withStatus = declared !== null || scope !== null;
  // Never inferred from an empty answer: a failed read drawn as "not set"
  // would hide Remove for a value that is still there.
  const known = list.isSuccess && (declared === null || secrets.isSuccess);

  const statusOf = (name: string): { text: string; tone: string } => {
    if (!known) return { text: list.isError || secrets.isError ? "Unknown" : "…", tone: "text-ink-subtle" };
    const status = variableStatus(name, variables, secrets.data, scope);
    return { text: status.text, tone: TONE[status.tone] };
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {list.isError ? <p className="text-[12.5px] text-danger">Could not read the environment variables.</p> : null}
      {rows.map((name) => {
        const stored = known ? own(name) : null;
        const value = typed.get(name) ?? stored?.value ?? "";
        const saving = set.isPending && set.variables?.name === name;
        const status = statusOf(name);
        return (
          <div key={name} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
              <code className="font-mono text-[12px] text-ink">{name}</code>
              {/* Settings' rows are all set; the box beside the name says what to. */}
              {withStatus ? <span className={cn("text-[11.5px]", status.tone)}>{status.text}</span> : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <TextInput
                aria-label={`Value of variable ${name}`}
                className="font-mono"
                placeholder={scope === null ? "Value" : "Value for this step"}
                value={value}
                onChange={(event) => setTyped((current) => new Map(current).set(name, event.target.value))}
              />
              <Button size="sm" aria-label={`Save variable ${name}`} disabled={value === "" || value === stored?.value || saving} onClick={() => save({ name, value, fromAddRow: false })}>
                Save
              </Button>
              {stored !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={removes(name) ? `Remove variable ${name}` : `Use the shared variable for ${name}`}
                  disabled={clear.isPending && clear.variables === name}
                  onClick={() => clear.mutate(name)}
                >
                  {removes(name) ? "Remove" : "Use shared"}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {known && rows.length === 0 ? <p className="text-[12.5px] text-ink-subtle">No environment variables.</p> : null}
      {declared === null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1">
          <TextInput
            aria-label="Variable name"
            className="min-w-[8rem] flex-1 font-mono"
            placeholder="REGION"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <TextInput
            aria-label="Variable value"
            className="min-w-[8rem] flex-1 font-mono"
            placeholder="Value"
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
          />
          <Button
            size="sm"
            aria-label="Add variable"
            disabled={newName === "" || newValue === "" || set.isPending}
            onClick={() => save({ name: newName, value: newValue, fromAddRow: true })}
          >
            Add
          </Button>
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
