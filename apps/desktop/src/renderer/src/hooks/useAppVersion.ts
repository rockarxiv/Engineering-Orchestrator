import { useEffect, useState } from "react";
import { aliasRetirementReached } from "@eo/core";
import { bridge } from "../ipc/bridge";

/** Example invoke round-trip (F-04 acceptance criteria). */
export function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    void bridge().invoke("app:getVersion", undefined).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setVersion(result.data.version);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}

/**
 * Whether the release that retires the `ticket_*` aliases is the one
 * running (KAN-178).
 *
 * Three screens say the same thing about the alias period — the Servers
 * screen, the pack import preflight and a module's approval card — and
 * the only part of it that is not a constant is this. One hook so they
 * cannot disagree about whether the deadline has arrived, which is the
 * difference between "retired after v0.1" and "this will stop working on
 * update".
 *
 * False until the version answers, which is the direction that cannot
 * mislead: a screen that flashed the red line and then took it back
 * would be teaching people to ignore it.
 */
export function useAliasesRetired(): boolean {
  return aliasRetirementReached(useAppVersion() ?? "");
}
