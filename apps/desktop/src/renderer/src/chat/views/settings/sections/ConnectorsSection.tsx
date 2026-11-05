import { ConnectorNeeds } from "../../../connectors/ConnectorNeeds";
import { ManagedLockLine } from "../../../managed/ManagedSection";
import { CardSection } from "../../../kit";
import { JiraConnectionsPanel, JiraMirrorPanel, JiraSyncPanel } from "../org/JiraPanels";

/**
 * Settings → Connectors (EO-315, ARCHITECTURE.md, "A connector is an MCP server with a setup
 * flow").
 *
 * The pack-shipped connectors first — what somebody came here for — and
 * then Jira's own three cards, which are one particular connection with a
 * screenful of settings behind it.
 *
 * The list is `ConnectorNeeds` with no role: every connector this
 * installation has. The step editor draws the same component narrowed to
 * one role, so the two cannot come to disagree about whether a line is red.
 */
export function ConnectorsSection() {
  return (
    <>
      <CardSection
        title="Connectors"
        description="What the agents on your steps can reach, and what each one still needs. Connecting one stores its values in your OS keychain, never in EO's database."
      >
        {/*
          The line and **not** a fence (EO-329, ARCHITECTURE.md, "Publish, lock and versions"). What
          a published
          connectors section locks is the catalogue; connecting one is
          signing in with your own account, and "your sign-ins … are
          yours" would be false if this disabled its Connect buttons.
        */}
        <ManagedLockLine section="connectors" />
        <ConnectorNeeds role={null} empty="No pack on this installation ships a connector yet." />
      </CardSection>
      <JiraConnectionsPanel />
      <JiraMirrorPanel />
      <JiraSyncPanel />
    </>
  );
}
