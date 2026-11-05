import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MODULE_ENV_NAME_MESSAGE, MODULE_ENV_NAME_PATTERN, ORGANISATION_SECRET_LINE } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { environmentVariablesKey, environmentVariablesRootKey, moduleSecretsKey, moduleSecretsRootKey } from "../../query/hooks";
import { unreadableSecretIn, unreadableSecretLine, variableLineForSecret } from "../../shared/modules/environmentVariableStatus";
import { byName, revealLine, useSecretReveal } from "../../hooks/useSecretReveal";
import { Button, Segmented, TextInput } from "../kit";

/**
 * Setting the named values a module declares (KAN-105), in the chat
 * layout's terms.
 *
 * One component for Settings, the architect's approval card and a module
 * step's inspector, because three copies of it would be three chances to
 * leak a value. The list tells this which names are set, never what they
 * hold; a personal value comes back only when the person presses Reveal
 * (EO-489, ARCHITECTURE.md §14.2) — fetched then through the machine
 * half, held in `useSecretReveal`'s state alone, and hidden on Hide, on
 * leaving the screen, or after thirty seconds. Organisation secrets and
 * references have no Reveal, nor does a renderer served by a server.
 *
 * A name can instead read one of EO's own variables (EO-417). That is a
 * variable's name going in and a name and a boolean coming back — which
 * variable, and whether EO was started with it — and never what it holds.
 *
 * **Mount one per scope.** What is typed is plaintext in component state,
 * keyed by name — a caller that swapped `stepId` under a live mount would
 * leave one step's token in the next step's box. Pass a `key` that changes
 * with the scope.
 */

export interface ModuleSecretsProps {
  /** Which step these values belong to, or null for the shared ones. A step's value wins, name by name. */
  stepId?: string | null;
  /** The names the module declares in `needs.env`, which are then the rows; null lists whatever is set. */
  declared?: string[] | null;
  /** Why a step cannot hold values yet — an unpublished step has no row to file them against. */
  unavailable?: string | null;
  className?: string;
}

/** Storing a value, or reading one of EO's own variables (EO-415). */
type Mode = "value" | "reference";

const MODE_OPTIONS: readonly { value: Mode; label: string }[] = [
  { value: "value", label: "Store a value" },
  { value: "reference", label: "Read from EO's environment" },
];

/** What one save is: which name, which kind, and which of the two rows it came from. */
interface Pending {
  name: string;
  /** A value to store. Absent for a reference. */
  value?: string;
  /** Which of EO's variables to read. Present is what makes this a reference. */
  variable?: string;
  fromAddRow: boolean;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/**
 * A referenced name's line: which variable it reads, and — in the tone
 * "Not set" uses, because the step will refuse — that EO was started
 * without it. EO reads its environment once, when it starts.
 */
function reads(line: string, available: boolean, tone: string): { text: string; tone: string } {
  return available ? { text: line, tone } : { text: `${line} · EO was started without it`, tone: "text-danger" };
}

export function ModuleSecrets({ stepId = null, declared = null, unavailable = null, className }: ModuleSecretsProps) {
  const queryClient = useQueryClient();
  const ids = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  // Which of the two a row is offering, and what is typed as a variable's
  // name (EO-417). Held only where the person has chosen or typed: an
  // untouched row follows what is stored, so it opens on what it holds.
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [variables, setVariables] = useState<Record<string, string>>({});
  // Its own state, so a value typed before its name is not stranded under "".
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newMode, setNewMode] = useState<Mode>("value");
  // Null follows the name being typed, which is the prefill; a string is
  // what the person wrote over it.
  const [newVariable, setNewVariable] = useState<string | null>(null);
  // A reference waiting on its warning: it replaces a stored value, and
  // once replaced that value is gone for good, so it cannot be put back.
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const scope = stepId ?? null;
  // The row's own scope, as Save and Remove act on.
  const reveal = useSecretReveal((secret) => ipcQuery("moduleSecrets:reveal", { name: secret, stepId: scope }));
  const secrets = useQuery({
    queryKey: moduleSecretsKey(scope),
    queryFn: () => ipcQuery("moduleSecrets:list", { stepId: scope }),
    enabled: unavailable === null,
  });
  // The other list (EO-486): a declared name whose value is an
  // environment variable has no secret, and is not "Not set".
  const environment = useQuery({
    queryKey: environmentVariablesKey(scope),
    queryFn: () => ipcQuery("environmentVariables:list", { stepId: scope }),
    enabled: unavailable === null,
  });

  // The whole prefix: a step's list holds the shared names too, so a save
  // in either scope reaches every cached answer.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: moduleSecretsRootKey }),
      // The Environment variables list says which names are secrets.
      queryClient.invalidateQueries({ queryKey: environmentVariablesRootKey }),
    ]);

  const set = useMutation({
    mutationFn: (pending: Pending) =>
      ipcQuery(
        "moduleSecrets:set",
        pending.variable === undefined
          ? { name: pending.name, value: pending.value, stepId: scope }
          : { name: pending.name, reference: { variable: pending.variable }, stepId: scope },
      ),
    onSuccess: async (result, pending) => {
      setConfirming(null);
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      // What was revealed is not what is stored any more.
      reveal.hide(pending.name);
      // Cleared once sent; a refused value stays in its box on purpose.
      if (pending.fromAddRow) {
        setNewName("");
        setNewValue("");
        setNewMode("value");
        setNewVariable(null);
      } else {
        // The typed value goes whichever kind was saved: a reference
        // saved beside a half-typed token must not leave the token behind.
        setValues((current) => ({ ...current, [pending.name]: "" }));
        setModes((current) => without(current, pending.name));
        setVariables((current) => without(current, pending.name));
      }
      setProblem(null);
      await invalidate();
    },
    // A rejected name arrives as a rejection, not a `problem`.
    onError: (error: Error) => {
      setConfirming(null);
      setProblem(error.message);
    },
  });

  const clear = useMutation({
    mutationFn: (secret: string) => ipcQuery("moduleSecrets:clear", { name: secret, stepId: scope }),
    onSuccess: async (_result, secret) => {
      reveal.hide(secret);
      setProblem(null);
      await invalidate();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  if (unavailable !== null) return <p className={cn("text-[12.5px] text-ink-subtle", className)}>{unavailable}</p>;

  const shared = secrets.data?.names ?? [];
  const overrides = secrets.data?.overrides ?? [];
  // The organisation's names (EO-328, ARCHITECTURE.md, "Secrets"): folded in so a declared name
  // it supplies is not drawn as a debt the person owes.
  const organisation = secrets.data?.organisation ?? [];
  // Every reference in the shared scope and in this step, resolving or
  // not (EO-416). A variable's name and a boolean — never what it holds.
  const references = secrets.data?.references ?? [];
  const referenceIn = (secret: string, where: "shared" | "step") => references.find((reference) => reference.name === secret && reference.scope === where) ?? null;
  /** The reference this scope itself holds for a name, which is what Save and Remove here act on. */
  const ownReference = (secret: string) => referenceIn(secret, scope === null ? "shared" : "step");
  // A dangling reference is in neither list above, and still has to be a
  // row: it is the one that most needs reading and removing.
  // So is a stored value that no longer decrypts (EO-489): it is in
  // neither list either, and leaving it out hid the one row that says it
  // cannot be read and offers to remove it.
  const storedHere = secrets.data?.stored ?? { shared: [], step: [] };
  const rows =
    declared ??
    [...new Set([...shared, ...organisation, ...references.map((reference) => reference.name), ...storedHere.shared, ...(scope === null ? [] : storedHere.step)])].sort();
  // Never inferred from an empty answer: a failed read drawn as "not set"
  // would hide the Remove button for a value that is still there.
  const known = secrets.isSuccess;

  /** The organisation's line first, because its value is what the run actually gets. */
  const statusOf = (secret: string): { text: string; tone: string } => {
    if (!known) return { text: secrets.isError ? "Unknown" : "…", tone: "text-ink-subtle" };
    if (organisation.includes(secret)) return { text: ORGANISATION_SECRET_LINE, tone: "text-ink-subtle" };
    // The step's own entry before the shared one, whichever kind each
    // is — and a step's reference before anything, resolving or not: one
    // that dangles does not fall back, so the shared entry's status
    // would describe a value this step will never be given.
    const stepReference = scope === null ? null : referenceIn(secret, "step");
    if (stepReference) return reads(`Reads ${stepReference.variable} from EO's environment for this step`, stepReference.available, "text-running");
    if (overrides.includes(secret)) return { text: "Set for this step", tone: "text-running" };
    // There and unreadable: like a dangling reference, it is this step's
    // answer for the name, and nothing shared — a secret or a variable —
    // is what the step gets instead.
    if (scope !== null && unreadableSecretIn(secrets.data, secret, "step")) return { text: unreadableSecretLine("step").text, tone: "text-danger" };
    // A step's own variable beats every shared entry, secret or not (EO-486).
    const stepVariable = scope === null ? null : variableLineForSecret(secret, (environment.data?.variables ?? []).filter((each) => each.scope === "step"), scope);
    if (stepVariable) return { text: stepVariable.text, tone: "text-running" };
    const sharedReference = referenceIn(secret, "shared");
    if (sharedReference) {
      const line = scope === null ? `Reads ${sharedReference.variable} from EO's environment` : `Using the shared entry · reads ${sharedReference.variable} from EO's environment`;
      return reads(line, sharedReference.available, "text-ink-subtle");
    }
    if (shared.includes(secret)) return { text: scope === null ? "Set" : "Using the shared value", tone: "text-ink-subtle" };
    if (unreadableSecretIn(secrets.data, secret, "shared")) return { text: unreadableSecretLine("shared").text, tone: "text-danger" };
    // Filled from the Environment variables list instead (EO-486). Not
    // "Not set" until that list has answered: it may yet say otherwise.
    if (!environment.isSuccess) return { text: environment.isError ? "Unknown" : "…", tone: "text-ink-subtle" };
    const variable = variableLineForSecret(secret, environment.data.variables ?? [], scope);
    if (variable) return { text: variable.text, tone: "text-ink-subtle" };
    return { text: "Not set", tone: "text-danger" };
  };

  /**
   * Whether this scope holds a stored value for a name: what a reference
   * saved here would remove.
   *
   * Read from `stored` rather than from the lists a status is drawn from.
   * Those leave out a value that no longer decrypts, since no dispatch
   * would get it — and it is removed, for good, like any other.
   */
  const holdsValue = (secret: string): boolean => {
    const stored = secrets.data?.stored;
    return known && stored !== undefined && (scope === null ? stored.shared : stored.step).includes(secret);
  };

  /**
   * Saves a reference, by way of the warning when it would cost a value.
   *
   * The name is checked here, in the words `needs.env` uses, so a bad one
   * is refused with what was typed still in its field.
   */
  const saveReference = (name: string, variable: string, fromAddRow: boolean) => {
    if (!MODULE_ENV_NAME_PATTERN.test(variable)) {
      setProblem(MODULE_ENV_NAME_MESSAGE);
      return;
    }
    const pending: Pending = { name, variable, fromAddRow };
    if (holdsValue(name)) {
      setProblem(null);
      setConfirming(pending);
      return;
    }
    set.mutate(pending);
  };

  /** Said before the save rather than after it: by then the value is gone. */
  const replaceWarning = (pending: Pending) => (
    <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-paused">
      <p className="min-w-0 flex-1">
        {pending.name} has a stored value {scope === null ? "here" : "for this step"}. Reading {pending.variable} from EO&apos;s environment removes it, and it cannot be read back.
      </p>
      <Button size="sm" variant="danger" aria-label={`Remove the stored value of ${pending.name}`} disabled={set.isPending} onClick={() => set.mutate(pending)}>
        Remove the stored value
      </Button>
      <Button size="sm" variant="ghost" aria-label={`Keep the stored value of ${pending.name}`} disabled={set.isPending} onClick={() => setConfirming(null)}>
        Keep it
      </Button>
    </div>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {secrets.isError ? <p className="text-[12.5px] text-danger">Could not read which secrets are set.</p> : null}
      {rows.map((secret) => {
        const status = statusOf(secret);
        const typed = byName(values, secret) ?? "";
        const own = known ? ownReference(secret) : null;
        // No reference where the organisation supplies the name: its value
        // is what a run is given, so one here would point at nothing.
        const supplied = organisation.includes(secret);
        const mode: Mode = supplied ? "value" : (byName(modes, secret) ?? (own ? "reference" : "value"));
        // Prefilled with what this scope reads now, and otherwise with the declared name.
        const variable = byName(variables, secret) ?? own?.variable ?? secret;
        const saving = set.isPending && set.variables?.name === secret;
        // Offered only against a list that arrived.
        // A value that cannot be read is removable like any other (EO-489).
        const clearable = known && (own !== null || (scope === null ? shared : overrides).includes(secret) || holdsValue(secret));
        // A value this scope stores and can read (EO-489): not the
        // organisation's, not a reference, not where the machine half is refused.
        const revealable = reveal.available && known && !supplied && own === null && (scope === null ? shared : overrides).includes(secret);
        const shown = revealable ? reveal.revealed(secret) : undefined;
        const line = revealLine(shown);
        return (
          <div key={secret} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
              <code className="font-mono text-[12px] text-ink">{secret}</code>
              <span id={`${ids}-${secret}`} className={cn("text-[11.5px]", status.tone)}>
                {status.text}
              </span>
            </div>
            {supplied ? null : (
              <Segmented
                size="sm"
                label={`How ${secret} is supplied`}
                value={mode}
                options={MODE_OPTIONS}
                onChange={(next) => {
                  setConfirming(null);
                  setModes((current) => ({ ...current, [secret]: next }));
                }}
              />
            )}
            <div className="flex min-w-0 items-center gap-1.5">
              {mode === "reference" ? (
                <TextInput
                  aria-label={`Variable for ${secret}`}
                  aria-describedby={`${ids}-${secret}`}
                  className="font-mono"
                  placeholder={secret}
                  value={variable}
                  onChange={(event) => {
                    setConfirming(null);
                    setVariables((current) => ({ ...current, [secret]: event.target.value }));
                  }}
                />
              ) : (
                <TextInput
                  aria-label={`Value for ${secret}`}
                  aria-describedby={`${ids}-${secret}`}
                  type="password"
                  placeholder={scope === null ? "Value" : "Value for this step"}
                  value={typed}
                  onChange={(event) => setValues((current) => ({ ...current, [secret]: event.target.value }))}
                />
              )}
              {/* Named after the secret, and pending per row. */}
              <Button
                size="sm"
                aria-label={`Save ${secret}`}
                disabled={(mode === "reference" ? variable === "" : typed === "") || saving}
                onClick={() => (mode === "reference" ? saveReference(secret, variable, false) : set.mutate({ name: secret, value: typed, fromAddRow: false }))}
              >
                Save
              </Button>
              {/* A step's entry falls back to the shared one rather than unsetting the name. A reference is cleared as a value is. */}
              {clearable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={scope === null ? `Remove ${secret}` : `Use the shared value for ${secret}`}
                  disabled={clear.isPending && clear.variables === secret}
                  onClick={() => clear.mutate(secret)}
                >
                  {scope === null ? "Remove" : "Use shared"}
                </Button>
              ) : null}
              {revealable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={shown === undefined ? `Reveal ${secret}` : `Hide ${secret}`}
                  disabled={shown?.state === "pending"}
                  onClick={() => (shown === undefined ? reveal.reveal(secret) : reveal.hide(secret))}
                >
                  {shown === undefined ? "Reveal" : "Hide"}
                </Button>
              ) : null}
            </div>
            {line?.kind === "value" ? (
              <code aria-label={`Value of ${secret}`} className="min-w-0 break-all rounded-md bg-canvas-subtle px-2 py-1 font-mono text-[12px] text-ink select-all">
                {line.value}
              </code>
            ) : null}
            {line?.kind === "message" ? <p className={cn("text-[11.5px]", line.danger ? "text-danger" : "text-ink-subtle")}>{line.text}</p> : null}
            {confirming && !confirming.fromAddRow && confirming.name === secret ? replaceWarning(confirming) : null}
          </div>
        );
      })}
      {known && rows.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nothing set.</p> : null}
      {/* Only without a manifest: with one, every name it could be given is a row above. */}
      {declared === null ? (
        <div className="flex min-w-0 flex-col gap-1.5 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <TextInput
              aria-label="Secret name"
              className="min-w-[8rem] flex-1 font-mono"
              placeholder="FLY_API_TOKEN"
              value={newName}
              onChange={(event) => {
                setConfirming(null);
                setNewName(event.target.value);
              }}
            />
            <Segmented
              size="sm"
              label="How the new name is supplied"
              value={newMode}
              options={MODE_OPTIONS}
              onChange={(next) => {
                setConfirming(null);
                setNewMode(next);
              }}
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {newMode === "reference" ? (
              <TextInput
                aria-label="Variable to read"
                className="min-w-[8rem] flex-1 font-mono"
                placeholder="Variable"
                value={newVariable ?? newName}
                onChange={(event) => {
                  setConfirming(null);
                  setNewVariable(event.target.value);
                }}
              />
            ) : (
              <TextInput
                aria-label="Secret value"
                className="min-w-[8rem] flex-1"
                type="password"
                placeholder="Value"
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
              />
            )}
            <Button
              size="sm"
              disabled={newName === "" || (newMode === "reference" ? (newVariable ?? newName) === "" : newValue === "") || set.isPending}
              onClick={() => (newMode === "reference" ? saveReference(newName, newVariable ?? newName, true) : set.mutate({ name: newName, value: newValue, fromAddRow: true }))}
            >
              Save
            </Button>
          </div>
          {confirming?.fromAddRow ? replaceWarning(confirming) : null}
        </div>
      ) : null}
      {problem ? <p className="text-[12.5px] text-danger">{problem}</p> : null}
    </div>
  );
}
