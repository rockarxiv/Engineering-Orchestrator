import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipcQuery } from "../../../../query/client";
import { settingsKey } from "../../../../query/hooks";
import { withArticleCapital } from "../../../parts";
import { CardSection, ErrorLine, Field, LinkButton, Loading } from "../../../kit";
import { DraftInput } from "../core/draftInput";
import { NotedField } from "../core/fields";
import { useItemWords } from "../core/words";

/**
 * Settings → Archive: how long finished work stays on the project
 * (KAN-33).
 *
 * Blank means never — a setting that cannot be turned off eventually
 * surprises somebody — and `0` is a real value meaning "as soon as it is
 * done", which is why blank rather than zero is the off switch.
 */
export function ArchiveSection() {
  const queryClient = useQueryClient();
  const words = useItemWords();
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => ipcQuery("settings:get", undefined) });
  const save = useMutation({
    mutationFn: (archiveAfterDays: number | null) => ipcQuery("settings:set", { archiveAfterDays }),
    // The reply is the settings as stored, so it is drawn at once rather
    // than after a second read (EO-563); a refetch that left before the
    // write would otherwise land after it with the old number.
    onSuccess: async (next) => {
      await queryClient.cancelQueries({ queryKey: settingsKey });
      queryClient.setQueryData(settingsKey, next);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: settingsKey }),
  });

  const days = settings.data?.archiveAfterDays;

  return (
    <CardSection
      title="Archive"
      description={`Finished ${words.many} leave the project on their own. Nothing is deleted — the Archive keeps them.`}
      actions={<LinkButton to="/archive" variant="ghost" size="sm">Open the archive</LinkButton>}
    >
      {days === undefined ? (
        settings.isError ? (
          <ErrorLine>EO could not read its settings.</ErrorLine>
        ) : (
          <Loading />
        )
      ) : (
        <div className="max-w-[24rem]">
          <NotedField
            note={`Only counts time spent finished. ${withArticleCapital(words.one)} that is blocked or still in progress is never archived, however old it is.`}
          >
            <Field label="Archive after (days done, blank = never)">
              <DraftInput
                type="number"
                min={0}
                value={days === null ? "" : String(days)}
                onCommit={(raw) =>
                  save.mutateAsync(raw.trim() === "" ? null : Math.max(0, Number(raw))).then(
                    () => true,
                    () => false,
                  )
                }
              />
            </Field>
          </NotedField>
          {/* The box keeps what was typed when a save fails, so it must say so. */}
          {save.error ? <ErrorLine>Not saved: {save.error.message}</ErrorLine> : null}
        </div>
      )}
    </CardSection>
  );
}

