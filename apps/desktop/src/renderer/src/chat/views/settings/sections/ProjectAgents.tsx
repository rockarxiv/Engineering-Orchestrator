import { staffingLine, useProjectOwnAgents, useProjectStaffing } from "../../../../shared/agents/agentScope";

/**
 * Under a project in the chat layout's settings: its own agents, and for
 * each agent step of its pipelines, the agent the step names (EO-475,
 * EO-876) — read from the step, never from a staffing rule. What is said
 * is the app's (`shared/agents/agentScope`); only the drawing is here.
 */
export function ProjectAgents({ projectId }: { projectId: string }) {
  const own = useProjectOwnAgents(projectId);
  const staffing = useProjectStaffing(projectId);
  const steps = staffing.data?.steps ?? [];

  return (
    <div aria-label="This project's agents" className="flex flex-col gap-1 text-[11.5px] leading-snug text-ink-subtle">
      <p aria-label="Agents of this project's own">
        {own.length === 0 ? (
          "No agents of its own: its steps name global agents. Customise one for this project under Agents."
        ) : (
          <>
            This project&apos;s own agents:{" "}
            {own.map((agent, index) => (
              <span key={agent.id}>
                {index > 0 ? ", " : ""}
                <span className="text-ink">{agent.name}</span> ({agent.role}
                {agent.enabled ? "" : ", disabled"})
              </span>
            ))}
          </>
        )}
      </p>
      {staffing.error ? <p className="text-danger">{staffing.error.message}</p> : null}
      {steps.length > 0 ? (
        <ul aria-label="Who runs each step" className="flex flex-col gap-0.5">
          {steps.map((entry) => (
            <li key={entry.stepId} aria-label={`${entry.pipelineName} · ${entry.stepName}`}>
              {entry.pipelineName} · <span className="text-ink-muted">{entry.stepName}</span> →{" "}
              <span className={entry.problem === null ? "text-ink" : "text-danger"}>{staffingLine(entry)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
