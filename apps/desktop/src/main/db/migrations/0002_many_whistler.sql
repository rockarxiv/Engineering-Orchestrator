CREATE TABLE `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`thread_id` text,
	`worktree_path` text,
	`pid` integer,
	`attempt` integer DEFAULT 1 NOT NULL,
	`result` text,
	`error` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_cents` integer,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor` text NOT NULL,
	`run_id` text,
	`reason` text,
	`ts` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
