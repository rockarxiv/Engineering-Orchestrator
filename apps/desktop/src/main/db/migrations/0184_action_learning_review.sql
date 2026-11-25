-- Whether a run of a role's action is followed by a learning review
-- (EO-911): a person's setting, for any role and action — a pack's own,
-- a role's definition, or one EO runs for itself. Empty, so every action
-- stays as it was until somebody sets one.
CREATE TABLE `action_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`action` text NOT NULL,
	`learning_review` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_action_settings_role_action` ON `action_settings` (`role`,`action`);
