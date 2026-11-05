import { useState } from "react";
import { useChromeVocabulary } from "../../../query/hooks";
import { Button, Chip, GroupLabel, Switch, TextInput } from "../../kit";
import { RefText } from "../items/ItemReference";
import { StatusLine } from "./parts";

/**
 * Attaching an item to a Jira issue, moving it, letting it go, and
 * switching what it says — from the app (EO-125, EO-126).
 *
 * The other door onto `items:update`, the one an agent's update tool comes in
 * by, so a person and an agent are told the same refusals by the same
 * handler. A refused key stays in the box to be corrected; the row above
 * it goes on naming the key the item actually holds. Nothing here calls
 * Jira: attaching is a local write.
 *
 * Keyed by the caller on the stored key, so attaching, moving or
 * detaching resets it to what the item now says.
 */
export function JiraLink({
  jiraKey,
  jiraSync,
  isContainer,
  busy,
  problem,
  onLink,
  onSync,
  onCancel,
}: {
  jiraKey: string | null;
  jiraSync: boolean;
  isContainer: boolean;
  busy: boolean;
  problem: string | null;
  onLink: (key: string | null) => void;
  onSync: (enabled: boolean) => void;
  onCancel: () => void;
}) {
  const vocabulary = useChromeVocabulary();
  // An unattached item opens on the box: there is no key to read, and
  // the point of the row is somewhere to type one.
  const [editing, setEditing] = useState(jiraKey === null);
  const [draft, setDraft] = useState(jiraKey ?? "");
  const trimmed = draft.trim();
  const sendable = trimmed !== "" && trimmed !== jiraKey;
  const send = (): void => {
    if (busy || !sendable) return;
    onLink(trimmed);
  };

  const word = vocabulary.item.toLowerCase();
  const explanation = jiraSync
    ? jiraKey === null
      ? "Nothing is mirrored until an issue key is attached."
      : `Status, comments and attachments are pushed to ${jiraKey}. Attaching reads the issue in on its own; Sync now asks for it again.`
    : jiraKey === null
      ? `Sync is off: this ${word} is neither pushed to Jira nor pulled from it.`
      : `Sync is off: nothing reaches ${jiraKey} and nothing comes back. The key stays attached, so switching sync on resumes against the same issue.`;

  return (
    <section aria-label="Jira" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
      <GroupLabel>Jira</GroupLabel>
      {jiraKey !== null ? (
        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="min-w-0 truncate font-mono text-ink" title={jiraKey}>
            {jiraKey}
          </span>
          {jiraSync ? null : <Chip tone="paused">Not syncing</Chip>}
        </span>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <TextInput
            aria-label="Jira issue key"
            placeholder="KAN-123"
            value={draft}
            disabled={busy}
            className="font-mono"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              send();
            }}
          />
          <span className="flex flex-wrap gap-1">
            {/* "issue", because the composer's Attach is about files. */}
            <Button size="sm" variant="secondary" disabled={busy || !sendable} onClick={send}>
              {jiraKey === null ? "Attach issue" : "Move issue"}
            </Button>
            {jiraKey !== null ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(jiraKey);
                  setEditing(false);
                  onCancel();
                }}
              >
                Cancel
              </Button>
            ) : null}
          </span>
        </div>
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} title={`Stop mirroring ${jiraKey ?? ""} and drop its queued pushes`} onClick={() => onLink(null)}>
            Detach
          </Button>
        </span>
      )}

      {problem ? (
        <StatusLine tone="danger">
          <RefText>{problem}</RefText>
        </StatusLine>
      ) : null}

      {/* Refused with no key attached: a preference stored against no
          issue is a setting nobody can see the effect of. */}
      <Switch
        label="Sync with Jira"
        checked={jiraSync}
        disabled={busy || jiraKey === null}
        onChange={(next) => onSync(next)}
        description={`${explanation}${isContainer ? ` Switching it here changes everything under this ${word} too.` : ""}`}
      />
    </section>
  );
}
