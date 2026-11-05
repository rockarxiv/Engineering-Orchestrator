-- Consult becomes Discussions.
--
-- The name was accurate when it was a side room: a place to ask the
-- product owner about the code without a ticket in hand. It is the front
-- door now (ARCHITECTURE.md, "A column is a responsibility, not a status") — where a description
-- becomes an understanding, a
-- decomposition, and finally tickets somebody approved — and "consult"
-- describes the old thing.
--
-- One of them is a discussion; the screen that lists them is Discussions.
-- The action an agent runs there is `discuss`.
--
-- Foreign keys are off around a migration batch (`runMigrations`), so the
-- referencing rows are updated beside the rows they reference rather than
-- in a dance around the constraint; `foreign_key_check` runs afterwards.

UPDATE `pipeline_steps` SET `id` = 'discussion', `name` = 'Discussion' WHERE `id` = 'consult';
--> statement-breakpoint
UPDATE `tickets` SET `step_id` = 'discussion' WHERE `step_id` = 'consult';
--> statement-breakpoint
UPDATE `transitions` SET `from_step_id` = 'discussion' WHERE `from_step_id` = 'consult';
--> statement-breakpoint
UPDATE `transitions` SET `to_step_id` = 'discussion' WHERE `to_step_id` = 'consult';
--> statement-breakpoint
UPDATE `step_routes` SET `from_step_id` = 'discussion' WHERE `from_step_id` = 'consult';
--> statement-breakpoint
UPDATE `step_routes` SET `target` = 'discussion' WHERE `target` = 'consult';
--> statement-breakpoint

-- The pipeline that holds it. Never in the sidebar — every step of it is
-- off-board — but it is a row like any other and should not be the last
-- thing still called Consult.
UPDATE `pipelines` SET `id` = 'discussions', `name` = 'Discussions' WHERE `id` = 'consult';
--> statement-breakpoint
UPDATE `pipeline_steps` SET `pipeline_id` = 'discussions' WHERE `pipeline_id` = 'consult';
--> statement-breakpoint
UPDATE `tickets` SET `pipeline_id` = 'discussions' WHERE `pipeline_id` = 'consult';
--> statement-breakpoint
UPDATE `step_routes` SET `pipeline_id` = 'discussions' WHERE `pipeline_id` = 'consult';
--> statement-breakpoint

-- What the product owner is asked to do there.
UPDATE `runs` SET `action` = 'discuss' WHERE `action` = 'consult';
--> statement-breakpoint

-- `CHAT-3` becomes `DISC-3`. Discussions keep a sequence of their own for
-- the reason they always did: a discussion is a ticket so that it can host
-- runs, and burning work numbers on them would put holes in the sequence
-- people actually read and quote.
UPDATE `key_counters` SET `prefix` = 'DISC' WHERE `prefix` = 'CHAT';
--> statement-breakpoint
UPDATE `tickets` SET `key` = 'DISC-' || substr(`key`, 6) WHERE `key` LIKE 'CHAT-%';
--> statement-breakpoint

-- A discussion's own model and reasoning-effort settings live under a key
-- in `tickets.spec`. Rewritten rather than left behind: a row whose spec
-- still says `consult` would silently lose its settings the moment
-- anything read the new key.
UPDATE `tickets` SET `spec` = json_set(`spec`, '$.discussion', json_extract(`spec`, '$.consult'))
WHERE `spec` IS NOT NULL AND json_extract(`spec`, '$.consult') IS NOT NULL;
--> statement-breakpoint
UPDATE `tickets` SET `spec` = json_remove(`spec`, '$.consult')
WHERE `spec` IS NOT NULL AND json_extract(`spec`, '$.consult') IS NOT NULL;
