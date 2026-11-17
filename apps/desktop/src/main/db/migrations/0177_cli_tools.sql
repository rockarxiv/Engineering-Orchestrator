-- Command-line tools, the third catalogue beside MCP servers and skills
-- (EO-819). A row is a program installed on the machine -- the command an
-- agent types and what it is for here -- and grants nothing: no
-- allowedTools entry, no sandbox change. `command` is unique, so the
-- prompt never names one program twice. Archived rows are kept so an
-- attachment still points at something a person can read.
--
-- `agent_cli_tools` is the join to agents, the sibling of
-- `agent_mcp_servers` and `agent_skills`, and goes with either side.
CREATE TABLE `cli_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_tools_command_unique` ON `cli_tools` (`command`);
--> statement-breakpoint
CREATE TABLE `agent_cli_tools` (
	`agent_id` text NOT NULL,
	`cli_tool_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `cli_tool_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cli_tool_id`) REFERENCES `cli_tools`(`id`) ON UPDATE no action ON DELETE cascade
);
