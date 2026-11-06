import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPipeline, openPlace } from "./support/rail.js";

/**
 * Picking a feature from Jira, against the real app (J-02).
 *
 * The unit tests inject a fake `fetch`; this one does not. The app makes
 * genuine HTTP requests over a socket, stores the token through the real
 * `safeStorage`, and crosses the real IPC bridge — the layers that a
 * stubbed bridge cannot tell you anything about.
 *
 * What it is *not* is Atlassian. The server below answers the handful of
 * v2 endpoints J-01 and J-02 call and nothing else, so this proves the
 * app's half of the conversation, not Jira's.
 */
const EPIC = {
  id: "10001",
  key: "ACME-7",
  fields: {
    summary: "Rate limiting for the public API",
    description: "Anonymous callers get 100 requests a minute; authenticated ones get 1000.",
    issuetype: { name: "Epic" },
    status: { name: "In Progress" },
  },
};

const CHILDREN = [
  {
    id: "10002",
    key: "ACME-8",
    fields: { summary: "Count requests per API key", description: "Sliding window.", issuetype: { name: "Story" }, status: { name: "To Do" }, parent: { key: "ACME-7" } },
  },
  {
    id: "10003",
    key: "ACME-9",
    fields: { summary: "Return 429 with Retry-After", description: "", issuetype: { name: "Story" }, status: { name: "To Do" }, parent: { key: "ACME-7" } },
  },
];

/**
 * An issue someone already wrote out in full, and typed as a Bug
 * (KAN-19). Both halves matter: no children, so the picker asks the
 * as-written question; and not called "Story", because EO must not key
 * that choice off a team's own vocabulary.
 */
const WRITTEN = {
  id: "10011",
  key: "ACME-11",
  fields: {
    summary: "Retry-After header is missing on 429",
    description: "Set Retry-After to the seconds remaining in the window whenever a 429 goes out.",
    issuetype: { name: "Bug" },
    status: { name: "To Do" },
  },
};

function startStubJira(): Promise<{ server: Server; baseUrl: string; requests: string[] }> {
  const requests: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.pathname);
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Proves the app really sent the credential, rather than the test
    // proving only that a socket accepted a connection.
    if (!req.headers.authorization?.startsWith("Bearer ")) return send({ errorMessages: ["Unauthorised"] }, 401);

    if (url.pathname === "/rest/api/2/myself") return send({ name: "dev", displayName: "Dev Ops" });
    if (url.pathname === "/rest/api/2/project/ACME") return send({ id: "1", key: "ACME", name: "Acme API" });
    if (url.pathname === "/rest/api/2/issue/createmeta") {
      return send({ projects: [{ issuetypes: [{ name: "Epic", fields: {} }] }] });
    }
    if (url.pathname === "/rest/api/2/search") {
      const jql = url.searchParams.get("jql") ?? "";
      // Children are asked for by parent key, so the stub has to answer
      // by parent key: matching on "Epic Link" alone handed ACME-7's
      // children to every issue that asked, which made a childless
      // issue look like a container.
      if (jql.includes("Epic Link") || jql.includes("parent")) {
        return send({ issues: CHILDREN.filter((child) => jql.includes(child.fields.parent.key)) });
      }
      return send({ issues: [EPIC] });
    }
    if (url.pathname.startsWith("/rest/api/2/issue/")) {
      const key = url.pathname.split("/rest/api/2/issue/")[1]!.split("/")[0];
      const issue = [EPIC, ...CHILDREN, WRITTEN].find((entry) => entry.key === key);
      return issue ? send(issue) : send({ errorMessages: [`Issue does not exist: ${key}`] }, 404);
    }
    send({ errorMessages: [`No stub for ${url.pathname}`] }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

test("an epic is picked from Jira and its children arrive as stories", async () => {
  const jira = await startStubJira();
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e jira "));
  const home = path.join(scratch, "home");
  const repoPath = path.join(scratch, "acme-api");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# acme-api\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  const { app, window } = await launchApp(
    homeEnv(home, {
      // Playwright launches every Electron with `--password-store=basic`
      // and `--use-mock-keychain`, so safeStorage lands on Chromium's
      // plaintext store and J-01 refuses — correctly — to put a token
      // there. Naming a real backend is the only way an e2e can reach
      // the connected half of this feature at all. The name is Linux's;
      // on a Mac setting it at all is what puts the real keychain back,
      // and Windows has only DPAPI and no switch.
      EO_PASSWORD_STORE: process.env["EO_PASSWORD_STORE"] ?? "gnome-libsecret",
    }),
  );

  // The keyring is checked out loud, because without one J-01 refuses to
  // store the token and every step below fails as a timeout thirty
  // seconds later, describing nothing.
  //
  // After the first window and not before it, though. `evaluate` runs in
  // the main process, and the main process spends its first half-second
  // inside synchronous startup — opening the database, running
  // migrations, syncing prompts — answering no inspector traffic at all.
  // A question asked into that gap comes back as "Resulting promise was
  // garbage collected", which names neither the keyring nor the test.
  // Run on its own the launch is slow enough that startup is over by the
  // time the question arrives; run after any other spec, with Electron
  // already warm, it is not — so this failed in CI, in the full suite,
  // every time, and never on a developer running the file alone. A
  // window exists only once `whenReady` has finished, so waiting for one
  // is waiting for a main process that can answer.
  const keychain = await app.evaluate(({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
  }));
  expect(
    keychain.available,
    `no OS keychain here (backend: ${keychain.backend}) — set EO_PASSWORD_STORE to one this machine has, since Playwright forces --password-store=basic on every Electron it launches`,
  ).toBe(true);

  try {
    // First run creates a repository, which is what a Jira connection
    // belongs to.
    await attachRepository(window, repoPath);
    await expect(window.getByRole("button", { name: "Switch project" })).toContainText("acme-api", { timeout: 10_000 });
    await openPlace(window, "Settings");
    const view = openView(window);

    // Two steps since KAN-22: the site and its token are their own
    // thing, and the repository then points at it. Data Center, so the
    // token is a bearer PAT and there is no email.
    // Settings shows one section at a time, so the section comes first.
    // "Connectors" since EO-301, where it was "Jira sync": a Jira
    // binding is one connector on the project, and a section named after
    // the only connector there is would have to be renamed by the first
    // pack that adds a second.
    await view.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Connectors" }).click();
    await view.getByRole("button", { name: "Add a Jira connection" }).click();
    const site = view.getByLabel("Add Jira connection");
    await site.getByLabel("Kind").selectOption("datacenter");
    await site.getByLabel("Jira URL").fill(jira.baseUrl);
    await site.getByLabel("Personal access token").fill("a-real-looking-pat");
    await site.getByRole("button", { name: "Save" }).click();
    await expect(site).toHaveCount(0, { timeout: 15_000 });

    // On a Mac, that the token was encrypted under the real keychain and
    // not the mock one Playwright asks for (see EO_PASSWORD_STORE in
    // `index.ts`): the key safeStorage encrypts with lives there as the
    // app's name and "Safe Storage", and the app is "Electron" when run
    // unpackaged, as here.
    if (process.platform === "darwin") {
      expect(() => execFileSync("security", ["find-generic-password", "-s", "Electron Safe Storage"], { stdio: "ignore" }), "no safeStorage key in the macOS keychain").not.toThrow();
    }

    const connect = view.getByLabel("Connect to Jira");
    await connect.getByLabel("Project key").fill("ACME");
    await connect.getByRole("button", { name: "Connect" }).click();
    // `exact`, because `getByLabel` substring-matches and the settings
    // screen also has a "Jira connections" section — an ambiguous
    // locator that only bites when both happen to be mounted at the
    // moment of the check.
    await expect(view.getByLabel("Jira connection", { exact: true })).toBeVisible({ timeout: 15_000 });

    // Pick the epic, from the board's own Import from Jira button
    // (EO-518) — the one way to add work its head still offers.
    await openPipeline(window, "Delivery");
    await view.getByRole("button", { name: "Import from Jira" }).click();
    const picker = window.getByRole("dialog", { name: "Pick from Jira" });
    await picker.getByRole("button", { name: "Search" }).click();
    await picker.getByRole("button", { name: /ACME-7/ }).click();

    // The question the story exists to ask.
    await expect(picker.getByText(/has 2 children in Jira/)).toBeVisible();
    await picker.getByRole("button", { name: "Import them as stories" }).click();

    // Landed as a feature carrying its key, and the item detail links
    // back to the issue.
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting for the public API" })).toBeVisible({ timeout: 15_000 });
    await expect(view.getByRole("link", { name: "ACME-7" })).toHaveAttribute("href", `${jira.baseUrl}/browse/ACME-7`);
    // The description arrived as the opening comment, not a field.
    await expect(view.getByText("Anonymous callers get 100 requests a minute")).toBeVisible();

    await openPipeline(window, "Delivery");
    await expect(view.getByText("Count requests per API key")).toBeVisible();
    await expect(view.getByText("Return 429 with Retry-After")).toBeVisible();

    // And it really went over the wire.
    expect(jira.requests).toContain("/rest/api/2/myself");
    expect(jira.requests).toContain("/rest/api/2/search");

    // KAN-19: the other answer to the same question. A Bug with no
    // children, taken as the work rather than a request for it — one
    // story, no feature above it, waiting on the product owner.
    await view.getByRole("button", { name: "Import from Jira" }).click();
    await picker.getByRole("textbox", { name: "Words to look for" }).fill("ACME-11");
    await picker.getByRole("button", { name: "Search" }).click();
    await picker.getByRole("button", { name: /ACME-11/ }).click();

    await expect(picker.getByText("Is this the work, or a request for it?")).toBeVisible();
    await picker.getByRole("button", { name: "Work it as written" }).click();

    // Its words are the specification, so they are the item's body
    // rather than the opening line of a conversation.
    await expect(view.getByRole("heading", { level: 1, name: "Retry-After header is missing on 429" })).toBeVisible({ timeout: 15_000 });
    await expect(view.getByText("Set Retry-After to the seconds remaining")).toBeVisible();
    await expect(view.getByText(/will not be decomposed/)).toBeVisible();
  } finally {
    await closeApp(app);
    jira.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
