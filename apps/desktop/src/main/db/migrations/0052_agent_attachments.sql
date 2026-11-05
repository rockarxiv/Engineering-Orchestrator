-- Attaching a catalogue entry to an agent (EO-106).
--
-- 0050 and 0051 landed two catalogues that reach nobody. This is the
-- join that carries them to an agent: a person defines an MCP server or
-- a skill once, and ticks which agents get it.
--
-- Keyed on the agent and not on the role name. Roles are configuration
-- (ARCHITECTURE.md, "An agent is a row") -- "the reviewer" is a row somebody can rename,
-- add a second of, or disable, so a table keyed on the word would point
-- at whichever of those happened last.
--
-- Two tables rather than one with a `kind` column. The two catalogues
-- are separate tables with separate lifecycles, and one join table would
-- have to give up its foreign key to hold rows pointing into both --
-- which is the single thing these tables are for: a tick that cannot
-- name something that is not there.
CREATE TABLE `agent_mcp_servers` (
	`agent_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `server_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Cascade is a backstop and not the ordinary path. A server a person is
-- done with is archived rather than deleted (invariant #3, and the note
-- on `mcp_servers.archived_at`), which is exactly so that an agent that
-- was given it still has something to point at -- the attachment stays
-- resolvable instead of dangling, and the screen can say "archived"
-- rather than showing a gap where a row used to be.
CREATE TABLE `agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- What the thread this run started was given, as a tool surface.
--
-- The sibling of `runs.instructions_hash` (0042), and for the same
-- reason spelled out there: neither backend re-sends configuration on
-- resume, so a resumed thread keeps the servers and skills it was born
-- with. Without this, attaching a GitHub server mid-ticket would appear
-- to work and silently do nothing until the thread happened to end.
--
-- A hash of the resolved *content* rather than of the ids: a renamed
-- command or an edited skill body changes what the agent can do while
-- every id stays the same. Never a secret -- the values live in the
-- keychain and the row holds only the variable names, and this is a
-- sha256 of the row's content besides.
--
-- Null on every row written before this column, and on builtin and
-- module runs, which have no agent. Unlike `instructions_hash`, null is
-- not the absence of an answer: nothing could be attached before this
-- migration, so a row that predates it had nothing attached. It is read
-- as the empty surface, and `findReusableThread` carries the argument.
ALTER TABLE `runs` ADD COLUMN `agent_attachments_hash` TEXT;
