-- Plan mode moves onto the step it was always about (ARCHITECTURE.md, "A step").
--
-- It lived on the project group with a comment explaining why: "a
-- per-board gate cannot be a state without making workflows per-board".
-- That was true when `workflow_states` was one global table. Workflows are
-- per-pipeline now, so the reason is gone — and the flag was never really
-- about a project. It asks one step, the one that implements, to plan
-- first and write nothing, which is a property of that step.
--
-- Being on the step also makes it expressible where it could not be
-- before: two pipelines in one project, one of them cautious.

ALTER TABLE `pipeline_steps` ADD COLUMN `plan_mode` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Carried over rather than reset: a project that had it on had it on for
-- a reason. It lands on whichever steps run `implement`, since that is the
-- only action it ever changed.
UPDATE `pipeline_steps` SET `plan_mode` = 1
WHERE `entry_action` = 'implement'
  AND `pipeline_id` IN (
    SELECT COALESCE(`pipelines`.`id`, '')
    FROM `pipelines`
    JOIN `projects` ON `projects`.`id` = `pipelines`.`project_id`
    WHERE `projects`.`plan_mode` = 1
  );
--> statement-breakpoint

ALTER TABLE `projects` DROP COLUMN `plan_mode`;
