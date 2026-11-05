# Contributing to EO

Thanks for looking. This is what you need to get a change in.

## Before you write code

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`CLAUDE.md`](./CLAUDE.md) first. `ARCHITECTURE.md` is the one design document: what EO is, how it is put together, and why it is shaped the way it is. `CLAUDE.md` is the working agreement, and its invariants hold for every change — code that breaks one of them is wrong even if its own tests pass. If a change seems to need breaking one, say so on the issue before going further.

Outside work starts from a [GitHub issue](https://github.com/rockarxiv/Engineering-Orchestrator/issues). Open one, or comment on an existing one, before starting anything bigger than a small fix, so the scope is agreed before the code is written.

## Issue keys you will see

Commit history and code comments are full of keys like `EO-123` and `KAN-45`. They refer to the maintainer's own tracker, which is not public, so there is nothing to look them up in. The commit or comment beside a key says what it needed to; the key is only there to tie related changes together.

## Running it

Requires **Node 22+**, **pnpm 10+**, and **git** on your PATH.

```bash
pnpm install
pnpm dev
```

`pnpm install` rebuilds the native SQLite module for Electron, and `pnpm dev` opens the app with hot reload.

## The checks a pull request must pass

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter=@eo/desktop exec playwright test   # end-to-end, needs a display
```

CI runs the same checks on every pull request, along with `pnpm design:check`, which checks the design system's colour tokens and their contrast. Run them yourself first.

Every pull request is reviewed by the maintainer before it can merge.

## Writing the change

- **Tests live beside the code**, and they are part of the change, not a follow-up. Engine logic is unit-tested; anything touching SQLite uses an in-memory database.
- **Match the conventions already in the codebase** over your own preference. `CLAUDE.md` lists the ones that matter most.
- **Ask before adding a dependency.** Anything not already in [`ARCHITECTURE.md`](./ARCHITECTURE.md), "The stack", needs discussing on the issue first.
- **Keep to the issue's scope.** A good idea nearby is a new issue, not part of this pull request.

## Licence

Contributions are accepted under the [Apache License 2.0](./LICENSE), as section 5 of that licence provides. By opening a pull request you agree that your contribution is licensed on those terms.

## Security and conduct

Do not report a vulnerability in a public issue — [`SECURITY.md`](./SECURITY.md) says how to report one privately. Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
