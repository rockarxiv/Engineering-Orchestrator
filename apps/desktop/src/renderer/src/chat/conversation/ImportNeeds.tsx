import type { ReactNode } from "react";
import { aliasNotice, describeMachineSpecificPlace, type ImportPreflightView } from "@eo/core";
import { cn } from "@eo/ui";

/**
 * What an imported pipeline would need here, before anything is written
 * (KAN-108) — every line `pipelines:importPreflight` answers, drawn once
 * for the two places that ask it: the assistant's import card (EO-521)
 * and the pipeline editor's Import.
 *
 * Only answerable because a module declares what it touches. Nothing
 * here is enforced on the module's behalf, and the wording says so where
 * it matters (EO-74).
 *
 * The module slugs that collide with ones here are not drawn: each place
 * asks about them in its own way, beside its own button.
 */
export function ImportNeeds({
  preflight,
  aliasesRetired,
  itemsWord,
}: {
  preflight: ImportPreflightView;
  /** Whether this release has retired the old tool-name aliases (KAN-178). */
  aliasesRetired: boolean;
  /** The project's word for its work, plural and lowercased. */
  itemsWord: string;
}) {
  const unfilled = preflight.roleSlots.filter((slot) => !slot.filled);
  const present = preflight.itemTypes.filter((type) => type.present);

  return (
    <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed">
      {preflight.moduleCount > 0 ? (
        <Line>
          This document carries code written on another machine. Its modules arrive unapproved and cannot run until you have read and approved
          them. Approving runs a module&apos;s tests, and every one has to pass.
        </Line>
      ) : null}
      {preflight.missingBinaries.map((missing) => (
        <Line key={`bin-${missing.name}`} tone="paused">
          <code className="font-mono">{missing.name}</code> is not on your PATH — {missing.wantedBy.join(", ")} needs it.
        </Line>
      ))}
      {preflight.missingSecrets.map((missing) => (
        <Line key={`env-${missing.name}`} tone="paused">
          <code className="font-mono">{missing.name}</code> is not set — {missing.wantedBy.join(", ")} needs it. Add it under Settings → Modules.
        </Line>
      ))}
      {preflight.wantsNetwork.length > 0 ? <Line>Uses the network: {preflight.wantsNetwork.join(", ")}.</Line> : null}
      {preflight.readsItems.length > 0 ? (
        <Line>
          Says it reads your {itemsWord} and their comments: {preflight.readsItems.join(", ")}. That is what the author declared, not a limit EO
          enforces.
        </Line>
      ) : null}
      {preflight.postsComments.length > 0 ? (
        <Line>
          Says it comments on your {itemsWord}: {preflight.postsComments.join(", ")}. Comments are mirrored to Jira, and each run is capped at a few
          of them.
        </Line>
      ) : null}
      {preflight.attachesFiles.length > 0 ? (
        <Line>
          Says it attaches files to your {itemsWord}: {preflight.attachesFiles.join(", ")}. The files come from the directory the step runs in, and
          are uploaded to Jira from anything mirrored there.
        </Line>
      ) : null}
      {preflight.createsItems.length > 0 ? (
        <Line>
          Says it creates {itemsWord}: {preflight.createsItems.join(", ")}. Each one goes straight onto a pipeline of the same project with nobody
          accepting it first, and a run is capped at ten.
        </Line>
      ) : null}
      {/* Invariant #11 at the gate (EO-314): a refusal, not a need. */}
      {preflight.refusal !== null ? <Line tone="danger">{preflight.refusal}</Line> : null}
      {preflight.capabilities.length > 0 ? (
        <div className="text-ink-subtle">
          <p>What this pack can reach:</p>
          <ul className="ml-4 list-disc">
            {preflight.capabilities.map((capability) => (
              <li key={capability.server}>{capability.line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preflight.connectors
        .filter((connector) => !connector.connected)
        .map((connector) => (
          <Line key={`connector-${connector.slug}`} tone="paused">
            {connector.label} is not connected here{connector.description === "" ? "" : ` — the pack ${connector.description}`}. It arrives
            disconnected; connect it under Settings.
          </Line>
        ))}
      {preflight.itemTypes.length > 0 ? (
        <Line>
          Brings the item {preflight.itemTypes.length === 1 ? "type" : "types"} {preflight.itemTypes.map((type) => type.label).join(", ")}
          {present.length > 0
            ? `. You already have ${present.map((type) => type.label).join(", ")}, which ${present.length === 1 ? "is" : "are"} kept as ${
                present.length === 1 ? "it is" : "they are"
              }.`
            : "."}
        </Line>
      ) : null}
      {preflight.itemTypes.map((type) =>
        type.conflict === null ? null : (
          <Line key={`type-${type.type}`} tone="paused">
            {type.conflict}
          </Line>
        ),
      )}
      {preflight.roleSlots.length > 0 ? (
        <Line>
          Needs {preflight.roleSlots.length === 1 ? "an agent in the role" : "agents in the roles"} {preflight.roleSlots.map((slot) => slot.slug).join(", ")}
          {preflight.roleSlots.some((slot) => slot.carriesPrompt)
            ? `, and carries the prompt for ${preflight.roleSlots
                .filter((slot) => slot.carriesPrompt)
                .map((slot) => slot.slug)
                .join(", ")}`
            : ""}
          . A role this machine has nobody in arrives as an agent carrying that prompt; one you already have is left alone.
        </Line>
      ) : null}
      {preflight.roleSlots
        .filter((slot) => !slot.filled && slot.recommendedBackend !== null)
        .map((slot) => (
          <Line key={`backend-${slot.slug}`} tone={slot.backendSignedIn === false ? "paused" : "plain"}>
            {slot.slug} was built on {slot.recommendedBackend}
            {slot.recommendedModel === null ? "" : ` (${slot.recommendedModel})`}
            {slot.backendSignedIn === false
              ? ", which you are not signed in to — the agent arrives with no backend until you pick one."
              : ", which is a recommendation rather than a requirement."}
          </Line>
        ))}
      {unfilled.length > 0 ? (
        <Line tone="paused">
          No agent here is in {unfilled.map((slot) => slot.slug).join(", ")}, so those steps will not dispatch until one is.
        </Line>
      ) : null}
      {preflight.oldNames.map((entry) => (
        <Line key={`old-${entry.where}`} tone={aliasesRetired ? "danger" : "paused"}>
          <span className="text-ink">{entry.where}</span> {aliasNotice("pack", aliasesRetired)}:{" "}
          {entry.names.map((name) => `${name.deprecated} → ${name.replacement}`).join(", ")}.
        </Line>
      ))}
      {/* Values that only hold on the machine the pack was written on
          (EO-451), read here because nobody standing here wrote them.
          Advice: the buttons below are the same with or without them. */}
      {preflight.machineSpecific.length > 0 ? (
        <Line tone="paused">
          Some of this looks like it only holds on the machine it was written on, and may not work here. This is a read of the text, and
          advice: nothing about the import changes because of it.
        </Line>
      ) : null}
      {preflight.machineSpecific.map((entry, index) => (
        <Line key={`machine-${index}-${entry.where}`}>
          <span className="text-ink">{entry.where}</span>:{" "}
          {entry.warnings.map((warning, at) => (
            <span key={`${at}-${warning.text}`}>
              {at > 0 ? "; " : ""}
              {describeMachineSpecificPlace(warning.where)} <code className="font-mono">{warning.text}</code> — {warning.instead}
            </span>
          ))}
          .
        </Line>
      ))}
    </div>
  );
}

export function Line({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "paused" | "danger" }) {
  return <p className={cn(tone === "paused" ? "text-paused" : tone === "danger" ? "text-danger" : "text-ink-subtle")}>{children}</p>;
}
