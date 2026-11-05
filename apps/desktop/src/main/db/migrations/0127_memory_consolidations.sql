-- Automatic memory consolidation (EO-480, ARCHITECTURE.md, "What an
-- agent is given").
--
-- A consolidation folds one scope's agent-written entries into a smaller
-- set. Each one is a row here, and its id is the `consolidation_id` every
-- entry it retired or wrote is tagged with. The ids themselves are kept
-- as JSON arrays as well, because a tag on an entry is overwritten if a
-- later consolidation retires it again, and a restore must put back
-- exactly what this one took and take back exactly what it wrote.
--
-- Rows are the scheduler's memory too: the newest `succeeded` row is when
-- a scope was last consolidated, the `failed` rows since it are the
-- backoff, and a `running` row left by a process that stopped is closed
-- as failed on the next launch. A success, a skip and a restore
-- (`restored_at`) each settle the scope under the caps then in force
-- (`caps_entries`, `caps_chars`): a scope over a cap is taken up again
-- only once something in it is written after that, or the caps change,
-- so the entries a restore put back are not folded again at once.
CREATE TABLE `memory_consolidations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`restored_at` integer,
	`retired_ids` text DEFAULT '[]' NOT NULL,
	`written_ids` text DEFAULT '[]' NOT NULL,
	`failure_reason` text,
	`note` text,
	`caps_entries` integer,
	`caps_chars` integer
);
--> statement-breakpoint
CREATE INDEX `idx_memory_consolidations_scope` ON `memory_consolidations` (`scope_kind`,`scope_id`,`started_at`);
--> statement-breakpoint
-- An entry a consolidation kept although it disagrees with the
-- workspace's CLAUDE.md or AGENTS.md, because it is plainly newer and
-- says it corrects the file. The file is never edited.
ALTER TABLE `memories` ADD `contradicts_repository_file` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Which runs were given memory, by when (EO-480). The scheduled
-- consolidation counts runs given a scope's memory since its last one,
-- and `run_events` is keyed on `(run_id, seq)` with nothing on `type` or
-- `ts`. Partial, like `idx_run_events_debug_sent` (0110): one entry per
-- delivery and nothing for the rest of the table. The query says
-- `type = 'memory_delivered'` as a literal so SQLite uses it — see
-- `runsDeliveredFromScopeSince`. An index only: no row of `run_events`
-- is written, changed or removed (invariant 3).
CREATE INDEX `idx_run_events_memory_delivered` ON `run_events` (`ts`) WHERE `type` = 'memory_delivered';
