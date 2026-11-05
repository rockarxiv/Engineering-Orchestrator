-- The one entity that moves through a pipeline stops being a ticket
-- (KAN-145, ARCHITECTURE.md, "One work entity").
--
-- A ticket is what a software team calls it. A support team calls the
-- same row a case, a marketing team calls it a report, and every one of
-- them means "the thing that enters a pipeline, is worked, and comes out
-- the other end". The core's own word for it becomes `item`, and the
-- pack that knows it is software keeps calling it a ticket in the words
-- it shows a person. Renamed wholesale rather than translated at a
-- boundary, the way `boards` became `projects` in 0027: carrying two
-- words for one thing is how each following story acquires a small bug.
--
-- Nothing moves. No row is rewritten, no id changes, no key is
-- renumbered — `items.key` still reads "EO-31" on every row that had it,
-- because the key's prefix comes from the project (0067) and has never
-- had anything to do with this word.
--
-- Order is load-bearing, and there are three passes: the tables take
-- their names, then the columns that point at them, then the indexes.
--
-- SQLite rewrites the REFERENCES clauses of *other* tables when a table
-- is renamed, and rewrites the indexes and primary keys that name a
-- column when the column is renamed, so nothing below drops a constraint
-- to put it back. That holds even though `runMigrations` runs with
-- `PRAGMA foreign_keys = OFF` — the pragma stopped governing this in
-- SQLite 3.25, which is what made the twelve-step rebuild unnecessary
-- here. `PRAGMA foreign_key_check` afterwards is what proves it.

-- 1. The tables.
ALTER TABLE `tickets` RENAME TO `items`;
--> statement-breakpoint
ALTER TABLE `ticket_deps` RENAME TO `item_deps`;
--> statement-breakpoint

-- 2. Every column naming one. `item_deps.depends_on_id` is untouched: it
--    already says what it points at without saying what kind of thing it
--    is, which is the whole point of the rename.
ALTER TABLE `item_deps` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `runs` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `transitions` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `comments` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `attachments` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `outbox` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint
ALTER TABLE `repository_indexes` RENAME COLUMN `ticket_id` TO `item_id`;
--> statement-breakpoint

-- 3. The indexes. SQLite has no ALTER INDEX RENAME, so each one is
--    dropped and recreated — which costs a rebuild of five indexes and
--    is the only way a name changes here. The definitions are exactly
--    what the column rename above left behind, column for column; only
--    the name is different.
--
--    `items.key` is UNIQUE inline rather than through a named index, so
--    its autoindex followed the table in pass 1 and is not listed.
DROP INDEX `idx_comments_ticket`;
--> statement-breakpoint
CREATE INDEX `idx_comments_item` ON `comments` (`item_id`,`created_at`);
--> statement-breakpoint

DROP INDEX `idx_attachments_ticket`;
--> statement-breakpoint
CREATE INDEX `idx_attachments_item` ON `attachments` (`item_id`);
--> statement-breakpoint

DROP INDEX `idx_attachments_ticket_jira`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_item_jira` ON `attachments` (`item_id`,`jira_attachment_id`);
--> statement-breakpoint

DROP INDEX `idx_outbox_ticket`;
--> statement-breakpoint
CREATE INDEX `idx_outbox_item` ON `outbox` (`channel`,`item_id`,`id`);
--> statement-breakpoint

DROP INDEX `idx_tickets_held`;
--> statement-breakpoint
CREATE INDEX `idx_items_held` ON `items` (`held_at`);
--> statement-breakpoint

-- 4. The three stored JSON documents that spell the word in a key.
--
-- These are not cosmetic and they are not optional. Each of the three is
-- read by a `...Ticket...` key that no longer exists in the source, so
-- leaving them alone would not preserve a person's setting — it would
-- silently discard it and fall back to a default, which is the one
-- outcome a rename is supposed to make impossible.
--
-- Guarded on `json_valid` the way 0061 and 0048 are: these columns are
-- open bags that the editor, the MCP tools and anyone holding the SQLite
-- file can write, and one unparseable row is that row's problem rather
-- than the whole batch's. Guarded on finding something to change as
-- well, so a row already in the new shape is left byte for byte alone
-- rather than reformatted by a `json_set` that had nothing to set.

-- The guardrails (`engine.guards`). `perTicketBudgetCents` is the one
-- that would be missed: it defaults to null — no ceiling — so a person
-- who had set one would have had it quietly lifted rather than reported.
UPDATE `app_settings`
SET `value` = json_remove(json_set(`value`, '$.perItemBudgetCents', json_extract(`value`, '$.perTicketBudgetCents')), '$.perTicketBudgetCents')
WHERE `key` = 'engine.guards'
  AND json_valid(`value`)
  AND json_type(`value`, '$.perTicketBudgetCents') IS NOT NULL;
--> statement-breakpoint

UPDATE `app_settings`
SET `value` = json_remove(json_set(`value`, '$.perItemAttemptLimit', json_extract(`value`, '$.perTicketAttemptLimit')), '$.perTicketAttemptLimit')
WHERE `key` = 'engine.guards'
  AND json_valid(`value`)
  AND json_type(`value`, '$.perTicketAttemptLimit') IS NOT NULL;
--> statement-breakpoint

-- Thread reuse on an agent whose role the registry does not know, which
-- is the only case `agents.config` still decides (EO-178). 0061 wrote
-- this key on every shipped implementer, so a database that has run that
-- migration has rows here to carry over.
--
-- `json_extract` returns 1/0 for a JSON boolean, so `json()` of the
-- CASE puts a real `true`/`false` back rather than a number — which is
-- what `reusesThreadPerItem` compares against with `=== true`.
UPDATE `agents`
SET `config` = json_remove(
    json_set(`config`, '$.reuseThreadPerItem', json(CASE WHEN json_extract(`config`, '$.reuseThreadPerTicket') THEN 'true' ELSE 'false' END)),
    '$.reuseThreadPerTicket'
  )
WHERE json_valid(`config`)
  AND json_type(`config`, '$.reuseThreadPerTicket') IS NOT NULL;
--> statement-breakpoint

-- What a module's manifest declares it reads (EO-74). Advisory rather
-- than enforced — it is the author's word, shown to whoever approves the
-- module — which is exactly why losing it would go unnoticed: the module
-- would go on reading items and simply stop saying so.
UPDATE `modules`
SET `manifest` = json_remove(
    json_set(`manifest`, '$.needs.item', json(CASE WHEN json_extract(`manifest`, '$.needs.ticket') THEN 'true' ELSE 'false' END)),
    '$.needs.ticket'
  )
WHERE json_valid(`manifest`)
  AND json_type(`manifest`, '$.needs.ticket') IS NOT NULL;
--> statement-breakpoint

-- 5. The proposals a person has been shown but not yet approved.
--
-- A `discuss` or `assist` turn answers with proposals, and an `amend` or
-- a `reorder` names the item it is about. That field was `ticket` and is
-- `item` now, and the card it produced is *still on the screen*: the run
-- survived the rename, the comment survived it, and the button under it
-- stopped working. `applyDiscussionProposal` re-reads the run's stored
-- result when somebody clicks Approve rather than trusting the card, so
-- a payload in the old shape no longer parses and the person is told
-- "the run behind this proposal no longer has a readable result" about
-- work they were in the middle of.
--
-- Only `parsed` is rewritten. `runs.result` holds both halves for the
-- reason the original design gives — "store the raw output alongside the parsed result;
-- when something goes wrong you'll want the original" — and they are not
-- the same kind of thing. `raw` is what the agent actually said, which
-- is a record and not EO's to edit; `parsed` is EO's own reading of it,
-- which is exactly what a rename is entitled to restate. So the two
-- disagree after this, on purpose, and the one that disagrees is the one
-- nothing acts on.
--
-- Both shapes, because `parsedResultOf` tolerates both: a result written
-- before A-02 introduced the wrapper *is* the parsed value, with no
-- `parsed` key at all. A migration that only knew the newer shape would
-- have left the oldest cards — the ones most likely to still be sitting
-- unapproved — exactly as broken as before.
--
-- Order is load-bearing and preserved. A turn posts one comment per
-- proposal and `proposalOfComment` finds which proposal a card is *by
-- its position in the array*, so rebuilding the array in a different
-- order would not fail — it would approve the wrong proposal, which is
-- worse. Hence the `ORDER BY` rather than a bare `json_each` scan.
--
-- A proposal that never carried the field — `new_feature`, `new_story`,
-- `new_bug` — is copied through untouched rather than given an
-- `"item": null` it never had.
UPDATE `runs`
SET `result` = json_set(`result`, '$.parsed.proposals', (
      SELECT json_group_array(json(
               CASE WHEN json_type(proposal.value, '$.ticket') IS NOT NULL
                    THEN json_remove(json_set(proposal.value, '$.item', json_extract(proposal.value, '$.ticket')), '$.ticket')
                    ELSE proposal.value END))
        FROM (SELECT key, value FROM json_each(json_extract(`runs`.`result`, '$.parsed.proposals')) ORDER BY key) AS proposal))
WHERE json_valid(`result`)
  AND json_type(`result`, '$.parsed.proposals') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(json_extract(`runs`.`result`, '$.parsed.proposals')) AS p WHERE json_type(p.value, '$.ticket') IS NOT NULL);
--> statement-breakpoint

-- The same, for a result stored before A-02 wrapped it in `raw`/`parsed`.
UPDATE `runs`
SET `result` = json_set(`result`, '$.proposals', (
      SELECT json_group_array(json(
               CASE WHEN json_type(proposal.value, '$.ticket') IS NOT NULL
                    THEN json_remove(json_set(proposal.value, '$.item', json_extract(proposal.value, '$.ticket')), '$.ticket')
                    ELSE proposal.value END))
        FROM (SELECT key, value FROM json_each(json_extract(`runs`.`result`, '$.proposals')) ORDER BY key) AS proposal))
WHERE json_valid(`result`)
  AND json_type(`result`, '$.proposals') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(json_extract(`runs`.`result`, '$.proposals')) AS p WHERE json_type(p.value, '$.ticket') IS NOT NULL);
