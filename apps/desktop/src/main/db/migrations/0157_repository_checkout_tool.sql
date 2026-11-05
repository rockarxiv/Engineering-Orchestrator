-- An allowlist is exhaustive, so a tool that is registered and not named in
-- one is a tool the agent is offered and then refused — the gap 0112 closed
-- for `attachment_add`.
--
-- `repository_checkout` (EO-633) checks out a branch of a repository on the
-- ticket's project for the run to read. Added only where
-- `mcp__eo__attachment_read` already is, as 0112 did: an agent that may read
-- a ticket's files is one that works on tickets, and granting the tool
-- anywhere else would be reach the agent never had. An agent with no
-- allowlist is not narrowed and needs nothing.
--
-- Once: the NOT EXISTS is what makes running this over a list that already
-- names it a no-op, so a database migrated twice, or an agent somebody
-- edited by hand first, ends up naming it exactly one time.
--
-- `json_valid` guards the batch as 0112 does: one unparseable row is that
-- row's problem rather than an aborted migration and an app that will not
-- open.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__repository_checkout')
WHERE json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__attachment_read'
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__repository_checkout'
  );
