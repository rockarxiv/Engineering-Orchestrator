-- The design a person approved for a trial (EO-587, ARCHITECTURE.md,
-- "Trial pipelines").
--
-- JSON in the shape of `TrialDesignSchema`: the draft and its trial plan
-- as the design card showed them, and which trial step, module and test
-- item each of the draft's became. On the trial's own pipeline row
-- because it is a fact about the trial and goes when the trial does. Null
-- on a trial made without a design card and on every pipeline that is not
-- a trial.
ALTER TABLE `pipelines` ADD `trial_design` text;
