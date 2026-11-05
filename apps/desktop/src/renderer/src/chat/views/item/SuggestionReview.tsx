import { useQuery } from "@tanstack/react-query";
import { versionLabel } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { CardSection, Notice } from "../../kit";
import { VersionDiff } from "../changes/VersionDiff";

/**
 * A suggested change to a managed pipeline, as the admin deciding on it
 * reads it (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions"): the diff against what
 * is published, the needs list and the modules nobody here has approved.
 *
 * The buttons are not here — Approve and Send back are the step's own
 * results and the decision card offers them. Nothing at all on an item
 * that is not a suggestion: the channel answers null.
 */
export function SuggestionReview({ itemId }: { itemId: string }) {
  const answer = useQuery({ queryKey: ["suggestion", itemId], queryFn: () => ipcQuery("suggestions:detail", { itemId }) });
  const suggestion = answer.data?.suggestion ?? null;
  if (suggestion === null) return null;

  const against =
    suggestion.publishedVersion === null
      ? "This server has published no version of that pipeline, so there is nothing to compare it against."
      : `Against ${versionLabel(suggestion.publishedVersion)}, which is what is published now. Approving it publishes ${versionLabel(suggestion.publishedVersion + 1)}.`;

  return (
    <div className="flex flex-col gap-3" aria-label="The suggested change" role="group" data-testid="suggestion-review">
      <CardSection
        title={`Suggested change to “${suggestion.pipelineName}”`}
        description={
          <>
            {suggestion.author === null ? "" : `${suggestion.author} · `}
            {suggestion.basedOn === null ? "" : `based on ${versionLabel(suggestion.basedOn)} · `}
            {against}
          </>
        }
      >
        {/* Before the diff: it decides whether the buttons will work. */}
        {suggestion.problem === null ? null : (
          <Notice tone="danger" role="alert">
            {suggestion.problem}
          </Notice>
        )}
      </CardSection>

      {suggestion.diff === null ? null : <VersionDiff diff={suggestion.diff} />}

      {suggestion.needs.length === 0 ? null : (
        <CardSection title="What this needs">
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {suggestion.needs.map((need) => (
              <li key={need.key} className="text-ink-muted">
                <span className={need.met ? "text-ink-subtle" : "text-ink"}>{need.line}</span>
                {need.why === null ? null : <span className="text-[11.5px] text-ink-subtle"> — {need.why}</span>}
              </li>
            ))}
          </ul>
        </CardSection>
      )}

      {suggestion.unapprovedModules.length === 0 ? null : (
        <CardSection
          title="Modules nobody here has approved"
          description="A module is code from somebody else’s machine. EO runs none of it until somebody here has read it in Settings → Modules and said so — approving this change does not approve them."
        >
          <ul className="flex flex-col gap-1">
            {suggestion.unapprovedModules.map((name) => (
              <li key={name} className="font-mono text-[12px] text-ink">
                {name}
              </li>
            ))}
          </ul>
        </CardSection>
      )}
    </div>
  );
}
