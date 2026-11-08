# EO — Engineering Orchestrator: frequently asked questions

EO is an open-source desktop app for running work through pipelines you build yourself. These are the questions people ask about it, each answered first in a sentence or two and then in detail. The design behind every answer is in [`ARCHITECTURE.md`](../ARCHITECTURE.md); installing and running EO is in the [README](../README.md).

- [What is EO, and who is it for?](#what-is-eo-and-who-is-it-for)
- [Can I build my own pipeline, or change an existing one?](#can-i-build-my-own-pipeline-or-change-an-existing-one)
- [What can a step in a pipeline be?](#what-can-a-step-in-a-pipeline-be)
- [Can a step wait for something outside EO, like a pull request, a payment or a reply?](#can-a-step-wait-for-something-outside-eo-like-a-pull-request-a-payment-or-a-reply)
- [Is EO only for software development?](#is-eo-only-for-software-development)
- [How do I run several Claude Code or Codex agents in parallel without them stepping on each other?](#how-do-i-run-several-claude-code-or-codex-agents-in-parallel-without-them-stepping-on-each-other)
- [How does EO check an agent's work instead of trusting it?](#how-does-eo-check-an-agents-work-instead-of-trusting-it)
- [What happens when an agent gets stuck or needs an answer?](#what-happens-when-an-agent-gets-stuck-or-needs-an-answer)
- [Does EO work without Claude Code, or without Codex?](#does-eo-work-without-claude-code-or-without-codex)
- [Does my data leave my machine?](#does-my-data-leave-my-machine)
- [How much does EO cost?](#how-much-does-eo-cost)
- [Which operating systems does EO run on?](#which-operating-systems-does-eo-run-on)
- [Why does Windows or macOS warn me about the EO installer?](#why-does-windows-or-macos-warn-me-about-the-eo-installer)
- [How is EO different from running agents by hand in terminals or tmux?](#how-is-eo-different-from-running-agents-by-hand-in-terminals-or-tmux)
- [How is EO different from working in one interactive agent session?](#how-is-eo-different-from-working-in-one-interactive-agent-session)
- [How is EO different from a CI bot that opens pull requests?](#how-is-eo-different-from-a-ci-bot-that-opens-pull-requests)

## What is EO, and who is it for?

EO is a desktop app for building pipelines and running work through them, where each step is done by an AI agent, a person, EO itself or a script of your own. It is for anyone who wants agents to do part of a recurring job, with a person deciding at the points where a person should.

A piece of work is an *item*. It sits on a *step* of a pipeline, and the step says who has it right now. When that party is finished it reports a *result*, the pipeline's *routes* say where that result leads, and the item moves there. The pipeline is data — steps and the routes between them — so you shape your own process without writing code.

The agents are Claude Code and Codex, signed in with your own account. Everything runs on your own machine; nothing needs a server. Examples of what people build: an agent that drafts the weekly report for someone to approve, a triage of a shared inbox, a content draft that is only published when a person presses the button, or a software change that an agent implements in its own git worktree and a reviewer checks. The first thing EO shows is a gallery of templates like these, not an empty board.

## Can I build my own pipeline, or change an existing one?

Yes. You describe the pipeline you want to the assistant, or the change you want to one you have, and it drafts the graph for you to read and publish; you can start from a gallery template and change it the same way, at any time.

- **Describe it to the assistant.** For example: "every Monday draft the sales report, have Anna approve it, then post it to Slack." The assistant proposes the steps, who owns each one, the results each can report and the routes between them, and writes any script a step needs. The draft is drawn as a graph on a card and checked by the same validator as every other change. Nothing changes until you press **Publish pipeline**. Asking for "a hand-checked QA step after Review" works the same way on a pipeline that already exists.
- **There is no separate graph editor for drawing it by hand.** Every pipeline is drawn on its Graph view, which is read-only; a change to the graph, a step's settings, a pipeline's name or a restored version is a draft or a card the assistant proposes and you press. The assistant never applies its own proposals.
- **From another program.** EO can serve an MCP server on `127.0.0.1` (off until you turn it on in Settings), and a Claude Code or Codex session of your own can read and publish a pipeline graph through it, with the same checks and refusals as a click in the window.

Routes are rows of data — "from this step, on this result, go to that step" — so inserting a step between two others, or adding a third outcome to a review, is a change to rows and needs no code. The validator reports problems in plain words before anything is published, such as "The Approve step has no route for 'rejected'".

Publishing writes a **new version** of the pipeline. Items already in flight finish on the version they entered on; new items take the new one. Rolling back is publishing an older version again. Before publishing, you can also have the assistant test a draft with real runs on test items, on a copy that leaves the live pipeline untouched.

## What can a step in a pipeline be?

A step is one of exactly four kinds: an agent, a person, EO itself, or your own script (a *module*). The kind says who has the item while it is on that step.

| Kind | Who does it |
|---|---|
| **An agent** | A Claude Code or Codex agent in the role the step names — a writer, a triager, an implementer, a reviewer, or any role you define. |
| **A person** | Somebody you name, or a group where anyone can claim it. EO never dispatches here; it waits. The step's results are drawn as buttons, such as "Approve → Post to Slack". |
| **EO itself** | A function EO ships, called a *builtin*: cutting a git worktree, opening a pull request, watching a pull request, or waiting until a date. |
| **Your own script** | A *module*: JavaScript stored in EO with a manifest declaring its inputs, what it needs (programs it may run, environment variables, network access, permission to comment or create items), the results it can report and whether it has effects outside EO. |

A module is the way to put your own code into a pipeline, and a person is the gate in front of it:

- **It cannot run on live work until a person approves it.** Approving runs its tests, and a module with no tests, or whose tests did not run or did not pass, cannot be approved. Tests run with the network blocked, writes confined and a fake clock.
- **Any change to its code or manifest withdraws the approval.**
- What the person is shown before approving is what the module declares and what it did when tested, with the source one click away.
- The one exception is a trial: while the assistant tests a draft with real runs, an unapproved module may run on that trial's test items, within the needs it declared, and nowhere else.

A module runs in a separate process that hands it only what its manifest declares. That is a boundary of declared needs, not an operating-system sandbox, which is why a person's approval is required.

## Can a step wait for something outside EO, like a pull request, a payment or a reply?

Yes. A builtin or module step can be set to *keep checking*: it runs a short check every few minutes, and the item moves on when a check reports a result.

The step carries two settings, how often to check (at least every minute) and when to give up (a week unless it says otherwise, or never). Each check either answers "still waiting", optionally with news such as a failed CI job or a new review comment, which EO posts once on the item, or reports one of the step's results, which routes like any other. The wait is stored as a row, not held in a running process, so it survives EO being closed and the computer sleeping. No check runs while EO is offline or for a minute after the computer wakes.

A module whose manifest declares that it can wait is how a pipeline waits on another system — a payment provider, a document-signing service, a shared inbox — with no code added to EO. The builtin that watches a pull request works the same way: it reports `merged`, `closed`, `conflict`, `checks_failed`, `changes_requested` or, if the step asks for it, `ready`.

A watch that gives up, fails six checks in a row, or keeps sending an item round the same loop stops and posts a comment that mentions a person.

## Is EO only for software development?

No. Software delivery is one gallery template among four, and the other three have nothing to do with code.

| Template | What it does |
|---|---|
| **Weekly report** | Gather → Draft → Approve → Filed. An agent reads a folder and writes the report; a person approves it before it is filed. |
| **Inbox triage** | Read → Decide → Handled. An agent summarises each message; a person chooses to answer, escalate or close. |
| **Content draft and approve** | Outline → Write → Approve → Approved. Nothing is published without a person pressing the button. |
| **Software feature to merge** | Worktree → Index → To Do → Review → Merge Request → Watching pull request → Done. The pipeline EO uses for its own development. |

**Preview** walks a template's example item through every step for free, before anything is signed in. A run can work in a git repository, a fixed folder, a temporary scratch directory, or no disk at all, so a pipeline does not need a repository. The core that schedules, runs and routes work knows nothing about repositories or branches; the git support is a separate pack.

## How do I run several Claude Code or Codex agents in parallel without them stepping on each other?

Give each piece of work its own git worktree, tell EO which files each one touches, and raise the concurrency limits in Settings. EO starts at one run at a time, on purpose.

- **A worktree per item.** In the *Software feature to merge* template each ticket gets its own branch and its own git worktree under `~/.eo/worktrees/<TICKET-KEY>`, cut from the remote branch rather than your local one. EO never checks out, stashes or fast-forwards anything in your own working copy.
- **Dependencies and `touches`.** When the assistant plans work into tickets it lists the repository paths each one touches. Two tickets whose paths overlap are given a dependency, so one waits for the other; a ticket that depends on an unmerged ticket of the same feature in the same repository is cut from that ticket's branch and rebased when it lands. An item with an open dependency is never started.
- **Concurrency.** Three limits apply: across all of EO, per agent, and per shared filesystem (one repository or folder). All three default to **1**. Raising them is a settings change, made when you trust the dependency graph for your work.
- **A check after the fact.** After an agent implements a ticket, EO checks that no file on its branch is byte-identical to another ticket's unmerged work, because a worktree is where an agent is pointed, not a wall it cannot see past.

Worktrees give filesystem isolation only: two agents can each write correct code whose combination is broken. That is why EO leans on the dependency graph, re-runs the checks after rebasing onto the current base, and leaves merging to a person.

## How does EO check an agent's work instead of trusting it?

Wherever a claim can be checked independently, EO checks it itself, and each step says what is checked. Where nothing can check it, the step says so and a person's step downstream is where it gets looked at.

- **Software changes.** After an implementer says it is finished, EO looks at the worktree: the branch has commits beyond the base, the tree is clean, the project's configured test command actually ran, and nothing was copied from another ticket's unmerged work. A failed check either routes to a step you chose for `verification_failed` or stops the item and asks you.
- **Review coverage.** A reviewer reports a result for each acceptance criterion. EO compares those with the criteria the ticket declares and says in the thread which were left unexamined.
- **Folder work.** EO checks that the files the step declares exist and were written during this run.
- **Answers are structured.** An agent's answer must match its role's schema, enforced through the backend's own structured-output mechanism. EO never parses prose looking for an answer; a malformed answer is sent back with the validation errors, and escalated if it stays malformed.
- **Only EO moves items.** An agent returns a result; the pipeline's routes decide where it goes. No agent can move an item itself.

The column head shows what is checked — "EO checks: commits, tests ran, …" — or "Not checked until Approve" where nothing checks the step. On the item, each run's checks are listed with a pass or fail mark and a sentence each.

## What happens when an agent gets stuck or needs an answer?

It posts a comment that mentions you, and its run ends. Nothing sits waiting in a terminal; when you reply, the agent picks up the same conversation with its context intact.

The question is a comment marked as blocking. The run ends with its conversation kept, the item stays on its step with a `!` marker, and the comment appears in your inbox, with a desktop notification. When you reply, whenever that is, EO resumes the agent's conversation with what was said since, as the next attempt.

EO also stops runs on its own, and each stop is a comment that mentions a person rather than a silent failure:

- a run whose agent has said nothing for 10 minutes, while no tool is running;
- a run past its time limit (2 hours by default);
- an item past 3 failed attempts, such as a review loop that keeps going round;
- the budget for the item or the day being spent;
- a result the pipeline has no route for.

Every limit is a setting you can change. There is also a global pause.

## Does EO work without Claude Code, or without Codex?

Yes: each agent is set to its own backend, so you can use only Claude Code, only Codex, or both. To do real work you need at least one of them signed in; the third backend, `fake`, spends nothing and does no real work.

- **Claude Code** and **Codex** are chosen per agent under **Agents → Edit**. EO uses the login you already have for each and says plainly when you are signed out. Capabilities EO hands an agent reach both backends, and where one cannot do something EO says so where you choose the backend.
- **`fake`** walks a pipeline with scripted answers and costs nothing. It is what Preview and EO's own tests run on. Its answers are placeholders, so an agent left on `fake` does not do the step's real work.
- EO does not ship the Claude Code or Codex command-line tools. If the backend you pick is not on your machine, EO offers to fetch it, naming the package, the publisher, the size and whose terms apply before anything is downloaded. If you already have it installed, EO uses yours.

## Does my data leave my machine?

EO keeps its data on your machine, in a local SQLite database, and needs no server or account of its own. What leaves the machine is what your agents send to the AI provider you signed in to, and whatever you connect EO to.

- **Where it lives:** `~/.config/EO` on Linux, `~/Library/Application Support/EO` on macOS, `%APPDATA%/EO` on Windows. Worktrees are under `~/.eo/worktrees/`. Secrets are kept in your operating system's keychain, never in the database.
- **What goes out:** agent runs go to Anthropic or OpenAI through Claude Code or Codex, under your own login. EO checks GitHub releases for updates, fetches an index of further gallery templates, and talks to the services you connect — a forge through `gh` or `glab`, Jira, or a connector you authorise.
- **Organisation mode is optional.** A team can run its own EO server and have desktops sign in, to share configuration and a record of the work. Even then the work runs on each person's machine, with their files and their sign-in, and the server never needs a person's disk.

EO's own MCP server, for other programs to drive EO, is off unless you turn it on, and listens only on `127.0.0.1`.

## How much does EO cost?

EO itself is free and open source under the Apache License 2.0. The agents' usage is billed by the provider — Anthropic for Claude Code, OpenAI for Codex — to the account you sign in with.

EO records what each run spent, shows it per item, per project and per day, and enforces budgets: a budget per day is on by default ($50), and a budget per item can be set. A pipeline step's run is stopped when either is spent, during its turn rather than only after it. The assistant's own runs are the exception: their spend is counted in the totals, but no budget stops them. Preview and the `fake` backend cost nothing. The Apache licence lets anyone use, modify and distribute EO, including commercially; it does not grant use of the EO name or logo.

## Which operating systems does EO run on?

Windows, macOS and Linux. Every release on the [releases page](https://github.com/rockarxiv/Engineering-Orchestrator/releases) has an installer for each.

| | |
|---|---|
| **Windows** | `EO-<version>-win.exe`, one installer for x64 and arm64 |
| **macOS** | `EO-<version>-mac-arm64.dmg` for Apple silicon, `-x64` for Intel |
| **Linux** | `EO-<version>-linux-x86_64.AppImage`; `chmod +x` it and run it |

On Windows and Linux an installed EO checks for updates at start and every six hours, and *Settings → Updates* downloads one and restarts only when you ask it to. **macOS has no automatic updates**, because they need a signed app: Mac users update by downloading the new `.dmg` and installing it over the old one. You can also run EO from source with Node 22+, pnpm 10+ and git; the README says how.

## Why does Windows or macOS warn me about the EO installer?

Because the installers are not code-signed: the signing certificates are still outstanding. The warning is about the missing signature, not about anything found in the app.

- **Windows** shows "Windows protected your PC". Click **More info → Run anyway**.
- **macOS** says "EO is damaged and can't be opened", which is what Gatekeeper says about any app without a Developer ID signature and notarization; it is not true. Right-click the app → **Open** → **Open**, or run `xattr -cr /Applications/EO.app` once after dragging it across.
- **Linux** has no such gate. The AppImage needs FUSE, which current desktops have; on a headless machine, `./EO-*.AppImage --appimage-extract-and-run` skips it.

Checksums are attached to each release as `SHA256SUMS-*.txt`.

## How is EO different from running agents by hand in terminals or tmux?

EO does the bookkeeping you would otherwise do yourself: which work is next, which worktree it is in, whether the agent really finished, and who needs to answer what. It also keeps that state when the app closes or the machine sleeps.

- **Work survives interruptions.** Every event of every run is written to a local database as it happens. If EO is closed or crashes, interrupted runs are carried on in their own conversations when it starts again (after you resume, if you chose to stop the agents when closing), and an interruption does not count as a failed attempt. A run cut off by a sleeping laptop is resumed, not failed.
- **Nothing waits in a window for you.** A stuck agent asks in a comment and its run ends, and the question lands in one inbox instead of in whichever terminal you last looked at.
- **Claims are checked.** EO checks the commits, the clean tree and the test run before work goes to review.
- **Order comes from the graph.** Dependencies and overlapping files decide what may run side by side, and worktrees are created and cleaned up for you.
- **Limits and spend are tracked.** Attempts, time, silence and budgets are enforced per run, and each stop is a comment.

## How is EO different from working in one interactive agent session?

One session is one conversation that you watch; EO runs many items, each through its own steps, with different agents for different roles and a person where the pipeline asks for one.

- **Roles are separate.** In *Software feature to merge* the implementer keeps one conversation per ticket across rework, while each review is a fresh read by a separate reviewer agent.
- **It runs unattended.** Agents work for hours without you watching; you open EO to answer what only you can, which the inbox lists.
- **Every agent gets the right context.** Each run is given the item, the newest comment from every step it has passed through and everything a person has said since that agent last ran, with tools to read the rest of the thread.
- **The process is written down.** The pipeline is a graph you can read, version and change, rather than instructions repeated at the start of each session.

You still talk to an agent directly: the assistant is a conversation, and that is where pipelines and work are planned.

## How is EO different from a CI bot that opens pull requests?

EO runs on your machine with your own agent login, works through a pipeline you define with people in it, and does not merge. A bot that runs in CI starts from an event in the repository; EO starts from items you plan, and a pull request is one step near the end.

- **It runs locally.** The agents work in worktrees on your machine, with your files and your sign-in; EO needs no CI runner or server.
- **People are steps.** A reviewer agent, an approval by a named person, or an answer to an agent's question are all part of the same pipeline.
- **It checks before it opens.** The implementer's claim is checked and a reviewer reads the work before the pull request is opened, through `gh` or `glab`.
- **It keeps watching.** After opening, a step watches the pull request and sends the ticket back to the implementer when checks fail, changes are requested or a conflict appears.
- **A person merges.** EO's job is to get work to review, not past it.
