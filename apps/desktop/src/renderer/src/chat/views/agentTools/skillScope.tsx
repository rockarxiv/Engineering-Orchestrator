import { useScopedSkills, type ScopeOption, type ScopeSubject } from "../../../shared/agentTools/skillScope";

/**
 * A skill's scope in the chat layout's own terms (EO-470).
 *
 * What a scope means, how it is spelled as a picker value and which
 * skills a project or a workspace lists are the app's
 * (`shared/agentTools/skillScope`) and shared with the classic layout; only the
 * drawing is here, because the chat layout draws nothing of the classic
 * one's (`noClassicUi.test.ts`).
 */

/** The picker's options as `<option>`s in three groups, for the kit's `Select`. */
export function ScopeOptions({ options }: { options: ScopeOption[] }) {
  const of = (group: ScopeOption["group"]) => options.filter((option) => option.group === group);
  const list = (group: ScopeOption["group"]) =>
    of(group).map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));
  return (
    <>
      {list("global")}
      {of("project").length > 0 ? <optgroup label="Only runs on a project">{list("project")}</optgroup> : null}
      {of("workspace").length > 0 ? <optgroup label="Only runs whose step works in a workspace">{list("workspace")}</optgroup> : null}
    </>
  );
}

/** Under a project or a workspace in settings: the skills scoped to it, or a sentence saying there are none. */
export function ScopedSkillsLine({ subject }: { subject: ScopeSubject }) {
  const skills = useScopedSkills(subject);
  const where = subject.kind === "project" ? "this project" : "this workspace";
  return (
    <p className="text-[11.5px] leading-snug text-ink-subtle" aria-label={`Skills scoped to ${where}`}>
      {skills.length === 0 ? (
        `No skills are scoped to ${where}. Scope one under Skills to deliver it only to runs here.`
      ) : (
        <>
          Skills scoped to {where}:{" "}
          {skills.map((skill, index) => (
            <span key={skill.id}>
              {index > 0 ? ", " : ""}
              <span className="text-ink">{skill.name}</span>
              {skill.enabled ? "" : " (disabled)"}
            </span>
          ))}
        </>
      )}
    </p>
  );
}
