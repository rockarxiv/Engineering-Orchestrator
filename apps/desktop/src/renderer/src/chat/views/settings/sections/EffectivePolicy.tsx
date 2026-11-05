import { useQuery } from "@tanstack/react-query";
import { ipcQuery } from "../../../../query/client";
import { agentsKey, usePipelines } from "../../../../query/hooks";
import { useRepositories } from "../../../../query/useRepositories";
import { Card, Facts, GroupLabel } from "../../../kit";

/**
 * The rail beside Settings: what this installation adds up to — its
 * repositories, its pipelines and its live agents.
 *
 * No loading line: a count that has not arrived reads as a dash, and the
 * rail never puts a status beside the section a person is working in.
 */
export function EffectivePolicy() {
  const { repositories, isLoading: repositoriesLoading } = useRepositories();
  const { pipelines, isLoading: pipelinesLoading } = usePipelines(null);
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  // Live ones: an archived agent is kept for the record and is not one
  // this installation has (EO-186).
  const live = agents.data ? agents.data.agents.filter((agent) => agent.archivedAt === null).length : null;
  const count = (value: number | null) => <span className="font-mono tabular-nums">{value === null ? "—" : value}</span>;

  return (
    <Card className="gap-2.5">
      <GroupLabel>Effective policy</GroupLabel>
      <Facts
        items={[
          { term: "Repositories", value: count(repositoriesLoading ? null : repositories.length) },
          { term: "Pipelines", value: count(pipelinesLoading ? null : pipelines.length) },
          { term: "Agents", value: count(live) },
        ]}
      />
    </Card>
  );
}
