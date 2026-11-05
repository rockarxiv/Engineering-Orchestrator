import { useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { JIRA_ALWAYS_SENT_FIELDS, type IpcRequest, type JiraConnectionView, type JiraFieldView, type RepositoryView } from "@eo/core";
import { cn } from "@eo/ui";
import { ipcQuery } from "../../../../query/client";
import { connectionsKey, pipelineStepsKey, repositoriesKey, settingsKey, useChromeVocabulary, usePipelines } from "../../../../query/hooks";
import { useConfiguredRepository, useProjects } from "../../../../query/useRepositories";
import { withArticle } from "../../../parts";
import { Button, CardSection, Checkbox, Chip, EmptyState, ErrorLine, Field, GroupLabel, Select, TextInput } from "../../../kit";
import { withArticleCapital } from "../../../parts";
import { RepositoryPicker } from "../core/fields";

/**
 * Jira's three panels on Settings → Connectors, in the chat layout's
 * terms: the sites EO can talk to (KAN-22), the active repository's
 * mirror (J-01, J-04, J-05), and how often edits are pulled back.
 *
 * Kept as their own cards below the connector list, as the classic screen
 * keeps them: a connector is what somebody came here for, and Jira is one
 * particular connection with a screenful of settings behind it.
 *
 * A token is typed here and never comes back: the renderer is told
 * whether one exists, never what it is (ARCHITECTURE.md, "Secrets").
 */

// ── Connections ─────────────────────────────────────────────────────

type ConnectionDraft = Omit<IpcRequest<"jiraConnections:save">, "token"> & { token: string };

function blankConnection(): ConnectionDraft {
  return { name: "", baseUrl: "", flavour: "cloud", email: "", token: "" };
}

/**
 * The Jira sites EO can talk to (KAN-22). Global rather than per
 * repository, so two repositories on one Jira share one token, entered
 * once and rotated once.
 */
export function JiraConnectionsPanel() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: connectionsKey, queryFn: () => ipcQuery("jiraConnections:list", undefined) });
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => {
    for (const key of [connectionsKey, repositoriesKey]) void queryClient.invalidateQueries({ queryKey: key });
  };

  const save = useMutation({
    mutationFn: (input: IpcRequest<"jiraConnections:save">) => ipcQuery("jiraConnections:save", input),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) {
        setDraft(null);
        refresh();
      }
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => ipcQuery("jiraConnections:remove", { id }),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) refresh();
    },
    onError: (error: Error) => setProblem(error.message),
  });

  const sites = connections.data?.connections ?? [];

  return (
    <CardSection
      title="Jira connections"
      description="A site and its token, shared by every repository that mirrors to it."
      actions={
        draft === null ? (
          <Button icon={<Plus size={13} />} onClick={() => setDraft(blankConnection())}>
            Add a Jira connection
          </Button>
        ) : null
      }
    >
      {sites.length > 0 ? (
        <ul aria-label="Jira connections" className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {sites.map((site) => (
            <ConnectionRow
              key={site.id}
              site={site}
              busy={save.isPending || remove.isPending}
              onEdit={() => setDraft({ id: site.id, name: site.name, baseUrl: site.baseUrl, flavour: site.flavour, email: site.email ?? "", token: "" })}
              onRemove={() => remove.mutate(site.id)}
            />
          ))}
        </ul>
      ) : connections.isSuccess && draft === null ? (
        <p className="text-[12.5px] text-ink-subtle">No Jira site yet.</p>
      ) : null}

      {problem !== null ? <ErrorLine>{problem}</ErrorLine> : null}

      {draft !== null ? (
        <ConnectionEditor
          draft={draft}
          busy={save.isPending}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setProblem(null);
          }}
          onSave={() => {
            const { token, ...site } = draft;
            save.mutate({
              ...site,
              email: draft.flavour === "cloud" ? draft.email : null,
              // Omitted means "keep the stored one", so renaming does not need the secret again.
              ...(token.trim() ? { token: token.trim() } : {}),
            });
          }}
        />
      ) : null}
    </CardSection>
  );
}

function ConnectionRow({ site, busy, onEdit, onRemove }: { site: JiraConnectionView; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium text-ink">{site.name}</span>
          <Chip>{site.flavour}</Chip>
          {/* Says a token exists, never what it is. Without one a repository cannot choose this site. */}
          <Chip tone={site.credentialsConfigured ? "running" : "paused"}>{site.credentialsConfigured ? "token stored" : "no token"}</Chip>
        </div>
        <span className="truncate text-[11.5px] text-ink-subtle">
          {site.baseUrl} · {site.projectCount} repository{site.projectCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function ConnectionEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ConnectionDraft;
  busy: boolean;
  onChange: (draft: ConnectionDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const cloud = draft.flavour === "cloud";
  const isNew = draft.id === undefined;

  return (
    <section aria-label={isNew ? "Add Jira connection" : `Edit ${draft.name}`} className="flex min-w-0 flex-col gap-3 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Jira URL">
          <TextInput
            value={draft.baseUrl}
            placeholder={cloud ? "https://your-team.atlassian.net" : "https://jira.your-company.com"}
            onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
          />
        </Field>
        <Field label="Kind">
          <Select value={draft.flavour} onChange={(event) => onChange({ ...draft, flavour: event.target.value === "datacenter" ? "datacenter" : "cloud" })}>
            <option value="cloud">Cloud (atlassian.net)</option>
            <option value="datacenter">Server / Data Center</option>
          </Select>
        </Field>
        <Field label="Name">
          <TextInput value={draft.name} placeholder="defaults to the host" onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </Field>
        {/* Cloud's API tokens are the password half of Basic auth with the account email; a Data Center PAT has no email. */}
        {cloud ? (
          <Field label="Email">
            <TextInput value={draft.email ?? ""} placeholder="you@your-team.com" onChange={(event) => onChange({ ...draft, email: event.target.value })} />
          </Field>
        ) : null}
      </div>
      <Field
        label={cloud ? "API token" : "Personal access token"}
        hint={
          <>
            Stored in your OS keychain, never in EO&apos;s database and never sent to the window. Every repository on this connection uses it, so
            rotating it here is enough.{" "}
            {cloud ? "Create one under Atlassian account settings → Security → API tokens." : "Create one under your Jira profile → Personal Access Tokens."}
          </>
        }
      >
        <TextInput
          type="password"
          value={draft.token}
          placeholder={isNew ? "" : "leave blank to keep the stored one"}
          onChange={(event) => onChange({ ...draft, token: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || draft.baseUrl.trim() === "" || (isNew && draft.token.trim() === "")} onClick={onSave}>
          {busy ? "Checking…" : "Save"}
        </Button>
      </div>
    </section>
  );
}

// ── The repository's mirror ─────────────────────────────────────────

/**
 * The optional Jira mirror, per repository (J-01): scoped to the active
 * project's repository, with a picker only where the project spans more
 * than one — and then naming the repository outright, because silently
 * configuring the wrong one is what the picker exists to prevent.
 */
export function JiraMirrorPanel() {
  const { repository: active, members, choose } = useConfiguredRepository();

  if (!active) {
    return (
      <CardSection title="Jira" description="Optional. Connect a repository to mirror its features and stories into Jira.">
        <p className="text-[12.5px] text-ink-muted">A Jira connection belongs to one repository. Add a repository to configure one.</p>
      </CardSection>
    );
  }

  return (
    <CardSection title="Jira" description="Optional. With no repository connected, nothing about EO behaves differently.">
      <RepositoryPicker members={members} chosen={active} onChoose={choose} />
      {/* Keyed on the repository, so switching remounts the form rather
          than showing one repository's settings under another's name. */}
      {active.jira.credentialsConfigured && active.jira.baseUrl ? <Connected key={active.id} repository={active} /> : <ConnectForm key={active.id} repository={active} />}
    </CardSection>
  );
}

/**
 * Points a repository at a site that already exists (KAN-22): only what
 * belongs to this repository — which site, which project on it, and what
 * the issue types are called there.
 */
function ConnectForm({ repository }: { repository: RepositoryView }) {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: connectionsKey, queryFn: () => ipcQuery("jiraConnections:list", undefined) });
  const usable = (connections.data?.connections ?? []).filter((site) => site.credentialsConfigured);

  const [draft, setDraft] = useState<Omit<IpcRequest<"jira:connect">, "repositoryId" | "connectionId">>({
    projectKey: "",
    featureIssueType: "Epic",
    storyIssueType: "Story",
  });
  const [connectionId, setConnectionId] = useState("");

  const connect = useMutation({
    mutationFn: (input: IpcRequest<"jira:connect">) => ipcQuery("jira:connect", input),
    onSuccess: (result) => {
      if (result.ok) void queryClient.invalidateQueries({ queryKey: repositoriesKey });
    },
  });

  // Nothing to pick from is a different problem with a different fix.
  if (usable.length === 0) {
    return (
      <EmptyState title="No Jira connection to use yet">
        Add a Jira connection first — it holds the site and the token, and several repositories can share one.
      </EmptyState>
    );
  }

  const chosen = connectionId || usable[0]!.id;

  return (
    <section aria-label="Connect to Jira" className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {/* "Site", not "connection": the panel shown once connected already has that name. */}
        <Field label="Jira site">
          <Select value={chosen} onChange={(event) => setConnectionId(event.target.value)}>
            {usable.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project key">
          <TextInput className="font-mono" value={draft.projectKey} placeholder="ACME" onChange={(event) => setDraft({ ...draft, projectKey: event.target.value.toUpperCase() })} />
        </Field>
        <Field label="Issue type for features">
          <TextInput value={draft.featureIssueType} onChange={(event) => setDraft({ ...draft, featureIssueType: event.target.value })} />
        </Field>
        <Field label="Issue type for stories">
          <TextInput value={draft.storyIssueType} onChange={(event) => setDraft({ ...draft, storyIssueType: event.target.value })} />
        </Field>
      </div>
      {connect.data?.ok === false ? <ErrorLine>{connect.data.problem}</ErrorLine> : null}
      {connect.error ? <ErrorLine>{connect.error.message}</ErrorLine> : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={connect.isPending || draft.projectKey.trim() === ""}
          onClick={() => connect.mutate({ ...draft, repositoryId: repository.id, connectionId: chosen })}
        >
          {connect.isPending ? "Checking…" : "Connect"}
        </Button>
      </div>
    </section>
  );
}

function Connected({ repository }: { repository: RepositoryView }) {
  const queryClient = useQueryClient();
  const jira = repository.jira;
  const [fields, setFields] = useState<Record<string, unknown>>(jira.fields ?? {});
  const [createByDefault, setCreateByDefault] = useState(jira.createByDefault);

  const required = useQuery({
    queryKey: ["jira", "fields", repository.id, jira.featureIssueType],
    queryFn: () => ipcQuery("jira:fields", { repositoryId: repository.id, issueType: jira.featureIssueType ?? "Epic" }),
    staleTime: Infinity,
  });

  const test = useMutation({ mutationFn: () => ipcQuery("jira:test", { repositoryId: repository.id }) });
  const save = useMutation({
    mutationFn: (input: IpcRequest<"jira:saveConfig">) => ipcQuery("jira:saveConfig", input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: repositoriesKey }),
  });
  const disconnect = useMutation({
    mutationFn: () => ipcQuery("jira:disconnect", { repositoryId: repository.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: repositoriesKey }),
  });

  // Only the required ones: Jira returns every field on the create screen.
  const mustFill = (required.data?.fields ?? []).filter((field) => field.required && !JIRA_ALWAYS_SENT_FIELDS.has(field.id));

  return (
    <section aria-label="Jira connection" className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip tone="running">connected</Chip>
        <span className="font-mono text-[12px] text-ink-muted">{jira.projectKey}</span>
        <span className="min-w-0 truncate text-[12px] text-ink-subtle">{jira.baseUrl}</span>
        <span className="text-[12px] text-ink-subtle">
          {jira.featureIssueType} / {jira.storyIssueType}
        </span>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </div>
      </div>

      {test.data ? (
        <ul aria-label="Connection check" className="flex min-w-0 flex-col gap-1 rounded-[12px] bg-canvas-subtle px-3.5 py-2.5">
          {test.data.steps.map((step) => (
            <li key={step.name} className="flex min-w-0 items-start gap-1.5 text-[12.5px]">
              {step.ok ? <Check aria-label="Passed" size={13} className="mt-0.5 shrink-0 text-running" /> : <X aria-label="Failed" size={13} className="mt-0.5 shrink-0 text-danger" />}
              <span className="shrink-0 text-ink-muted">{step.name}</span>
              <span className={cn("min-w-0 break-words", step.ok ? "text-ink-subtle" : "text-danger")}>{step.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Checkbox checked={createByDefault} onChange={setCreateByDefault} label="Create features in Jira by default" />

      <div className="flex min-w-0 flex-col gap-2">
        <GroupLabel>Required fields</GroupLabel>
        {required.data?.problem ? <p className="text-[12.5px] text-paused">{required.data.problem}</p> : null}
        {!required.data?.problem && mustFill.length === 0 ? (
          <p className="text-[12.5px] text-ink-subtle">Jira requires nothing beyond a summary and description for {jira.featureIssueType}.</p>
        ) : null}
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {mustFill.map((field) => (
            <RequiredField key={field.id} field={field} value={fields[field.id]} onChange={(value) => setFields({ ...fields, [field.id]: value })} />
          ))}
        </div>
      </div>

      {save.data?.ok === false ? <ErrorLine>{save.data.problem}</ErrorLine> : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              repositoryId: repository.id,
              fields,
              createByDefault,
              featureIssueType: jira.featureIssueType ?? "Epic",
              storyIssueType: jira.storyIssueType ?? "Story",
            })
          }
        >
          Save
        </Button>
      </div>

      <StatusMap repository={repository} />
    </section>
  );
}

/** A field Jira asks for, in the shape Jira takes: an object for anything with an id, a bare string otherwise. */
function RequiredField({ field, value, onChange }: { field: JiraFieldView; value: unknown; onChange: (value: unknown) => void }) {
  if (field.allowedValues.length > 0) {
    const selected = typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : undefined;
    return (
      <Field label={field.name}>
        <Select value={selected ?? ""} onChange={(event) => onChange(event.target.value === "" ? undefined : { id: event.target.value })}>
          <option value="">choose…</option>
          {field.allowedValues.map((option) => (
            <option key={option.id} value={option.id}>
              {option.value}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field label={field.name}>
      <TextInput value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />
    </Field>
  );
}

/**
 * Which Jira status each step means (J-04), by name, for every pipeline's
 * steps — a repository's work can be on any of them. A step left blank is
 * "Jira has no opinion about this one".
 */
function StatusMap({ repository }: { repository: RepositoryView }) {
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const [map, setMap] = useState<Record<string, string>>(repository.jira.statusMap ?? {});

  const { activeProjectId } = useProjects();
  const { pipelines } = usePipelines(activeProjectId);
  const states = useQueries({
    queries: pipelines.map((pipeline) => ({
      queryKey: pipelineStepsKey(pipeline.id),
      queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId: pipeline.id }),
    })),
  });
  const groups = pipelines.map((pipeline, index) => ({ pipeline, steps: states[index]?.data?.steps ?? [] })).filter((group) => group.steps.length > 0);
  const statuses = useQuery({
    queryKey: ["jira", "statuses", repository.id],
    queryFn: () => ipcQuery("jira:statuses", { repositoryId: repository.id }),
    staleTime: Infinity,
  });
  const outbox = useQuery({
    queryKey: ["jira", "outbox", repository.id],
    queryFn: () => ipcQuery("jira:outbox", { repositoryId: repository.id }),
    refetchInterval: 5000,
  });

  const save = useMutation({
    mutationFn: () => ipcQuery("jira:saveStatusMap", { repositoryId: repository.id, statusMap: map }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: repositoriesKey }),
  });

  return (
    <div aria-label="Jira status map" role="group" className="flex min-w-0 flex-col gap-3 border-t border-line/60 pt-4">
      <div className="flex flex-col gap-0.5">
        <GroupLabel>Status map</GroupLabel>
        <p className="text-[12.5px] text-ink-subtle">
          When {withArticle(vocabulary.item.toLowerCase())} moves here, its issue moves there. Leave a step blank and Jira is left alone for it.
        </p>
      </div>

      {statuses.data?.problem ? <p className="text-[12.5px] text-paused">{statuses.data.problem}</p> : null}

      {groups.map((group) => (
        <div key={group.pipeline.id} className="flex min-w-0 flex-col gap-2">
          {groups.length > 1 ? <h4 className="text-[12.5px] font-medium text-ink-muted">{group.pipeline.name}</h4> : null}
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {group.steps.map((state) => (
              <Field key={state.id} label={state.name}>
                <Select
                  value={map[state.id] ?? ""}
                  onChange={(event) => {
                    const next = { ...map };
                    if (event.target.value === "") delete next[state.id];
                    else next[state.id] = event.target.value;
                    setMap(next);
                  }}
                >
                  <option value="">not mirrored</option>
                  {(statuses.data?.statuses ?? []).map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        </div>
      ))}

      <TransitionFields repository={repository} />

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* A queue that is stuck should be visible, not mysterious. */}
        <span className="text-[12px] text-ink-subtle">
          {outbox.data && outbox.data.pending > 0
            ? `${outbox.data.pending} waiting to send${outbox.data.failing > 0 ? `, ${outbox.data.failing} retrying` : ""}`
            : "Nothing waiting to send."}
        </span>
        <Button className="ml-auto" size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save status map
        </Button>
      </div>
      {save.data?.ok === false ? <ErrorLine>{save.data.problem}</ErrorLine> : null}
    </div>
  );
}

/**
 * What a transition asks for, once Jira has said so (J-05). Nothing shows
 * until a push has hit the requirement: Jira only describes transitions
 * available from where an issue sits, so there is no moment at which the
 * whole picture could be fetched in advance.
 */
function TransitionFields({ repository }: { repository: RepositoryView }) {
  const queryClient = useQueryClient();
  const known = Object.entries(repository.jira.transitionFields ?? {});
  if (known.length === 0) return null;

  return (
    <div aria-label="Jira transition fields" role="group" className="flex min-w-0 flex-col gap-2">
      <GroupLabel>Transition fields</GroupLabel>
      <p className="text-[12.5px] text-ink-subtle">Jira asks for these when moving an issue into a status. Until they are filled, that move is refused.</p>
      {known.map(([status, config]) => (
        <TransitionFieldGroup
          key={status}
          repositoryId={repository.id}
          status={status}
          config={config}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: repositoriesKey })}
        />
      ))}
    </div>
  );
}

function TransitionFieldGroup({
  repositoryId,
  status,
  config,
  onSaved,
}: {
  repositoryId: string;
  status: string;
  config: NonNullable<RepositoryView["jira"]["transitionFields"]>[string];
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(config.values);
  const save = useMutation({
    mutationFn: () => ipcQuery("jira:saveTransitionFields", { repositoryId, status, values }),
    onSuccess: onSaved,
  });
  const unfilled = config.requires.filter((field) => values[field.id] === undefined);

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink">Moving to {status}</span>
        {unfilled.length > 0 ? <Chip tone="paused">{unfilled.length} to fill</Chip> : null}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {config.requires.map((field) => (
          <RequiredField key={field.id} field={{ ...field, required: true }} value={values[field.id]} onChange={(value) => setValues({ ...values, [field.id]: value })} />
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      {save.data?.ok === false ? <ErrorLine>{save.data.problem}</ErrorLine> : null}
    </div>
  );
}

// ── Pulling back ────────────────────────────────────────────────────

/**
 * Pulling comments and edits back from Jira. Blank turns it off. Status
 * is deliberately not pulled: the map is EO-to-Jira, and the engine owns
 * transitions.
 */
export function JiraSyncPanel() {
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => ipcQuery("settings:get", undefined) });
  const save = useMutation({
    mutationFn: (jiraPullMinutes: number | null) => ipcQuery("settings:set", { jiraPullMinutes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });

  const minutes = settings.data?.jiraPullMinutes;
  if (minutes === undefined) return null;

  return (
    <CardSection title="Jira sync" description="Comments and edits made in Jira are pulled back onto the project.">
      <Field
        label="Check every (minutes, blank = never)"
        hint={
          <>
            Only for repositories connected to Jira, and only reads. {`${withArticleCapital(vocabulary.item.toLowerCase())}'s`} <strong className="font-medium">Sync now</strong>{" "}
            button does the same thing immediately. Jira wins on the title and description, and what it replaced is recorded in the thread.
          </>
        }
      >
        <TextInput
          type="number"
          min={1}
          className="max-w-[10rem]"
          value={minutes ?? ""}
          onChange={(event) => save.mutate(event.target.value.trim() === "" ? null : Math.max(1, Number(event.target.value)))}
        />
      </Field>
      {save.error ? <ErrorLine>{save.error.message}</ErrorLine> : null}
    </CardSection>
  );
}

