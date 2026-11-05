-- F-06: the queue stopped being about Jira, and tickets grew a pull request.
--
-- J-04 built a durable queue with exactly the properties an outward-facing
-- write needs: written in the same transaction as its cause, ordered,
-- retried with backoff, and giving up loudly rather than silently. A
-- second queue for pull requests would mean a second timer, a second
-- backoff curve, and a second set of the bugs J-04 already found.
ALTER TABLE jira_outbox RENAME TO outbox;
--> statement-breakpoint

ALTER TABLE outbox ADD COLUMN channel TEXT NOT NULL DEFAULT 'jira';
--> statement-breakpoint

-- SQLite carries indexes across a RENAME under their old names, so both
-- are dropped and rebuilt with `channel` leading. Ordering is per
-- (channel, ticket), not per ticket: a Jira outage must not hold up the
-- pull request for the same ticket, which are unrelated systems that
-- would otherwise be coupled by an implementation detail.
DROP INDEX idx_jira_outbox_due;
--> statement-breakpoint
DROP INDEX idx_jira_outbox_ticket;
--> statement-breakpoint
CREATE INDEX idx_outbox_due ON outbox (channel, next_attempt_at, id);
--> statement-breakpoint
CREATE INDEX idx_outbox_ticket ON outbox (channel, ticket_id, id);
--> statement-breakpoint

-- The pull request EO opened. Null is the ordinary state; set once and
-- never overwritten, because it is what stops a second one being opened
-- for the same ticket.
ALTER TABLE tickets ADD COLUMN pr_url TEXT;
--> statement-breakpoint

-- Which pipeline stage produces a pull request. Data, not a constant
-- (invariant #7): a pipeline whose second terminal state means
-- "abandoned" leaves this 0. Deliberately not keyed off is_terminal,
-- which would open a pull request for work someone gave up on.
ALTER TABLE workflow_states ADD COLUMN opens_pull_request INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE workflow_states SET opens_pull_request = 1 WHERE id = 'ready_to_merge';
--> statement-breakpoint

-- Per repository. Off by default: opening a pull request is an
-- outward-facing action on a repository other people share, and an
-- upgrade must not start doing it unasked.
ALTER TABLE projects ADD COLUMN forge_open_pr INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- NULL means "work it out from the remote". An explicit value overrides
-- a wrong guess, which self-hosted hostnames guarantee eventually.
ALTER TABLE projects ADD COLUMN forge_kind TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN forge_remote TEXT NOT NULL DEFAULT 'origin';
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN forge_draft INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Only needed for a template directory holding several choices, where
-- there is no correct automatic answer.
ALTER TABLE projects ADD COLUMN forge_template_path TEXT;
