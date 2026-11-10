import { startAgentWriteBridge, type AgentWriteBridge, type AgentWriteHandler } from "../mcp/writeBridge.js";

/**
 * An agent write bridge for a test that drives a supervisor whose agents
 * write (EO-543).
 *
 * The bridge has to be listening before the supervisor dispatches — a
 * turn is handed its address as it opens — and its handler is the
 * supervisor's own, which does not exist until the supervisor does. So
 * this binds first and is pointed at the supervisor once there is one:
 *
 *     const writes = await startTestWriteBridge();
 *     const supervisor = createRunSupervisor({ …, agentWriteBridge: writes.agentWriteBridge });
 *     writes.serve(supervisor);
 *
 * Until `serve`, every write is refused as one no run is there to make.
 */
export interface TestWriteBridge {
  agentWriteBridge: () => AgentWriteBridge;
  serve: (supervisor: { handleAgentWrite: AgentWriteHandler }) => void;
  close: () => Promise<void>;
}

export async function startTestWriteBridge(): Promise<TestWriteBridge> {
  let target: AgentWriteHandler | null = null;
  const bridge = await startAgentWriteBridge((itemId, request, writes) =>
    target === null ? Promise.resolve({ ok: false, code: "NO_RUN", problem: "No supervisor is serving this bridge yet." }) : target(itemId, request, writes),
  );
  return {
    agentWriteBridge: () => bridge,
    serve: (supervisor) => {
      target = (itemId, request, writes) => supervisor.handleAgentWrite(itemId, request, writes);
    },
    close: () => bridge.close(),
  };
}
