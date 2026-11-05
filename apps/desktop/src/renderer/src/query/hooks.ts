import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chromeVocabulary,
  emptyRegistry,
  fromRegistryView,
  NO_POLICY,
  PipelineTemplateStatusSchema,
  SECTION_LOCK_TEXT,
  type ChromeVocabulary,
  type IpcRequest,
  type IpcResponse,
  type PublishedSection,
  type RegistryFacts,
} from "@eo/core";
import { machineAvailable } from "../ipc/bridge";
import { ipcQuery } from "./client";
import { useInvalidateOnPush } from "./useInvalidateOnPush";

export const itemsKey = ["items"] as const;
/**
 * What is waiting on somebody (`inbox:list`). One key for the rail's
 * count, the home screen, the board's paused rail and the inbox itself,
 * so one push listener on it serves all of them (EO-560).
 */
export const inboxKey = ["inbox"] as const;
/**
 * The prefix every pipeline's steps hang off, so all of them can be
 * invalidated at once (EO-72).
 *
 * `pipelineSteps:list` carries `elsewhere` — the hand-off targets the
 * editor's picker offers — and the main process scopes those to the
 * *active* project when the pipeline being edited belongs to none. So
 * switching project changes the answer for a pipeline nobody edited, and
 * the switch does not know which pipeline's steps are cached: the screen
 * that is open may be any of them.
 */
export const pipelineStepsRootKey = ["pipeline"] as const;
/**
 * Steps are per pipeline now, so the key has to say which (KAN-59).
 *
 * A bare ["pipelineSteps"] could only ever cache one pipeline's columns,
 * and switching pipelines would show the previous one's until a refetch.
 */
export const pipelineStepsKey = (pipelineId: string) => [...pipelineStepsRootKey, pipelineId, "steps"] as const;
export const pipelinesKey = (projectId: string | null) => ["pipelines", projectId] as const;
/**
 * The jobs of one project, and one job with its history (EO-308).
 *
 * Keyed by project for `pipelinesKey`'s reason: a job belongs to a
 * project, and a bare key would serve one project's list on another's
 * screen until a refetch. The single job hangs off the same root so that
 * saving an edit can invalidate the list and the page at once — its next
 * run is what the list shows, and the two disagreeing would be the page
 * saying 09:00 while the rail behind it still said 08:00.
 */
export const jobsRootKey = ["jobs"] as const;
export const jobsKey = (projectId: string | null) => [...jobsRootKey, projectId] as const;
export const jobKey = (jobId: string) => [...jobsRootKey, "one", jobId] as const;
export const agentsKey = ["agents"] as const;
export const worktreesKey = ["worktrees"] as const;
export const repositoriesKey = ["repositories"] as const;
/**
 * Every kind of disk, where `repositoriesKey` above is the one kind
 * (EO-301).
 *
 * A root key rather than a leaf: the Workspaces screen asks per project,
 * so the cached answer is `[...workspacesKey, projectId]` and an
 * invalidation of the root covers every project's — which is what a
 * `config:changed` push means, since attaching a repository can create
 * the project it lands in.
 */
/**
 * The gallery (EO-316).
 *
 * Unscoped, unlike `pipelinesKey`: what templates exist is a property of
 * the installation and the network rather than of the project somebody
 * happens to be looking at, and the "what this needs" lines on a card
 * are refreshed by `config:changed` like every other derived list.
 */
export const galleryKey = ["gallery"] as const;
/**
 * The needs check's lines, for one project and one pack (EO-317).
 *
 * Under the gallery's root so that a `config:changed` push — which is
 * what attaching a folder, signing in and connecting a connector all
 * emit — refreshes the card's "what this needs" and the needs check
 * together. They are the same sentences read in two places, and the one
 * that went stale would be whichever the person was not looking at.
 */
export const galleryNeedsKey = (projectId: string, slug: string) => [...galleryKey, "needs", projectId, slug] as const;
/** Whether first run is behind this installation, and which mode it answered (EO-317). */
export const firstRunKey = ["firstRun"] as const;

export const workspacesKey = ["workspaces"] as const;
export const projectsKey = ["projects"] as const;
export const connectionsKey = ["jiraConnections"] as const;
/**
 * The module catalog (KAN-103).
 *
 * Not keyed by pipeline, unlike `pipelineStepsKey`, and that is the whole
 * point of a catalog: a module is written once and used from any number
 * of pipelines, so scoping it to one would cache the same rows under
 * several keys and let them disagree.
 */
export const modulesKey = ["modules"] as const;
/**
 * One module's test cases (EO-354), under the catalog's root so that
 * anything refreshing the catalog — a push, a save, a run — refreshes
 * the cases with it. A case and the run that judged it disagreeing on
 * screen is the one thing a test list must not do.
 */
export const moduleTestsKey = (moduleId: string) => [...modulesKey, "tests", moduleId] as const;
/**
 * One module's kept versions (EO-361), under the catalog's root for
 * `moduleTestsKey`'s reason: a save or a restore files a version, and
 * the history beside the card has to follow it without being told.
 */
export const moduleVersionsKey = (moduleId: string) => [...modulesKey, "versions", moduleId] as const;
/** One version whole — its code, manifest and cases. */
export const moduleVersionKey = (moduleId: string, number: number) => [...moduleVersionsKey(moduleId), number] as const;
/**
 * Which module secrets are set. Names only — a value never crosses IPC (KAN-105).
 *
 * Keyed by step, because a step can override a shared value: caching one
 * step's answer under the same key as another's would show the wrong one
 * the moment two module steps are open in a session.
 */
export const moduleSecretsRootKey = ["moduleSecrets"] as const;
export const moduleSecretsKey = (stepId: string | null = null) => [...moduleSecretsRootKey, stepId] as const;
/**
 * The environment variables (EO-486): values that are not secret, so the
 * list carries each one. Keyed by step for the reason module secrets are —
 * a step's list holds the shared values too, beside its own.
 */
export const environmentVariablesRootKey = ["environmentVariables"] as const;
export const environmentVariablesKey = (stepId: string | null = null) => [...environmentVariablesRootKey, stepId] as const;
/**
 * The two catalogues an agent's tool surface is drawn from (EO-104,
 * EO-105).
 *
 * Not keyed by agent, for the reason `modulesKey` is not keyed by
 * pipeline: a server is defined once and ticked onto any number of
 * agents, so scoping either catalogue to one would cache the same rows
 * under several keys and let them disagree.
 *
 * Both are fetched with `includeArchived: true` wherever they are asked
 * for, so there is one cached answer rather than two that differ by a
 * flag — an archived entry an agent still holds has to stay visible for
 * that agent to be able to take it off.
 */
export const mcpServersKey = ["mcpServers"] as const;
export const skillsKey = ["skills"] as const;
/**
 * Which agent has been given what, out of those two (EO-106).
 *
 * Every agent's, in one entry, deliberately. `agentAttachments:list`
 * takes an optional agent, and caching per agent would put the catalogue
 * screen's question ("which agents have this server?") and the agent
 * editor's ("which servers does this agent have?") in two entries
 * describing the same rows — so a tick made in one place would leave the
 * other showing what it believed beforehand. It is one row per agent
 * that has anything, which is not a size worth splitting.
 */
export const agentAttachmentsKey = ["agentAttachments"] as const;
/**
 * The connectors this installation has, and whether each is connected
 * (EO-315).
 *
 * Keyed by the role it was narrowed to, unlike `mcpServersKey` above: a
 * step editor asks what one role reaches and Settings asks what the
 * installation has, and those are genuinely different answers to the
 * same channel rather than one answer plus a flag. The root is what a
 * connect invalidates, so a red line goes green on every screen at once
 * without a mutation having to know which of them is open.
 */
export const connectorsRootKey = ["connectors"] as const;
export const connectorsKey = (role: string | null) => [...connectorsRootKey, role] as const;
/** Shared: the inbox owns Do Not Disturb, Settings owns the archive delay (KAN-33). */
export const settingsKey = ["settings"] as const;
/**
 * What roles, built-in functions and item types this installation knows
 * about (KAN-124). One entry for the whole app: it is a property of the
 * running main process, not of any screen.
 */
export const registryKey = ["registry"] as const;
/**
 * Shared: Settings edits the guardrails, the pipeline editor reads the run
 * timeout to state the bound on a step's own time limit (EO-162).
 *
 * One key so the second screen sees a change made on the first without a
 * reload — the bound it prints has to be the bound that will be enforced,
 * or it advertises a number that gets the publish refused.
 */
/**
 * The project's item types, as the configure screen's Types section
 * edits them (KAN-164).
 *
 * Keyed by the project for the reason the registry is: `item_types`
 * holds a row per project, so one entry for the app would be one
 * project's answer served to the next.
 */
export const itemTypesKey = (projectId: string | null) => ["itemTypes", projectId] as const;

export const guardsKey = ["guards"] as const;

/**
 * The organisation's list: everybody EO can name, and every group
 * (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * One entry for the app, like the registry and for the same reason: it
 * is a property of the record this installation is working against
 * rather than of any one screen. Three screens read it — the admin's
 * People section, the group editor beside it, and the picker on a human
 * step's column head — and a change made on any of them has to reach the
 * other two, which is what one key buys.
 */
export const peopleKey = ["people"] as const;

/** The machines signed in to this organisation, for the admin's Devices list. */
export const devicesKey = ["devices"] as const;

/** Where this desktop stands: signed in, signed out, or turned out by its organisation. */
export const sessionKey = ["session"] as const;

/** How this machine is getting on with its organisation's record. */
export const syncKey = ["sync"] as const;

/**
 * This machine's sign-in, kept honest by the push (EO-323).
 *
 * The subscription is the whole reason this is a hook rather than a
 * `useQuery` at each of its two call sites. Every other state in EO
 * changes because somebody asked for it; a revocation does not. It is
 * discovered by the main process when some unrelated request comes back
 * 401 — and that request then succeeds anyway, because `people:list`
 * falls back to this machine's own rows — so without a push the window
 * would go on rendering a signed-in session until somebody happened to
 * reload it. Two surfaces show the sentence, the banner and the
 * Organisation section, and both have to hear it; one hook is how
 * neither can be the one that forgot to subscribe.
 *
 * `enabled` on `machineAvailable`, because `session:*` is the machine
 * half: a browser served by an organisation server would be asking the
 * record whether the record is signed in to itself, and be refused at
 * its own door.
 */
/**
 * The module catalog, kept current by the push (EO-354).
 *
 * A hook rather than a `useQuery` at each screen because one screen
 * missing the subscription is exactly the bug it exists to prevent. A
 * module's tests re-run in the background after a save, and the run
 * ends with `config:changed` — so the "Not fully tested" marker on the
 * configuration screen, in the step inspector and on the board goes the
 * moment the tests pass the bar, without anybody reloading anything.
 */
export function useModules() {
  const modules = useQuery({ queryKey: modulesKey, queryFn: () => ipcQuery("modules:list", {}) });
  useInvalidateOnPush("config:changed", modulesKey);
  return modules;
}

/**
 * The catalog with the deleted modules in it (EO-398).
 *
 * For a card that names one module and has to say what became of it: a
 * module somebody deleted is absent from `useModules`, and "deleted" and
 * "not loaded yet" must not look alike. Under the catalog's root, so every
 * save, approval and push that refreshes the list refreshes this with it.
 */
export function useModulesWithDeleted() {
  const modules = useQuery({ queryKey: [...modulesKey, "withDeleted"], queryFn: () => ipcQuery("modules:list", { includeArchived: true }) });
  useInvalidateOnPush("config:changed", modulesKey);
  return modules;
}

export function useSession() {
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: () => ipcQuery("session:status", undefined),
    enabled: machineAvailable(),
  });
  useInvalidateOnPush("config:changed", sessionKey);
  return session;
}

/**
 * The link to the record: online, offline since when, and what is
 * queued behind it (EO-324, `ARCHITECTURE.md`, "The record").
 *
 * Subscribed to both pushes, because the two halves of what it reports
 * move for different reasons. `config:changed` is the link itself —
 * signing in, signing out, the first request that failed, the first one
 * that worked again. `items:changed` is the queue — a move made offline
 * adds to it and a reconnect empties it, and both of those are things a
 * board is already being told about.
 *
 * `enabled` on `machineAvailable` for `useSession`'s reason and its
 * own: a server *is* the record, so a browser served by one asking how
 * it is getting on with the record would be asking about nothing, and
 * is refused at its own door by name.
 */
export function useSyncStatus() {
  const sync = useQuery({
    queryKey: syncKey,
    queryFn: () => ipcQuery("sync:status", undefined),
    enabled: machineAvailable(),
  });
  useInvalidateOnPush("config:changed", syncKey);
  useInvalidateOnPush("items:changed", syncKey);
  return sync;
}

/**
 * Everybody and every group, with the change pushed to whoever is open.
 *
 * `config:changed` rather than a key of its own: naming somebody on a
 * step is a configuration change, and the board's column heads and this
 * list have to agree about who waits where.
 */
export function usePeople() {
  const people = useQuery({ queryKey: peopleKey, queryFn: () => ipcQuery("people:list", undefined) });
  useInvalidateOnPush("config:changed", peopleKey);
  return {
    people: people.data?.people ?? [],
    groups: people.data?.groups ?? [],
    /** Whether these came from an organisation server or from this machine's own rows. */
    fromServer: people.data?.fromServer ?? false,
    isLoading: people.isLoading,
  };
}

/** What the organisation published, and so what is locked here (EO-329). */
export const sectionsKey = ["sections"] as const;

/**
 * Which of the five configuration sections this installation may not
 * edit (EO-329, `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * One hook for every locked screen, for `useSession`'s reason: the
 * answer changes without anybody on this machine asking. A publish
 * lands on the next sync — the pull that applies it emits
 * `config:changed`, which is the same push the pipeline and the agents
 * already redraw on — and a screen that read this once at mount would
 * go on offering a Publish button for a section that had just become
 * somebody else's.
 *
 * `locked` is derived on the main side and never stored (invariant #6's
 * argument, one subject over): the rows say a section was published and
 * the installation says whether that binds here, so a server's own
 * admin, who publishes these very rows, is answered with an empty list.
 *
 * `lockText` comes down the wire rather than being imported, so that
 * the one sentence the design writes cannot be spelled differently by a
 * screen than by the main process that refuses the write.
 */
export function useLockedSections() {
  const sections = useQuery({ queryKey: sectionsKey, queryFn: () => ipcQuery("sections:list", undefined) });
  useInvalidateOnPush("config:changed", sectionsKey);
  return {
    published: sections.data?.published ?? [],
    locked: sections.data?.locked ?? [],
    lockText: sections.data?.lockText ?? SECTION_LOCK_TEXT,
    isLocked: (section: PublishedSection) => (sections.data?.locked ?? []).includes(section),
    isLoading: sections.isLoading,
  };
}

/** Whether this machine's copy of a pipeline is its own (EO-331, ARCHITECTURE.md, "Divergence and suggestions"). */
export const divergenceKey = (pipelineId: string) => ["pipeline-divergence", pipelineId] as const;

/**
 * Whether this machine has edited a pipeline its organisation manages
 * (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Two screens read it and must agree: the configure screen, where the
 * lock becomes "Edited locally · based on v6 · v7 available" with three
 * actions, and the board's header, where it is a chip. One hook, one
 * answer — a board saying "diverged" beside a configure screen showing
 * a lock would be the app disagreeing with itself about whose pipeline
 * it is.
 *
 * On `config:changed` for `useLockedSections`' reason and one more of
 * its own: the *available* half of that line is what an organisation
 * published while somebody was editing, and it arrives on a sync.
 */
export function useDivergence(pipelineId: string | null) {
  const answer = useQuery({
    queryKey: divergenceKey(pipelineId ?? ""),
    queryFn: () => ipcQuery("pipelines:divergence", { pipelineId: pipelineId as string }),
    enabled: pipelineId !== null,
  });
  useInvalidateOnPush("config:changed", divergenceKey(pipelineId ?? ""));
  return {
    diverged: answer.data?.diverged ?? false,
    basedOn: answer.data?.basedOn ?? null,
    available: answer.data?.available ?? null,
    line: answer.data?.line ?? null,
    isLoading: answer.isLoading,
  };
}

/** Where a pipeline came from and whether its template has news for it (EO-536). */
export const templateStatusKey = (pipelineId: string) => ["pipeline-template-status", pipelineId] as const;

/**
 * A pipeline's template origin and update state (EO-536, ARCHITECTURE.md,
 * "Template versions and origins"): what the head of its board and Graph
 * view says.
 *
 * Asked again on `config:changed`, which an applied update or a draft
 * published from the conflict's chat files a version under, and on
 * `items:changed`, which a conflict resolved, a notice posted or a chat
 * opened for it pushes.
 */
export function useTemplateStatus(pipelineId: string | null) {
  const answer = useQuery({
    queryKey: templateStatusKey(pipelineId ?? ""),
    queryFn: () => ipcQuery("pipeline:templateStatus", { pipelineId: pipelineId as string }),
    enabled: pipelineId !== null,
  });
  useInvalidateOnPush("config:changed", templateStatusKey(pipelineId ?? ""));
  useInvalidateOnPush("items:changed", templateStatusKey(pipelineId ?? ""));
  // Read through the schema: an answer that is not one says nothing,
  // rather than drawing half a chip.
  const parsed = PipelineTemplateStatusSchema.safeParse(answer.data);
  return parsed.success ? parsed.data : null;
}

/**
 * Who this renderer is, as whoever answers it knows them (EO-326,
 * ARCHITECTURE.md, "Identity").
 *
 * `useSession` says what *this machine* signed in as, and is switched
 * off in a browser because `session:*` is the machine half. This is the
 * question a browser can ask: it goes over the same transport as every
 * other read, and the server answers it out of the token the request
 * arrived on.
 *
 * Both exist because they answer different questions, and a screen that
 * confused them would be wrong in both places. On a desktop signed in to
 * an organisation, `useSession` names the organisation and this is the
 * local person; in a browser served by that organisation, `useSession`
 * is silent and this is the admin reading it.
 *
 * `organisation` is what the admin surface is drawn on. It is false on
 * every desktop, which is what keeps every screen below exactly as it
 * was for somebody working alone.
 */
export const meKey = ["me"] as const;

export function useMe() {
  const me = useQuery({ queryKey: meKey, queryFn: () => ipcQuery("people:me", undefined) });
  // The admin flag and the people list move together — `people:setAdmin`
  // is a configuration change — so this hears what `usePeople` hears.
  useInvalidateOnPush("config:changed", meKey);
  return {
    person: me.data?.person ?? null,
    /** May this caller see every project on the record (the design's one flag)? */
    admin: me.data?.admin ?? false,
    /** Is the thing answering a record that holds more than this caller's own work? */
    organisation: me.data?.organisation ?? false,
    isLoading: me.isLoading,
  };
}

/**
 * What the organisation allows, and what today has cost you (EO-328,
 * `ARCHITECTURE.md`, "Policy").
 *
 * A record-half read like `usePeople`, so the same hook answers on a
 * desktop and in the browser an admin opened the server's address in —
 * and on a solo desktop it answers `NO_POLICY`, which is what makes
 * every screen below draw exactly what it drew before this story.
 *
 * Invalidated on **two** pushes, because this answer has two halves that
 * change for different reasons.
 *
 * `config:changed` is the policy itself: that is what a publish emits, so
 * an admin raising the budget on one screen reaches the top bar on
 * another, and an allowed-backends list that changed while somebody had
 * the agent editor open greys the picker under them.
 *
 * `runs:changed` is the **spend**, and it was the gap. `yours` is a sum
 * over today's runs, and a run ending is what moves it — so a budget line
 * that listened only for a publish sat at the figure it had when the
 * window opened, going stale all morning while the guard behind it
 * counted the real number. A person watching "$3 of $10" while the
 * dispatch refuses their work would have no way to tell which of the two
 * was lying.
 *
 * Not `runs:progress`, which fires many times within one run: the cost is
 * written when the run ends, so the frame that carries a status is the
 * one worth re-reading on.
 */
export const policyKey = ["policy"] as const;

export function usePolicy() {
  const policy = useQuery({ queryKey: policyKey, queryFn: () => ipcQuery("policy:get", {}) });
  useInvalidateOnPush("config:changed", policyKey);
  useInvalidateOnPush("runs:changed", policyKey);
  return {
    policy: policy.data?.policy ?? NO_POLICY,
    /** Whether this came from the organisation's record rather than from the copy this machine kept (ARCHITECTURE.md, "The record"). */
    fromServer: policy.data?.fromServer ?? false,
    /**
     * Whether this caller may publish the policy, here (ARCHITECTURE.md, "Publish, lock and
     * versions").
     *
     * What the admin surface hangs off, and deliberately not
     * `fromServer`: that is true on every managed desktop and false on
     * the server, which is the opposite of where publishing happens.
     */
    mayPublish: policy.data?.mayPublish ?? false,
    /** Your own day against your own ceiling, or null where there is no ceiling to report. */
    yours: policy.data?.yours ?? null,
    isLoading: policy.isLoading,
  };
}

/**
 * Who waits at a human step (EO-323, ARCHITECTURE.md, "Identity").
 *
 * Not optimistic, for `useClaimItem`'s reason: the column head reads
 * what the main process says about the step, and a picker that moved
 * before the write landed would show a name the record does not have.
 * Both keys, because the answer is on the steps query and the picker's
 * own list is what offered it.
 */
export function useSetStepOwner(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"steps:setOwner">) => ipcQuery("steps:setOwner", input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pipelineStepsKey(pipelineId) });
      void queryClient.invalidateQueries({ queryKey: peopleKey });
    },
  });
}

/**
 * The project's data. Both queries live behind one hook so the screen
 * can't accidentally render columns without items or vice versa.
 *
 * `items` itself is kept fresh app-wide by AppShell (an item can move
 * while the project isn't even mounted). Only the config-driven pieces are
 * subscribed here: workflow states and agents change when a human edits
 * settings, not while the engine runs, so invalidating them on every
 * item movement would be pure waste.
 */
export function usePipelineData(pipelineId: string) {
  const stepsKey = pipelineStepsKey(pipelineId);
  const items = useQuery({ queryKey: itemsKey, queryFn: () => ipcQuery("items:list", undefined) });
  const steps = useQuery({ queryKey: stepsKey, queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId }) });
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });

  useInvalidateOnPush("config:changed", stepsKey);
  useInvalidateOnPush("config:changed", agentsKey);

  return {
    items: items.data?.items ?? [],
    states: steps.data?.steps ?? [],
    routes: steps.data?.routes ?? [],
    /** What work must have to enter (EO-610), or null for a pipeline that asks for nothing. */
    entrySentence: steps.data?.entrySentence ?? null,
    // The other pipelines a route out of this one may hand work to
    // (EO-69). The map needs it to tell a hand-off from a broken target.
    elsewhere: steps.data?.elsewhere ?? [],
    // What each column head says is checked, and who a human step waits
    // on (EO-312). On the same query as the steps, so a head and its
    // column are always the same answer.
    verification: steps.data?.verification ?? [],
    // Which version this pipeline is on, what is still finishing on
    // older ones, and which steps are ghosts (EO-327, ARCHITECTURE.md, "Publish, lock and
    // versions"). On the same
    // query as the columns for the reason the verification lines are:
    // the banner is a sentence *about* the board under it, and two
    // round-trips would let it say "3 items finish on v6" over a board
    // that has already drawn them somewhere else.
    version: steps.data?.version ?? null,
    finishingOn: steps.data?.finishingOn ?? [],
    ghosts: steps.data?.ghosts ?? [],
    // Where each step works (EO-301), for the Graph view's step details
    // (EO-524): the project's workspaces and the kind a step that picks
    // none inherits.
    workspaces: steps.data?.workspaces ?? [],
    workspaceKind: steps.data?.workspaceKind ?? null,
    agents: agents.data?.agents ?? [],
    isLoading: items.isLoading || steps.isLoading,
    error: items.error ?? steps.error ?? null,
  };
}

/**
 * Every item in the active project group, for the Items list.
 *
 * No subscription of its own: `items:list` is kept fresh app-wide by
 * AppShell, which is subscribed to both `items:changed` and
 * `runs:changed` on every route. Subscribing again here would invalidate
 * the same key twice per push.
 */
export function useProjectItems() {
  const query = useQuery({ queryKey: itemsKey, queryFn: () => ipcQuery("items:list", undefined) });
  return { items: query.data?.items ?? [], isLoading: query.isLoading, error: query.error ?? null };
}

/**
 * The registry, as the main process holds it short of its schemas
 * (KAN-124).
 *
 * The renderer's one way to learn which roles are built in and what a
 * builtin step can return — in place of importing the constants, which
 * agreed with the main process only because both were one build. Read
 * over `registry:get` so that a pack folded in at startup (KAN-144)
 * changes the screen's answer the moment it changes the main process's.
 *
 * Empty until the answer arrives, deliberately, rather than undefined:
 * every reader is a lookup that has a sensible answer for "no such role"
 * — not built in, so the checkbox is drawn from `config`; no such
 * function, so the result rows are not filled in — and the answer
 * arrives before anybody can have typed a role or picked a function.
 * `isLoading` is there for a screen that would rather wait.
 *
 * No push subscription: the registry changes when the app restarts with
 * a different pack, not while it runs. `staleTime: Infinity` says so —
 * the default 30s would refetch a value that cannot have moved.
 */
export function useRegistry(): { registry: RegistryFacts; isLoading: boolean } {
  // **Keyed by the project it is the registry of** (KAN-147). Roles and
  // builtins are the installation's, but item types are rows scoped to a
  // project, and `registry:get` answers for whichever one is active —
  // so one entry for the whole app was one entry for whichever project
  // happened to be open when it was first asked.
  //
  // What that cost: following an item into another project switches the
  // active one, and the detail then drew its spec editor from the
  // *previous* project's types — no editor at all for a type that
  // project never had, or the wrong pack's fields where both have the
  // word. `staleTime: Infinity` made it permanent. The project in the
  // key makes a stale answer unreadable rather than merely refreshable:
  // there is no arrangement of invalidations to get right, and a switch
  // the main process makes on its own is covered too.
  const activeProjectId = useActiveProjectId();

  // Rebuilt into maps inside the query rather than in render, so an
  // answer that is not a registry fails the query — and the screen falls
  // back to the empty one — instead of throwing out of a component.
  const query = useQuery({
    queryKey: [...registryKey, activeProjectId],
    queryFn: async () => fromRegistryView(await ipcQuery("registry:get", undefined)),
    staleTime: Infinity,
  });
  const registry = useMemo(() => query.data ?? emptyRegistry(), [query.data]);
  return { registry, isLoading: query.isLoading };
}

/**
 * What this project's chrome calls an item, and whether its rows have
 * to say what type they are (EO-309, ARCHITECTURE.md, "What a pack labels").
 *
 * Derived from the registry rather than fetched, so it costs no request
 * of its own and cannot disagree with the types the rest of the screen
 * is drawing from. `chromeVocabulary` is where the rule lives and what
 * the reasoning is written against; this is the hook that hands it the
 * project's registry.
 *
 * **The word is neutral until the registry answers**, which is one
 * frame: the empty registry has no packs in it, so a project with one
 * pack reads "Items" for as long as `registry:get` is in flight and its
 * own word after. The alternative would be guessing a pack's word
 * before knowing which pack, which is a wrong answer held confidently
 * rather than a neutral one held briefly.
 *
 * `mixed` does not do that, deliberately — it is false while the
 * registry is loading, so no row flickers a type label into existence
 * and back out again. `chromeVocabulary` says why the two differ.
 */
export function useChromeVocabulary(): ChromeVocabulary {
  const { registry } = useRegistry();
  return useMemo(() => chromeVocabulary(registry), [registry]);
}

/**
 * Which project the app is looking at, for a hook that needs it in a key.
 *
 * The same query `useProjects` runs, by the same key, so react-query
 * serves both from one request — and this file cannot import that hook,
 * which lives a layer up and imports this one.
 */
function useActiveProjectId(): string | null {
  const query = useQuery({ queryKey: projectsKey, queryFn: () => ipcQuery("projects:list", undefined) });
  return query.data?.activeProjectId ?? null;
}

/**
 * Whether a webhook job files onto a pipeline, and whether somebody has
 * let what it delivers be sent on unread (EO-405).
 *
 * Read off `pipelineSteps:list`, by the key the board and the editor
 * already hold it under, so react-query serves this from the request
 * they made and the header, the control and the graph are one answer.
 * `entry` decides whether the editor shows the control at all;
 * `unattended` is what the board's header states.
 *
 * Both false until told otherwise, which is the refusal standing.
 */
export function useWebhookUnattended(pipelineId: string | null) {
  const key = pipelineStepsKey(pipelineId ?? "");
  const graph = useQuery({
    queryKey: key,
    queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId: pipelineId as string }),
    enabled: pipelineId !== null,
  });
  useInvalidateOnPush("config:changed", key);
  return { entry: graph.data?.webhook?.entry ?? false, unattended: graph.data?.webhook?.unattended ?? false };
}

/**
 * Turns the setting on or off for one pipeline (EO-405).
 *
 * `said` is the sentence to show where the call came back without doing
 * what was asked: the reason the main process gave, or the refusal's own
 * message — a managed pipelines section answers with the typed lock, and
 * its sentence is the one every other locked edit shows.
 */
export function useSetWebhookUnattended(pipelineId: string, onChanged?: () => void) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (unattended: boolean) => ipcQuery("pipelines:setWebhookUnattended", { pipelineId, unattended }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pipelineStepsKey(pipelineId) });
      onChanged?.();
    },
  });
  return {
    set: (unattended: boolean) => set.mutate(unattended),
    isPending: set.isPending,
    said: set.error ? set.error.message : (set.data?.refused ?? null),
  };
}

/** The pipelines of one project, for the sidebar. */
export function usePipelines(projectId: string | null) {
  const key = pipelinesKey(projectId);
  const query = useQuery({ queryKey: key, queryFn: () => ipcQuery("pipelines:list", { projectId }) });
  useInvalidateOnPush("config:changed", key);
  return { pipelines: query.data?.pipelines ?? NO_PIPELINES, isLoading: query.isLoading, error: query.error ?? null };
}

/**
 * No pipelines yet, as one array rather than a new one per render, so a
 * memo over the list holds until there is a list (EO-565): the board's
 * hand-off handler is built from it, and every card is handed that.
 */
const NO_PIPELINES: IpcResponse<"pipelines:list">["pipelines"] = [];

export function useMoveItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:move">) => ipcQuery("items:move", input),
    // Refetch rather than patching the cache by hand: the move may have
    // cancelled a run and made the item immediately dispatchable, so
    // the truthful answer comes from the main process.
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemsKey }),
  });
}

/**
 * "Move them to X", the offer under the strand refusal (EO-327, ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * `useMoveItem`'s shape, for its reason and one more: what this changes
 * is not only where the cards are but whether the save that was refused
 * would now land, so both the items and the graph's own answer — which
 * carries what each step holds — are re-read from the main process.
 */
export function useMoveStepItems(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"pipeline:moveStepItems">) => ipcQuery("pipeline:moveStepItems", input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      void queryClient.invalidateQueries({ queryKey: pipelineStepsKey(pipelineId) });
    },
  });
}

/**
 * A person deciding on a human step (EO-310, ARCHITECTURE.md, "The item").
 *
 * `useMoveItem`'s shape, and the same reason for it: the decision takes
 * a route, may post a comment and may make the step it lands on
 * dispatchable within the second, so the truthful answer comes from the
 * main process rather than from a cache patched by the button.
 */
export function useDecideItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:decide">) => ipcQuery("items:decide", input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemsKey }),
  });
}

/** IPC mutations for the dashboard story layered on EO-45; no hold UI lives here. */
export function useHoldItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:hold">) => ipcQuery("items:hold", input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemsKey }),
  });
}

/**
 * Taking an item (EO-305, ARCHITECTURE.md, "The board").
 *
 * The same shape as the three above, and deliberately not an optimistic
 * one: a claim writes who has it *and* posts a comment, and the card's
 * assignee slot is drawn from what the main process says rather than
 * from what the button hoped. The board re-reads, the item's authority
 * is asked again (its own root since EO-560), and the item's thread is
 * invalidated by the `items:changed` push the command emits.
 */
export function useClaimItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:claim">) => ipcQuery("items:claim", input),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: stepAuthorityKey(input.itemId) });
      return queryClient.invalidateQueries({ queryKey: itemsKey });
    },
  });
}

/**
 * Who may act on each item where it stands (EO-368). A root of its own,
 * not under `itemsKey` (EO-560): the board's list is invalidated on every
 * item change, and a prefix match re-asked every claimable card's
 * authority with it.
 */
export const stepAuthorityRootKey = ["item-authority"] as const;
/** Who may act on one item where it stands (EO-368). */
export const stepAuthorityKey = (itemId: string) => [...stepAuthorityRootKey, itemId] as const;

/** What `items:authority` answers, once it has. */
export type StepAuthority = IpcResponse<"items:authority">["authority"];

/**
 * Who may act on this item where it stands, as far as this screen knows
 * (EO-368).
 *
 * `known: false` until the first answer arrives, and that is a state of
 * its own rather than a null: null means "nothing is gated here", and a
 * screen that read the wait as that would draw the decision buttons for
 * a person outside the group until the answer came back. `refreshing` is
 * the answer being asked again — after a push said somebody claimed or
 * took something — and a gated control is not pressed on an answer that
 * is about to change.
 */
export type StepAuthorityState = { known: false } | { known: true; authority: StepAuthority; refreshing: boolean };

/**
 * Who may act on this item where it stands, for whoever is looking
 * (EO-368, `items:authority`).
 *
 * Null authority wherever nothing is gated — every step that is not a
 * human one owned by a group, and every item on a desktop signed in to
 * nothing — which is what keeps every screen as it was everywhere else.
 *
 * Re-read on `items:changed` naming the item (or none), because a claim
 * or a takeover by anybody changes who holds it, and on `config:changed`,
 * because that is what a change to a group's membership emits.
 * `enabled: false` asks nothing — a board card only asks about an item it
 * might offer Claim on.
 *
 * One listener for every card on screen (EO-560): each card subscribes
 * the root, which `useInvalidateOnPush` shares, and an item's push
 * refreshes that item's authority and no other card's.
 */
export function useStepAuthority(itemId: string, enabled = true): StepAuthorityState {
  const key = stepAuthorityKey(itemId);
  const authority = useQuery({ queryKey: key, queryFn: () => ipcQuery("items:authority", { itemId }), enabled });
  useInvalidateOnPush("items:changed", stepAuthorityRootKey, { enabled, perItem: true });
  useInvalidateOnPush("config:changed", stepAuthorityRootKey, enabled);
  if (authority.data === undefined) return { known: false };
  return { known: true, authority: authority.data.authority ?? null, refreshing: authority.isFetching };
}

/**
 * Taking an item over from its holder, once the warning naming them has
 * been confirmed (EO-368). Not optimistic, for the claim's reason.
 */
export function useTakeOverItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:takeOver">) => ipcQuery("items:takeOver", input),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      void queryClient.invalidateQueries({ queryKey: stepAuthorityKey(input.itemId) });
    },
  });
}

/**
 * Handing an item to somebody else (EO-305, EO-326, ARCHITECTURE.md, "The board").
 *
 * `items:claim`'s twin, and the reason they were two channels from the
 * start: claiming is "I am taking this" and cannot name anybody;
 * assigning is "you are taking this" and is the whole of what it says.
 * The command landed with EO-305 and had no screen, because on a machine
 * with one person there was nobody to hand anything to — a picker there
 * would have been a control that could do nothing, which invariant 12
 * forbids. The organisation's list is what changes that.
 *
 * Not optimistic, for the claim's reason: the write also posts the
 * comment that records who did it, and the slot reads what the record
 * says rather than what the picker hoped.
 */
export function useAssignItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:assign">) => ipcQuery("items:assign", input),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: stepAuthorityKey(input.itemId) });
      return queryClient.invalidateQueries({ queryKey: itemsKey });
    },
  });
}

export function useResumeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcRequest<"items:resume">) => ipcQuery("items:resume", input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemsKey }),
  });
}
