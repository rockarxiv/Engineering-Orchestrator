import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ipcQuery } from "../../query/client";

/** What a project's thread is called where a person meets it (EO-471). */
export const PROJECT_NOTES_LABEL = "Project notes";

/**
 * Opens a project's thread in the ordinary item view (EO-471,
 * ARCHITECTURE.md, "One channel").
 *
 * The thread is made the first time it is asked for, by whichever record
 * owns the project, so opening it is a request rather than a link: the
 * answer is the item to open, or the sentence saying why there is none.
 * Shared by both layouts' project settings, which differ in how they
 * draw the button and not in what it does.
 */
export function useOpenProjectNotes(onProblem: (problem: string | null) => void) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (projectId: string) => ipcQuery("projects:thread", { projectId }),
    onSuccess: (result) => {
      if (result.itemId === null) {
        onProblem(result.problem ?? "EO could not open this project's notes.");
        return;
      }
      onProblem(null);
      void navigate(`/items/${result.itemId}`);
    },
    onError: (error) => onProblem(error.message),
  });
}
