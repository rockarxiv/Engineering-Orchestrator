import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { Link } from "react-router-dom";
import { machineAvailable } from "../../../ipc/bridge";
import { ipcQuery } from "../../../query/client";
import { mcpServersKey, skillsKey } from "../../../query/hooks";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { ManagedSection } from "../../managed/ManagedSection";
import { Notice, Tabs, ViewHeader } from "../../kit";
import { ServersPanel } from "./ServersPanel";
import { SkillsPanel } from "./SkillsPanel";

/**
 * Agent tools (`/agent-tools`) — the two catalogues an agent's tool
 * surface is drawn from (EO-109), drawn in the chat layout's own terms.
 *
 * Not Settings → MCP server, which points the other way (EO serving its
 * tools to another program); the view says so where somebody who took a
 * wrong turn is standing.
 *
 * Publishes what the classic screen publishes: the tab here, and each
 * catalogue its own Show archived beside it, merged by `ViewPublisher`.
 */

type Tab = "servers" | "skills";

export function AgentToolsView() {
  const [tab, setTab] = useState<Tab>("servers");

  // Which catalogue is on screen (EO-192): "add this one" means a different act on each.
  useViewParameters({ filter: { text: "", facets: { tab } } });

  // For the tab counts only; the panels read the same keys from the cache.
  const servers = useQuery({ queryKey: mcpServersKey, queryFn: () => ipcQuery("mcpServers:list", { includeArchived: true }) });
  const skills = useQuery({ queryKey: skillsKey, queryFn: () => ipcQuery("skills:list", { includeArchived: true }) });
  const liveServers = (servers.data?.servers ?? []).filter((server) => server.archivedAt === null).length;
  const liveSkills = (skills.data?.skills ?? []).filter((skill) => skill.archivedAt === null).length;

  return (
    <div className="@container flex min-w-0 flex-col">
      <ViewHeader
        icon={<Plug size={15} />}
        title="Agent tools"
        meta="MCP servers and skills your agents are given. Define one here, then tick which agents get it — an agent has nothing from this screen until you do."
      >
        <Notice>
          <p>
            This is not{" "}
            {/* A link only where the section exists: it is this machine's, and an organisation server has none. */}
            {machineAvailable() ? (
              <Link to="/settings?section=mcp" className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                Settings → MCP server
              </Link>
            ) : (
              "Settings → MCP server"
            )}
            . That one points the other way: it lets another program drive EO. This one is what EO hands to the agents it dispatches.
          </p>
        </Notice>
        <Tabs
          label="Agent tools"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "servers", label: "MCP servers", count: liveServers },
            { value: "skills", label: "Skills", count: liveSkills },
          ]}
        />
      </ViewHeader>

      {/*
        Only one of the two catalogues is a section to lock (EO-329, ARCHITECTURE.md, "Publish, lock
        and versions").
        A skill arrives with a pack, so the packs section fences the Skills
        tab — and only that tab. The servers are policy's, said a row at a
        time: a published row cannot be edited or archived, and everything
        else stays the person's.
      */}
      {tab === "servers" ? (
        <ServersPanel />
      ) : (
        <ManagedSection section="packs">
          <SkillsPanel />
        </ManagedSection>
      )}
    </div>
  );
}
