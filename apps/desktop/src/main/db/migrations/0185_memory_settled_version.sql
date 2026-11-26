-- EO-913: a scheduled consolidation sends only what is new since the
-- scope's last finished run, and a project moved to an organisation's
-- record arrives with none of its consolidation history while finalising
-- the move stamps every entry it brought as changed. The sender says which
-- entries its last consolidation had settled; this holds, on the record,
-- the version (`updated_at`) of each such entry as it arrived, and from the
-- move's finalisation on that moment, so the record can tell an entry the
-- handover only carried from one written or changed since. Null on every
-- entry no move settled.
ALTER TABLE `memories` ADD `settled_version` integer;
