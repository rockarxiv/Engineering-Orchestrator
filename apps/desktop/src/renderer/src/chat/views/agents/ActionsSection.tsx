import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ACTION_KEY_PATTERN, actionDefinitionProviderSchema, ENGINE_RESULTS } from "@eo/core";
import type { ActionRouteUse, ActionUse, RegistryView } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { registryKey, useChromeVocabulary } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { ManagedLockLine } from "../../managed/ManagedSection";
import { ReadOnlyFence } from "../../admin/ReadOnlyFence";
import { Button, CardSection, Checkbox, Chip, ConfirmDialog, ErrorLine, Field, IconButton, Notice, Segmented, Select, TextArea, TextInput } from "../../kit";
import {
  blankRow,
  FIELD_KINDS,
  fieldsFromRows,
  fieldsFromText,
  fieldsToText,
  kindOf,
  rowProblems,
  rowsFromFields,
  withKind,
  type FieldKind,
  type FieldRow,
} from "./actionFields";

/**
 * What the agent's role answers in (EO-427): the actions it can be
 * dispatched on, each with the results it may return.
 *
 * **The role's, not the agent's.** A definition is keyed by role and
 * action, so two agents sharing a role are shown one list and an edit
 * made from either is the other's too — which is why this reads the
 * registry by role and holds nothing on the agent.
 *
 * Two kinds of action are listed and only one is editable. An action a
 * pack ships for the role is drawn read-only: the pack decides its
 * shape, and the schema shown for it is asked of the main process, which
 * is the only place that holds it (`roleActions:inspect`). An action the
 * role defines for itself is edited here, through `roleActions:save` —
 * the one save every definition is written by — so this screen refuses
 * exactly what an import or the system agent's tool would.
 *
 * Under an organisation lock on the agents section both are read-only
 * and the section says who manages it. The two channels are refused
 * there in any case (`SECTION_LOCKED_CHANNELS.agents`); the fence is so
 * nobody is offered a control that would do nothing.
 */

type ActionView = NonNullable<RegistryView["roleActions"]>[number]["actions"][number];

interface ResultDraft {
  key: string;
  label: string;
  meaning: string;
}

interface Draft {
  action: string;
  description: string;
  results: ResultDraft[];
  /** The fields schema as it stands: what the list was read from, and what is saved. */
  fields: Record<string, unknown>;
  /** The schema's properties as rows, or null where only the JSON view can read it. */
  rows: FieldRow[] | null;
  /** The JSON view's text — the same schema, or what somebody is half-way through typing. */
  text: string;
  /** Why the text is not the schema yet, in the parser's words. */
  textProblem: string | null;
}

const NEW = "\u0000new";

/** The registry as `registry:get` sends it, kept as sent: `usedBy` is on the wire and not in the maps `useRegistry` builds. */
const registryViewKey = [...registryKey, "view"] as const;

function draftOf(action: ActionView | null): Draft {
  const fields = { ...(action?.fields ?? {}) };
  return {
    action: action?.action ?? "",
    description: action?.description ?? "",
    results: action === null ? [{ key: "done", label: "", meaning: "" }] : action.results.map((result) => ({ key: result.key, label: result.label, meaning: result.meaning ?? "" })),
    fields,
    rows: rowsFromFields(fields),
    text: fieldsToText(fields),
    textProblem: null,
  };
}

/**
 * What a saved definition says, as one string to compare: the parts an
 * editor's draft is made from and nothing else. Which steps use it is
 * left out — that is read live and is nobody's draft.
 */
function savedContent(action: ActionView | null): string | null {
  if (action === null) return null;
  return JSON.stringify({
    description: action.description,
    results: action.results.map((result) => [result.key, result.label, result.meaning ?? ""]),
    fields: action.fields ?? {},
  });
}

/**
 * One role's action as the main process has it: the provider schema in
 * force, and the steps that dispatch the pair with the keys each routes.
 *
 * Under the registry's key, so the invalidation a save makes reaches it,
 * and on `config:changed`, because a pipeline published in another
 * window changes the answer as much as a definition does.
 */
function useInspection(role: string, action: string, enabled: boolean) {
  const key = [...registryKey, "action", role, action] as const;
  useInvalidateOnPush("config:changed", key, enabled);
  return useQuery({ queryKey: key, queryFn: () => ipcQuery("roleActions:inspect", { role, action }), enabled });
}

/** One use, as a line: the step, its pipeline, and — for a step only an older version still has — what is finishing on it. */
function lineOf(use: ActionUse, items: string): string {
  if (use.finishing === undefined) return `"${use.stepName}" (${use.pipelineName})`;
  const { version, items: count } = use.finishing;
  return `"${use.stepName}" (${use.pipelineName} v${String(version)}, ${String(count)} ${items} still finishing on it)`;
}

function UsedBy({ uses, title = "Used by" }: { uses: readonly ActionUse[]; title?: string }) {
  const items = useChromeVocabulary().items.toLowerCase();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-muted">{title}</span>
      {uses.length === 0 ? (
        <p className="text-[12.5px] text-ink-subtle">No pipeline step dispatches this action.</p>
      ) : (
        <ul aria-label="Steps using this action" className="flex flex-col gap-0.5 text-[12.5px] text-ink-muted">
          {uses.map((use, index) => (
            <li key={index}>{lineOf(use, items)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What saving these result keys does to the steps that route on them,
 * one sentence per key or step.
 *
 * A step using an action must route every declared key and may route no
 * other but the engine's own (EO-423). So, for a definition that exists:
 * a key taken away that some step routes, and a key added that some
 * step does not. For one being created over steps that already name the
 * role and the action — `savedKeys` is null — there is no "before" to
 * compare with, and the rule is asked whole: every key a step does not
 * route, and every route a step has on a key this will not return.
 *
 * Uses an older version holds are weighed like any other, against that
 * version's routes: the work still bound to it is carried by them, and
 * is answered with the definition as it stands.
 */
function routeImpact(uses: readonly ActionRouteUse[], savedKeys: readonly string[] | null, draftKeys: readonly string[], items: string): string[] {
  // A key somebody is half-way through typing is not one a route could name yet.
  const declared = draftKeys.filter((key) => ACTION_KEY_PATTERN.test(key));
  const named = (affected: readonly ActionRouteUse[]) => affected.map((use) => lineOf(use, items)).join(", ");
  const lines: string[] = [];

  if (savedKeys === null) {
    for (const use of uses) {
      const stray = use.routedKeys.filter((key) => !declared.includes(key) && !ENGINE_RESULTS.includes(key));
      if (stray.length > 0) lines.push(`${lineOf(use, items)} routes on ${stray.map((key) => `"${key}"`).join(", ")}, which this action will not return.`);
    }
    for (const key of declared) {
      const lacking = uses.filter((use) => !use.routedKeys.includes(key));
      if (lacking.length > 0) lines.push(`"${key}": ${named(lacking)} has no route for it.`);
    }
    return lines;
  }

  for (const key of savedKeys.filter((saved) => !draftKeys.includes(saved))) {
    const routing = uses.filter((use) => use.routedKeys.includes(key));
    if (routing.length > 0) lines.push(`Removing "${key}": ${named(routing)} routes on it, and will route on a key this action no longer returns.`);
  }
  for (const key of declared.filter((added) => !savedKeys.includes(added))) {
    const lacking = uses.filter((use) => !use.routedKeys.includes(key));
    if (lacking.length > 0) lines.push(`Adding "${key}": ${named(lacking)} will have no route for it.`);
  }
  return lines;
}

function RouteImpact({ uses, savedKeys, draftKeys }: { uses: readonly ActionRouteUse[]; savedKeys: readonly string[] | null; draftKeys: readonly string[] }) {
  const items = useChromeVocabulary().items.toLowerCase();
  const lines = routeImpact(uses, savedKeys, draftKeys, items);
  if (lines.length === 0) return null;
  const older = uses.some((use) => use.finishing !== undefined);

  return (
    <Notice tone="paused" role="status" title="Saving this changes what these steps must route">
      <ul aria-label="Routes affected" className="flex flex-col gap-0.5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-ink-subtle">A pipeline named here will not publish again until its routes match.</p>
      {older ? (
        <p className="text-ink-subtle">
          A step of an older version cannot be edited: the {items} still finishing on it keep that version&apos;s routes, and an answer with no route there waits for
          a person.
        </p>
      ) : null}
    </Notice>
  );
}

function SchemaBlock({ text }: { text: string }) {
  return (
    <pre aria-label="Provider schema" className="max-h-72 overflow-auto rounded-[10px] bg-canvas-raised px-3 py-2 font-mono text-[11.5px] leading-snug text-ink-muted">
      {text}
    </pre>
  );
}

/** The exact document the provider is handed for this definition: `result`, `summary`, then the fields, under EO's wrapper. */
function ProviderSchema({ results, fields }: { results: ResultDraft[]; fields: Record<string, unknown> }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(actionDefinitionProviderSchema({ results, fields }), null, 2);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [results, fields]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-muted">What the provider is handed</span>
      <p className="text-[11.5px] leading-snug text-ink-subtle">
        Generated from the results and fields above: <code className="font-mono">result</code> is one of the declared keys, <code className="font-mono">summary</code> is
        always required, and the agent may ask a question instead of answering.
      </p>
      <SchemaBlock text={text} />
    </div>
  );
}

function ResultRows({ results, onChange }: { results: ResultDraft[]; onChange: (results: ResultDraft[]) => void }) {
  const set = (index: number, patch: Partial<ResultDraft>) => onChange(results.map((result, at) => (at === index ? { ...result, ...patch } : result)));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-muted">Results</span>
      <ul aria-label="Results" className="flex min-w-0 flex-col gap-1.5">
        {results.map((result, index) => (
          <li key={index} className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-1.5">
            <TextInput aria-label={`Result ${String(index + 1)} key`} className="font-mono" placeholder="key" value={result.key} onChange={(event) => set(index, { key: event.target.value })} />
            <TextInput aria-label={`Result ${String(index + 1)} label`} placeholder="Label" value={result.label} onChange={(event) => set(index, { label: event.target.value })} />
            <TextInput
              aria-label={`Result ${String(index + 1)} when to return it`}
              placeholder="When to return it"
              value={result.meaning}
              onChange={(event) => set(index, { meaning: event.target.value })}
            />
            <IconButton label={`Remove result ${String(index + 1)}`} icon={<Trash2 size={14} />} tone="danger" onClick={() => onChange(results.filter((_, at) => at !== index))} />
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...results, { key: "", label: "", meaning: "" }])}>
          Add result
        </Button>
      </div>
    </div>
  );
}

function FieldList({ rows, onChange }: { rows: FieldRow[]; onChange: (rows: FieldRow[]) => void }) {
  const set = (index: number, next: FieldRow) => onChange(rows.map((row, at) => (at === index ? next : row)));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {rows.length === 0 ? <p className="text-[12.5px] text-ink-subtle">No extra fields: the answer is its result and its summary.</p> : null}
      <ul aria-label="Fields" className="flex min-w-0 flex-col gap-1.5">
        {rows.map((row, index) => {
          const kind = kindOf(row.schema);
          const name = row.name === "" ? `Field ${String(index + 1)}` : row.name;
          return kind === null ? (
            // Carried through as written: nothing here can change it, so nothing here is a control.
            <li key={index} aria-label={name} className="flex min-w-0 items-center gap-2 rounded-[10px] bg-canvas-raised px-2.5 py-1.5">
              <span className="truncate font-mono text-[12.5px] text-ink">{row.name}</span>
              {row.required ? <span className="text-[11.5px] text-ink-subtle">required</span> : null}
              <Chip className="ml-auto">JSON only</Chip>
              <span className="text-[11.5px] text-ink-subtle">Editable in the JSON view only</span>
            </li>
          ) : (
            <li key={index} aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto_auto] items-center gap-1.5">
              <TextInput aria-label={`Field ${String(index + 1)} name`} className="font-mono" placeholder="name" value={row.name} onChange={(event) => set(index, { ...row, name: event.target.value })} />
              <Select aria-label={`Field ${String(index + 1)} type`} value={kind} onChange={(event) => set(index, withKind(row, event.target.value as FieldKind))}>
                {FIELD_KINDS.map((choice) => (
                  <option key={choice.kind} value={choice.kind}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              <Checkbox checked={row.required} onChange={(required) => set(index, { ...row, required })} label="Required" ariaLabel={`Field ${String(index + 1)} required`} />
              <IconButton label={`Remove field ${String(index + 1)}`} icon={<Trash2 size={14} />} tone="danger" onClick={() => onChange(rows.filter((_, at) => at !== index))} />
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...rows, blankRow()])}>
          Add field
        </Button>
      </div>
    </div>
  );
}

/** One of the role's own actions, open: what it is for, its results, its fields in either view, where it is used and what the provider gets. */
function ActionEditor({
  role,
  existing,
  readOnly,
  onClose,
}: {
  role: string;
  existing: ActionView | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(existing));
  /** The saved definition this draft was made from, so one saved since can be told apart from it. */
  const [base, setBase] = useState(() => savedContent(existing));
  const [touched, setTouched] = useState(false);
  const [view, setView] = useState<"list" | "json">("list");
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isNew = existing === null;

  // The definition was saved somewhere else while this was open — the
  // other agent on the role, another window, the system agent. A draft
  // nobody has typed into follows it, here, in the render that noticed:
  // an open editor showing what used to be saved is one whose Save
  // would put it back. A draft somebody has typed into is theirs, and
  // is asked about below rather than replaced or silently kept.
  const latest = savedContent(existing);
  const changedElsewhere = latest !== base;
  if (changedElsewhere && !touched) {
    setBase(latest);
    setDraft(draftOf(existing));
  }
  const conflict = changedElsewhere && touched;

  const edit = (change: (current: Draft) => Draft) => {
    setTouched(true);
    setDraft(change);
  };

  // The registry is what every reader of a definition reads — this list, the other agent on the role, the pipeline editor's validation.
  const refresh = () => void queryClient.invalidateQueries({ queryKey: registryKey });

  const name = draft.action.trim();
  const savedKeys = isNew ? null : existing.results.map((result) => result.key);
  const draftKeys = draft.results.map((result) => result.key);
  const keysChanged = savedKeys === null || savedKeys.length !== draftKeys.length || savedKeys.some((key, index) => draftKeys[index] !== key);
  // Asked of the main process, which holds the pipelines and their older
  // versions. For a new action that is "which steps already name this
  // role and this action", so it follows the name as it is typed.
  const inspectable = !readOnly && ACTION_KEY_PATTERN.test(name);
  const inspection = useInspection(role, name, inspectable);
  // A change of keys is not saved before what it does to the steps
  // routing on them has been worked out and shown: an answer still on
  // its way, or one that failed, is not "nothing is affected".
  const impactNeeded = inspectable && keysChanged;
  //
  // "On its way" includes a refetch. An answer already in the cache is
  // kept while the next one is fetched, and the next one is fetched
  // because something changed — a pipeline published in another window
  // invalidates this. So an answer being replaced is not one to save
  // against either: its steps and routes are the ones from before.
  const impactPending = impactNeeded && (inspection.isFetching || (inspection.data === undefined && !inspection.isError));
  const impactFailed = impactNeeded && inspection.isError && !inspection.isFetching;
  const impact = impactNeeded && !impactPending && !impactFailed ? inspection.data : undefined;

  const save = useMutation({
    mutationFn: () => ipcQuery("roleActions:save", { role, action: name, description: draft.description, results: draft.results, fields: draft.fields }),
    onSuccess: (result) => {
      // A refusal keeps the draft, and says why in the save's own words — the compiler's, where it was the schema.
      if (!result.saved) {
        setProblems(result.problems);
        return;
      }
      setProblems([]);
      refresh();
      onClose();
    },
    onError: (error: Error) => setProblems([error.message]),
  });

  const remove = useMutation({
    mutationFn: () => ipcQuery("roleActions:delete", { role, action: draft.action }),
    onSuccess: (result) => {
      setConfirmingDelete(false);
      if (!result.deleted) {
        setProblems([result.problem ?? "Nothing was deleted."]);
        return;
      }
      refresh();
      onClose();
    },
    onError: (error: Error) => {
      setConfirmingDelete(false);
      setProblems([error.message]);
    },
  });

  const setRows = (rows: FieldRow[]) =>
    edit((current) => {
      const fields = fieldsFromRows(current.fields, rows);
      return { ...current, rows, fields, text: fieldsToText(fields), textProblem: null };
    });

  const setText = (text: string) =>
    edit((current) => {
      const read = fieldsFromText(text);
      // Text that does not parse leaves the schema as it last was: the list keeps showing something true.
      if (!read.ok) return { ...current, text, textProblem: read.problem };
      return { ...current, text, textProblem: null, fields: read.fields, rows: rowsFromFields(read.fields) };
    });

  const listProblems = draft.rows === null ? [] : rowProblems(draft.rows);
  const busy = save.isPending || remove.isPending;
  const canSave = !busy && name !== "" && draft.textProblem === null && listProblems.length === 0 && !conflict && !impactPending && !impactFailed;

  return (
    <section aria-label={isNew ? "New action" : `Action ${draft.action}`} className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-line px-3.5 py-3">
      {conflict ? (
        <Notice
          tone="paused"
          role="alert"
          title="This action was changed somewhere else while you were editing it"
          action={
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                onClick={() => {
                  setBase(latest);
                  setDraft(draftOf(existing));
                  setTouched(false);
                  setProblems([]);
                }}
              >
                Load the saved version
              </Button>
              <Button size="sm" onClick={() => setBase(latest)}>
                Keep my edits
              </Button>
            </div>
          }
        >
          What is shown below is your draft, made from the version before that change. Load the saved version to start from it, or keep your edits — saving them
          then replaces what was saved.
        </Notice>
      ) : null}

      <ReadOnlyFence readOnly={readOnly}>
        <div className="grid gap-3 @xl:grid-cols-2">
          {/* The pair is what a definition is: an action renamed would be another definition, so the name is fixed once saved. */}
          <Field label="Action" {...(isNew ? { hint: "lowercase letters, digits and underscores" } : { hint: "fixed once created" })}>
            <TextInput className="font-mono" value={draft.action} disabled={!isNew} onChange={(event) => edit((current) => ({ ...current, action: event.target.value }))} />
          </Field>
        </div>
        <Field label="Description" hint="What the action is for, as the agent is told it.">
          <TextArea className="min-h-16" value={draft.description} onChange={(event) => edit((current) => ({ ...current, description: event.target.value }))} />
        </Field>

        <ResultRows results={draft.results} onChange={(results) => edit((current) => ({ ...current, results }))} />
      </ReadOnlyFence>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex-1 text-[12px] font-medium text-ink-muted">Fields</span>
          {/* Outside the fence: reading the schema either way is not editing it. */}
          <Segmented
            label="Fields view"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List" },
              { value: "json", label: "JSON" },
            ]}
          />
        </div>
        <ReadOnlyFence readOnly={readOnly}>
          {view === "json" ? (
            <TextArea
              aria-label="Fields schema"
              className="min-h-40 font-mono text-[12px]"
              spellCheck={false}
              value={draft.text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : draft.textProblem !== null ? (
            <Notice tone="paused">The JSON view holds something that is not JSON yet. Finish it there, and the list will show it.</Notice>
          ) : draft.rows === null ? (
            <Notice tone="paused">
              This schema&apos;s <code className="font-mono">properties</code> or <code className="font-mono">required</code> is not written in a form the list can
              read. It is editable in the JSON view only.
            </Notice>
          ) : (
            <FieldList rows={draft.rows} onChange={setRows} />
          )}
        </ReadOnlyFence>
        {draft.textProblem !== null ? <ErrorLine>{draft.textProblem}</ErrorLine> : null}
        {listProblems.map((problem) => (
          <ErrorLine key={problem}>{problem}</ErrorLine>
        ))}
      </div>

      {isNew ? (
        // Steps may already name this role and this action, as words: they are what creating it changes.
        (inspection.data?.uses.length ?? 0) > 0 ? (
          <UsedBy uses={inspection.data?.uses ?? []} title="Already dispatched by" />
        ) : null
      ) : (
        <UsedBy uses={existing.usedBy ?? []} />
      )}
      <ProviderSchema results={draft.results} fields={draft.fields} />

      {impactPending ? (
        <p role="status" className="text-[12.5px] text-ink-subtle">
          Checking which steps route on these results…
        </p>
      ) : null}
      {impactFailed ? (
        <Notice
          tone="danger"
          role="alert"
          title="EO could not work out which steps this change affects, so it is not saved yet"
          action={
            <Button size="sm" onClick={() => void inspection.refetch()}>
              Try again
            </Button>
          }
        >
          {inspection.error?.message}
        </Notice>
      ) : null}
      {impact !== undefined ? <RouteImpact uses={impact.uses} savedKeys={savedKeys} draftKeys={draftKeys} /> : null}

      {problems.length > 0 ? (
        <ul aria-label="Why this was not saved" role="alert" className="flex flex-col gap-0.5 text-[12.5px] text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {!isNew && !readOnly ? (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(true)} className="mr-auto">
            Delete action
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {readOnly ? null : (
          <Button variant="primary" disabled={!canSave} onClick={() => save.mutate()}>
            {isNew ? "Create action" : "Save action"}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete the ${role} role's "${draft.action}" action?`}
        confirmLabel="Delete action"
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmingDelete(false)}
      >
        <p>The definition is removed for every agent on this role. It is refused while a pipeline step still dispatches it.</p>
      </ConfirmDialog>
    </section>
  );
}

/**
 * An action a pack ships for the role, open: everything the registry
 * says about it, the schema the pack holds it to, and nothing to change.
 *
 * The schema is asked for rather than generated. A pack's action is not
 * `result` and `summary` plus fields — the reviewer answers with a
 * verdict — so a document built here from its result keys would be a
 * plausible picture of something no provider is ever handed.
 */
function ShippedAction({ role, action, onClose }: { role: string; action: ActionView; onClose: () => void }) {
  const inspection = useInspection(role, action.action, true);
  const schema = inspection.data?.providerSchema;
  return (
    <section aria-label={`Action ${action.action}`} className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-line px-3.5 py-3">
      <Notice>This action ships with the role. The pack that ships it decides its results and its shape, so it is shown here and cannot be edited.</Notice>
      {action.description !== "" ? <p className="text-[12.5px] leading-snug text-ink-muted">{action.description}</p> : null}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-muted">Results</span>
        <ul aria-label="Results" className="flex flex-col gap-0.5 text-[12.5px] text-ink-muted">
          {action.results.map((result) => (
            <li key={result.key}>
              <span className="font-mono text-ink">{result.key}</span> — {result.label}
            </li>
          ))}
        </ul>
      </div>
      <UsedBy uses={action.usedBy ?? []} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-muted">What the provider is handed</span>
        <p className="text-[11.5px] leading-snug text-ink-subtle">
          The pack&apos;s own schema for this action, as the main process hands it over. Where an item type gives the action another shape, a run on that type is
          handed that one instead.
        </p>
        {inspection.isError ? (
          <ErrorLine>{inspection.error.message}</ErrorLine>
        ) : inspection.data === undefined ? (
          <p role="status" className="text-[12.5px] text-ink-subtle">
            Asking for the schema…
          </p>
        ) : schema === null || schema === undefined ? (
          <p className="text-[12.5px] text-ink-subtle">No schema is handed over for this action: its answer is read as prose.</p>
        ) : (
          <SchemaBlock text={JSON.stringify(schema, null, 2)} />
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

export function ActionsSection({ role, locked, reveal = false }: { role: string; locked: boolean; /** Arrived at by address (EO-428): brought into sight once. */ reveal?: boolean }) {
  const sectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [reveal, role]);
  const view = useQuery({ queryKey: registryViewKey, queryFn: () => ipcQuery("registry:get", undefined) });
  // A definition saved anywhere else — the system agent's tool, an import, another window — is announced on this channel.
  useInvalidateOnPush("config:changed", registryViewKey);
  const [open, setOpen] = useState<string | null>(null);

  const shipped = view.data?.roles.find((entry) => entry.slug === role)?.actions ?? [];
  const own = view.data?.roleActions?.find((entry) => entry.role === role)?.actions ?? [];
  const actions = [...shipped, ...own];
  const opened = open === null || open === NEW ? null : (actions.find((entry) => entry.action === open) ?? null);

  return (
    <div ref={sectionRef} className="flex min-w-0 flex-col">
    <CardSection
      title="Actions"
      description={
        <>
          What the <span className="font-mono">{role}</span> role answers in: each action a pipeline step can dispatch it on, and the results it may return. Shared by every
          agent on this role.
        </>
      }
      actions={
        locked ? null : (
          <Button size="sm" icon={<Plus size={13} />} disabled={open === NEW} onClick={() => setOpen(NEW)}>
            New action
          </Button>
        )
      }
    >
      {/* Said here as well as at the head of the editor: this is the part somebody is about to try to change. */}
      {locked ? <ManagedLockLine section="agents" /> : null}
      {view.error ? <ErrorLine>{view.error.message}</ErrorLine> : null}
      {view.data !== undefined && actions.length === 0 && open !== NEW ? (
        <p className="text-[12.5px] text-ink-subtle">This role defines no actions yet. A step that dispatches it on one answers in prose, which is read as done.</p>
      ) : null}

      <ul aria-label="Actions" className="flex min-w-0 flex-col gap-1.5">
        {actions.map((action) => (
          <li key={action.action} aria-label={action.action} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[13px] text-ink">{action.action}</span>
                  {action.packShipped ? <Chip>Ships with the role · read-only</Chip> : null}
                  <span className="text-[11.5px] text-ink-subtle">
                    {(action.usedBy ?? []).length === 0 ? "not used by a step" : `used by ${String((action.usedBy ?? []).length)} step${(action.usedBy ?? []).length === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div aria-label={`Results of ${action.action}`} className="flex min-w-0 flex-wrap gap-1">
                  {action.results.map((result) => (
                    <Chip key={result.key} className="font-mono" title={result.label}>
                      {result.key}
                    </Chip>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                aria-label={`${open === action.action ? "Close" : action.packShipped || locked ? "View" : "Edit"} ${action.action}`}
                onClick={() => setOpen(open === action.action ? null : action.action)}
              >
                {open === action.action ? "Close" : action.packShipped || locked ? "View" : "Edit"}
              </Button>
            </div>
            {opened !== null && opened.action === action.action ? (
              action.packShipped ? (
                <ShippedAction role={role} action={action} onClose={() => setOpen(null)} />
              ) : (
                <ActionEditor key={action.action} role={role} existing={action} readOnly={locked} onClose={() => setOpen(null)} />
              )
            ) : null}
          </li>
        ))}
      </ul>

      {open === NEW && !locked ? <ActionEditor key="new" role={role} existing={null} readOnly={false} onClose={() => setOpen(null)} /> : null}
    </CardSection>
    </div>
  );
}
