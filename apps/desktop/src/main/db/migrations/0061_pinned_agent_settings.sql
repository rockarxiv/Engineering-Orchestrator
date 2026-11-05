-- Makes the stored configs say what the code now does (EO-178).
--
-- Three settings stopped being anybody's choice. `permissionMode`,
-- `sandboxMode` and `approvalPolicy` are written at the spawn site now —
-- `bypassPermissions` in `claude.ts`, `danger-full-access` and `never` in
-- `codex.ts` — with no `config` read at all, because `agents.config` is an
-- open bag that the editor, MCP `agent_save` and anyone holding the SQLite
-- file can write, and a guarantee that can be edited out of a row is not
-- one. Thread reuse stopped being a choice on the four roles EO ships:
-- `reusesThreadPerTicket` answers from the role for those, and the editor
-- draws no checkbox for them.
--
-- So this is not cosmetic. A config bag that still carries
-- `"permissionMode":"plan"` while the process runs on bypass is a row that
-- lies to the next person who reads it, and a `"reuseThreadPerTicket":false`
-- on the implementer is a row that lies about a run that resumes anyway.
-- The behaviour is already decided in code; this is the database agreeing
-- with it.
--
-- Guarded with `json_valid` like 0048: `config` is an open bag, and one
-- unparseable row is that row's problem rather than the batch's — without
-- the guard it aborts the migration and the app will not open at all. Each
-- statement is also guarded on finding something to change, so a row that
-- is already right is left byte for byte alone rather than reformatted by
-- a `json_remove` that had nothing to remove.

-- The implementer keeps one conversation per ticket — 0048's argument,
-- unchanged: dispatched a second time on a ticket it is doing the same work
-- in the same worktree, and a fresh conversation re-reads the codebase to
-- get back where the last one already was.
--
-- `json_set` rather than 0048's `json_insert`, and that is the difference
-- between the two migrations. 0048 wrote only where the key was absent, so
-- somebody who had deliberately turned reuse off kept it off. That
-- restraint was right while this was a checkbox and is wrong now that it is
-- not: the checkbox is gone for this role, so a stored `false` is a
-- preference nothing can act on and nobody can see. `json('true')` rather
-- than `1`, because `reusesThreadPerTicket` takes a literal `true`.
UPDATE `agents`
SET `config` = json_set(`config`, '$.reuseThreadPerTicket', json('true'))
WHERE `role` = 'implementer'
  AND json_valid(`config`)
  AND json_type(`config`, '$.reuseThreadPerTicket') IS NOT 'true';
--> statement-breakpoint
-- The other three shipped roles carry no key at all, which is what an
-- agent nobody has considered the question for already looks like. Off is
-- the answer for each: the product owner and the pipeline architect
-- because nothing made the implementer's case for them, and the reviewer
-- because a reviewer resuming its own thread is re-reading a diff it has
-- already formed an opinion about, which is the one thing a review must
-- not do.
UPDATE `agents`
SET `config` = json_remove(`config`, '$.reuseThreadPerTicket')
WHERE `role` IN ('product_owner', 'reviewer', 'pipeline_architect')
  AND json_valid(`config`)
  AND json_type(`config`, '$.reuseThreadPerTicket') IS NOT NULL;
--> statement-breakpoint
-- Every agent, whatever its role and whatever its provider: a Codex key on
-- a Claude agent was already inert, and both are inert now. Not keyed on
-- the role, because the pin is not — an agent somebody invented spawns
-- through the same two functions.
UPDATE `agents`
SET `config` = json_remove(`config`, '$.permissionMode', '$.sandboxMode', '$.approvalPolicy')
WHERE json_valid(`config`)
  AND (
    json_type(`config`, '$.permissionMode') IS NOT NULL
    OR json_type(`config`, '$.sandboxMode') IS NOT NULL
    OR json_type(`config`, '$.approvalPolicy') IS NOT NULL
  );
