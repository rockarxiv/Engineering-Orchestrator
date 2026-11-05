/**
 * What a connected client is not told by anything else.
 *
 * EO's own dispatched agents arrive with role prompts that explain the
 * model they are working in. A client connecting over MCP — Claude Code,
 * Codex, Claude Desktop — arrives with nothing but tool descriptions,
 * and a tool description cannot hold a procedure: it has to be short
 * enough to read while choosing between forty of them.
 *
 * The server's `instructions` carry what a model must know *before* it
 * does something wrong, and are always in context, so they stay short.
 * These are the rest: fetched when someone is about to do the thing,
 * and free until then.
 *
 * Plain data, and deliberately not a template engine. A guide is prose
 * with a name; the moment it needs logic it should be a tool instead.
 */
export interface Guide {
  name: string;
  title: string;
  description: string;
  body: string;
}

const ORIENT = `# What EO is, in the terms its tools use

EO drives a feature request to a ready-to-merge pull request by dispatching
role-based coding agents against a dependency-ordered ticket graph. You are
not one of those agents. You are where the person at the keyboard is, and
these tools do what they can do.

## The nouns

- **Project** — a group of work, spanning one or more repositories. Most
  tools act on the project the app window is showing; the listing tools take
  an optional \`projectId\` to read another without switching the window.
- **Pipeline** — an ordered set of **steps** belonging to a project.
- **Step** — a named *responsibility*, not a status. It is owned by an agent
  role, by a person, or by a built-in.
- **Route** — an edge. \`(from step, result key) → target\`. This is what
  decides where a ticket goes next, and it is data, not code.
- **Ticket** — \`feature\`, \`story\` or \`bug\`. A feature is a container and
  sits on no pipeline; its stories do the work.
- **Run** — one execution of a step against a ticket. Its transcript is in
  \`run_events\`, readable a page at a time with \`run_events\`.
- **Comment** — the only communication channel there is.

## What will refuse you, and why

- **You cannot move a ticket directly.** Only the engine writes where a
  ticket sits, by looking a result key up in a route. \`ticket_move\` asks
  for a manual transition; it does not write state.
- **You hand work over, you do not type it in.** There is no tool that
  makes a ticket from a title. \`work_submit_plan\` takes a decomposition
  you have already agreed with someone — an understanding, the decisions
  settled, and stories with acceptance criteria — and \`work_submit_ticket\`
  takes a single bug or story. Both go through the same validation EO's
  own system agent does, so agree the work first and submit the result.
- **A refusal is an answer.** Move, hold and resume return "no, and here is
  why" on a *successful* call — nearly always because an agent is working on
  the ticket. Read the reason. Never retry the same call unchanged.
- **Needs-attention is derived.** Nothing sets it; it follows from an open
  mention. Answer the comment and it clears.

## Asking for less

Every read tool takes \`fields\`, and every read tool with a main list —
\`tickets\` on \`tickets_list\`, \`events\` on \`run_events\`, and so on; its
description names it — also takes \`where\`, \`sort\`, \`limit\` and
\`offset\`. EO applies them to the answer itself, so they mean the same on
every tool.

- **\`fields\`** — dot paths into the answer, kept through lists:
  \`["tickets.key", "tickets.stepName"]\` answers two properties per ticket. A
  path that matches nothing is named in the summary, not refused.
- **\`where\`** — an array of \`{ "path", "op", "value" }\`, every one of which
  a list element must meet. Paths are relative to one element (\`stepName\`,
  not \`tickets.stepName\`). \`op\` is one of \`eq\`, \`ne\`, \`in\` (value is an
  array), \`contains\` (case-insensitive on text, membership on an array),
  \`gt\`, \`gte\`, \`lt\`, \`lte\` (numbers, or text — ISO dates order correctly)
  and \`exists\` (present and not null; \`"value": false\` for the opposite).
- **\`sort\`** — \`{ "path", "direction": "asc" | "desc" }\` on the list.
  Elements without the field come last.
- **\`limit\`** (at most 1,000) and **\`offset\`** — one page of the list.

An answer narrowed by any of these comes back as a one-line summary followed
by compact JSON, and its data carries \`total\` (how many matched),
\`returned\` and \`nextOffset\` (null on the last page). Filtering happens
before paging, so \`total\` counts every match.

An answer nobody narrowed is sent as the tool wrote it — unless it would run
past 40,000 characters, when EO sends its first page instead and says how
many there are. Treat that as a cue to ask again with \`where\`, \`fields\`
or \`limit\`, not as the whole answer.

\`tickets_list\` and \`tickets_list_archived\` also take filters EO applies in
its own query, before it builds the answer — so on a large project they are
the cheaper way to ask, and \`where\` can narrow what they return further:
\`stepId\` or \`stepName\`, \`pipelineId\`, \`type\`, \`parentKey\` (the
tickets filed under one feature), \`keys\` (a list), \`text\` (in the title,
whatever the case), \`createdSince\` and \`updatedSince\` (epoch
milliseconds), and on the live list \`atTerminalStep\`.

## Naming a ticket

Every tool that takes a ticket's id — \`ticket_get\`, \`comment_post\`,
\`ticket_update\`, \`ticket_move\`, \`ticket_hold\`, \`ticket_delete\` and the
rest, under either name — takes its key as well: \`EO-486\` names the same
ticket as its UUID. The key is read through the project whose prefix it
carries. There is no need to read \`tickets_list\` to turn a key into an id; a
key that names nothing is refused, naming it, and nothing is changed.

## Reading part of a ticket

\`ticket_get\` answers with the whole ticket: its fields, every comment,
every run and every move. On a long-lived ticket that is most of what you
did not need. \`include\` names the parts you do — any of \`ticket\`,
\`comments\`, \`runs\`, \`transitions\`, \`dependsOn\` and \`decision\` — and
the rest are not read at all. \`commentsLimit\` keeps the newest comments,
\`commentsSince\` those posted since a moment in epoch milliseconds, and
\`pinnedOnly\` the ones somebody marked as settled; \`runsLimit\` keeps the
newest runs; each narrows its part only when that part is included.
\`include: ["ticket", "comments"]\` with \`pinnedOnly: true\` is what a
ticket is and what was settled about it.

## Timing and spend across runs

\`runs_list\` reads runs across every ticket, newest first: each one's ticket
key, action, backend, model, status, start and end, \`durationMs\`, tokens in
and out, cache reads and writes, cost, turns and their scope, attempt,
thread, interruption and, on a review, its \`verdict\`. \`runs_summary\` adds
the same runs up by \`groupBy\` — \`item\`, \`action\`, \`backend\` or \`day\` —
with the count, \`activeMinutes\` (the runs' durations summed),
\`elapsedMinutes\` (first start to last end), tokens, \`costCents\` and, for
reviews, \`rejections\`; \`overall\` is every run matched. Both filter in EO's
own query by \`itemId\` (a key works), \`projectId\`, \`action\`, \`backend\`,
\`status\`, \`threadId\`, \`startedSince\` and \`startedUntil\` (epoch
milliseconds), and \`where\` narrows the list or the groups further. EO's
own short model calls, such as memory upkeep, are there too, as the action
\`side_call:<purpose>\`, so what they cost adds up with the runs. Sum a list's
\`costMicrocents\`, not its \`costCents\`: a side call costs a fraction of a
cent. This is the way to ask how long review took or what a week cost —
there is no need to read EO's database.

## What EO has learned

\`memories_search\` reads memory — what agents and people wrote down for the
next run to know — across every project and workspace scope, newest first.
Each entry has its \`id\`, \`scope\` with its \`name\`, \`body\`, \`source\` (a
person, or a run with its \`runId\` and ticket key), \`extracted\`, \`state\`
(\`active\`, \`retired\` or \`consolidated\`) and \`retiredReason\`,
\`consolidationId\`, \`contradictsRepositoryFile\`, \`replacesId\` (the
version an edit of it replaced), \`supersededIds\` (the entries an agent's
note named as the ones it corrects or repeats, retired as \`superseded\`),
\`createdAt\` and \`updatedAt\`. \`query\` is approximate search over the bodies: "windo" finds
Windows, "rerun" finds reruns, and a word spelt a letter off still matches;
matches come best first by bm25, each with a \`score\`. Filter in EO's own
query by \`scopeKind\`, \`scopeId\`, \`scopeName\`, \`projectId\`, \`sourceKind\`,
\`runId\`, \`itemId\` (a key works), \`extracted\`, \`state\`,
\`contradictsRepositoryFile\`, \`createdSince\`, \`createdUntil\`,
\`updatedSince\` and \`updatedUntil\`. Retired entries are included unless
\`state\` says otherwise; \`state: "active"\` is what runs are given now.
\`memory_get\` reads one entry with every version its edits replaced, the
entries it superseded, and the consolidations that wrote or retired it; \`memory_consolidations_list\` reads
all of a scope's consolidations with how many entries each \`replacedCount\`
and \`producedCount\`, and whether it was \`restored\`. This is how to see what
EO knows — there is no need to read EO's database.

The memory panel's actions are tools too, under its rules. \`memory_add\`
writes an entry to a \`scope\` (\`kind\` project or workspace, and its
\`id\`); \`memory_edit\` gives an active entry a new \`body\`, retiring
the old version and writing a new entry that names it as \`replacesId\`.
A body is at most 4,000 characters, as in the panel. Either way the entry is a person's,
so consolidation never rewrites it. \`memory_retire\` takes an entry out of
what runs are given and \`memory_restore\` puts it back;
\`memory_consolidation_restore\` undoes one consolidation, making what it
replaced active again and retiring what it produced. Nothing is deleted
by any of them. Each answers with the entry, or the entries, as they now
stand — or with the sentence saying why nothing changed: no entry, scope
or consolidation has that id, the body is too long, or the
organisation's record holding the project could not be reached. On a
project the record holds, every write goes to the record, as the panel's
do.

## Where to start

\`projects_list\`, then \`tickets_list\`, then \`ticket_get\` on anything that
looks stuck. \`inbox_list\` is the fastest read of whether anything is
waiting on a person.`;

const SUBMIT_WORK = `# Handing work over to EO

There is no tool that makes a ticket from a title: work typed straight
into a column has been thought about by nothing. What you hand over is
work you have already agreed with the person you are working with, and
it goes through the same validation EO's own system agent does. Agree
it first, then submit the result.

## Which of the two

- **\`work_submit_plan\`** — a capability big enough to need decomposing.
  It creates a feature with its stories under it, on a pipeline. Send
  \`understanding\` — what the work is, in your words, pinned on the
  feature and read by every agent downstream instead of your
  conversation — the \`decisions\` you settled, and the stories.
- **\`work_submit_ticket\`** — one bug somebody hit, or one story added to
  work that already exists. \`parent\` is an existing *feature's* key, and
  leaving it out is ordinary: standalone work is still work.

A feature holding one story is a container holding one thing. If the
work is one ticket, send one ticket.

## Dependencies are spelled differently in the two

- In \`work_submit_plan\`, \`depends_on\` holds **indices into your own
  stories array** — those stories do not exist yet, so their position is
  the only way they can name each other.
- In \`work_submit_ticket\`, \`dependsOn\` holds **keys of tickets that
  already exist** — \`KAN-14\`. You are attaching to a graph that is
  already there, and a key naming nothing is refused.

Either way, use it for real ordering only: a story that merely touches
related code is not a dependency.

Dependencies can be changed after filing, with \`item_update\`:
\`addDependsOn\` names tickets it is to wait for from now on and
\`removeDependsOn\` ones it is to stop waiting for, by key. So a ticket
that turns out to need work filed after it — a release waiting on the
stories that go into it — is changed in place, not filed again. The
change is refused whole, naming the tickets, if any part of it cannot
be made, a cycle included.

## Acceptance criteria are what gets checked

A story needs at least one, and each has to be checkable by someone who
did not write the story — because when the implementer says it is done,
EO does not take its word for it. The criteria are read against the diff
one at a time, and one that is not met blocks the story. "Works
correctly" is not something anyone else can check. "Returns 429 after
100 requests in a minute" is.

A **bug** is not required to declare any — its four repro fields are its
bar — but it keeps the ones you send, and a bug that declares none stops
in front of a person before it can be reviewed: EO refuses to review a
ticket it has nothing to check against, rather than let a reviewer
improvise a list nobody agreed to. If the person you are working with
said what "fixed" looks like, send it as \`acceptanceCriteria\` rather
than leaving it in your conversation, which EO cannot read.

## \`touches\` is a collision lever, not a summary

Repository-relative paths the story will change — \`src/limiter.ts\`, or
\`src/\` for a whole directory. EO compares these entries against each
other and serialises stories that overlap, so two agents never edit the
same file at once. Prose can never match anything, in a field that looks
like a safety feature — so in a plan an entry with a space in it is
rejected outright.

## \`priority\` is what gets picked first

An integer, 0 or more, and the scheduler picks the highest first: 0 is
Normal, 1 High, 2 Urgent, and anything above that is higher still. Left
out, a ticket is 0. On \`work_submit_plan\` the plan's own \`priority\` is
the feature's and each story carries its own — a story does not inherit
the feature's, so one sent without it is 0 however urgent the feature is.
A negative or fractional priority is refused, and on a plan that refuses
the whole plan. Set it when the person said the work is urgent, rather
than filing at 0 and changing it after with \`ticket_update\`.

## A bug filed this way never meets intake

Inside EO a bug is questioned until it is complete. Arriving here it
reaches the board directly, so \`work_submit_ticket\` demands all four and
names whichever are missing when it refuses:

- **\`stepsToReproduce\`** — how to make it happen, in steps someone else
  can follow.
- **\`expected\`** — what should have happened.
- **\`actual\`** — what happens instead.
- **\`environment\`** — where: OS, browser, version, whatever is
  load-bearing.

Do not invent one to get past the refusal. Ask the person who saw it.

## Where the work lands

- **Pipeline** — \`pipeline\` is a name; read the ones that exist from
  \`pipelines_list\`. Omitted, a project with one pipeline uses it and a
  project with several refuses and lists them. **A name the project does
  not have is refused, not guessed at**: work put somewhere other than
  where it was sent, and reported as a success, is the worst shape a
  failure can take.
- **Repository** — nothing to decide on a project with one. Over several,
  name it in \`repository\`, per story in a plan. A ticket filed under a
  parent feature takes that feature's repository *only when that feature
  has one*, and a feature made by \`work_submit_plan\` has none — so under
  one of those the ordinary rule still holds, and a project spanning
  several repositories refuses a ticket that names no repository. A name
  that is not on the project is refused for the reason above: the wrong
  repository is a branch and a pull request in the wrong place.
- **Project** — whichever the window is showing, unless you pass
  \`projectId\`.

Both tools succeed and answer \`created: false\` with a \`problem\` when the
work cannot be built — a dependency that is not there, a cycle once the
\`touches\` overlaps are merged in, a parent that is not a feature. Read
it, fix the submission, send it again.

## Write \`understanding\` for the agents, not for the person

\`understanding\` is pinned on the feature, and it is what every agent
downstream reads *instead of* your conversation. They cannot see what you
and the person discussed: this paragraph is the whole of it, as far as
they are concerned.

So write it for them. What is being built and why it matters, in enough
detail that somebody picking up one story understands what the rest of
the work is for — not a summary of who said what, and not a restatement
of the title.

\`decisions\` are the questions you settled that would otherwise be asked
again: "ten requests a second, settable per repository". They are pinned
too, and they are binding on everything that comes after. A decision left
out is one an implementer will make differently, in good faith.

## After it lands

The stories go to where their pipeline says work enters, and the
scheduler picks them up in dependency order — so the first thing to
happen may be nothing visible, if what you sent has to wait.

- \`tickets_list\` shows where each one is and who is on it.
- \`inbox_list\` shows anything that has come back with a question. An
  agent that needs a decision posts a comment and **ends its run**, so a
  full inbox is not a pile of notices — it is the reason the board is
  still.
- \`comment_post\`, with \`parentId\` set to the comment that asked, is how
  you answer one and let the parked run resume.
- The \`eo_unblock\` guide covers the rest of that ground.`;

const CHANGE_PIPELINE = `# Changing a pipeline without breaking it

The pipeline graph is data: steps and the routes between them. Inserting a
step and wiring what flows into and out of it takes no code. It also takes
no code to delete half a workflow by accident, which is what this is about.

## Read it first

\`pipeline_get\` returns the whole graph — every step, every route, and which
step work enters at. There is no per-step edit and no partial save, so this
is not optional: it is the only way to know what you are about to replace.

## The one trap

**\`pipeline_save\` publishes the whole graph.** What you send replaces what
is there. A step you leave out is a step you deleted, along with the routes
that mentioned it and the secrets scoped to it. Always start from
\`pipeline_get\` and send it back modified — never assemble a graph from
scratch unless you intend to replace everything.

## What the fields mean

- **\`entryStepId\`** — where work enters. Exactly one, and position orders
  the display and nothing else.
- **\`isTerminal\`** — the engine stops here. A pipeline with no reachable
  terminal step is work that never finishes.
- **\`type\`** — \`agent\` (a role does it), \`user\` (a person does it), or
  \`builtin\` / a module (EO does it).
- **\`ownerRole\`** — which role staffs an agent step. Read the roles that
  exist with \`agents_list\`; a step owned by a role no agent staffs will
  never dispatch.
- **Routes** — \`(fromStepId, resultKey) → target\`. The **result key** must
  be one the step's agent actually returns; a key nothing produces is a
  route never taken, and a result nothing routes parks the ticket and ends
  the run. \`target\` is another step's id, or one of two sentinels:
  \`user_attention\` (park it and ask a person) or \`terminal\` (done).

## What work must have to enter

\`entryRules\` is an ordered list of what an item must have to enter the
pipeline. Rules are declared data, not code: each can only ask about what EO
already holds on the item, and nothing runs. EO checks them when an item is
created on the pipeline, when a job is saved and each time it fires, and when
an item moves in from another pipeline, by hand or by a route. A refusal names
everything missing at once. A route that is refused leaves the item where it
is and asks a person.

- **\`kind\`** — \`field\` (with \`field\`, a spec field by name),
  \`description\`, \`workspace\`, or a kind a pack contributes, which
  \`registry_get\` lists.
- **\`types\`** — the qualified item types it applies to, such as
  \`developer:story\`. Left out, it applies to every type. A \`field\` rule fails
  on an item whose type has no such field, so narrow it with \`types\`.
- **\`message\`** — your own words for it, shown instead of the generated ones.

A value is missing when it is null, absent, an empty or whitespace-only
string, or an empty array. \`0\` and \`false\` are present.

\`pipeline_get\` shows them. In \`pipeline_save\`, leaving \`entryRules\` out keeps
what the pipeline has and \`[]\` clears them. A rule naming a field or a type
this project does not have is refused, and so is a kind nothing contributes.
Changing them files a new version, and an item already on the pipeline is not
checked again. They replace nothing a module step does after entry: a rule
stops work at the door, and a module step can still check anything once it is in.

## Then validate, then save

\`pipeline_validate\` takes the same graph and writes nothing. It reports
what would refuse to publish — an unreachable step, a duplicate result key,
a route to a step that does not exist. Run it, fix what it says, and only
then \`pipeline_save\`. A blocking problem is refused at save anyway; finding
out at validate is cheaper and says more.

## Nothing in it may only work on your machine

A pipeline is meant to be shared: exported to another installation,
imported from a pack, published by an organisation. So nothing you write
into one may hardcode a value that only holds where it was written. This
applies to **modules, module test cases, pipeline steps and agent
instructions alike** — not only to module code. A value that only holds
here passes every test on this machine and breaks silently on the next.

Never write in:

- **Absolute or home-directory paths** — \`/home/…\`, \`/Users/…\`,
  \`C:\\…\`, \`~/…\`.
- **User names, host names or local ports** — somebody's login, a
  machine's name, \`localhost:5173\`, \`127.0.0.1:8080\`.
- **One operating system's shell, commands or path separators** —
  \`bash -c\`, \`cmd /c\`, a binary only one system has, a path glued
  together with \`/\` or \`\\\` by hand rather than built with \`node:path\`.
- **Personal tooling** — a particular password manager, one person's
  signing setup, an alias from somebody's shell.

Anything that differs between installations — the repository, a branch,
a URL, how long to wait — goes in one of three places instead:

- **A step input with a sensible default**, which another installation
  overrides without touching code. A repository convention such as a
  default branch of \`main\` is fine written this way.
- **Read while the step runs**, from the checkout (\`ctx.cwd\`, git) or
  from the forge.
- **A declared environment variable or secret** — in a module, named in
  \`needs.env\`.

A module's test cases build every path they use from \`harness.cwd\`,
never from a path on this machine. Fake output a test case scripts is not
filesystem access, though: a path in a scripted \`stdout\` or \`stderr\` is
a realistic fixture, and it stays rather than being stripped out.`;

const UNBLOCK = `# Why is nothing moving?

Work back along the chain. Each step tells you whether to stop or keep
going.

## 1. Is EO dispatching at all?

\`engine_status\`. If \`paused\` is true, nothing new starts however healthy
the board looks — \`engine_resume\` starts it again. The one exception is the
system agent, which carries on while paused, so its runs are no sign that
EO is not paused. \`activeRunCount\` says how many agents are working right
now.

## 2. Is somebody waiting on a person?

\`inbox_list\`. This is the fastest read there is. An agent that needed a
decision posts a comment, mentions the human, and **ends its run** — it does
not sit holding a subprocess. So a full inbox is not a queue of notices; it
is the reason the board is still.

\`everythingBlocked\` means every ticket that could be moving is waiting on
someone. That is worth saying out loud rather than inferring from a board
that merely looks quiet.

## 3. Answer it

\`comment_post\` with \`parentId\` set to the comment that asked. Filing the
answer under the question is what marks the mention addressed and lets the
parked run resume; a reply posted at the top of the thread reads fine to a
person and clears nothing.

Mention an agent by name to hand it work. Mention the human to ask
something. There is no other channel — no inbox to write to, no side
message.

## 4. If a specific ticket is stuck

\`ticket_get\` on it, and read in this order:

- **a run is in progress** — nothing is wrong; it is being worked on, and
  move or delete will refuse until it ends or you pass \`cancelActiveRun\`.
- **its last run was cancelled** — somebody stopped it, and EO does not
  offer that step again by itself; the thread says so where it happened.
  Mention the agent whose step it is, move the ticket, or \`ticket_hold\`
  then \`ticket_resume\` to have it picked up again.
- **held** — someone parked it by hand. \`ticket_resume\` unparks it, and it
  stays on the step it was already on.
- **waits for** — an open dependency. It will not dispatch until those
  reach a terminal step. Chase those tickets, not this one.
- **the last run failed** — read the transcript with \`run_events\`, from
  \`fromSeq: 0\`, following \`nextSeq\` until it comes back null.`;

export const GUIDES: readonly Guide[] = [
  {
    name: "eo_orient",
    title: "How EO is put together",
    description: "The model and vocabulary EO's tools assume, and which of its refusals are by design. Read this first.",
    body: ORIENT,
  },
  {
    name: "eo_submit_work",
    title: "Handing work over to EO",
    description: "Which submit tool fits which shape of work, and what a plan or a ticket has to carry to be accepted and worked well.",
    body: SUBMIT_WORK,
  },
  {
    name: "eo_change_pipeline",
    title: "Changing a pipeline safely",
    description: "Steps, routes, result keys, sentinels and entry rules — and why pipeline_save replaces the whole graph.",
    body: CHANGE_PIPELINE,
  },
  {
    name: "eo_unblock",
    title: "Why work is not moving",
    description: "Working back from a still board: the engine, the inbox, a parked run, an open dependency.",
    body: UNBLOCK,
  },
];

export function guideNamed(name: string): Guide | undefined {
  return GUIDES.find((guide) => guide.name === name);
}
