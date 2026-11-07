# EO — design

This is the design document for EO as the code implements it. It is meant to be read on its own: what EO is, who it is for, how it is put together, and why it is shaped the way it is. The working agreement — the invariants, the conventions and the commands — is [`CLAUDE.md`](./CLAUDE.md), and this document refers to it rather than repeating it.

## Contents

1. [What EO is](#1-what-eo-is)
2. [Vocabulary](#2-vocabulary)
3. [The core and its packs](#3-the-core-and-its-packs)
4. [Pipelines and routes](#4-pipelines-and-routes)
5. [The engine](#5-the-engine)
6. [Runs and run_events](#6-runs-and-run_events)
7. [Comments, attention and escalation](#7-comments-attention-and-escalation)
8. [Items and item types](#8-items-and-item-types)
9. [Jobs](#9-jobs)
10. [Workspace kinds](#10-workspace-kinds)
11. [The assistant](#11-the-assistant)
12. [Agents and backends](#12-agents-and-backends)
13. [MCP and skills](#13-mcp-and-skills)
14. [Connectors and secrets](#14-connectors-and-secrets)
15. [First run and the gallery](#15-first-run-and-the-gallery)
16. [The surfaces](#16-the-surfaces)
17. [Organisation mode](#17-organisation-mode)
18. [Export and import](#18-export-and-import)
19. [The developer pack: git, the forge, Jira and repository intelligence](#19-the-developer-pack-git-the-forge-jira-and-repository-intelligence)
20. [Licensing and updates](#20-licensing-and-updates)
21. [The stack](#21-the-stack)
22. [The visual design system](#22-the-visual-design-system)
23. [The package layout](#23-the-package-layout)
24. [The invariants](#24-the-invariants)

---

## 1. What EO is

**EO is a platform for running work through pipelines of agent and human steps.** A piece of work is an *item*. It sits on a *step* of a *pipeline*, and the step says who is responsible for it right now: an agent, a person, EO itself, or a script. When that party is finished it reports a *result*, the result is looked up in the pipeline's *routes*, and the item moves to wherever the route says. The pipeline — its steps and the edges between them — is data, so a team shapes its own process without writing code.

EO is a desktop application. The work runs on the person's own machine, with their files, their sign-in to an agent backend, and their connectors. Nothing needs a server. An organisation that wants shared configuration and a shared record can run an EO server and have its desktops sign in to it (§17); the desktop remains where the work happens.

**Who it is for.** Teams that want "internal agents" — an agent that drafts the weekly report, triages a shared inbox, prepares content for approval, implements a software change — and want a person in the loop at the points where a person should be. Most of the people who would run such a pipeline are not programmers, so the first thing EO shows is a gallery of templates rather than an empty board, and everything a pipeline is made of can be edited in the app or drafted by describing it to the assistant.

**Software delivery is one pack among several.** The *developer pack* contributes git worktrees, verification of an implementer's claim, review, pull requests, Jira sync and repository intelligence, and the gallery template built on it — *Software feature to merge* — is the pipeline EO uses for its own development. It sits beside templates that have nothing to do with code: *Weekly report*, *Inbox triage*, and *Content draft and approve*. The core that schedules, dispatches, routes and records knows nothing about repositories or branches.

**The board is not the product.** The board is the observable state of the engine. What EO actually does is decide what may run, run it, check what it can of the result, move the item, and tell a person when only a person can go on.

### What makes this hard

Three things; nearly everything else is ordinary application code.

1. **Durable orchestration.** An agent run takes minutes to hours. The app is closed, the machine sleeps, a process crashes. State has to survive all of it and resume correctly (§6).
2. **Trusting a result.** The engine owns every transition, but it can only move an item on a result, and some results are claims it cannot check. EO verifies whatever it can check independently, says on the step what it checks, and puts a person wherever it cannot (§4.5, §10).
3. **Semantic conflict between parallel work.** Isolated workspaces give filesystem isolation, not semantic isolation: two agents can each produce clean work whose combination is broken. The dependency graph between items is the main lever, and concurrency defaults to one (§5.3).

### The shape, in one picture

```
┌────────────────────────────────────────────────────────────────────┐
│  EO desktop (Electron)                                             │
│                                                                    │
│  RENDERER — React                                                  │
│  chat layout: conversation · canvas · rail; canvas & debug windows │
│                │  typed IPC, one Zod contract                      │
│  MAIN PROCESS — Node / TypeScript                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ IPC handlers ── the only way in, for the window, for the     │  │
│  │                 MCP host and for the organisation server     │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │ record        owns item state, schedules, leases dispatches  │  │
│  │ run supervisor   spawn · stream · persist · verify · settle  │  │
│  │ packages/engine  pure: tick, routes, context, validation     │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │ packs         roles, builtins, item types, workspace kinds   │  │
│  │ providers     Claude Code · Codex · the fake backend         │  │
│  │ modules       approved scripts in a child process            │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │ SQLite — configuration, items, comments, runs, run_events    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
        │ optional: sign in                      ▲ optional: MCP on 127.0.0.1
        ▼                                        │
  EO server (the same main process, headless)   another program driving EO
```

---

## 2. Vocabulary

| Word | Meaning |
|---|---|
| **Item** | The one entity that moves through a pipeline. It has a key (`SUP-31`), a type, a title, a body, structured fields, a thread of comments, dependencies on other items, and a step it currently sits on. |
| **Item type** | Data: labels, whether items of the type contain other items, and the shape of their structured fields (§8). |
| **Pipeline** | A named set of steps with an entry step, and the routes between them. |
| **Step** | A named responsibility. Its *type* says who does it: an agent, a person, EO, or a script (§4.2). |
| **Result** | What a step reports when it is finished: a key such as `approved` or `changes_requested`. |
| **Route** | A row: on this step, this result key leads to that target (§4.3). |
| **Run** | One attempt by an agent, a builtin or a module to do a step's work for an item (§6). |
| **Comment** | Anything anybody says about an item — a person, an agent, the engine, a module. The only channel there is (§7). |
| **Job** | A recurring definition that stamps out items: a trigger, a pipeline, a template (§9). |
| **Project** | The grouping an item belongs to. It carries the key prefix, the workspaces, and the pipelines. |
| **Workspace** | Where a run works. A project has zero or more; each is of a *kind* (§10). |
| **Agent** | A configured worker: a name, a role, a backend, a model, instructions, and a tool surface (§12). |
| **Role** | What an agent is for. A step names the role that owns it; any enabled agent in that role may be dispatched. |
| **Pack** | A bundle of contributions to the core: roles, item types, builtins, workspace kinds, pipeline templates (§3). |
| **The assistant** | The system agent, as a person meets it: the conversation that plans work, drafts pipelines and proposes modules (§11). |
| **The record** | Whoever owns item state and schedules work — this machine when solo, the organisation's server when signed in (§17). |

### Where "ticket" survives

The core's word is **item**, everywhere: the tables (`items`, `item_deps`, `item_types`, `item_extensions`), the IPC channels (`items:*`), the schemas and the types. Three places keep the word *ticket*, on purpose:

- **The developer pack's labels.** A pack names what it calls its own work, and the developer pack calls it a ticket, so a developer's board, dialogs and prompts say "ticket". Chrome that spans pipelines uses the pack's word when a project has one pack and the neutral word when it has several.
- **The MCP tool names.** Tools that external clients registered under `ticket_*` names keep answering to them as deprecated aliases of their `item_*` twins, and the app shows which registered clients still use the old names.
- **`ctx.ticket()` in the module host.** Approved modules call it, so it stays, deprecated, beside `ctx.item()`.

---

## 3. The core and its packs

### 3.1 The core is domain-neutral

The core knows steps, routes, items, comments, runs, people, jobs and workspaces-as-a-kind. It schedules work, dispatches it, records what happened, and routes the result. It does not know what a repository, a branch or a story is. Where the core needs something only a domain can answer, it takes the answer **as data or as a function handed to it**:

- the scheduler takes a *capacity key* function and a *dispatch gate* rather than reading a repository id;
- the context builder takes *section renderers* rather than knowing what acceptance criteria are;
- the pipeline validator, the result-schema lookup and the thread-reuse lookup take a **registry** value rather than reading constants.

The registry (`packages/core/src/registry/index.ts`) is what an installation knows: its **roles** (each with its default prompt file, its thread-reuse rule and the output schema of each of its actions), its **builtins** (each with the results it can report and whether it has side effects outside EO), its **item types**, and each pack's **vocabulary**. It is a plain value built once at startup from the installed packs, not a registration API, so its contents never depend on import order.

Two tests hold the boundary, and `CLAUDE.md` names them: a vocabulary scan of the engine's sources, and an allowlist of every file that imports from the developer pack.

### 3.2 Two kinds of pack, two trust classes

EO distinguishes code it ships and audits from things a person approved. Packs inherit that split.

**A code pack** is TypeScript in the main process, shipped with EO. The `CodePack` type in `apps/desktop/src/main/packs/pack.ts` is the whole of what one may contribute:

- registry entries — roles, builtin declarations, item types, vocabulary;
- **workspace kinds** (§10);
- **builtin runners**, the functions behind `builtin` steps;
- **comment posters**, named functions that write the record of an action;
- **role wiring** — how a role's parsed answer becomes a result key, and what happens after a successful run;
- **section renderers** for the context an agent is dispatched with;
- a **dispatch gate**;
- **connector** declarations;
- its own **IPC handlers**.

`createEngine(options, packs)` in `apps/desktop/src/main/engine.ts` is the composition root. It folds the packs into one value and refuses to start if two packs claim the same role, builtin, item type, workspace kind, connector or poster. With no pack installed the core still builds and runs; a step that needs a role or a function nobody provides is refused with a comment saying so. The core ships one function of its own, **`wait_until`**, which every fold includes and no pack may also claim: a `builtin` step that keeps checking until a moment — its `at` input, a date and time with a time zone, or the spec field its `field` input names — reporting `reached` once it has come and `failed`, with a comment naming the field, when the moment cannot be read.

**A data pack** is a document: a pipeline with its steps and routes, the item types it uses, the roles its agent steps need (with prompts and output schemas as JSON Schema), modules, connector and MCP server definitions, vocabulary, and an example item for Preview. It is the pipeline export format (§18), and it is what a gallery template is. Anyone can author or share one. Because it arrives from outside, it lands behind gates: its modules are unapproved, its connectors disconnected, its secrets unset — and a role asking for the administrative grant is refused outright (§11.4).

The developer pack is one code pack (`apps/desktop/src/main/packs/developer/`) and one data pack (the *Software feature to merge* template). The three other gallery templates are data packs only: their roles — a writer, a triager, a reporter — arrive as data and run on the core's own workspace kinds.

### 3.3 What a pack labels

A pack labels four things: its item types, its steps, its results, and the two results the engine produces on its own (needing a person's input, and escalation). The core's own chrome uses the neutral word. Every row on a surface that spans pipelines can show the item's type label, and item keys take a per-project prefix, so a support lead reads `SUP-31`.

---

## 4. Pipelines and routes

### 4.1 A column is a responsibility, not a status

A step does not say what state an item is in. It says **who has it**. "Review" means the reviewer is responsible for this item now. That is why a pipeline holds only work: everything on it is something done to an item that already exists and is already understood. Understanding a request and breaking it into items happens in a conversation with the assistant (§11), not in a column.

### 4.2 A step

A step (`pipeline_steps`) has a name, a position, an optional instructions summary, a terminal flag, and a **type**. There are exactly four:

| Type | Who does it | In the editor |
|---|---|---|
| `agent` | An agent in the step's owner role, dispatched with the step's entry action | "an agent does this" |
| `user` | A person. The engine never dispatches; it waits | "a person does this" |
| `builtin` | EO itself: a named function a pack ships | "EO does this" |
| `module` | A script a person approved, run in a child process (§4.6) | "a script does this" |

Beyond its type a step may carry: the **entry action** (the action an agent is asked for, or the name of the builtin or module to run); the **results** it declares, each with a label, a tone, and whether it requires a comment; a **workspace** choice — inherit the item's, name one of the project's, or none — and for a git workspace a **mode**, `isolated` or `read`; a **plan mode** flag, which asks an agent to propose without changing anything; a **time limit** for a module step; **inputs** for a module or builtin; **keep checking**, on a builtin or module step (below); an **off-board** flag, which keeps conversations out of the board, archive and inbox; and, on a `user` step, an **owner** — a person or a group.

Position orders the display. It decides nothing once a step declares a route.

**Keep checking** is how a step waits on something outside EO — a pull request's checks, a document's approval, a customer's reply, a date — without holding a process open for as long as the wait takes. It is a *mode* of `builtin` and `module` steps, not a fifth type: a type says who has the item, and a watch is still EO doing this or a script doing this. The step carries two settings, **check every N minutes** (at least 1) and **give up after H hours** (168 unless it says otherwise), and only a step whose builtin declaration (`BuiltinEntry.watch`) or module manifest (`watch: true`) says it can wait may use it — `validatePipeline` refuses the mode anywhere else, and refuses an interval under a minute with a sentence naming the step. The other way round holds too (EO-505): a step whose function or module says it can wait must keep checking, because its first check answers `waiting` and on a step that runs once nothing would ask again — so `validatePipeline` refuses one with keep checking off, naming the step. The column head says so: "Checks every 5 minutes · gives up after 7 days".

A step can also **never give up** (EO-571): `watch: { "everyMinutes": 5, "neverGivesUp": true }` checks until a check has a result, however long that takes. A pull request can wait weeks or months for a person, so the shipped template's Watching pull request step uses it (Software feature to merge 1.2, reaching installed pipelines as a template version, §15.5). It has to be said. A `watch` that leaves `giveUpAfterHours` out still gives up after a week, so every pipeline, export and draft written before it keeps its meaning, and a very large number of hours is still a deadline. It is set the same three ways as the rest of the watch: `pipeline_save`, an assistant draft's `watch`, and an import. It is a flag beside the hours rather than a value in their place. NULL hours already means "runs once" in `pipeline_steps`, so the flag has its own column, `watch_never_gives_up`. `Infinity` does not survive JSON. And a build that predates the flag strips a key it does not know, so it refuses a format-10 export with "Update EO and try again" instead of failing on it as damaged. With the flag set the hours are not read, though `validatePipeline` still refuses nought, a negative or a non-finite number, because they are what an older device reads the step as. Everywhere the deadline is shown, such a step says it never gives up instead: "Checks every 5 minutes · never gives up" on the column head, "Never gives up" on the item page, and never "it gives up first" among the reasons it is waiting. The round-trip guardrail and the stop after six failed checks in a row still stop it (§5.5); only the time limit is gone.

In this mode the step runs a short **check** on the interval. A check answers in one of two ways. It may report the reserved outcome `waiting` — nothing to do yet — optionally carrying **news**, entries that each have a stable id and some text: a failed job, a new comment, a reply. Or it may report a result key, which routes through `step_routes` and `transitionItem` exactly as a result of a step that runs once does. `waiting` itself never routes, and a route keyed on it is refused on any step, not only one that keeps checking. Where a `waiting` answer reaches a step that runs once anyway — a pipeline published before that refusal — EO does not route it: the item parks with a comment saying the step needs keep checking turned on. Turning it on reaches items that enter afterwards; the parked item finishes on the version it entered on (§17.4), so the comment offers it what that version can do — a reply checks once more, or a person moves it on by hand.

The wait lives on a row, not in a process: **`item_watches`**, one per item and step, holding when the watch started, when it last checked and when it checks next, how many checks it has run, how many have failed in a row and the last error, and the ids of news already posted. The row belongs to the move that brought the item onto the step, so an item that leaves and comes back is watched afresh. A check may remember more than that row does, by reading the item's earlier runs, and `watch_pull_request` does for requests for changes and review comments; its `ready` it answers at most once per head commit per stay, so a ticket that comes back on the same commit can leave through `ready` again (§19.2). One case is excepted, and accepted as it stands (EO-617): a ticket whose `ready` was stored before that rule, parked on a step that runs once and moved off it and back by hand, may hear `waiting` instead. A move leaves a parked run as it was, so what is stored cannot tell that ticket from one moved first and parked after without trusting two machines' clocks, and no migration tries to; the `waiting` parks it with a comment saying what to do. The scheduler holds a watching item behind its own blocker until the next check is due or the give-up time arrives, whichever is first (§5.2) — a step that checks once a day still gives up on the hour it was told to — and the item page shows when the last check ran and when the next is due. A check that comes back `waiting` with nothing new writes that row and **one line on one run** (EO-618): the check's detail, or "Still waiting." where it gave none, as an `output` event on the run that holds all of this stay's quiet checks, so a week of five-minute checks is a transcript of two thousand lines and not two thousand runs. An item that leaves the step and comes back gets a new one. That run is a record rather than work (`recordQuietCheck`): it is `succeeded` from its first line, so it is never active and holds no slot, no item and no move; and it has no `started_at` and no result, so it sorts behind every run that started and nothing that reads the item's newest run — a park, a retry's backoff, what the item shipped — reads it. Its `ended_at` is the last check, and the Runs tab orders it by that and follows its transcript live. On an organisation's record the next check may be another device's, which has the watch row before it has this run, or holds only part of it. So the run's id is worked out from the item and the stay, which makes it one run whichever device writes first, and each line is numbered from the moment the record granted the lease its check ran under, past what that device already holds. That time is the record's clock and is new with every grant, so no two devices give two lines one number however their clocks disagree, the record, where the first row with a number wins, drops neither, and the lines read in the order the checks ran. A line can still reach a device after a later one; how it is delivered and shown is in §6.2. Anything else is a run of its own, like any other: news, a result key, an error, or the check that answers a person's reply, which is what closes the park. News is posted as **one comment per check**, holding only the entries whose ids have not been posted for that watch, and quoted as text from outside EO, the way a webhook payload is (§7.5). A result key may carry news too — the failed job behind a failure — and it is posted the same way before the result routes, so whoever the item is routed to can read it. How a watch stops — giving up, failing, being sent round too often — is a guardrail (§5.5), and each ends in a comment.

**No check runs while EO is offline, or for 60 seconds after a wake** — the policy Claude Desktop's scheduled tasks use. A check that cannot reach what it checks fails, and failures escalate, so an outage or a laptop whose network is not back yet would otherwise spend a watch's allowance on nothing it did wrong. Offline is the platform's `isOnline()` — Electron's `net.isOnline()` on a desktop; a server treats itself as always online — and a wake is the platform's `onWake`, or a watchdog pass that comes long after it was due. The scheduler holds every item on a watching step behind `watch_held` meanwhile, whether or not its check is due and whether or not its watch has started. A reply to a watch that stopped is held too, at the check itself rather than only at the scheduler: the park and the reply stay as they are, the person who wrote is told why in one note, and the scheduler's recovery pass runs the reply on its first tick after the hold lifts. Because a check schedules the next one from when it ran, a watch that fell due while the machine slept is checked once when the hold lifts, not once for every interval it missed.

On an organisation's record (§17.4) the watch row is shared state, not the checking machine's own. The device that ran a check hands the row to the record before it gives the lease back, so the record's scheduler holds the item from its own copy, and the next device it leases the item to carries the same watch on — its clock, its failure streak and the news already posted — rather than starting one. Rows travel up as a `watch` command and down on the changes feed; a replica keeps its own row only while it still owes the record a report about it, and the record leaves out a report about a stay its own transitions say is over, and one showing fewer checks than the current watch has, so a machine that went quiet cannot wind a watch back or put an old one in place of the current one.

Nothing in `packages/engine` knows what is being watched: it knows that a step is watching, when it checks next and what the check said. What a check *is* belongs to whoever ships it — a builtin in a pack, or a module.

### 4.3 Results and routes

When a step finishes it reports a result key. Routing is a lookup in `step_routes`: *from this step, on this result key, go to this target*. A target is another step — in this pipeline or another one, which is how work is handed from one pipeline to the next — or one of two named targets: `user_attention`, which parks the item and mentions a person, and `terminal`, which resolves to the pipeline's first terminal step.

Where the result key comes from depends on the step:

- **A builtin or a module reports its own key.** A builtin declares its possible results in the registry and a module in its manifest; every builtin must be able to report `failed`.
- **An agent's answer is constrained by its role's output schema**, and the pack's role wiring maps the parsed answer to a key. The schema constrains what an agent may say; the route table decides where that leads.
- **A person presses a button.** A `user` step declares its results, and each is drawn on the item as a button reading "Approve → Post to Slack". Pressing one runs the same route resolution as an agent's result, with the person as the actor. A result that requires a comment will not go through without one, because the comment is how the reason reaches the next step.

The rules (`resolveRoute` in `packages/engine/src/routing.ts`; a route into another pipeline must also meet that pipeline's entry rules, §4.3a):

- A step with **no routes at all** moves to the next step by position. This is the only place position routes anything, and it exists so a simple line of steps needs no route rows. That is the runtime rule; at publish, an agent step on a declared action must route each of its results, so the line that needs no rows is one of builtins, modules and actions nobody defined.
- Once a step declares any route, **only declared routes apply**. A result with no matching route leaves the item where it is.
- **An undeclared result is a guard, not a fall-through.** The item is parked, and an engine comment names the result that came back and tells the person to add a route or move the item. Parking matters: on an agent-owned step, an item that merely stayed put would be dispatched again on the next tick.

Because every edge is a row, a review fork is two rows, a third outcome is a third row, and inserting a QA step between two existing ones is rows and nothing else. `validatePipeline` in `packages/engine/src/pipelineValidation.ts` checks a graph before it is saved or published and writes its problems in the reader's words — "The Approve step has no route for 'rejected'". Among its rules: a step that still holds items cannot be deleted; a declared result must be routed; an agent step is held to the results its action declares — the dispatched role's own definition of it, or else the installed pack's action of that name — so a route on a key the action cannot return is refused, and so is a declared key with no route, which is stricter than the warning a builtin or a module gets because those keys are the answers an agent is told to choose between on every run (the three results the engine produces itself, `needs_user_input`, `escalation` and `verification_failed`, may always be routed and are never required, and an action nothing defines is a warning that its answer is not validated and routes as `done`); and a pipeline that a webhook enters and a side-effecting step ends, with no person's step between, is refused. That last refusal is the default and has one way past it: a setting on the one pipeline, off until a person turns it on in that pipeline's editor, after which the same finding is reported as a warning (§9.6).

### 4.3a Entry rules

A pipeline can say what an item must have before it may enter: "nothing comes in without these". An item type's required fields hold for the type everywhere, and a module step checks after the item has entered, by which time an agent may have been dispatched. Entry rules are the check at the door, for one pipeline.

`pipelines.entry_rules` is an ordered list. A rule has a `kind`, an optional `types` list of qualified item types (absent is every type) and an optional `message`, the words a person wants shown instead of the generated ones. The core answers three kinds: `field` names a spec field, `description` asks for the item's body and `workspace` asks that it has one. A pack can contribute more through the registry (`entryRuleKinds`), as data naming the extension slot and property the value is in, which is how the developer pack's `jira_key` exists without the core knowing what a Jira key is. A value is missing when it is null, absent, an empty or whitespace-only string, or an empty array; `0` and `false` are present. A `field` rule that applies to an item whose type has no such field counts as missing, which is why `types` exists.

**They are data and not code**, for the same reason the graph is (invariant 7), and because of what the check is for. A rule can only ask about what EO already holds on the item, so it runs synchronously at every door, needs no approval, cannot reach outside EO and cannot fail in any way but "this is missing". That is what lets one sentence name everything missing at once: `"Delivery" needs these before work can enter it: a description, a Customer.` Anything that has to run code or ask another system is a module step, after entry; rules replace nothing a module step does.

They are judged by a pure function (`unmetEntryRules` in `packages/engine/src/entryRules.ts`) at each way in:

- **Creation.** Inside `createItem`, before the key is minted, so every door that creates an item answers in its existing refusal shape and a refusal leaves nothing behind. A plan is asked about each of its stories before its first row, and is refused whole, naming the story.
- **Moves by hand.** In `moveItem` and `decideItem` where the destination is on another pipeline, beside `pipelineMismatch` and so before the active-run guard: a move that was never possible must not cost somebody a running agent.
- **Routes.** In `routeResult` and on the failure routes, where the outcome is a step on another pipeline. A refusal asks the person and parks, as a `user_attention` route does: the item keeps its step and the run ends `awaiting_input`, so the scheduler does not dispatch it again. Once the item is fixed, a person moves it in.
- **Jobs.** When a job is saved, against its template: a value with a blank in it counts as present, and so does a field the job's webhook mapping fills. And each time it fires, when a refusal is a `failed` occurrence on the job's thread and later occurrences still fire. A webhook event that is refused is recorded as `refused` rather than held, because no amount of waiting will fill its field and it would stop the queue behind it.
- **The record.** A device asks its replica's copy of the rules before it shows a move, and the record applies the same rules to the command, because that copy can be behind. A refused move comes home through the same path as any other: the person is told and the item is put back.

Only entering is checked. A move within one pipeline is not, nor an edit to an item already on a pipeline, nor `item_move_to_version`, nor work being cleared off a step that is being removed. Items already on a pipeline when a rule is added are not re-checked or flagged. Items carrying `trialAt` or `previewAt` are exempt at every door, so a trial does not exercise the rules.

Rules are part of what a version says: `pipeline_versions.entry_rules` freezes them, a rollback restores them, a save that changes them files a new version and the diff lists the change. An arrival is checked against the version it would bind to (`versionForArrival`), which is the live row except on a step the destination has retired. They travel in a pipeline export (format 11) and to a record's replicas, and `validatePipeline` refuses, at `pipeline:save`, a draft and an import alike, a `field` rule no applicable item type on the project declares, a `types` entry the project does not have, and a `kind` nothing has contributed. Only rules being published are judged, so a rule that has since gone stale does not stop somebody editing a step. A save that leaves the list out keeps what the pipeline has.

People set them through the assistant, whose draft carries them: absent keeps the rules a pipeline has and an empty list clears them, and they reach the pipeline by every way a draft is published. When it designs or changes a pipeline the assistant works out what the entry step needs in order to start without stopping to ask, and proposes rules for exactly that, saying why; nothing takes effect until a person publishes. A trial does not exercise them, but what it publishes is what the person approved, so a later draft that changes them is a change to the design (§11.5). The graph shows them on the entry step in the words a refusal would use, and there is no form.

### 4.4 Moving an item by hand

A person may drop an item on any step. That is not an escape hatch: it is a transition through the same function as every other, with the person as the actor. Two things make it safe.

- **If a run is in flight, the move is refused first and confirmed second.** The dialog says that proceeding cancels the running work. Confirming cancels the run and posts an engine comment naming both ends of the move.
- **The dialog carries an optional comment**, posted as the person's own, *before* the transition so it sits above the move in the thread. People move things backwards because they have something to say, and the comment is the only way the next agent will hear it.

### 4.5 What "EO checks" means on a step

The engine verifies a claim wherever it can check it independently, and it does not pretend to where it cannot. So a step's column head states **what is checked**, derived rather than configured: whether the step's workspace kind has a verifier for the step's action (§10.3).

- `EO checks: commits, tests ran, …` — the kind has a verifier, and the line lists what it describes.
- `Not checked until Approve` — nothing checks this step's claim; a person's step downstream is where it gets looked at.
- On a `user` step the line names who decides: `You approve here`, `Anna Ruiz · approves here`, or `Support team · anyone claims`.

The line is drawn only where it says something — a pipeline whose every agent step is verified, and whose human steps name nobody, shows none. On the item, the run's checks are listed with a pass or fail mark and a sentence each, so a person reading a run knows exactly what was checked.

A failed check either routes — a step can declare a route for the result `verification_failed`, which is distinct from `failed` because "I could not do it" and "I say I did and the workspace disagrees" lead to different people — or, where no route is declared, parks the item and asks.

### 4.6 Modules: a step that is a script

A module is JavaScript a person approved, stored in the `modules` table with a manifest: its name and description, its inputs, what it needs (binaries it may execute, environment variables, network, access to the item, permission to comment, whether it attaches files, whether it creates work items), the results it can report, and whether it has side effects outside EO.

It runs in a spawned child process under the module host (`apps/desktop/src/main/modules/moduleHost.mjs`). The host blocks imports that would let a module start processes or escape its context, and hands the module a `ctx`: its working directory and inputs, the item (`ctx.item()`, `ctx.itemByKey()`), `ctx.comment()`, `ctx.attach()` for files out of its working directory, `ctx.createItem()` for a new work item, `ctx.exec()` restricted to the binaries the manifest names, and a log. This is a boundary of declared needs, not an operating-system sandbox — which is exactly why the gate in front of it is a person's approval.

- **A module cannot run until it is approved**, and any change to its code or manifest withdraws the approval.
- **A trial grant lets an unapproved module run on one trial's items** (§11.5). Making a trial from a draft records a grant on each module the draft runs (`module_trial_grants`, `modules/registry.ts` and `db/repos/moduleTrialGrantsRepo.ts`): who granted it (`"human"`, or an agent's id, as `transitions.actor` says it), when, which trial pipeline, and the needs it covers — the binaries, environment variables and secrets, network, outside effects and item creation the manifest declared at that moment. The module then runs on items carrying the trial mark that stand on that trial pipeline, and on nothing else: on any other item the runner refuses before it touches the workspace, the secrets or the host, with a reason the item is parked with and a comment says. Its code may change as often as the test-fix loop needs while its needs stay within the grant; a save or a restore whose manifest asks for anything more withdraws the grant in the same write (asking for less never does), and the refusal on the trial's next item says the grant was withdrawn and what the module now needs. The validator accepts an unapproved module on a trial pipeline holding a grant for it (`trialGrantedModuleIds`) and still refuses it on every other pipeline. A grant is not an approval: `approved_at` stays null, and only approving — which runs the module's tests — lets it run on live work.
- **A trial never edits a module live work runs.** Where a published pipeline uses a module — on a current step or in any version an item may still be bound to (`moduleInLiveUse`) — the trial is given a draft copy instead: a new row with the original's code, manifest and test cases, unapproved, linked by `modules.forked_from_module_id`, granted, and named by the trial's step. Editing the copy leaves the original's code, approval and versions as they were, and every live item keeps running the original. Discarding the trial deletes its grants and archives the copies made for it — except a copy live work has since come to use (a person can approve one from the catalogue and publish a pipeline running it), which is no longer the trial's to throw away. Publishing a tested draft (EO-588, §11.5) approves each copy and puts it in its original's place on the published pipeline, under the original's name; the original itself is never rewritten, since items still on the version they entered on run it.
- **A module can create work, within limits.** `ctx.createItem()` creates one item of any non-container type the project has, directly on a pipeline of the same project, with no person accepting it first — so the approval of a manifest declaring `needs.create` is the gate, and unlike the other declarations it is enforced, by the host and again by the parent process that performs the write. The item goes through the same door as one handed over complete (`applyNewItem`), so it is held to its type's own required fields. Every creation carries an idempotency key unique per originating item, so a step run twice answers with the item it already made. A run creates at most ten items; an item nobody's module created is generation 0, a created item is its originator's generation plus one, and a run on a generation 3 item cannot create. The pipeline is the one the module names, never the originating item's own. It can name a branch that already exists for the item to be worked on (`existingBranch`), judged and written by the door exactly as a plan's is. Either item can wait for the other (`wait`: `this_waits` or `created_waits`), and the new one for other existing items (`dependsOn`): these are ordinary dependency edges written in the same transaction as the item, so a circular combination is refused and creates nothing, and what waiting holds is what any dependency holds — the next step EO would dispatch, never a person's step and never the terminal one. On a project an organisation holds the edges are the record's, and they reach a desktop with the items at their ends on each pull (`RecordItemSchema.waits`), so its board and item page say what the record's scheduler is holding. Each item gets a comment from EO naming the module and the other item, and the new one records where it came from (`item_origins`) — a fact that travels with the item when a project is handed to a record or mirrored to a replica, so neither guard lapses when work changes hands. The answer returns to the module on a descriptor of its own, each line signed with a key the module is never shown and verified by functions the host took hold of before importing it. On a project an organisation holds, the creation is *asked* of the record rather than written to the desktop's replica (`record:createItem`): the record checks the device's lease, its own copy of the module's manifest, and everything above, and a record that cannot be reached means nothing was created. A run on a trial item creates nothing at all (§11.5): there is no pipeline it could file on that would not be live work.
- **Approval runs its tests.** A module carries test cases; approving a module with none, or whose tests did not run, is refused. Tests run with the network blocked, writes confined, a scripted `exec` and a fake clock.
- **Nobody approves code blind.** What the person is shown is what the module declares and what it did when tested; the source is one click away.
- **A module step has its own time limit** — ten minutes unless the step says otherwise — because a module often waits on somebody else's system. It is bounded by the run timeout, and a limit above that bound is refused rather than silently lowered.
- **A module can be a check.** A manifest that declares `watch: true` may be run by a step in keep-checking mode (§4.2): each run is one short check that answers `waiting`, with news if it has any, or one of the module's declared results. That is the shape for a wait measured in hours or days — a module that holds its process open for as long as somebody else's system takes is the run-holds-a-subprocess shape invariant 9 rejects — and it is how a data pack waits on Stripe, DocuSign or a shared inbox with no code in EO. A check that is still waiting returns `{ ok: true, result: "waiting", news: [{ id, text }] }`; each id is the module's own and stays the same for as long as the news is true, which is how EO posts it once. `waiting` is accepted only from a manifest that declares `watch: true`: the host refuses it from any other, and the run fails with a comment saying the manifest does not declare that it can wait. The host applies that rule in test mode too, so a test case sees exactly what a run would: it can assert a `waiting` outcome and the ids of its news, and approval still needs every case to have run and passed. The module editor shows the flag and edits it as a switch. Anything a check writes that names its run — a comment, a file, a created item — makes the run row first, since a check that is still waiting with nothing new has no run of its own, only a line on the stay's quiet run.
- **A module's claim is verified like anyone else's**: the workspace kind's verifier runs on module and builtin runs as well as agent runs.

---

## 5. The engine

### 5.1 `packages/engine` is pure

The engine package is plain functions over plain data: no `node:*`, no Electron, no database. Given items, dependencies, steps, agents, active runs and limits, it returns what to dispatch. That makes it trivially testable, and it is the one module that would port anywhere. It contains:

- **`tick`** — the scheduler (`packages/engine/src/scheduler.ts`);
- **`resolveRoute`** — routing (§4.3);
- **`decisionRefusal`** — whether a person's decision on a step is acceptable;
- **`validatePipeline`** — the graph validator;
- **`assembleContext`, `assembleSeedContext`, `fitCommentThread`** — what an agent is dispatched with (§7.5);
- **the dependency graph** — cycle detection, closure, ready set, topological order, and deriving dependencies from the paths two items say they touch;
- **`validateRefineGraph`**, **review coverage**, and **`archivableItems`**.

Everything with a side effect lives in the main process, which gathers the data, calls the engine, and acts on the answer.

### 5.2 The tick

A tick runs on an interval and on every state change. It is deliberately boring and synchronous. For each item, in priority order and then oldest first — with the trial items of a draft still under test ahead of the rest while the **trial items first** guardrail is on (§11.5) — it asks whether anything blocks a dispatch:

| Blocker | Meaning |
|---|---|
| `paused` | The global pause is on. Nothing dispatches but an agent step owned by the `system` role (§5.5). |
| `unknown_step` | The item is not on a step the engine can find. |
| `step_not_dispatchable` | The step is a person's, or terminal, or a builtin/module step with nothing to run. |
| `open_dependency` | An item this one depends on has not reached a terminal step. |
| `awaiting_input` | The item's last run ended by asking a question (§7.3). |
| `held` | A person parked it by hand. |
| `run_active` | It is already being worked on. |
| `retry_backoff` | Its last run failed a moment ago, and the retry waits (§5.5). |
| `watching` | It stands on a step that keeps checking, and the next check is not due yet; the sentence names when it is (§4.2). |
| `watch_held` | It stands on a step that keeps checking, and EO is offline or woke less than a minute ago, so no check runs yet (§4.2). |
| a pack's refusal | The dispatch gate said no, with its own reason. |
| `no_enabled_agent` | No enabled agent in the step's owner role can take it. |

An item with no blocker is dispatched if there is capacity. The same eligibility function answers "why is this item not moving?" for the interface, so the board's explanation and the scheduler's behaviour cannot disagree.

### 5.3 Capacity and concurrency

Three limits apply, all guardrail settings: a **global** cap, a cap **per agent**, and a cap **per capacity key**. A capacity key is supplied by the item's workspace kind and names a shared filesystem: the workspace id for a git or folder workspace, where two runs would touch the same tree, and nothing for a scratch or no-disk workspace, where they would not.

All three default to **1**. Parallel agents multiply every bug not yet found, and the dependency graph is not yet trusted enough to say which items are safe side by side. Raising the cap is a settings change made on evidence, not a design decision.

**A step the `system` role owns is held back by none of the three** (EO-616, a person's choice on ASK-56, and the one exception to invariant 10). The host names the role on `TickInput` (`uncappedRoles`), and `tick()` compares it with the step's owner role, so a builtin or module step is never exempt. The global limit reaches a dispatch twice, so the exception does too: `offerWork`'s `capacity` is what a device says it could start, and work with no cap is offered past it. That makes a capacity of nought still an ask, which is why a device with no slot left asks the record anyway. A process that can run nothing asks with a capacity of null, which sweeps and offers nothing. The system agent's runs still count as active, so they take up slots against other work as any run does, and an item still has one run at a time: `run_active`, the lease and the item lock do not know about caps.

### 5.4 Transitions

**Only `transitionItem` writes an item's step.** Every move — an agent's result, a builtin's, a module's, a person's decision, a person's drag, a guard — goes through it, and each is appended to `transitions` with its actor, the run that caused it and a reason. Agents never move items. An agent is a function: given an item and instructions, it returns a result, and the engine decides what that result means.

The decision the engine enforces is a row rather than a branch in code (§4.3), which is what makes the rule checkable.

### 5.5 Guardrails

Guardrails are settings, tunable without a release (`apps/desktop/src/main/ipc/configCommands.ts` holds the defaults):

| Guard | Default | Why |
|---|---|---|
| Global, per-agent and per-capacity-key concurrency | 1 each | A run is a real subprocess; see §5.3 |
| Attempts per item | 3 | A review loop will otherwise go round forever |
| Wall-clock timeout per run | 2 hours | The ceiling on a run that is busy but never finishing |
| Silence before a run is ended | 10 minutes | Backends hang; a hang is caught by the silence it makes (§6.5) |
| Time limit per module step | 10 minutes | A module waits on somebody else's system (§4.6) |
| Budget per item | unset | What one large item legitimately costs is not a figure EO can guess |
| Budget per day | 5,000¢ | Autonomous loops burn money silently; this is the one budget that ships switched on |
| Agent-to-agent mention depth | 3 | A pings B pings A is a real and expensive failure mode |
| Watch round trips per item | 5 | A watch that keeps sending an item back to be fixed, and getting it back, is a loop with nobody in it |
| Trial items first | on | A draft's test-fix loop waits on one trial run at a time, and behind a queue of live work it would stall for hours; this orders, and caps nothing (§11.5) |
| Test rounds per draft | 8 | A test-fix loop that has not converged by then needs the person, not another round (§11.5) |
| Budget per draft | unset | The daily budget already bounds a loop; this is for a draft somebody wants held to less |
| Stop on a repeated failure | on | The same step failing with the same result two rounds running means the fix did not reach it (§11.5) |
| Global pause | off | The kill switch, for everything but the system agent (below) |

Jobs add a budget per occurrence and a cap on items per hour (§9); an organisation adds a budget per person per day and a list of allowed backends (§17.6).

**Only the attempt limit applies to the system agent** (EO-616). The definition is EO-615's, `isSystemAgent`, and it covers every run of the role on every action, pipeline steps included. The concurrency caps (§5.3), the wall-clock timeout, the silence limit, the interruption ceiling, mention depth, the per-item, daily and job-occurrence budgets: none of them stops such a run, and it is handed no budget cap to stop at. Four things still do. The attempt limit refuses it with the same stop as anybody else. Silence after a wake still carries it on in its own thread (§6.5), because that is recovery and not a limit. An organisation's allowed backends and budget per person still refuse it (§17.7). And a draft's test rounds, budget and repeated-failure stop still end a test-fix loop (§11.5). Its spend is recorded and counted in the per-item and daily totals as anybody's, so it can use up the day and stop every other agent while it goes on itself. A mention of it past the depth cap is answered, and what it writes next is weighed as usual, so a chain that runs on through another agent stops at that agent.

**The system agent carries on while EO is paused** (EO-615). A pause holds every agent, builtin and module but one: a run by an agent in the `system` role goes ahead by whichever door it arrives. That is a message in an assistant or scenario chat, a mention of it on an item, a reply to a run of its that parked, a retry of one of its runs, and any agent step its role owns. Reading a free-text reply on a parked builtin or module step is such a run, and the step it would wake still waits for the resume. There is one definition, `isSystemAgent`: the run's agent holds the role. The engine knows nothing of it, because the host names the roles a pause does not hold on `EligibilityInput` (`pauseExemptRoles`), and `tick()` and `dispatchBlocker` compare them with the step's owner role, so a builtin or module step is never exempt. Everything else that stops a run still stops it: a hold, an archived project, a disabled or archived agent, an open dependency, a parked item. While paused that goes further than usual on two counts, so that a pause never reaches something a person has also put away: a mention of or reply to the system agent on a held item, or to one switched off, is kept for later rather than answered. `engine_pause` with `cancelRunning` leaves the system agent's running runs alone, whatever has happened to the agent since they started, and cancels the rest, a chat's warmed backend is kept and a chat can be warmed while paused, and the rail does not count these runs as finishing, since a pause is not waiting for them. Memory consolidation is a side call rather than a run, and pausing still stops it. Closing EO is not a pause: it has its own door (`beginClose`), which exempts nobody (§6.3).

**An interrupted run is not an attempt.** A run cut short without failing records why (`runs.interruption`): `quit` when a person stopped it by closing EO, `restart` when EO went down under it and found it still running on the next launch. Such a run is carried on (§6.3) and the attempt count leaves it out, because the agent did nothing wrong. To keep that from becoming a loop — a run that takes EO down with it would otherwise be resumed into the same crash on every launch — an initiation interrupted five times is not carried on again: the next dispatch is refused with a comment, as Claude Desktop parks a session its crash-loop guard catches. The system agent is exempt, at the dispatch, in reconciling and in a forced restart (EO-616). The cost is known and accepted: nothing else bounds this loop, because the attempt limit does not count interruptions, so a run of the system agent that takes EO down with it is resumed on every launch until a person stops it.

**Budgets hold during a turn, not only after it.** Both backends report a turn's usage at its end, so the per-item and daily budgets used to be checked only once a turn had spent whatever it spent. A dispatch is now refused when either budget is already spent, and a pipeline step's turn is handed what is left of them as its own cap, the system agent's excepted (EO-616): Claude's CLI holds that cap itself (`maxBudgetUsd`), and Codex's adapter prices the running usage the app-server reports and interrupts the turn at it, recording what it spent first. Either way the run is parked with the budget escalation it would have got at the end. A conversation's turn is short and started ahead of time, so it is checked when it is dispatched and when it ends, not capped mid-turn.

**A resumed run is charged only what it spent.** The budgets, the spend screens and `spend_read` all sum the runs' own figures, so each run must record its own share and no more. Codex's adapter reads a turn's tokens as the thread's total at the turn's end less the total restated before it began. Claude's CLI is different. When it resumes a session it restores the session's cost, so a rework round, a reply after escalation, a rerun or a corrective turn reports the whole conversation's tokens and cost as its own. Its `num_turns` still counts the query alone. Each run therefore starts from where the thread's earlier runs left the session. Every run records two figures: its own share, which the budgets sum, and the session's running total as it last read it (`runs.session_*`, `UsageTally.sessionTotal`). The next run on the thread starts from the newest of those totals (`sessionTotalBefore`), not from the sum of the shares, so one wrong share does not carry forward. A corrective turn starts from the session's total as the turn before it left it: that starting point plus the earlier turn's own share, or the earlier turn's reading alone if that turn found the session had restarted. The first reading of every resumed stream decides how it is read. If every figure is at or above that starting point, the total carried on and the starting point is taken off. If any figure is below it, the session started again and the reading is the run's own, whole (`createUsageTally`). The cap handed to a resumed turn is not raised to make room for the restored cost: the CLI holds `maxBudgetUsd` to what its own process spent, which is the restored cost taken off the session's. Runs recorded before EO-490 keep their inflated figures, but runs after them on the same thread do not inherit the error (EO-504). Each of those older rows holds the session's whole total rather than a share, so summing them overshoots the session. Every later reading then looked like a restart and was recorded whole, and the overshoot grew with each run. Rows written before EO-504 have no session total of their own, so `sessionTotalBefore` walks them oldest first and reads each one by the tally's test. A row at or above the total so far in every figure is taken as the session's whole total. A row below it in any figure is a share, and is added to the total. Two kinds of older row can be misread, because their figures look like the other kind. A share recorded between EO-490 and EO-504 that outspent everything before it on the thread, in every figure, is taken for the whole total. The next run then records the earlier runs' spend once more as its own. A whole total recorded before EO-490 by a session that had restarted is below the total so far, so it is taken for a share and added. The next run's reading is then below the reconstructed total, is read as a restart, and is recorded whole. Either way only that next run is wrong. It records the session's real total, and every run after it on the thread starts from that. The total a run records is its newest reading, not the high-water mark its spend is counted from. After a `/clear` resets the running total part-way through a turn, the session stands at the smaller figure, and both the run's corrective turn and the next run carry on from that figure.

**A failed run's retry waits.** A failed run is retried in its own initiation up to the attempt limit, after 30 seconds, then 2 minutes, then 8 minutes, rather than on the next tick. A crash on start used to spend every attempt within seconds, faster than anybody could look. The wait is a scheduler blocker like any other, so an item waiting it out says so and until when. A move into the step starts a new initiation and owes nothing to the failure before it.

**A watch stops in three ways, and each is a comment** (§4.2). Past its give-up time the item is parked with an engine comment that mentions its owner and says how long the step watched. A check that throws or fails is retried after 1, 2, 5, 10 and then 30 minutes — the failures in a row and the last error are on the watch row — and the sixth in a row parks the item with an escalation carrying that error. And **watch round trips per item** parks an item that steps which keep checking have sent to another step, or back to themselves, that many times since a person last commented, because a check that reports the same failure on every round sends the item back for as long as anybody lets it; any comment from a person starts the count again. A reply to any of the three starts the watch again from that moment.

**Every guard resolves the same way: it posts a comment and stops.** The engine posts as itself — "Stopped after 3 failed review cycles. Last reviewer feedback: …" — and mentions a person. No guard drops work silently.

---

## 6. Runs and run_events

### 6.1 A run

A run (`runs`) is one attempt at a step's work for one item: the agent (none for a builtin or module), the action, a status, the backend's thread id, the working directory, the attempt number, the structured result, token and cost figures, and timestamps. Its status is one of `queued`, `running`, `awaiting_input`, `succeeded`, `failed`, `cancelled`, `orphaned`.

A builtin or module step gets a run row with no agent, so it has an elapsed time, a status, a transcript and a result that routes — which is the point of making worktree setup and opening a pull request *steps* rather than side effects.

The run supervisor (`apps/desktop/src/main/supervisor/runSupervisor.ts`) owns a run's life: resolve and prepare the workspace, assemble the context, start or resume the backend, stream events, enforce the timeout and the budgets, validate the answer against the action's schema, run the workspace's verifier, post the outcome as comments, resolve the route, and transition.

**A malformed answer is re-prompted with the validation errors**, as one complete list, and escalated if it stays malformed. Structured output is demanded through the backend's own schema mechanism; EO never parses prose looking for an answer.

### 6.2 `run_events` is the durability substrate

Every event of a run — output, tool calls, file edits, usage, errors, the result — is appended to `run_events`, keyed by run and sequence number. **It is append-only.** Nothing updates a row and nothing deletes one, with the single exception `CLAUDE.md` states: deleting the item itself. That one rule is what makes crash recovery, live transcripts, the organisation's record sync and after-the-fact debugging all work from the same table.

Writes are batched: a chatty agent emits thousands of events and a write per event thrashes the disk, so events are buffered and flushed together, with sequence numbers allocated in memory per run.

**Between machines a line is delivered by when it arrived, not when it was written** (EO-618). Devices read the record's transcripts as one feed, and a line can reach the record long after lines written later, because the device that wrote it was asleep, or because a watch's run is written by two devices (§4.2). So a line from another machine takes an `arrival` position on insert, past every position taken so far whatever any clock says, and the feed pages on that, or on `ts` for a line written on the machine serving it. The row is never touched again, and a device's cursor stays good across the change. A transcript open on a run follows the log forward from its last sequence, so the log also says how many lines the run holds: a view that holds fewer has had one land behind it, reads the run again, and puts that in place of what it held. A pulled line tells open windows as a line written here does.

This is the durable-execution pattern at the right size. EO is one process on one machine, so an append-only log in SQLite does the job a workflow server would do, with nothing extra to install or keep alive.

**The one event that is never stored is a word being written.** A turn somebody is watching — the assistant's — streams its blocks as they are generated (`output_delta`), the way Claude Desktop does. Those pieces go to an in-memory store (`supervisor/liveDrafts.ts`) and to the window, coalesced to about one push a frame on `runs:delta`, and never to `run_events`: the finished block arrives a moment later as an `output`, a `reasoning` or the answer's tool call, and *that* is the record. A draft stays in the conversation view until its finished event has been written, so the words are on screen as a draft until they are on screen as a step. `runs:delta` carries its text, against the rule that a push says only "ask again", for the reason download progress does: there is no substrate behind it to ask.

### 6.3 Reconciling on launch

Before the first tick after a start, every run still marked `running` is reconciled:

- its process is alive and ours → it is adopted and left to finish;
- it has a thread id → the backend resumes the thread, as the same attempt;
- otherwise → it is marked `orphaned` and the item is handed back to be dispatched again.

Then stale workspaces are released. Nothing dispatches against unreconciled state.

**Closing EO while agents work** offers three choices: keep it open, close when the work finishes, or stop the agents and close. Close when the work finishes starts no new run of any agent, and stopping the agents stops the system agent's runs too. Stopping is not a cancellation of the work: EO reopens paused, and once it is resumed each stopped run is carried on in its own thread and told why ("EO was closed while you were working…"), the way Claude Desktop carries on a turn its app was closed in the middle of. A thread that can no longer be resumed — the agent moved to another backend, or its attached tools changed — is started over in a fresh session instead. Both this and a restart are interruptions, not attempts (§5.5). The system agent's runs do not wait for the resume, because a pause does not hold them (§5.5): when EO reopens paused, one left `running` is reconciled and carried on, and one stopped by closing is restarted on the first tick, so its conversation is not left stuck. Everybody else's runs stay untouched until EO is resumed. A close that lands while a recovered run or a reply is being prepared, after its row is written and before a backend is reached, starts nothing: the recovered run keeps its restart, and the reply goes back to waiting, to be read when EO next runs.

### 6.4 Thread reuse

A backend session can be resumed by id, so a role may keep **one conversation per item**. The registry says which: the implementer does (a rejection, a clarification and a mention all continue the same thread, with its context intact), the reviewer does not (each review is a fresh read), and the system agent keeps one per conversation. For a role nobody shipped, it is a setting on the agent.

A session keeps the instructions it started with, so a thread is not reused when the agent's instructions or attachments have changed since: the next dispatch opens a new thread and a comment says why. A thread the backend has lost is treated the same way — a fresh thread, a full context, and a comment — rather than failing the run.

### 6.5 Telling a quiet agent from a stuck one

A run's backend is watched the way Claude Desktop watches its sessions. Everything it says counts as a sign of life, and so do two signals that are never stored: a **heartbeat** while a tool runs (Claude reports a running tool's progress; Codex streams a command's output as it prints) and the start and end of a tool call, which Codex reports only once the call is over. A request to the model that the backend is retrying is reported as a **retry**, stored and shown in the transcript, because a turn waiting out a rate limit otherwise looks exactly like a hang.

The inactivity guard looks at every run in flight every 30 seconds. A run whose backend has said nothing for the silence limit, while no tool call is open, is stopped the way the wall clock stops one: parked with an escalation that says what it last said, its thread kept so a reply carries it on. A tool that runs quietly for a long time is the agent at work and is not counted; the wall clock still bounds it. Neither limit stops a system agent's run (§5.5), though the recovery after a wake below still carries one on.

Time asleep is nobody's. EO hears that the computer woke from the operating system, and also infers it from a watchdog pass that arrives far later than it was due. Silence is counted from the later of the run's last word and the wake. A run whose backend went quiet across a sleep and stayed quiet for the whole limit afterwards is carried on in its own thread and told the computer slept, as Desktop does, rather than escalated: the connection did not survive the sleep, and the agent did nothing wrong. Like a quit or a restart it is an interruption, not an attempt (§5.5).

**A compaction is reported and the brief restated.** When a backend compacts a long conversation — Claude's `compact_boundary`, Codex's `contextCompaction` item — EO records it in the run, where the transcript marks it, and steers the running turn with the item restated: its key and title, the step, and the acceptance criteria it will be checked against. The agent's instructions survive a compaction, since the system prompt is not summarised; the brief the run was seeded with is what can be lost. The reminder is recorded beside the compaction, because what EO tells an agent is part of the run. A conversation is its own brief and gets none.

### 6.6 Speaking to a run in flight

A person can send a message to a running agent, to be delivered now or at the next opportunity, and can stop it. Both backends support steering and interruption of a live turn. In the assistant's chat, stopping also lets go of the messages that were waiting for the next turn, and says so under the turn: a person who pressed Stop did not ask for the next turn to start on its own.

---

## 7. Comments, attention and escalation

### 7.1 One channel

**Everything anyone says — a person, an agent, the engine, a module — is a comment on an item.** A question is a comment that mentions someone. An answer is a comment. A reviewer's feedback is a comment. An engine guard is a comment. The thing a step produced is a comment. There is no inbox table, no side channel between agents, and no separate conversation store: a conversation with the assistant is the comment thread of an item on an off-board step.

**Each project has one thread.** Something that belongs to a project rather than to any one item — a proposed skill, a note about the repository — still has to be a comment on an item, so each project gets one off-board item as its **project thread**, shown as *Project notes* in the project's settings and opened in the ordinary item view. It is made the first time anything asks for it, through one accessor (`ItemRecord.projectThread`, which `openProjectThread` in `apps/desktop/src/main/projects/projectThread.ts` implements on the record's tables); a unique index holds every project to one. Its key is the project's own — `SHOP-NOTES` — rather than a number from a counter, because a counter is one database's and the thread may be made on a desktop or on the organisation's record and travel between them. It sits on its own off-board, non-terminal step (`project-thread`), so it appears on no board, in no column and in no archive listing, and the archive sweep never takes it. Its comments are ordinary comments: a mention on one reaches the inbox and the `!` count like any other. Deleting it is refused while its project exists; deleting the project takes it. In organisation mode it belongs to the record, like the project's other items: a desktop holding a moved project asks the record for it (`record:projectThread`) and copies the answer into its replica. It is the job thread's arrangement (§9.2), given to a project.

A comment has an author type (`human`, `agent`, `engine`, `module`), a kind (`note`, `question`, `decision`, `approval`, `rejection`, `escalation`, `output`), optional choices rendered as buttons, optional attachments, a parent for replies, and a `pinned` flag that protects it from truncation.

### 7.2 Three facts, three places

Conflating these is what causes state drift:

| Fact | Where it lives | What it drives |
|---|---|---|
| What was said | `comments` | The timeline, and an agent's context |
| Who needs to see it | `comment_mentions` | The inbox, and the `!` marker |
| Why the item is not moving | the run ended `awaiting_input` | The scheduler |

A mention does not by itself block an item. An item is blocked because its run *ended waiting for a reply*. Keeping those apart lets an agent mention a person with an FYI without stalling the pipeline.

A mention targets a person or an agent, and is `open`, `addressed` or `dismissed`. Only a comment from the same kind of author as the target can address it, so an agent can never close a mention aimed at a person.

### 7.3 Escalation ends the run

An agent asks through a tool — the `comment` tool, with `mentions` and `blocking` — never through prose EO would have to detect. When it posts a blocking comment that mentions someone:

```
the run ends cleanly, status awaiting_input, thread id kept
  → a mention row is created, open
  → the scheduler skips the item
  … the person replies, whenever …
  → the backend resumes the thread with what was said since
  → a new run, the next attempt, same conversation, context intact
```

**The run does not hold a subprocess open waiting for a person.** That is what makes escalation cheap, and it has to be cheap: an expensive way of asking is one agents get tuned to avoid, and an agent that asks freely is worth more than one that guesses.

Optionally, the system agent *interprets* a person's reply before the step resumes — deciding whether it answers the question or changes the subject — so a step is not woken by a remark that was not for it.

### 7.4 Needs-attention is derived

The `!` on an item is computed from open mentions aimed at a person. It is never stored, because a stored flag drifts the moment something is dismissed or resolved. The item **stays in its column**: moving it to a "needs a person" column would lose which step it is stuck on. And attention is not priority — an urgent item running fine needs nothing from anyone, and a low-priority one can be completely stuck.

**The inbox is a view**: open mentions aimed at a person, newest first. It answers "what can only I do?", which, since agents run unattended for hours, is the reason to open the app. Being a desktop app, EO also raises a native notification on a new blocking mention, badges the dock with the open count, and says so loudly when every item in flight is waiting on the person.

### 7.5 What an agent is given

Nothing a person said may be unreachable, and nobody should re-litigate a settled decision. Inlining the whole thread guarantees that and stops scaling: on an item that has been round a review loop many times, nearly all of a dispatch is thread, most of it agent chatter, and an agentic loop pays for its whole conversation on every turn. So there are two shapes of context.

**A step-owning agent is seeded**, and given tools to reach the rest:

```
the item — title, body, structured fields
+ the workspace it is in, and which others the project spans
+ dependency item KEYS
+ the newest comment from every step the item has passed through
+ every human comment since this agent last ran here
+ a census of what that leaves out, by author and kind, with the
  ids of the attachments those comments carried
```

The rest is one `comment_search` or `comment_read` away; `item_detail` on a dependency key answers with what that item shipped; `attachment_read` reaches any file by id. The seed is bounded by the shape of the item — one comment per step plus what a person has said since — rather than by a budget.

**A conversational agent is given the whole thread**, because for it the conversation *is* the work:

```
the item — title, body, structured fields
+ its parent's title and body, and the parent's pinned comments
+ this item's full comment thread
+ dependency item summaries
```

Which shape an agent gets is decided by one predicate — whether it holds the `thread_read` tool — not by its role and not by its action, since both are configuration. One predicate means "the thread is in your prompt" and "you can fetch the thread" cannot drift into a prompt that promises a tool the agent does not have.

**Threads grow; context windows do not.** A whole thread is fitted to the budget in tiers, and what it gives up it gives up from the bottom:

1. **Questions** are never given up, at any depth. From the question alone an agent can decide whether an exchange bears on its work.
2. **Standalone human comments** are never given up either; nor are pinned comments, nor anything carrying an attachment.
3. **Answers** are given up second, as a whole exchange: the question keeps its place and its answers become one marker naming a count and the question's id, which `comment_read` follows.
4. **Agent chatter** is given up first, oldest first, summarised by kind and count rather than dropped silently.

A collapsed answer is retrievable and a dropped one would be gone, which is the only reason the question may outrank the answer. Losing a person's words to save room is the one thing truncation may not do. `comment_read` returns at most fifty replies, so an exchange larger than that is left whole even if the thread stays over budget: a pointer to most of what was hidden is the same loss with a signpost on it.

**A payload that arrived from outside** — a webhook's body — is rendered as a quoted block under a heading that says it is untrusted, never as the item's own description.

**Memory is selected, not complete.** What earlier runs and people learned about a project lives in EO's database as entries (`memories`), each at one of three scopes — a project, one workspace of it, or a container item whose work is in progress (below) — with its source (a person, or a run and its item) and nothing ever deleted: an edit retires the old row as `edited` and inserts a new one, a note retires the entries it replaces as `superseded` (below), a person retiring an entry or a consolidation folding it only stamps `retired_at`, and a restore clears it (`db/repos/memoriesRepo.ts`, the `memory:*` channels). A dispatch's *candidates* are the active entries of the item's project and of the workspace its step works in — the same workspace its skills are decided by (`skillRunScope`); a step with none, a conversation or the `none` kind, has the project's only, and a retired entry is never one. An item filed under a container has that container's entries among its candidates too, whatever its step works in; no other item does.

**An item's own notes do not come back to it** (EO-611, `deliverMemory`). A note a run wrote on an item, by `memory_note` or by extraction, is not a candidate for that item's later runs, on the same thread or a new one, so neither `memory_delivered`'s ids nor its `candidateCount` hold it and the threshold does not count it; it is taken out after the active entries are read and before anything is chosen, and again when they are read after a selection. EO-610 is why: a run on the thread that wrote three notes was handed all three and counted one as used, which says nothing about whether memory helps, and a reviewer given four notes extracted from the implementer seconds earlier was reading the implementer's account of the code under review, which invariant 5 says it should check instead. It looks only at the item, so a person's entry is unaffected and a note from any other item is delivered as it always was, a sibling under the same container included. An item left with nothing takes the path of one with no candidates. The cost is accepted: a run on a new thread after a lost one does not get its item's notes from memory, though it still gets the newest word from each step. `memory_read` still lists them. An entry a consolidation wrote keeps the source of the newest entry it folded, so it counts as that item's.

- **A small set is given whole.** When the candidates total the `memoryDeliveryChars` guardrail or less — 4,000 characters by default — every one is delivered and nothing is asked.
- **A larger set is selected.** One `memory_select` side call (§12.2) on the dispatched agent's backend, made *inside* the run being dispatched — after its row is written, on its slot, against its item's and day's budget — is given every candidate with its id and the task: the item's title and body, the step's action and the comments since this agent last ran on it, or on a conversation turn the latest message. It answers through its schema with at most eight ids that will clearly help, told to be conservative, to match on what the action will do rather than on shared words, and that an entry helps only where the action will do what the entry is about, so a run that judges finished work is not given notes on running the tests (EO-611); an id it made up is not delivered. That is the prompt's one rule about actions: it is given the action's name and works out what it means, and EO has no per-role selection or delivery rule. It is measured on both backends' small models by an opt-in live test (`selection.live.test.ts`, `EO_LIVE_MEMORY=1`), one item under an implement and a review action. It has twenty seconds.
- **A failed selection falls back.** Whatever the reason — timeout, schema, budget, a backend with no side calls — the newest candidates up to the threshold are delivered with a line saying selection did not run. A dispatch never fails because of memory. The selection is the one await between the run row and the provider: when it yields, the boundary's checks are asked again after it, and a run that may no longer start — paused, deleted, archived, moved, its agent gone — is closed as cancelled with the reason, rather than started; one caught by EO quitting is closed as shutdown closes a live run, as an interruption rather than an attempt. What is delivered after a selection is held to the entries as they are then: one retired or edited while it ran is not sent, and a fallback takes the newest of the entries still active. The selector is shown the task whole — body, comments and message uncut.

The chosen entries arrive as one section appended to the context, the same text on both backends because it is EO's context rather than either backend's feature (`memory/selection.ts`). It says the entries are background, true when written, to be checked against the workspace before being acted on; each entry carries its age ("written 12 days ago") and its id under its scope's heading, with "by a person" on a person's (EO-594), and each scope ends with how many other entries it holds. The run's log records a `memory_delivered` event with the delivered ids, how they were chosen and whether selection ran. The rest stay one call away: the `eo` server's `memory_read` lists a scope's entries by id and first line and returns any one in full, held to the scopes the turn was given, and is served on every turn of a thread that was given memory — the dispatch, its corrections, a reply, a recovery. Every run that opens a new turn is given memory chosen when it starts: a dispatch, fresh or resuming a thread, and a person's reply to a parked run, whose memory may have changed while it waited and whose reply may bear on entries the first turn was not given — both through the same selection and the same checks after it (`memoryBeforeStart`). A continuation after an interruption, and a corrective turn, are not given the section again: they carry on a turn that already holds it.

**Whether what a run was given was used is counted** (EO-597, `memory/memoryUse.ts`, `db/repos/memoryUseRepo.ts`). The only evidence that a delivered entry helped used to come from reading a diff by hand. So the `implement` and `review` answers take an optional `memoryUsed`, the ids of the entries the run relied on, and the memory-writing block (below) asks for it of any answer whose schema has the field — asked of the field, never of an action. The claim is checked (invariant 5): an id the run was not given, by a `memory_delivered` event of its own or of an earlier run on its item that shares its thread (a continuation answers from a conversation that already holds that memory), is taken out of the parsed result the engine acts on, and the run's log records a `memory_used` event with the ids kept and the ids dropped; `raw` keeps the answer as written. An answer without the field records nothing, which is not the same as one that used none. Two counts follow, both runs and not events: per run, `runs_list` shows how many distinct entries it was delivered and how many of those it said it used (`memoryDelivered`, `memoryUsed`, null on a side call); per entry, `memories_search` and each active entry in the Memory section show how many runs it was delivered to and how many used it (`deliveries`, `uses`), so an entry delivered often and never used stands out. Both are read from `run_events` through partial indexes over those two event types (migrations 0127 and 0151); no count is stored. On Codex, whose strict schema needs every key, a `memoryUsed` left out arrives as null and is taken out like any absent field, inside review's verdict union too.

**Agents write to memory two ways** (EO-479). The `eo` server's `memory_note` takes a scope — `project` (or the project's own scope id, which agents shown it write as often), the id of a workspace the run works in, or that of the container its item is filed under (EO-596) — and at most 1,000 characters, and is listed only for an agent whose `allowedTools` grants it and only on a turn told its scopes. Every agent holds the grant unless a person took it away from that one (EO-593): migration 0126 gave it to the implementer, reviewer and system agent, 0148 to every agent of any other role, and every agent made since — on the Agents screen, with `agent_save`, by staffing a template's role or importing a pack, though not a template Preview's agent on `fake` — is given it as it is made (`withMemoryNoteGrant`: appended to its `allowedTools`, or a list of only it where there is none, which narrows nothing). Taking it out of one agent's `allowedTools` is how a person stops that agent writing memory, and saving it again does not put it back; 0148 leaves an agent of the three roles without it, since by then that was a person's doing. Writing memory changes what later runs are told, never what any agent is dispatched with, so invariant 11 is untouched.

**How to write memory is EO's to say, not a role prompt's** (EO-593). Every turn served `memory_note` — the agent holds the grant and the turn has a scope to write to, the `eo` server's own rule for listing it — is given one block, `## Writing memory`, appended after the memory section, or alone where no scope holds an entry or delivery failed (`memory/writing.ts`). It is the same whatever the agent's own instructions say, so an agent a person made with their own is told exactly what a shipped one is: that the tool writes at once, that later runs on other items are given what it writes, and that a person can edit or retire it; `MEMORY_NOTE_DEFINITION` word for word; one fact per note within the 1,000 characters; each scope the run may name, `project` and each workspace's id, with what belongs in which; to write only what was checked; and that nothing about the run itself — what it did or found, its progress, its answer — is a note. It names the tool as the memory section names `memory_read`, the same text on both backends (invariant 12, `providerParity.test.ts`). It is asked of the grant and the scopes, never of the role or the action. Unlike the memory section, it goes on every send of such a turn: a dispatch, a reply to a parked run, a continuation after an interruption, a corrective turn and a recovery after a restart (`memoryWritingFor`, one predicate for all of them). The last three choose no memory again, but a thread being carried on cannot be assumed to hold the block already: one opened before it existed, by an agent 0148 has since granted the tool, holds none. The implementer's, reviewer's and system agent's prompts carried a paragraph of their own about memory until then; it is gone from all three, and the texts that still had it (implementer and reviewer v14, system agent v36) are in `SHIPPED_PROMPT_HASHES`, so an agent still on one of them without recorded provenance is brought up to date while an edited one is left alone. As with every write an agent makes (§13.1), the server cannot write and hands the call to the main process over the agent write bridge, which applies the rules against the item's scopes now (`checkMemoryNote`), writes the entry with the run and its item as its source, and answers — so the tool says "noted" only of a note that was. Most runs never call it, so when a run ends — succeeded, failed or awaiting input, not cancelled or interrupted — EO also extracts: one `memory_extract` side call (§12.2) on the run's backend, inside the run, after its item has moved and before its slot is given back, with a 60-second limit (`memory/extraction.ts`). The slot is held through it on every path: a dispatch's lease counts it, and a run with no lease — a reply to a parked run, a recovery, a mention's reply — is counted against the global limit until its extraction returns, though its row is already terminal and the scheduler's active runs no longer list it. It is given the item the run worked on — its title, description and acceptance criteria, under a heading of their own (EO-592) — how the run ended and the result key it reported where its answer named one (the `result` field), the run's final answer (or the last thing it said, when it has none), the comments it posted, the names of the tools it used, what people said on the item since this agent last ran, and the active entries of the scopes the run could write to, and answers with at most five notes or none — an answer of none is its own outcome, `nothing_to_save`, never a write of nothing, so a miss can be told apart (EO-511). How the call ended — `written` with the entries and any refusals, `nothing_to_save`, or `failed` with its reason — is appended to the run's log as a `memory_extracted` event, and drawn as one line in its transcript; a run extraction was not asked about gets none. What it holds a note to is one definition in core, `MEMORY_NOTE_DEFINITION` (`packages/core/src/memory.ts`), which its prompt (`MEMORY_EXTRACT_SYSTEM`) carries word for word and the memory-writing block gives every agent served `memory_note`: a note is something a later agent working on something else would get wrong or lose time over without, and would not see by reading the code — how to build, run or test the project, a rule the whole project follows for any change, generated files, a trap, a decision a person made — and it must pass one test, *would a later agent need this after this item is finished?* So what is wrong, missing or still to do in the work under way, however it is worded, is not a note, nor is anything restating what the item asks for; the item is shown so that the extractor can tell the two apart. Nothing in it, nor in what extraction does, turns on the role that ran, the action or what the run decided: the item and the definition draw the line, because an agent a person creates is held to the same line as a shipped one. The prompt is measured on both backends' small models by an opt-in live test (`extraction.live.test.ts`, `EO_LIVE_MEMORY=1`): six fixture runs — one stating durable facts, one that learned nothing, one reporting defects in the change under way, one restating its item's criteria, one mixing defects with a trap that outlasts the item, and one stating a known gap its change leaves — each held to the wanted answer in four attempts of five. Each is held to `memory_note`'s rules and written with the run as its source, marked `extracted`. Nothing is asked for a run that called `memory_note` itself, has no scope to write to, produced fewer than fifty words of prose, or ran on a preview; a failed call writes nothing and is not asked again, and nothing about it can change where the item went.

**A gap a run leaves is the reviewer's to judge.** Unfinished work written down as memory is read by agents and seen by nobody, so `MEMORY_NOTE_DEFINITION` says that a gap the work leaves once it is finished, and something wrong in the project a note would only work around, such as a comment or document that says the wrong thing, is said in the run's answer and is not a note; a trap nobody has said should change still is one. What happens to it there is review, and nothing else. The implementer's prompt says nothing is left for later: finish what the story needs, keep out what it puts out of scope, and state anything else plainly in the `handoff`. The reviewer's says that such a line, however it is worded, is a finding: it blocks the work as one the reviewer found itself would when a criterion or the story's stated purpose does not hold without it, or the change itself left something broken. It does not when the story puts it out of scope, a person settled it on the thread, or the change neither touched it nor made it worse and the story still does what it set out to. Where the story is silent and only a person can say, the verdict is `needs_user_input`, so the rule adds no criteria, and a line that leaves nothing wrong is feedback. EO proposed these as follow-ups for a while (EO-595 to EO-609, tables dropped in migration 0154), a side call lifting gaps out of a run's answer into a File it or Discard on the thread. It is gone because it took them out of the one place they could be acted on: every ticket left one or two, each filed one left more, and a reviewer reading a gap already labelled as someone else's work approved the change that left it. The comments it posted stay as history, with their buttons and open mentions removed, and `memory_extracted` events already in the log keep what they were written with, the `follow_ups_only` outcome included.

**A note may retire the entries it corrects or repeats** (EO-594). Left to themselves, corrections pile up beside what they correct: EO-585's "Known gap…" and "Supersedes the earlier 'Known gap' note…" were both delivered for days, and one trap was noted six times by different runs before a consolidation folded them. So `memory_note` takes an optional `replaces`, a list of entry ids, and so does each note an extraction answers with (`MemoryExtractionSchema`, defaulted to none, so the JSON Schema a strict structured output is held to lists it while an answer without it still parses). Each id must name an entry that is active, written by an agent's run — a person's never qualifies, as consolidation never touches one — and in one of the scopes the run was given; one that is not refuses the note whole, with a sentence naming the id, and nothing is written or retired (`supersedeProblem`). Otherwise the named entries are retired as `superseded` and the note is written in one transaction (`noteMemory`, `db/repos/memoriesRepo.ts`), so a correction and what it corrects are never both active, nor neither. The new entry names them in `superseded_ids` (migration 0149) — a list, since one note may fold several, beside `replaces_id`, which holds the one version an edit replaced — written with it and never changed, so `memory_get` on it lists the entries it superseded, as it named them, a restored one included. A superseded entry is a retired one like any other: `memory_restore` and the Memory section's Restore return it to active, leaving the note as it is, and the panel says "Superseded by a newer note". On a project an organisation's record holds, the device holds the ids to the run's scopes against its replica before it asks — which of a project's workspaces a run works in is the device's word — and the record holds each again to being an active agent-written entry of the item's project, then answers with every row the write changed (§17.4). Nothing used to show an agent what memory held before it wrote, so a run repeated what was already there (EO-611): `memory_note`'s answer names each active entry in the note's scope that `duplicateSimilarity` puts above `NEAR_DUPLICATE_SIMILARITY`, the measure consolidation uses, with its id and body, closest first, or says there are none. The note is written in every case, since nothing is refused for being similar and a run still decides what to write. Where one repeats or is corrected by the note, the agent writes again naming in `replaces` both that entry and the note it just wrote, whose id the answer gives, because naming only the old entry would leave the fact in two notes. A person's entry can appear, marked as a person's, and is refused in `replaces` as ever. The list is read after the write, from the database the run reads, which on a project a record holds is the replica the record's answer has just been copied into. Extraction is not shown it. When to use it is in the memory-writing block, the same on both backends: a note that corrects an entry memory holds, or says again what one already says, names it; only an agent's, never a person's, whose entry an agent leaves to them and corrects only in its own words. The memory section shows each delivered entry's id for that, and `memory_read`'s listing every active one's; extraction is shown each existing entry's id and whether a person wrote it, and told to name the entry a correction corrects. Extraction drops a note that says word for word what its scope already holds, but never one that names entries it replaces — a fold of two copies of one fact says the same as both — which the write's own rules decide; and what such a note retires stops counting as held for the notes after it in the same answer.

**Memory is kept bounded by consolidation, without asking anyone** (`memory/consolidation.ts`, `memory/consolidator.ts`, `db/repos/memoryConsolidationsRepo.ts`). Each scope holds at most the `memoryScopeMaxEntries` and `memoryScopeMaxChars` guardrails — 200 active entries or 40,000 characters, whichever comes first — so a step in one workspace draws from at most 400. A scope is queued for consolidation when it reaches either cap — whoever's entries took it there — and is newly over it: never settled, written to by anyone since it was last settled (a consolidation, as of when it read its entries; a skip; a restore), or settled under other caps because a guardrail changed. It is also queued when more than a day has passed since its last consolidation and at least five runs have been given its memory since, counted by when their `memory_delivered` events were written rather than when the runs were made (a partial index over those rows keeps that from reading every transcript). At most one consolidation per scope is queued or running, and they run one at a time, never while the engine is paused nor while pipeline work is waiting or going (below); pausing stops one already running, which changes nothing, is recorded as `paused` and gives its global slot back, and the scope is asked again a minute after EO is resumed (EO-514). After each one every scope is looked at again at once.

- **What it is.** One `memory_consolidate` side call (§12.2) — one per batch, for a scope too large for one (below) — on the system agent's backend, model and reasoning effort, or its consolidation override (EO-578), made on its own — no item, no run — so it takes a global concurrency slot and holds it (invariant 10), and its cost is recorded against the scope's project. It is given the scope's agent-written entries with their ids and the dates they were written, and for a workspace its own `CLAUDE.md` and `AGENTS.md` where present — for a project, each of its workspaces', named with the workspace and sharing the room one workspace's are given, since a project entry is read in every one of them (EO-514); on an organisation's record, which has no workspace folders, a project is given none. A person's entries are never sent, never retired by it, and count toward the cap; when they alone exceed it, that is recorded on the consolidation and they are left as written, and the agents' entries are held to a tenth of the cap.
- **What it returns.** Through its schema, the changes and nothing else (EO-573): `retire` (`{ id, reason }`), `merge` (`{ from, body, contradictsRepositoryFile }`, folding at least two entries into one) and `rewrite` (`{ id, body, contradictsRepositoryFile }`). An entry it does not name stays exactly as it is, so a large scope never has to be written out in full. It is told to merge duplicates, retire what is stale, contradicted by a newer entry or derivable from the code, and make relative dates absolute in what it rewrites. The schema holds that every id named is one it was given — a person's entry never is — and that none is named twice. About half of each cap, less what people's entries take, is its aim and not a test: where that leaves little, up to a tenth of the cap, but never more than the room left under it. A merge or rewrite says one fact, at most 1,000 characters (`MAX_MEMORY_NOTE_CHARS`, what a note may hold) (EO-591): the first batched consolidation of a large scope wrote 1,500-to-2,000-character topic digests bundling unrelated facts, which selection can only deliver whole and which made answers long enough to run out of time. So the prompt tells the model to split a topic into separate facts rather than exceed the limit, and an answer with a longer one, in a batch or in the cross-batch pass, is refused as `schema`. An answer that makes the scope smaller, in entries or characters, is applied however far short of the aim it falls; one that would leave as many entries in more characters is refused as `schema`; one with all three lists empty is a valid answer that changes nothing. Where the workspace's file and an entry disagree the file is current, unless the entry is plainly newer and says it corrects the file: that entry is kept, and a merge or rewrite carrying it sets `contradicts_repository_file`. The file is never edited.
- **What EO does with it.** In one transaction, as one consolidation: a retired entry, and every entry a merge or a rewrite replaces, is retired as `consolidated`; each merge and rewrite is written as a new entry with the source and age of the newest entry it replaces, and a rewrite that is its entry word for word with the same flag is no change at all. All of them are tagged with the consolidation's id (`memory_consolidations`, which also lists exactly what it retired and wrote). If an entry it was given was edited or retired while it ran, nothing is changed. Entries written while it waited for its slot or ran are not in what it was given and are left as they are; they count as a change since it settled the scope, so if they took the scope back to a cap the next consolidation follows straight away.
- **In batches** (EO-574, `memory/consolidationBatches.ts`). A scope's whole set in one call is an answer too large to produce — EO's own project scope, at 111 entries and 56,000 characters, failed eight in a row — so a scope whose agents' entries do not fit one batch of 30 entries or 15,000 characters, whichever comes first, is cut into batches. Related entries tend to share one: each batch starts from the oldest entry not yet in one and grows by the entries the full-text index (EO-545, `similarMemoryNeighbours`) ranks most like it, then theirs, filling from the next oldest when they run out; where the index cannot be asked, batches go by age. Each batch is one call, told which batch it is and asked for the scope's target in its share, and its answer is applied on its own as its own consolidation, so each can be restored on its own. Every row of a run starts at the moment the run read its entries, and together they settle the scope as of then: what any of them wrote is the settlement's own, and an entry somebody wrote while the run went on — absent from its plan, whichever batch it was written during — is a change, so a scope still over its cap is taken up again at once. They run one at a time; a scope queued for its cap stops as soon as it is under its caps. A batch that fails ends the run there, leaving the batches before it applied, and its row backs the scope off as any failure does — a failure since the scope was last settled is itself a reason to take it up again, over a cap or not, so the retry waits neither for somebody to write to the scope nor, for a run on the schedule whose earlier batches made it the last consolidation, for another day and five runs — and the retry takes up the entries no batch of that run had, which the consolidator remembers in memory for two days and only while that failure is the scope's last consolidation (after a restart, or past either, it starts again from every entry). A pause between two batches is recorded as the next one stopped by pausing. After the last batch, the **cross-batch pass** looks for duplicates that fell into different batches: one call is shown only each remaining entry's id and first line and answers with groups that may be duplicates (`MemoryMergeCandidatesSchema`), and a last small call is given those groups' full bodies, as many whole groups as fit one batch, and answers with operations — given no repository files, which the batches already checked against. Both are one consolidation; no candidates is one that changed nothing.
- **Duplicates, without a model** (EO-576, `memory/duplicates.ts`). Before a run asks anything, agents' entries that repeat another word for word — once case and whitespace are normalised away and so is the only punctuation that cannot change what a note says, the sentence marks `. , ; : …` at a word's end and the backticks around inline code (`normalisedBody`), and with the same repository-file flag; every other mark — one inside a word, a sign, an operator, a bracket, a quote, `!` or `?` (`!=`, `-1`, `(a + b) * c`, `'a'`, `println!`) — is kept, so two notes differing only in one are left to the model — are folded with no side call: each set keeps its newest entry and the rest are retired as `consolidated` under one consolidation of their own, which a restore undoes like any other and whose note says so. A scope queued for its cap that this alone brings under its caps asks nothing more. Of what is left, pairs the full-text index names as each other's neighbours (`similarMemoryNeighbours`) and whose share of the index's trigrams in common (Dice's coefficient, `duplicateSimilarity`) is above `NEAR_DUPLICATE_SIMILARITY` are likely duplicates: they are not merged blindly but joined into groups no larger than a batch, each group placed whole in one batch (`planBatches`), and each member marked in that batch's input with the others it likely repeats, so the model's decision about them is cheap. Where the index cannot be asked, nothing is marked. A person's entry is never folded, marked or sent.
- **Never stalling the pipeline** (EO-577). A consolidation holds the global slot for as long as its call runs, and the failing project scope above held it for two to five minutes at a time, every few hours, for calls bound to fail. So consolidation is pipeline work's last in line. It starts only while the pipeline is idle — no item the tick could dispatch (`hasDispatchableItem`, asked of the same eligibility the tick decides with, so an item whose agents are all busy still counts) and no run in flight (`slotsOfRuns`) — and so does each batch of it and the skill proposal call after it; what is queued stays queued and starts once the last run ends, rather than queueing for the slot ahead of the next dispatch. A batch that would have started while work waits, or whose call gave way at the slot, is recorded as `deferred`: like `paused`, nothing went wrong, so it is looked at again a minute later, neither backs the scope off nor counts towards its being stuck, and its retry takes up where it stopped. Each call is cut off at 180 seconds (`MEMORY_CONSOLIDATE_TIMEOUT_MS`) or 24,000 output tokens counted as above (`MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS`), whichever comes first, and either is recorded as a `timeout`, with what the call spent. The two are in line (EO-591): at the 90 seconds first allowed, a batch written at Opus 5.5's 125 or so tokens a second was cut off at about 11,000 tokens, under half the cap, and one that passed took 88.7 seconds. Failures back a scope off an hour after the first in a row, four after the second and a day after the third and every one after (`CONSOLIDATION_BACKOFF_MS`); a budget refusal waits for the budget, and a change, a pause or a deferral a minute, as before. At the third failure in a row, EO posts one note on the project's thread (§7.1) — a note, not a question, mentioning nobody — naming the scope, what it holds against its caps, the last failure's reason and sentence and when it is next tried, and saying that nothing else waits on it; the scope keeps being delivered and written to as it is. It is marked on that failure's row (`stuck_noticed_at`), so the same run of failures is not said again, and only a success, which ends the run, lets the next one be said. A scope on no project has no thread, and has it said in that failure's note instead. Each consolidation records how long its calls held the global slot (`slot_held_ms`), the skill proposal call's included on the consolidation it is posted under; one that made no call held it for none.
- **Asking for one now** (EO-589). Consolidation starts by itself, and a scope that keeps failing waits a day between tries — right for an unattended loop, wrong for a person who has just changed how consolidation works and wants to see it on real data. So a person can ask for one scope now: `memory:consolidateNow`, the Memory section's Consolidate now button (below), or `memory_consolidate_now` on the MCP host. The supervisor, which owns the consolidator, queues the scope with the trigger `manual`. It skips the due rule and the backoff: it runs whether or not the scope is over a cap or has had its day and five runs, and however many failures in a row it is backing off from. It keeps everything else: at most one consolidation per scope queued or running, one at a time, only while the pipeline is idle, never while the engine is paused, and the same batches, cross-batch pass, limits and skill proposal call, on the same rows in `memory_consolidations`. One that fails is recorded as any failure is, and counts towards the backoff of the automatic tries after it. The answer is a sentence and a typed result: `started`; `queued`, behind pipeline work (it starts once the pipeline is idle) or behind another scope's consolidation; `already` queued or running, with nothing added; or `refused`, saying why — the engine is paused, the scope holds no entry an agent wrote, no scope has that id, or the scope's project is held by an organisation's record, which consolidates it and which this desktop leaves alone (EO-482; the request is not routed there). Whether one is queued or running is `memory:consolidations`'s `pending`, and a `memory:changed` push says when a scope's consolidation is queued, starts or ends.
- **Undoing one.** `memory:restoreConsolidation` puts back the set from before a consolidation in one action — what it retired is active again, what it wrote is retired — and counts as the scope being settled, so the next look does not fold the restored entries straight back; `memory:consolidations` lists a scope's consolidations to choose from.
- **Proposing skills** (EO-483, `memory/skillProposals.ts`, `db/repos/skillProposalsRepo.ts`). A memory entry holds a fact; a procedure that keeps appearing in a scope's memory belongs in a skill (§13.3), chosen by its description and read when needed rather than sent with every dispatch. So once a consolidation run of a scope has succeeded — every batch it made applied, and its cross-batch pass where it had one — EO makes one more side call of its own (EO-575), on the same system agent's model and reasoning effort as the consolidation (EO-578): never inside the consolidation's answer, whose operations would otherwise have to carry whole SKILL.md drafts beside them, and never after a run that failed or stopped part-way, whose retry asks instead. It is given the scope's active agent-written entries as the consolidation left them, with their ids, days and items (never a person's), the existing skills in the scope and the global ones, and every proposal a person discarded in the scope (`skillProposalsInput`, `MEMORY_PROPOSE_SKILLS_SYSTEM`), and answers with up to three skill proposals (`MemorySkillProposalsAnswerSchema`), each `new` or an `improvement` to one of those skills (named by slug in `target`), with a slug, a name, a one-line description, the scope, its evidence — the ids of the entries it was seen in and the items those came from — and a SKILL.md body with Trigger, Steps and Verification sections, below frontmatter EO writes from the slug and description. Its schema refuses an improvement with no target, and EO checks what the schema cannot say: the scope is the one asked about, the evidence is entries it was given and their items. The proposals are posted under the run's last consolidation. A proposal call that fails changes nothing: the consolidation is already applied and stays so, nothing is posted, and why is a sentence on its note. These are the only source of proposals; there is no mid-run tool for agents. Each proposal is posted on the project's thread (§7.1) as one comment that mentions the person and says what the skill is for, lists the evidence with links to the items, attaches the draft as `SKILL.md` (and, for an improvement, `SKILL.md.diff` against the skill as it is), and offers Save and Discard. **Nothing is saved until a person presses Save**: a skill changes what agents are dispatched with, which no step-owning agent may decide (invariant 11), so the press is the gate. A step-owning agent cannot press it: what it says reaches the thread as the agent's, and only a person's reply is read as an answer. The system agent can, and that is allowed rather than overlooked (EO-514): its `comment_post` over `eo_admin` writes as the person, and invariant 11 makes deciding what agents are dispatched with its job — it already holds `skill_save` and `agent_attachments_set`, so refusing its Save would gate nothing it could not do directly, and the entries Save retires come back with the consolidation, as those a consolidation retires on its own do. The same holds for a client of the person's own on the external MCP host, which acts on a credential the person handed it. Save is a reply on the thread, read as `answerSkipOffer` reads one (§9.2): a new skill is created in the proposal's scope and attached to the agents whose runs wrote the evidence; an improvement replaces only the target's body, leaving its scope and attachments — the target being the skill it was posted against, held by the id recorded then and never looked up by slug again, so one that has since been renamed, archived or had its slug taken by another skill is refused rather than applied to whichever skill now answers to the name. Then the evidence entries — named as the consolidation left them — are retired as `moved_to_skill` with the consolidation's id, so restoring that consolidation brings them back, along with what it replaced. The exception is an entry the run's consolidations wrote by folding two or more entries into one, or by rewriting one that was (`coveringEntries`, from the run's own record of what each wrote from what, kept across a retried run's batches): it may hold the procedure together with an unrelated fact, and nothing EO keeps says which of the folded entries held the procedure, so Save leaves it in memory, and the proposal says so, rather than lose that fact. The call is also told to name as evidence only entries that hold nothing else worth keeping. Once the proposing consolidation has been restored, Save is refused before anything is written — that consolidation's restore is spent, so nothing retired under its id could come back — and the proposal no longer holds back a later one. A published packs or agents section refuses Save as it refuses the Skills screen. The proposal's row, and the memory, skills and agents Save changes, belong to the database whose consolidation posted it, while its comment is on a thread every device shares; so a press is carried out where that row is, whichever machine it was made on — locally from `comments:post`, on a desktop as the reply is pulled from the record (`drain.ts`), on the record as a device's reply is applied (`serveRecord.ts`) — once, by the row's `open` status, with EO's answer travelling back as an ordinary comment. Discard keeps a record of the proposal, and a later consolidation posts nothing for one with the same scope and slug, whatever its description says (EO-512) — a model rewords a description freely, and what the person turned down was the skill — nor for one still waiting on the thread, matched by its fingerprint: scope, slug and description lowercased with punctuation folded. Each proposal call is shown the scope's discarded proposals, slug and description, and told not to propose them again under any slug. The discard holds until a person replies **Propose again** under the proposal, as EO's own answer to the Discard tells them; that removes the scope's discard records for the slug, carried out where the row is as Save and Discard are. A proposal whose slug is taken or whose target is gone is posted with that sentence and Discard only. Whatever could not be posted is a sentence on the consolidation's note; the consolidation has already succeeded and stays so.

**A container's memory lasts as long as the work under it** (EO-596, `memory/containerScope.ts`). About fifteen of the 43 entries the eight trial stories EO-581..588 wrote were only about the trial work in progress — maps of the new code, findings, gaps — and sibling stories used them, then they sat in the project scope for good. So the third scope kind, `container` (`MEMORY_SCOPE_KINDS`), holds what is only true while the work filed under one container item is in progress; its id is the container item's, and its entries carry the container's project, so they travel to an organisation's record and back as a project's and a workspace's do (§17, `record/memoryReplica.ts`). Which items it reaches is asked of the type's container flag and the item's parent, never of a type's word (invariant 13): a run on an item whose parent is a container on a project is given the container's scope beside the project's and the workspace's (`containerScopeOf`, `memoryScopesFor`), may read it with `memory_read`, and may write to it with `memory_note` — and so may its extraction — naming the container's id; a run on any other item is not given it, and a note naming it is refused as a scope the run does not work in, on a desktop and on the record alike. The memory-writing block lists it with when to use it: what is only true while this work is in progress, what the other items under it will need after this one is finished and nobody will once all of it is. It is capped and consolidated like any scope, and a person reads and corrects it in a Memory section on the container item's own page. **It ends when the work does.** Once every item filed under the container stands on a terminal step of its own version (archived ones included; a container with nothing under it has not started), the consolidator's next look — and a move of an item under a container prompts one at once — queues one consolidation of the scope with the trigger `container_done` (`containerDoneDue`), and only where the scope holds an entry an agent wrote: a container with none queues nothing. It runs through the ordinary consolidator — only while the pipeline is idle, in batches where its entries do not fit one call, each on its own row and applied on its own, backing off on failure — but is told something else (`MEMORY_CONTAINER_DONE_SYSTEM`): the work is finished, and it answers only with the facts that will still hold (`keep`, each drawn `from` one or more of its entries, at most 1,000 characters). EO writes each as a new entry of the container's project, with the source and age of what it is drawn from, and retires every entry it was given as `consolidated` (`applyConsolidation` with `writeTo`). There is no cross-batch pass and no skill proposal: nothing is left in the scope to compare, and what was kept is the project's to fold with the rest. The queue holds a scope as it was when it was looked at, and work can resume under a container at any moment — a rejection reopens an item, a new one is filed under it — so whether the work is still finished, and not restored since, is asked again before each batch starts and again with each answer in hand, in the same synchronous stretch as the write (`containerStillFinished`). Where it no longer is, nothing is retired or written by that batch: its row is `skipped`, saying why, with no backoff, and the scope is queued again once the work finishes again. Restore on its row puts the container's entries back and retires what it wrote in the project, and a restored `container_done` is a person keeping the container's memory: it is not queued again until the work under the container finishes again. A person's entries are never sent, so they stay as written.

**A person reads and corrects memory in settings** (EO-481). Each project in Projects and each workspace in Workspaces carries a Memory section — and so does each container item, on its own page (EO-596) — closed until opened and saying how many active entries the scope holds. It lists the active entries newest first, each with its source — a person, or the item the run that wrote it was on, linked, with that item's runs beside it — and how many runs it was given to and how many used it (EO-597, above), and marks the ones extraction wrote and the ones a consolidation kept although they contradict the workspace's `CLAUDE.md` or `AGENTS.md`. A person adds an entry, edits one, retires one and restores a retired one; each consolidation is one row with its time and how many entries it replaced, and Restore on one that succeeded undoes it. At the top of the section, above Add entry and the entries so it is in sight on a scope of a hundred entries and more (EO-591), Consolidate now asks for the scope to be consolidated at once (EO-589) and shows EO's answer, with the consolidation history after it, newest first; it is disabled, with the reason, while one of the scope's is queued or running, while EO is paused, and where no active entry was written by an agent, and the list is read again when the consolidation ends. Every action is one of the `memory:*` commands above, so nothing the panel does is possible only from the panel. On a project an organisation's record holds, each of those commands is asked of the record, and the memory arrives on every desktop by its sync (§17.4). What is listed and every write are one module (`renderer/src/memory/memoryPanel.ts`), drawn with the chat layout's kit.

### 7.6 Agent to agent

A person mentioning an agent in a thread dispatches it directly, with a respond action, outside the pipeline's routing. Agents may mention each other too, behind two guards. A mention aimed at a person can only be resolved by a person. And agent-to-agent hops are counted on the item since the last human comment: past the mention-depth guardrail the dispatch is refused, the mention closed, and an escalation names the chain. A person commenting restarts the count, because a person in the thread is what makes a long exchange legitimate. The count is taken where the dispatch happens rather than in the tool, so a mention that arrived from Jira or from a module is counted like one an agent typed.

### 7.7 The timeline is two tables

Transitions live in `transitions` and words live in `comments`. They are merged when drawn — "moved to Review by the implementer" between the comments on either side — and never by writing system events into the comment table, which the context assembly would then have to filter back out.

### 7.8 The output is a comment

What a step produced — the report, the reply, the draft — is a comment of kind `output`, with attachments. The current output of an item is the latest such comment, derived the way attention is. A person's edit posts a new output comment and the one it replaces stays in the thread. The next step's context receives the current output, so a send step sends what the approver corrected. No new table, and one channel.

---

## 8. Items and item types

### 8.1 One work entity

There is one entity that moves through a pipeline, however it came to exist. A scheduled run and a webhook are not different kinds of work; they are different ways of *creating* an item. Once created it sits on a step, has a thread, gets escalated and gets archived, and everything is keyed on it: dependencies, comments, mentions, runs, transitions.

An item has a key from its project's prefix and a counter, a type, a parent, a title, a markdown body, structured fields (`spec`), a priority, the pipeline and step it is on, the pipeline version it entered on (§17.4), the workspace it works in, who created it, and — on a person's step — who it is assigned to.

**Dependencies** are edges in `item_deps`. Acyclicity is enforced on insert, and an item with an open dependency is not dispatched. The dependency graph is the main lever against semantic conflict: when a plan says which paths each item touches, overlapping items are serialised, so parallelism becomes an output of the graph rather than a setting.

**Changing an item's dependencies.** They are set when work is filed, and changed later through one shared function (`roles/itemDependencies.ts`) behind two doors: the assistant chat's reorder card, which a person approves, and `items:update` — the item screen, and `item_update` with its `addDependsOn` and `removeDependsOn` lists of keys or ids. The whole change is judged before anything is written, against the live graph with its removals taken out and its additions merged in: an item that does not exist, the item itself, one on another project, an edge to add that is already there or one to remove that is not, or a cycle refuses the whole change, naming the items by key, and nothing is written. Whether the item may change at all is the rule an amendment is held to (`refuseIfUntouchable`): not while an agent holds it, in review, or once it is finished. An applied change posts one engine comment on the item saying what it now waits for, what it no longer waits for and who asked; a removal that leaves a waiting item with nothing open frees it at the next tick, and the answer says so. On a project the organisation's record holds, both doors ask the record to make the change (§17.4).

**Parents.** An item whose type is a *container* holds other items and is not itself work. It sits on no step; its state is derived from its children in both directions — every child finished closes it, one child reopened reopens it.

**Pack state on an item** lives in `item_extensions(item, extension, data)` rather than in columns: the git workspace keeps the branch and pull-request address under the `git` extension, and Jira sync keeps its key and sync state under `jira`. An item on a workspace with no repository does not carry null git columns.

### 8.2 An item type is data

A type is a row in `item_types`, scoped to a project and namespaced by the pack that shipped it, so two packs may both ship a "case" and the picker shows "Case (Support)". It carries:

- **labels**, singular and plural;
- **a container flag**;
- **a spec shape** — a JSON Schema for the item's structured fields, and which of them it must arrive with. It is what creation validates against and what the assistant's proposal schema is composed from;
- **action overrides** — what an action means on this type. *Refine* on a container decomposes it into children, and on a leaf clarifies what is already written; the schema the answer is held to, the result key reported and the comment posted all follow from that one fact, so it is stated once, on the type.

The developer pack ships three: **feature** (a container), **story** (which must carry at least one acceptance criterion — it is what the implementer's claim is checked against) and **bug** (which carries its reproduction fields). The other gallery templates ship their own — a report, a message, a draft.

A person may create a type in the app, scoped to the project: labels, the container flag, and fields of kind text, number, yes/no or list. None of that is code. A hand-made leaf type inherits the leaf defaults for every action.

### 8.3 How items come to exist

- **Through the assistant.** A person describes what they want; the assistant asks its questions and proposes items; the person presses Create (§11).
- **Through a job** — a manual run, a schedule, a webhook, or a conversation (§9).
- **By hand**, from the new-item form.
- **From Jira**, one issue at a time, when the developer pack's Jira connector is bound (§19.3).

### 8.4 Archive and delete

An item is archived automatically once it has been finished for longer than the archive delay (fourteen days unless changed; a daily sweep). A container is archived only when every child is, and a parent is kept while any child is not eligible. Archiving removes nothing: the item leaves the board and the scheduler, an engine note says why, and Restore brings it back.

Deleting an item is the one act that removes `run_events` rows. It is a person asking for an item to be gone, behind a confirmation that says exactly what goes with it: the items under it, its runs, its recorded spend. Discarding a trial pipeline (§11.5) deletes its trial items by the same path.

---

## 9. Jobs

A **job** is the recurring definition that stamps out items: a **trigger**, a **pipeline**, a **template** for the item (type, title and body, with blanks such as the date), and an **owner** — the person whose inbox it fills and whose budget it draws on.

### 9.1 Trigger kinds

There are exactly four (`JobTriggerSchema` in `packages/core/src/schemas/jobs.ts`):

| Kind | Fires |
|---|---|
| `manual` | When a person presses *Run now* |
| `schedule` | On a calendar — daily at a time, weekly on a day, or a five-field cron expression — in a stated time zone, with a catch-up grace in minutes |
| `webhook` | When a signed event arrives at the job's address on the organisation server |
| `from-discussion` | When a person presses Create in the conversation the job is tied to |

### 9.2 What a job records

Each firing is a row in `job_occurrences`, with the time it was due and a status of `fired`, `skipped` or `failed`, a reason, and the item it created. A webhook job also keeps `job_events`: every event received, its payload, and an outcome — created, deduplicated, bad signature, outside the time window, unreadable, held, or over the cap. Both are records, as `transitions` is; neither is a channel.

**Each job owns one off-board item as its thread.** A guard that fires when there is no item to comment on — a skipped occurrence, a tripped budget — posts there and mentions the owner. So every guard still ends in a comment, there is still one channel, and the inbox works unchanged. Each project has one the same way — its project thread (§7.1) — for what belongs to the project rather than to any job or item.

A job's past items are not a separate history: they are the board and the archive, filtered by job. An item shows where it came from — the job, the trigger, the occurrence.

### 9.3 Schedules, and a machine that was off

A job placed on a device runs while EO is open on that machine. On launch EO computes the occurrences missed since the last one: those within the grace window (180 minutes unless changed) fire, and the rest are written as skipped. A skip posts to the job's thread and mentions the owner, offering to run that occurrence now.

If the previous occurrence's item is still open when the next comes round, the new one is skipped the same way: no duplicate work, and the person is told. A paused job skips too. The three skip reasons are exactly *offline beyond grace*, *previous still open* and *paused*.

### 9.4 Controls

A job can be paused by hand; it has an optional budget per occurrence, and tripping it pauses the job with the reason shown; a webhook job has an optional cap on items per hour, beyond which events are held and shown as waiting.

### 9.5 Where a job runs

A job carries **Runs on**: `device` (this machine, the default) or `server` (the organisation server). EO works out what each choice would require from what the pipeline needs, and refuses a placement where something would be missing rather than letting the job fail quietly. The reasons are exactly:

- bound to the machine — a step's agent uses a **personal sign-in**; a secret it reads is **personal**; its **workspace is a local path**; an **MCP server** it is served is configured on this machine only;
- bound to the server — a step reads an **organisation secret**, or is served an **organisation-only MCP server**.

The unavailable choice is shown with each reason beside it, and each reason carries its fix or "Ask your admin."

### 9.6 Webhooks

A webhook is `POST /webhooks/<path>` on the organisation server, since only a server has an address the outside world can reach. The sender signs each event: an HMAC-SHA256, under the job's secret, over the timestamp, a full stop and the raw body, sent with the timestamp in a header. EO compares in constant time, refuses a timestamp more than five minutes off, refuses a body over one mebibyte, and limits attempts per path. Each event has a key — a field the job's mapping points at, or a hash of the body — and the same key never creates two items.

The job's **field mapping** uses JSON pointers into the payload for the item's title, body, event key and structured fields. The payload reaches an agent only as a quoted, untrusted block (§7.5), and a pipeline that takes webhook events straight to a side-effecting step with no person between is refused at validation (§4.3).

A module that creates items is held to the same rule as a side-effecting step. It sends nothing outside EO, and it is the same hole by another door: a module whose manifest declares `needs.create` can copy the payload into a new item's title and body, and the next agent reads those as the item's own description — the quoted, untrusted block is gone, and a stranger's event has reached something that acts with nobody asked in between. So the walk stops at a module step declaring `needs.create` as it does at one declaring `sideEffects`, a `user` step on every path before it satisfies the rule, and the sentence says what is true of that step — that it creates work from what a webhook sent, with nobody asked in between — where a step that sends keeps the sentence about sending. The engine reads the field off the manifest it is already handed.

That refusal can be lifted for one pipeline at a time. Some pipelines are meant to run with nobody in them — acknowledging every inbound form, say — so a pipeline carries a setting, `pipelines.webhook_unattended`, that is off by default and off on every pipeline that predates it. With it on, `validatePipeline` runs the same walk and reports each step it would have refused as a warning naming the step, and the pipeline publishes. The setting reaches the engine as data (`webhookUnattended`), the way `entryReachedByWebhook` does. Only a person turns it on: the control is in the pipeline's editor, shown only when a webhook job files onto the pipeline, and it states the risk — what arrives, who controls it, what it can reach. It is written by its own command, `pipelines:setWebhookUnattended`, which belongs to the pipelines section and so is refused with the section lock on a managed desktop, a diverged copy included; no MCP tool reaches it, and a `pipeline_save` that names the setting is refused with a reason instead of publishing without it. It travels from a record to its replicas and nowhere else: an export has no field for it, and an import or a moved project lands with it off. It is given for a webhook that exists: when a pipeline's last webhook job is deleted, moved away or changed to another trigger, the setting is turned off with it (`dropWebhookWaiversWithoutEntry`), so a job added later is accepted afresh. A replica takes the setting from its record even for a pipeline it has diverged, because what diverged is the graph and the setting was never the desktop's to edit. A pipeline with it on says so on its board header.

---

## 10. Workspace kinds

### 10.1 A workspace is a kind, attached to the project

Where a run works is not assumed to be a repository. A project has zero or more **workspaces** (`workspaces`: project, kind, configuration, position), an item names the one it works in, and a step may pick among the project's. A pipeline whose first step drafts in a scratch directory and whose next commits to a repository is legitimate.

A project is what a person creates, and a repository joins the project it is added to, after the workspaces already there, however many that is; adding one neither makes a project nor moves the window. Only a repository with no real project to join — none exists, or the one it would join is the gallery's Preview — gets a project made for it, named after it, and the window switches to that. Removing a project's last repository keeps the project, with its pipelines, items and notes, and nowhere to work until one is added again.

### 10.2 The four kinds

| Kind | What it is | Contributed by |
|---|---|---|
| `git-worktree` | A repository. In **isolated** mode a branch is cut per item into its own worktree and the work is verified against the tree. In **read** mode the run gets the repository's own checkout and changes nothing — what a conversation or a planning step wants. | the developer pack |
| `folder` | A fixed directory, optionally with a subfolder per item. The shared drive, the reports folder. | the core |
| `scratch` | A temporary directory per run, whose files become the item's output. | the core |
| `none` | No disk. The agent works only through MCP servers and connectors, in an empty directory. | the core |

Read mode is a mode of the git kind chosen per step, not a fifth kind: a person's mental model is "my repository", and the step editor offers "works on a branch" or "reads only".

`none` is a **real kind, not the absence of one**. A run with nowhere to work does not fall back to some process directory; it is given an empty one, and the card says "no disk". An absence is stated where the person will see it.

### 10.3 The interface

A kind (`WorkspaceKind` in `apps/desktop/src/main/supervisor/workspaceKind.ts`) answers seven questions, the last of them optional:

- **`prepare(item, action)`** — make the working directory ready and return it, or refuse with a reason and, where there is a choice to offer, options.
- **`attach(item, agent, workspace)`** — what the workspace lends the agent: MCP servers, skills, notices, and a sync to run first. For git this is the repository-intelligence server and the skills checked into the worktree.
- **`verifiers`**, keyed by action — each returns a list of checks, every one with a sentence saying what it checked and whether it passed, and each *describes* in advance what it will check. That description is what the column head's line is derived from (§4.5).
- **`release(request)`** — clean up: what a run collected, what a settled item leaves behind, what has gone stale.
- **`artifacts(item, run)`** — what the run produced, posted as the item's output: the diff over the verified range for git, the changed files for folder and scratch.
- **`capacityKeyOf(item)`** — the shared filesystem two runs would collide on, or nothing (§5.3).
- **`refusesTurn(item, workspace)`**, optional — a last gate before a backend turn starts: a reason this directory will not do, or nothing. The git kind answers it, refusing a turn whose working directory is not inside a repository, so that nothing runs somewhere it was not meant to; the other kinds leave it out, which means any directory the kind prepared will do. The supervisor asks it rather than either backend adapter, so both backends get the same answer.

What each verifies:

- **git, on `implement`** — commits exist beyond the base, the tests ran, the tree is clean, and nothing was borrowed from another item's unmerged work.
- **folder** — the outputs the step declares exist in the folder and were written during this run.
- **scratch** and **none** — nothing; such a step reads "Not checked until Approve".

---

## 11. The assistant

### 11.1 One agent, not a cast

"The assistant" is the **system agent**: an agent in the built-in `system` role. It owns no pipeline step. There is no separate planner, architect or intake role — understanding a request, breaking it into items, drafting a pipeline, writing a module and answering a question about the installation are all the same agent, asked for different things.

The built-in roles are exactly three — **`system`**, **`implementer`** and **`reviewer`** (`BUILTIN_ROLES` in `packages/core/src/registry/developer.ts`). Any other role is one a person or a data pack defined, and needs no code: an agent row carries the role, and a step names it.

### 11.2 Conversations

A conversation is an item on an off-board step, so it hosts runs, costs, attachments and a thread exactly as any item does. Each turn is a run of the system agent with a conversational action, and each answer is held to a schema: a message, optional questions, and optional proposals. A turn either asks or proposes — never both, because a proposal built on unanswered questions is a guess with a button on it.

There are two rooms:

- **The assistant conversation** — the general one, where work is planned into items and pipelines are drafted. It is the spine of the window (§16.1): there is no other place to talk to the assistant, and no window of its own.
- **The module conversation** — opened from a module, about that module's code and tests.

There used to be two more, both answered by the same agent: **Discussions**, a screen of conversations kept per project (`DISC-n`, its turns the `discuss` action), and the **Architecture panel** of the pipeline configure screen (`ARCH-n`, `configure`), both in the classic layout EO had until EO-529. Both were retired in EO-526 because everything they did is said in the assistant conversation, and their conversations were deleted rather than hidden: a one-off step at startup (`retireConversationRooms`, after `retireForgeQueue`) deletes every item on their two steps through `deleteItem` — comments, attachments and their files, runs, run events, transitions, and the `from-discussion` jobs whose thread they were — on a desktop and on the organisation server alike, each its own copy, since deletions are not replicated. Their key counters are left alone.

### 11.3 What it proposes, and what a person approves

The assistant never applies its own proposals. Each is drawn as a card and waits for a person.

- **Items.** The assistant proposes items — with their type, their structured fields, their dependencies and the paths they touch — and the person presses **Create**. This is the gate on the one handoff the engine cannot verify: a schema proves a plan is well-formed, and nothing proves it is right, so a person reads it before it becomes rows. A proposed change to existing items is the same card with **Apply change**.
- **A pipeline draft.** The person describes the whole thing — "every Monday draft the sales report, have Anna approve it, then post it to Slack" — and the assistant proposes the graph: steps, their owners, their results and the routes between them, targeting a new pipeline or an existing one. The draft is drawn as a pipeline the person can read, validated by the same validator as a hand edit, and becomes ordinary rows when they press **Publish pipeline**. They can edit any of it by hand afterwards.
- **A module.** Where a step needs a script, the assistant writes it as part of drafting the graph. A module the assistant proposes on its own, that no draft needs, gets a card of its own showing what it declares, its inputs, its code and its tests, with an **Approve** button; approving runs the tests.
- **A draft that needs modules** (EO-581) is one card with one button, **Approve and publish**, in place of an Approve per module and a Publish waiting on them. Each module the draft needs and nobody has approved is a collapsed row on the draft card: a one-sentence description, its declared needs — binaries, environment variables and secrets, network, outside effects (`sideEffects`), item creation (`needs.create`) — and how its tests last went stay visible, because the description is the assistant's claim and the needs are what the person is granting; its inputs and code are behind an expand, the view the module card's View code opens (`DraftModuleRow`). Pressing the button (`assist:approveAndPublish`, `approveAndPublishAssistDraft` in `ipc/assistCommands.ts`) runs every module's tests through the runner `modules:approve` uses and holds each to the same rule (`judgeModuleForApproval`): at least one case, every case passing, line coverage at the bar or confirmed. A module under the bar is asked about on the same card, with its figure, before anything is approved. Then one transaction reads the draft again, checks each module is still what its tests ran against, approves them all and publishes the pipeline — creating it, as **Publish pipeline** does for a new one, or saving into the one that exists through `savePipeline`, with the name and icon the card gives it. Any module whose tests fail or do not run, or a graph the save refuses, and nothing is approved and no version is written; the card names the module and the failing case under that module's row. A draft with no unapproved modules publishes through **Publish pipeline** exactly as before, and one resolving a template update the organisation's record holds is refused with what to do instead, since publishing on the record cannot share a transaction with an approval here. Without real runs this is the whole of approving a pipeline: the one card is both "this is the shape I want" and "publish it". With real runs, the same button is on the publish card after the trials (EO-588, §11.5), for the draft the trial ran.
- **A design card** (EO-587) is the draft card of a turn that planned a test with real runs. Before it drafts, the assistant asks whether to test with real runs; if so it asks for test items and, for each, the step it must end on and anything more in the person's words — and, for a pipeline that judges something, a case that must fail — and proposes each step's mode with a reason from EO's side-effect data. It returns that plan beside its draft (`trial` on `AssistOutputSchema`, `AssistTrialPlanSchema` in `packages/core/src/schemas/assistTrial.ts`, in the draft's own step ids and with each test item named by a key), and the schema refuses a plan that names a step the draft does not have, leaves a step that runs something without a mode, redirects or mocks a person's or terminal step, or mocks a result the step does not declare. The card shows the graph, every module the draft runs as a collapsed row as above, the test items with where each must end, and every step's mode with its reason and whether EO classes the step as sending or creating outside EO (`assist:draft`'s `trial`, `designCardView` in `main/trials/designCard.ts`). It has **Approve design** and no Publish. Approving it (`assist:approveDesign`, `approveTrialDesign` in `main/trials/design.ts`) means "this is the shape I want" and publishes nothing: in one transaction the draft becomes a trial pipeline (§11.5), every module it runs is granted trial-only permission within the needs it declares, the approved design is recorded on the trial, the test items are filed as trial items and the first round is started.

When a section is locked by an organisation (§17.3), the assistant's edit is refused with the same answer a person's would be, and it offers to send the change as a suggestion instead.

### 11.5 Trial pipelines

A draft can be tested with real runs before it is published (EO-580). Items cannot stand on a draft — an item stands on a `pipeline_steps` row and binds to a published version (§17.5) — so a draft under test is materialised as a **trial pipeline**: a pipeline of its own, created and saved through `savePipeline` exactly as Publish saves one, so its graph is judged by the same validator and frozen in a version of its own. The row is marked as a trial (`pipelines.trial_at`) and linked to the assistant conversation it came from (`trial_conversation_id`) and to the pipeline the draft would replace (`trial_target_pipeline_id`), or to none for a draft that creates one. Every step gets a fresh id, because a draft that changes a pipeline names that pipeline's own steps and a row cannot stand on two pipelines; `createTrialFromDraft` (`main/trials/trials.ts`) answers with which trial step each draft step became.

**The pipeline it would replace is never touched.** The trial reads the draft and writes only its own rows, so creating one, running items on it and discarding it leave the target's steps, routes, versions and items exactly as they were. For the same reason two things a published draft may carry are refused for a trial: action definitions (a role's definitions are shared by every pipeline naming it) and a route handing work to another pipeline's step (a trial item following it would land on live work). The draft's modules are not refused, approved or not: in the same transaction every one is given a trial grant (§4.6) by whoever made the trial (`TrialStart.grantedBy`, the person by default), and a module a published pipeline uses is copied first, so the trial's step runs the copy and nothing the trial does to it reaches live work; `createTrialFromDraft` answers with which module each step runs (`moduleIds`). And a module running on a trial item may not create an item (`ctx.createItem` answers with a refusal, `postModuleCreation` in `modules/moduleCreations.ts`, before anything is written): the door it files through places work only on pipelines a person can see, so whatever it made would be unmarked live work on the board the draft would replace, still there after the trial is discarded.

Items filed on a trial (`fileTrialItem`) carry the **trial mark**, `items.trial_at`. It is not the preview mark (§15.3): a preview is swapped onto the fake backend, given no disk and reports its side effects instead of doing them, while a trial item runs on its agent's own backend, on a real workspace — the one named, or the project's only one — and through real modules. A trial on no project, or on a project with no workspace that has a disk — none attached, or only a `none` workspace, which a run is prepared on exactly as a preview is — is refused when it is made and when an item is filed on it, and a `none` workspace named for an item is refused too, so a trial item never runs with no disk. On a desktop, a project moved to the organisation's record is refused the same way before anything is written: its work is scheduled by the record and never on the desktop (§17.4), so a trial written into the desktop's copy would be rows nothing runs. On the record itself (`TrialPlace.onTheRecord`), where the project is held, it is the ordinary case. It is never mirrored to an issue tracker. What the two marks share is what a person browses:

Both marks travel. A trial pipeline's mark, conversation and target (`RecordPipelineSchema.trial`) and a trial item's mark (`RecordItemSchema.trialAt`) go with them when their project is moved to the organisation's record and when the record's pipelines and items reach a replica, so on the far side a trial is still hidden, its spend is still reported apart, and it can still be discarded as one. A page from a build that predates the fields reads as live work, which is all such a build could send.

- `listPipelines` never answers with a trial pipeline, so it is in no switcher or `pipelines_list`, on no board, in no export and not in the gallery's matching of installed pipelines; nothing names one by accident, and the trial's own code finds it by id (`trialsRepo.ts`).
- A trial item is left off the board and every item list, out of the inbox — its rows and its counts, and so the dock badge and notifications — without the `!` marker, and out of the archive. On a trial the assistant stands in for the person, and what only the person can answer it brings to them in its own conversation. The item can still be opened by id.

What the marks do not share is cost. A trial runs on real backends and spends real money, so its runs and side calls count against the per-item and daily budgets like any item's; `costs:getDaily` reports the trial share of the day apart (`trialCostCents`), and `spend_read` says it on a line of its own.

While the conversation a trial came from is open, the scheduler offers its trial items a slot before live work (`trialItemsInRunningLoops`, handed to the engine as `firstInLine`), so a loop that waits on one run at a time is not left behind a queue for hours. It changes the order slots are handed out in and nothing else: concurrency stays where the guardrails put it (invariant #10), no run already going is stopped, and within each group the order is still priority then age. It is one guardrail, **trial items first**, on by default (§5.5), because it was the call least settled; off, trial items wait like everything else.

**Step modes on a trial.** A trial carries a **trial plan** (EO-584, `TrialPlanSchema` in `packages/core/src/trialPlan.ts`, stored on the trial's own row as `pipelines.trial_plan`) that gives each of its steps one of three modes. A step the plan does not name is real, and so is every step for an item without the trial mark: only a trial item is ever redirected or mocked.

- **Real** — the step runs as written, exactly as it would on a published pipeline: the same backend, module host, workspace, values and routes. A trial's steps have fresh ids, so the trial records which live step each was copied from (`pipelines.trial_step_sources`, written by `createTrialFromDraft`, travelling as `RecordPipelineSchema.trial.stepSources`), and a copied step's own variables and secrets are that live step's — read in place and never written or copied, so a real step on a trial runs on what the published step runs on, an edit to the live step reaches the trial's next run, and nothing the trial does reaches the live scope. A step the draft invented is its own source.
- **Redirected** — the real code runs against a test target. On a trial item the step reads its **trial-only** variables and secrets (`trialScopeOf` the trial step's id, a scope of its own in the module-secrets store, so values never touch SQLite) in place of its own; on any other item it reads its own. Both module runs (`environmentFor`) and agent runs (`agentRunVariables`, which also fill an attached server's declared names) take the step's scopes from one function, `stepScopeFor` in `main/trials/stepModes.ts`. A name the step's own scope sets and the trial scope does not is given nothing, not the shared value — the step was set up to replace that value, and falling through to it could point the real code at the live target — and a module needing it is refused with that sentence. For an agent run leaving the name out of the run's variables is not enough, because the CLI inherits EO's own environment beneath them: the turn names it (`withheldEnvironmentVariables`, from `redirectWithheldVariables`), and both adapters take it out of every layer beneath what EO sets, inherited included, the way they withhold an unreadable organisation value (EO-488). The organisation's value still wins over both (§14.2). Clearing a step's values (`clearStepSecrets`) clears its trial-only ones with them.
- **Mocked** — the step does not run. For each trial item the plan names the result key the step reports and the output it posts. Every door a step's work goes through asks first (`runMockedStep` in the supervisor, ahead of the agent path's runtime, preflight and budget checks and of the builtin and module path): no run row, backend, module host or workspace is started. EO posts the output as its own `output` comment opening with the mocked mark (`MOCKED_OUTPUT_MARK`, `isMockedOutput` — in the body because the body is what travels to the record and to replicas, and an agent cannot post as EO to forge it), routes the key through `routeResult` — the resolution every run's result takes, on the item's own version — and moves the item with `transitionItem`, EO as the actor and `mocked on a trial` as the reason. Where the plan names nothing for the item, or the key routes to a person or nowhere, the item is held where it is on a placeholder that names no thread, with a comment (invariant #8). A reply to a parked step asks the same question first (`resumeItemHeld`), before a builtin is re-run or a parked thread resumed — a real run that stopped to ask and was planned as mocked before the answer is mocked, not resumed — and because a mock writes no run to supersede the park, the park it answers is closed as the item moves, or a fresh one is made, newer than the reply, where the plan still names nothing.

Saving a plan (`saveTrialPlan`) refuses, before anything is written, a step that is not the trial's, the same step twice, a person's or terminal step redirected or mocked (they run nothing; a person's step on a trial is answered on their behalf, not mocked), a result on a step that is not mocked, a mocked result for an item that is not one of the trial's test items, and **a result key the step does not declare** — one with no route out of it in the trial's graph, which would only park the item asking for one. The plan travels with its trial (`RecordPipelineSchema.trial.plan`), and saving it moves the pipeline's `updated_at`, so a plan changed between rounds reaches whichever machine runs the next trial item.

The assistant proposes each step's mode from EO's own side-effect data, and the person decides. `pipeline_get` (`pipelineSteps:list`) and `pipeline_validate` (`pipeline:validate`, for a draft that exists nowhere yet) both answer, per step, whether it **sends** or **creates** outside EO (`outsideReach`): the webhook refusal's own classification (`webhookReach`, exported with `outsideReachByStep` from `packages/engine/src/pipelineValidation.ts`), so a builtin whose registry entry has `sideEffects`, a module whose manifest says `sideEffects` or `needs.create`, and an agent step whose role can reach a connector with side effects (`sideEffectingServersByStep`) are named exactly as the refusal names them. A step that sends is one to redirect or mock; one that creates work is one to mock, since a module on a trial item may not create any.

**The assistant on trial items** (EO-585). On a trial item the system agent stands in for every person the pipeline would ask: it presses a person step's results with `item_decide` and answers an agent's question by replying under it with `comment_post`. It does so **as itself, never as the person**. The administrative MCP host (§11.4) leases each turn's credential for the agent the turn is (`adminDispatchFor` → `lease(agent.id)`, the one call both backends make), and stamps that agent's id as `actingAgentId` on the two channels it acts on (`AGENT_ACTED_CHANNELS`: `items:decide`, `comments:post`) — below every tool, after the tool has deleted whatever a caller sent under that name. No tool advertises the field (`withoutCallerIdentity`), and the Electron door and an organisation server's HTTP door strip it (`withActingAgent(…, undefined)`), so a caller is never an agent by its own say-so and a turn cannot name another agent. `decideItem` records such a press with the agent's id as the transition's actor and an agent comment — always, with `Decided "<label>".` where it wrote no words — and refuses a result that needs a reason without one exactly as it refuses the person, because the reason is judged before the note is added. On a trial item that comment, and any comment the agent posts there, carries a visible note (`ON_YOUR_BEHALF_TRIAL`, `main/trials/onBehalf.ts`) that it acted on the person's behalf on a trial. Such a comment is a reply to everything that waits on a person's: one predicate, `isStandInReply`, decides it — written by an agent holding the `eo_admin` grant, on a trial item, in no run, carrying the note — and the question count (`unansweredQuestions`), the scheduler's recovery of a reply whose resume was deferred (`awaitsTheStep`, read by `deferredReplyItemIds`) and the reader a parked builtin or module step answers from (`answersSinceLastAsk`, which hands the step the words with the note taken off) all ask it, so the asking run resumes whether the reply arrived while EO was running or paused. Anything else the same agent writes — inside a run, or without the note — stays commentary. Off a trial item a press is still recorded as the agent's, without the note, and its other comments go in as they always did, as the person's (EO-514). **It presses with the person's authority, never more.** On a step that waits on a group (§17), a decision is judged against the person the press is made for, locally (`refusedOnGroupStep`) and on the record, which holds every decision — told by its `decided ` reason (`isDecision`) — to the holder rule whoever the actor is (`serveRecord.ts`), so an assistant cannot press a result its person could not. On a trial item, where standing in for whoever the step would ask is the point, no hold binds it. What it may answer, and what it must bring to the person — a credential, more tools, a wider grant — is in its prompt (`system-agent.md`, "Standing in for the person on trial items").

**The test-fix loop** (EO-586, `main/trials/loop.ts`). The loop is a sequence of assistant turns, never one turn waiting on a run (invariant #9), and what joins them is EO waking the assistant. When a trial item reaches a terminal step, parks for attention (an escalation or a question mentioning the person, or an agent's blocking comment of any kind — an output included — which `writeAgentComment` posts with `endsRun`, the one thing that tells it from an output that does not block), fails past its attempts (the attempt limit's stop, told apart by its own words, `isAttemptLimitStop` in `supervisor/attemptLimit.ts`) or arrives on a person's step — by a move, or by being filed onto a trial whose entry step is a person's (`wakeOnFiling`, from `fileTrialItem`, since no move puts it there) — EO posts a note on the conversation the trial came from that mentions the system agent — as `openUpdateConflictChat` posts its brief — and that mention starts the next turn in the conversation, never on the trial item. The note names the item, the step, the result and the expected outcome. The result is the key the move was made on. A routed move carries it: `routeResult` names the result on the destination it answers with (`NextStepDestination.resultKey`), the supervisor passes it to `transitionItem` with the move, as a press and a mocked step do, and the listeners are told it (`AppliedTransition.resultKey`) — never stored and never sent to the record, but the one way to know which result a run was sent on once a pack has read its answer its own way, as the developer pack maps a review's `reject` to `changes_requested`. A move that carries none is read from the one route between the two steps, or else the `result` the run's stored answer names exactly; nothing else an answer says is taken for a result, and where nothing settles it the note says which keys it could have been. For a park it is what parked it. Arriving on a person's step on the way is reported as not yet an end. It is hooked at the writes, `onTransitionApplied` and `onCommentPosted` (`installTrialLoop`, from `startMain`), so no path that moves or parks an item can forget to wake it; a run that asks three questions has parked once and wakes once; a copy of a comment written on another machine wakes nothing there; and an item without the trial mark wakes nothing at all. Each wake is also recorded as a **trial outcome** (`trial_outcomes`), with EO's own reading of whether it failed: an item with an **expected outcome** — the step it must end on and the person's own words for anything more, per test item on the trial plan (`TrialPlanSchema.expected`), which `saveTrialPlan` holds to the trial's own items and steps — has failed wherever it ends that is not that step; one without has failed only by parking or running out of attempts. Arriving on a person's step is not an end and fails nothing (invariant #5: EO judges, not the assistant).

A round of the trial's test items is started through `startTrialRound`, the one door every round goes through, which records it (`trial_rounds`) and refuses it when a guardrail has tripped (§5.5): the rounds allowed (`trialRoundsPerDraft`, 8) have run; testing the draft has cost its budget (`trialBudgetCentsPerDraft`, unset by default, the daily budget applying either way); or the same step failed with the same result in each of the last two rounds (`trialStopOnRepeatedFailure`, on), where a round's failures are each item's newest outcome in it. A refusal stops the loop with an engine `escalation` on the conversation that mentions the person, says which guardrail and what still fails, and offers three answers as its options — **keep going**, **publish anyway**, **discard** (`TRIAL_STOP_CHOICES`) — which the chat draws as buttons until a valid answer settles the stop (`canAnswer`, read from `trial_stops`, so a reply that is none of the three leaves them there). Until then every round is refused, saying so, without asking twice. Only the person's reply under the stop answers it, and it is read where it is still known whose it is: `postHumanComment` hands a reply from a caller that is no agent to `answerTrialStop`, and refuses one an agent asked for (`actingAgentId`) under a stop before anything is written (`agentStopAnswerRefusal`) — off a trial item the system agent's comments are filed as the person's (EO-514), so the comment alone could not tell. The assistant cannot answer its own guardrail (invariant #11). Keep going makes every guardrail count again from the answer — rounds and repeated failures from the round the loop was on when it was given (`trial_stops.answered_after_round`, by number, so a round started in the answer's own millisecond still counts), the draft's spend from the answer's time — and wakes the assistant to carry on; publish anyway wakes it to bring the publish card; discard discards the trial (below) and says so. Anything else is answered under the stop, which stays open (invariant #8). The rounds, outcomes and stops (`trial_rounds`, `trial_outcomes`, `trial_stops`) are local to the installation running the loop, like the trial grants, and go with the trial's pipeline by cascade. What a round runs on the trial's items is its caller's.

**The design under test** (EO-587). A trial made from a design card records what the person approved on the trial's own row (`pipelines.trial_design`, `TrialDesignSchema` in `packages/core/src/trialDesign.ts`): the draft and its trial plan as the card showed them, and which trial step, module and test item each of the draft's became. Local to the installation, like the trial grants. Each round (`runDesignRound`) goes through `startTrialRound`, files every test item of the approved design afresh as a trial item, and extends the trial plan with where each must end and what each mocked step reports for it, in the trial's own ids; a test item that cannot be filed takes the round back with it. Every later draft the assistant returns in that conversation is handed to the loop once the reply is posted (`continueTrialLoop`, from the developer pack's wiring) and classified by EO against the approved design (`classifyDesignChange`), never by the assistant. A change to what the person approved — a step, a route or a declared result added or removed, a step that runs something else, is done by someone else or ends work, the entry step, what work must have to enter it, a test item or its expected outcome, a step's mode or what a mock reports, a module proposed anew or one whose needs grew past its grant (EO-583) — leaves the reply a new design card, says why in the conversation mentioning the person, and no round starts until it is approved. The wait is recorded on the design under test (`TrialDesign.pending`) and held at the round door (`runDesignRound` refuses while it is set), so it outlasts the turn: every later draft is a design card too — one returning to the approved shape included, since the assistant changing its mind is not the person deciding — and only the person approving a design ends it. Approving it replaces the design under test: the new trial runs the draft copies the loop has fixed rather than forking the originals again (`TrialStart.carriedCopies`), unless live work has since adopted a copy, which then is copied again — its fixes kept, still a copy of the module the draft names — and the earlier trial is discarded. Which module a trial runs for each the draft names is decided once (`trialModuleFor`, `main/trials/trialModules.ts`) for both the card and the grant, so the rows and outside reach a redesign card shows are those of the modules approving it grants. A card's plan is read first from the design approved for it, so an approved redesign that inherited its plan still reads as a design card after its trial is made. Anything else — a step's instructions, name or settings, the words on a result, module code within its grant — is saved into the trial pipeline under the trial's ids, so new test items run it and items already running finish on the version they entered on, and the next round starts; the reply is answered with what was applied, so it is no card to approve or publish. A draft revised mid-loop is a draft of the design under test whether or not the turn restated its plan: it is never offered as a publish card that skips the trial.

**The publish card** (EO-588). When every test item of the newest round has ended where it was expected to, or the person answered a stop with **publish anyway**, the assistant returns the card `{ "kind": "trialPublish" }` on its own, with no draft (`TRIAL_PUBLISH_CARD_KIND`, among the cards for what only a person may do). It names nothing: the conversation has one trial under test, and everything on the card is read from it by `readTrialPublish` (`main/trials/publishCard.ts`), never from the assistant (invariant #5). The graph is the one the trial ran: the trial pipeline's own steps and routes, with every setting they were materialised and tested with and the module each module step ran, under the draft's step ids (`testedGraph`) — never the draft read again, which would settle what it leaves out against the target's rows as they are now and so publish values a later edit to the target put there that no test item ran with. The draft the trial runs — the newest one the loop applied without a card (`TrialDesign.applied`), else the approved design card — is read only for what it says about the pipeline itself: which one, and its name and icon. Beside it: what changed since the approved design, measured on the graph itself — the trial's resolved graph as it was materialised when the design was approved (`TrialDesign.approvedGraph`) against the one it runs now, every field of every step and route compared, position and every setting included (`resolvedGraphChanges`, `packages/core/src/trialPublish.ts`), so a setting a revision inherited from the target after approval, which no draft wrote, is named too; each module as the draft card's collapsed row, marked where its code moved since approval (against a digest the design kept, `TrialDesign.moduleCode`) and, more strongly, where its needs did (against the trial grant, which records what the person granted), and naming the live module a draft copy takes the place of; every step as **tested**, **redirected**, **mocked** — never called tested, whatever reached it — **reached but never run**, or **not reached** by any test item. A step has run where there is evidence of work, not of arrival (`ranSteps`): a run on it that succeeded, a move off it on a run's result, a press of a person's step; a terminal step runs nothing, so reaching it is enough. A step an item parked on before its code started — a missing credential, a withdrawn grant — has not run; each test item of the newest round (`TrialDesign.rounds`) with where it was expected to end and where it did, by EO's outcomes; and every result the assistant pressed on a person's step (the move's `decided "…" on the person's behalf`) and every question it answered (`isStandInReply`), in every round, said as what the live pipeline will ask the person. The card is refused, when offered and when pressed, while a design card waits (`TrialDesign.pending`), while a stop waits for its answer, before any round has run, or while a test item of the newest round has not ended where expected and no stop since that round's start was answered **publish anyway**; after one was, the card says which items failed above its button, which reads **Publish anyway**. The button (`assist:publishTrial`, `publishTrialCommand` in `ipc/assistCommands.ts`, locked with the pipelines section like Approve and publish) is §11.3's single-card publish for the draft under test: every module the graph runs has its tests run and judged (`judgeModuleForApproval`) — one approved before included, since publishing puts it onto live work again — coverage under the bar asked about on the card; then one transaction asks the press again (the conversation still open, the card still the newest — a reply can replace it while the tests are awaited), reads the card again, approves every module not yet approved, gives each draft copy the name of the module it copied, and publishes the graph — a new version of the target through `savePipeline`, or a new pipeline. A failing or unrun module test, or a graph the save refuses, and nothing is approved and nothing is published. The live module a copy was made of is left exactly as it was: items already on the target finish on the version they entered on, which runs it, and so does any other pipeline naming it — a copy takes the original's place on the published pipeline, never in the catalogue. After the commit, what was published is filed under the card — read before the trial goes, since the card has nothing else to show afterwards — and the trial and its test items are discarded (below); the copies it published are live work now, so discarding keeps them.

**Discarding** a trial (`discardTrial`, `main/trials/discard.ts`) deletes its items through the item-delete path — `removeItemsAndTheirWork`, the sequence `items:delete` and `projects:delete` share, which stops their runs, releases their worktrees (keeping the branches, as every delete does) and removes their comments, runs, run events, transitions and attachment files — and then, in the same transaction, the trial's routes, steps, versions and pipeline row, with its modules' trial grants, archiving the draft copies of modules made for it. Uncommitted work in a trial's worktree goes with it; it was made to be thrown away. That is invariant #3's one exception, used for what it is for, and nothing else in EO deletes a pipeline row: `deleteTrialPipelineRows` refuses one that is not a trial. Deleting a conversation discards its trials first, so no hidden pipeline is left running where nobody can see it.

### 11.4 The `eo_admin` grant

The system agent reconfigures the installation — that is its job — and it does so through an MCP server named **`eo_admin`**, which serves EO's whole tool catalogue to it over loopback with a per-dispatch token. It is the **only** agent served that server, and the grant is a named entry in its `allowedTools`.

This is the one exception to a rule every other agent is held to: an agent that owns a pipeline step may not widen its own tool surface, because an implementer must not be able to decide what it will be dispatched with next. The system agent owns no step; reconfiguring is the person's authority delegated to it, and every write it makes goes through the same IPC handlers, and so the same refusals, as a person's click.

The grant cannot be imported. A pack whose role asks for it is refused, not stripped, with the line "This pack asks for admin tools. EO does not allow that from a pack." — and a pipeline carrying such a role cannot be exported either.

---

## 12. Agents and backends

### 12.1 An agent is a row

An agent (`agents`) has a name, a role, a backend, a model, a reasoning effort, instructions, a configuration bag including its `allowedTools`, and an enabled flag. A built-in role's default instructions are a versioned prompt file in its pack (`apps/desktop/src/main/packs/developer/prompts/`); EO keeps a hash of what it wrote so it can update a prompt nobody edited and leave alone one somebody did.

**Roles are configuration, not code.** The engine knows only that a step names a role. Adding a tester that runs before review is one agent row, one step row and the routes around it.

**An agent is global unless it belongs to a project.** An agent has an optional project (`agents.project_id`); without one it is global, which every agent was before the column existed. A project's own agent is dispatched only for that project's items, never for another project's or for an item on no project. It also takes precedence there: for an item on project P, if P has a dispatchable agent of its own in the step's role, only P's agents in that role are candidates, and otherwise the global agents in that role are, as before. Dispatchable means enabled and not archived, not free. A project's own implementer that is busy is a queue for that project's work and does not hand it to the global one, while one that is switched off outranks nobody. So a project that wants its own writer or implementer, with different instructions, model or backend, gets one without disabling the global agent everyone else uses. The rule is one function, `staffingAgents` in `packages/core/src/domain.ts`, built on `staffsItem` (scope and the preview mark). The scheduler picks from it, its "no enabled agent" blocker asks whether it is empty, the dispatch preflight admits a rerun only for an agent in it, and the pipeline validator is handed the roles it is non-empty for on the pipeline's project, so none of them can promise what another refuses. A mention is a dispatch too: EO refuses to start another project's agent on an item where somebody mentioned it, says so in the thread and closes the mention, and asks again after preflight in case the agent was re-scoped meanwhile. The paths that start an agent without asking the scheduler hold to the same scope: a reply to a parked run, a boot reconciliation resuming an interrupted one, and a forced restart. Each of them settles an agent that has moved to another project with a sentence, closing the park, orphaning the interrupted run or dropping the promised restart, so the step is staffed again from the item's own project, and the one door every start goes through refuses it as well. A global agent mentioned by name on a project that has its own is still answered, because naming somebody is not staffing a step. **The `system` role is always global.** The assistant is one agent with the same instructions for everyone (§11.1) and the only holder of the `eo_admin` grant (§11.4), so `agents:save`, and the MCP `agent_save` that dispatches through it, refuse a project on a system agent with a sentence. Archiving a project leaves its own agents where they are: nothing of an archived project is dispatched by any door, so its agents run nothing while it is put away, and restoring it makes them dispatchable again with nothing to undo. Deleting a project archives its own agents rather than deleting them — instructions, config and attachments kept, since an agent row is what its runs and comments point at (invariant 3) — and detaches them, in the same transaction as the project's delete, so a refused deletion leaves them untouched.

**A project's own agents travel with the project.** Moving a project to the organisation's record carries them with its graphs, before the runs that name them, under the ids they had. On a record-held project they are the record's configuration and reach every replica on the sync's own list, paged on the agent row's `updated_at` as a pipeline is, under the pipelines' rule (§17.5): written over the replica's copy where the agents section is published, and only where missing where it is not, and locked by the agents section like any other agent. A replica that keeps its own copy while the section is unpublished still holds the record's newest one, durably, and applies it the moment a publication of the agents section lands, on whichever page that is read; publishing also re-offers every project's own agent on the sync. Either way a replica takes the record's agent under the lock rather than keeping one it can no longer correct. Because the record can move an agent between the two doors — onto a project or off one — every change the record makes to an agent adds one to its `revision`, which every copy carries through both doors, and a replica keeps the revision of the copy it last took (`agents.record_stamp`); a copy older than it, arriving late through either door, is passed over — a revision rather than a timestamp, because two changes can land in one millisecond: a held project copy does not undo the publication that made the agent global, and a publication read late does not undo the project copy that came after it. A run pulled before the agent it names is written as nobody's and keeps the record's id beside it, and is named when that agent arrives — a project's own from the sync, a global one from a publication, which may never come. A server or skill an agent is attached to that has not arrived yet — a global skill comes with the packs section, a project's own skill on the sync's own list (§13.3), a server with policy, each on its own page — is held with the copy it belongs to and attached when it lands — only what had not arrived, and only while nobody here has changed the agent's tools since, so a person's own edit to an unpublished agent stands; and every held row is retried least-tried first, so rows waiting on something that never comes cannot keep a later one from being tried. Global agents stay the installation's, and an organisation hands those out by publishing the agents section, whose document carries global agents only — a project's agent arriving there would land as a global one — and writes each of them global on a replica, so an agent the record took off a project is global on a machine that held it scoped as on one meeting it fresh. A move pages the agents within the contract's limit, however many a project has collected. A pipeline export carries roles, never agents (§18.1): the role's prompt is read from an agent that works for the pipeline's project, the project's own before a global one, and nothing in the document names an agent.

A person sees and sets the scope on the Agents screen, which groups agents by it — the global ones, then each project's own — and offers every agent but the system one a scope picker. A global agent also offers **Customise for this project**: `agents:customise` makes the active project's own copy, with the same role, backend, model, `config` (reasoning effort among it), instructions and MCP servers and skills, named for the project so a mention never meets two agents of one name, in one transaction so a copy never exists without its tools. Editing the copy leaves the original alone. A project's settings list its own agents and, for each role its pipelines' agent steps name, who will be dispatched — the project's own, the global ones, or nobody — which `projects:staffing` answers by asking `staffingAgents` of a real item on the project, so the summary cannot name an agent the scheduler would pass over.

A pack names a role, never a backend: the author cannot know what the reader is signed in to. The installing machine chooses the agent, and a pack may recommend a backend and model but not require one.

### 12.2 One interface, two backends

Every backend sits behind `AgentProvider` (`packages/core/src/agent-provider.ts`): `start(options)` and `resume(threadId, message)`, each returning a stream of events that can be interrupted and steered, and `sideCall(options)` for the side calls below. A start is given the instructions, the assembled context, the working directory, the output schema, the tool surface, and an abort signal. The events are a small closed vocabulary: thread started, server status, quota, output, reasoning, tool call, tool result, file edit, usage, result, error — and the transient output delta, which is shown and never stored (§6.2). Streaming and reasoning summaries are asked for per turn (`streamDeltas`, `showReasoning`), and only conversation turns ask — the ones a person is watching: a pipeline step nobody is watching pays for neither.

- **Claude Code** runs through `@anthropic-ai/claude-agent-sdk`, loaded at run time from the runtime EO resolved rather than bundled into the app. Instructions go in the system prompt and the output schema in the SDK's structured-output option.
- **Codex** runs as `codex app-server --stdio`, the CLI's own JSON-RPC mode, spawned from the executable EO resolved and spoken to by EO's own client (`apps/desktop/src/main/providers/codexAppServer.ts`, `apps/desktop/src/main/providers/codexClient.ts`). Over that connection a turn can be started, resumed, interrupted and steered, and its plan-limit readings and MCP startup report arrive as the same quota and server-status events Claude's do.
- **The fake backend** walks a pipeline with scripted answers and spends nothing. It is what Preview runs on (§15.3) and what the test suites use.

Both real backends run with the agent's permission prompts off: EO constrains an agent by what it is *given* — its tools, its workspace, its lockdown — and checks the result, rather than by approving each action.

**EO also makes side calls.** A side call is one short question to a model with one schema-shaped answer, made by EO itself rather than by an agent: picking which memory a dispatch is given, proposing notes after a run, consolidating a scope's memory. It is not a run. It needs no item — consolidation belongs to a scope — puts nothing on the board, keeps no thread and is not seen by the agent it is about. It goes through `sideCall` (`apps/desktop/src/main/sideCalls/sideCall.ts`) and the adapter's `sideCall(options)`, and comes back as either the parsed answer or a failure — `timeout`, `schema`, `budget`, `quota`, `signed_out` or `error`, with a sentence. It never throws.

- **What it may have.** The question, its system prompt and its schema; an empty temporary directory, removed afterwards; the backend's own structured-output mechanism; and EO's lockdown (§12.4). On Claude that is the agent SDK with built-in tools off (`tools: []`), no setting sources at all — so no `CLAUDE.md` — strict MCP configuration, no skills and no session written to disk. On Codex it is an ephemeral app-server thread, read-only, with no `mcp_servers` overrides, web search off, memories off and a Codex home of the side calls' own (`side-calls`, beside the agents'). There is no fallback to the person's own home, as there is for an agent whose sign-in is in the keyring: that home is their `config.toml`, whose MCP servers Codex starts whatever the launch declares, so where the sign-in cannot be carried into the side calls' home a Codex side call is refused with the reason (`sideCallCodexHome`). A sign-in in the keyring, or on `auto`, is refused before anything is spawned, as `sign_in_unreachable` rather than `error`, with the one fix there is — `cli_auth_credentials_store = "file"` and signing in again — since these calls have no backend of their own to switch; and because it leaves memory with nowhere to run, the Codex Runtimes card and the Codex agent editor say so (EO-509). Codex has no single "no tools" switch, so its tools are turned off one surface at a time, as measured against the pinned CLI with a capture server standing in for the model (`apps/desktop/src/main/providers/codexSideCallLockdown.ts`): the shell features off, the skills catalogue off — under a redirected home Codex otherwise lists the person's `~/.agents/skills` — and a one-model catalogue (`model_catalog_json`) copied from Codex's own cache with the keys that give the model code mode, sub-agents and a patch tool removed. A model no cached catalogue names is refused rather than run with its tools on. `codexSideCall.live.test.ts` repeats the measurement through EO's client; what it leaves is `request_user_input`, which is plan-mode only and which EO's client refuses.
- **What it may not have.** Tools, MCP servers — EO's own included — skills, a plugin directory, a thread to resume or a repository. It is one turn.
- **Which model.** Said per purpose, in a table keyed by purpose so a new one cannot leave it out (`SIDE_CALL_MODELS`, EO-578). Selection and extraction run on the backend's *small model*, a setting per backend on the Runtimes tab — `claude-haiku-5-5` by default on Claude, and on Codex the smallest model the runtime reports, read as the cheapest by EO's price table (`apps/desktop/src/main/providers/smallModels.ts`) — with no reasoning effort set. Consolidation — each batch, the cross-batch pass and the skill proposal call after a run — is asked about once a day per scope and needs judgement over the whole of it, so it runs on the system agent's own model and reasoning effort, and changing the assistant's changes consolidation's; on a 56,000-character scope the small model failed it eight times in a row. The system agent's editor in the chat layout holds an optional override, a consolidation model and reasoning effort kept in that agent's own config (`consolidationModel`, `consolidationReasoningEffort`), each field set replacing the agent's and each empty one following it; it is not on the Runtimes tab. Where neither names a model, Claude's CLI picks its default and Codex runs on the one its `model/list` marks default, since a Codex side call must name its model to switch that model's tools off. The effort reaches Claude as its `effort` option and Codex as `effort` on `turn/start`. A model the backend cannot run fails the call with a sentence naming it, and the row records the model the backend says answered.
- **Which backend.** The one it is given: the dispatched agent's, or the system agent's for consolidation.
- **Concurrency.** A side call made inside a run's dispatch or settle uses that run's slot. One made on its own waits for a free global slot and holds it until it ends (`sideCalls/slots.ts`); the tick and the device's capacity both leave it free, so invariant 10 holds. Every call has a timeout, which covers that wait and the sign-in and model lookups before it — each is handed the call's signal and stops its own process — and EO's shutdown stops calls in flight. A call may also carry an output-token cap (`maxOutputTokens`, EO-577): both adapters stream a side call's words as `output_delta`s, as they do a watched turn's — Claude through `includePartialMessages`, Codex through its item deltas, held to one capability in `providerParity.test.ts` — and `sideCall` counts them at one token a byte of UTF-8 — every token of a byte-level tokenizer stands for at least a byte, so code, punctuation and non-Latin text can never slip past the cap as they would at four characters a token — or by the output tokens the backend reports, whichever is larger. Past the cap the call is wound down rather than killed (`windDown`): Claude's turn is interrupted over its input, which a side call holds open as a stream for this until its result, and Codex's with `turn/interrupt`, and EO reads the turn to its end for what it spent — Claude says it only in the closing result — so the tokens and cost of an answer cut off are recorded and count against the budgets; one that has not ended five seconds later (`SIDE_CALL_WIND_DOWN_MS`) is stopped outright. `providerParity.test.ts` holds both to that as one capability. Either way it is recorded as `timeout`, and so is running past the time. Reasoning a backend never streams is bounded by the time and by what it reports. A call made on its own may ask to give way (`giveWay`): asked at the moment it would take the slot, after the slower lookups, and when it says pipeline work is waiting the call is not made and takes no slot, failing as `error` with a sentence that says so. And the caller is told how long it held the slot (`onSlotHeld`).
- **Where its cost is recorded.** One row per call in `side_calls`: purpose, project, the item and the run where there is one, backend, model, tokens, cost, duration and outcome — never the prompt or the answer. The cost is kept in micro-cents, not whole cents (EO-510): a call costs a fraction of a cent, and rounded one at a time almost every call was recorded as nothing. The readers sum micro-cents and round the sum, so two hundred half-cent calls are a dollar. The spend readers count those rows wherever they count runs: the per-item and daily budgets (a call is refused with `budget` and makes no model call when either is spent — asked when it is made and again just before the model is, since a call that waited for a slot may find a run spent the rest meanwhile — and is capped at what is left), the project and person totals, a job's spend, `spend_read` and the spend screens, which list them as their own line ("Memory upkeep"). A row about an item an organisation's record holds is also queued for the record as it is written (`sideCall` in `RecordCommand`, EO-514), carrying its run ahead of it as a comment does, and the record files it under its own item's project — so the per-person daily budget the record computes counts it. A consolidation of such a project runs on the record and is written there. The rows travel up only: another desktop's per-item figure is still its own calls and the runs it has pulled.

`providerParity.test.ts` holds both adapters to the same side call.

### 12.3 The parity rule

**A capability reaches both backends, or names the one it does not.** Anything EO hands an agent — an MCP server, a tool named in a prompt, a skill, a control in the interface — works the same whichever backend the agent runs on. Parity is work, not a default, because the two differ in both spelling and delivery:

- **Spelling.** Claude advertises a tool as `mcp__<server>__<tool>`; Codex sends `<server>/<tool>`. A prompt written around one backend's punctuation leaves the other without the tool while every test passes. So prompts name tools by server and purpose, and allowlists are parsed in both spellings.
- **Delivery.** Claude reads a generated plugin directory; Codex takes MCP servers as configuration overrides on its command line. A delivery path only one adapter reads leaves the other silently unequipped.

Where a backend genuinely cannot do something, EO says so where the person choosing the backend will see it and offers no control that would do nothing. An absence is never left for an agent to discover.

Two tests hold it. `apps/desktop/src/main/providers/providerParity.test.ts` runs both adapters through one shared list of capabilities — starting, resuming, a lost thread, steering, interruption, quota readings, MCP startup status, secrets reaching servers, answer schemas, cost reporting and more — so a capability added to the list fails until both backends pass it. `apps/desktop/src/main/providers/backendBranching.test.ts` holds every line outside the provider and runtime code and the sign-in screens that branches on a backend's name to a checked-in allowlist that says why.

### 12.4 Lockdown: an agent has what EO gave it

"This agent has these tools" has to be a true statement, so an agent does not inherit whatever the person has configured for their own use of the backend.

- **A Claude agent** is started with only the project's own settings as a setting source, strict MCP configuration, and exactly the skills and servers EO attached, delivered as a generated plugin directory.
- **A Codex agent** runs in its own redirected home (§12.5).
- **"Let this agent use your own setup"** is an explicit, per-agent opt-out that restores the ambient configuration.
- **Neither backend's own memory is on**, so EO's memory is the only one an agent has. Every turn — locked down or on the person's own setup — is started with it switched off explicitly rather than left to a default a release could change. Claude Code's auto-memory is off through `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the spawn environment, set over anything the person or an attached server says; its background consolidation is gated on auto-memory and goes with it. Codex's memories are off through `features.memories=false`, `memories.generate_memories=false` and `memories.use_memories=false` on the app-server's command line, where they win over the person's `config.toml`. Both were read from the pinned CLIs (Claude Code 2.1.318, Codex 0.166.0), where Claude's default is on and Codex's is off — and Codex's switch still covers the second memory store 0.165.0 started a fresh home on (a real 0.166.0 turn under those switches wrote neither store); neither CLI complains about a switch it no longer knows, so a bump re-reads them. `providerParity.test.ts` holds both as one capability.

An agent's attachments — its MCP servers and skills — are hashed, and a thread is not resumed across a change of them (§6.4).

### 12.5 Codex homes

Codex reads its configuration, credentials, skills and session files from `$CODEX_HOME`. To lock a Codex agent down, EO gives each one its own home, `<userData>/codex-homes/<agent>`, carrying exactly two links into the person's own home — `auth.json` and `sessions` — and nothing else (`apps/desktop/src/main/providers/codexHome.ts`).

- `config.toml` is deliberately **not** linked: it holds the person's own MCP servers and model settings, which is what the lockdown takes away.
- Before every turn the home is cleared down to Codex's own state, so a `config.toml`, an `AGENTS.md` or a skill that an agent wrote into its home never configures its next turn.
- On Windows `sessions` is a directory junction and `auth.json` a hard link; neither needs administrator rights or Developer Mode, and both write through. A hard link cannot cross drives, so where EO's data folder and the person's Codex home are on different drives the home goes under `~/.eo/codex-homes` instead. Where no root can be linked at all, the dispatch is refused with the reason.
- A sign-in kept in the operating system's keyring cannot be carried, because Codex files it under a name derived from the home's own path. A person whose Codex configuration stores credentials in the keyring — or in "auto", which reads the keyring first, so a credential file may be stale — has their Codex agents run in their own home, and the agent's editor and the item both say so. EO's memory side calls do not follow them there (`sideCallCodexHome`), so on such a machine they do not run at all, and the Runtimes card and the editor say that too.

**What was measured about redirecting `CODEX_HOME`.** These measurements are why the home is built the way it is. They were measured against the real CLI at version 0.147.0, with real turns on a real account; EO pins a later version and they have not been re-run against it, so the opt-in live test `apps/desktop/src/main/providers/codexHome.live.test.ts` (run with `EO_LIVE_CODEX=1`) is what to consult before relying on any of them.

- **A bare redirect signs the agent out, slowly.** In a fresh home `codex login status` reports not logged in, and a run never reaches a turn: it fails with 401 against the websocket endpoint, retried five times over about eleven seconds, then falls back to HTTPS and retries five more. A sign-in probe run in the ambient environment would go on reporting signed in while every dispatch ran signed out — so the probe and the dispatch must look at the same home.
- **A bare redirect loses every resumable thread, quietly.** A thread started under one home and resumed under another fails with "no rollout found for thread id". EO already treats that as a lost thread and starts a fresh one, so nothing crashes; instead every conversation becomes unresumable exactly once, each costing a full context and a comment blaming session cleanup that did not happen. That is why `sessions` is not optional.
- **Codex follows a linked `sessions` directory, and the conversation really is carried.** A thread started under one home resumed under a second and a third that shared only that link, and the model recalled its own earlier reply. Pointing the link at the person's own sessions directory means session files land where they always did: there is no migration, and existing threads stay resumable.
- **Codex writes through a linked `auth.json`.** A ChatGPT credential holds a rotating refresh token, so Codex rewrites the file from time to time. Tested through the same writer, the link stayed a link and the target's contents changed — so a refresh in an agent's home lands in the person's real credential rather than stranding it. Ordinary runs read `auth.json` and `config.toml` and write neither.
- **A redirected home stops reading the person's `config.toml` entirely.** Their reasoning effort, their trusted-project list and their own MCP servers silently vanish. For a locked-down agent that is the intent; for anything else it is a surprise.
- **Because Codex writes through links, never run `codex login` or its interactive onboarding inside a redirected home** that links the person's files: both write configuration, and would edit the person's own.
- **Skills in `$CODEX_HOME/skills` are advertised by name, description and path, not by body.** The model reads the file itself, so the context cost is one line per skill, and the agent must be able to read the path.
- **A fresh home is not free.** Codex materialises six SQLite databases, an installation id and a models cache — about 2.5 MB and 75 files bare. Once any skill is present it installs a remote plugin catalogue into the home: 42 MB with one skill, 17 MB if the plugins directory is shared between homes. The very first fresh home staged 78 MB across more than five thousand files before it had authenticated. None of that is per-agent data; it is cache.
- **A home under a temporary directory** makes Codex emit a PATH-alias warning, which is one reason homes live under EO's data folder.

### 12.6 Runtimes and sign-in

EO does not ship the agent command-line tools. Anthropic's components carry no redistribution grant, so EO fetches them from their publisher rather than passing on a copy.

For each backend EO resolves a runtime: one the person configured, one in EO's cache, or none. If there is none, the Agents screen says so and offers to fetch it — naming the package, the publisher, the size and whose terms apply before anything is downloaded. The versions are pinned; the tarball comes from the npm registry, is checked against the integrity hash the registry publishes, and is unpacked beside its destination and renamed into place.

Agents authenticate with what the person already has. EO probes each backend's own sign-in status, shows it plainly, and offers the backend's sign-in flows; a Claude API key, if used instead, is stored encrypted and handed to the process in its environment.

---

## 13. MCP and skills

MCP runs in both directions: EO serves tools *to* its agents, and EO *is* a server another program can drive.

### 13.1 What EO hands an agent

Three server names are reserved for EO's own:

- **`eo`** — the item's own tools, a small stdio server started per turn. Always: `item_detail` (and its deprecated twin `ticket_detail`), `attachment_read`, `comment_read`, `comment_search`. By grant: `thread_read` (the whole thread — and the predicate that decides the context shape, §7.5), `comment` (posting, mentioning, escalating), and a set of read-only configuration tools. On a run with a workspace directory: `attachment_add`, which puts files from that directory on the run's own item mid-run — one comment per call, the caption as its body. Not listed for a conversation or on `none`, which have nothing to attach from. On a turn given memory: `memory_read`, and by grant `memory_note`. On a turn with a write bridge, which is every turn on an item: `repository_checkout` (EO-633), which takes a repository on the item's project and a branch and answers with the path of a reference checkout of it (§13.1). Every result's `structuredContent` carries everything its text does — Claude Code shows an agent the structured part rather than the text, so a structured part that said less would leave a Claude agent told less than a Codex agent about the same call.
- **`repo`** — repository intelligence for the checkout the agent is working in, lent by the git workspace kind (§19.4).
- **`eo_admin`** — the administrative server, served only to the system agent (§11.4).

What an agent holds is decided by its `allowedTools`, not by its role.

**EO never infers a write from an agent's event stream.** The `eo` server opens the database read-only, and three of its tools write: `comment`, `attachment_add` and `memory_note`. Each is handed, as it is called, to the main process over the agent write bridge (`mcp/writeBridge.ts`) — loopback, with a per-item credential minted from a secret only the running supervisor holds. The main process applies the rules and writes, through the organisation's record where the record holds the project, and answers; the tool's answer is the write's result — written, or refused with the reason, in which case nothing was. A blocking comment ends its run as it is posted (invariant 9): the supervisor learns of it from the bridge, not from the backend's report of the call. `repository_checkout` goes the same way though it writes nothing EO keeps (EO-633): the server cannot reach the git kind, so the supervisor asks the item's own workspace kind for a reference checkout, or any installed kind that lends one, and answers with its path, its commit and whether that commit was the remote branch's or the local one's — or the kind's refusal, word for word, which the tool hands the agent as its error. A `tool_call` or `tool_result` in the stream is a record of what the agent did and nothing more. EO once acted on them — a comment posted from a call's arguments, a note or an attachment written when a result's text began with the right words — and on Claude, whose results arrive as `structuredContent`, every one of those writes was told "done" and never made. `agentWriteBoundary.test.ts` fails if supervisor or provider code writes in response to either event.

**Servers a person adds** are rows in `mcp_servers` — stdio, HTTP or SSE, with an auth kind and declared environment variables or headers — attached to agents through `agent_mcp_servers`. Each backend receives them its own way and to the same effect: Claude through a generated MCP configuration whose placeholders are filled from the spawn environment, Codex through per-server configuration overrides that name the environment variables to read. The secret values travel in the process environment in both cases and are never written into a generated file.

### 13.2 The server that lets another program drive EO

EO hosts an MCP server so that Claude Code, Codex or Claude Desktop can drive it the way its own window does: read the board, post comments, move items, edit pipelines (`apps/desktop/src/main/mcpHost/`).

- **It is a second caller, not a second backend.** Every tool dispatches through the same IPC handlers the renderer calls, under the same Zod contract. So the engine still owns transitions without the host knowing what a transition is, and an organisation's locks answer it exactly as they answer a click. An architectural test keeps the host from writing to the database directly.
- **It is off until someone turns it on**, in Settings. It binds to `127.0.0.1` only, on a configurable port, over streamable HTTP, and requires a bearer token that is generated by EO and stored encrypted. Host and origin are checked.
- **Destructive tools are behind a second switch.** Every tool is classed as read, write or dangerous, and dangerous ones are refused until that switch is on.
- **If the port is taken, the app starts unaffected.** The failure is a line in Settings, not a dialog. Nothing has to start before EO is usable, and nothing's death takes EO with it.
- **Renamed tools keep their old names as aliases.** A client that registered `ticket_*` tools keeps working; EO records which clients still call the old names and shows it, so a deprecation is something a person sees and not only something an agent reads in a description.

EO can write its own registration into each of those clients' configuration.

### 13.3 Skills

A skill is a named, described body of instructions with optional files (`skills`), attached to agents through `agent_skills`. Its slug is derived from its name and kept unique; its `SKILL.md` carries a frontmatter of name, description and whether the model may invoke it on its own.

Delivery differs by backend and the result is the same:

- **Claude** — the skill is written into the agent's generated plugin directory and offered through the SDK's skills option, and each skill's Skill tool name (`eo-attachments:<slug>`) and description is named in the prompt the turn starts with, read back off that directory, with the instruction to invoke one with the Skill tool when it fits.
- **Codex** — the skill is written into the working directory at `<workspace>/.agent/skills/<slug>/SKILL.md`, with a marker saying EO put it there, and each skill's slug and description is named in the prompt the turn starts with. The model chooses from descriptions and reads a body only once it has chosen. EO never overwrites a skills folder it did not write.

No home is redirected to deliver a skill, and no skill is written into the person's own.

**A skill has a scope**, as memory does: `global`, `project` with a project id, or `workspace` with a workspace id (`skills.scope`, `skills.scope_id`). Global is the default, and every skill that existed before scopes is global. A procedure learned in one repository is noise in every other project, so a scoped skill is delivered only to a run that works in its scope. Attachment is still the first gate, and a scope only narrows it: a run is given the agent's attached skills that are global, or scoped to the item's project, or scoped to the workspace its step works in — the same workspace the run is sent to (`workspaceFor`). A skill scoped to another project or workspace is not delivered, and a run on no project with no disk gets the global skills only.

One rule decides it (`skillInRunScope` in `packages/core`), and both deliveries apply it: the Claude plugin directory is written from the agent's attachments narrowed to the run's scope, and the Codex adapter, which holds every attached skill, narrows by the scope each turn carries before it writes `.agent/skills` and the list in the prompt. `providerParity.test.ts` holds both to it as one capability. The attachment hash that decides thread reuse (§6.4) is taken over the skills the run is actually given, so two runs of one agent that receive different scoped skills record different hashes, and a thread is never resumed under a different skill set. A run given only global skills hashes as it did before scopes existed.

The scope is set on the Skills screen, and a project's and a workspace's settings list the skills scoped to them. The catalogue lists every skill whatever its scope. A skill whose project or workspace has been deleted is kept and reaches no run until it is moved.

**A project's own skills travel with the project.** A skill scoped to a project, or to one of its workspaces, is the project's (`skills.project_id`, the workspace's project for a workspace's skill, kept as a workspace changes project — a workspace never reaches a record, so the skill says whose it is, as a workspace's memory does). Moving a project to the organisation's record carries them, archived ones included, before the agents attached to them and under the ids they had, and the moved agents are attached to them there; on a record-held project the sync pages them to every replica — on when the record last wrote the row (`skills.local_changed_at`), which finishing a move stamps again, and never on `updated_at`, the sender's version, so an edit the move's last sweep carries still lands over the copy it replaces; a project still arriving is left out before the page is cut, so it cannot hold the cursor — newest copy winning, before the agents on the same page, so a replica's copy of a moved agent has the skills it had where it was moved from. A global skill is never carried — it is the installation's, and reaches an organisation only when it publishes the packs section. A skill the record already has under another owner, or under the same slug, ends the move with a sentence naming it, as an agent does; renaming it is the fix. What a moved agent is attached to that the record has not got — a global skill, another project's, an MCP server — is not dropped: the record keeps it with the agent, attaches any of it that arrives on a later page of the move, and once the project is live says what is left in one comment on the project's thread, naming each agent and each tool, forgetting it in the same transaction as the comment is written so a failure leaves it to be said on the next request (`sayUncarriedTools` in `projectMoveRepo.ts`).

---

## 14. Connectors and secrets

### 14.1 A connector is an MCP server with a setup flow

A person should never see a command line or a JSON configuration. A **connector** is an MCP server definition plus what it takes to set it up: a label for its Connect button, a kind, the secret names it needs, and whether using it has side effects outside EO. The kinds are:

- `token` — the person types one or more values;
- `oauth` — the person signs in. EO runs the authorisation-code flow with PKCE against the connector's declared endpoints, receives the redirect on a loopback address, and stores the token under the declared secret name;
- `none` — nothing to set up.

A connector is **connected** when every secret it names is set. A pack — code or data — may ship connector definitions; they land disconnected. The step's list of what its agent can reach is written as capabilities, not tool names.

A connector's `sideEffects` flag is the same flag a module's manifest and a builtin's declaration carry, and all three feed one rule: the validator's refusal of a pipeline where outside input reaches a side effect with no person between.

One connector is built into the developer pack rather than expressed as an MCP server: Jira, bound per project (§19.3).

### 14.2 Secrets

**A secret is never stored in the database, and a personal secret is displayed only on the desktop, on request.** Values are encrypted at rest behind one `SecretStore` interface with two implementations:

- on the **desktop**, the operating system's keychain through Electron's safe storage;
- on the **server**, which has no keychain, authenticated encryption under a key the operator supplies in the environment or a file. The server never generates that key, and a rotation command re-encrypts every stored value under a new one.

There are three scopes, resolved in this order when a run's environment is built: an **organisation** secret, a secret set on a **step**, and a **global** one. A secret reaches a module or an MCP server as an environment variable. A value that cannot be read stops the run rather than starting it without.

For a module, a step or global entry may instead be a **reference**: "read this name from EO's own environment variable X", where X defaults to the declared name. In one scope a name holds a stored value or a reference, never both, and setting one removes the other. A reference is resolved at dispatch from the environment the main process was launched with — no shell is run to ask for the login shell's — and takes the place a stored value would have in the order above. One whose variable is absent or empty yields no value and does not fall through to a wider scope: the step is refused before the module runs, in a sentence that names the variable and says EO reads its environment when it starts. A reference is not a secret at rest, so it is kept in the clear beside the encrypted values and needs no keychain; it is this machine's own setting and is never exported with a pipeline. The value it resolves to is redacted from transcripts and comments exactly as a stored one is, and only the variable's name — never its value — crosses IPC.

**Environment variables** are the other list, beside Secrets: named values that are *not* secret — a region, a tier, a tool's home directory. A variable is stored without encryption under userData, in the same per-scope directories as the references, so it needs no keychain and is removed with its step; it is never in SQLite and never in the keychain. Its value is shown in full, returned by the list channel and by `environment_variables_list`, and is not redacted from transcripts. It has the two scopes a module secret has, **shared** or set on one **step**, and a step's value beats the shared one. Within one scope a name is a secret (a stored value or a reference) or a variable, never both: saving it in the other list is refused with a sentence naming the list that already holds it. PATH, HOME, names starting `EO_` and the names EO sets when it starts a backend (`ANTHROPIC_API_KEY`, `CODEX_HOME`, the `CLAUDE_CODE_` switches EO pins) are refused, because EO sets them itself. A variable takes the place a stored value would have in the order above — the organisation's secret, then the step's entry of any kind, then the shared entry of any kind — so an organisation secret of the same name wins everywhere, and an unreadable step entry still stops the fallback. Three consumers receive variables: a **module**, only the names its manifest declares in `needs.env` (and the gallery's needs check and an import preflight count a shared variable as set); an **MCP server**, only the names it declares and only where it has no secret of its own for that name — the organisation's secret, then the server's own, then the run's step's variable, then the shared one, resolved for a delivered server only, by the one reader each backend spends (`attachmentEnvironment` for Claude's `${VAR}` expansion, `codexServerSecretReader` for Codex's `mcp_servers` env), and an organisation value that cannot be read is stood in for by neither a variable nor the inherited environment on either backend; the server screens and `mcp_servers_list` say "From environment variables" for a declared name only a shared variable fills; and an **agent run**, every shared variable plus its step's own, in the CLI's environment on both backends. An agent run's are read from disk as each turn opens and handed to that turn, never to the cached provider, so an edit reaches the next run without a restart and no value is part of the provider cache key; they go over what the CLI inherits and under every name EO sets for the run — PATH, HOME, `CODEX_HOME`, the backend's key, the admin bearer, the search hook's variables, an attached server's values — and a reserved name is dropped at spawn even if one was stored. A variable is this machine's own setting: it is never exported with a pipeline, its name included.

An organisation secret is set once on the server and delivered to signed-in desktops that run work. On a desktop it is shown as set by the organisation and not shown here — not "never readable", because an agent with a shell can read its own environment, and the honest claim is only that EO does not display it.

**Reveal.** A person's own stored secret — a module secret, shared or set on a step, or an MCP server's value — has a Reveal button on its row. The value is fetched only when the button is pressed, through two channels in the machine half of the IPC contract (`moduleSecrets:reveal`, `mcpServers:revealSecret`), so a renderer served by an organisation server is refused them as `machine-only` and draws no button. They read the row's own scope and the personal store only: a step's Reveal shows its own override and never the shared value it falls back to, and a name the organisation also set is answered with the person's value, never the organisation's. An organisation secret and a reference have no Reveal — the reference's variable name is already on the row — and a stored value that can no longer be decrypted is answered with a sentence saying it cannot be read, never with an empty value — a row whose value is already unreadable when it is listed says so in place of "Not set" (the lists carry such names, names only: `stored` on `moduleSecrets:list`, `secretsUnreadable` on a server view) and offers to remove it. The revealed value is held in the row's component state alone, not in the query cache and not written anywhere, and it hides again when the person presses Hide, leaves the screen, or after 30 seconds; there is no OS re-authentication prompt. No eo_admin tool reaches either channel: `module_secrets_list` and `mcp_servers_list` stay names only, and a value never lands in an MCP client's transcript.

---

## 15. First run and the gallery

### 15.1 What a person sees first

"Point EO at a repository" is the wrong door for most people. In order:

1. **One question: just me, or my organisation.** Solo goes straight in. Organisation offers two ways in (EO-661). **I have an account** takes the server's address, an email and a password and signs in through `session:signIn`, the same call Settings → Organisation makes; on success the mode is recorded as organisation and the flow goes on, and on failure the server's sentence is shown with every field as typed. **I have an invitation link** reads the pasted link — anything that is not a server's `/invite/<code>` address, judged as a browser will read it (a `.` or `..` code, `%2e` included, resolves to the server's root), is refused with a sentence saying what one looks like, before anything is opened — opens it in the person's browser, where the password is set, and then shows the account form with the server's address filled in. Without an account or an invitation, the screen says whoever runs the server has to invite them and offers **Continue on my own**, which records solo. Once signed in, the gallery's role pickers list the organisation's people (`gallery:list` asks the organisation's `people:list`), and whoever is picked is written locally under the record's own id. A signed-in desktop is never treated as solo: when the server cannot be asked, the last list it gave stands in, and a colleague neither list names is refused before anything is created.
2. **Connect a coding agent** (EO-659), shown only while no backend on this machine is signed in. It lists every runtime EO can fetch (`MANAGED_RUNTIMES`), installs one through the consent and `runtime:install` channel Agents → Runtimes uses, and signs it in with the same `SignInDialog`; once a runtime's status answers "signed in" the flow moves on by itself. **Look around first** goes on to the gallery without one, where Preview works and every card's Use this waits, saying a coding agent is needed, with a button back to this step. A managed copy that was turned off is turned back on from the same list (`runtime:setEnabled`). On a served tab, where there is no machine to install on, the step says signing in happens on the machine that runs the agent and offers only Look around first, and the gallery stays Preview-only. The needs check's coding-agent line opens the same panel in place when nothing is installed, since first run hides Agents → Runtimes.
3. **A gallery, not an empty board.** Each template has a plain description and a list of what it needs.
4. **Preview**, optional, before anything is signed in.
5. **The template's own blanks.** The template knows what the person wants; it lacks which folder, which day, which prefix, who approves. A short form, one line per blank. For a pipeline that works on a git repository the form also asks for one (EO-662) — a blank no pack writes, derived the way the needs check decides it wants a repository — checked with git before anything is made and attached to the new project; leaving it empty leaves the question to the needs check.
6. **The needs check.**
7. **The first item, or the board.** Where the person lands depends on whether there is a first item to watch. If the template came with a job and every line of the needs check is green, the last button starts the first item by firing that job, and the person is taken to **that item's own page** to watch it run. If the template has no job — or the firing produced no item — there is nothing to watch, and the button opens **the pipeline's board** instead. Leaving with Preview only also lands on the board.

Conversations with the assistant remain the door for work no template covers.

### 15.2 The gallery

Four templates are bundled with the app, in `apps/desktop/resources/gallery/`:

| Template | File | What it is |
|---|---|---|
| **Software feature to merge** | `software-feature-to-merge.json` | Worktree → Index → To Do (implementer) → Review (reviewer) → Merge Request → Watching pull request → Done. The developer pack's pipeline. The watch keeps checking every 5 minutes and, as of 1.2, never gives up (EO-571): `merged` goes to Done, `checks_failed`, `changes_requested` and `conflict` go back to To Do — through Review and Merge Request again, which pushes to the open pull request, and back into the watch — and `closed`, `ready` and `failed` ask a person (EO-461). |
| **Weekly report** | `weekly-report.json` | Gather → Draft → Approve → Filed. A reporter reads a folder and a person approves the report. |
| **Inbox triage** | `inbox-triage.json` | Read → Decide → Handled. A triager summarises each message and a person chooses what happens. |
| **Content draft and approve** | `content-draft-and-approve.json` | Outline → Write → Approve → Approved. Nothing is published without a person pressing the button. |

A template is a pipeline export document (§18) with a `template` block: a slug, a title, a description, a version and its blanks. A blank is one of a folder, a schedule, a key prefix, a connector or a step input. A template names role slots, never people.

The bundled set means first run works offline and on the day the installer does. The app also fetches an index of further templates; a fetched template is shown with its source and version, a bundled one always wins a clash of names, and if the fetch fails the gallery is simply the bundled set.

### 15.3 Preview

Preview walks a template's example item through every step, for free, before the person has signed in to anything. It is a button on a template, not a backend to choose.

- The pack is imported into a preview project and its example item is filed with a preview mark.
- A run for a preview item is swapped onto the fake backend and given no disk.
- A builtin or a side-effecting module reports "Would have sent: …" rather than doing it.
- A preview item is excluded from the inbox counts, notifications, the archive and cost totals, and wears a persistent banner: "Preview. Nothing was sent, nothing cost money." *Done previewing* removes it.

A preview is not a trial (§11.5). A trial item carries a mark of its own and runs on real backends, real disks and real modules; it is hidden from the board, the inbox, the `!` marker and the archive as a preview is, but its cost counts against the budgets.

### 15.4 The needs check

One line per thing that still has to be true, each with a status. The kinds of need are exactly: a **folder** chosen, a **repository** attached, a **backend** signed in, a **connector** authorised, a **secret** set, a **role** filled, a **module** read and approved. A project's needs check has one module line per module its steps run, approved in place (EO-659); before a project exists, a card or an import says only how many modules the pack carries. Each red line says why it is red and carries the one button that fixes it. A role line is worded for somebody who has never heard of a pack or a backend (EO-660): it names the role as its imported agent is named ("An agent for the Reporter steps"), says the steps have no agent to run on yet, and its button names the runtime by its label ("Use Claude Code for these steps"); EO points the role's agent at that runtime only when the button is pressed. The repository line lists every repository on the project by name, each with its own status and, when broken, its own reason (EO-662); it is green while any one works, and a green one carries **Add another repository**, which attaches a further one the way Settings → Projects does — the repository form and `workspaces:create` for a new checkout, `projects:addProject` for one EO already holds. A person who cannot get a line green can leave with **Continue with Preview only**. Nothing real runs until every line is green.

The same list is what an import shows (§18).

### 15.5 Template versions and origins

**Every version of every bundled template ships with the app**, under `apps/desktop/resources/gallery/history/<slug>/<version>.json`, each with release notes saying what changed and why (EO-531). The gallery file is the newest of them, and `history.test.ts` holds the two equal.

**A pipeline made from a template remembers its origin**: the template's slug, the version, and a snapshot of that version — its **base** — stored in EO's database (`template_versions`), so it survives a release that drops an old file. `gallery:use`, importing a document with a `template` block, and the first-run seed each record one; an import re-mints step ids, so the origin also maps each template step id to the pipeline's own. Pipelines that predate origins were given one once, by matching their step ids against the history (`gallery/origins.ts`); one that matches nothing has no origin and is never compared.

**When EO starts on a release that ships a newer version, it compares every pipeline with an origin three ways** (EO-532): the base, the pipeline as the person has it now, and the new version (`compareThreeWay` and `mergeThreeWay` in `packages/engine/src/templateMerge.ts`, pure and domain-neutral; `gallery/templateUpdates.ts` around them). Steps are keyed by id, routes by the step they leave and the result key they route, and a step's settings field by field: its type, entry action, owner, keep checking, inputs, time limit and results. A step's name, summary and place on the board are not compared, and stay the person's. For each key:

| Changed by | Outcome |
|---|---|
| Only the template | Take the template's |
| Only the person | Keep the person's |
| Both, to the same value | Nothing to do |
| Both, differently | Conflict |

A step one side deleted and the other changed is a conflict too: where a step is missing from any of the three, the whole step is one key, its value null on the side without it.

- **No conflict.** The person's graph with the template's changes laid over it is filed as a new pipeline version, its author the template update (`template:<slug>@<version>`, shown as "the … template update"), and the base moves to the new version. Items in flight finish on the version they entered on, as after any publish (§17.5). A comment on the project thread (§7.1) — of the project owning the pipeline, or of each project with work on one nobody has adopted — says what changed, with the release notes of every version since the base, and mentions nobody, because nothing is asked of anyone. The merged graph is judged by `validatePipeline` with the inputs a publish uses, for the projects whose work the pipeline serves (`projectsServedByPipeline`) rather than whichever project is on screen; one that fails is not applied, and is recorded as a conflict with the reasons. The graph, the new base and the notice are written in one transaction, and the threads are opened before it: where one cannot be — a project in the middle of moving to the record — nothing is written and the update waits for the next launch, since an update applied unannounced would never be announced.
- **Conflict.** Nothing from that version is applied — not even the parts that do not conflict, since a new step whose route in is the conflicting one would arrive unreachable. EO records an open update conflict (`pipeline_update_conflicts`): the template version, both stored snapshots, the release notes, and each conflicting key with its base, current and template values. The pipeline keeps working as it is. The same version is not raised again on the next launch; a newer one supersedes it.
- **The conflict notice** (EO-533). Recording the conflict posts one comment on the same project threads an applied update's notice goes to, written in the same transaction and deferred with it when a thread cannot be opened. It mentions the person — on the organisation's record, each of its admins — so it is in their inbox; it names the pipeline, the template and both versions, lists each conflicting key in plain words ("Merge Request's 'opened' route: it went to Done; you have it going to Merge PR; the template sends it to Watching pull request"), and has exactly one button, **Fix with assistant**. That button is a comment option of its own kind: an option is either an answer, the plain string pressing posts as the reply, or an **action** (`CommentActionOption`, `packages/core/src/schemas/commentOptions.ts`) that names what it opens and posts nothing. The chat layout draws actions on the comment, apart from any answers, and an agent reading the thread is told them as buttons for the person, never as answers. Pressing it (`assist:openUpdateConflict`) starts a new assistant chat whose first message is EO's brief — the pipeline's name and id, the template and both versions, the release notes and the conflicting keys, and the instruction to read the details with its comparison tool and propose drafts — posted by EO and mentioning the assistant, so the first turn is dispatched as a person's message would be, with nobody typing. The pipeline is pinned to the brief as the board a draft is published against. The chat is recorded on the conflict, so pressing again, from any project's copy of the notice, shows the same chat; one since put away is brought back, and one since removed is started again. Resolving the conflict, however it is resolved, dismisses the notice's mentions in the same write (`resolveUpdateConflict`), and a pipeline's update to a version that has once been announced is never announced again. Nothing else closes them: a mention on a comment that carries an action is not settled by a remark on the thread or a reply under it, since its button stands for something still open. A conflict held with nobody told — recorded before notices existed, or while its pipeline had no project and no work on any — is announced on the first launch that finds a thread for it. In organisation mode the conflict is the record's, and so is its chat: a desktop pressing the button on the record's notice asks the record (`ItemRecord.updateConflictChat`, `record:updateConflictChat`), which makes the chat once and hands the same chat to every admin who presses after. Every admin's desktop pulls that chat, and mention dispatch is each machine's own, so the record's brief asks nobody: the record hands the brief's first turn to one device — the first to press, kept on the conflict (`chat_turn_device_id`) so the same device asking again after a lost answer gets it again — and only that desktop asks its own assistant, on its copy of the brief (`askAgentAbout`). Before it asks, it copies the chat and the brief into its replica and pins the pipeline to the brief, since that pin is the chat's own state, which the pull does not carry; its next tick dispatches the turn. A desktop that only pulled the chat holds a brief that asks nobody, and answers nothing.
- **Resolving it** (EO-534). The assistant reads the held update with `pipeline_update_conflict`, an `eo_admin` read (`pipeline:updateConflict`, `gallery/updateConflictDetail.ts`): the template and both versions, the release notes, the three graphs in the pipeline's own step ids, every key somebody changed with its three values and which side changed it — conflicts first, compared again against the pipeline as it stands — and the person's own versions since the base, with who filed each and what it changed. It resolves nothing. The reply offers at most three options, the recommended one first: drafts on the ordinary draft card — `draft`, and up to two `alternatives` beside it for the same pipeline, each posted as its own card after the message and each validated on its own (`assistDraftSlot` reads which card is which by its place among the run's last comments) — and the **Keep my pipeline** card (`pipelineKeepMine`), the one card that may come beside a draft. One plain option takes the template as it ships and one keeps the person's pipeline. Publishing a draft from the chat that holds the conflict resolves it: after `pipeline:save`, the card says so with `assist:draftPublished`, and EO checks that the pipeline filed a version since the card and that its graph is the card's before it believes it. Keep my pipeline (`pipeline:keepOwnVersion`) resolves it with no graph change. Either way the base moves to the held version, with a step map read against the pipeline as it now stands (`resolveHeldUpdate`), and the notice's mentions close with it. A step the template adds that a draft gives a fresh id — because another pipeline holds the template's — is named in the draft's `templateStepIds`, the template's id to the draft's; EO checks it against the template and the graph (the same kind of step, running the same thing) and writes it into the new base's step map, so the template's next version still knows the step. The moment a base moves is kept with it (`pipelines.template_base_moved_at`, migration 0137) — by an applied update, an update the person had already made, a resolution either way — and the person's edits are the versions filed after it, each told from the whole of the version before: inputs, time limits and keep checking included. A later template version starts a new comparison from there. **In organisation mode** a pipeline the record holds has its update held on the record, so a desktop asks the record for all three: the tool's read (`record:updateConflict`), Keep my pipeline, and Publish on a draft from the chat about it (`record:resolveUpdateConflict`, through `ItemRecord.updateConflict` and `resolveUpdateConflict`). Publish there sends the draft's graph rather than saving it into the desktop's copy (`assist:publishOnRecord`): the record checks that the device is one of its admins', that the draft came from the chat its Fix with assistant opened, and that its template step ids hold; saves the graph through its own `savePipeline`, filed under that admin; resolves the update and closes its notice. Every replica follows the record's graph as it does any of its pipelines, and a desktop keeping its own copy of an unpublished section is given the same graph once the record has taken it. Which installation answers is decided by where the pipeline is held now (`updateHeldElsewhere`, `recordHoldingUpdateOf`), never by which conflicts a desktop happens to hold: one a desktop recorded before the record took the pipeline over is obsolete, passed over by all three, and closed with its notice — resolved as `held by the record` — on the pull that says so and on the next launch (`retireObsoleteHold`). A read answers whether it was **authoritative**: the record out of reach, or a desktop signed out of it, is "nobody who could say was asked", never "nothing is held", so a draft on such a pipeline is refused for Publish with the reason rather than published into the desktop's copy, which would leave the record's update held.
- **Where a person sees it** (EO-536). The head the board and the Graph view share says where a pipeline came from and what its template has done to it, read with `pipeline:templateStatus` (`gallery/templateStatus.ts`) and drawn by `TemplateOrigin` beside the diverged and webhook chips: "From *Software feature to merge* v1.1" for the template and the version the base is; "Updated to v1.1" for three days after an applied update (`TEMPLATE_UPDATE_RECENT_MS`), whose press shows that version's release notes; and "Update waiting: 1 conflict" while one is held, whose press opens the chat Fix with assistant opened, or — while there is none — the notice that offers the button. A pipeline with no origin shows nothing. The origin and the open conflict are read when asked; the applied update is recorded on the pipeline when EO applies it (`pipelines.template_applied`, migration 0138), since a later save may prune the version it filed. The Changes view and the Graph view's history mark a version a template update wrote (`templateUpdateOfAuthor`, the reading of `template:<slug>@<version>`). For a pipeline the organisation's record holds, a desktop asks the record (`record:templateStatus`, `ItemRecord.templateStatus`), since the origin it kept from before the pipeline moved is out of date the moment the record applies an update; with the record out of reach the head says nothing about the template rather than the stale one.

**SQL migrations no longer edit pipeline graphs.** A template's change ships only as a template version with release notes, and reaches each pipeline through the comparison above. The guarded migrations that came before — 0114 re-pointing pull-request returns, 0123 adding "Watching pull request" — were all or nothing: a pipeline nobody touched was changed without anybody being told, and one somebody had customised was skipped without anybody being told either. That is how EO's own Delivery, whose Merge Request routes into a Merge pipeline, never learned that the watch existed. Those two stay in the migration history, since installations have already run them, and no new one is written.

**In organisation mode** a pipeline the record holds is compared on the record, and reaches replicas as any publish does. Its origin travels with it when its project is moved (`RecordPipeline.origin`: the slug, the version, the stored base, the step map, and the update EO last applied to it, so the record's answer to the pipeline's head still says "Updated to" after the move), because an imported pipeline's re-minted step ids could not be matched to its template again on the far side. A desktop never compares one it follows — one on a project moved to the record, or any pipeline where the organisation publishes the pipelines section — since two desktops each filing their own merge would be two different versions of one number.

---

## 16. The surfaces

The renderer is one React application over one typed IPC bridge, and it has one layout: the window is organised around the conversation with the assistant (§16.1). Every address opens in it. `/`, and any address it does not draw, goes to `/chat`; the address of a screen — `/items/:id`, `/inbox`, `/jobs/:id`, `/settings` and the rest — opens as that screen's view. There is no layout to choose: Settings → Colours, the section that held the layout choice and is still at `?section=layout`, offers colour themes only (§22.3).

Besides the main window there are two others, each the same bundle told by its address what to draw. The **canvas** can be popped out into a window of its own (`?window=canvas`, EO-383), which is how views go on a second monitor; a browser served the renderer cannot open a window and is offered no button for it. The **debug window** (`?window=debug`) is drawn with the same kit and transcript as the rest.

### 16.1 The chat-centric layout

The assistant conversation is the **spine** of the window. Beside it is a canvas of **tabs**, and everything else opens as one: a board, a pipeline's graph, what a pipeline version changed, an item, an item's runs, the item list, the inbox, open mentions, the archive, the jobs list, a job, the gallery, agents, agent tools, and settings. A rail on the far side holds navigation.

With nothing open the canvas is a home overview: what is waiting on the person, what is working now, what is waiting on others, and the open boards. Opening a view narrows the conversation to a column beside it, and for the wide views — settings, agents, the gallery — folds it. The canvas holds a limited number of tabs, which are session state and reset when the project changes, and it can be popped out into its own window.

**Pipelines change through the assistant.** There is no pipeline editor (EO-525): every change to a pipeline — its graph, the tuning of a step, its name, a restored version, export, import, deletion, its item types, and the settings that are deliberately a person's — is something the assistant proposes as a draft or a card, and a person presses the card's button. Nothing is applied by the agent itself, and a secret's value is typed on the card and never reaches it. A pipeline's setup is shown read-only on its Graph view, and what a version changed on a read-only Changes view opened from the board, the diverged chip or the graph's history. Neither has a control that writes; each has a way to the conversation. The rail's **New pipeline** hands the person to the conversation with the cursor in its box and creates nothing, and the old configure address, `/pipelines/:id/configure`, opens that pipeline's Graph view (`?view=graph`).

The window's colours are a theme, chosen per device (§22.3).

The conversation is drawn and driven as Claude Desktop's is. A running turn shows its steps as they happen — what it says, its reasoning under "Thinking", each tool it calls — and its words as they are written, revealed at a steady pace. Once it has answered, everything it did folds behind one line above the answer ("Worked for 1m · 12 tool calls"), which opens to the run's steps (`runs:steps`), each call to what it was asked and what came back; a turn stopped before it answered keeps that work on screen, opened. The box offers **Stop** while a turn runs, and Escape does the same; Up brings back the last message; `/` offers the chat's commands — new, clear, stop, fork, model, effort, thinking — and a picker in the box's row chooses the model, effort and whether reasoning is shown for the next turn. Under each message are Copy and **Fork from here**, which starts a new chat holding the conversation up to that point (nothing in the original moves — the thread is a record); under the last reply, Retry. The transcript follows the newest words only while the person is at the end, and each chat in the rail is marked when a turn is running in it or something in it waits on the person — derived, never stored.

Every conversation room — the assistant's and the module conversation — draws its turns this way. The assistant's chat also pages its history: a view carries the newest hundred messages and older ones are read on demand (`assist:earlier`). A message waiting for the next turn can be taken back (`assist:withdraw`); it stays in the thread, and only the request to the assistant is withdrawn.

**The backend starts while you type.** As in Claude Desktop, typing in an assistant chat with nothing running starts the backend for the turn being asked for (`assist:prewarm` → `RunSupervisor.prewarmConversation` → `AgentProvider.prewarm`): the Claude CLI with its stdin open and nothing said, or the Codex app-server handshaken with its thread open. The supervisor works it out from the very decisions the dispatch will make — workspace, thread reuse, tool directory, schema, settings — and the provider hands it to the dispatch only when the turn's options match it exactly; anything else shuts it down and starts as before. The system agent's admin bearer is minted per turn (EO-444), so a warm process is spawned with one of its own and matched on the bearer's name rather than its value; that bearer is let go when the warm process is dropped or when the turn that adopted it is over, and the one minted for an adopting turn is let go unused. No run exists while it waits and it is shut down after a minute of nobody sending, so it is not a turn held open for a person (invariant 9). A send also asks the engine for a tick at once rather than after its debounce.

One thing Claude Desktop does that this chat deliberately does not: **per-tool permission prompts.** Backends run with prompts off (§12.2), and a prompt would hold a run open waiting on a person, which invariant 9 forbids. The assistant's equivalent is that it never applies its own proposals: what changes the installation is drawn as a card and waits for a person to press it (§11.3).

### 16.2 The board

A column head carries the step's glyph and name, a count, the step's summary, the verification line (§4.5), and on a person's step a control to name its owner.

A card carries the item's key and title; its type label, when the project mixes types; a version chip when it entered on an older pipeline version; a workspace badge — the branch for a git workspace, an eye and the base branch for read mode, the folder name, or "no disk"; its priority; and its assignee — an agent's name on an agent step, a person on a person's step, or a single **Claim** when nobody has it.

Dragging a card to another step opens the confirm-and-comment dialog (§4.4). An item can also be dragged to a hold rail, which parks it, or handed to another pipeline.

### 16.3 The item

On a person's step the **output** sits above the thread, with Copy, Export and — for text — Edit; saving posts a new output comment (§7.8). Below it, the step's **results as buttons**, each naming where it leads. The **thread** is the centre: comments with their replies nested, merged with transitions in time order. The run block lists the latest run's **checks**, each with its sentence and a pass or fail mark, and links to the run's transcript.

### 16.4 The transcript

A transcript is two things interleaved: what the agent *said* and what it *did*. Rendered flat, the doing wins on volume and buries the one sentence explaining why. So a consecutive run of machine activity folds behind a single line — "5 tool calls, 2 files edited" — and expands inset, as detail belonging to the line above.

- **Nothing is dropped and nothing is reordered.** A fold only answers whether you have to look at it now.
- **Errors never fold**, nor does narration, nor a person's message.
- **An unrecognised event type never folds.** The event type is an open string, and an unknown event is exactly what somebody debugging is looking for.
- **A run of one does not fold** — a chevron hiding a single tool call is a click in exchange for nothing.
- **The summary counts what a person would scan for.** Files are counted distinct: three edits to one file is one file edited.

### 16.5 The inbox, the archive and jobs

The **inbox** lists open mentions aimed at a person, grouped by day, each marked blocking or FYI, with filters for blocking, mentions, FYI and unassigned. Rows read "Waiting on you", "Waiting on Anna" or "Unclaimed". When every item in flight is waiting on the person it says so.

The **archive** lists archived items and pipelines, with Restore.

The **job page** is a full editor — the trigger with its time zone stated, the pipeline, the item template, the budget, where it runs, a paused switch and *Run now* — with a **history** of every occurrence (due, what happened, the item, cost, duration), including the skipped ones. A webhook job adds its address and signing secret, a test event, the field-mapping table, and an **events** tab.

---

## 17. Organisation mode

### 17.1 Modes, not editions

**Solo** is the desktop app on its own: everything local, no account, one implicit person called "you".

**Organisation** mode is the same desktop app signed in to an EO server. The server is not a replacement for the desktop. It holds configuration, locks it, keeps the shared record, schedules, and receives webhooks. **Work still runs on the person's machine** — their sign-in to a backend, their files, their connectors — and the server never needs a person's disk.

### 17.2 The server

The server is **the same main process, headless**. Everything the main process needs from its host is one `Platform` interface (`apps/desktop/src/main/ipc/platform.ts`) — pick a directory, open a path, the keychain, the data path, notify, open a window, serve the IPC contract — implemented once over Electron and once over plain Node. The server implementation refuses dialogs, logs notifications, has no machine, and keeps secrets under its own key (§14.2). It then starts the very same `startMain` the desktop does.

- **It is a separate build** of the desktop package, started as a Node program. It needs an operator token, a data directory and a secret key; it listens on loopback by default and takes its host and port from the environment.
- **Storage** is one SQLite file in the data directory — the same schema and the same migrations as the desktop — guarded by a lock so two servers cannot open one directory.
- **It speaks plain HTTP**, and is meant to sit behind something that terminates TLS. The desktop enforces the other half: it refuses a server address that is not `https://`, unless the host is loopback.
- **It serves** the IPC contract (one POST per channel, with a bearer token), a push stream of change frames, organisation secrets to devices entitled to them, webhooks, and the renderer itself.
- **The admin's interface is the renderer**, opened in a browser at the server's address. There is no separate admin product to learn.

**The contract is split in two.** `packages/core/src/ipc.ts` defines a **record** half — everything answered from the database and the engine, which a server implements in full — and a **machine** half — dialogs, file pickers, runtime install, updates, worktrees, anything that needs a person's computer. The full contract is their union. Called on a server, a machine channel answers with a typed machine-only refusal. The same split is what lets the renderer run in a browser.

### 17.3 Identity

People exist before any server does, because a job needs an owner and "have Anna approve it" needs an assignee. Solo mode has one implicit local person; items carry who created them and who they are assigned to; a person's step may name a person or a group; and a mention targets a person.

A server adds the list:

- **Invitations.** An admin invites a person; EO mints a single-use code with a limited life and hands back the link for the admin to send. EO sends no email. Accepting sets a password.
- **Devices.** Signing in from a desktop registers the device and issues it its own token, stored encrypted on that machine. A desktop that runs work is also given the key to the organisation's secrets; a browser session is not.
- **Revocation.** An admin revokes a device, its token stops working at once, and the desktop drops to a revoked state and forgets the organisation's secrets and policy.
- **Groups.** A group can own a person's step — "Support team · anyone claims" — and scope who sees a project. Claiming is an assignee change and a comment, not a transition.
- **One admin flag.** A person with it may use the admin-only channels: publishing, people, devices, policy.

On first sign-in a person who already has local projects is asked, per project, whether to **keep it local** or **move it to the record**. A kept project stays entirely this machine's, scheduled here, unknown to the server. Moving is one-way.

### 17.4 The record

**Whoever owns item state is "the record", and there is exactly one per item.** The record runs the only scheduler for the items it owns; a **device** claims a dispatch under a lease with a time limit, runs the machine-local preflight — signed in, agent available, workspace prepared — does the work, and reports the result or the refusal.

This is not a second engine for organisation mode. In solo mode the desktop plays both parts in one process: it is the record and it is the device, and the lease is local. One interface (`ItemRecord` in `apps/desktop/src/main/record/record.ts`) has a local and a remote implementation, and the choice is made per item — which is how a kept-local project and a moved one live side by side on the same desktop.

On a signed-in desktop:

- **Scheduling.** The desktop asks the record for work; the record runs the engine's tick and grants leases. A lease is renewed while the run lives, released when it ends, and one that expires is released with an engine comment.
- **Moves are provisional.** A move a person makes is written locally and queued as a command for the record. If the record had already applied a different move, it answers *superseded*, and the person gets an inbox row saying whose move won — never a silent revert.
- **Runs and run events sync upward**, append-only, by run and sequence, so the rule that `run_events` is never rewritten holds on both sides.
- **Changes come down** by cursor, prompted by the push stream.
- **Offline.** The desktop keeps working on what it has: it finishes the run it holds and queues the result, with a visible offline line. Offline means "finish and queue", not "keep scheduling locally" — the record is the only scheduler for what it owns.

Side effects outside EO follow the same ownership: only the record tells a tracker that an item moved, so one move is one push however many desktops are open.

**What an item waits for is the record's** (EO-600). A record-held item's edges are read by the record's scheduler, and a cycle is a question about the record's whole graph, so `items:update` and an approved reorder card ask the record to change them (`record:changeDependencies`, through `ItemRecord.changeDependencies`). The record judges and writes the change whole, with its comment filed under the person whose device asked. On a step that waits on a group it first asks whether that person holds the item, against its own copy rather than the replica's, which may be a takeover behind; a refusal is said on the item and in the answer. It answers with the item and the comment, which the desktop copies into its replica at once. An unreachable record changes nothing, says so, and queues nothing. A call that changes the edges and other fields of such an item is refused: the two halves would land on two machines, and nothing could make them land together.

**Memory follows the project** (EO-482). A record-held project's memory, and the memory of its workspaces, is the record's: every desktop working on it is given the same entries. So a write to it is asked of the record rather than made on the replica, as a module's item creation is (`record:createItem`). That covers a run's `memory_note`, the notes extraction draws out of a run, and a person's add, edit, retire and restore. Each is a `record:memory` round trip through `ItemRecord.writeMemory`.

- **The record checks the write itself.** A note must come from a run on an item of that project, under `memory_note`'s rules, and from the device that ran it: one holding the item's lease with no other machine's lines on the run, or one whose lines the record already has for it. It never rewrites a run it already holds on a note's say-so. So a desktop sends the note's run, and every line of it not yet sent, through `record:apply` before the note itself: a reply to a parked run, or a recovery, holds no lease, and its lines are how the record knows which device ran it. A person's entry is sourced to the person whose device asked.
- **The changed rows come back with the answer** and are copied into the replica at once. Every other desktop takes them on its next pull, on a `memories` cursor of their own.
- **An unreachable record means nothing was written, and the tool says so.** The `eo` server cannot write and cannot reach the record; it hands every note to the main process over the agent write bridge (§13.1, `mcp/writeBridge.ts`, a bearer per item, given with the turn), and the main process writes it through the record as the run it is driving on that item and answers with what happened; that answer is the tool's. "Not saved" is the record's own word rather than a guess from a cached link state, and nothing is written locally. A turn with no bridge is told nothing was written.
- **Workspaces never travel, so an entry carries its project** (`memories.project_id`). That is how the record places a workspace's entries without the workspace's row. It is kept where a workspace's project is written (`updateWorkspaceProject`): a workspace attached for the first time, or moved to another project, takes its memory with it.
- **Consolidation runs on the record.** A desktop leaves a moved project's scopes alone, and asks again before applying an answer: a consolidation still running when its project is handed over changes nothing here. Its consolidations are listed and undone on the record (`record:memoryConsolidations`, `record:restoreMemoryConsolidation`).
- **Memory travels with the project.** Moving a project carries its entries, retired ones and their sources included, and counts them like every other table.
- **Memory never travels with a pipeline** (§18.1).

### 17.5 Publish, lock and versions

An admin edits pipelines, agents, packs, connectors and policy on the server exactly as a solo person edits them on a desktop, and **publishes** a section to every signed-in desktop. The sections are exactly: **pipelines, agents, packs, connectors, policy**.

**A published section locks on the desktops that receive it.** The lock is per section, not per field — a partly locked editor is confusing to read and hard to explain. It is enforced where every request enters the main process, with a typed refusal, so the renderer, the assistant's administrative server and an outside MCP client all get the same answer; a lock only the renderer knew about would let the assistant rewrite a published pipeline from a chat. The lock text says what is locked and what stays the person's: "Steps, routes and prompts are managed by your organisation. Your sign-ins, local folders and personal secrets are yours." Unpublished sections stay editable locally.

**A published agent** carries its role, instructions and tool surface, and may recommend a backend and model. Backend and model stay local, so a locked agents section never stops a person who is signed in to one backend and not the other. A record-held project's own agents are not in the publication; they travel with their project (§12.1), and the same lock covers them.

**A pipeline version is a snapshot of its steps and routes.** An item binds to the version it entered on and finishes on it, unless somebody moves it with `item_move_to_version`: routing and scheduling for that item read the bound snapshot. A move within a pipeline never changes the binding, and refuses a step the item's own version lacks; handing the item to another pipeline binds it to the version it arrives on. `item_move_to_version` (`items:moveToVersion`) is the explicit request to rebind: it names a version the pipeline keeps, older or newer, and binds the item to it without touching its step, pipeline, assignee or branch and without writing a transition — refused, changing nothing, where that version lacks the item's step, where the item is already on it, while an agent is working on it, and for an archived item or one on no pipeline. Binding to the current version means the live graph, as for an item that entered on it. One comment says which version it left, which it is on and who asked. On a record-held project it is a command the record judges and applies (§17.4), bumping the item's `updated_at` so replicas page it, and a published pipelines section does not lock it: it changes which version an item finishes on, not the graph. On the board, an item on an older version wears a version chip, a step that exists only in an older version and still holds items is drawn as a ghost column until it empties, and a banner says a pipeline was updated and by whom, with a view of what changed.

An item on the current version reads the live graph rather than its snapshot, so a graph changed outside a publish — an older migration that added a step to the shipped pipeline, such as "Watching pull request" (migrations no longer do, §15.5) — is what those items run on from the moment it lands. Before the next publish moves the pointer, EO compares the live graph with the current version's snapshot and, where they differ, files the live graph as a version of its own and binds the current version's items to it, so a publish never starts reading them against a document that has no step they are standing on.

A new graph that would strand items — by removing a step they sit on — is refused, naming how many it holds. **Rollback** is publishing an older version again. Old versions that nothing references are eventually pruned.

### 17.6 Divergence and suggestions

A person on a desktop may edit a published pipeline locally when they want to propose a change. Doing so marks it **diverged**: only that pipeline unlocks, and updates from the organisation stop applying to it silently, though they are still stored. The board shows a diverged chip, as a fact rather than a warning, and three things can be done about it:

- **Compare** — the chip opens the read-only Changes view on this machine's own edits;
- **Suggest my change** — send the local edit to the organisation;
- **Discard my edits** — restore the published version.

The last two are cards the assistant draws and a person presses (§11.3), as every change to a pipeline is (§16.1).

**A suggestion is an item.** It sits on an internal *Pipeline changes* pipeline with one human step owned by the admins, and the proposed pipeline is its output. So it has a thread: the admin can ask "why did you drop the review step?" in the one channel there is. The admin reads it as a difference of steps, routes, prompts and modules against the published version. Approving applies the document and publishes it; sending it back returns it to its author with the reason. Until then it reaches nobody else.

### 17.7 Policy

An organisation publishes policy:

- **allowed backends** — checked when an agent is bound and again at dispatch, with a refusal comment;
- **a budget per person per day** — the owner a job's or an item's spend draws on. A trip happens before dispatch, so it is not a route: the work parks and the person is mentioned;
- **which MCP servers exist** — published servers are applied on each desktop, and a local edit to one is refused;
- **organisation secrets** — named in policy and delivered encrypted to devices that run work.

Budgets per item, per day and per job occurrence remain guardrails as in solo mode (§5.5, §9.4).

### 17.8 What a person notices

A lock on the sections the admin published, and otherwise nothing: the board does not look different. The exceptions are states rather than chrome — the offline line, a provisional move, a superseded move, a version chip.

---

## 18. Export and import

### 18.1 One document

A pipeline exports as one JSON document with a format version (`PipelineExportSchema` in `packages/core/src/schemas/pipelineExport.ts`). It carries the pipeline and its entry step, the steps, the routes, and everything they depend on: the **modules** (code, manifest and tests), the **roles** its agent steps need (with instructions, the action definitions each role has — description, results with labels and meanings, fields — and, as JSON Schema, the output schemas a code pack ships for them), the **item types** with their spec shapes, **connector** and **MCP server** definitions, the **vocabulary**, an example **preview item**, and optionally a **template** block that makes it a gallery entry. A data pack, a gallery template, an organisation's suggestion and a file somebody emailed are all this one document. What a project's runs and people learned, its memory (§7.5), is never in it.

### 18.2 Import is the needs check

Opening a document shows the same list as first run (§15.4): what this needs, line by line, with the fix on each.

- **Modules land unapproved.** The document carries code written on another machine, and it cannot run until a person here has read and approved it.
- **Connectors land disconnected, secrets unset, role slots unfilled.**
- **A role that asks for the administrative grant is refused outright**, not stripped (§11.4). So is a connector EO cannot set up.
- Where a module in the document has the same slug as one already installed, the person chooses to reuse theirs or import the document's.

A pack names roles, not backends (§12.1), so the installing machine chooses which agent fills each.

### 18.3 How a pack travels

- **As a file**, sent however people send files.
- **Through the organisation server**, as a suggestion an admin approves (§17.6).
- **Through the gallery**, whose bundled entries ship with the app and whose fetched index is maintained by EO.

---

## 19. The developer pack: git, the forge, Jira and repository intelligence

Everything in this section is contributed by the developer pack (`apps/desktop/src/main/packs/developer/`). It is what makes *Software feature to merge* work, and none of it is known to the core.

### 19.1 Worktrees, and the limit of isolation

In isolated mode each item gets its own git worktree on its own branch, under `~/.eo/worktrees/<KEY>`: a lightweight checkout that gives the agent full filesystem isolation without duplicating the repository. It is created by the `create_worktree` builtin, so it is a step with a card, an elapsed time and somewhere to fail.

**Cut from the remote, never the local branch.** The start point, the rebase target, the "has commits beyond the base" check and the "has this dependency landed" comparison all read the remote-tracking ref, fetched at dispatch. A person's local main is whatever they last left it as. EO never fast-forwards, checks out or stashes anything in their working copy. A repository with no remote falls back to its local branches; a configured remote that lacks the branch escalates rather than cutting from a stale one.

**Stacking.** An item that depends on an unmerged item of the same feature in the same repository is cut from that item's branch rather than the base, and rebased when the dependency lands.

**Worktrees give filesystem isolation only.** They do not solve decomposition, dependency tracking or semantic conflict. The mitigations, in order of value: the dependency graph (§8.1); running one thing at a time (§5.3); rebasing onto the current base and re-running the checks before review; and a person merging.

### 19.2 Verification, review and the pull request

**The implementer's claim is never taken on trust.** After an `implement` run the git kind checks for itself: the branch has commits beyond the base, the tree is clean, the project's configured test command actually ran, and no file on the branch is byte-identical to another item's unmerged work. That last check exists because a worktree is where an agent is *pointed*, not a boundary it is held inside — it can read any other checkout on the machine — and policing reads is either evadable or breaks git itself. So EO checks the result instead of the act.

**Review** is the reviewer role answering with a verdict and feedback, and on a rejection a result for each acceptance criterion. Quality of judgement is the model's; *how much of the item the review accounted for* is not, so the engine compares the reported criteria against the ones the item declares and says in the thread which were left unexamined. The feedback is a comment, which is how the next implementer attempt reads it.

**The pull request** is opened by the `open_pull_request` builtin through the forge's own command-line tool — `gh` for GitHub, `glab` for GitLab. It pushes, looks for an existing request, creates one, and looks again: looking before creating prevents a duplicate after a crash, and looking after means the address is read back as a fact rather than scraped from a command's chatter. **Opening is not merging.** A person merges; EO's job is to get work to review, not past it.

**Watching the pull request** is the `watch_pull_request` builtin, a check for a step that keeps checking (§4.2), through the same two CLIs. Each check reads the pull request's state, mergeability, review decision, check runs and review comments, and answers with the first that is true: `merged`, `closed`, `conflict`, `checks_failed` (once every check has finished and one failed), `changes_requested`, and — only when the step's `reportReady` input is true — `ready`, approved with every check green; otherwise `waiting`. The step's `readyWhen` input says what `ready` takes besides green checks: `approved`, the default, is an approval on the forge; `mergeable` (EO-515) is the forge's own verdict that it can merge the pull request — GitHub's `mergeStateStatus` `CLEAN`, `HAS_HOOKS` or `BEHIND`, GitLab's `detailed_merge_status` `mergeable` or `need_rebase` — for a repository where nobody approves on the forge. That verdict already holds whatever branch protection requires, and a branch only behind its base counts, since the watch cannot update it and the merging step rebases; any other status is `waiting`, naming it. Seeing no checks is not green on the first check of a stay (EO-620), because CI may not have started and GitHub says `CLEAN` before it has: that check answers `waiting` and says so. A later check of the stay that still sees none may answer `ready`, saying no checks were reported, so a repository with no CI gets there one interval later. CI that takes longer than an interval to appear can still slip through. On GitLab the head pipeline's own status counts as a check beside its jobs: the jobs list leaves out trigger jobs, so a pipeline that is unfinished holds `ready` back, and one that failed or was canceled answers `checks_failed`, whatever its jobs show. A failure the ticket came back to gets one check's grace (EO-622): on the first check of a stay, when every failed check was already reported on this commit and nothing is pending, the watch answers `waiting` and says so, because the push that brought the ticket back was seconds ago and CI cannot have restarted. Only that check: the watch never gives up, so ignoring the failure for good would leave the ticket waiting on nothing, and a failure first reported on a `waiting` check of this stay is still owed `checks_failed` once the others finish. If the failure still stands, the send-back posts news naming each check and the commit and saying CI was not restarted, once per stay, since the old failure's own news is not posted twice; it counts towards the round-trip guardrail like any other. Which reports came before the arrival is read off the watch row, which is reset on arrival, against the item's runs. Its news is each failed check with its link, each review comment with its author, and a conflict appearing, with ids from the forge and the head commit. The lists come from the forges' APIs rather than `gh pr view`, because that is where each entry carries its own id — a check *run*, not a check name, so two checks of one name stay two and a re-run that fails again is news — and every page of each is read, since the newest comments are on the last page and a job missing from the first could still be running. A GitLab manual job holds the checks open only when it is blocking (`allow_failure: false`). A request for changes is answered once, and review comments are posted once, judged against the news the item's earlier checks recorded on their runs rather than one stay's watch row. `ready` is answered at most once per head commit per stay on the step (EO-617), its news id naming both, so the run that stored the answer says which stay it was, on a step with no watch row as on one with: a ticket parked after `ready` and replied to hears `waiting`, whether that `ready` was stored under this id or the older `ready:<sha>`, which is placed on its stay by the watch row or, on a step with none, by whether the run is still parked on that step, never by comparing it with the arrival, since the two come from different machines' clocks, and one that comes back on the same commit with the pull request still qualifying hears `ready` from the first check of the new stay, or the next one where it sees no checks at all, since that rule starts again with every stay. The one exception is in §4.2. So a pipeline that sends `ready` to a step which returns the ticket to the same watch to wait for a merge gets `ready` on every return until the round-trip guardrail stops it (§5.5); that shape needs a second watch step without `reportReady`. Each request is answered on its own — on GitHub the review that stands as one, on GitLab the newest `requested changes` system note of a reviewer still asking — so a reviewer who approves and then asks again is asked anew, one of two reviewers approving is not a new request, and nothing is `ready` while any request stands, answered or not: a forge goes on saying "changes requested" after the fix is pushed, until the reviewer looks again, and the work must not be sent back for a review it has already had. A ticket with no pull request answers `failed` with a note; a CLI that is missing or not signed in fails the check with a note saying which, and the watch's backoff asks again. It only reads, so it declares no side effects. In *Software feature to merge* it is the step after Merge Request (EO-461), and the news a check posts is on the item before its result routes, so an implementer sent back over a failed check is dispatched with the comment naming it among what each step said. Migration `0123` added the step to an installation whose Merge Request still sent `opened` to Done, and left one whose owner routed it elsewhere as it was; such a pipeline now meets the step as *Software feature to merge* 1.1, through the three-way comparison (§15.5), which holds the update as a conflict on that route rather than skipping it in silence.

`index_repository` is the third builtin: it builds or refreshes the repository index.

### 19.3 Jira

Jira is a connector bound per project: a connection (Cloud or Data Center), a project key, the issue types that correspond to a container and to work, a map from pipeline step to Jira status, and any fields a transition requires.

- **Import** brings in one issue at a time, when asked. EO does not import a backlog; the point is to start work that already has a key, not to keep a second copy of Jira.
- **Push** creates in Jira what EO creates, and mirrors moves and comments. It happens after the EO item exists and can never stop it existing: Jira being down is a comment on the item, and the work carries on.
- **Pull** asks Jira what changed, on an interval and at launch.

Outbound writes go through an outbox, so they survive a restart and retry. In organisation mode only the record pushes (§17.4).

### 19.4 Repository intelligence

EO can build an index of an item's checkout — symbols, callers, callees, imports — and hand the agent working there an MCP server, `repo`, to query it, so that navigating a codebase is a question rather than a search. It is off unless enabled in Settings. The index is built outside the worktree, the server is lent by the git kind's `attach`, and everything else talks to one provider interface rather than to the implementation. The pack's own notes, and what measuring the feature found, are in [`apps/desktop/src/main/packs/developer/repositoryIntelligence/README.md`](./apps/desktop/src/main/packs/developer/repositoryIntelligence/README.md).

---

## 20. Licensing and updates

### 20.1 Licensing

EO is licensed under [Apache-2.0](./LICENSE). Third-party components are listed in [`NOTICE`](./NOTICE).

### 20.2 Updates

Packaged builds update through `electron-updater` from the project's GitHub releases. EO checks at start and every six hours. The releases are public, so a check needs no setup and no credential. An unpackaged build never checks.

Installers are built per platform: a `.dmg` for macOS on each architecture, one NSIS installer for Windows covering x64 and arm64, and an AppImage for Linux. The macOS build is not code-signed, and `electron-updater` will not update an unsigned Mac app, so until there is a signing certificate Mac users update by downloading the new installer.

---

## 21. The stack

Electron 39 · TypeScript (strict) · React 19 · Tailwind CSS v4 · Base UI · @dnd-kit · TanStack Query · react-router · react-virtuoso · SQLite through better-sqlite3 and Drizzle · Zod, and ajv for schemas that arrive as data · the Model Context Protocol SDK · pnpm workspaces and Turborepo · Vitest and Playwright.

Each choice below is stated with what it was chosen over, because the reasons are the part that cannot be read off the code.

### 21.1 The constraint that decides most of it: agent tooling is Node

EO supervises agent sessions on the person's own machine. The agent SDKs and CLIs are a Node ecosystem: the Claude Agent SDK is TypeScript and Python only, and Codex is a CLI driven by exchanging JSON over standard input and output. Any language can spawn a process and parse lines — but doing so per backend means re-implementing and then maintaining, against fast-moving and thinly documented interfaces, what the vendor already maintains: resume semantics, event schemas, attachments, error taxonomies. That trade is what the next two decisions follow from.

### 21.2 Electron, not Tauri

Tauri's small binaries are real only if the application's logic lives in Rust. EO needs a Node runtime — that is where the agent tooling lives — so under Tauri it would bundle Node as a sidecar and hand-roll the IPC to it: most of Electron's size, plus a distributed-systems problem inside the installer. Electron ships Node as the main process, which for EO is not bloat but the feature: `child_process`, a line reader, an embedded synchronous SQLite, bundled extra resources and auto-update are all its home ground. Tauri becomes the right answer only if install size turns into a hard requirement, at the price of the sidecar.

### 21.3 All TypeScript in the main process, not a JVM sidecar

A Kotlin and Spring sidecar was the serious alternative: domain logic in a language well suited to modelling state machines, and a server tier ready-made. It lost on what it costs a desktop app — no agent SDKs, so a hand-rolled protocol per backend; sixty to eighty megabytes more installer; seconds of cold start, or per-platform native-image builds to avoid them; a second process to start, health-check, and clean up when the app is force-quit, with a "backend failed to start" state users would meet; and a serialisation boundary on every interaction. The JVM's advantages are server advantages, and none of them apply to a process living inside a desktop app.

The decisive point is what the engine is: about a fifth state transitions and four fifths supervising agent processes, streaming their output and managing their life. Splitting those across a process boundary puts the hardest problem on both sides of an IPC hop.

The door stays open the cheap way: **`packages/engine` is pure**, so the scheduling and routing rules are the one part that would port anywhere, and the organisation server is the same main process run headless rather than a second implementation.

**The MCP host and the organisation server are not the sidecar this rejects.** The rejected design put EO's own domain logic behind HTTP and shipped a second runtime to serve it. The MCP host is a second caller of the same in-process handlers, off by default, whose failure to bind costs nothing (§13.2). The server is the same code, the same contract and the same database schema, in one language.

### 21.4 React and its ecosystem, not a native UI toolkit

Avalonia, Uno, MAUI, Blazor Hybrid and Compose Multiplatform were all considered and all rejected for one reason: each means hand-building a design system and a drag-and-drop board from primitives, which is exactly the cost the React ecosystem removes. @dnd-kit was the deciding library — it is the maintained answer for accessible drag and drop in React, and a board is drag and drop or it is a list. Components are owned source, in the manner of shadcn/ui: the chat layout's kit (`apps/desktop/src/renderer/src/chat/kit/`), styled with Tailwind v4 over the tokens in `packages/ui`.

Client state is deliberately small: server state is TanStack Query over IPC, with the main process pushing invalidations, and what remains is component state and a few per-device choices kept in the browser profile behind `useSyncExternalStore`. There is no client state library because there is no client-owned domain state to hold.

### 21.5 SQLite, and nothing more

One file in the application's data directory, opened through better-sqlite3, queried through Drizzle, migrated with versioned SQL.

- **Not Postgres**, which earns its place in a multi-tenant hosted service. EO is one process on one machine — and so is its server.
- **No sync engine, no CRDTs.** In solo mode there is no second replica. In organisation mode the record is authoritative by construction: devices send commands and append-only events, and the record wins a conflict and says so (§17.4). That is a queue and a cursor, not a merge.
- **Not a workflow server** such as Temporal, nor a Postgres-oriented durable-execution library. An append-only log in the database already open is the right size for one process (§6.2).
- **better-sqlite3 because its API is synchronous**, which is a feature in a main process that wants a boring, synchronous tick, and because it is N-API, so its prebuilt binaries survive Electron upgrades without a compiler on the installing machine.

Two habits come with it. **IDs are UUIDv7, generated by whoever creates the row**, never autoincrement: nearly free at the start, the thing that hurts most to retrofit, and what makes syncing rows between a device and a record possible at all. And **each native module has exactly one import site, behind an interface**, so an Electron major bump — which changes the Node ABI — touches one file.

### 21.6 Zod for schemas in code, ajv for schemas that arrive as data

Every schema EO defines is Zod. It is the single source of truth for anything crossing a boundary — IPC, agent output, configuration — and it emits the JSON Schema each backend constrains generation with. What Zod cannot do is *consume* JSON Schema, and a data pack ships its roles' output schemas in a document. So both kinds sit behind one `OutputSchema` interface (`packages/core/src/schemas/outputSchema.ts`): parse a value into data or a list of issues, and emit JSON Schema.

**ajv 8 was chosen** for the documents:

- **Every dialect a pack author is likely to have written.** The edition a document declares is the one it is read with — 2020-12, 2019-09 or draft-07. Reading one with another's validator does not merely misread it; a draft-07 tuple would silently stop being a tuple. Draft-06 and earlier are refused by name: an edition EO does not test is one it does not support.
- **No added footprint.** The MCP SDK and the packaging tool already bring ajv into the tree, and it has no Node imports, so `packages/core` stays pure.
- **Complete error reporting** in the same shape Zod gives — a path and a message per issue — so an agent's re-prompt is one list rather than one field at a time.
- It is the reference implementation most tooling tests against, so a schema that validates in a pack author's editor validates in EO.

**Rejected: an EO-defined subset of JSON Schema compiled to Zod.** It would have meant inventing a dialect, documenting it, and telling authors which parts of the standard they may not use — with every gap surfacing as a schema that validates in their editor and fails in EO, and a subset that had to grow with every pack. **Also passed over:** `@cfworker/json-schema`, a fair candidate that lost on being less widely tested against and on error objects that do not name the missing property; and JSON-Schema-to-Zod converters, which are the subset option wearing a dependency.

Two asymmetries are known and tested: a JSON Schema document returns its input as it was, with no defaults filled and no unknown keys stripped, where Zod does both; and nothing in a document can stand in for a Zod preprocess step.

**A document reaches a backend whole.** EO wraps a result schema beside its clarification branch, which moves the document's root — and would change the meaning of any internal reference. Rather than rewrite references, a document that uses any reference machinery is embedded whole under the wrapper's definitions with an identifier of its own, as the specification's bundling provides, and the wrapper declares the *document's* dialect. A document with none — every schema Zod emits — is placed inline.

### 21.7 Codex through its app server, not its SDK

The Codex TypeScript SDK wraps the CLI's one-shot execution mode, which has no handle on a turn once it has started: no steering, no interruption, no live limit readings, no MCP startup status. Those gaps were most of what would have left Codex behind Claude, and so most of what the parity rule forbids. EO therefore speaks the CLI's JSON-RPC app-server mode with its own client. The cost is a protocol client to maintain; the alternative was a backend that could not be held to parity.

### 21.8 Process supervision

Agents and modules are child processes of the main process, and their trees are killed on timeout, cancel and quit. Events are buffered and throttled in the main process — an agent in a loop emits faster than a window can draw — and the renderer is never streamed raw events.

### 21.9 Packaging

electron-vite builds, electron-builder packages. The agent CLIs are excluded from the installer and fetched on demand (§12.6). A runner that bundles unsigned command-line tools is close to a worked example of what antivirus heuristics flag, so installers want signing: notarisation on macOS and an Authenticode certificate on Windows.

---

## 22. The visual design system

The tokens are the `@theme` block in `packages/ui/src/styles.css`, at the values of the Slate theme (§22.3). [`tokens.css`](./tokens.css) at the repository root is the portable copy, generated from it; `scripts/design-tokens.mjs` generates it and enforces the rules in §22.7. The controls drawn from them are the chat layout's own kit, `apps/desktop/src/renderer/src/chat/kit/`, and the theme a person chooses is painted over the colour tokens.

### 22.1 Genre: utilitarian

The system's argument is that it should not have one. EO's job is to make someone else's work legible — you are reading what an agent did — and the design's role is to get out of the way of it: no display typeface, no accent scheme, no concept. That is not the same as undesigned. Density is deliberate, the ink ladder is three real steps, the radii are generous on purpose, and every colour is solved for contrast.

Seven rules hold across every screen:

1. **Type is roman.** Never italic for emphasis inside an upright heading.
2. **Mono means machine.** Keys, branches, hashes, paths, transcript output, durations. If a person typed it, it is not mono.
3. **There is no display typeface.** Hierarchy is weight and size.
4. **Status is its own scale, never the accent.**
5. **Contrast is computed, not chosen.**
6. **The accent never reports state.** A thing in the accent colour is something you can do.
7. **Depth is lightness, never a coloured glow.**

### 22.2 Type

Two families and no third: **Geist** for everything a person reads (400 body, 500 dense chrome, 600 titles) and **JetBrains Mono** for text a machine wrote or parses. The display role resolves to the body face.

The scale is a major third from a **14px chrome base**, with a separate **16px reading base**:

```
--text-2xs   11px   counts, dense metadata
--text-xs    12px   labels, column heads
--text-sm    13px   dense rows, the rail
--text-base  14px   chrome workhorse
--text-read  16px   reading surfaces only
--text-lg    18px   subheads
--text-xl    22px   section titles
--text-2xl   28px   screen titles
--text-display 32px
```

**Dense chrome against generous reading is the rule that makes it work.** The scale is what the base styles and the Markdown renderer read; the chat layout's kit sets its chrome a step denser, at sizes of its own between the steps — mostly 11.5 to 13px — so a board still holds six steps. Text a person reads — a turn, a comment, an item's body — is set larger, with generous leading and a bounded measure. Every size on the scale declares its own line height, because Tailwind pairs a line height with each size utility and one declared without would silently inherit a default. Columns of numbers use tabular numerals.

Two label registers: a **micro-label** — mono, uppercase by `text-transform`, tracked — for a metadata key or the word beside a status dot; and a **section label** — body face, sentence case, 600 — for a heading a person reads. Casing is never written into the string, so the accessible name stays the sentence somebody wrote.

### 22.3 Colour

The window's colours are a **theme**, chosen per device in Settings → Colours and kept in the browser profile rather than the database (`apps/desktop/src/renderer/src/chat/theme.ts`), because how a window looks is not a fact about the work. Seven presets ship: **Claude**, the default, **Slate**, **Linear**, **GitHub Dimmed**, **Nord**, **Catppuccin Mocha** and **Tokyo Night**. All but Slate are the dark schemes of products people already spend the day in, each a full palette tuned by hand, because what makes them look right is the particular ladder of greys under them and no two-colour rule reproduces both Linear's near-black and Nord's light slate.

**Slate is the design system's own palette**: the values in `styles.css`, the ones the checker computes (§22.7) and a custom theme's lightness steps are taken from. It is a cool ground at hue 262, around 21% lightness — lighter than near-black, which is most of why it reads as a room rather than a void.

| Token | Value |
|---|---|
| `--color-canvas` | `oklch(21% 0.016 262)` |
| `--color-canvas-subtle` | `oklch(24% 0.017 262)` |
| `--color-canvas-raised` | `oklch(28% 0.018 262)` |
| `--color-canvas-hover` | `oklch(32% 0.019 262)` |
| `--color-canvas-active` | `oklch(36% 0.02 262)` |
| `--color-line` | `oklch(31% 0.016 262)` |
| `--color-line-strong` | `oklch(42% 0.018 262)` |
| `--color-ink` | `oklch(94% 0.006 262)` |
| `--color-ink-muted` | `oklch(76% 0.01 262)` |
| `--color-ink-subtle` | `oklch(66% 0.012 262)` |
| `--color-accent` | `oklch(55% 0.18 258)` |

In Slate, hairlines barely register; the lightness step does the separating. Its accent is a mid blue carrying near-white text, so a primary action reads as a solid object rather than a highlighter. There is no translucency: window vibrancy is a platform material, not a token, and the ground is flat.

A theme replaces the ground, line, ink, accent, focus and scrim tokens — and one extra, a deeper ground for the rails and the conversation's own surface — by setting them on the document root, so a dialog or a menu drawn in a portal wears the same colours as the window it opens over. **The status scale is not themeable**, apart from the idle grey, which is a ground colour: running, reviewing, paused and danger mean the same thing in every theme. Claude's clay accent sits between failed and waiting, where no hue is 35° from both; it is kept because it is the scheme, and it does no harm because a status mark is always drawn in the status scale, never in the accent.

A **custom** theme is two seeds — a hue and chroma for the ground, a hue and chroma for the accent — and everything else is derived, not picked: the canvas ladder at the Slate lightness steps, inks lightened until they clear 4.5:1 on a raised surface, an accent fill that clears 3:1 against the canvas with whichever of a light or dark ink reads on it, a hover step, and a focus ring that clears 3:1. Contrast stays computed even when a person chooses the colours. If a custom accent of real chroma falls within 35° of a status hue, the picker says which state it would be mistaken for.

**Status is its own scale.** Running is not success and paused is not a warning: a run in flight has not succeeded, and an item waiting on a person is not a problem. Reusing those tokens is how a dashboard ends up looking alarmed at normal work.

| Token | Value | Means |
|---|---|---|
| `--color-running` | `oklch(71% 0.15 150)` | an agent is working |
| `--color-reviewing` | `oklch(66% 0.16 305)` | awaiting review |
| `--color-paused` | `oklch(79% 0.13 75)` | waiting on a person |
| `--color-idle` | `oklch(58% 0.012 262)` | nothing is happening |
| `--color-danger` | `oklch(67% 0.18 22)` | destructive, failed |
| `--color-warning` | `oklch(79% 0.13 75)` | needs attention |
| `--color-success` | `oklch(71% 0.15 150)` | done |

Reviewing is violet rather than blue because the accent took the blue, and an accent a few degrees from a run state is exactly the collision — "you can act" reading as "the machine is working" — the scale exists to prevent.

### 22.4 Shape and spacing

Radii are generous: **6px** for chips and inline marks, **10px** for inputs, buttons and rows, **14px** for cards, panels and dialogs. That softness is what stops a dense dark tool reading as a spreadsheet. A pill is a status, never a button.

Spacing is Tailwind's own four-point numeric scale, and **there is deliberately no named scale on top of it**. Tailwind v4's named spacing keys share a namespace with its container scale and win the lookup, so declaring a spacing token called `md` makes `max-w-md` resolve to that spacing value instead of the container width — a paragraph wrapping one word per line, with nothing failing and nothing to search for. Declaring a container token alongside does not reclaim the name.

Rhythm: **do not pad every region equally.** The rail is tight, boards are medium, reading surfaces are generous.

### 22.5 Depth and motion

Depth is lightness, not shadow: on a dark screen lightness is what reads as closer. Static surfaces step up the canvas ladder and take no shadow. Only floating layers — menus, dialogs, drag ghosts — get the panel shadow, a hairline ring and a tight umbra, never a halo. There are seven named z-levels and no ad-hoc numbers.

**Cards on the board are cards**, one step up the ladder at the 14px radius. The column draws no border of its own, so there is one containment layer, not a card inside a card. An empty column draws its edges, because a region you can drag onto has to show where a card would land.

Motion is CSS only; there is no motion library. Three named easings and three durations (120, 220 and 420 milliseconds). Animate transform and opacity only. One orchestrated entrance per screen and no scroll-triggered reveals — this is an application, and content that fades in as a list scrolls is hostile. A focus ring appears instantly. Reduced-motion collapses animation to near zero, **except spinners**, which stay running: a frozen spinner reads as a hung app, which is worse than the motion.

### 22.6 Interaction

- **Silent success.** A thing that visibly changed does not also announce that it did.
- **A confirmation only where an action is genuinely irreversible** — deleting an item, a project, an agent — and the confirmation spells out what will be removed.
- Hover carries one signal per element, a colour shift or a one-pixel move, never both.
- Every hover affordance has a keyboard equivalent. No hover-only controls.

Screens pick the family that matches their job: **map** for a pipeline, which is a routing graph and is drawn as one, with visible edges; **index** for lists — items, inbox, archive, agents — dense, scannable and sortable; **long document** for an item, a transcript, a conversation and settings prose.

Two things are deliberately not done. **A person's turns are not tinted in the accent**: they sit on the right in a bubble one step up the ground, as Claude Desktop draws them, and the one colour reserved for action is not spent on the text carrying the least information. And **reasoning is not given invented titles**: output is one open stream, and a heading made from its first line would be fabricated copy.

### 22.7 What the checker enforces

`pnpm design` recomputes every pair and regenerates `tokens.css`; `pnpm design:check` verifies it is current without writing it. A failure means the value is wrong. It is not advisory, and it refuses to write `tokens.css` while any check fails.

- **Thirty-five contrast pairs.** Text — the three inks on each of the three surfaces, text on the accent fill, accent text on its tint — clears **4.5:1**. Marks, icons and rings — the accent mark, the focus ring, and each of the seven status colours on each surface — clear **3:1**, which is what is asked of non-text indicators, and what a status dot is.
- **The ink ladder is three steps.** Muted and subtle ink must be at least 8% of lightness apart. Two inks can both clear contrast against the ground and be indistinguishable from each other, collapsing the hierarchy to two without failing anything else.
- **The accent clears the status scale by 35° of hue**, against running, reviewing and paused.
- **Every pair is computed.** A pair that could not be parsed is a failure, not a pass.

The themes are held to the same pairs by their own test (`apps/desktop/src/renderer/src/chat/theme.test.ts`): Slate is `styles.css` token for token, every preset and any colour a person picks clears the contrast pairs, no preset sets a status colour, and every preset's accent clears the status hues but Claude's clay (§22.3).

One renderer test holds the shape of the renderer itself (`apps/desktop/src/renderer/src/oneLayout.test.ts`). It fails if any of the classic layout's folders comes back under `apps/desktop/src/renderer/src/`, if any renderer file takes a design-system control from `@eo/ui`, type-only imports included, and if `@eo/ui` exports one again — the package exports only what §23.3 lists, and a control is the chat layout's kit's to draw. It replaces EO-519's `chat/noClassicUi.test.ts`, which held the chat layout apart from a classic layout that no longer exists.

---

## 23. The package layout

A pnpm workspace built with Turborepo. Shared dependency versions are pinned once in the workspace catalog.

```
apps/desktop/                     the application — and the server, a second build of it
apps/desktop/src/main/            the main process
apps/desktop/src/preload/         the bridge exposed to the window
apps/desktop/src/renderer/        the React application
apps/desktop/resources/gallery/   the bundled templates
apps/desktop/e2e/                 Playwright
packages/core/                    types, Zod schemas, the IPC contract, the registry — no I/O
packages/engine/                  the pure rules: tick, routes, context, validation
packages/ui/                      design tokens, the Markdown renderer, `cn`
packages/eslint-config/           shared lint configuration
packages/tsconfig/                shared compiler configuration
scripts/                          token generation, notices, live smoke tests
```

### 23.1 `packages/core`

The single source of truth for anything crossing a boundary: domain types, every Zod schema, the IPC contract (`packages/core/src/ipc.ts`) with its record and machine halves, the registry and its lookups, and the small pure helpers both the renderer and the main process must agree on. No Node, no Electron, no database.

### 23.2 `packages/engine`

Pure functions over core's types (§5.1). Depends on core and nothing else.

### 23.3 `packages/ui`

The design tokens (`packages/ui/src/styles.css`) and the little the renderer shares that is not a control: `cn`, the Markdown renderer (`Markdown`, `MarkdownItemReferenceProvider`, `splitItemReferenceText`), `CollapsibleMarkdown`, `ThemeProvider` and the `StatusTone` type. It has no buttons, badges, panels, tabs, dialogs, selects, inputs or steppers: those are the chat layout's own, in its kit (§23.4), and a renderer test refuses an import of one from here (§22.7). A purity test keeps the package free of application knowledge.

### 23.4 `apps/desktop`

The main process, by directory:

| Directory | What lives there |
|---|---|
| `apps/desktop/src/main/db/` | The one import site for SQLite, the schema, migrations, and repositories. `transitionItem` is here. |
| `apps/desktop/src/main/ipc/` | Every handler, registered against the contract; the `Platform` interface |
| `apps/desktop/src/main/supervisor/` | The run supervisor, the workspace-kind interface and the core's three kinds, route resolution, thread reuse, escalation |
| `apps/desktop/src/main/record/` | The record interface, its local and remote implementations, leases, the outbound queue and the drain |
| `apps/desktop/src/main/packs/` | The `CodePack` type and fold; `apps/desktop/src/main/packs/developer/` is the developer pack |
| `apps/desktop/src/main/providers/` | The backend adapters, Codex homes, the fake backend, and the two parity tests |
| `apps/desktop/src/main/runtimes/` | Locating, fetching and signing in to the agent CLIs |
| `apps/desktop/src/main/agentAttachments/` | Delivering MCP servers and skills to each backend |
| `apps/desktop/src/main/mcp/` | The `eo` server handed to agents; MCP server secrets |
| `apps/desktop/src/main/mcpHost/` | The server that lets another program drive EO |
| `apps/desktop/src/main/modules/` | The module host, runner, tests and pipeline transfer |
| `apps/desktop/src/main/roles/` | The assistant's conversations and proposals |
| `apps/desktop/src/main/jobs/`, `apps/desktop/src/main/schedule/` | Jobs, triggers, webhooks, placement; cron and intervals |
| `apps/desktop/src/main/gallery/`, `apps/desktop/src/main/firstRun/` | Templates, Preview, the needs check |
| `apps/desktop/src/main/connectors/`, `apps/desktop/src/main/secrets/` | Connector setup and OAuth; the secret stores |
| `apps/desktop/src/main/identity/`, `apps/desktop/src/main/managed/`, `apps/desktop/src/main/policy/`, `apps/desktop/src/main/server/` | People and devices; the signed-in session and locks; policy; the HTTP door |
| `apps/desktop/src/main/archive/`, `apps/desktop/src/main/outbox/` | The archive sweep; outbound tracker writes |

The renderer, under `apps/desktop/src/renderer/src/`, is `App.tsx` and `main.tsx` and these directories:

| Directory | What lives there |
|---|---|
| `apps/desktop/src/renderer/src/chat/` | The layout: its frame, rail, conversation and canvas; `views/`, one per screen; `kit/`, its controls; `theme.ts`, its themes; first run, sign-in and invitations |
| `apps/desktop/src/renderer/src/shared/` | The hooks, helpers, query keys and types the views read the record through, owned by no layout (EO-519) |
| `apps/desktop/src/renderer/src/query/`, `apps/desktop/src/renderer/src/ipc/` | TanStack Query over IPC and the push invalidations; the bridge to the main process, and its push stream when the renderer is served over HTTP |
| `apps/desktop/src/renderer/src/hooks/` | Small hooks with no record behind them — the clock, the app's version, a secret's Reveal |
| `apps/desktop/src/renderer/src/debug/` | The debug window |
| `apps/desktop/src/renderer/src/memory/` | What the Memory section lists and writes (§7.5) |

There is no folder per feature beside `chat/`: the classic layout's folders were deleted with it (EO-529), and a test keeps them from coming back (§22.7).

### 23.5 Where the seams are

- **The IPC contract** is the only way into the main process. The window, the assistant's administrative server, an outside MCP client and the organisation server's HTTP door are four callers of one set of handlers, which is why a lock, a refusal or a validation written once holds for all of them.
- **The record/machine split** of that contract is what lets the main process run headless and the renderer run in a browser.
- **`Platform`** is everything the main process needs from its host.
- **`createEngine(options, packs)`** is the composition root, and **`CodePack`** is the whole of what a code pack may contribute.
- **`WorkspaceKind`** is where a domain's idea of "where work happens" and "what can be verified" plugs in.
- **`AgentProvider`** is where a backend plugs in, and the parity test is what it must pass.
- **`ItemRecord`** is where solo and organisation mode diverge, and the only place they do.
- **`SecretStore`** and the single SQLite import site are where native and host-specific code is contained.
- **`OutputSchema`** is where a schema written in code and one that arrived as data become the same thing.

---

## 24. The invariants

EO has a short list of numbered invariants that are load-bearing: code that breaks one of them is wrong even if its own tests pass. **They are stated once, in [`CLAUDE.md`](./CLAUDE.md), and that file is authoritative.** They are not repeated here, so that there is never a second copy to drift.

This document is the argument for them: the sections on the engine, runs, comments, pipelines, workspace kinds, the assistant, backends and packs each explain the design that one or more of them protects, and say so where they do.

If a change seems to require breaking one of them, stop and ask.
