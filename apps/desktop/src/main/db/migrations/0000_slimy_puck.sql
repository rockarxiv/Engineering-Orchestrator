CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`instructions` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `key_counters` (
	`prefix` text PRIMARY KEY NOT NULL,
	`next_value` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_deps` (
	`ticket_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `depends_on_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`body` text,
	`spec` text,
	`state` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`state`) REFERENCES `workflow_states`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_key_unique` ON `tickets` (`key`);--> statement-breakpoint
CREATE TABLE `workflow_states` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`owner_role` text,
	`entry_action` text,
	`is_terminal` integer DEFAULT false NOT NULL
);
