import { cn } from "@eo/ui";

/**
 * That EO's memory calls cannot run on this machine's Codex, and how to
 * make them (EO-509), drawn in the chat layout's own style on its Codex
 * Runtimes card and Codex agent editor.
 *
 * The classic layout draws the same sentence (`agents/CodexMemoryNotice`),
 * which this layout may not import; why it is said, and where, is there.
 */
export function CodexMemoryKeyringNotice({ className }: { className?: string }) {
  return (
    <p role="note" className={cn("leading-snug text-paused", className)}>
      EO&apos;s memory calls are unavailable on Codex while it keeps its sign-in in your operating system&apos;s keyring: choosing which memory an agent
      is given, writing notes from its runs and tidying them up run only in a Codex home of their own, which a keyring sign-in cannot reach. To turn them
      on, set <code className="font-mono">cli_auth_credentials_store = &quot;file&quot;</code> in your{" "}
      <code className="font-mono">~/.codex/config.toml</code> and sign in to Codex again.
    </p>
  );
}
