-- The entries a note replaces (EO-594, ARCHITECTURE.md §7.5).
--
-- A note an agent writes may name the agent-written entries it corrects,
-- or says again. They are retired as `superseded` in the transaction that
-- writes it, and the new row names them here, as a JSON array of ids —
-- several, where `replaces_id` (0139) holds the one version an edit
-- replaced. Written once and never changed afterwards: restoring a
-- superseded entry leaves the history as it happened. No foreign key, for
-- `project_id`'s reason (0129). Every existing row named none.
ALTER TABLE `memories` ADD `superseded_ids` text DEFAULT '[]' NOT NULL;
