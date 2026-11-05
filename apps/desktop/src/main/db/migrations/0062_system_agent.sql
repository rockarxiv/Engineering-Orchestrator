-- One conversational agent where there were two (EO-181).
--
-- The product owner and the pipeline architect were siblings in
-- everything but subject: same conversation machinery, same question
-- schema, same ask-XOR-propose rule, same "nothing is applied until a
-- person accepts it" gate. Neither owned a pipeline step — both are
-- reached through the mention path, and the action a conversation
-- dispatches is chosen from the step its ticket sits on rather than from
-- who was mentioned — so two rows bought nothing but the chance for the
-- two prompts and the two tool lists to drift apart.
--
-- Both rooms survive exactly as they were. The Discussions panel and the
-- Architecture panel keep their own steps (`discussion`, `architecture`),
-- their own key prefixes (DISC, ARCH) and their own `tickets.spec`
-- settings keys, and `discuss` and `configure` keep their separate
-- schemas. None of those are touched here. What changes is only which
-- agent row both of them resolve.
--
-- Nothing is deleted. Every existing conversation on either step keeps
-- its ticket, its comments and its runs.

-- The Product Owner row becomes the system agent.
--
-- This row rather than the architect's because it is the older of the
-- two and the one every install has: 0001 seeds it, 0036 seeds the
-- architect, and an install that predates 0036 has no architect row to
-- promote.
--
-- `instructions` is deliberately not written here. `syncRolePrompts`
-- runs at the next boot and replaces them with `system-agent.md` if and
-- only if `prompt_hash` — or, on a pre-0033 install with no provenance
-- at all, `SHIPPED_PROMPT_HASHES` — says the text there is EO's own.
-- Somebody's edited prompt is reported as customised on the Agents
-- screen instead of being overwritten by SQL that cannot tell the
-- difference. Writing the prompt here would also freeze this version of
-- it into applied SQL, which is what R-01 chose versioned files to
-- avoid.
--
-- Keyed on the role rather than on 0001's id, so a second product owner
-- somebody created is carried across too. Leaving one behind would leave
-- an agent on a role that no longer resolves anywhere: `BUILTIN_ROLES`
-- no longer names it, `loadRolePrompt` no longer has a file for it, and
-- neither panel would ever dispatch to it again.
UPDATE `agents`
SET `role` = 'system',
    `name` = 'System'
WHERE `role` = 'product_owner';
--> statement-breakpoint

-- The five configuration reads the architect had and the product owner
-- did not.
--
-- This story adds no capability — the merged agent is exactly as able as
-- the two it replaces — which cuts both ways: it must not lose the
-- architect's half either. An allowlist is exhaustive, so a system agent
-- holding only the product owner's tools would open the Architecture
-- panel, be asked for a `configure` turn, and have nothing to read the
-- pipeline with.
--
-- It is not only the tools. `configToolsEnabled` answers from exactly
-- these names, and it is what decides whether the `eo` MCP service
-- serves the configuration tools at all and whether Codex is spawned
-- with a runtime root. Without them a configure run is not merely
-- narrower, it is inert.
--
-- One statement per tool, each guarded on its own absence, for the
-- reason 0047 was: `config` is an open bag, this may run against a row
-- somebody has already edited, and appending a duplicate is a tool
-- listed twice in a prompt. `json_valid` guards the batch the way 0061
-- does — one unparseable row is that row's problem rather than an
-- aborted migration and an app that will not open.
--
-- A row with no `allowedTools` array at all is left alone by
-- `json_type(...) = 'array'`, and correctly: absent means every
-- advertised tool is already permitted, so there is nothing to widen.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__pipeline_list')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo__pipeline_list'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__pipeline_read')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo__pipeline_read'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__agents_list')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo__agents_list'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__agent_read')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo__agent_read'
  );
--> statement-breakpoint
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__runtimes_list')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo__runtimes_list'
  );
--> statement-breakpoint

-- Any step a person wired to one of the old roles follows the rename.
--
-- No pipeline EO ships has one: 0001's `intake` and `backlog` were the
-- only seeded steps that named `product_owner`, and 0030 deleted both;
-- the architect never owned a step at all. So this is for a step
-- somebody hand-wired — the owner picker has always excluded the
-- conversational roles, but `pipeline_save` over MCP does not, and an
-- installation can have an intake column of its own making.
--
-- Left behind, such a step would name a role with no enabled agent, and
-- every ticket that reached it would wait there forever. That is exactly
-- the silent park the picker's exclusion exists to prevent, so the
-- rename has to reach the steps as well as the rows.
--
-- The two conversation steps are not touched by this: both carry
-- `owner_role` NULL and are `type = 'user'`, which is what keeps the
-- scheduler away from them.
UPDATE `pipeline_steps`
SET `owner_role` = 'system'
WHERE `owner_role` IN ('product_owner', 'pipeline_architect');
--> statement-breakpoint

-- The architect row is retired, not removed.
--
-- `runs.agent_id` references it and `agents` has no `archived_at`, so
-- deleting it would either fail the foreign key check `runMigrations`
-- runs afterwards or take every configure run ever dispatched with it.
-- The run history of a conversation is the conversation; invariant #3
-- says `run_events` is the durability substrate, and orphaning the runs
-- that point into it is the same loss by another route.
--
-- `enabled = 0` is what takes it out of service: `architectAgent` and
-- the discussion resolver both require `enabled`, and every dispatch
-- path reads one of them. Its `role` is left as `pipeline_architect` on
-- purpose — it is no longer a role EO ships, so `syncRolePrompts` finds
-- no file for it and leaves its instructions untouched rather than
-- rewriting a disabled row's text with a prompt for a different job.
--
-- By id rather than by role: 0036 seeded exactly this row, and an
-- architect somebody created themselves is theirs to keep or disable.
UPDATE `agents`
SET `enabled` = 0
WHERE `id` = '019fb8c6-de92-7a41-9c33-4471f0c2b1de';
