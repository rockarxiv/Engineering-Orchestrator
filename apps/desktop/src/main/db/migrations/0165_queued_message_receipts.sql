-- Which queued messages the record has already written (EO-729).
--
-- A desktop queues a message it owes a person — a job's budget trip on
-- an item the organisation's record holds — as a `sendMessage` record
-- command, and the drain sends it until the record acknowledges it. An
-- acknowledgement can be lost, so the record must know a replay when it
-- sees one. The message itself cannot say so: once it is handled it is
-- deleted after 7 days or past the 100-handled cap, and a replay after
-- that would write it again, open. So the id the desktop minted is kept
-- here, written with the message and never swept.
CREATE TABLE `queued_message_receipts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL
);
