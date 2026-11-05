import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { GIT_WORKTREE_KIND, MOVE_IS_ONE_WAY_LINE, type IpcResponse } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../../query/client";
import { itemsKey, pipelineStepsRootKey, projectsKey, repositoriesKey, useSession, workspacesKey, worktreesKey } from "../../../../query/hooks";
import { useProjects, useRepositories } from "../../../../query/useRepositories";
import { useViewParameters } from "../../../../shared/view/ViewPublisher";
import { unsavedEditsBetween } from "../../../../shared/settings/primitives";
import { Button, Card, CardSection, Chip, EmptyState, ErrorLine, Field, GroupLabel, Loading, RowList, TextInput } from "../../../kit";
import { ConfirmArchiveProject, ConfirmDeleteProject } from "../core/ProjectDialogs";
import { FieldGrid, Note } from "../core/fields";
import { useItemWords } from "../core/words";
import { ScopedSkillsLine } from "../../agentTools/skillScope";
import { ProjectAgents } from "./ProjectAgents";
import { ProjectItemTypes } from "./ProjectItemTypes";
import { MemoryPanel } from "./MemoryPanel";
import { GitForm } from "./WorkspacesSection";
import { PROJECT_NOTES_LABEL, useOpenProjectNotes } from "../../../../shared/settings/projectNotes";

type Project = IpcResponse<"projects:list">["projects"][number];

/**
 * Settings → Projects: the projects, which repositories each spans
 * (KAN-17), and adding a repository to one (EO-603), renaming, archiving,
 * restoring, deleting and moving one to the organisation's record — and,
 * read-only, the item types each one files (EO-523), which the
 * assistant's cards change.
 */
export function ProjectsSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const { repositories } = useRepositories();
  const { projects, archivedProjects, isLoading } = useProjects();
  const [draft, setDraft] = useState<{ name: string; keyPrefix: string } | null>(null);
  /** Archived projects are kept and hidden, as archived agents are (EO-347). */
  const [showArchived, setShowArchived] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The project whose Add a repository form is open. */
  const [addingTo, setAddingTo] = useState<string | null>(null);

  // The Add project form has no row behind it, so it is compared against
  // blank: what has been typed is unsaved, and an untouched form says nothing.
  useViewParameters({
    unsavedEdits:
      draft === null ? [] : unsavedEditsBetween(draft, { name: "", keyPrefix: "" }, { name: "New project name", keyPrefix: "New project key prefix" }),
  });

  const refresh = () => {
    for (const key of [projectsKey, repositoriesKey, itemsKey]) void queryClient.invalidateQueries({ queryKey: key });
  };
  const report = (result: { ok: boolean; problem: string | null }) => {
    setProblem(result.ok ? null : result.problem);
    if (result.ok) refresh();
  };

  const create = useMutation({
    mutationFn: (input: { name: string; keyPrefix: string }) => ipcQuery("projects:create", { ...input, repositoryIds: [] }),
    onSuccess: (result) => {
      report(result);
      if (result.ok) setDraft(null);
    },
  });
  const addRepository = useMutation({
    mutationFn: (input: { projectId: string; repositoryId: string }) => ipcQuery("projects:addProject", input),
    onSuccess: report,
  });
  // A new repository on the project whose button was pressed, whichever
  // one the window is showing. Refreshes what Settings → Workspaces does.
  const attachRepository = useMutation({
    mutationFn: (input: { projectId: string; config: unknown }) => ipcQuery("workspaces:create", { kind: GIT_WORKTREE_KIND, ...input }),
    onSuccess: (result) => {
      if (!result.ok) return;
      setAddingTo(null);
      for (const key of [workspacesKey, repositoriesKey, projectsKey, itemsKey, worktreesKey, pipelineStepsRootKey]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  const attachProblem = attachRepository.data?.problem ?? attachRepository.error?.message ?? null;
  const openAddRepository = (projectId: string) => {
    attachRepository.reset();
    setAddingTo(projectId);
  };
  const removeRepository = useMutation({
    mutationFn: (input: { projectId: string; repositoryId: string }) => ipcQuery("projects:removeProject", input),
    onSuccess: report,
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => ipcQuery("projects:update", input),
    onSuccess: report,
  });

  // "A project can be moved later from its settings" (EO-325). Offered
  // only while this machine is signed in: a solo desktop has no record to
  // move anything to.
  const session = useSession();
  const signedIn = session.data?.state === "signed-in";
  const move = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:moveToRecord", { projectId }),
    onSuccess: (result) => report({ ok: result.problem === null, problem: result.problem }),
  });

  // Delete (EO-346): ask the main process what it would take, show that,
  // and delete only on the person's say-so. Everything is refetched after,
  // because the project the window was showing may be the one that went.
  const [deleting, setDeleting] = useState<{
    id: string;
    name: string;
    preview: IpcResponse<"projects:delete"> | null;
    problem: string | null;
    leftover: IpcResponse<"projects:delete">["leftoverWorktrees"];
  } | null>(null);
  const askToDelete = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:delete", { projectId, confirm: false }),
    onSuccess: (preview, projectId) => setDeleting((current) => (current?.id === projectId ? { ...current, preview, problem: preview.problem } : current)),
    onError: (error, projectId) => setDeleting((current) => (current?.id === projectId ? { ...current, problem: error.message } : current)),
  });
  const confirmDelete = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:delete", { projectId, confirm: true }),
    onSuccess: (result) => {
      if (!result.deleted) {
        setDeleting((current) => (current === null ? null : { ...current, problem: result.problem ?? "EO did not delete it." }));
        return;
      }
      void queryClient.invalidateQueries();
      setDeleting((current) => (current === null || result.leftoverWorktrees.length === 0 ? null : { ...current, leftover: result.leftoverWorktrees }));
    },
    onError: (error) => setDeleting((current) => (current === null ? null : { ...current, problem: error.message })),
  });
  const openDelete = (project: { id: string; name: string }) => {
    setDeleting({ id: project.id, name: project.name, preview: null, problem: null, leftover: [] });
    askToDelete.mutate(project.id);
  };

  // Archive (EO-347): the same ask-then-confirm, the same refetch after.
  const [archiving, setArchiving] = useState<{ id: string; name: string; preview: IpcResponse<"projects:archive"> | null; problem: string | null } | null>(
    null,
  );
  const askToArchive = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:archive", { projectId, confirm: false }),
    onSuccess: (preview, projectId) => setArchiving((current) => (current?.id === projectId ? { ...current, preview, problem: preview.problem } : current)),
    onError: (error, projectId) => setArchiving((current) => (current?.id === projectId ? { ...current, problem: error.message } : current)),
  });
  const confirmArchive = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:archive", { projectId, confirm: true }),
    onSuccess: (result) => {
      if (!result.archived) {
        setArchiving((current) => (current === null ? null : { ...current, problem: result.problem ?? "EO did not archive it." }));
        return;
      }
      void queryClient.invalidateQueries();
      setArchiving(null);
    },
    onError: (error) => setArchiving((current) => (current === null ? null : { ...current, problem: error.message })),
  });
  const openArchive = (project: { id: string; name: string }) => {
    setArchiving({ id: project.id, name: project.name, preview: null, problem: null });
    askToArchive.mutate(project.id);
  };
  /** Restoring asks nothing first: it takes nothing away. */
  const restore = useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:restore", { projectId }),
    onSuccess: (result) => {
      setProblem(result.restored ? null : result.problem);
      if (result.restored) void queryClient.invalidateQueries();
    },
  });
  /** The project's own thread (EO-471), in the ordinary item view. */
  const openNotes = useOpenProjectNotes(setProblem);
  /** Preview is a rehearsal and a project mid-move keeps what it has, so neither offers to add one (EO-607). */
  const chipsOn = (project: Project) =>
    repositories.filter((repository) => project.repositoryIds.includes(repository.id) || (!project.preview && project.adoptingAt === null));

  return (
    <>
      <CardSection
        title="Projects"
        description="A project can span several repositories. One feature, work in each."
        actions={
          draft === null ? (
            <Button icon={<Plus size={13} />} onClick={() => setDraft({ name: "", keyPrefix: "" })}>
              Add a project
            </Button>
          ) : null
        }
      >
        {isLoading ? <Loading /> : null}
        {!isLoading && projects.length === 0 ? (
          <EmptyState title="No projects yet.">Add one here, or attach a repository under Workspaces — that makes a project named after it.</EmptyState>
        ) : null}
        {projects.length > 0 ? (
          <RowList label="Projects">
            {projects.map((project) => (
              <li key={project.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {/* Renameable, committed on blur (or Enter) rather than per keystroke. */}
                  <input
                    aria-label={`Rename ${project.name}`}
                    defaultValue={project.name}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next && next !== project.name) rename.mutate({ id: project.id, name: next });
                    }}
                    className="h-7 min-w-[8rem] flex-1 rounded-[8px] border border-transparent bg-transparent px-1.5 text-[13.5px] font-medium text-ink hover:border-line focus:border-line-strong focus:outline-none"
                  />
                  <Chip className="font-mono">{project.keyPrefix}</Chip>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-ink-subtle">{words.count(project.itemCount)}</span>
                  {/* Somewhere to say what belongs to the project rather
                      than to any one item (EO-471). On every project, the
                      organisation's included: the record is asked. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={openNotes.isPending}
                    aria-label={`Open ${project.name}'s project notes`}
                    onClick={() => openNotes.mutate(project.id)}
                  >
                    {PROJECT_NOTES_LABEL}
                  </Button>
                  <span className="flex shrink-0 gap-1">
                    {/* Every live project but one mid-move (EO-605), where the attach is refused, and Preview (EO-604),
                        where saving would make a new project and move the window. The record keeps its button. */}
                    {project.adoptingAt === null && !project.preview ? (
                      <Button size="sm" variant="ghost" aria-label={`Add a repository to ${project.name}`} onClick={() => openAddRepository(project.id)}>
                        Add a repository
                      </Button>
                    ) : null}
                    {/* Local projects only (EO-346, EO-347): one on the record is
                        the record's to remove, and one mid-move is about to be. */}
                    {project.managedAt === null && project.adoptingAt === null ? (
                      <>
                        <Button size="sm" variant="ghost" aria-label={`Archive ${project.name}`} onClick={() => openArchive(project)}>
                          Archive
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Delete ${project.name}`} onClick={() => openDelete(project)}>
                          Delete
                        </Button>
                      </>
                    ) : null}
                  </span>
                </div>
                {addingTo === project.id ? (
                  <div role="group" aria-label={`Add a repository to ${project.name}`} className="flex flex-col gap-3 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
                    <h3 className="text-[13px] font-medium text-ink">Add a repository to {project.name}</h3>
                    <GitForm
                      isNew
                      busy={attachRepository.isPending}
                      onCancel={() => setAddingTo(null)}
                      onSave={(config) => attachRepository.mutate({ projectId: project.id, config })}
                    />
                    {attachProblem ? <ErrorLine>{attachProblem}</ErrorLine> : null}
                  </div>
                ) : null}
                {signedIn ? <WhereItLives project={project} busy={move.isPending} onMove={() => move.mutate(project.id)} /> : null}
                {/* The skills that reach only this project's runs (EO-470). */}
                <div className="pl-1.5">
                  <ScopedSkillsLine subject={{ kind: "project", projectId: project.id }} />
                </div>
                {/* Its own agents, and who each role's work goes to (EO-475). */}
                <div className="pl-1.5">
                  <ProjectAgents projectId={project.id} />
                </div>
                {/* The kinds of item it files, read-only: the assistant's cards change them (EO-523). */}
                <div className="pl-1.5">
                  <ProjectItemTypes projectId={project.id} projectName={project.name} />
                </div>
                {/* What agents should know across the project, to read and correct (EO-481). */}
                <div className="pl-1.5">
                  <MemoryPanel scope={{ kind: "project", id: project.id }} name={project.name} />
                </div>
                {chipsOn(project).length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 pl-1.5">
                    {chipsOn(project).map((repository) => {
                      const on = project.repositoryIds.includes(repository.id);
                      return (
                        <button
                          key={repository.id}
                          type="button"
                          disabled={project.adoptingAt !== null}
                          aria-label={`${on ? "Remove" : "Add"} ${repository.name} ${on ? "from" : "to"} ${project.name}`}
                          onClick={() => (on ? removeRepository : addRepository).mutate({ projectId: project.id, repositoryId: repository.id })}
                          className={cn(
                            "inline-flex h-[24px] items-center gap-1 rounded-[7px] px-2 text-[11.5px] disabled:pointer-events-none disabled:opacity-50",
                            on ? "bg-accent-subtle text-accent-soft hover:bg-accent-subtle/70" : "bg-canvas-raised text-ink-subtle hover:text-ink",
                          )}
                        >
                          {on ? <Check aria-hidden size={11} strokeWidth={2.5} /> : <Plus aria-hidden size={11} />}
                          {repository.name}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            ))}
          </RowList>
        ) : null}

        {problem ? <ErrorLine>{problem}</ErrorLine> : null}

        {archivedProjects.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-line/60 pt-3">
            <div>
              <Button size="sm" variant="ghost" onClick={() => setShowArchived((shown) => !shown)}>
                {showArchived ? "Hide archived" : `Show archived (${String(archivedProjects.length)})`}
              </Button>
            </div>
            {showArchived ? (
              <>
                <GroupLabel>Archived</GroupLabel>
                <RowList label="Archived projects">
                  {archivedProjects.map((project) => (
                    <li key={project.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                      <span className="min-w-0 flex-1 truncate px-1.5 text-[13px] text-ink-muted">{project.name}</span>
                      <Chip className="font-mono">{project.keyPrefix}</Chip>
                      <span className="shrink-0 text-[11.5px] text-ink-subtle">Archived · {words.count(project.itemCount)}</span>
                      <span className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" disabled={restore.isPending} aria-label={`Restore ${project.name}`} onClick={() => restore.mutate(project.id)}>
                          Restore
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Delete ${project.name}`} onClick={() => openDelete(project)}>
                          Delete
                        </Button>
                      </span>
                    </li>
                  ))}
                </RowList>
              </>
            ) : null}
          </div>
        ) : null}
      </CardSection>

      {draft ? (
        <Card label="Add project">
          <h2 className="text-[14px] font-medium text-ink">Add a project</h2>
          <FieldGrid>
            <Field label="Name">
              <TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="Key prefix">
              {/* Fixed at creation: the work already carries it in its keys. */}
              <TextInput
                value={draft.keyPrefix}
                placeholder="SHOP"
                className="font-mono"
                onChange={(event) => setDraft({ ...draft, keyPrefix: event.target.value.toUpperCase() })}
              />
            </Field>
          </FieldGrid>
          <Note>The key prefix numbers this project&rsquo;s {words.many} and cannot be changed afterwards.</Note>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || draft.name.trim() === "" || draft.keyPrefix.trim() === ""}
              onClick={() => create.mutate(draft)}
            >
              Create
            </Button>
          </div>
        </Card>
      ) : null}

      {archiving !== null ? (
        <ConfirmArchiveProject
          name={archiving.name}
          preview={archiving.preview}
          busy={askToArchive.isPending || confirmArchive.isPending}
          problem={archiving.problem}
          onConfirm={() => confirmArchive.mutate(archiving.id)}
          onCancel={() => setArchiving(null)}
        />
      ) : null}
      {deleting !== null ? (
        <ConfirmDeleteProject
          name={deleting.name}
          preview={deleting.preview}
          busy={askToDelete.isPending || confirmDelete.isPending}
          problem={deleting.problem}
          leftover={deleting.leftover}
          onConfirm={() => confirmDelete.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Where a project lives (EO-325), on a signed-in desktop only: in solo
 * mode there is no record for "on this machine" to be in contrast with.
 * A moved project says so and offers nothing — there is no way back, and
 * the honest shape of that is no control plus the sentence saying why.
 */
function WhereItLives({ project, busy, onMove }: { project: Project; busy: boolean; onMove: () => void }) {
  if (project.adoptingAt !== null) {
    return <Note className="pl-1.5">Moving to the record. Nothing new will start on it until it has finished.</Note>;
  }
  if (project.managedAt !== null) {
    return <Note className="pl-1.5">On your organisation&rsquo;s record. {MOVE_IS_ONE_WAY_LINE}</Note>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 pl-1.5">
      <span className="text-[12px] text-ink-subtle">On this machine.</span>
      <Button size="sm" variant="ghost" disabled={busy} aria-label={`Move ${project.name} to the record`} onClick={onMove}>
        Move to the record
      </Button>
      <span className="text-[12px] text-ink-subtle">{MOVE_IS_ONE_WAY_LINE}</span>
    </div>
  );
}
