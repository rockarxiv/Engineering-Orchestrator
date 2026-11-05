-- The implementer keeps its conversation between dispatches on one ticket.
--
-- `reuseThreadPerTicket` decides whether a dispatch carries on the agent's
-- existing provider conversation or opens a new one, and it has shipped off
-- for every role — the implementer seeded with `config = '{}'` by 0001. That
-- is the wrong default for the one role it was written for: an implementer
-- dispatched a second time on a ticket, after a review bounce or a
-- clarification, is doing the same work in the same worktree, and a fresh
-- conversation has to re-read the codebase to get back to where the last one
-- already was. Resumed, it is sent the task line and the comments it has not
-- seen and keeps everything it had worked out.
--
-- The trade, since it is a real one and belongs here rather than in
-- somebody's memory. A resumed thread carries its whole transcript, and the
-- backend re-sends that transcript on every turn, so a ticket that bounces
-- several times accumulates one long conversation that costs more per turn
-- as it grows — measured on this install, a second implement run cost
-- roughly twice per turn what the first did. What it buys back is the
-- re-reading, which a fresh conversation pays for in full every time, and a
-- follow-up prompt of a few hundred tokens where a fresh seed is tens of
-- thousands. For the implementer that trade is worth taking; this migration
-- says nothing about any other role, and the switch is still a checkbox
-- anyone can clear.
--
-- Restrained the way 0026, 0038 and 0047 are: written only where the key is
-- absent, so somebody who deliberately turned this *off* keeps it off, and
-- somebody who already turned it on is not rewritten at all. `json_valid`
-- because a config that will not parse is one row's problem and must not
-- abort the batch. `json('true')` rather than `1`: `reusesThreadPerTicket`
-- takes a literal `true` and reads an integer as off.
UPDATE `agents`
SET `config` = json_insert(`config`, '$.reuseThreadPerTicket', json('true'))
WHERE `role` = 'implementer'
  AND json_valid(`config`)
  AND json_type(`config`, '$.reuseThreadPerTicket') IS NULL;
