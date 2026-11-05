import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../../../query/client";

/** One IPC call as a test sees it. */
export interface Call {
  channel: string;
  payload: unknown;
}

/**
 * The preload bridge, answering from a table and recording every call —
 * the classic settings tests' stub, once. An answer may be a function of
 * the payload; anything unlisted answers `{}`, which every section reads
 * as "none of those yet".
 */
export type Answers = Record<string, unknown | ((payload: unknown) => unknown)>;

/**
 * Built here, installed by the test: only a test file (and `ipc/bridge.ts`)
 * may touch the preload object (EO-319, `ipc/bridge.test.ts`), so each test file
 * puts `invoke` in place itself — see `stubIpc` in those files.
 */
export function ipcStub(answers: Answers = {}): { invoke: (channel: string, payload: unknown) => Promise<unknown>; calls: Call[] } {
  const calls: Call[] = [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const answer = answers[channel];
    if (typeof answer === "function") return { ok: true, data: (answer as (payload: unknown) => unknown)(payload) };
    if (channel in answers) return { ok: true, data: answer };
    return { ok: true, data: {} };
  });
  return { invoke, calls };
}

/** The payloads sent on one channel, in order. */
export function sent(calls: Call[], channel: string): unknown[] {
  return calls.filter((call) => call.channel === channel).map((call) => call.payload);
}

/** A section as the chat layout's settings view hosts it: a query client and a router. */
export function renderSection(node: ReactNode) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
