-- Which runs were given which skills, and which loaded them (EO-715,
-- ARCHITECTURE.md §7.5). The supervisor records a `skills_delivered` run
-- event for every run given a skill and a `skill_loaded` event when the
-- run loads one, and the Skills screen and `skills_list` count each
-- skill's runs from them — nothing stores a count. Partial, like
-- `idx_run_events_memory_delivered` (0127): one entry per such event and
-- nothing for the rest of the table. The queries say the type as a
-- literal so SQLite uses them — see `skillUsageById`. Indexes only: no
-- row of `run_events` is written, changed or removed (invariant 3).
CREATE INDEX `idx_run_events_skills_delivered` ON `run_events` (`ts`) WHERE `type` = 'skills_delivered';--> statement-breakpoint
CREATE INDEX `idx_run_events_skill_loaded` ON `run_events` (`ts`) WHERE `type` = 'skill_loaded';
