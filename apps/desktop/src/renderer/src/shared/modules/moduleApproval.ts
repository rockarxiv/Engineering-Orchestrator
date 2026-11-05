import type { ReactNode } from "react";

/**
 * What approving a module hands a screen: the act, whether it is under
 * way, why it was refused, and the confirmation window to draw (EO-353).
 * The classic layout's `useModuleApproval` and the chat layout's answer
 * in this one shape, so a screen reads either the same way (EO-519).
 */export interface ModuleApproval {
  /** Runs the module's tests and approves it if they allow. */
  approve: (module: { id: string; name: string }) => void;
  /** True while the tests run. */
  approving: boolean;
  /** Why the last attempt was not approved, or null. May span lines: one per failing case. */
  problem: string | null;
  /** The confirmation window, when one is open. Render it anywhere. */
  dialog: ReactNode;
}
