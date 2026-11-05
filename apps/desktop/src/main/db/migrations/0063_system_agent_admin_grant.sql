-- The grant nothing ever wrote (EO-185).
--
-- 0062 made the system agent, and EO-182 built everything it reaches
-- with: the internal `eo_admin` server, the `adminToolsEnabled`
-- predicate, and the delivery that writes that server into an agent's
-- generated `.mcp.json`. Every piece of it works. None of it had ever
-- run, because the switch that turns it on is a named entry in
-- `allowedTools` and nothing in the tree wrote one — no migration, and
-- no renderer, since the Agents screen has no tools editor. The only
-- grant that existed was in `adminDelivery.test.ts`, which hand-builds
-- an agent whose `allowedTools` names the server. The tests passed
-- because they granted it to themselves.
--
-- `mcp__eo_admin` — the whole server — rather than the tools under it.
-- It is Claude Code's own spelling for "everything this server offers",
-- it is the grant `adminToolsEnabled` is written to read, and naming
-- seventy tools one at a time would be a list to keep in step with
-- `mcpHost/catalog.ts` forever. The catalogue decides the surface; this
-- entry decides who reaches it.
--
-- Keyed on the role, for 0062's reason: `system` is the role that
-- reconfigures the installation, and a second one somebody staffed is
-- doing the same job as the seeded row. Invariant #11 is not bent by
-- that — the rule is that no *step-owning* agent may widen its own tool
-- surface, and `system` owns no step. The retired architect row is not
-- matched: 0062 left it on `pipeline_architect` precisely so that
-- nothing keyed on the new role would reach it again.

-- First, the row that has no allowlist at all — the second defect, which
-- hid the first.
--
-- `agents.config` is a whole-object replace on the way in: `agents:save`
-- declared `config` as an open record with `.default({})`, so a caller
-- that sent a partial config silently dropped every key it had not sent.
-- That is how a system agent seeded by 0021 and widened by 0026, 0038,
-- 0047 and 0062 came to hold `{"effort":"xhigh","reasoningEffort":"xhigh"}`
-- and nothing else. The channel is fixed in the same commit as this
-- file; SQL is the only thing that can repair the row already lost.
--
-- 0062 could not do it, and was right not to try: it only widens an
-- array that is already there, guarded on
-- `json_type(config,'$.allowedTools') = 'array'`, because for every
-- other role an absent list means "every advertised tool is already
-- permitted" and writing one would be a narrowing nobody asked for.
--
-- On `system` an absent list does not mean that. It is the role whose
-- capabilities are read off named entries and nothing else:
-- `fullThreadEnabled`, `configToolsEnabled` and `adminToolsEnabled` all
-- answer false to an absent array — that asymmetry is documented in
-- `agent-capabilities.ts` and it fails safe everywhere but here. A
-- system agent with no list is not an unrestricted agent, it is an inert
-- one: no `thread_read`, nothing to read the pipeline with when the
-- Architecture room asks it for a `configure` turn, and no way to
-- express the grant above at all. Writing the list is the only way the
-- role works.
--
-- The list is exactly what 0021, 0026, 0038, 0047 and 0062 produce
-- between them on a fresh install, in the order they added them, plus
-- the grant. No `Write`, `Edit` or `Bash`: 0021 took those away to make
-- "read-only" a fact rather than a sentence in a prompt, and what this
-- agent writes it now writes through `eo_admin`, where every write is a
-- tool a person can see in the catalogue and an entry in `run_events`.
--
-- Guarded on the key being *absent*, not on "is not an array". An
-- `allowedTools` somebody has written as a string is a mistake in their
-- own config and theirs to correct; overwriting it from here would be
-- this migration performing the very whole-object replace it exists to
-- repair. `json_valid` guards the batch as 0061 and 0062 do — one
-- unparseable row is that row's problem rather than an aborted migration
-- and an app that will not open.
UPDATE `agents`
SET `config` = json_set(
	`config`,
	'$.allowedTools',
	json_array(
		'Read',
		'Grep',
		'Glob',
		'mcp__eo__ticket_detail',
		'mcp__eo__attachment_read',
		'mcp__eo__comment_read',
		'mcp__eo__thread_read',
		'mcp__eo__comment_search',
		'mcp__eo__pipeline_list',
		'mcp__eo__pipeline_read',
		'mcp__eo__agents_list',
		'mcp__eo__agent_read',
		'mcp__eo__runtimes_list',
		'mcp__eo_admin'
	)
)
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') IS NULL;
--> statement-breakpoint

-- Then the grant itself, on every system row that does have a list.
--
-- The healthy path: an installation whose config was never replaced
-- already carries the thirteen names above and needs only the
-- fourteenth. Guarded on its own absence for the reason 0047 and 0062
-- were — this may run against a row somebody has already edited, and
-- appending a duplicate is a tool listed twice in a prompt — which is
-- also what makes the pair of statements idempotent: the row repaired
-- above already names the server, so this one steps over it.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo_admin')
WHERE `role` = 'system'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE `value` = 'mcp__eo_admin'
  );
