import type { AgentEvent, AgentProvider, AgentProviderResumeOptions, AgentProviderStartOptions } from "@eo/core";
import { createFakeProvider, type FakeProviderScript } from "./fake.js";

export interface ScriptedRoute {
  /** Matched against the assembled dispatch context (which carries the item key and the action being dispatched). */
  when: (context: string) => boolean;
  script: FakeProviderScript;
}

/**
 * Routes each dispatch to a different scripted behaviour.
 *
 * The fake provider (A-01) replays one script per instance, which is all
 * a single-run test needs. A multi-item scenario needs different agents
 * to behave differently on different items, and `start()` deliberately
 * receives no item id — an AgentProvider is handed a prompt, not a
 * database row. The assembled context is the honest discriminator: it
 * carries the item key and the action, which is exactly what a real
 * agent would be reading to decide what to do.
 *
 * Each matched route gets its own fake-provider instance, and threads are
 * namespaced per route so `resume()` continues the right script.
 */
export function createScriptedProvider(routes: ScriptedRoute[], fallback: FakeProviderScript = {}): AgentProvider {
  const providersByRoute = new Map<number, AgentProvider>();
  const routeByThreadId = new Map<string, number>();

  function providerFor(index: number): AgentProvider {
    let provider = providersByRoute.get(index);
    if (!provider) {
      provider = createFakeProvider(index === -1 ? fallback : routes[index]!.script);
      providersByRoute.set(index, provider);
    }
    return provider;
  }

  return {
    async *start(opts: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
      const index = routes.findIndex((route) => route.when(opts.context));
      const provider = providerFor(index);

      for await (const event of provider.start(opts)) {
        // Namespace the thread id so resume() can find its way back to
        // the same route's provider instance.
        if (event.type === "thread_started") {
          const threadId = `r${index}:${event.threadId}`;
          routeByThreadId.set(threadId, index);
          yield { type: "thread_started", threadId };
          continue;
        }
        yield event;
      }
    },

    async *resume(threadId: string, message: string, opts?: AgentProviderResumeOptions): AsyncIterable<AgentEvent> {
      const index = routeByThreadId.get(threadId);
      if (index === undefined) return;
      const innerThreadId = threadId.slice(threadId.indexOf(":") + 1);
      yield* providerFor(index).resume(innerThreadId, message, opts);
    },
  };
}
