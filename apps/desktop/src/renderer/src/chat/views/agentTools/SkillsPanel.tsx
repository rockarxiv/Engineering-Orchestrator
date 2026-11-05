import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { skillMachineSpecificWarnings, type IpcRequest, type Skill, type SkillFile, type SkillScope } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { skillsKey } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { BLANK, draftOf, toSave, type SkillDraft } from "../../../shared/agentTools/skills";
import { Button, Card, Chip, EmptyState, ErrorLine, Field, IconButton, Loading, Select, TextArea, TextInput } from "../../kit";
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

function SkillCard({
  skill,
  pending,
  onEdit,
  onToggle,
  onArchive,
}: {
  skill: Skill;
  /** What a press on this row is still doing (EO-562): its buttons wait and say so. */
  pending: RowAction | undefined;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
}) {
  return (
    <Card label={skill.name}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[16rem] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="mr-0.5 truncate text-[14px] font-medium text-ink">{skill.name}</h3>
            <code className="font-mono text-[11.5px] text-ink-subtle">{skill.slug}</code>
            {skill.archivedAt !== null ? <Chip tone="paused">Archived</Chip> : skill.enabled ? null : <Chip>Disabled</Chip>}
            {skill.disableModelInvocation ? <Chip>Not offered to the model</Chip> : null}
            <ScopeChip scope={skill.scope} />
            {skill.files.length > 0 ? (
              <Chip>
                {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
              </Chip>
            ) : null}
          </div>
          <p className="text-[12.5px] text-ink-muted">{skill.description}</p>
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
        </div>
      </div>
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
          />
        ),
      )}

      <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p>
    </div>
  );
}
