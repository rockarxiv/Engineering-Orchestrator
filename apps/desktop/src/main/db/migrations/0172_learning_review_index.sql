-- The `learning_review` rows by run (EO-788). A quiet assistant chat's
-- review commits its notes in its `learning_review` event and writes them
-- after it, so EO looks there for notes it committed and has not written
-- yet — a write that failed, or EO quitting before the last of them — and
-- asks which of a chat's runs were reviewed last. Partial, like
-- `idx_run_events_skills_settled` (0162). An index only: no row of
-- `run_events` is written, changed or removed (invariant 3).
CREATE INDEX `idx_run_events_learning_review` ON `run_events` (`run_id`) WHERE `type` = 'learning_review';
