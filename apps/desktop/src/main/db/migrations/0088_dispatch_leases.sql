-- A device's claim on dispatching one item, with a time limit (EO-322,
-- ARCHITECTURE.md, "The record").
--
-- The record owns item state and runs the only scheduler; a device
-- claims a dispatch under this lease, runs the machine-local preflight
-- and reports a result or a refusal as a comment. Solo mode runs both
-- roles in one process with a local lease, so there is one code path.
--
-- `item_id` is the key: one item admits one lease, and the uniqueness
-- SQLite already enforces is what makes a grant an insert that either
-- lands or does not, rather than a read and a write two devices could
-- interleave between.
--
-- `on delete cascade` because a lease is a claim on an item that exists.
-- Deleting the ticket (KAN-30) takes it, and unlike `run_events` there
-- is nothing here to preserve: what happened is the run, the transition
-- and the comment, and none of those are this row.
CREATE TABLE `dispatch_leases` (
	`item_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dispatch_leases_expires` ON `dispatch_leases` (`expires_at`);
