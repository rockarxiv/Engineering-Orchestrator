-- The module dry run is gone (EO-353): approving a module runs its tests
-- now, so "when somebody last watched it run" is a mark nothing reads.
--
-- Only the module's mark. `runs.dry_run` stays, and so does every run it
-- flags: those runs happened, and what happened is history (invariant
-- #3's spirit). `approved_at` is not touched either -- a module approved
-- before this change keeps its approval, and editing its code is what
-- clears it, so the tests are asked for at its next approval.
ALTER TABLE `modules` DROP COLUMN `dry_run_at`;
