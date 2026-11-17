-- A change to an existing module, frozen by an assistant or scenario turn
-- before its answer names it (EO-813).
--
-- The turn stages the module's code and manifest, edits them, and freezes
-- the result here; its answer names the row by id rather than restating
-- the whole module. A row is the whole proposal -- code, manifest (null
-- leaves it as it is), the test cases it adds or replaces and the ids it
-- removes -- with `base`, the hashes of what was staged, so a stale change
-- can be told from a current one. Nothing on disk is named: the staging
-- files may be swept without the row losing anything.
--
-- Never updated and never deleted: a card a person may still apply reads
-- it. Rows go only with their conversation or their run, by cascade.
-- Nothing here touches the module, its tests, its history or its approval.
CREATE TABLE `module_change_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text NOT NULL,
	`module_id` text NOT NULL,
	`room` text NOT NULL,
	`summary` text NOT NULL,
	`code` text NOT NULL,
	`manifest` text,
	`tests` text DEFAULT '[]' NOT NULL,
	`remove_tests` text DEFAULT '[]' NOT NULL,
	`base` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_module_change_proposals_item` ON `module_change_proposals` (`item_id`,`created_at`);
