-- What this desktop still owes a project it has only just heard of
-- (EO-325).
--
-- `record:changes` pages every list strictly forwards on when its rows
-- were written, which is exactly right for a record that only grows
-- forwards, and wrong for the one thing that does not arrive in order.
-- A project moved to the record brings its whole history with the dates
-- it actually happened on; a desktop that has been syncing that record
-- for a month has cursors far past those dates, so it takes the project
-- row and never asks for a single item behind it.
--
-- Restamping the history on the way up would have fixed the paging and
-- lied about the work: a comment written in March is a comment written
-- in March. So the desktop asks a second time instead, scoped to the
-- project, on the cursors kept here — which start at the beginning,
-- because with respect to this project that is where it stands.
--
-- One row per project per desktop, and `done_at` is the whole state
-- machine: null while it is still owed, stamped once a scoped page came
-- back saying there was no more. Nothing reads a finished row except
-- the check that stops it being started again.
create table record_backfills (
  project_id text primary key not null references projects(id) on delete cascade,
  cursors text not null,
  created_at integer not null,
  done_at integer
);
--> statement-breakpoint
create index record_backfills_outstanding on record_backfills(done_at) where done_at is null;
