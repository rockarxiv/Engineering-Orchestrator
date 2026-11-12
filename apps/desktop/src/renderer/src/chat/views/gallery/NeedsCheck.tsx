import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Download, ExternalLink, FolderOpen, Plus, RefreshCw, X } from "lucide-react";
import { CHAT_HOME_ROUTE, GIT_WORKTREE_KIND, type GalleryNeedView, type GalleryTemplateView, type RuntimeStatusView, type SectionLock } from "@eo/core";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { galleryNeedsKey, projectsKey, repositoriesKey, useChromeVocabulary, useModules } from "../../../query/hooks";
import { useProjects, useRepositories } from "../../../query/useRepositories";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { assistRoomKey, assistThreadsKey } from "../../../shared/assist/useAssistRoom";
import { ConnectorNeeds } from "../../connectors/ConnectorNeeds";
import { ManagedLockNotice } from "../../managed/ManagedSection";
import { Button, Card, ErrorLine, Loading, TextInput, ViewHeader } from "../../kit";
import { useModuleApproval } from "../../modules/useModuleApproval";
import { Needs as ModuleNeedChips } from "../settings/org/ModulesCatalog";
import { ConnectAgentPanel, runtimeInstalled, useCodingAgents } from "../agents/ConnectAgent";
import { SignInDialog } from "../agents/SignIn";
import { GitForm } from "../settings/sections/WorkspacesSection";

/**
 * The needs check — step 5 of first run (EO-317,
 * `ARCHITECTURE.md`, "The needs check", "What a person sees first").
 *
 * One status per line — a backend signed in, a folder chosen, a
 * connector authorised, a secret set — each red line saying why and
 * carrying the one button that fixes it, in place: every fix acts here
 * and then asks the machine the question again, never patching the line
 * it acted on and never sending anybody to Settings to come back.
 *
 * Both exits are always offered: the board (or, with every line green,
 * the first item — started by the template's job where it has one, and
 * otherwise asked for by the assistant), and "Continue with Preview
 * only", which rehearses the pack with nothing real filed.
 */
export function NeedsCheck({
  template,
  projectId,
  pipelineId,
  needs: first,
  jobId: firstJob,
  onFinished,
}: {
  template: GalleryTemplateView;
  projectId: string;
  /** The board to land on. Null falls back to the project's own address. */
  pipelineId: string | null;
  /** The lines as `gallery:use` answered them, so the view draws before its first refetch. */
  needs: GalleryNeedView[];
  jobId: string | null;
  /** Called on the way out, by either exit. */
  onFinished: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const { activeProjectId, setActive } = useProjects();
  const key = galleryNeedsKey(projectId, template.slug);

  const needs = useQuery({
    queryKey: key,
    queryFn: () => ipcQuery("gallery:needs", { projectId, slug: template.slug, token: template.token }),
    initialData: { needs: first, jobId: firstJob, problem: null },
  });
  // Signing in, connecting and attaching a folder announce
  // `config:changed`, and the sign-in ends in the main process rather
  // than in a mutation here — so the view listens.
  useInvalidateOnPush("config:changed", key);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const lines = needs.data?.needs ?? [];
  const jobId = needs.data?.jobId ?? null;
  const red = lines.filter((need) => !need.met);
  const boardAddress = pipelineId === null ? "/project" : `/pipelines/${pipelineId}`;

  /** Where they are going first, and only then the flow closing behind them. */
  const leave = (to: string) => {
    void navigate(to);
    onFinished();
  };

  /** Step 6: the job fires, and the first item it files is opened to be watched. */
  const start = useMutation({
    mutationFn: () => ipcQuery("jobs:runNow", { jobId: jobId ?? "" }),
    onSuccess: (result) => leave(result.itemId === null ? boardAddress : `/items/${result.itemId}`),
  });

  /**
   * Step 6 for a template with no job (EO-664): there is no first item to
   * start, and the window has no way to make one, so the assistant asks
   * for it. A new chat whose first message is EO's brief, put on show and
   * opened as Fix with assistant opens one; its first turn is already on
   * its way.
   */
  const brief = useMutation({
    mutationFn: () => ipcQuery("gallery:openFirstItemChat", { projectId, slug: template.slug, token: template.token, pipelineId }),
    onSuccess: async (result) => {
      if (result.conversation === null) return;
      // The chat is on this project's rail (EO-765), so the window follows
      // it there; the switch reads the room and the rail again once it is
      // through, and the main process has already put this chat on show.
      if (projectId !== activeProjectId) {
        setActive(projectId);
        leave(CHAT_HOME_ROUTE);
        return;
      }
      // A read of the room begun before this is cancelled first, or it
      // would land after the write and put the old chat back.
      await queryClient.cancelQueries({ queryKey: assistRoomKey, exact: true });
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      leave(CHAT_HOME_ROUTE);
    },
  });

  /**
   * The exit for somebody who cannot get a line green: a rehearsal in
   * EO's preview project, landing on its board. The window is pointed at
   * that project first, because a board draws the project it is on.
   */
  const previewOnly = useMutation({
    mutationFn: async () => {
      const result = await ipcQuery("gallery:preview", { slug: template.slug, token: template.token });
      if (result.projectId !== null) await ipcQuery("projects:setActive", { id: result.projectId });
      return result;
    },
    onSuccess: (result) => {
      if (result.problem !== null) return;
      leave(result.pipelineId === null ? "/project" : `/pipelines/${result.pipelineId}`);
      // After the navigation: everything project-scoped is asked again.
      void queryClient.invalidateQueries();
    },
  });

  const greenThroughout = red.length === 0;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        title={`${template.title} is set up`}
        meta={
          greenThroughout
            ? "Everything it needs is here."
            : `${red.length} thing${red.length === 1 ? "" : "s"} left before real work runs. Each one says why, and carries the one button that fixes it.`
        }
      />

      <Card label="What this needs" className="gap-0 py-1.5">
        <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {lines.map((need) => (
            <li key={need.key}>
              <NeedRow need={need} projectId={projectId} template={template} onFixed={refresh} />
            </li>
          ))}
        </ul>
      </Card>

      {needs.data?.problem ? <ErrorLine>{needs.data.problem}</ErrorLine> : null}
      {previewOnly.data?.problem ? <ErrorLine>{previewOnly.data.problem}</ErrorLine> : null}
      {start.data?.problem ? <ErrorLine>{start.data.problem}</ErrorLine> : null}
      {brief.data?.problem ? <ErrorLine>{brief.data.problem}</ErrorLine> : null}
      {brief.error ? <ErrorLine>{brief.error instanceof Error ? brief.error.message : String(brief.error)}</ErrorLine> : null}

      <div className="flex flex-wrap items-center gap-2">
        {jobId !== null && greenThroughout ? (
          <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
            Start the first {vocabulary.item.toLowerCase()}
          </Button>
        ) : greenThroughout ? (
          <Button variant="primary" disabled={brief.isPending} onClick={() => brief.mutate()}>
            Plan the first {vocabulary.item.toLowerCase()} with the assistant
          </Button>
        ) : (
          <Button variant="primary" onClick={() => leave(boardAddress)}>
            Go to the board
          </Button>
        )}
        {/* The quiet way out beside the loud way on: it costs nothing and creates nothing real. */}
        {template.previewable ? (
          <Button disabled={previewOnly.isPending} onClick={() => previewOnly.mutate()}>
            Continue with Preview only
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One line: the status, the sentence, why it is red, and the one button. */
function NeedRow({ need, projectId, template, onFixed }: { need: GalleryNeedView; projectId: string; template: GalleryTemplateView; onFixed: () => Promise<unknown> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2.5">
      <div className="flex items-start gap-2.5">
        {need.met ? (
          <Check size={14} aria-label="Ready" className="mt-[3px] shrink-0 text-running" />
        ) : (
          <X size={14} aria-label="Not ready" className="mt-[3px] shrink-0 text-danger" />
        )}
        <span className={need.met ? "text-[13px] text-ink-muted" : "text-[13px] text-ink"}>{need.line}</span>
      </div>
      {/* In the words of whatever decided it — never composed here. */}
      {need.why === null ? null : <p className="pl-6 text-[12.5px] leading-snug text-danger">{need.why}</p>}
      {/* What the line counts — each repository, by name, with its own status and reason (EO-662). */}
      {need.parts === undefined || need.parts.length === 0 ? null : (
        <ul aria-label={`What "${need.line}" counts`} className="flex flex-col gap-1 pl-6">
          {need.parts.map((part) => (
            <li key={part.key} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-start gap-2">
                {part.met ? (
                  <Check size={12} aria-label="Ready" className="mt-[3px] shrink-0 text-running" />
                ) : (
                  <X size={12} aria-label="Not ready" className="mt-[3px] shrink-0 text-danger" />
                )}
                <span className="text-[12.5px] text-ink-muted">{part.line}</span>
              </span>
              {part.why === null ? null : <p className="pl-5 text-[12px] leading-snug text-danger">{part.why}</p>}
            </li>
          ))}
        </ul>
      )}
      {/* A green line carries a button only where it offers more of the same — another repository. */}
      {need.fix === null || (need.met && need.fix.kind !== "addRepository") ? null : <Fix need={need} projectId={projectId} template={template} onFixed={onFixed} />}
    </div>
  );
}

function Fix({ need, projectId, template, onFixed }: { need: GalleryNeedView; projectId: string; template: GalleryTemplateView; onFixed: () => Promise<unknown> }) {
  const fix = need.fix;
  if (fix === null) return null;
  /** Every other fix is told only that it is done; Check again waits on the reading. */
  const done = () => void onFixed();
  if (fix.kind === "folder" || fix.kind === "repository") {
    return <WorkspaceFix label={fix.label} kind={fix.kind} path={fix.target ?? ""} projectId={projectId} onFixed={done} />;
  }
  if (fix.kind === "addRepository") return <AddRepositoryFix label={fix.label} projectId={projectId} onFixed={done} />;
  if (fix.kind === "backend") return <BackendFix label={fix.label} backend={fix.target} onFixed={done} />;
  if (fix.kind === "connector") return <ConnectorFix label={fix.label} server={fix.target} onFixed={done} />;
  if (fix.kind === "secret") return <SecretFix label={fix.label} name={fix.target ?? ""} onFixed={done} />;
  if (fix.kind === "module") return <ModuleFix label={fix.label} moduleId={fix.target ?? ""} onFixed={done} />;
  if (fix.kind === "forge") return <ForgeFix label={fix.label} link={fix.link ?? null} onCheck={onFixed} />;
  if (fix.kind === "forgeKind") return <ForgeKindFix repositoryId={fix.target ?? ""} onFixed={done} />;
  if (fix.kind === "assistant") return <AssistantFix label={fix.label} backend={fix.target ?? ""} onFixed={done} />;
  return <RoleFix label={fix.label} role={fix.target ?? ""} template={template} onFixed={done} />;
}

/**
 * Staffing a role from here (ARCHITECTURE.md, "The needs check"): the main process points the agent
 * the
 * import wrote at a backend this machine is signed in to, or refuses.
 *
 * A lock is drawn as the lock every other view draws, never as red text:
 * a section somebody else manages is not something the person did wrong.
 * The button stays offered while locked, because the same press *binds*
 * a published agent, which stays the person's.
 */
function RoleFix({ label, role, template, onFixed }: { label: string; role: string; template: GalleryTemplateView; onFixed: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [locked, setLocked] = useState<SectionLock | null>(null);
  const staff = useMutation({
    mutationFn: () => ipcQuery("gallery:staffRole", { slug: template.slug, token: template.token, role }),
    onSuccess: (result) => {
      setLocked(result.locked);
      setProblem(result.locked === null ? result.problem : null);
      if (result.ok) onFixed();
    },
    onError: (error: Error) => {
      setLocked(null);
      setProblem(error.message);
    },
  });

  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div>
        <Button size="sm" disabled={staff.isPending} onClick={() => staff.mutate()}>
          {label}
        </Button>
      </div>
      {locked === null ? null : <ManagedLockNotice lock={locked} />}
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}

/**
 * The assistant pointed at a signed-in backend and switched on (EO-664),
 * for a template whose first item the assistant asks for. Only on this
 * press; the main process refuses with a sentence where it cannot.
 */
function AssistantFix({ label, backend, onFixed }: { label: string; backend: string; onFixed: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const staff = useMutation({
    mutationFn: () => ipcQuery("gallery:staffAssistant", { backend }),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.ok) onFixed();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div>
        <Button size="sm" disabled={staff.isPending} onClick={() => staff.mutate()}>
          {label}
        </Button>
      </div>
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}

/**
 * The folder or the repository, chosen or typed (ARCHITECTURE.md, "The needs check"). Choosing *is*
 * the answer; typing is for a pasted path and for a server, where there
 * is no dialog to open (EO-319).
 */
function WorkspaceFix({ label, kind, path, projectId, onFixed }: { label: string; kind: "folder" | "repository"; path: string; projectId: string; onFixed: () => void }) {
  const [typed, setTyped] = useState(path);
  const [problem, setProblem] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (chosen: string) => ipcQuery("gallery:attachWorkspace", { projectId, path: chosen, kind: kind === "repository" ? "git" : "folder" }),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.ok) onFixed();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const pick = useMutation({
    mutationFn: () => ipcQuery("dialog:pickDirectory", { title: label }),
    onSuccess: (result) => {
      if (!result.path) return;
      setTyped(result.path);
      attach.mutate(result.path);
    },
  });

  const field = kind === "repository" ? "Repository path" : "Folder path";
  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TextInput aria-label={field} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={field} className="min-w-[12rem] flex-1 font-mono text-[12.5px]" />
        {machineAvailable() ? (
          <Button size="sm" icon={<FolderOpen size={12} />} disabled={pick.isPending || attach.isPending} onClick={() => pick.mutate()}>
            {label}
          </Button>
        ) : null}
        <Button size="sm" variant="primary" disabled={typed.trim() === "" || attach.isPending} onClick={() => attach.mutate(typed.trim())}>
          Save
        </Button>
      </div>
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}

/**
 * Another repository on the project, once one works (EO-662) — the way
 * Settings → Projects adds one: the same repository form and
 * `workspaces:create` for a checkout EO does not have yet, and
 * `projects:addProject` for one it already holds on another project.
 */
function AddRepositoryFix({ label, projectId, onFixed }: { label: string; projectId: string; onFixed: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { repositories } = useRepositories();
  const { projects } = useProjects();
  const onProject = new Set<string>(projects.find((project) => project.id === projectId)?.repositoryIds ?? []);
  const elsewhere = repositories.filter((repository) => !onProject.has(repository.id));

  const done = (result: { ok: boolean }) => {
    if (!result.ok) return;
    setOpen(false);
    for (const key of [repositoriesKey, projectsKey]) void queryClient.invalidateQueries({ queryKey: key });
    onFixed();
  };
  const create = useMutation({
    mutationFn: (config: unknown) => ipcQuery("workspaces:create", { kind: GIT_WORKTREE_KIND, projectId, config }),
    onSuccess: done,
  });
  const add = useMutation({
    mutationFn: (repositoryId: string) => ipcQuery("projects:addProject", { projectId, repositoryId }),
    onSuccess: done,
  });
  const problem = create.data?.problem ?? create.error?.message ?? add.data?.problem ?? add.error?.message ?? null;

  if (!open) {
    return (
      <div className="pl-6">
        <Button
          size="sm"
          icon={<Plus size={12} />}
          onClick={() => {
            create.reset();
            add.reset();
            setOpen(true);
          }}
        >
          {label}
        </Button>
      </div>
    );
  }
  return (
    <div role="group" aria-label={label} className="ml-6 flex min-w-0 flex-col gap-3 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <GitForm isNew busy={create.isPending} onCancel={() => setOpen(false)} onSave={(config) => create.mutate(config)} />
      {elsewhere.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-ink-subtle">Or one EO already has:</span>
          {elsewhere.map((repository) => (
            <Button key={repository.id} size="sm" variant="ghost" icon={<Plus size={11} />} disabled={add.isPending} aria-label={`Add ${repository.name}`} onClick={() => add.mutate(repository.id)}>
              {repository.name}
            </Button>
          ))}
        </div>
      ) : null}
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}

/**
 * Signing a backend in, from here (ARCHITECTURE.md, "The needs check"), with the dialog the Agents
 * view uses. A machine with no runtime installed is offered the install
 * first, in place (EO-659): the same panel first run's "Connect a coding
 * agent" step draws, since Agents → Runtimes is a screen first run hides.
 */
function BackendFix({ label, backend, onFixed }: { label: string; backend: string | null; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const { entries } = useCodingAgents();
  const installed = entries.map((entry) => entry.runtime).filter((runtime): runtime is RuntimeStatusView => runtimeInstalled(runtime));
  // The one the pack was built on where this machine has it; otherwise any signed-in backend answers the line.
  const runtime = installed.find((candidate) => candidate.id === backend) ?? installed[0] ?? null;

  if (!machineAvailable()) {
    return <p className="pl-6 text-[12.5px] text-ink-subtle">Signing a coding agent in happens on the machine that runs it, which is not this server.</p>;
  }
  if (runtime === null) {
    return (
      <div className="flex flex-col gap-2 pl-6">
        {connecting ? (
          <ConnectAgentPanel onSignedIn={onFixed} />
        ) : (
          <>
            <p className="text-[12.5px] text-ink-subtle">No coding agent is installed on this machine yet. EO ships none, and can fetch one for you.</p>
            <div>
              <Button size="sm" icon={<Download size={12} />} onClick={() => setConnecting(true)}>
                Install a coding agent
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="pl-6">
      <Button size="sm" onClick={() => setOpen(true)}>
        {label} to {runtime.label}
      </Button>
      {open ? (
        <SignInDialog
          runtime={runtime}
          open
          onOpenChange={setOpen}
          onSignedIn={() => {
            setOpen(false);
            onFixed();
          }}
        />
      ) : null}
    </div>
  );
}

/** Connecting a connector from here (ARCHITECTURE.md, "The needs check"), narrowed to the one server this line is about. */
function ConnectorFix({ label, server, onFixed }: { label: string; server: string | null; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  if (server === null) return null;
  return (
    <div className="flex flex-col pl-6">
      {open ? (
        <ConnectorNeeds role={null} servers={[server]} empty="That connector is no longer here." onChanged={onFixed} />
      ) : (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            {label}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A module, read and approved where it is needed (EO-659): its
 * description, what it needs and its code, then the approval every other
 * screen makes — `modules:approve`, which runs its tests and decides.
 * Here rather than a pointer to Settings → Modules, which first run hides.
 */
function ModuleFix({ label, moduleId, onFixed }: { label: string; moduleId: string; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  const modules = useModules();
  const approval = useModuleApproval({ onApproved: onFixed });
  const module = (modules.data?.modules ?? []).find((candidate) => candidate.id === moduleId) ?? null;

  if (!open) {
    return (
      <div className="pl-6">
        <Button size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
    );
  }
  if (module === null) {
    return <div className="pl-6">{modules.isLoading ? <Loading>Reading the module…</Loading> : <ErrorLine>That module is no longer here.</ErrorLine>}</div>;
  }
  return (
    <section aria-label={`Read ${module.name}`} className="ml-6 flex min-w-0 flex-col gap-2 rounded-[12px] bg-canvas-subtle p-3.5">
      <p className="text-[12.5px] leading-relaxed text-ink-muted">{module.description}</p>
      <ModuleNeedChips module={module} />
      <pre aria-label={`Code of ${module.name}`} className="max-h-64 overflow-auto rounded-[8px] bg-canvas p-2.5 font-mono text-[11.5px] text-ink">
        {module.code}
      </pre>
      <p className="text-[12px] leading-relaxed text-ink-subtle">
        A module runs on this machine with your permissions. Approving it runs its tests first, and approves it only if every one passes.
        Approving one is trusting whoever wrote it.
      </p>
      {approval.problem === null ? null : <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">{approval.problem}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={approval.approving} onClick={() => approval.approve(module)}>
          {approval.approving ? "Running its tests…" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" disabled={approval.approving} onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
      {approval.dialog}
    </section>
  );
}

/**
 * The forge CLI line's button (EO-663): EO does not install `gh` or
 * `glab`, so this asks `forge:detect` again — the needs check's own
 * question, read afresh — and links to where the CLI is installed from.
 */
function ForgeFix({ label, link, onCheck }: { label: string; link: { label: string; url: string } | null; onCheck: () => Promise<unknown> }) {
  const check = useMutation({ mutationFn: onCheck });
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <Button size="sm" icon={<RefreshCw size={12} />} disabled={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? "Checking…" : label}
      </Button>
      {/* `target="_blank"` reaches the window-open handler, which sends it to the real browser. */}
      {link === null ? null : (
        <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent-soft hover:underline">
          <ExternalLink size={12} />
          {link.label}
        </a>
      )}
    </div>
  );
}

/**
 * GitHub or GitLab, for a remote EO cannot place (EO-663): written to the
 * repository as Settings → Workspaces' Forge field writes it, and then the
 * line is asked again.
 */
function ForgeKindFix({ repositoryId, onFixed }: { repositoryId: string; onFixed: () => void }) {
  const choose = useMutation({
    mutationFn: (forgeKind: "github" | "gitlab") => ipcQuery("workspaces:update", { id: repositoryId, config: { forgeKind } }),
    onSuccess: (result) => {
      if (result.ok) onFixed();
    },
  });
  const problem = choose.data?.problem ?? choose.error?.message ?? null;
  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={choose.isPending} onClick={() => choose.mutate("github")}>
          It is GitHub
        </Button>
        <Button size="sm" disabled={choose.isPending} onClick={() => choose.mutate("gitlab")}>
          It is GitLab
        </Button>
      </div>
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}

/** A secret, set where it is missing. Names in, values in, nothing back. */
function SecretFix({ label, name, onFixed }: { label: string; name: string; onFixed: () => void }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => ipcQuery("moduleSecrets:set", { name, value }),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (!result.saved) return;
      setValue("");
      onFixed();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TextInput type="password" aria-label={`Value for ${name}`} value={value} onChange={(event) => setValue(event.target.value)} className="min-w-[12rem] flex-1" />
        <Button size="sm" variant="primary" disabled={value === "" || save.isPending} onClick={() => save.mutate()}>
          {label}
        </Button>
      </div>
      {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
    </div>
  );
}
