-- What a message is about, within its source (EO-727): the update
-- conflict a `template_conflict` message asks about, the memory scope a
-- `consolidation_stuck` one does. EO resolves the open messages of a
-- source and subject once what they asked about is settled some other
-- way — a later consolidation of that scope succeeding, say — without
-- keeping their ids anywhere. Null for a message nothing resolves.
--
-- Kept where the message was written; a replica's copy has none, since
-- only the installation that sent a message resolves it.
ALTER TABLE `messages` ADD `subject` text;
--> statement-breakpoint
CREATE INDEX `idx_messages_source_subject` ON `messages` (`source`,`subject`);
