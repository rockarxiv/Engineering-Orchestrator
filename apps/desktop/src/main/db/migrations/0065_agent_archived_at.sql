-- Retiring an agent is archiving it, not switching it off (EO-186).
--
-- 0062 retired the pipeline architect with `enabled = 0` and kept the
-- row, and keeping the row was right: it is referenced by 2 runs, the 5
-- comments it authored and the 2 mentions that named it, so deleting it
-- would strip authorship from real comments in real threads — the loss
-- invariant #3 exists to prevent.
--
-- What it left behind is a row with nowhere to belong. `enabled` means
-- "not right now": a person switches an agent off to stop it being
-- dispatched and switches it back on later. Retired means "this is over,
-- keep it for the record", and every other catalogue in EO already draws
-- that line with `archived_at` — `pipelines`, `modules`, `mcp_servers`
-- and `skills` all carry one and all archive rather than delete.
-- `agents` is the one that never got it, which is why the architect
-- renders on the Agents screen as one of the person's own agents,
-- complete with the controls a live agent gets.
--
-- Nothing here removes anything. The architect's runs, comments and
-- mentions are untouched, and the comments still show it as their
-- author: `listAgents` goes on returning archived rows precisely so that
-- the name behind an old run or an old comment still resolves. What
-- changes is where the row is offered — not dispatched, not counted as
-- staffing a role, not in the step-owner picker, not on the Agents
-- screen unless you ask for it.
ALTER TABLE `agents` ADD COLUMN `archived_at` integer;
--> statement-breakpoint

-- The architect row, retired for the second and last time.
--
-- By id rather than by role, exactly as 0062 did it: 0036 seeded this
-- row, and an agent somebody created on that role themselves is theirs
-- to keep, disable or archive.
--
-- `enabled = 0` is left as it is rather than being tidied up. The two
-- columns say different things — `isDispatchable` requires both, and a
-- row that is archived while still enabled is one somebody archived
-- while it was working fine — so rewriting the switch here would erase
-- what 0062 recorded about this agent and gain nothing.
--
-- Guarded on `archived_at IS NULL` because this is an UPDATE against a
-- row a person may already have archived by hand on a build where the
-- column existed; their timestamp is the true one and is kept.
--
-- `strftime` rather than a constant: this says when the row was
-- archived, and the only moment this database can honestly claim is the
-- one the migration runs in. `strftime('%s','now')` rather than
-- `unixepoch()` for portability across SQLite versions, `* 1000` because
-- every timestamp in this schema is milliseconds.
UPDATE `agents`
SET `archived_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `id` = '019fb8c6-de92-7a41-9c33-4471f0c2b1de'
  AND `archived_at` IS NULL;
