-- Whoever already had the whole thread keeps it.
--
-- `ticket_detail` used to return a ticket *and every comment on it*, and this
-- is the release where that stops being true: it answers with the ticket
-- alone, and the unbounded read moves to `thread_read`. So this is not a new
-- grant — it is the same capability under the name it now goes by, added
-- wherever the old one is already named.
--
-- The grant is also what decides the *prompt*. A step-owning agent is seeded
-- with the newest word from each step and searches for the rest; an agent
-- that can read the whole thread with a tool is handed the whole thread
-- inlined, because for it — the product owner in Discussions, the architect
-- in a configure chat — the conversation is the work rather than context
-- about it. One predicate answers both questions, so a prompt cannot promise
-- a tool the agent does not have.
--
-- Named on the role as well as the tool, which 0038 did not have to do.
-- 0038 granted `comment_read`, a strictly bounded subtree read, to whoever
-- had `ticket_detail`; granting the *unbounded* read on that same predicate
-- is not the same restraint. Somebody who narrowed their implementer with an
-- explicit allowlist — a natural way to take `Bash` away — happens to name
-- `mcp__eo__ticket_detail` in it, and would have been handed whole threads
-- again on upgrade: the 60k dispatch this release exists to end, restored
-- silently, on the very role it is about. The product owner is who this is
-- for, and who the commit says it is for.
--
-- Otherwise as restrained as 0038 and 0026: a config somebody has edited
-- keeps whatever they made it. The implementer and reviewer ship with `config = '{}'`, which
-- names no allowlist at all and therefore already permits every advertised
-- tool — they are untouched here and stay seeded, which is the point.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__thread_read')
WHERE `role` = 'product_owner'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__ticket_detail'
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__thread_read'
  );
--> statement-breakpoint

-- The architect, which 0038 deliberately left with no ticket read at all.
--
-- A `configure` conversation is held in a ticket's thread — the chat *is* the
-- comments — so an architect that cannot read a thread cannot see what it is
-- being asked. It has been working from the assembled context alone, which is
-- fine while the context carries the thread and is not fine the moment that
-- becomes a capability question. Named on the role because that is what the
-- seeded row is keyed on, and guarded on the tool being absent so a config
-- somebody has already extended is left alone.
UPDATE `agents`
SET `config` = json_insert(json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__ticket_detail'), '$.allowedTools[#]', 'mcp__eo__thread_read')
WHERE `role` = 'pipeline_architect'
  AND json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__thread_read'
  );
--> statement-breakpoint

-- `comment_search` to anyone who names a ticket read.
--
-- Unlike `thread_read` this one is safe to spread: it is bounded — ids,
-- kinds and short excerpts, never bodies and never reply trees — and every
-- `ticket_detail` answer now ends by telling the reader to use it, so an
-- allowlist that omits it is a tool advertised, recommended and then
-- refused. An agent with no allowlist already has it, since an absent list
-- permits everything advertised.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.allowedTools[#]', 'mcp__eo__comment_search')
WHERE json_valid(`config`)
  AND json_type(`config`, '$.allowedTools') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__ticket_detail'
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(`agents`.`config`, '$.allowedTools'))
    WHERE value = 'mcp__eo__comment_search'
  );
