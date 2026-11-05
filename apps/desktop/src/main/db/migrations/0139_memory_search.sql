-- Searching and reading memory entries (EO-545, the `memories_search`
-- and `memory_get` MCP tools).
--
-- ── Which version an edit replaced ──────────────────────────────────
--
-- An edit retires the old row as `edited` and writes a new one. Until
-- now nothing said which new row replaced which old one, so an entry's
-- history could only be guessed from the two rows' times. The new row now
-- names the one it replaced, written by `editMemory` in the same
-- transaction and carried to replicas with the rest of the row. It is
-- never changed afterwards: restoring the old version leaves the history
-- as it happened. No foreign key, for `project_id`'s reason (0129).
ALTER TABLE `memories` ADD `replaces_id` text;
--> statement-breakpoint
-- Edits made before this, where the times say so without doubt: a
-- person's row, written by no consolidation, created at the very moment
-- exactly one row of its scope was retired as `edited` — and the only
-- such row of its scope created at that moment. `editMemory` stamps both
-- with one clock reading, so that pair is the edit. Anything less certain
-- — two edits in one scope in one millisecond, a version since restored,
-- a row a consolidation wrote with an older entry's age — is left
-- without a predecessor rather than given a wrong one.
UPDATE `memories`
SET `replaces_id` = (
	SELECT `old`.`id` FROM `memories` AS `old`
	WHERE `old`.`scope_kind` = `memories`.`scope_kind`
		AND `old`.`scope_id` = `memories`.`scope_id`
		AND `old`.`retired_reason` = 'edited'
		AND `old`.`retired_at` = `memories`.`created_at`
)
WHERE `memories`.`source_kind` = 'person'
	AND NOT EXISTS (
		SELECT 1 FROM `memory_consolidations`, json_each(`memory_consolidations`.`written_ids`)
		WHERE json_each.`value` = `memories`.`id`
	)
	AND (
		SELECT count(*) FROM `memories` AS `old`
		WHERE `old`.`scope_kind` = `memories`.`scope_kind`
			AND `old`.`scope_id` = `memories`.`scope_id`
			AND `old`.`retired_reason` = 'edited'
			AND `old`.`retired_at` = `memories`.`created_at`
	) = 1
	AND (
		SELECT count(*) FROM `memories` AS `same`
		WHERE `same`.`scope_kind` = `memories`.`scope_kind`
			AND `same`.`scope_id` = `memories`.`scope_id`
			AND `same`.`created_at` = `memories`.`created_at`
	) = 1;
--> statement-breakpoint
CREATE INDEX `idx_memories_replaces` ON `memories` (`replaces_id`);
--> statement-breakpoint
-- ── Approximate search ──────────────────────────────────────────────
--
-- An FTS5 index of every entry's body, retired ones included, with the
-- trigram tokenizer: every three-character run of the text is a token,
-- so a query matches part of a word ("windo" finds "Windows"), another
-- form of it ("rerun" finds "reruns"), and — by asking for each of a
-- word's trigrams on its own and ranking with bm25 — most of a word
-- spelt a little wrong. SQLite's own FTS5, which better-sqlite3 bundles:
-- no new dependency and nothing outside the database.
--
-- What is indexed is the body folded by `eo_fold_case` (textFold.ts):
-- NFKC-normalised and case-folded in every script, the one definition of
-- "the same letters" that a query is folded by too. Indexing the raw
-- body would leave a "für" typed as "u" and a combining diaeresis
-- unfindable even by the same text, since the query is normalised and
-- the tokenizer folds only case. `eo_fold_case` is registered on every
-- connection `openDb` opens, which is the only way EO opens a database;
-- a connection without it cannot write an entry, rather than writing one
-- the index misses.
--
-- Keyed on the entry's id rather than on `memories`' rowid. The table has
-- a text primary key, so its rowid is implicit, and VACUUM may renumber
-- an implicit rowid — which would leave an external-content index
-- pointing at the wrong bodies. So the index holds its own folded copy of
-- each body beside the id, and is joined to `memories` by id.
--
-- Kept in step by triggers rather than by each write, because entries
-- are written by more than one module — a person's and an agent's
-- writes, consolidation, a replica copying its record's rows, a project
-- arriving or leaving — and a trigger cannot be forgotten by the next
-- one. A retirement or a restore changes no body and so nothing here;
-- whether an entry is retired is read off `memories` at query time. An
-- edit writes a new row, which the insert trigger indexes.
CREATE VIRTUAL TABLE `memories_fts` USING fts5(`id` UNINDEXED, `body`, tokenize = 'trigram');
--> statement-breakpoint
INSERT INTO `memories_fts` (`id`, `body`) SELECT `id`, eo_fold_case(`body`) FROM `memories`;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_insert` AFTER INSERT ON `memories` BEGIN
	INSERT INTO `memories_fts` (`id`, `body`) VALUES (new.`id`, eo_fold_case(new.`body`));
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_update` AFTER UPDATE OF `id`, `body` ON `memories` BEGIN
	DELETE FROM `memories_fts` WHERE `id` = old.`id`;
	INSERT INTO `memories_fts` (`id`, `body`) VALUES (new.`id`, eo_fold_case(new.`body`));
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_delete` AFTER DELETE ON `memories` BEGIN
	DELETE FROM `memories_fts` WHERE `id` = old.`id`;
END;
