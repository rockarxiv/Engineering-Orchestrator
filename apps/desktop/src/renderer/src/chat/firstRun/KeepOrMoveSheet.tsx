import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MOVE_IS_ONE_WAY_LINE } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { projectsKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { Button, ErrorLine, Segmented } from "../kit";
import { useChatPalette } from "../theme";

/**
 * "You have 2 local projects · keep local / move to the record"
 * (EO-325, the original design).
 *
 * The one screen the design asked for. A solo person with projects and
 * items mid-flight signs in to a server and, in the first draft, was
 * told nothing at all about what became of them — which in a product
 * that syncs is the difference between "my work is mine" and "my work
 * is my employer's", decided for somebody without their being asked.
 *
 * ### The default is keep, and the default is what silence means
 *
 * Every row starts on "Keep on this machine", and closing the sheet
 * without touching a row keeps everything. That is not politeness: the
 * alternative is a person's work arriving on their organisation's
 * server because they were slow to read a dialog, and there is no way
 * back from it. "Move to the record" is deliberately the deliberate
 * choice.
 *
 * ### Why it has no dismiss
 *
 * It is not modal about *work* — the board underneath is untouched and
 * every project on it goes on running exactly as it did — but it is the
 * only place these two answers are offered, and a sheet with an X in
 * the corner would be a sheet most people close. "Keep them here" is
 * the way out, and it is one press and reversible.
 *
 * ### Why there is no "have I shown this" flag
 *
 * Because the list *is* the state. `projects:undecided` answers with
 * the projects that have neither answer, which is empty on a solo
 * desktop and empty again once every row has been decided. A flag would
 * be a second account of the same thing and could disagree with it —
 * either nagging somebody who has answered or, worse, never appearing
 * for somebody who has not.
 *
 * ### Why it is not the kit's `Dialog`
 *
 * Drawn in the chat layout's look (EO-527), from the kit's controls and
 * in its dialog's shape — but not as that `Dialog`, which closes on
 * Escape, on the scrim and on its X, and this sheet has no dismiss
 * (above). Its colours are this device's chat theme set on the sheet
 * itself (`useChatPalette`) rather than on the document: it is drawn
 * over a window, and a sheet that repainted the board behind it would
 * be changing somebody's window to ask them a question.
 */
export function KeepOrMoveSheet() {
  const queryClient = useQueryClient();
  const undecided = useQuery({ queryKey: undecidedKey, queryFn: () => ipcQuery("projects:undecided", undefined) });
  useInvalidateOnPush("config:changed", undecidedKey);

  /** Which rows the person has switched to "move". Everything else is kept. */
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<readonly string[]>([]);
  const palette = useChatPalette();

  const apply = useMutation({
    mutationFn: async (projects: readonly { id: string; name: string }[]) => {
      const said: string[] = [];
      // One at a time and in order, because a move is a long ordered
      // conversation with the record and two at once would interleave
      // two projects' pages over one connection.
      for (const project of projects) {
        if (!moving.has(project.id)) {
          const kept = await ipcQuery("projects:keepLocal", { projectId: project.id });
          if (kept.problem !== null) said.push(`${project.name}: ${kept.problem}`);
          continue;
        }
        // A move either took everything or it is a failure with a
        // reason, and there is no third answer for a screen to have to
        // explain. The record's own account of what it could not write
        // arrives inside that reason — see `RecordAdoptCountsSchema`,
        // where the earlier arrangement and what it cost are written
        // down. The project is untouched either way, so a person who
        // reads the line can simply press the button again.
        const answer = await ipcQuery("projects:moveToRecord", { projectId: project.id });
        if (answer.problem !== null) said.push(`${project.name}: ${answer.problem}`);
      }
      return said;
    },
    onSuccess: (said) => {
      setProblems(said);
      void queryClient.invalidateQueries({ queryKey: undecidedKey });
      void queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });

  const projects = undecided.data?.projects ?? [];
  if (projects.length === 0) return null;

  const count = projects.length;
  const movingCount = projects.filter((project) => moving.has(project.id)).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your local projects"
      style={palette}
      className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-6"
    >
      <div aria-hidden className="absolute inset-0 bg-scrim" />
      <div className="relative flex max-h-full w-[36rem] max-w-full flex-col gap-4 overflow-y-auto rounded-[16px] bg-canvas-subtle p-5 text-ink shadow-panel">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-ink">
            You have {count} local {count === 1 ? "project" : "projects"}
          </h2>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">{undecided.data?.line}</p>
        </div>

        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-[12px] bg-canvas px-3.5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate text-[13px] text-ink">{project.name}</p>
                <p className="text-[11.5px] text-ink-subtle">
                  {project.keyPrefix} · {project.itemCount} {project.itemCount === 1 ? "item" : "items"}
                </p>
              </div>
              <Segmented
                label={`Where ${project.name} goes`}
                size="sm"
                value={moving.has(project.id) ? "move" : "keep"}
                options={(
                  [
                    { value: "keep", label: "Keep on this machine" },
                    { value: "move", label: "Move to the record" },
                  ] as const
                ).map((choice) => ({
                  value: choice.value,
                  // The project's name is part of each choice's name, so
                  // a screen reader on a list of them says whose it is.
                  label: (
                    <>
                      {/* The space ends the visible words rather than
                          starting the hidden ones: a name is computed
                          per element, trimmed, and would run together. */}
                      {`${choice.label} `}
                      <span className="sr-only">— {project.name}</span>
                    </>
                  ),
                }))}
                onChange={(value) =>
                  setMoving((current) => {
                    const next = new Set(current);
                    if (value === "move") next.add(project.id);
                    else next.delete(project.id);
                    return next;
                  })
                }
              />
            </li>
          ))}
        </ul>

        {/* Said whether or not anybody has chosen to move one, because
            it is the thing to know *before* choosing rather than after.
            One wording, from `core`, shared with the settings screen. */}
        <p className="text-[12.5px] leading-relaxed text-ink-subtle">{MOVE_IS_ONE_WAY_LINE}</p>

        {problems.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="What EO could not do">
            {problems.map((problem) => (
              <li key={problem}>
                <ErrorLine>{problem}</ErrorLine>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex justify-end">
          <Button variant="primary" disabled={apply.isPending} onClick={() => apply.mutate(projects.map((project) => ({ id: project.id, name: project.name })))}>
            {apply.isPending
              ? "Working…"
              : movingCount === 0
                ? "Keep them here"
                : `Move ${String(movingCount)} and keep the rest`}
          </Button>
        </div>
      </div>
    </div>
  );
}

const undecidedKey = ["projects", "undecided"] as const;
