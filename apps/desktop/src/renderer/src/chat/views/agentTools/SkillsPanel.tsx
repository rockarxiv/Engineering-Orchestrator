import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import {
  runsWithoutLoadLabel,
  skillAuthorLabel,
  skillMachineSpecificWarnings,
  skillVersionActionLabel,
  type IpcRequest,
  type Skill,
  type SkillFile,
  type SkillListEntry,
  type SkillUsage,
  type SkillScope,
  type SkillState,
  type SkillVersion,
  type SkillVersionReport,
} from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { skillsKey } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { BLANK, draftOf, toSave, type SkillDraft } from "../../../shared/agentTools/skills";
import { Button, Card, Chip, EmptyState, ErrorLine, Field, IconButton, Loading, Select, Switch, TextArea, TextInput } from "../../kit";
import { AttachedAgents, useNextDispatchNote } from "./attach";
import { TickOption } from "./ticks";
import { toggleLabel, type RowAction } from "./rowActions";
import { MachineSpecificValues } from "../../modules/MachineSpecificValues";
import { scopeFromValue, scopeLabel, scopeOptions, scopeValue, useSkillScopeTargets } from "../../../shared/agentTools/skillScope";
import { ScopeOptions } from "./skillScope";

/**
 * The catalogue of skills a person wrote (EO-105, EO-109), in the chat
 * layout's own terms.
 *
 * The draft and what it is saved as are the classic `Skills`' own
 * (`draftOf`, `toSave`): an empty slug goes as null — "decide one" on a
 * create, "keep it" on an edit — and `enabled` is never part of a save.
 */

/** The files beside `SKILL.md`: a path and a body each, text only. */
function SupportingFiles({ files, onChange }: { files: SkillFile[]; onChange: (files: SkillFile[]) => void }) {
  const replace = (index: number, file: SkillFile) => onChange(files.map((existing, at) => (at === index ? file : existing)));

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] font-medium text-ink-muted">Supporting files</span>
      {files.map((file, index) => (
        // The index is the identity: keying on the path being typed would remount the field on every keystroke.
        <div key={index} className="flex flex-col gap-2 rounded-[12px] bg-canvas-subtle p-3">
          <div className="flex items-end gap-1.5">
            <Field label="Path (inside the skill's own folder)" className="flex-1">
              <TextInput
                aria-label={`Path for supporting file ${String(index + 1)}`}
                placeholder="checklist.md"
                className="font-mono"
                value={file.path}
                onChange={(event) => replace(index, { ...file, path: event.target.value })}
              />
            </Field>
            <IconButton
              label={`Remove supporting file ${String(index + 1)}`}
              icon={<X size={14} />}
              tone="danger"
              onClick={() => onChange(files.filter((_, at) => at !== index))}
            />
          </div>
          <Field label="Contents">
            <TextArea
              aria-label={`Contents of supporting file ${String(index + 1)}`}
              className="min-h-24 font-mono text-[12px]"
              value={file.content}
              onChange={(event) => replace(index, { ...file, content: event.target.value })}
            />
          </Field>
        </div>
      ))}
      <div>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...files, { path: "", content: "" }])}>
          Add a supporting file
        </Button>
      </div>
    </div>
  );
}

/** Which runs the skill reaches once attached (EO-470) — the classic editor's picker, in this layout's kit. */
function ScopePicker({ scope, onChange }: { scope: SkillScope; onChange: (scope: SkillScope) => void }) {
  const targets = useSkillScopeTargets();
  return (
    <Field label="Scope (which runs it reaches once attached)">
      <Select aria-label="Scope" value={scopeValue(scope)} onChange={(event) => onChange(scopeFromValue(event.target.value))}>
        <ScopeOptions options={scopeOptions(targets, scope)} />
      </Select>
    </Field>
  );
}

/** The scope on a card, said only when it narrows anything. */
function ScopeChip({ scope }: { scope: SkillScope }) {
  const targets = useSkillScopeTargets();
  return scope.kind === "global" ? null : <Chip>{scopeLabel(scope, targets)}</Chip>;
}

function SkillEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  problem,
  saving,
}: {
  draft: SkillDraft;
  onChange: (draft: SkillDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  problem: string | null;
  saving: boolean;
}) {
  return (
    <section aria-label="Skill editor" className="flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4 shadow-[inset_0_0_0_1.5px_var(--color-accent)]">
      <h2 className="text-[14px] font-medium text-ink">{draft.id === undefined ? "New skill" : `Edit ${draft.name || "skill"}`}</h2>
      <div className="grid gap-3 @xl:grid-cols-2">
        <Field label="Name (what you call it)">
          <TextInput value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </Field>
        {/* The only name a model can invoke — a skill listed under a display name is one it cannot call (EO-105). */}
        <Field label="Slug (the only name a model can invoke; blank to decide one)">
          <TextInput className="font-mono" placeholder="pr-review" value={draft.slug} onChange={(event) => onChange({ ...draft, slug: event.target.value })} />
        </Field>
      </div>
      <Field label="Description (what the model reads to decide whether this is the one)">
        <TextInput value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
      </Field>
      <Field label="Body (what the model reads once it has chosen)">
        <TextArea className="min-h-56 font-mono text-[12px]" value={draft.body} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      </Field>
      {/* What the body holds that only exists on this machine (EO-450), read as it is typed. Advice: Save is never refused for it. */}
      <MachineSpecificValues warnings={skillMachineSpecificWarnings(draft.body)} subject="the skill" />

      <SupportingFiles files={draft.files} onChange={(files) => onChange({ ...draft, files })} />

      <ScopePicker scope={draft.scope} onChange={(scope) => onChange({ ...draft, scope })} />

      {/* Not the enable switch: this one is on disk and not offered; a disabled one is not delivered at all. */}
      <TickOption checked={draft.disableModelInvocation} onChange={(next) => onChange({ ...draft, disableModelInvocation: next })}>
        Do not offer this to the model — it is installed and readable, but the model will not pick it on its own. For a skill somebody invokes
        deliberately, or one that is half written.
      </TickOption>

      {problem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{problem}</p> : null}

      <div className="flex items-center gap-1.5">
        <Button variant="primary" disabled={saving} onClick={onSave}>
          {draft.id === undefined ? "Create skill" : "Save changes"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** The key one skill's history is read under — beneath `skillsKey`, so every skill write reads it again (EO-714). */
function skillVersionsKey(id: string) {
  return [...skillsKey, id, "versions"] as const;
}

/**
 * Every write to one skill, newest first, with Restore on each earlier
 * one (EO-714). A restore is itself a new version, naming the person.
 */
function SkillHistory({ skill, onRestored }: { skill: Skill; onRestored: () => Promise<unknown> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const versions = useQuery({ queryKey: skillVersionsKey(skill.id), queryFn: () => ipcQuery("skills:versions", { id: skill.id }) });
  const restore = useMutation({
    mutationFn: (versionId: string) => ipcQuery("skills:restoreVersion", { id: skill.id, versionId }),
    onSuccess: async (result) => {
      setProblem(result.problem);
      if (result.skill !== null) await onRestored();
    },
    onError: (error: Error) => setProblem(error.message),
  });
  const list: SkillVersion[] = versions.data?.versions ?? [];

  return (
    <section aria-label={`History of ${skill.name}`} className="flex flex-col gap-1.5 rounded-[12px] bg-canvas-subtle p-3">
      <span className="text-[12px] font-medium text-ink-muted">History</span>
      {versions.isLoading ? <Loading /> : null}
      {versions.error ? <ErrorLine>{versions.error.message}</ErrorLine> : null}
      {versions.data?.problem ? <ErrorLine>{versions.data.problem}</ErrorLine> : null}
      {problem !== null ? <p role="alert" className="text-[12px] text-danger">{problem}</p> : null}
      <ol className="flex flex-col gap-1.5">
        {list.map((version, index) => (
          <li key={version.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-1 basis-[14rem] flex-col">
              <span className="text-[12.5px] text-ink">
                {skillVersionActionLabel(version.action)} by {skillAuthorLabel(version.author)}
                {index === 0 ? " — current" : ""}
              </span>
              <span className="text-[11.5px] text-ink-subtle">{new Date(version.createdAt).toLocaleString()}</span>
              <span className="truncate text-[11.5px] text-ink-muted">{version.description}</span>
              {version.report === null ? null : <VersionReport report={version.report} />}
            </div>
            {index > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Restore the version from ${new Date(version.createdAt).toLocaleString()}`}
                disabled={restore.isPending}
                onClick={() => restore.mutate(version.id)}
              >
                Restore
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * What EO reported about one write, kept on the version rather than posted
 * anywhere (EO-728): the evidence a consolidation drew a skill from — each
 * memory entry and the item it came from — and, for an improvement, its
 * diff; or the runs without a load EO archived the skill after.
 */
function VersionReport({ report }: { report: SkillVersionReport }) {
  if (report.kind === "unused") return <span className="text-[11.5px] text-ink-muted">Archived by EO {runsWithoutLoadLabel(report.runsWithoutLoad)}.</span>;
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] font-medium text-ink-muted">Evidence</span>
      <ul aria-label="Evidence" className="flex flex-col gap-0.5">
        {report.evidence.map((entry) => (
          <li key={entry.entryId} className="text-[11.5px] text-ink-muted">
            {entry.itemKey === null ? null : <span className="font-mono text-ink-subtle">{entry.itemKey} · </span>}
            {entry.body ?? "(no longer there)"}
          </li>
        ))}
      </ul>
      {report.itemKeys.length > 0 ? <span className="text-[11.5px] text-ink-subtle">Seen on {report.itemKeys.join(", ")}.</span> : null}
      {report.diff === null ? null : (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-ink-muted">What it changed</summary>
          <pre aria-label="Diff" className="mt-1 overflow-x-auto rounded-[8px] bg-canvas p-2 font-mono text-[11px] text-ink">
            {report.diff}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Who archived an archived skill, and — for EO — after how many runs
 * without a load, with Restore beside it (EO-728). Restore puts back the
 * archive version itself, which is the skill as it was, live again.
 */
function ArchivedBy({ skill, onRestored }: { skill: SkillListEntry; onRestored: () => Promise<unknown> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: (versionId: string) => ipcQuery("skills:restoreVersion", { id: skill.id, versionId }),
    onSuccess: async (result) => {
      setProblem(result.problem);
      if (result.skill !== null) await onRestored();
    },
    onError: (error: Error) => setProblem(error.message),
  });
  const archive = skill.archive;
  if (archive === null) return null;
  const why = archive.runsWithoutLoad === null ? "" : ` ${runsWithoutLoadLabel(archive.runsWithoutLoad)}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-[12px] text-ink-muted">
        Archived by {skillAuthorLabel(archive.author)}
        {why}.
      </p>
      <Button size="sm" variant="ghost" aria-label={`Restore ${skill.name}`} disabled={restore.isPending} onClick={() => restore.mutate(archive.versionId)}>
        {restore.isPending ? "Restoring…" : "Restore"}
      </Button>
      {problem !== null ? <p role="alert" className="text-[12px] text-danger">{problem}</p> : null}
    </div>
  );
}

/**
 * How a skill has been used (EO-715): the runs given it, the runs that
 * loaded it, the last load, and the runs given it since — the stretch an
 * unused agent skill goes stale over. Counted from the runs' own events.
 */
export function skillUsageText(usage: SkillUsage): string {
  if (usage.runsDelivered === 0) return "Not delivered to a run yet";
  const runs = (count: number) => `${count} ${count === 1 ? "run" : "runs"}`;
  const last = usage.lastLoadedAt === null ? "never loaded" : `last loaded ${new Date(usage.lastLoadedAt).toLocaleString()}`;
  return `Delivered to ${runs(usage.runsDelivered)}, loaded by ${runs(usage.runsLoaded)}, ${last} · ${runs(usage.deliveriesSinceLoad)} without a load since`;
}

const SKILL_STATE_TITLE: Record<SkillState, string> = {
  active: "Delivered to the agents it is attached to.",
  stale: "Given to many runs in a row and loaded by none. EO archives it if that goes on; a run loading it makes it active again.",
  archived: "Delivered to nobody. Restore a version from its history to bring it back.",
};

/** Where a skill stands (EO-720), beside the numbers that put it there. */
function SkillStateChip({ state }: { state: SkillState }) {
  const label = state === "active" ? "Active" : state === "stale" ? "Stale" : "Archived";
  return (
    <Chip tone={state === "active" ? "neutral" : "paused"} title={SKILL_STATE_TITLE[state]}>
      {label}
    </Chip>
  );
}

function SkillCard({
  skill,
  pending,
  onEdit,
  onToggle,
  onArchive,
  onLock,
  onRestored,
}: {
  skill: SkillListEntry;
  /** What a press on this row is still doing (EO-562): its buttons wait and say so. */
  pending: RowAction | undefined;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
  onLock: (locked: boolean) => void;
  onRestored: () => Promise<unknown>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <Card label={skill.name}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[16rem] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="mr-0.5 truncate text-[14px] font-medium text-ink">{skill.name}</h3>
            <code className="font-mono text-[11.5px] text-ink-subtle">{skill.slug}</code>
            {skill.archivedAt === null && !skill.enabled ? <Chip>Disabled</Chip> : null}
            {/* Who created it, and whether a person locked it (EO-714). */}
            <Chip>{skill.createdBy === "agent" ? "Written by an agent" : "Written by a person"}</Chip>
            {skill.locked ? <Chip>Locked</Chip> : null}
            {skill.disableModelInvocation ? <Chip>Not offered to the model</Chip> : null}
            <ScopeChip scope={skill.scope} />
            {skill.files.length > 0 ? (
              <Chip>
                {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
              </Chip>
            ) : null}
          </div>
          <p className="text-[12.5px] text-ink-muted">{skill.description}</p>
          {/* How it has been used (EO-715), for every skill whoever wrote it. */}
          {/* …and where that leaves it (EO-720): active, stale or archived. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <SkillStateChip state={skill.state} />
            <p className="text-[11.5px] text-ink-subtle">{skillUsageText(skill.usage)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" disabled={pending !== undefined} aria-busy={pending === "enable" || pending === "disable"} onClick={onToggle}>
            {toggleLabel(pending, skill.enabled)}
          </Button>
          {skill.archivedAt === null ? (
            <Button size="sm" variant="ghost" disabled={pending !== undefined} aria-busy={pending === "archive"} onClick={onArchive}>
              {pending === "archive" ? "Archiving…" : "Archive"}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory((shown) => !shown)}>
            {showHistory ? "Hide history" : "History"}
          </Button>
        </div>
      </div>
      <Switch
        checked={skill.locked}
        disabled={pending !== undefined}
        onChange={onLock}
        label="Locked"
        description="While it is locked, no agent can change, archive or restore this skill. You still can."
      />
      <ArchivedBy skill={skill} onRestored={onRestored} />
      {showHistory ? <SkillHistory skill={skill} onRestored={onRestored} /> : null}
      <AttachedAgents kind="skill" entryId={skill.id} entryName={skill.name} />
    </Card>
  );
}

export function SkillsPanel() {
  const queryClient = useQueryClient();
  const note = useNextDispatchNote();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Whether the archived rows are on screen (EO-192), merged with the tab the view publishes.
  useViewParameters({ filter: { text: "", facets: { archived: showArchived ? "true" : "false" } } });

  const skills = useQuery({ queryKey: skillsKey, queryFn: () => ipcQuery("skills:list", { includeArchived: true }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: skillsKey });

  const save = useMutation({
    mutationFn: (payload: IpcRequest<"skills:save">) => ipcQuery("skills:save", payload),
    onSuccess: async (result) => {
      if (!result.saved) {
        setProblem(result.problem);
        return;
      }
      setDraft(null);
      setProblem(null);
      await refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const setEnabled = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => ipcQuery("skills:setEnabled", input),
    onSuccess: async (result) => {
      if (result.problem !== null) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  const archive = useMutation({
    mutationFn: (id: string) => ipcQuery("skills:archive", { id }),
    onSuccess: async (result) => {
      if (!result.archived) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  const lock = useMutation({
    mutationFn: (input: { id: string; locked: boolean }) => ipcQuery("skills:setLocked", input),
    onSuccess: async (result) => {
      if (result.problem !== null) {
        setRowProblem(result.problem);
        return;
      }
      setRowProblem(null);
      await refresh();
    },
    onError: (error: Error) => setRowProblem(error.message),
  });

  // Per row, not the mutation's own `isPending`, which would hold every
  // row's buttons for one press; held until the list has been read again.
  const rowActions = useInFlight<string, RowAction>();
  const runRow = (id: string, action: RowAction, task: () => Promise<unknown>) => {
    // A refusal is said above the list by the mutation itself.
    void rowActions.run(id, action, task).catch(() => undefined);
  };

  const all = skills.data?.skills ?? [];
  const live = all.filter((skill) => skill.archivedAt === null);
  const archived = all.filter((skill) => skill.archivedAt !== null);
  const rows = showArchived ? [...live, ...archived] : live;

  const editor =
    draft === null ? null : (
      <SkillEditor
        draft={draft}
        onChange={setDraft}
        onCancel={() => {
          setDraft(null);
          setProblem(null);
        }}
        onSave={() => save.mutate(toSave(draft))}
        problem={problem}
        saving={save.isPending}
      />
    );
  const editingInPlace = draft?.id !== undefined && rows.some((skill) => skill.id === draft.id);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {draft === null ? (
          <Button
            icon={<Plus size={13} />}
            onClick={() => {
              setProblem(null);
              setDraft(BLANK);
            }}
          >
            New skill
          </Button>
        ) : null}
        {archived.length > 0 ? (
          <Button variant="ghost" onClick={() => setShowArchived((shown) => !shown)}>
            {showArchived ? "Hide archived" : `Show archived (${String(archived.length)})`}
          </Button>
        ) : null}
      </div>

      {rowProblem !== null ? <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{rowProblem}</p> : null}

      {editingInPlace ? null : editor}

      {skills.isLoading ? <Loading /> : null}
      {skills.error ? <ErrorLine>{skills.error.message}</ErrorLine> : null}
      {!skills.isLoading && all.length === 0 && draft === null ? (
        <EmptyState title="No skills yet.">A skill is a house playbook an agent can follow — write it once here, then tick which agents get it.</EmptyState>
      ) : null}

      {rows.map((skill) =>
        editingInPlace && draft?.id === skill.id ? (
          <div key={skill.id}>{editor}</div>
        ) : (
          <SkillCard
            key={skill.id}
            skill={skill}
            onEdit={() => {
              setProblem(null);
              setDraft(draftOf(skill));
            }}
            pending={rowActions.pending.get(skill.id)}
            onToggle={() => runRow(skill.id, skill.enabled ? "disable" : "enable", () => setEnabled.mutateAsync({ id: skill.id, enabled: !skill.enabled }))}
            onArchive={() => runRow(skill.id, "archive", () => archive.mutateAsync(skill.id))}
            onLock={(locked) => runRow(skill.id, locked ? "lock" : "unlock", () => lock.mutateAsync({ id: skill.id, locked }))}
            onRestored={refresh}
          />
        ),
      )}

      <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p>
    </div>
  );
}
