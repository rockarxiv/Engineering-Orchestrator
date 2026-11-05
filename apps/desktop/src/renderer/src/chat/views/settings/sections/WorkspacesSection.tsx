import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { FOLDER_KIND, GIT_WORKTREE_KIND, NONE_KIND, SCRATCH_KIND, type WorkspaceView } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { itemsKey, pipelineStepsRootKey, projectsKey, repositoriesKey, workspacesKey, worktreesKey } from "../../../../query/hooks";
import { useProjects } from "../../../../query/useRepositories";
import { useInvalidateOnPush } from "../../../../query/useInvalidateOnPush";
import { useViewParameters } from "../../../../shared/view/ViewPublisher";
import { basename, unsavedEditsBetween } from "../../../../shared/settings/primitives";
import { Button, Card, CardSection, Checkbox, Chip, EmptyState, ErrorLine, Field, Loading, RowList, Select, TextInput } from "../../../kit";
import { CheckLine, FieldGrid, Note, PathField } from "../core/fields";
import { useItemWords } from "../core/words";
import { ScopedSkillsLine } from "../../agentTools/skillScope";
import { MemoryPanel } from "./MemoryPanel";

/**
 * Settings → Workspaces (EO-301): where this project's work happens.
 *
 * Four kinds, and the kind is the first thing the Add flow asks, because
 * it decides everything after it: the git kind asks for a checkout, its
 * commands and its pull-request settings; a folder asks for a path and
 * whether each item gets a drawer of its own; scratch and no-disk ask
 * nothing at all.
 */

/** The kinds a person can attach, in the order the Add flow offers them. */
function useKinds(): { value: string; label: string; explains: string }[] {
  const words = useItemWords();
  return [
    { value: GIT_WORKTREE_KIND, label: "Repository", explains: "A git checkout on this machine. Agents work in a branch and a worktree of their own." },
    { value: FOLDER_KIND, label: "Folder", explains: "A directory that already exists — a shared drive, a folder of reports. Nothing is branched or cloned." },
    { value: SCRATCH_KIND, label: "Scratch", explains: `A fresh temporary directory per run. What it produced becomes the ${words.one}'s output, and the directory goes.` },
    { value: NONE_KIND, label: "No disk", explains: "No directory at all. The agent works through MCP servers and connectors." },
  ];
}

/** The git kind's form, as a draft: every field one of `GitWorkspaceConfig`'s, under the name it has there. */
interface GitDraft {
  name: string;
  description: string | null;
  repoPath: string;
  baseBranch: string;
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  forgeOpenPr: boolean;
  forgeKind: "github" | "gitlab" | null;
  forgeRemote: string;
  forgeDraft: boolean;
  forgeTemplatePath: string | null;
}

const BLANK_GIT: GitDraft = {
  name: "",
  description: null,
  repoPath: "",
  baseBranch: "main",
  testCommand: null,
  lintCommand: null,
  buildCommand: null,
  forgeOpenPr: false,
  forgeKind: null,
  forgeRemote: "origin",
  forgeDraft: false,
  forgeTemplatePath: null,
};

/**
 * What each field is called on screen, which is what is published as
 * typed and not saved (EO-192): the agent and the person have to be able
 * to name the same box. The same labels the classic form publishes.
 */
const GIT_FIELD_LABELS: Record<keyof GitDraft, string> = {
  name: "Name",
  description: "What this repository is",
  repoPath: "Repository path",
  baseBranch: "Base branch",
  testCommand: "test command",
  lintCommand: "lint command",
  buildCommand: "build command",
  forgeOpenPr: "Open a pull request when a story is approved",
  forgeKind: "Forge",
  forgeRemote: "Remote",
  forgeDraft: "Open it as a draft",
  forgeTemplatePath: "Template",
};

interface FolderDraft {
  path: string;
  perItemSubfolder: boolean;
}

/** Published under the project's own word, as the classic form says it on a developer project. */
function folderFieldLabels(one: string): Record<keyof FolderDraft, string> {
  return { path: "Folder path", perItemSubfolder: `A subfolder per ${one}` };
}

function gitDraftOf(workspace: WorkspaceView): GitDraft {
  return { ...BLANK_GIT, ...(workspace.config as Partial<GitDraft>) };
}

function folderDraftOf(workspace: WorkspaceView): FolderDraft {
  const config = workspace.config as Partial<FolderDraft>;
  return { path: config.path ?? "", perItemSubfolder: config.perItemSubfolder ?? false };
}

export function WorkspacesSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const kinds = useKinds();
  const { activeProjectId, projects } = useProjects();
  const onPreview = projects.some((project) => project.id === activeProjectId && project.preview);
  // Scoped to the project on screen: what a step may pick among.
  const workspaces = useQuery({
    queryKey: [...workspacesKey, activeProjectId] as const,
    queryFn: () => ipcQuery("workspaces:list", { projectId: activeProjectId }),
  });
  useInvalidateOnPush("config:changed", workspacesKey);
  useInvalidateOnPush("items:changed", workspacesKey);

  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function refresh() {
    // The step editor's workspace picker is drawn from the graph query, so
    // it is refreshed with everything else (EO-72, EO-301).
    for (const key of [workspacesKey, repositoriesKey, projectsKey, itemsKey, worktreesKey, pipelineStepsRootKey]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const create = useMutation({
    mutationFn: (input: { kind: string; config: unknown }) => ipcQuery("workspaces:create", { ...input, projectId: activeProjectId }),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) {
        setAdding(null);
        refresh();
      }
    },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; config: unknown }) => ipcQuery("workspaces:update", input),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) {
        setEditing(null);
        refresh();
      }
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipcQuery("workspaces:remove", { id }),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) refresh();
    },
  });

  const rows = workspaces.data?.workspaces ?? [];
  const kindLabel = (kind: string) => kinds.find((candidate) => candidate.value === kind)?.label ?? kind;

  return (
    <>
      <CardSection
        title="Workspaces"
        description="Where this project's work happens. A project can hold several, and a step picks among them."
        actions={
          adding === null ? (
            <Button icon={<Plus size={13} />} onClick={() => setAdding(GIT_WORKTREE_KIND)}>
              Add a workspace
            </Button>
          ) : null
        }
      >
        {workspaces.isLoading ? <Loading /> : null}
        {workspaces.isError ? <ErrorLine>EO could not list this project&rsquo;s workspaces.</ErrorLine> : null}
        {!workspaces.isLoading && rows.length === 0 && adding === null ? (
          <EmptyState title={activeProjectId === null ? "No project yet." : "Nowhere to work yet."}>
            {activeProjectId === null
              ? `Attaching a repository makes one — it is named after the repository and numbers its ${words.many}.`
              : "This project has nowhere to work yet. Every step will run with no disk until you attach one."}
          </EmptyState>
        ) : null}

        {rows.length > 0 ? (
          <RowList label="Workspaces">
            {rows.map((workspace) =>
              editing === workspace.id ? (
                <li key={workspace.id} className="py-2">
                  <WorkspaceEditor
                    workspace={workspace}
                    busy={update.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={(config) => update.mutate({ id: workspace.id, config })}
                  />
                </li>
              ) : (
                <li key={workspace.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2.5">
                  {/* The kind first: it decides what everything else on the row means. */}
                  <Chip>{kindLabel(workspace.kind)}</Chip>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] text-ink">{workspace.label}</span>
                    <span className="truncate text-[11.5px] text-ink-subtle">{workspace.summary}</span>
                  </span>
                  {/* What is wrong with it now — a drive not mounted this morning. */}
                  {workspace.problem !== null ? <Chip tone="paused">unavailable</Chip> : null}
                  <span className="shrink-0 text-[11.5px] tabular-nums text-ink-subtle">{words.count(workspace.itemCount)}</span>
                  <span className="flex shrink-0 gap-1">
                    {/* Only the kinds with something to configure: an Edit that
                        opened an empty form would be a control that does nothing. */}
                    {workspace.kind === GIT_WORKTREE_KIND || workspace.kind === FOLDER_KIND ? (
                      <Button size="sm" onClick={() => setEditing(workspace.id)}>
                        Edit
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(workspace.id)}>
                      Remove
                    </Button>
                  </span>
                  {/* The skills that reach only runs working here (EO-470). */}
                  <div className="basis-full">
                    <ScopedSkillsLine subject={{ kind: "workspace", workspaceId: workspace.id }} />
                  </div>
                  {/* What agents should know about this workspace, to read and correct (EO-481). */}
                  <div className="basis-full">
                    <MemoryPanel scope={{ kind: "workspace", id: workspace.id }} name={workspace.label} />
                  </div>
                </li>
              ),
            )}
          </RowList>
        ) : null}

        {rows.flatMap((workspace) => (workspace.problem === null ? [] : [workspace.problem])).map((line) => (
          <Note key={line} tone="danger">
            {line}
          </Note>
        ))}
        {problem ? <ErrorLine>{problem}</ErrorLine> : null}

        <Note>Removing a workspace only unlinks it from EO. The repository, the folder and everything in them are left exactly as they are.</Note>
      </CardSection>

      {adding !== null ? (
        <AddWorkspace
          kind={adding}
          kinds={kinds}
          onPreview={onPreview}
          busy={create.isPending}
          onKind={setAdding}
          onCancel={() => setAdding(null)}
          onSave={(config) => create.mutate({ kind: adding, config })}
        />
      ) : null}
    </>
  );
}

/**
 * Attaching one: the kind, then that kind's form. Changing the kind
 * replaces the form — a repository path reconsidered as a folder is not a
 * value the folder form has any use for.
 */
function AddWorkspace({
  kind,
  kinds,
  onPreview,
  busy,
  onKind,
  onCancel,
  onSave,
}: {
  kind: string;
  kinds: { value: string; label: string; explains: string }[];
  onPreview: boolean;
  busy: boolean;
  onKind: (kind: string) => void;
  onCancel: () => void;
  onSave: (config: unknown) => void;
}) {
  const chosen = kinds.find((candidate) => candidate.value === kind) ?? kinds[0]!;
  return (
    <Card label="Add workspace">
      <h2 className="text-[14px] font-medium text-ink">Add a workspace</h2>
      <div className="flex max-w-[20rem] flex-col gap-1.5">
        <Field label="Kind">
          <Select value={kind} onChange={(event) => onKind(event.target.value)}>
            {kinds.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {candidate.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Note>{chosen.explains}</Note>
      {/* A repository never joins Preview (EO-603), and moving the window unannounced would come as a surprise. */}
      {kind === GIT_WORKTREE_KIND && onPreview ? <Note>Saving makes a new project named after this repository and switches to it.</Note> : null}

      {kind === GIT_WORKTREE_KIND ? <GitForm isNew busy={busy} onCancel={onCancel} onSave={onSave} /> : null}
      {kind === FOLDER_KIND ? <FolderForm draft={{ path: "", perItemSubfolder: false }} busy={busy} onCancel={onCancel} onSave={onSave} /> : null}
      {kind === SCRATCH_KIND || kind === NONE_KIND ? (
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[12.5px] text-ink-subtle">Nothing to configure.</span>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => onSave({})}>
            Save
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Editing one that exists. The kind is fixed: a repository that became a folder would be the same row meaning something else. */
function WorkspaceEditor({ workspace, busy, onSave, onCancel }: { workspace: WorkspaceView; busy: boolean; onSave: (config: unknown) => void; onCancel: () => void }) {
  return (
    <div role="group" aria-label={`Edit ${workspace.label}`} className="flex flex-col gap-3 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      {workspace.kind === GIT_WORKTREE_KIND ? (
        <GitForm draft={gitDraftOf(workspace)} workspaceId={workspace.id} busy={busy} onCancel={onCancel} onSave={onSave} />
      ) : (
        <FolderForm draft={folderDraftOf(workspace)} busy={busy} onCancel={onCancel} onSave={onSave} />
      )}
    </div>
  );
}

/**
 * The git kind's form, with the pull-request settings in it (EO-301). All
 * of it waits for Save: a form where some fields wait and others write
 * on blur is one where Cancel means two different things. The one
 * repository form: Settings → Projects opens it too.
 */
export function GitForm({
  draft: initial = BLANK_GIT,
  workspaceId,
  isNew = false,
  busy,
  onSave,
  onCancel,
}: {
  draft?: GitDraft;
  /** Only an attached repository can be checked against its remote. */
  workspaceId?: string;
  isNew?: boolean;
  busy: boolean;
  onSave: (config: GitDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const detect = useMutation({ mutationFn: () => ipcQuery("forge:detect", { repositoryId: workspaceId! }) });
  useViewParameters({ unsavedEdits: unsavedEditsBetween(draft, initial, GIT_FIELD_LABELS) });
  const result = detect.data;

  return (
    <>
      <FieldGrid>
        <Field label="Name">
          <TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        {/* Read when a project spans several repositories, to decide which one work belongs in. */}
        <Field label="What this repository is">
          <TextInput
            value={draft.description ?? ""}
            placeholder="the Go payments service"
            onChange={(event) => setDraft({ ...draft, description: event.target.value || null })}
          />
        </Field>
        <PathField
          label="Repository path"
          title="Choose a repository"
          value={draft.repoPath}
          placeholder="/Users/you/code/your-repository"
          onChange={(repoPath) =>
            // A freshly picked folder names the repository, unless a name
            // was already typed.
            setDraft({ ...draft, repoPath, ...(isNew && draft.name.trim() === "" ? { name: basename(repoPath) } : {}) })
          }
        />
        <Field label="Base branch">
          <TextInput value={draft.baseBranch} className="font-mono" onChange={(event) => setDraft({ ...draft, baseBranch: event.target.value })} />
        </Field>
        {(["testCommand", "lintCommand", "buildCommand"] as const).map((key) => (
          <Field key={key} label={key.replace("Command", "")}>
            <TextInput
              value={draft[key] ?? ""}
              className="font-mono"
              placeholder="not configured — skipped, not assumed to pass"
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value || null })}
            />
          </Field>
        ))}
      </FieldGrid>

      {/* Off until someone turns it on: pushing to a repository other
          people share is not something an upgrade should start doing. */}
      <div role="group" aria-label="Pull requests" className="flex flex-col gap-3 border-t border-line/60 pt-3">
        <Checkbox checked={draft.forgeOpenPr} onChange={(forgeOpenPr) => setDraft({ ...draft, forgeOpenPr })} label="Open a pull request when a story is approved" />
        {draft.forgeOpenPr ? (
          <>
            <FieldGrid>
              <Field label="Forge">
                <Select value={draft.forgeKind ?? ""} onChange={(event) => setDraft({ ...draft, forgeKind: (event.target.value || null) as GitDraft["forgeKind"] })}>
                  <option value="">detect from the remote</option>
                  <option value="github">GitHub (gh)</option>
                  <option value="gitlab">GitLab (glab)</option>
                </Select>
              </Field>
              <Field label="Remote">
                <TextInput value={draft.forgeRemote} className="font-mono" onChange={(event) => setDraft({ ...draft, forgeRemote: event.target.value })} />
              </Field>
              <Field label="Template (blank = find it)">
                <TextInput
                  value={draft.forgeTemplatePath ?? ""}
                  className="font-mono"
                  placeholder=".github/PULL_REQUEST_TEMPLATE/bug_fix.md"
                  onChange={(event) => setDraft({ ...draft, forgeTemplatePath: event.target.value || null })}
                />
              </Field>
              <div className="flex items-end pb-1.5">
                <Checkbox checked={draft.forgeDraft} onChange={(forgeDraft) => setDraft({ ...draft, forgeDraft })} label="Open it as a draft" />
              </div>
            </FieldGrid>
            {/* Only for a repository already attached: the check asks git
                about a remote, and an unsaved path is nothing EO can look at. */}
            {workspaceId !== undefined ? (
              <div className="flex min-w-0 items-center gap-2">
                <Button size="sm" disabled={detect.isPending} onClick={() => detect.mutate()}>
                  {detect.isPending ? "Checking…" : "Check"}
                </Button>
                {result ? <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-subtle">{result.remoteUrl}</span> : null}
              </div>
            ) : null}
            {result ? (
              <ul aria-label="Forge check" className="flex flex-col gap-1">
                <CheckLine ok={result.kind !== null} name="Forge" detail={result.kind ?? "unknown"} />
                <CheckLine ok={result.cliInstalled} name="CLI" detail={result.cliInstalled ? "installed" : "not installed"} />
                <CheckLine ok={result.authenticated} name="Signed in" detail={result.authenticated ? "yes" : "no"} />
                <CheckLine ok name="Template" detail={result.templatePath ?? "none — the reviewer will write a description"} />
              </ul>
            ) : null}
            {result?.problem ? <ErrorLine>{result.problem}</ErrorLine> : null}
            <Note>EO pushes the branch and opens the request. It never merges, and never force-pushes.</Note>
          </>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || draft.name.trim() === "" || draft.repoPath.trim() === ""} onClick={() => onSave(draft)}>
          Save
        </Button>
      </div>
    </>
  );
}

/**
 * The folder kind's form: a path and one choice. `perItemSubfolder` is
 * the difference between a team's drive and one item's drawer in it, off
 * by default because the folder attached is the folder meant.
 */
function FolderForm({ draft: initial, busy, onSave, onCancel }: { draft: FolderDraft; busy: boolean; onSave: (config: FolderDraft) => void; onCancel: () => void }) {
  const words = useItemWords();
  const [draft, setDraft] = useState(initial);
  useViewParameters({ unsavedEdits: unsavedEditsBetween(draft, initial, folderFieldLabels(words.one)) });

  return (
    <>
      <PathField label="Folder path" title="Choose a folder" value={draft.path} placeholder="/Users/you/Documents/reports" onChange={(path) => setDraft({ ...draft, path })} />
      <Checkbox
        checked={draft.perItemSubfolder}
        onChange={(perItemSubfolder) => setDraft({ ...draft, perItemSubfolder })}
        label={`Give each ${words.one} a subfolder of its own`}
      />
      <Note>
        The folder has to exist already — EO never creates it. A path that is not there is usually a typo, and a folder made to match one is a folder nobody
        will look in.
      </Note>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || draft.path.trim() === ""} onClick={() => onSave(draft)}>
          Save
        </Button>
      </div>
    </>
  );
}
