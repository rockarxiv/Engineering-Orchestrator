import { REPOSITORY_MCP_SERVER_NAME } from "@eo/core";
import type { PackConnector } from "../pack.js";

/**
 * The developer pack's own connector (EO-315,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * One, and it is the repository intelligence server EO injects into a
 * dispatch whose item has an index. It is here so that the reach list on
 * a step reads the same for everyone: a support pack's board shows
 * "Zendesk — reads and replies to your tickets" and a developer's board
 * would otherwise show an empty list beside a step that plainly does
 * reach something. A line that says what the step can already do costs
 * nothing and is the difference between a list and a hole.
 *
 * **Setup `none`, and that is the honest kind rather than a placeholder.**
 * There is nothing for a person to paste and nobody to sign in to: the
 * server is a local index EO builds from the checkout, and whether it is
 * *there* is a fact about the repository, answered by Settings →
 * Repository Intelligence, which owns the switch and the per-repository
 * statuses. Colouring this line red on a project with no index would put
 * a Connect button in front of a flow that does not exist, which is the
 * "control that does nothing" invariant 12 rules out for a person as
 * firmly as for an agent.
 *
 * **What it reaches is not written here.** `EO_SERVER_CAPABILITIES` in
 * `packages/core` already says what EO's own two servers do, in the
 * words the import gate shows (EO-314), and the reach list reads the
 * same table. A second sentence here would be a second thing to keep
 * true about one server.
 *
 * Named by `REPOSITORY_MCP_SERVER_NAME` rather than by the string, so
 * the setup and the registration cannot drift apart — the same reason
 * the reservation itself lives in `packages/core` beside the name.
 */
export const developerConnectors: readonly PackConnector[] = [
  {
    serverName: REPOSITORY_MCP_SERVER_NAME,
    setup: { label: "Repository intelligence", kind: "none", secretNames: [], oauth: null },
  },
];
