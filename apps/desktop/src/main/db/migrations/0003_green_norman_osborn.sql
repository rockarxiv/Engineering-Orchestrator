CREATE TABLE `comment_mentions` (
	`comment_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`addressed_by` text,
	PRIMARY KEY(`comment_id`, `target_type`, `target_id`),
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`addressed_by`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_mentions_open` ON `comment_mentions` (`status`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text,
	`run_id` text,
	`body` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`options` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_comments_ticket` ON `comments` (`ticket_id`,`created_at`);