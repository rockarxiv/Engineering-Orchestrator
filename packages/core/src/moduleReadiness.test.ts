import { describe, expect, it } from "vitest";
import { ModuleReadinessSchema, moduleReadinessProblems, moduleReadinessRefusal, type ModuleReadiness } from "./moduleReadiness.js";

describe("module readiness sentences (EO-816)", () => {
  const notReady: ModuleReadiness = {
    ready: false,
    bin: [
      { name: "gh", status: "missing" },
      { name: "jq", status: "missing" },
      { name: "git", status: "found" },
    ],
    env: [
      { name: "FLY_API_TOKEN", status: "unset" },
      { name: "DEPLOY_KEY", status: "unreadable" },
      { name: "JAVA_HOME", status: "dangling", variable: "JDK21_HOME" },
      { name: "SLACK_WEBHOOK", status: "withheld" },
      { name: "REGION", status: "set" },
    ],
  };

  it("names everything missing in one refusal, and nothing that is there", () => {
    const refusal = moduleReadinessRefusal("Deploy", notReady)!;
    expect(refusal.startsWith('"Deploy" was not run, because it is not ready on this machine: ')).toBe(true);
    expect(refusal).toContain("gh and jq are not installed");
    expect(refusal).toContain("FLY_API_TOKEN is not set");
    expect(refusal).toContain("EO cannot read DEPLOY_KEY");
    expect(refusal).toContain("JAVA_HOME from its environment variable JDK21_HOME");
    expect(refusal).toContain("SLACK_WEBHOOK is set on the step but not for its trial");
    expect(refusal).not.toContain("git");
    expect(refusal).not.toContain("REGION");
    expect(moduleReadinessProblems(notReady)).toHaveLength(5);
  });

  it("refuses nothing when every prerequisite is there", () => {
    expect(moduleReadinessRefusal("Deploy", { ready: true, bin: [{ name: "gh", status: "found" }], env: [{ name: "REGION", status: "set" }] })).toBeNull();
  });

  it("has no field for a value", () => {
    expect(ModuleReadinessSchema.parse({ ...notReady, env: [{ name: "REGION", status: "set", value: "eu" }] }).env[0]).toEqual({ name: "REGION", status: "set" });
  });
});
