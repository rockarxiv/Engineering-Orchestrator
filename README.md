# EO

A desktop app for running work through pipelines of agent and human steps.

A piece of work is an item. It sits on a step of a pipeline, and the step says who has it right now: an agent, a person, EO itself, or a script. When that party is finished, the item moves along the route the pipeline declares for the result. When an agent gets stuck it comments and mentions you, which ends its run rather than leaving a subprocess waiting.

Pipelines are data. Start from a template — a weekly report, an inbox triage, a content draft — or describe what you want to the assistant and have it draft one. Software delivery is one template among them: in **Software feature to merge** an implementer works each ticket in its own git worktree, and the engine then checks the claim independently — commits exist, the tree is clean, your tests actually ran — before a reviewer sees it.

[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the design document.

## Running it

Requires **Node 22+**, **pnpm 10+**, and **git** on your PATH.

```bash
pnpm install
pnpm dev
```

That's the whole thing — `pnpm install` rebuilds the native SQLite module for Electron, and `pnpm dev` opens the app with hot reload.

Devtools do not open by themselves. Toggle them with `Ctrl/Cmd-Shift-I`, or launch with `EO_DEVTOOLS=1` to have them open detached.

## Download

Every release attaches installers for all three platforms: [Releases](https://github.com/rockarxiv/Engineering-Orchestrator/releases).

| | |
|---|---|
| **Windows** | `EO-<version>-win.exe` — one installer, x64 and arm64 |
| **macOS** | `EO-<version>-mac-arm64.dmg` for Apple silicon, `-x64` for Intel |
| **Linux** | `EO-<version>-linux-x86_64.AppImage` — `chmod +x` it and run it |

**They are not code-signed.** Certificates are still outstanding, and until they exist your operating system will say so:

- **Windows** shows *"Windows protected your PC"*. Click **More info → Run anyway**.
- **macOS** refuses outright — *"EO is damaged and can't be opened"* is what Gatekeeper says about any unsigned, un-notarized app, and it is not true. Either right-click the app → **Open** → **Open**, or run `xattr -cr /Applications/EO.app` once after dragging it across.
- **Linux** has no such gate. The AppImage needs FUSE, which every current desktop already has; on a headless box, `./EO-*.AppImage --appimage-extract-and-run` skips it.

Checksums are attached to each release as `SHA256SUMS-*.txt`. Updates come from the same releases and need no setup: an installed EO checks at start and every six hours, and *Settings → Updates* says when a newer release is out and downloads it and restarts when you ask it to. **Not on macOS, for now:** automatic updates need a signed app, and the macOS build is not code-signed, so until there is a signing certificate Mac users update by downloading the new `.dmg` from [Releases](https://github.com/rockarxiv/Engineering-Orchestrator/releases) and installing it over the old one.

## Building your own

If you would rather build it than download it:

```bash
pnpm build --filter=@eo/desktop && pnpm --filter=@eo/desktop run pack
```

That leaves a runnable app in `apps/desktop/release/linux-unpacked/` (`mac/` or `win-unpacked/` on other platforms). Run the `EO` binary inside it. Note `run pack` — plain `pnpm pack` is pnpm's own tarball command and does something else entirely.

To build an installer instead — `.dmg`, `.exe`, `.AppImage` — use `pnpm --filter=@eo/desktop exec electron-builder`, adding `--linux`, `--mac` or `--win` to pick a platform. Signing and notarization only run when the credentials are present, so an unsigned local build still succeeds. Note that each platform's installer has to be built on that platform.

Your data lives in the standard place for your OS: `~/.config/EO` on Linux, `~/Library/Application Support/EO` on macOS, `%APPDATA%/EO` on Windows. Worktrees are cut into `~/.eo/worktrees/<TICKET-KEY>`.

## First run

1. **Just me, or my organisation.** One question before anything else. Choosing your organisation takes its server's address; EO keeps it, and you sign in from **Settings → Organisation** once you have been invited. Everything else works on this machine on its own.
2. **Choose a template.** A gallery, not an empty board: a weekly report, an inbox triage, a content draft — and **Software feature to merge**, which is the pipeline EO ships for its own work and the one a developer wants. **Preview** walks an example through every step for free, before anything is signed in.
3. **Answer the template's own blanks** — for the developer template, the ticket prefix; for the others, a folder, a day, a channel.
4. **The needs check.** One line per thing that still has to be true — a repository, a coding agent signed in, a connector authorised — each red line saying why it is red and carrying the one button that fixes it. A developer attaches their checkout here. If a line cannot go green, **Continue with Preview only** leaves with a rehearsal rather than a locked door.
5. Then the board, with the first item running. **Settings → Projects** takes more than one repository; each gets its own board, its own ticket keys and its own branches. **Agents → Edit** picks the backend per agent: `claude`, `codex`, or `fake`, which walks the whole pipeline without spending anything.

Agents authenticate with whatever you already have: EO reads your existing `claude` or `codex` login and says so plainly if you are signed out.

EO does not ship the agent command-line tools themselves. If the backend you pick has no CLI on this machine, the Agents screen says so and offers to fetch it — naming the package, the publisher, the size and whose terms apply before anything is downloaded, and checking what arrives against the checksum npm publishes for it. Anthropic's components carry no redistribution grant, so EO fetches them from Anthropic rather than passing on a copy. If you already have Claude Code or Codex installed, EO uses that and downloads nothing.

## Licence

EO is open source under the [Apache License 2.0](./LICENSE). Anyone may use, modify and distribute it, including commercially, under that licence's terms.

The licence does not grant use of the EO name or logo.

Third-party components are listed in [NOTICE](./NOTICE).

## Working on EO itself

```bash
pnpm dev         # run the desktop app
pnpm typecheck   # must pass before any story is done
pnpm lint
pnpm test
pnpm --filter=@eo/desktop exec playwright test   # end-to-end, needs a display
```

Read [`CLAUDE.md`](./CLAUDE.md) first — it has the thirteen invariants that hold across every story, and code that breaks one of them is wrong even if its own tests pass.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) covers the rest of what a pull request needs: where outside work starts, what the issue keys in the history refer to, and the checks it must pass.

Found a vulnerability? Don't open an issue — [`SECURITY.md`](./SECURITY.md) says how to report it privately.
