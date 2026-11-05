import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { closeApp, homeEnv, launchApp, skipFirstRun } from "./support/app.js";
import { liveHome } from "./support/liveHome.js";

/**
 * The assistant chat against the real backends, the way a person uses it
 * — Claude Desktop's chat, as EO now draws it.
 *
 * Every unit test stops at one end of the chain: the adapters are held
 * to scripted streams, the renderer to fixtures. This runs the built app
 * on the person's own Claude and Codex sign-ins and asks what a person
 * would see: the answer's words appearing as they are written, the steps
 * of a turn that uses tools, the turn folded once it has answered, and
 * Stop ending a turn mid-sentence.
 *
 * **Opt-in, because it spends real usage on a real account**, and it
 * needs the managed runtimes installed and both CLIs signed in:
 *
 *     pnpm --filter @eo/desktop exec electron-vite build
 *     EO_LIVE_CHAT=1 xvfb-run -a pnpm --filter @eo/desktop exec playwright test e2e/assistantChat.live.spec.ts
 *
 * The profile is a scratch one, as every spec's is, and what it borrows
 * from the person's own is borrowed so that nothing of theirs can be
 * changed by it:
 *
 * - **Each installed runtime is linked one by one into a scratch runtimes
 *   directory.** An install replaces its target by removing it and
 *   renaming a new one into place, which on a link removes the link and
 *   leaves the person's copy alone.
 * - **`~/.claude.json` is copied**, not linked: the CLI writes project
 *   entries and counters into it, and those belong to the scratch run.
 * - **The two sign-ins are linked**, so a token the CLI refreshes in
 *   place is refreshed where it lives. A CLI that saved a refreshed token
 *   by writing a new file and renaming it over the link would leave the
 *   person's own copy holding a token already rotated out — so a run can,
 *   in that case, sign them out of that CLI, and they sign in again.
 */
const OPTED_IN = process.env["EO_LIVE_CHAT"] === "1";

test.describe.configure({ mode: "serial" });
test.skip(!OPTED_IN, "spends real usage: set EO_LIVE_CHAT=1 to run");
test.setTimeout(360_000);

function scratchHome(): { scratch: string; home: string } {
  return liveHome("live chat");
}

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  const answer = (await page.evaluate(([name, body]) => window.eo.ipc.invoke(name as never, body as never), [channel, payload] as const)) as { ok: boolean; data?: T; error?: { message: string } };
  if (!answer.ok) throw new Error(`${channel}: ${answer.error?.message ?? "refused"}`);
  return answer.data as T;
}

/** The system agent, put on a backend. Created if the scratch profile has none. */
async function systemAgentOn(page: Page, provider: "claude" | "codex"): Promise<void> {
  const { agents } = await invoke<{ agents: { id: string; name: string; role: string; instructions: string; enabled: boolean }[] }>(page, "agents:list");
  const system = agents.find((agent) => agent.role === "system");
  await invoke(page, "agents:save", {
    ...(system ? { id: system.id } : {}),
    name: system?.name ?? "Assistant",
    role: "system",
    provider,
    model: null,
    instructions: system?.instructions ?? "",
    enabled: true,
  });
}

/** The conversation, read again now that there is an assistant to hold it. The window is already in the chat layout (`launchApp`). */
async function openChat(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = "#/chat";
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByLabel("Assistant transcript")).toBeVisible({ timeout: 20_000 });
}

/** Sends a message and watches the live answer, sampling how much of it is on screen. */
async function askAndWatch(page: Page, words: string): Promise<{ lengths: number[] }> {
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await box.fill(words);
  await box.press("Enter");
  const live = page.getByRole("article", { name: "Live agent response" });
  await expect(live).toBeVisible({ timeout: 120_000 });
  const lengths: number[] = [];
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const text = (await live.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    if (text === null) break;
    lengths.push(text.length);
    await page.waitForTimeout(150);
  }
  return { lengths };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: the answer streams in, a tool-using turn shows its steps and folds, and Stop ends a turn`, async () => {
    const { scratch, home } = scratchHome();
    const { app, window: page } = await launchApp(homeEnv(home));
    try {
      await skipFirstRun(page);
      await systemAgentOn(page, provider);
      await openChat(page);

      // A first turn on a profile made a moment ago shares the main
      // process with everything a first start does, and is not what a
      // person sees after the app has been open a minute; it is asked
      // and waited out before anything is measured.
      await askAndWatch(page, "Say hello in five words, without using any tools.");
      await expect(page.getByRole("article", { name: "Live agent response" })).toHaveCount(0, { timeout: 120_000 });

      // 1. Words arrive as they are written: the live answer is read many
      // times while it grows, and grows in more than one step. The pushes
      // reaching the page are counted too, so a failure says which half
      // of the chain broke.
      await page.evaluate(() => {
        const counted = window as unknown as { __eoDeltas: number; __eoPieces: string[] };
        counted.__eoDeltas = 0;
        counted.__eoPieces = [];
        window.eo.ipc.subscribe("runs:delta" as never, ((push: { draft: { id: number; stream: string }; offset: number; text: string }) => {
          counted.__eoDeltas += 1;
          counted.__eoPieces.push(`${push.draft.id}/${push.draft.stream}@${push.offset}+${push.text.length}`);
        }) as never);
      });
      const { lengths } = await askAndWatch(page, "Without using any tools, write four sentences about why kitchen timers are useful.");
      const pushed = await page.evaluate(() => (window as unknown as { __eoDeltas: number }).__eoDeltas);
      const pieces = await page.evaluate(() => (window as unknown as { __eoPieces: string[] }).__eoPieces);
      console.log(`[${provider}] pushes: ${pieces.join(" ")}`);
      const distinct = new Set(lengths.filter((length) => length > 0));
      // The pushes are logged rather than counted: how finely the API cuts
      // a structured answer varies from turn to turn, and what a person is
      // owed is the text on screen growing as it is written, asserted next.
      expect(pushed, "the window was pushed the answer's words").toBeGreaterThan(0);
      expect(distinct.size, `the live answer grew in steps (${lengths.join(",")})`).toBeGreaterThan(3);
      await expect(page.getByLabel("Assistant transcript").getByText(/timer/i).last()).toBeVisible({ timeout: 60_000 });

      // 1b. Typing starts the backend, and the send adopts it: measured
      // against a send made with no typing at all, and checked by the
      // backend processes the app has — one waiting before the send, and
      // still that one, not a second, once the turn is under way.
      const backendName = provider === "claude" ? "claude" : "codex";
      const backendPids = (): string[] => {
        const pid = app.process().pid;
        try {
          return execFileSync("ps", ["-o", "pid=,comm=", "--ppid", String(pid)], { encoding: "utf8" })
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter(([, name]) => name === backendName)
            .map(([child]) => child!);
        } catch {
          return [];
        }
      };
      let runningTheTurn: string[] = [];
      const firstWordAfter = async (send: () => Promise<void>): Promise<number> => {
        const before = await page.getByRole("article", { name: "Live agent response" }).count();
        expect(before).toBe(0);
        const sentAt = Date.now();
        await send();
        const live = page.getByRole("article", { name: "Live agent response" });
        await expect(live).toBeVisible({ timeout: 120_000 });
        // Past the hidden name: the first word of the turn itself.
        await expect.poll(async () => ((await live.textContent()) ?? "").length, { timeout: 120_000, intervals: [25] }).toBeGreaterThan(12);
        const took = Date.now() - sentAt;
        runningTheTurn = backendPids();
        await expect(live).toHaveCount(0, { timeout: 120_000 });
        return took;
      };
      const conversationId = await page.evaluate(async () => {
        const answer = (await window.eo.ipc.invoke("assist:open" as never, undefined as never)) as { data: { conversation: { id: string } } };
        return answer.data.conversation.id;
      });
      const cold = await firstWordAfter(async () => {
        await page.evaluate(
          (id) => window.eo.ipc.invoke("assist:send" as never, { page: { route: "/chat", params: {} }, conversationId: id, body: "Without using any tools, say one short sentence about clocks.", attachmentIds: [], interrupt: false } as never),
          conversationId,
        );
      });
      const box1 = page.getByRole("textbox", { name: "Message the assistant" });
      await box1.fill("Without using any tools, say one short sentence about calendars.");
      await page.waitForTimeout(4_000);
      const waitingPids = backendPids();
      const warm = await firstWordAfter(async () => {
        await box1.press("Enter");
      });
      console.log(`[${provider}] first word: cold ${cold}ms, warmed ${warm}ms; waiting before the send: ${waitingPids.join(",")}; running the turn: ${runningTheTurn.join(",")}`);
      expect(waitingPids, "typing started the backend").toHaveLength(1);
      // The turn ran on the process that was waiting, and on no other.
      expect(runningTheTurn, "the send adopted the warm backend").toEqual(waitingPids);

      // 2. A turn that uses a tool shows the call while it runs, and once
      // it has answered folds what it did above the answer.
      const box = page.getByRole("textbox", { name: "Message the assistant" });
      const fold = page.getByRole("button", { name: /^Worked for .*tool call/ });
      // Counted first: an earlier turn may have used a tool it was asked
      // not to, and its fold is not this one.
      const foldsBefore = await fold.count();
      await box.fill("Use your EO tools to list the pipelines in this installation, then tell me how many there are in one sentence.");
      await box.press("Enter");
      await expect(fold).toHaveCount(foldsBefore + 1, { timeout: 240_000 });
      // Opened once it has settled — the line changes as the run ends —
      // and then kept open: a fold that closed itself would fail below.
      await expect(async () => {
        if ((await fold.last().getAttribute("aria-expanded")) !== "true") await fold.last().click();
        await expect(fold.last()).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      // Inside it the calls are folded again, one line for the run of them,
      // which opens to each call by what it did.
      const transcript = page.getByLabel("Assistant transcript");
      // A run of one call is drawn as itself rather than folded, so only
      // the folds there are get opened.
      await expect(transcript.getByRole("button", { name: /^\d+ tool calls|pipeline/i }).last()).toBeVisible({ timeout: 20_000 });
      for (const group of await transcript.getByRole("button", { name: /^\d+ tool calls/ }).all()) await group.click();
      await expect(transcript.getByRole("button", { name: /pipeline/i }).first()).toBeVisible({ timeout: 20_000 });
      await expect(fold.last()).toHaveAttribute("aria-expanded", "true");

      // 3. Stop ends a turn mid-answer and says so in the thread.
      await box.fill("Without using any tools, write a 700-word essay on the history of timekeeping.");
      await box.press("Enter");
      await expect(page.getByRole("article", { name: "Live agent response" })).toBeVisible({ timeout: 120_000 });
      await page.waitForTimeout(4_000);
      await page.getByRole("button", { name: "Stop" }).click();
      await expect(page.getByText("Turn stopped.")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("article", { name: "Live agent response" })).toHaveCount(0, { timeout: 60_000 });
    } finally {
      await closeApp(app);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
