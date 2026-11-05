-- A hold parks one ticket without moving it through its pipeline. Existing
-- rows remain unheld because NULL is the normal, dispatchable value.

ALTER TABLE `tickets` ADD COLUMN `held_at` INTEGER;
--> statement-breakpoint
CREATE INDEX `idx_tickets_held` ON `tickets` (`held_at`);
