-- The conflict notice and its chat (EO-533).
--
-- A held template update (0135) is told to the person as one comment on
-- the project thread, mentioning them, with one button: Fix with
-- assistant. Two facts tie that notice to the row it is about:
--
-- `notice_comment_ids` — the comments the notice was posted as: one for
-- the project owning the pipeline, or one per project with items on a
-- pipeline no project has adopted. Resolving the conflict closes their
-- mentions, and a pipeline whose update for a template version was
-- already announced is never announced for that version again.
--
-- `chat_id` — the assistant chat the button opened, so pressing it again
-- shows the same chat rather than a second one. No foreign key: a person
-- may remove the chat, and the next press then starts a new one.
--
-- `chat_turn_device_id` — on the organisation's record, the device the
-- chat's first turn was handed to. The chat is the record's and every
-- admin's desktop holds a copy, so its brief asks nobody there: the
-- record hands the first turn to exactly one device — the first to
-- press — and only that desktop asks its assistant. Kept, so the same
-- device asking again after a lost answer is handed it again rather
-- than nobody being. Null on a desktop's own conflicts.
ALTER TABLE `pipeline_update_conflicts` ADD `notice_comment_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `pipeline_update_conflicts` ADD `chat_id` text;
--> statement-breakpoint
ALTER TABLE `pipeline_update_conflicts` ADD `chat_turn_device_id` text;
