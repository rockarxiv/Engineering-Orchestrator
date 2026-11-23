# Teams

An `agent` step can run as a **team**: several focused agents each contribute a report to the item's thread, and EO turns those reports into the one result the step returns. A team is a **declared team**, a configured thing of its own beside agents, which a step names the way it names an agent. Nobody gets a separate item or column for their part. A team's members are either **report-only** (the default) or **isolated**. This page covers what a team can do, how it decides, how each kind of member is held to its mode, what it costs, how a person controls it, and what this release leaves out. The design is in [`ARCHITECTURE.md`](../ARCHITECTURE.md) §4.2a. This page is the operating manual.

## Configuration

A team is its own entity (`teams`, `TeamDefinitionSchema` in `packages/core/src/declaredTeam.ts`), and an agent step names one by id (`pipeline_steps.team_id`). Several pipelines of one project can name the same team. A step with no team is one agent, which is how every step behaves unless somebody gives it a team, or a template ships one ([below](#the-software-templates-review-team)).

A team declares:

| | |
|---|---|
| `name` | What a person and a draft call it. Unique within its project. |
| `coordination` | `independent` or `leader` ([below](#how-a-team-completes)). |
| `memberMode` | `report_only` (the default) or `isolated` ([below](#member-mode)). |
| `leader` | Leader-led only: an agent and what it is asked to do. Its kind must have the step's action. |
| `members` | Agents. On an independent team each has an assignment key, focused instructions and whether it is required; on a leader-led team, the agents the leader may assign work to. |
| `outcomes`, `completion`, `limits` | What a member may conclude, how an independent team decides, and its limits ([below](#how-a-team-completes)). |
| `toolPool` | The CLI tools (by command), MCP servers (by name) and skills (by slug) its members may be given. No member's own tools may go beyond it, and `eo_admin` can never be in it. |
| `modelRange` | The runtimes, models and reasoning levels a member the leader adds may run on. |
| `memberCap` | How many members it may have (8 when left out, at most 16). |

EO's system agent is never a leader or a member. A team that breaks any of this is refused at the draft and at Publish, in a sentence naming what is wrong, and so is a step naming a team that does not exist, belongs to another project, or has a leader whose kind lacks the step's action. A team the draft writes is judged whether or not any step names it, and a change to a team that another pipeline's steps name is refused where it would leave one of those steps refused, naming that pipeline.

**Every change to a team is a version**, recorded with who made it: a person, the assistant, or a team's leader. A person can restore any earlier version, and the restore is itself a new version. A person can **lock** a team: a locked team refuses every change but unlocking, a draft's included.

**The Teams tab** in Agents (EO-884) lists every declared team: its coordination and member mode, its leader and members with each one's kind, runtime, model, reasoning effort, instructions and who added it (a person, or its leader on an item, linked), its tool pool, model range, limits and member cap, the steps that run as it, and its versions with who made each. There a person can change any member's runtime, model and reasoning effort, the leader's included. Each change is a new version, and each version records every member's settings, so restoring one puts them back on the members. A person can also restore a version and lock or unlock the team. The tab edits no instructions and no membership: **Change members or instructions with the assistant** opens the assistant, whose draft a person publishes. A backend this machine is not signed in to is said in the runtime picker and under it. A locked team offers no change and no restore, and where an organisation manages the pipelines a version cannot be restored here.

You create, change or remove a team, and point a step at one, by **describing it to the assistant**. Its draft declares each team it creates or changes in `teams`, whole, with its agents by name, and names a step's team by name in that step's `team`, or `"none"` to make the step one agent again; a person's Publish on the draft card writes it. That is the only way a team is written. The draft card and the Graph view name the team a step runs as and show it in words, and `pipeline_get` lists each team with its whole definition as a draft writes it. The configure screen's step form does not edit teams, and the `pipeline_save` tool removes `teamId` and `teams`, so a save through it keeps the step's team as it was. A tool can never publish a team.

**A draft declares the members a team does not have yet** (EO-898). A team's agents are its own, so a draft names the team's own agents by name and declares every other in the team's `newMembers`: a name, a kind and the agent's own instructions, and either its own runtime, model and reasoning or `from`, an existing agent to take those — and its tools, kept to the team's pool — from (left out, the project's agent of that kind). Nothing is created before Publish, which creates each as an agent the team owns, in the transaction that writes the team and the graph, so a refused or failed Publish leaves no agent behind. The draft, the editor's check and Publish refuse in the same words a new member of a kind EO does not have, two of a team's members with one name, a `from` naming nobody, a leader whose kind lacks the step's action and more members than the cap. A draft naming an ordinary agent as a leader or member is refused, saying to declare a new member instead. The card lists each new member as new, with its kind, runtime, model and the first line of its instructions. A held template update whose new version gives a step a declared team lists that team ready for a draft (`pipeline_update_conflict`): every agent declared new, each taking its runtime, model and tools from the person's agent of its kind, and its pool that agent's tools — so taking the template's team is one card, and creates no ordinary agent.

**What runs.** Since EO-882, each part of a team runs as the agent the team names: the leader as the team's leader agent, and each member as itself, with that agent's own backend, model, reasoning, instructions and tools — reduced to report-only, or exactly as it is in a copy of its own where the team's members are isolated (below). So one team can mix Claude and Codex, models and reasoning levels. Nothing picks an agent by its kind: a member that cannot run is refused or waits, saying why, and is never stood in for by another agent of the same kind. A leader assigns work to its members by name; its turn lists each member with its name, kind, runtime, model, reasoning and a line from its own instructions, and EO refuses an assignment naming anyone who is not a member. A team declared from a step's old inline team (migration 0185, which named each "Pipeline · Step", a long name cut to fit a team name's 120 characters, and numbered apart from every other team of its project, whatever the case) names the agents the step's roles were bound to, so it runs what that step ran. A session a team began before EO-882 is not carried on after the update: the next dispatch starts the team again. An item still finishing on an older version of its pipeline runs the team that version's step names, as the team is now: its current leader, members, coordination, limits and outcomes. The team the version froze names kinds, not agents, and running it would mean picking agents by kind. Where the version's step runs as a team but names none EO can read (a version saved before teams were declared, whose step no longer had its team when they were), EO does not run the step's agent alone: the item waits for a person, with a comment naming the step. A member disabled after the team was published, or a preview's agent on a real item, does not run: its attempt fails saying why, and a leader is not offered it.

**A leader adding a member** (EO-883). When none of its members fits a piece of work, a leader-led team's leader may add one in its assign answer (`newMembers`): a name no other agent has, instructions, the tools it is given — each from the team's tool pool — a runtime, model and reasoning — each from the team's model range — and, where the members are of several kinds, which of those kinds it is. It may assign work to the new member by name in the same answer. EO creates it as a real agent of that kind (on the team's project, with only those tools attached and its reasoning set; nothing else, so no `memory_note` grant either), adds it to the team as a new version recorded as made by the leader on that item, and posts a comment on the item naming the member, its instructions, tools, runtime, model and reasoning. The leader's own agent is never changed. EO refuses an addition with a tool outside the pool (`eo_admin` always), a runtime, model or reasoning outside the range, a name another agent already has, a kind none of the members is, a member past the cap, or a team a person locked; the refusal is posted on the item with the leader's other refused assignments, the leader's next turn is told why, and nothing is created. The leader is offered `newMembers` only where an addition could be accepted — the team unlocked, under its cap, with a runtime, model and reasoning in its range — and is told which. A member added this way is a member like any other: the session's later turns and every later session can assign to it, and a person can take it off through the assistant's draft or by restoring a version from before it was added (the agent itself stays). The addition and the leader's answer are kept in one transaction, so an answer that arrives after its session ended creates nothing.

An exported pipeline carries the declared team each step runs as (export format 18, EO-885): its name, coordination, member mode, outcomes, completion or limits, tool pool by tool name, model range and member cap, with its leader and members each as an agent's name, kind and own instructions — never an agent or team id, and never a runtime or model, which are the importing machine's. Importing it, or installing a template, declares the team and binds each of its agents to one of the project's agents of that kind with the same instructions, copied for the team, or creates one with the document's name and instructions on the runtime, model and tools of the agent its step's kind binds to; a member is given only the tools in the team's pool. `pipeline_import_check` says which of a team's agents would be bound and which created. A document written before format 18 carries the role-staffed team, which still imports: a team is declared from it, binding each kind to an agent there, as a copy from the organisation's record does.

A template update compares a step's team as the template's base carries it. Where the person left it as the base had it, the team the step names is changed to the new version's, as a new version of that team by EO, keeping its name, its tool pool and every one of its own agents whose kind and instructions are unchanged — with whatever runtime, model and reasoning a person gave them. A team's tool pool belongs to the installation, as its members' runtimes and models do: an update never replaces it and never compares it, so a pool that differs from the template's is never a conflict and never holds a locked team's update, and a member the update adds is given only the tools in the installed pool. A person changes the pool through the assistant's draft. Where the person changed the team otherwise (its name and pool aside), the update is held as a conflict, as for any setting both changed. A locked team holds the update, saying so, and is not changed.

### Member mode

A team's `memberMode` chooses how every member works, the leader included:

| | `report_only` (the default) | `isolated` |
|---|---|---|
| For | Content EO should not let an agent act on: a draft from outside, an attachment, anything a member must only read | Members that should work as the role's agent does: a review that runs the tests or traces what a change reaches, an investigation that tries a fix |
| What a member is given | Four evidence tools over a captured copy, and nothing else ([below](#report-only-what-a-member-can-and-cannot-do)) | Everything an ordinary dispatch of its agent on the step gets, less what is for answering the step alone ([below](#isolated-a-member-works-as-its-roles-agent-does)) |
| Where it stands | An empty directory of its own | A copy of the item's workspace made for its attempt alone |
| Which agents can be members | Only agents EO can lock down (the table below) | Any agent that can run the step alone |
| Which workspaces | Any kind that can capture evidence (not `scratch`) | A kind that can copy for each member: a Git repository, or no disk. An item in a folder or scratch workspace is refused at start ([below](#an-item-whose-workspace-cannot-make-copies)) |

A team written without the key is report-only. The mode is part of the team: it is versioned, exported and imported with it, the version diff names a change to it ("report-only members" → "isolated members"), and the Graph view, the draft card and the pipeline tools say which mode a team runs in.

There are two ways to coordinate:

| | Independent | Leader-led |
|---|---|---|
| Who runs | A fixed list of member agents, each with a key, instructions and whether it is required | A leader agent, who assigns work to the team's members |
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
| The session's time limit (`timeoutMs`) | none: each turn is held to the run timeout, the session to its turns' guards and these limits | the run timeout |
| `budgetCents` | the item/daily budgets | can only tighten them |

A report-only member must be an agent EO can hold to report-only: Claude or Codex, not using the person's own setup, not naming its own executable, and, on Codex, naming a model. A draft or Publish naming any other agent as a report-only team's leader or member is refused, naming that agent and why; so is one naming an agent that is disabled or retired, whatever the team's mode. None of this applies to an isolated team. Its draft or Publish is refused instead where no workspace the step could work in can give each member a copy, and the refusal names the kind. Where some can and some cannot (a project with a Git repository and a folder, say), it is a warning naming the kinds that cannot, and the pipeline saves.

### An item whose workspace cannot make copies

An isolated team on an item whose workspace makes no copies — a folder or a scratch workspace — starts nobody. The team's run ends at once with a comment on the item naming the kind, and a person acts: makes the team's members report-only, or has the step work in a Git repository or on no disk. EO never runs a member in the item's own workspace instead, and never falls back to the step's single agent. A template update is never held for it: Delivery on 1.4 updates to 1.5, and its origin moves, whether the project has a Git and a folder workspace or a folder alone, and only the folder's items are refused. Publish still refuses an isolated team on a step where no workspace makes copies, so a person editing such a board is told the team cannot run there.

## How a team completes

Each team session ends in **one** routing decision, and it goes through the ordinary path: the answer is validated against the step's action, posted as the owner's summary, and routed by `transitionItem()`. No participant can route, settle or move anything.

- **Independent.** Nothing is decided while any participant is unsettled. The same settled reports always give the same result, whatever order they arrived in. The step's answer is the result and the reports, in the team's order.
- **Leader-led.** The leader's final answer must name the accepted reports it relied on, and say where they disagreed and what it could not establish. EO refuses a final answer in any of these cases:
  - a required assignment has no current accepted report;
  - it relies on a superseded report, or on one that is not the team's;
  - it names no report although reports exist;
  - its result is not one the action declares;
  - it fails the action's schema;
  - its result is one an accepted report rules out, and its `disagreements` does not overrule that report.

  A refused answer is corrected in another leader turn while `maxRetries` allows. After that the team parks and says why.
- **What a report rules out.** An outcome a team declares can carry `rulesOut`: the results of the step's action that an accepted report with that outcome rules out. A leader's final answer with one of those results is refused if any current accepted report concluded that outcome, unless the answer's `disagreements` overrules that report on a line of its own: `Overruled <assignment key or comment id>: <why>`. Mentioning the report is not overruling it — `criteria` alone, or "No disagreements with criteria", is refused — and neither is an override with no reason after the colon. The refusal names the report and its outcome, as the other checks do, and the leader corrects it in another turn while `maxRetries` allows. EO checks that the override names the report and gives a reason; whether the reason persuades is for the person who reads it on the thread with the answer. The engine knows no outcome or result by name: what rules out what is the team's data. `rulesOut` is optional and versioned, diffed, exported and imported with the team. Every key in it must be a result the step's action declares, which draft and Publish check. Only a leader-led team may declare it, because an independent team's result comes from its completion table and no agent writes it.

  ```json
  { "key": "blocking", "label": "Blocking issues", "rulesOut": ["approved"] }
  ```
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
- **The same index, and the item's context.** It is given the repository index the step's dispatch is lent. That is the item's own index: it describes the same files as they stand in the item's workspace. Its context is the item's as the step's agent is seeded with it, without what only that agent acts on (EO-888): the item, its criteria, the current output (the diff), the handover, pinned comments, human comments since, memory chosen before it starts, and the pack's sections about the item. It is not given the step's task and how to answer it (such as a review's "If you approve"), plan mode, or a pack section the pack marks as the step's agent's alone (`stepAgentOnly`, such as where to put files for the item, which a member never posts). It is always seeded, even where its agent could read the whole thread with a tool. "Human comments since" is what an ordinary dispatch of its agent would show, as far as its view of the thread goes: a run of the same agent in the same team session — a sibling member's or a leader turn — is not that agent having looked. So when one agent staffs every member, as the template's reviewer does, each member still sees what a person said before the session started.
- **Its own instructions, less what is for answering alone, then the team's.** Its agent's own instructions come first (for a reviewer, `reviewer.md`), without every passage marked as written for an agent answering the step alone: a line `<!-- alone -->`, the passage, a line `<!-- /alone -->` (EO-888). The reviewer's marks its reading rules ("read the whole change", "every file in the diff", and working outward from each symbol the change touched) and its rules for the verdict. A prompt a person has rewritten keeps only the marks they kept: one with none is sent to members whole. The agent answering the step alone, a team's leader included, is sent its instructions as they are. The team framing follows: which team, that it works on its assignment (not as it would on the step alone), to read what its assignment names and what that leads to rather than the whole change, to say in its report what it did not read, and the outcomes it may report. Its assignment shows what it covers. It is held to the same contribution schema as a report-only member, so completion, routing and the leader's checks are unchanged.
- **Its own copy.** Each attempt works in a copy of the item's workspace made for it alone, never the item's worktree. For a repository the copy is the item's worktree exactly, as the team's evidence captured it. It is a detached worktree at the item's own HEAD commit. Every file the item had modified, added or deleted is an uncommitted change in the copy, and its untracked files stay untracked. Which new files were added and which were untracked is read with the capture, so staging or unstaging in the item afterwards changes no copy. EO makes no commit for it, so `git log` in the copy lists exactly the branch's commits, and `git diff` and `git status` show what the item has, apart from what was staged. For no disk, the copy is an empty directory of its own. A member's commits, resets and writes move nothing but its copy: not the item's worktree, not its branch, not another member's copy. Nothing it changes is merged back.
- **Outside every checkout.** A repository copy lives at `~/.eo/team-copies/<KEY>/<attempt>`, beside the items' own worktrees in `~/.eo/worktrees`, and is still a worktree of the item's repository. Nothing that looks in parent directories reaches the person's checkout from there, whether that is the `CLAUDE.md` a backend loads or Node's `node_modules`. Copies made before this release sat at `<git common dir>/eo-team-copies/<KEY>/<attempt>`, and every sweep still looks there too.
- **Removed when its attempt ends.** Before the copy goes, what was done in it is put on the member's report. That means files changed, added or deleted against what EO handed it, and a moved HEAD. The item's own uncommitted changes are what it was handed, so they are never counted as the member's. A member that left no report gets a note instead. Copies a crash left behind are swept on startup, and when the item settles, is archived or is deleted, with the same line on the item.
- **Refs it leaves behind are said.** A worktree shares its repository's branches, tags and stash, so `git stash`, `git checkout -b`, `git tag` and `git branch -f` in a copy write to the repository every item's worktree uses. EO records the repository's branches, tags and stash entries when the attempt starts. The line names each one created, moved or deleted since. To tell a member's own writes from anybody else's, the member's processes carry a committer email of its attempt's, and Git keeps a reflog for every ref they write, tags included. When the copy is removed, EO deletes the branches and tags created under names that did not exist when the attempt started, but only where every reflog entry is that member's, and never one a worktree has checked out. That holds whether the member's own turn removes the copy or a sweep does after a crash. So a ref another member or the person made meanwhile, or one the person has written to since, is named and left, and the line says why. A moved or deleted branch is named and left as it is. Stash entries are named and never dropped, because the stash is shared with every worktree.
- **Independent, and silent.** A member never sees another member's report from its session, or the leader's turns. Its context, `comment_read`, `comment_search`, `thread_read` and what `item_detail` says the item shipped all apply the rule report-only's `item_context` does: the thread as far as the team's first capture, and nothing of its own team's after it. An `eo` server that cannot read that boundary shows none of the thread. The boundary reaches the server only on the member's credential, which EO's agent write bridge signs. So independence fails closed there too: where the bridge is not listening, because it has not started yet or failed to bind, the member does not start. Its attempt fails and is retried like any other failure, and a note on the item says why. A member is never served the whole thread. A member posts nothing on the item: its credential serves no `comment` and no `attachment_add`. EO posts its answer as its report, attributed to it.

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

- **A session is one run against EO's caps.** The team's own run is the step's run. It takes the slot a single run of that step would take, against the global, per-repository, per-agent and per-capacity-key caps, when the session starts, and holds it until the session settles, parks on a question or is cancelled. Another item that needs that slot waits, exactly as it would wait for a single run of the step.
- **Concurrency inside the session.** The leader's and the members' turns count against none of those caps, so on default guardrails (every cap 1) a team of four members of one agent runs four at once. They are bounded by the team's own `maxParallel` and nothing else: there is no machine-wide participant limit, so two sessions admitted side by side each run up to their own limit. Running them side by side is the second exception to invariant 10, read as "the team is one run": no cap rises for any other item. When an assignment waits for room, the thread says so.
- **Time.** The single-run wall clock does not stop the session: a review that is a leader turn, several member turns and another leader turn can take longer than one run may. Each turn, a leader's or a member's, is held to the wall clock and the inactivity guard as an ordinary run is, and a turn either stops is a failed contribution, retried within `maxRetries`. The session as a whole is bounded by the team's `timeoutMs` where one is declared, and otherwise by its turns' own guards and its finite limits.
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
| **Pause**, a hold, shutdown, the team timeout | Stops or fences every participant. A pause or hold leaves the session open to be adopted later |
| A turn's wall clock or inactivity guard | Stops that turn alone, as a failed contribution counted against its retries |
| **Restart** | Reconciles first: turns nobody is running are ended as cancelled and replaced, accepted reports are kept, and a settled session is replayed only on unchanged evidence |
| **Organisation lease handoff** | When another device takes the item, this desktop stops its team, cancels the session and moves nothing. The controls refuse a session another desktop runs |

On a trial, each team the draft creates or changes runs as the trial's own copy, so trying a draft never changes a live team. A team step planned real runs its participants on the trial's test item. A team step planned mocked runs nobody, and its output says the team was not tested.

## The software template's Review team

One bundled step has a team: **Review** in the *Software feature to merge* template, from its version 1.5. It is the only one, and `supervisor/teamQualification.test.ts` holds that. No seed or migration gives any step a team.

Review is a leader-led team in isolated mode. From version 1.8 (EO-885) it is a declared team the template carries whole: a **Lead reviewer**, whose own instructions are the template's reviewer prompt, and six members, each a reviewer agent with instructions written for its pass alone — **Criteria reviewer**, **Impact reviewer**, **Tests reviewer**, **Rules reviewer**, **Security reviewer** and **User-facing reviewer**. The lead assigns each pass to its own member, by name. The template adds no role: every agent of the team is of the `reviewer` kind, and each is the team's own (EO-897), so a person can put each on its own runtime, model and reasoning in the Teams tab. Its pool and model range are empty and its cap is its six members, so its lead adds none. An installation updating from 1.7 keeps the pool its Review team already had — the tools, MCP servers and skills of the reviewer it was declared from — and the six pass reviewers start with those tools. Up to 1.7, the template's `reviewer` led and was the one member, assigned each pass by key. Its limits are 8 participants, 4 at a time, 2 rounds and 1 retry. The leader reads the change, then assigns:

- on every review, a pass on the acceptance criteria and correctness, one on impact and side effects (callers, contracts, data and schema changes, configuration, paths the diff did not touch), one on the tests, and one on the repository's own written rules (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING` and the like), which it skips, saying so, when the repository has none;
- a security pass when the change touches authentication, permissions, input handling, secrets, network or file-system access, or dependencies, and a user-facing pass when it touches a UI, CLI output, error messages, a public API or docs, saying why it did or did not add each.

Each member works as the template's reviewer does on an assignment, in a copy of its own. From version 1.7 (EO-888) the leader says what each pass covers: the criteria pass alone covers the whole change; impact covers the symbols, schemas and configuration the change alters and what depends on them; tests the test files the change adds or alters and the code they test; rules the rule files and the parts of the change they govern; security and user-facing the files that touch what they are about. A member reads what its pass covers and what that leads to, and says what it did not read. The leader's final answer is the step's ordinary review verdict: an approval with its pull request body, a rejection carrying every blocking issue the passes found, merged and de-duplicated, with coverage for every criterion, or a question for the person. The step's routes are unchanged. Nothing in the team names anything of EO's own: every rule a pass checks comes from the repository under review (`gallery/templateTeam.test.ts`). A review is several runs rather than one, and the template's description says so.

From version 1.6 the team's `blocking` and `needs_decision` outcomes each rule out `approved`. A leader that approves over a pass reporting either is refused unless it names that pass and says why it overruled it.

An installation on 1.4 receives the team as any template update, one on 1.5 receives 1.6 the same way, one on 1.6 receives 1.7, and one on 1.7 receives 1.8, the team Review already runs as changed to the template's. Where a person already gave Review a team of their own, the update keeps theirs and holds as a conflict.

To remove the team, ask the assistant to make Review one agent again. Its draft carries `team: "none"` for Review (the declared team stays, for any other step to name), and you publish it from the draft card. The next review is the single-reviewer review: one reviewer run, the ordinary review schema, the same routes. A later template version that changes Review's team does not put it back. It is held as a conflict, as for any step a person edited. `reviewTeam.test.ts` removes it that way: the assistant's draft, then Publish on the card. `packs/developer/reviewTeam.test.ts` runs the step end to end on Claude, on Codex and on both, every turn through that backend's real adapter over a stubbed SDK `query` or `codex app-server`. Its scripted leader assigns the passes it reads in the template's own leader instructions, so a pass dropped from the template fails those runs. It also runs a leader that approves over a blocking report and is refused.

## Examples (opt-in)

Two example pipelines live in [`docs/examples/teams/`](./examples/teams/). They are ordinary pipeline export files. Nothing installs them. To try one, import it as you would any pipeline file. Both are non-code: the evidence is the item's own text and its attachments, so neither depends on the developer pack.

- **`publication-review.json`.** Independent. A fact checker and counsel (required) and a copy editor (optional) read an attached draft. *Any* "must change" sends it to **Revise**. Otherwise it is **Ready to publish**.
- **`incident-investigation.json`.** Leader-led. An incident lead assigns focused questions to a log analyst and a customer liaison, follows up where a report falls short, and answers *Explained* or *Action needed* from the reports it names. The lead's kind has the step's `investigate` action, since a leader answers it.

The imported agents recommend Claude. Change any member to Codex (with a model) to get a mixed-backend team.

## What has been proved, and how

**Mocked (every CI run).** The backends are scripted. Everything else is real: the supervisor, the database, evidence capture, the bridge and the routing.

- `apps/desktop/src/main/supervisor/teamQualification.test.ts` imports both examples and runs them end to end with every member on Claude, every member on Codex, and a mix of the two. It covers the positive and the negative independent result and a leader's adaptive follow-up. It then runs a failure matrix: disagreement, malformed report, participant crash, lost provider thread, restart during finalisation, duplicate delivery, capacity pressure, shared-budget exhaustion, cancellation, a human question, a source change and an organisation lease handoff. Each scenario ends in the same checks: execution stayed within limits; spending and history were kept; no report was accepted twice; nothing settled on stale evidence; the item moved at most once per settled session, to where the accepted reports route.
- `packages/engine/src/teamExamples.test.ts` decides the publication review example in the pure engine alone, with no repository involved.
- `teamSupervisor.test.ts`, `teamLeader.test.ts`, `teamSessionControls.test.ts`, `teamParticipants.test.ts`, `teamEvidence.test.ts` and `teamSessionsRepo.test.ts` cover the mechanisms one at a time.
- `supervisor/teamCapacity.test.ts` runs a leader-led team of four members of one agent on default guardrails. It checks that four run at once, that two admitted sessions run four each side by side, that another item's run of that agent waits for the session to release its slot (when it settles or parks), that a session whose turns together outrun the wall clock still settles, and that each turn is held to the wall clock and the inactivity guard.
- `providers/providerParity.test.ts` holds **both adapters** to the same report-only surface, refusals and refusal to start. It also holds them to an isolated member's surface: the ordinary `eo` server, index, servers, skills and permissions, with no report-only hook. On both backends that turn is built by the supervisor's own isolated-member path, never by hand, and what the member's copy asks of its processes' environment reaches the CLI.
- `supervisor/teamIsolated.test.ts` covers isolated members end to end. It checks that a member's turn differs from the same agent's ordinary dispatch of the step only in where it stands, its attempt, its framing and posting nothing. It checks its context, that its copy is removed with the change line on its report, and the refusal of a kind that makes no copy. It runs a team of four with `maxParallel: 2` and checks that the two members starting after the first reports see neither, in their context or through `comment_read`, `comment_search`, `thread_read` and `item_detail`. It also covers freshness, cancelling and a leader-led isolated team. `packs/developer/workspace/memberCopies.test.ts` checks that a copy of a real repository is the item's worktree exactly (its HEAD, its status apart from staging, its bytes, no commit of EO's) and that it lives outside the repository and its git directory. It writes, commits and resets in one member's copy and checks that the item's worktree, its branch, a sibling's copy and the remote are untouched. It runs `git stash`, `git checkout -b`, `git tag` and `git branch -f` in a copy and checks each is said and the new branch and tag are gone afterwards. With two members working at once and the person making refs meanwhile, it checks that each removal takes only its own member's refs, and that a sweep does the same and keeps a ref the person has written to since. It checks that staging or unstaging after the capture changes no copy. It also checks that the sweeps find copies in the new place and the old. `providers/reportOnly.test.ts` covers each adapter's lock, the runtime qualification and the pin tripwire.

**Real CLIs (opt-in, no credit spent).** A local server stands in for the model and scripts the calls a participant must not be able to make: a shell command, a file write, code mode's nested `exec_command`/`apply_patch`, a subagent, EO's `comment` and the repository index. It runs them on a fresh session and a resumed one, then checks that no marker file exists and that EO's bridge was asked only for evidence.

```sh
EO_LIVE_CLAUDE_WIRE=1 pnpm exec vitest run --root apps/desktop src/main/providers/reportOnlyClaude.live.test.ts
EO_LIVE_CODEX=1 EO_CODEX_BIN=<EO's codex 0.167.1> pnpm exec vitest run --root apps/desktop src/main/providers/reportOnlyCodex.live.test.ts
```

Last run for EO-850 on Linux x64, with Claude Code 0.3.322 + Claude Agent SDK 0.3.322 and Codex 0.167.1: all three probes passed. The Codex control probe confirms that the refused route does write on an agent that is not locked. These probes have not been run on macOS or Windows for this release. The enforcement there is the same code, and the start-time checks above still apply.

## Not in this release

- **Writing participants.** An isolated member may change its own copy, but nothing it changes reaches the item's work: no member implements.
- **Merging a member's copy back.** A copy is discarded when its attempt ends, and what changed in it is said on the report.
- **A copy on a folder or scratch workspace.** Only a Git repository and no disk give isolated members copies. An isolated team on an item in a folder or scratch workspace is refused at start; a folder step's team must be report-only to run.
- **Recursive teams.** A member cannot lead a team or assign work. Only the configured leader assigns, and only to the team's members.
- Editing a team on the configure screen's step form. Teams are configured through the assistant's draft.
