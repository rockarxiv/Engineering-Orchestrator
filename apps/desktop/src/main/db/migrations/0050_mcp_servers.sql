-- The catalogue of MCP servers a person added (EO-104).
--
-- EO injects exactly one MCP server into every agent it dispatches --
-- `eo`, hardcoded into both provider adapters -- so somebody who wants
-- their reviewer to reach GitHub has nowhere to put it. This is where
-- that goes. Nothing here reaches an agent yet: attachment is EO-106 and
-- delivery is EO-107/EO-108.
--
-- The columns are flat rather than one `config` blob, because the two
-- transports are answered by different halves of this row and a query
-- that wants "every stdio server" should not have to parse JSON to find
-- them. What keeps the halves from being mixed is not the table -- SQLite
-- cannot express "command xor url" without a CHECK nobody would read --
-- but `readMcpServerDraft` in packages/core, which every write goes
-- through and which returns a sentence rather than throwing.
--
-- What is deliberately absent is any secret. `env_names` holds the
-- *names* of the environment variables a server needs; the values are
-- encrypted by the OS keychain and written under `userData`, the same
-- arrangement the Jira token and a module's secrets have, and never here
-- (ARCHITECTURE.md, "Secrets"). Header values sit in this table as typed: a header
-- that needs a secret is written `Bearer ${TOKEN}` and interpolated at
-- spawn, so what is stored is the name and not the value.
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	-- Lowercase, and an identifier rather than a label: this is the key
	-- under `mcpServers` in a generated configuration and the middle of
	-- every tool id the model sees (`mcp__github__create_issue`).
	-- `eo` is refused at save time -- it is EO's own server's name, and a
	-- second entry carrying it would shadow the one thing every agent is
	-- guaranteed to have.
	`name` text NOT NULL,
	-- stdio | http | sse
	`transport` text NOT NULL,
	-- stdio only. Arbitrary local code, and knowingly so: the person
	-- adding the server is the person at risk, EO is a single-user desktop
	-- app, and a gate between someone and a field they typed themselves
	-- buys nothing.
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	-- http and sse only.
	`url` text,
	`headers` text DEFAULT '{}' NOT NULL,
	-- Names only. See the note above.
	`env_names` text DEFAULT '[]' NOT NULL,
	-- Whether the server is offered at all. Distinct from archived:
	-- disabled is a switch somebody flips while working out whether a
	-- server behaves, archived is being done with it.
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	-- Archived rather than deleted, for the reason `modules.archived_at`
	-- gives: something that used it still points at it, and asking for a
	-- server to be gone is not asking for what it did to be rewritten
	-- (invariant #3).
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);
