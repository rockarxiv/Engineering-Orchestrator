-- The pipeline architect: an agent you configure pipelines by talking to.
--
-- The pipeline graph is data (invariant #7) and the configuration screen
-- edits it by hand, which is correct and not easy: a builtin step must
-- name a function EO ships, only a `user` step may be terminal, every
-- result an agent can return needs a route or the ticket parks in
-- silence, a role with no enabled agent parks every ticket that reaches
-- it, and a Codex-backed step is inert unless the Codex CLI is on the
-- machine. `validatePipeline` enforces all of it *after* you have
-- guessed wrong. This is the agent that knows the rules up front.
--
-- Nothing here teaches the engine anything new. The architect proposes a
-- whole graph, a person publishes it through the same `pipeline:save`
-- the screen already uses, and `transitionTicket` remains the only thing
-- that moves a ticket (invariant #1).

-- A conversation is a ticket on an off-board step, which is the shape
-- `discussion` established (0021, renamed in 0032) and the reasoning
-- there holds verbatim: `runs.ticket_id` is NOT NULL, so a chat has to
-- be a ticket for its turns to be runs, and being a ticket makes the
-- messages ordinary comments so invariant #4 holds literally.
--
-- Its *own* step rather than sharing `discussion`, for three reasons
-- that are really one — the step is what the code keys on:
--
--   * `findPendingResponses` resolves which action to dispatch from the
--     step the ticket sits on. A second step means `configure` is
--     selected by the same rule that already selects `discuss`, rather
--     than by inspecting who was mentioned.
--   * `listConversations` returns every off-board ticket, so sharing a
--     step would put architecture chats in the Discussions picker.
--   * They are answered by different agents with different output
--     schemas. Two conversations that cannot be substituted for one
--     another are two kinds of conversation.
--
-- `owner_role` NULL and `type = 'user'` keep the scheduler away from it
-- entirely — `tick()` skips human-owned steps, so no capacity slot is
-- ever spent on a chat. `entry_action` is NULL because nothing arrives
-- here by transition; the action is resolved per dispatch. Position -2
-- sits beside `discussion`'s -1, outside the pipeline rather than at the
-- front of it: `off_board` keeps it from rendering as a column, so the
-- number only has to not collide.
--
-- It joins the existing `discussions` pipeline rather than starting one.
-- `pipelines:list` hides a pipeline whose every step is off-board, and
-- that test is derived from the steps rather than from a hard-coded id —
-- so a second off-board step keeps it hidden, and `resolvePlacement`
-- keeps it unassignable, with no code change for either.
INSERT INTO `pipeline_steps`
	(`id`, `pipeline_id`, `position`, `name`, `type`, `owner_role`, `entry_action`, `instructions_summary`, `is_terminal`, `plan_mode`, `off_board`)
VALUES
	('architecture', 'discussions', -2, 'Architecture', 'user', NULL, NULL, NULL, 0, 0, 1);
--> statement-breakpoint

-- `ARCH-3` rather than `EO-53`, for the reason `DISC` has its own
-- sequence: a conversation is a ticket so that it can host runs, and
-- burning work numbers on them would put holes in the sequence people
-- actually read and quote.
INSERT INTO `key_counters` (`prefix`, `next_value`) VALUES ('ARCH', 1);
--> statement-breakpoint

-- The agent itself.
--
-- `fake` and a placeholder, exactly as the three seeded in 0001: the
-- placeholder is what marks an agent as never having been configured, so
-- `syncRolePrompts` fills in the real prompt from
-- `roles/prompts/pipeline-architect.md` on the next launch and keeps it
-- current on every launch after that. Writing the prompt here instead
-- would freeze this version of it into applied SQL, which is precisely
-- what R-01 chose versioned files to avoid.
INSERT INTO `agents` (`id`, `name`, `role`, `provider`, `model`, `instructions`, `config`, `enabled`) VALUES
	(
		'019fb8c6-de92-7a41-9c33-4471f0c2b1de',
		'Architect',
		'pipeline_architect',
		'fake',
		NULL,
		'TODO: placeholder instructions for the pipeline_architect role.',
		-- Read-only, and narrowly so. This agent's entire job is to read
		-- the configuration and describe a better one; it writes nothing,
		-- because what it produces is a draft a person publishes. An
		-- allowlist is exhaustive, so naming these five is what permits
		-- them at all — and omitting Write/Edit/Bash is what makes
		-- "read-only" a fact rather than an instruction in a prompt.
		'{"allowedTools":["Read","Grep","Glob","mcp__eo__pipeline_list","mcp__eo__pipeline_read","mcp__eo__agents_list","mcp__eo__agent_read","mcp__eo__runtimes_list"]}',
		1
	);
