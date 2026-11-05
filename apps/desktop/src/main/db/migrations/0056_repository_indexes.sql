-- What EO knows about a repository index, and deliberately nothing more
-- (EO-145).
--
-- The index itself is a graph of symbols, callers, callees, imports and
-- inheritance, built by an external tool and living in a directory on
-- disk. None of it is here, and none of it ever will be. Derived state
-- does not go in `eo.db`: the graph is a cache of what the source
-- already says, it can be rebuilt from the checkout in seconds, and a
-- copy of it in this database would be a second thing to keep in step
-- with the working tree for no benefit anyone could name.
--
-- What is here is the note saying such a directory exists: where it is,
-- what built it, which commit it was built from, and whether it can be
-- trusted right now. That note is worth durability because it is what
-- lets a relaunch tell "there is a usable index in this worktree" from
-- "there is a directory of unknown provenance in this worktree", which
-- is not a question the filesystem can answer.
--
-- Three shapes in this table were decided rather than defaulted.
--
-- `repository_id` and not `project_id`. `project_repositories` is
-- many-to-many, and a story carries `tickets.repositoryId` while a
-- feature does not. Keying on project would index a shared repository
-- once per project and then leave a story with no way to find the index
-- that describes the code it is about to change.
--
-- `ticket_id` is nullable and nothing in this version writes anything
-- but a value to it. NULL is reserved to mean the repository's own
-- baseline. It is here now, unused, so that adding a baseline later is
-- an INSERT rather than a migration that changes what every existing row
-- means -- the cheapest column in the schema to add today and the most
-- expensive to retrofit.
--
-- `provider_version` is a version and there is no logic that reads it.
-- That is the point. An index is disposable, so version skew is
-- answered by throwing the directory away and building it again; a
-- stored version that differs from the resolved binary marks the row
-- STALE and the rebuild does the rest. Nothing in this codebase will
-- ever migrate an index, which is why nothing needs to know the shape
-- of an old one.
--
-- No UNIQUE index, and not by oversight. The rule is one row per
-- (repository, ticket), but SQLite treats NULLs as distinct in a unique
-- index, so the baseline rows this table is shaped to accept later
-- would not be constrained by one -- expressing the rule properly needs
-- two partial indexes for a table that holds one row per live worktree.
-- `db/repos/repositoryIndexesRepo.ts` is the only write path and is
-- where the rule is enforced instead.
--
-- Both foreign keys cascade. A repository EO no longer knows about, or
-- a ticket that has been deleted (EO-30), leaves behind a directory
-- somewhere and a row describing it; keeping the row would give the
-- next reader a note about an index nobody can act on. Deleting it is
-- not a rewrite of history in the sense invariant #3 protects -- this
-- table records the state of a cache, not what happened.
CREATE TABLE `repository_indexes` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL REFERENCES `repositories`(`id`) ON DELETE cascade,
	-- NULL is the repository's own baseline. See the note above.
	`ticket_id` text REFERENCES `tickets`(`id`) ON DELETE cascade,
	-- Which implementation built it, as an opaque identifier. Stored
	-- rather than assumed: an index built by one implementation is not
	-- readable by another, so a row naming a provider that is no longer
	-- configured is not a stale index -- it is somebody else's, and the
	-- answer is to remove it rather than to sync it.
	`provider` text NOT NULL,
	-- The directory holding the graph. Absolute, and owned by whatever
	-- wrote it; EO's only claims on it are that it may be deleted and
	-- that deleting it costs nothing but CPU.
	`index_path` text NOT NULL,
	-- not_indexed | indexing | ready | updating | stale | failed. Which
	-- moves between them are legal is in
	-- `main/repositoryIntelligence/transitions.ts`, not in a CHECK
	-- constraint: the rule is a graph with reasons attached and SQLite
	-- can only express the value set, which is the half that never goes
	-- wrong.
	`status` text NOT NULL,
	-- The commit the index was built from, when the provider records
	-- one. Advisory: what makes an index current is a sync, not this.
	`indexed_commit_sha` text,
	-- When a build last succeeded, as against when this row last moved.
	`indexed_at` integer,
	`updated_at` integer,
	`provider_version` text,
	-- Why the last attempt failed, in the words shown to a person.
	-- Repository intelligence degrades rather than blocks (EO-141), so
	-- this is read far more often as an explanation than as an error.
	`error_message` text
);
