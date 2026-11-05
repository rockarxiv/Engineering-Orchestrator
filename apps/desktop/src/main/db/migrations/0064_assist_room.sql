-- The help widget's room: a third conversation with the system agent
-- (EO-188).
--
-- EO has two places to talk to the agent and both are destinations —
-- Discussions, and the architect panel inside the pipeline configure
-- screen. Everywhere else (a ticket, a board, Settings, Agents, the
-- archive) you are on your own, and the thing you want to say is almost
-- always about what is in front of you. This is the step that room's
-- conversations live on.
--
-- Nothing here teaches the engine anything new, exactly as 0036 did not.
-- A turn is dispatched by the mention path because the ticket sits on an
-- off-board step; what a turn proposes is a draft a person publishes
-- through `pipeline:save`, or work a person approves; and
-- `transitionTicket` remains the only thing that moves a ticket
-- (invariant #1).

-- Its *own* step rather than sharing `discussion` or `architecture`, for
-- 0036's three reasons, which are really one — the step is what the code
-- keys on:
--
--   * `findPendingResponses` resolves which action to dispatch from the
--     step the ticket sits on, so a third step is what selects `assist`
--     and its own output schema.
--   * `listConversations` scopes the Discussions picker with
--     `stepId = 'discussion'`, so a room of its own stays out of that
--     sidebar with no new filtering.
--   * A page's help thread and a project's decomposition chat cannot be
--     substituted for one another. Two conversations that cannot be
--     swapped are two kinds of conversation.
--
-- `owner_role` NULL and `type = 'user'` keep the scheduler away from it
-- entirely — `tick()` skips human-owned steps, so no capacity slot is
-- ever spent on a chat. `entry_action` is NULL because nothing arrives
-- here by transition; the action is resolved per dispatch. Position -3
-- sits beside `architecture`'s -2 and `discussion`'s -1, outside the
-- pipeline rather than at the front of it: `off_board` keeps it from
-- rendering as a column, so the number only has to not collide.
--
-- It joins the existing `discussions` pipeline rather than starting one,
-- for 0036's reason: `pipelines:list` hides a pipeline whose every step
-- is off-board, and that test is derived from the steps rather than from
-- a hard-coded id, so a third off-board step keeps it hidden and
-- `resolvePlacement` keeps it unassignable with no code change for
-- either.
INSERT INTO `pipeline_steps`
	(`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `plan_mode`, `off_board`)
VALUES
	('assist', 'discussions', -3, 'Assist', 'user', NULL, NULL, NULL, 0, 0, 1);
--> statement-breakpoint

-- `ASK-3` rather than `EO-53`, for the reason `DISC` and `ARCH` have
-- sequences of their own: a conversation is a ticket so that it can host
-- runs, and burning work numbers on them would put holes in the sequence
-- people actually read and quote. There is one assist thread per page,
-- so this is the counter that grows fastest of the three — all the more
-- reason it is not the one the board draws from.
INSERT INTO `key_counters` (`prefix`, `next_value`) VALUES ('ASK', 1);
