import type { PackTemplate } from "@eo/core";

/**
 * EO's brief for the first item of a template with no job (EO-664).
 *
 * A template that files work on a schedule ends first run on the item its
 * job files. One with no job has no first item to start, and the window
 * has no way to make one by hand: work arrives through a job or through
 * the assistant. So first run ends in an assistant chat whose first
 * message is this, and the person goes on from it straight into the
 * conversation that files real work.
 *
 * Read by the assistant and by the person both — it is the chat's first
 * message — so it names the project and the pipeline in words, and asks
 * the template's own question for its first item. A template that brings
 * no question is asked about in its own title and description.
 *
 * The first line is what the chat is listed by before anybody has said
 * anything in it, so it is kept short enough to be listed whole.
 */
export function firstItemBrief(input: {
  template: Pick<PackTemplate, "title" | "description" | "openingQuestion">;
  project: { id: string; name: string };
  pipeline: { id: string; name: string };
}): string {
  const { template, project, pipeline } = input;
  const question = openingQuestionOf(template);
  return [
    `Help the person file the first piece of work for ${project.name}.`,
    "",
    `- Project: ${project.name} (id: ${project.id})`,
    `- Pipeline: ${pipeline.name} (id: ${pipeline.id}), set up just now from the template "${template.title}"`,
    "",
    "Open by asking them this, in your own words if they read better, and nothing else yet:",
    "",
    `> ${question}`,
    "",
    `Ask whatever else you need to know, then propose that first piece of work with \`pipeline\` set to "${pipeline.name}". ` +
      "Nothing is filed until they approve it.",
  ].join("\n");
}

/** The template's own question, or one built from what it says about itself. */
export function openingQuestionOf(template: Pick<PackTemplate, "title" | "description" | "openingQuestion">): string {
  const own = template.openingQuestion?.trim() ?? "";
  if (own !== "") return own;
  return `${template.title}: ${template.description.trim()} What is the first piece of work you want it to take on?`;
}
