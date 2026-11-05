-- Write it up on a follow-up opens an assistant chat (EO-606,
-- ARCHITECTURE.md §7.5). The chat is recorded on the follow-up, so a
-- second press shows the same one, and so accepting an item from it can
-- close the follow-up. On the organisation's record the chat's first turn
-- is handed to one device, as `pipeline_update_conflicts`' is (0136). No
-- foreign key to items, for that table's reason: a chat since removed is
-- started again.
ALTER TABLE `follow_up_proposals` ADD `chat_id` text;
--> statement-breakpoint
ALTER TABLE `follow_up_proposals` ADD `chat_turn_device_id` text;
--> statement-breakpoint
CREATE INDEX `idx_follow_up_proposals_chat` ON `follow_up_proposals` (`chat_id`);
--> statement-breakpoint
-- A card accepted in such a chat, on the record that holds it, once.
-- Two desktops can accept one card before either hears of the other's
-- approval, and a person can accept it again after an answer was lost, so
-- what a card made is kept by the card's comment id, in the transaction
-- that made it, and a repeat is answered from here. No foreign keys, for
-- the row above's reason: a filing outlives what it names.
CREATE TABLE `follow_up_filings` (
	`card_id` text PRIMARY KEY NOT NULL,
	`follow_up_id` text NOT NULL,
	`item_ids` text NOT NULL,
	`reply_comment_id` text,
	`created_at` integer NOT NULL
);
