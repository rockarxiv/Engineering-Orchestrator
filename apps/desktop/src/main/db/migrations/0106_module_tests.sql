-- A module's test cases, and the latest result of running them (EO-352).
--
-- One row per case, so a case is written, edited and deleted on its own,
-- and one result row per module, replaced on every run. The result
-- carries the fingerprint of what it was taken against -- the module's
-- code and manifest and every case -- so whether it is stale is worked
-- out on read rather than stored.
CREATE TABLE `module_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_module_tests_module` ON `module_tests` (`module_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `module_test_results` (
	`module_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`ran_at` integer NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
