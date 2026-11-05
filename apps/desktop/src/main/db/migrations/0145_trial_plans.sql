-- A trial's plan (EO-584, ARCHITECTURE.md, "Step modes on a trial").
--
-- How each step of a trial pipeline runs on its test items: real,
-- redirected (trial-only variables and secrets in place of the step's
-- own) or mocked (the step does not run; it reports the result and
-- output the plan names for each test item). JSON in the shape of
-- `TrialPlanSchema`, on the trial's own pipeline row because it is a
-- fact about the trial and goes when the trial does. Null is every step
-- real, which is what a trial nobody has planned does.
ALTER TABLE `pipelines` ADD `trial_plan` text;
--> statement-breakpoint
-- Which live step each of a trial's steps was copied from, by the trial
-- step's id: JSON, `{ [trialStepId]: liveStepId }`. A draft that changes
-- a pipeline names that pipeline's own steps, and the trial gives each a
-- fresh id; this is how a trial step still reads the step's own values
-- (`stepScopeFor`), read-only, so a real step on a trial runs on what the
-- published step runs on. A step the draft invents has no entry, and a
-- trial of a new pipeline has none at all.
ALTER TABLE `pipelines` ADD `trial_step_sources` text;
