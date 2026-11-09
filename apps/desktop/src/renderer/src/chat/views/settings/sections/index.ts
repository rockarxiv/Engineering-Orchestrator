import type { ComponentType } from "react";
import { GeneralSection } from "./GeneralSection";
import { LayoutSection } from "./LayoutSection";
import { ProjectsSection } from "./ProjectsSection";
import { WorkspacesSection } from "./WorkspacesSection";
import { WorktreesSection } from "./WorktreesSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { ModulesSection } from "./ModulesSection";
import { PeopleSection } from "./PeopleSection";
import { PolicySection } from "./PolicySection";
import { PublishingSection } from "./PublishingSection";
import { OrganisationSection } from "./OrganisationSection";
import { McpSection } from "./McpSection";
import { RepositoryIntelligenceSection } from "./RepositoryIntelligenceSection";
import { GuardrailsSection } from "./GuardrailsSection";
import { ArchiveSection } from "./ArchiveSection";
import { DebugSection } from "./DebugSection";
import { UpdatesSection } from "./UpdatesSection";

export interface SettingsSectionDef {
  id: string;
  label: string;
  /** Drawn only where there is a machine: a server refuses the channels behind it (EO-319). */
  machine?: boolean;
  /** Drawn only for an administrator reading an organisation's record (EO-329). */
  organisation?: boolean;
  /** Not drawn where EO is updated by hand from the release page — macOS (EO-698). */
  installsUpdates?: boolean;
  Component: ComponentType;
}

/** Settings' sections, in order, under the ids they have always had, so `?section=` links keep working. */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: "general", label: "General", Component: GeneralSection },
  { id: "layout", label: "Colours", Component: LayoutSection },
  { id: "projects", label: "Projects", Component: ProjectsSection },
  { id: "workspaces", label: "Workspaces", Component: WorkspacesSection },
  { id: "worktrees", label: "Git & worktrees", machine: true, Component: WorktreesSection },
  { id: "connectors", label: "Connectors", Component: ConnectorsSection },
  { id: "modules", label: "Modules", Component: ModulesSection },
  { id: "people", label: "People", Component: PeopleSection },
  { id: "policy", label: "Policy", Component: PolicySection },
  { id: "publishing", label: "Publishing", organisation: true, Component: PublishingSection },
  { id: "organisation", label: "Organisation", machine: true, Component: OrganisationSection },
  { id: "mcp", label: "MCP server", machine: true, Component: McpSection },
  { id: "repositoryIntelligence", label: "Repository Intelligence", Component: RepositoryIntelligenceSection },
  { id: "guardrails", label: "Guardrails", Component: GuardrailsSection },
  { id: "archive", label: "Archive", Component: ArchiveSection },
  // Debug mode (EO-392). Machine-only: what it records is what this desktop hands its backends.
  { id: "debug", label: "Debug", machine: true, Component: DebugSection },
  { id: "updates", label: "Updates", machine: true, installsUpdates: true, Component: UpdatesSection },
];
