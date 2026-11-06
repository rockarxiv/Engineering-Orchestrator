# Running the e2e suite

```bash
cd apps/desktop && pnpm e2e
```

From `apps/desktop`, not the repo root. Run from the root and Playwright
loads the specs through the wrong config and reports `Cannot find module`
or the misleading *"did not expect test() to be called here"* — which
reads like a duplicate `@playwright/test` and is not one.

## Every spec runs in the chat layout

It is the only layout there is (EO-529). Launch through
`launchApp(homeEnv(home))` in `support/app.ts`, never `electron.launch`
directly: it hands back the first window, which opens on the
conversation at `/chat`. In that layout there is no `main` landmark — what is open beside
the conversation is `openView(page)` (`support/board.ts`), the board's
pipelines are links on the rail (`openPipeline`), and every other place
is behind the rail's gear (`openPlace`, `support/rail.ts`).

## On a headless Linux box

Electron needs a display. Without one every spec fails at launch with
`The platform failed to initialize`:

```bash
xvfb-run -a pnpm e2e
```

## On macOS and Windows

CI runs the same suite on both (`e2e-macos`, `e2e-windows`). Neither
needs a display. Each launch gets its own `userData` through
`--user-data-dir` (see `launchApp`), because on those two systems no
environment variable moves it. On every platform it sits at
`<home>/.config/Electron`, which is why a spec can open
`.config/Electron/eo.db` wherever it runs.

Two tests are skipped on Windows, each giving its reason in the code.
`firstRun.spec.ts` fakes a signed-in Claude, and `pullRequest.spec.ts`
fakes `gh`. Both fakes are scripts, and Windows starts only a real
`.exe` for either.

On a Mac, setting `EO_PASSWORD_STORE` (the Jira spec always does)
undoes Playwright's `--use-mock-keychain`, so safeStorage uses the real
keychain. macOS looks for the keychain list and default under `$HOME`,
which is the spec's scratch home, so the spec makes a keychain there
with `security`, unlocks it and makes it that home's default. Without
one, the app blocks on a keychain it cannot find.

A hosted Mac's screen is 1024×768, and macOS keeps a window inside its
screen. A spec that measures layout sizes the window with `sizeWindow`
(`support/app.ts`), which also pins the page's viewport to that size.

## `pickFromJira.spec.ts` needs a real OS keychain

**Any Secret Service will do, not only GNOME's.** `EO_PASSWORD_STORE`
names a Chromium backend, and the default `gnome-libsecret` goes
through libsecret — which talks to whatever implements
`org.freedesktop.secrets` on the bus. On a KDE desktop that is
kwallet, and the spec passes with the default unchanged. Before
assuming this spec cannot run here, ask the bus whether a service is
already there and whether its collection is unlocked:

```bash
dbus-send --session --dest=org.freedesktop.secrets --print-reply \
  /org/freedesktop/secrets org.freedesktop.DBus.Properties.Get \
  string:org.freedesktop.Secret.Service string:Collections
```

If that answers with a collection and its `Locked` property is false,
run the spec as it is. The recipe below is for a machine with **no**
Secret Service at all — a CI container — rather than for every machine
without GNOME.

This matters because skipping the spec is how a rename slipped through:
it is the only end-to-end coverage of Settings → Connectors, so a
developer who writes it off as unrunnable is a developer who cannot see
that section break.


This is the only spec that stores a secret, and J-01 refuses to put a
token anywhere that is not encrypted. Playwright forces
`--password-store=basic` on every Electron it launches — Chromium's
plaintext store, for which `safeStorage.isEncryptionAvailable()` is
false — so the spec names a real backend through `EO_PASSWORD_STORE`
(defaulting to `gnome-libsecret`) and asserts the keychain is available
before it does anything else.

That assertion is the *good* failure. The bad one is a hang: if the
Secret Service is on the bus but has no unlocked default collection,
`isEncryptionAvailable()` blocks forever waiting on a `gcr-prompter`
that cannot reach the session bus, and the spec dies on a 30s timeout
with worker teardown timing out after it. Nothing in the output says
"keyring".

What it takes, and every part is load-bearing:

```bash
xvfb-run -a dbus-run-session -- bash -c '
  eval "$(printf "any-non-empty-password" \
    | gnome-keyring-daemon --unlock --components=secrets --daemonize)"
  export GNOME_KEYRING_CONTROL
  pnpm e2e
'
```

- **`xvfb-run` outside `dbus-run-session`.** The keyring daemon spawns a
  GTK prompter; with no `DISPLAY` already set it dies before the bus is
  reachable.
- **`eval` and exporting `GNOME_KEYRING_CONTROL`.** The daemon prints the
  variables that point at it. Without them in the environment the app
  process never finds the daemon this session started.
- **A non-empty password.** An empty one leaves the daemon with only the
  temporary `session` collection, and Chromium wants a *default* one. The
  password is meaningless — it just has to be something, so that
  `login.keyring` is created and left unlocked.

To check the state rather than guess at it:

```bash
dbus-send --session --dest=org.freedesktop.secrets --print-reply \
  /org/freedesktop/secrets org.freedesktop.DBus.Properties.Get \
  string:org.freedesktop.Secret.Service string:Collections
```

Both `collection/session` and `collection/login` should be listed. If
only `session` is, the spec will hang. `collection/login`'s `Locked`
property must be `false`.
