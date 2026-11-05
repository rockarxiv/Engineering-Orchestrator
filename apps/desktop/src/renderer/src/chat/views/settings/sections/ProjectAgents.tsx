import { staffingLine, useProjectOwnAgents, useProjectStaffing } from "../../../../shared/agents/agentScope";

/**
 * Under a project in the chat layout's settings: its own agents, and for
 * each role its pipelines use, who will be dispatched (EO-475). What is
 * said is the app's (`shared/agents/agentScope`), shared with the classic
 * layout; only the drawing is here.
 */
export function ProjectAgents({ projectId }: { projectId: string }) {
  const own = useProjectOwnAgents(projectId);
  const staffing = useProjectStaffing(projectId);
  const roles = staffing.data?.roles ?? [];

  return (
    <div aria-label="This project's agents" className="flex flex-col gap-1 text-[11.5px] leading-snug text-ink-subtle">
      <p aria-label="Agents of this project's own">
        {own.length === 0 ? (
          "No agents of its own: its work goes to the global agents. Customise one for this project under Agents."
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
      {roles.length > 0 ? (
        <ul aria-label="Who is dispatched, by role" className="flex flex-col gap-0.5">
          {roles.map((entry) => (
            <li key={entry.role} aria-label={entry.role}>
              <span className="font-mono">{entry.role}</span> → <span className={entry.from === "nobody" ? "text-danger" : "text-ink"}>{staffingLine(entry)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
