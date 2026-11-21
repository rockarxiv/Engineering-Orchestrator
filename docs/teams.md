# Teams on an agent step

An `agent` step can run as a **team**: several focused agents each contribute a report to the item's thread, and EO turns those reports into the one result the step returns. Nobody gets a separate item or column for their part. A team's members are either **report-only** (the default) or **isolated**. This page covers what a team can do, how it decides, how each kind of member is held to its mode, what it costs, how a person controls it, and what this release leaves out. The design is in [`ARCHITECTURE.md`](../ARCHITECTURE.md) §4.2a. This page is the operating manual.

## Configuration

A team is a setting on an agent step (`pipeline_steps.team`, `StepTeamSchema` in `packages/core/src/team.ts`). It is versioned, exported and imported with the pipeline like the step's other settings. A step with no team is one agent, which is how every step behaves unless somebody adds a team, or a template ships one ([below](#the-software-templates-review-team)).

You add or change a team by **describing it to the assistant**. Its draft can carry `team` on an agent step, or `"none"` to make the step one agent again, and a person's Publish writes it. The Graph view and the draft card show the team in words. The configure screen's step form does not edit teams, and the `pipeline_save` tool removes the key. A tool can never publish a team.

Members are staffed by **role**, never by agent id, using the project's usual staffing rule. A team names no tool, server or grant. Each member runs with what its role's agent already has: reduced to report-only, or exactly as it is in a copy of its own where the team's members are isolated (below). The `system` role is never a member.

### Member mode

A team's `members` key chooses how every member works, the leader included:

| | `report_only` (the default) | `isolated` |
|---|---|---|
| For | Content EO should not let an agent act on: a draft from outside, an attachment, anything a member must only read | Members that should work as the role's agent does: a review that runs the tests or traces what a change reaches, an investigation that tries a fix |
| What a member is given | Four evidence tools over a captured copy, and nothing else ([below](#report-only-what-a-member-can-and-cannot-do)) | Everything an ordinary dispatch of its agent on the step gets ([below](#isolated-a-member-works-as-its-roles-agent-does)) |
| Where it stands | An empty directory of its own | A copy of the item's workspace made for its attempt alone |
| Which agents can be members | Only agents EO can lock down (the table below) | Any agent that can run the step alone |
| Which workspaces | Any kind that can capture evidence (not `scratch`) | A kind that can copy for each member: a Git repository, or no disk. A folder or scratch step is refused |

A team written without the key is report-only. The mode is part of the team: it is versioned, exported and imported with it, the version diff names a change to it ("report-only members" → "isolated members"), and the Graph view, the draft card and the pipeline tools say which mode a team runs in.

There are two ways to coordinate:

| | Independent | Leader-led |
|---|---|---|
| Who runs | A fixed list of participants, each with a key, a role, instructions and whether it is required | A leader in a named role, who assigns work to agents of the permitted roles |
| Who decides | EO, from a small ordered table of rules (`all`/`any` of the reports reporting some outcomes → a result), with an explicit fallback | The leader answers the step's action itself, and EO checks that answer |
| Coordinating turn | None. No hidden synthesiser runs | One leader turn per round. Nothing waits in a process between rounds |
| Step action it can answer | Only one whose answer is `result` and `summary` | Any action with a defined schema |

**Limits** are finite and declared. Conservative defaults apply where they are left out:

| Limit | Default | Ceiling |
|---|---|---|
| Participants in all (`maxParticipants`) | 4 | 8 |
| At once (`maxParallel`) | 2 | 4 |
| Retries per participant (`maxRetries`) | 1 | 3 |
| Rounds, leader-led only (`maxRounds`) | 2 | 5 |
| `timeoutMs`, `budgetCents` | the run timeout and the item/daily budgets | can only tighten them |

A report-only member must be an agent EO can hold to report-only: Claude or Codex, not using the person's own setup, not naming its own executable, and, on Codex, naming a model. A draft or Publish that would staff a report-only team's role with any other agent is refused, and the refusal says why. None of this applies to an isolated team. Its draft or Publish is refused instead where the step works in a workspace that cannot give each member a copy, and the refusal names the kind.

## How a team completes

Each team session ends in **one** routing decision, and it goes through the ordinary path: the answer is validated against the step's action, posted as the owner's summary, and routed by `transitionItem()`. No participant can route, settle or move anything.

- **Independent.** Nothing is decided while any participant is unsettled. The same settled reports always give the same result, whatever order they arrived in. The step's answer is the result and the reports, in the team's order.
- **Leader-led.** The leader's final answer must name the accepted reports it relied on, and say where they disagreed and what it could not establish. EO refuses a final answer in any of these cases:
  - a required assignment has no current accepted report;
  - it relies on a superseded report, or on one that is not the team's;
  - it names no report although reports exist;
  - its result is not one the action declares;
  - it fails the action's schema.

  A refused answer is corrected in another leader turn while `maxRetries` allows. After that the team parks and says why.
- **At most one move per session.** A session that settled before a restart answers with its settled result again, without running anyone, and moves the item once. It does that only if the evidence still holds what the reports were made on. Otherwise the result is not used and the team runs again.

### An execution failure is not a finding

A contribution is either a **report** (an outcome and its text) or an **execution failure** (what went wrong). It is never both. Any of these is an execution failure:

- a crash;
- a turn that ended with no answer;
- an answer EO cannot read as a report;
- a lost provider thread;
- a turn that reached its budget share.

None of these counts as "found nothing" or "found a problem". An execution failure is retried up to `maxRetries`. A required participant still failing after that fails the team: the run parks with what each participant said and leaves the session open, and the item does not move. An optional participant that failed is left out of the decision and named in the summary. A negative finding is a *completed* report whose outcome selects the negative result. The publication review example below tests both cases.

## Report-only: what a member can and cannot do

A member, the leader included, can:

- list, read and search the evidence captured for it (`evidence_list`, `evidence_read`, `evidence_search`), and read the item's own context (`item_context`);
- return one answer: a report, a leader's assignments or final answer, or questions for the person.

A member cannot:

- edit files or the workspace;
- run a shell or any code;
- start a backend's own subagents or delegate in any other way;
- call an attached MCP server, a connector or the administrative server;
- post or read comments through EO's tools, beyond the thread view its `item_context` gives it;
- write memory or skills;
- change grants or create agents;
- search the web.

EO posts the report itself, attributed to the member's agent and run. A request for more permission is a question to the person, and nothing in an answer changes what an agent is dispatched with.

This is **enforced, not asked**, three ways at once. Each check refuses the turn before anything starts if it cannot be put in place:

1. **What it is offered.** The provider is built for the attempt alone: no built-in tools, no setting sources, no plugins or skills, strict MCP configuration with EO's `eo` server only (Claude); the participant's own home, every tool-bearing feature off, the model catalogue stripped of code mode, patching and multi-agent, web search off, and a read-only sandbox (Codex).
2. **What it may call.** One `PreToolUse` hook is offered every call, and it refuses everything except the four evidence tools and the backend's answer tool.
3. **What EO answers.** The `eo` server lists those four tools alone on a report-only credential and refuses any other call. The main process answers them only from that attempt's own captured scope.

### Where enforcement is unavailable, EO refuses to run

| Situation | What happens |
|---|---|
| A backend other than Claude or Codex | Refused at draft, Publish and start |
| An agent on the person's own setup (ambient config) | Refused at draft, Publish and start |
| An agent naming its own CLI executable | Refused at draft, Publish and start. EO cannot know that executable's version |
| A Codex agent with no model | Refused at draft, Publish and start |
| A Codex model the model catalogue does not name | Refused at start |
| A Codex sign-in held in the keyring (the person's own Codex home) | Refused at start |
| EO's own copy of the runtime is not installed, is switched off, or does not exist for this platform (anything other than macOS, Linux or Windows on x64 or arm64) | Refused at start |
| A runtime version other than the one the live probes passed on | Refused at start: Claude Code **0.3.322** with Claude Agent SDK **0.3.322**, Codex **0.167.1** (`REPORT_ONLY_QUALIFIED_RUNTIMES` in `providers/reportOnly.ts`) |
| No hook command on the machine, or a Codex CLI that does not report EO's hook as trusted | Refused at start |

A refused participant is an execution failure with the reason on the thread. The team's view marks it `enforcement`.

**A runtime upgrade cannot quietly switch enforcement off.** Part of the boundary depends on the CLI honouring what it is told, so moving a runtime pin in `runtimes/catalog.ts` or `runtimes/packages.ts` fails `providers/reportOnly.test.ts` until the live probes below are run on the new version and `REPORT_ONLY_QUALIFIED_RUNTIMES` is moved with it.

## Isolated: a member works as its role's agent does

An isolated member has exactly the rights and treatment its role's agent has on an ordinary dispatch of the step. The one difference is where it stands.

- **The same provider.** It is built through the ordinary path (`providerForAgent` in `engine.ts`), never `reportOnlyProviderForAgent`. That means the agent's backend, executable, credential, model, its own setup where it uses one, its attached servers and skills, its CLI tools, its `eo` grants, and the backend's ordinary permissions: `bypassPermissions` on Claude, `danger-full-access` on Codex. It gets no report-only hook, lock or credential, and none of the report-only refusals or runtime pins apply.
- **The same index and context.** It is given the repository index the step's dispatch is lent. That is the item's own index: it describes the same files as they stand in the item's workspace. Its context is the ordinary one for its agent and the step's action: the current output (the diff), the handover, pinned comments, human comments since, memory chosen before it starts, and the pack's sections.
- **The same instructions, then the team's.** Its agent's own instructions come first (for a reviewer, `reviewer.md`). The team framing follows: which team, its assignment, the outcomes it may report. It is held to the same contribution schema as a report-only member, so completion, routing and the leader's checks are unchanged.
- **Its own copy.** Each attempt works in a copy of the item's workspace made for it alone, never the item's worktree. For a repository it is a detached worktree, under the repository's git directory, of the tree the team's evidence captured, wrapped in a commit whose parent is the branch's HEAD. So it holds committed, modified and untracked files, and `git diff HEAD~1` shows the uncommitted work. For no disk, the copy is an empty directory of its own. A member's commits, resets and writes move nothing but its copy: not the item's worktree, not its branch, not another member's copy. Nothing it changes is merged back.
- **Removed when its attempt ends.** Before the copy goes, what was done in it (files changed or added, a moved HEAD) is put on the member's report. A member that left no report gets a note instead. Copies a crash left behind are swept on startup, and when the item settles, is archived or is deleted, with the same line on the item.
- **Independent, and silent.** A member never sees another member's report from its session, or the leader's turns. Its context, `comment_read`, `comment_search`, `thread_read` and what `item_detail` says the item shipped all apply the rule report-only's `item_context` does: the thread as far as the team's first capture, and nothing of its own team's after it. An `eo` server that cannot read that boundary shows none of the thread. A member posts nothing on the item: its credential serves no `comment` and no `attachment_add`. EO posts its answer as its report, attributed to it.

This independence is held at EO's surfaces. A member runs unsandboxed with a shell, exactly as the step's own agent does. That means it could read EO's database file, or `git push` from its copy, as that agent could. Use report-only where a member must not be able to.

## Evidence and freshness

A team reads a **captured** baseline, never a live source:

- The git kind's tree of the working tree, covering committed, modified and untracked files. It is built in a temporary index and taken twice to prove it held still.
- A content-addressed copy of a folder, walked twice.
- Nothing for an item with no workspace.
- Each attachment's SHA-256.
- The item's own task: a hash of its title, body, spec and type.

The thread is not evidence. Replies, reports and EO's notes never move it. A workspace kind that cannot capture (today, `scratch`) is refused rather than read live.

Paths are relative to the captured listing. `..`, absolute paths and links out are refused. Neither a repository index nor a shell is needed.

Before a team settles, EO captures the evidence again and compares it **by content**. A report made on a version that has since moved is superseded and done again, and nothing settles on it. Editing what the item asks for (title, body, spec) is a change too. If the evidence keeps moving, the team settles nothing past its retries and parks.

First-pass participants of an independent team all get the same view and cannot see each other's reports, through any tool. The person sees each report the moment it is accepted. A later round shows a report only where it names it (a leader's follow-up, or the leader's own next turn).

## Resource accounting

- **Concurrency.** A team's participants running side by side are the second exception to invariant 10. They are bounded by the team's `maxParallel`, a machine-wide limit of 4 participant turns across every team, and each agent's own limit. The team's waiting run does not use the provider slot its participants need. Other items still go through the global, per-agent and per-capacity-key caps exactly as before. When an assignment waits for capacity, the thread says so.
- **Money is shared, not copied.** For each budget a turn falls under (the item's, the day's, the team's own `budgetCents`), EO takes what is left, subtracts what the running turns covered by that budget still hold, and divides the rest between the assignments still owed a turn. Each turn gets the smallest of those shares. EO caps each turn at its share and stops it when its recorded spending reaches the share. Precision is only as good as the backend's usage reports: a turn can overshoot by what it reports while winding down, and that overshoot is recorded, not hidden.
- **Spending is kept.** Every turn, participant or leader, is a `runs` row of its own, written with every usage reading. A stop, a crash or a restart loses nothing. The team's own run spends nothing, so item, daily and trial totals count each cent once.

## Operating controls

| Control | Effect on a team |
|---|---|
| **Cancel** (item page, `teams:cancel`) | Ends the session `cancelled` with every participant and the team's run. Nothing late is taken |
| **Retry** (item page, `teams:retry`) | On a session parked with failed work: reruns only what failed and keeps every accepted report |
| **Reply** to a member's question | Resumes the step. Only the asking assignment (or the leader) reruns, with the question and answer in its context. Current sibling reports are kept |
| **Cancel the step's run**, or a participant's run | Stops the whole team, never one participant alone |
| **Move the item** | Refused while the team works unless you ask to stop it. Moving ends the session |
| **Pause**, a hold, shutdown, the run or team timeout | Stops or fences every participant. A pause or hold leaves the session open to be adopted later |
| **Restart** | Reconciles first: turns nobody is running are ended as cancelled and replaced, accepted reports are kept, and a settled session is replayed only on unchanged evidence |
| **Organisation lease handoff** | When another device takes the item, this desktop stops its team, cancels the session and moves nothing. The controls refuse a session another desktop runs |

On a trial, a team step planned real runs its participants on the trial's test item. A team step planned mocked runs nobody, and its output says the team was not tested.

## The software template's Review team

One bundled step has a team: **Review** in the *Software feature to merge* template, from its version 1.5. It is the only one, and `supervisor/teamQualification.test.ts` holds that. No seed or migration gives any step a team.

Review is a leader-led team in isolated mode. The template's `reviewer` leads, and may assign only `reviewer`, so the template adds no role and no agent: the focus of each pass is its assignment. Its limits are 8 participants, 4 at a time, 2 rounds and 1 retry. The leader reads the change, then assigns:

- on every review, a pass on the acceptance criteria and correctness, one on impact and side effects (callers, contracts, data and schema changes, configuration, paths the diff did not touch), one on the tests, and one on the repository's own written rules (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING` and the like), which it skips, saying so, when the repository has none;
- a security pass when the change touches authentication, permissions, input handling, secrets, network or file-system access, or dependencies, and a user-facing pass when it touches a UI, CLI output, error messages, a public API or docs, saying why it did or did not add each.

Each member works as the template's reviewer does, in a copy of its own. The leader's final answer is the step's ordinary review verdict: an approval with its pull request body, a rejection carrying every blocking issue the passes found, merged and de-duplicated, with coverage for every criterion, or a question for the person. The step's routes are unchanged. Nothing in the team names anything of EO's own: every rule a pass checks comes from the repository under review (`gallery/templateTeam.test.ts`). A review is several runs rather than one, and the template's description says so.

An installation on 1.4 receives the team as any template update. Where a person already gave Review a team of their own, the update keeps theirs and holds as a conflict. Removing the team, through the assistant's draft, gives back the single-reviewer review. `packs/developer/reviewTeam.test.ts` runs the step end to end on Claude, on Codex and on both, every turn through that backend's real adapter over a stubbed SDK `query` or `codex app-server`.

## Examples (opt-in)

Two example pipelines live in [`docs/examples/teams/`](./examples/teams/). They are ordinary pipeline export files. Nothing installs them. To try one, import it as you would any pipeline file. Both are non-code: the evidence is the item's own text and its attachments, so neither depends on the developer pack.

- **`publication-review.json`.** Independent. A fact checker and counsel (required) and a copy editor (optional) read an attached draft. *Any* "must change" sends it to **Revise**. Otherwise it is **Ready to publish**.
- **`incident-investigation.json`.** Leader-led. An incident lead assigns focused questions to a log analyst and a customer liaison, follows up where a report falls short, and answers *Explained* or *Action needed* from the reports it names.

The imported agents recommend Claude. Change any member to Codex (with a model) to get a mixed-backend team.

## What has been proved, and how

**Mocked (every CI run).** The backends are scripted. Everything else is real: the supervisor, the database, evidence capture, the bridge and the routing.

- `apps/desktop/src/main/supervisor/teamQualification.test.ts` imports both examples and runs them end to end with every member on Claude, every member on Codex, and a mix of the two. It covers the positive and the negative independent result and a leader's adaptive follow-up. It then runs a failure matrix: disagreement, malformed report, participant crash, lost provider thread, restart during finalisation, duplicate delivery, capacity pressure, shared-budget exhaustion, cancellation, a human question, a source change and an organisation lease handoff. Each scenario ends in the same checks: execution stayed within limits; spending and history were kept; no report was accepted twice; nothing settled on stale evidence; the item moved at most once per settled session, to where the accepted reports route.
- `packages/engine/src/teamExamples.test.ts` decides the publication review example in the pure engine alone, with no repository involved.
- `teamSupervisor.test.ts`, `teamLeader.test.ts`, `teamSessionControls.test.ts`, `teamParticipants.test.ts`, `teamEvidence.test.ts` and `teamSessionsRepo.test.ts` cover the mechanisms one at a time.
- `providers/providerParity.test.ts` holds **both adapters** to the same report-only surface, refusals and refusal to start. It also holds them to an isolated member's surface: the ordinary `eo` server, index, servers, skills and permissions, with no report-only hook.
- `supervisor/teamIsolated.test.ts` covers isolated members end to end. It checks that a member's turn differs from the same agent's ordinary dispatch of the step only in where it stands, its attempt, its framing and posting nothing. It checks its context, that its copy is removed with the change line on its report, and the refusal of a kind that makes no copy. It runs a team of four with `maxParallel: 2` and checks that the two members starting after the first reports see neither, in their context or through `comment_read`, `comment_search`, `thread_read` and `item_detail`. It also covers freshness, cancelling and a leader-led isolated team. `packs/developer/workspace/memberCopies.test.ts` writes, commits and resets in one member's copy of a real repository, and checks that the item's worktree, its branch, a sibling's copy and the remote are untouched. `providers/reportOnly.test.ts` covers each adapter's lock, the runtime qualification and the pin tripwire.

**Real CLIs (opt-in, no credit spent).** A local server stands in for the model and scripts the calls a participant must not be able to make: a shell command, a file write, code mode's nested `exec_command`/`apply_patch`, a subagent, EO's `comment` and the repository index. It runs them on a fresh session and a resumed one, then checks that no marker file exists and that EO's bridge was asked only for evidence.

```sh
EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop src/main/providers/reportOnlyClaude.live.test.ts
EO_LIVE_CODEX=1 EO_CODEX_BIN=<EO's codex 0.167.1> pnpm exec vitest run --root apps/desktop src/main/providers/reportOnlyCodex.live.test.ts
```

Last run for EO-850 on Linux x64, with Claude Code 0.3.322 + Claude Agent SDK 0.3.322 and Codex 0.167.1: all three probes passed. The Codex control probe confirms that the refused route does write on an agent that is not locked. These probes have not been run on macOS or Windows for this release. The enforcement there is the same code, and the start-time checks above still apply.

## Not in this release

- **Writing participants.** An isolated member may change its own copy, but nothing it changes reaches the item's work: no member implements.
- **Merging a member's copy back.** A copy is discarded when its attempt ends, and what changed in it is said on the report.
- **A copy on a folder or scratch workspace.** Only a Git repository and no disk give isolated members copies. A folder step's team must be report-only.
- **Recursive teams.** A member cannot lead a team or assign work. Only the configured leader assigns, and only to declared roles.
- Editing a team on the configure screen's step form. Teams are configured through the assistant's draft.
