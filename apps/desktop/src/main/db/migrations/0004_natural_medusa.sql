CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_path` text NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`test_command` text,
	`lint_command` text,
	`build_command` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
