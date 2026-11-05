-- Memory consolidation proposes skills (EO-483, ARCHITECTURE.md, "What
-- an agent is given").
--
-- A consolidation may propose up to three skills from procedures that
-- keep appearing in a scope's memory. Each is posted on the project's
-- thread as a comment offering Save and Discard, and is a row here: what
-- it proposes, the entries and items it was seen in, which entries Save
-- would move into the skill (`covering_entry_ids` — the evidence as the
-- consolidation left it), and what a person decided.
--
-- A discarded row is the fingerprint the story asks EO to keep — scope,
-- slug and normalised description — so a later consolidation that
-- proposes the same thing posts nothing for it. `unsaveable` says why a
-- proposal was posted without Save: its slug was taken, or its target
-- was gone. The comment may be deleted; the row, and so the fingerprint,
-- stays.
CREATE TABLE `skill_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`consolidation_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_slug` text,
	`target_skill_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`evidence_entry_ids` text DEFAULT '[]' NOT NULL,
	`evidence_item_ids` text DEFAULT '[]' NOT NULL,
	`covering_entry_ids` text DEFAULT '[]' NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`unsaveable` text,
	`comment_id` text,
	`skill_id` text,
	`moved_entry_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_skill_proposals_fingerprint` ON `skill_proposals` (`scope_kind`,`scope_id`,`fingerprint`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_proposals_comment` ON `skill_proposals` (`comment_id`);
