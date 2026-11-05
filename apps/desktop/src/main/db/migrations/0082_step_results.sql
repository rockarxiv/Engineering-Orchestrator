-- What a person may decide on a human step (EO-310,
-- the original design).
--
-- "A human step declares results exactly as an agent step does, and each
-- is routed." Until now nothing did: a builtin declares its results in
-- the registry, a module in its manifest, an agent answers whatever its
-- prompt asked for -- and a person had nowhere to declare anything, so
-- there was no such thing as a result for a human. The only gesture left
-- was a drag between columns, which names a destination rather than an
-- answer and never touches `resolveRoute`.
--
-- JSON rather than a `step_results` table, for `pipeline_steps.inputs`'
-- reason: it is a small ordered list belonging to exactly one step,
-- edited and published as part of the graph document in the same click,
-- and never queried across steps. A table would buy joins nobody makes
-- and a second thing to keep in step with `step_routes`.
--
-- `[]` rather than NULL for every existing row, which is what every
-- human step has always meant: it waits, and there is nothing to press.
-- The developer pipeline's own human step is given two below.
ALTER TABLE `pipeline_steps` ADD `results` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- The developer pack's human step gains the decision it always implied
-- (EO-310).
--
-- "Done" is where a person looks at work an agent has finished. Today
-- accepting it is doing nothing and sending it back is a drag to "To
-- Do" with no route taken and no reason attached. Both become results:
-- Approve, which finishes the item where it already stands, and Send
-- back, which returns it to the implementer with the reason as its own
-- comment on the thread.
--
-- `send_back` requires a comment and `approved` does not, which is the original design
-- exactly: "a non-approving result requires a comment". A story sent
-- back with no words is the failure this is for -- the implementer is
-- dispatched again with nothing to go on but the fact that the item
-- arrived.
--
-- **Only where this is still the step the pack shipped.**
--
-- A migration that seeds a pack's own default has to be able to tell
-- that default from what somebody has made of it, and an id is not
-- enough: `ready_to_merge` is the id of whatever now stands in that
-- column, which on a project a year old may be "Waiting on legal", may
-- no longer be terminal, and may be exactly the deliberately quiet
-- human step its owner wanted -- one that waits and offers nothing.
-- Giving that step two buttons and two routes is EO editing somebody's
-- pipeline on their behalf, in an upgrade they did not ask for and are
-- not told about.
--
-- So the guard is the whole shipped shape rather than a corner of it:
-- the name EO gave it, the kind, terminal, on the board, no role and no
-- action, nothing declared, and no branch drawn out of it. Every one of
-- those is something the configuration screen can change, and changing
-- any of them is somebody saying this step is theirs now.
--
-- Three columns are deliberately *not* in the guard, and each is a
-- decision rather than an omission.
--
-- `position`, because adding a step anywhere in the pipeline renumbers
-- it. Somebody who inserted a QA column has customised their pipeline
-- and has not touched Done, and refusing them the decision on that
-- ground would be reading "this pipeline changed" as "this step
-- changed".
--
-- `owner_person_id`, for the sharper version of the same: naming who
-- approves here (EO-302) makes the decision *more* wanted, not less. A
-- guard that excluded them would withhold the buttons from precisely
-- the installation that had said out loud it wants somebody to press
-- one.
--
-- `workspace_mode`, `workspace_id`, `inputs` and `timeout_ms`, because
-- none of them means anything on a step that never runs. They are facts
-- about a disk and about a module, and a `user` step has neither.
UPDATE `pipeline_steps`
SET `results` = '[{"key":"approved","label":"Approve","tone":"success","requiresComment":false},{"key":"send_back","label":"Send back","tone":"warning","requiresComment":true}]'
WHERE `id` = 'ready_to_merge'
  AND `pipeline_id` = 'default'
  AND `name` = 'Done'
  AND `type` = 'user'
  AND `is_terminal` = 1
  AND `off_board` = 0
  AND `plan_mode` = 0
  AND `owner_role` IS NULL
  AND `entry_action` IS NULL
  AND `instructions_summary` IS NULL
  AND `results` = '[]'
  AND NOT EXISTS (SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'ready_to_merge')
  -- And the step the send-back goes to has to be the one it means, or
  -- neither half is written. All-or-nothing on purpose: declaring
  -- `send_back` without its route would leave the shipped pipeline
  -- failing its own validator -- a button with nowhere to go, put there
  -- by an upgrade. The two statements below lean on this, which is why
  -- their guard is only that the declaration above happened.
  AND EXISTS (SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `type` = 'agent' AND `owner_role` = 'implementer');
--> statement-breakpoint
-- And the routes those two keys take. `terminal` for the approval:
-- "Done" is the terminal step, so approving is the person saying the
-- work is finished where it stands, and the transition records who said
-- so and when. `todo` for the send-back, which is where the drag went.
--
-- Written only when the step declared them a statement ago, so an
-- installation whose "Done" somebody has already rewired gets neither
-- half.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_done_approved', 'default', 'ready_to_merge', 'approved', 'Approve', 'success', 'terminal', 0
WHERE EXISTS (
	SELECT 1 FROM `pipeline_steps` WHERE `id` = 'ready_to_merge' AND `pipeline_id` = 'default' AND `results` != '[]'
) AND NOT EXISTS (
	SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'ready_to_merge' AND `result_key` = 'approved'
);
--> statement-breakpoint
-- And the destination has to be the step the send-back means, not
-- merely a row with its id: "send it back to be written again" is true
-- of the implementer's column and of nothing else. A `todo` somebody
-- has repurposed would be a branch pointing at whatever they made of
-- it, drawn by EO rather than by them.
INSERT INTO `step_routes` (`id`, `pipeline_id`, `from_step_id`, `result_key`, `label`, `tone`, `target`, `position`)
SELECT 'r_done_send_back', 'default', 'ready_to_merge', 'send_back', 'Send back', 'warning', 'todo', 1
WHERE EXISTS (
	SELECT 1 FROM `pipeline_steps` WHERE `id` = 'ready_to_merge' AND `pipeline_id` = 'default' AND `results` != '[]'
) AND EXISTS (
	SELECT 1 FROM `pipeline_steps` WHERE `id` = 'todo' AND `pipeline_id` = 'default' AND `type` = 'agent' AND `owner_role` = 'implementer'
) AND NOT EXISTS (
	SELECT 1 FROM `step_routes` WHERE `from_step_id` = 'ready_to_merge' AND `result_key` = 'send_back'
);
