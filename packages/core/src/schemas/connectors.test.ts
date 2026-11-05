import { describe, expect, it } from "vitest";
import {
  ConnectorSetupSchema,
  connectorConnected,
  connectorSetupProblems,
  connectorProblem,
  type ConnectorSetup,
} from "./connectors.js";

/**
 * A connector is an MCP server with a setup flow (EO-315,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * The rules here are read in three places — the step's reach list,
 * Settings and the needs check — so the tests are about the *answers*
 * rather than about the screens: whether a line is green, and what its
 * red version says.
 */
function setup(overrides: Partial<ConnectorSetup> = {}): ConnectorSetup {
  return ConnectorSetupSchema.parse({
    label: "Slack",
    kind: "token",
    secretNames: ["SLACK_BOT_TOKEN"],
    ...overrides,
  });
}

describe("whether a connector is connected", () => {
  it("is connected once every declared secret has a value", () => {
    expect(connectorConnected(setup(), ["SLACK_BOT_TOKEN"])).toBe(true);
    expect(connectorProblem(setup(), ["SLACK_BOT_TOKEN"])).toBeNull();
  });

  it("is disconnected while any is missing, and says which", () => {
    const two = setup({ secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] });

    expect(connectorConnected(two, ["SLACK_BOT_TOKEN"])).toBe(false);
    // The name, not "not connected": a person with half of a two-value
    // connector has to be told which half.
    expect(connectorProblem(two, ["SLACK_BOT_TOKEN"])).toBe("Slack is not connected yet — EO still needs SLACK_TEAM_ID.");
  });

  it("says sign in rather than paste when the kind is oauth", () => {
    const oauth = setup({
      kind: "oauth",
      secretNames: ["SLACK_TOKEN"],
      oauth: { authorizeUrl: "https://slack.test/authorize", tokenUrl: "https://slack.test/token", clientId: "eo", scopes: [], tokenSecretName: "SLACK_TOKEN" },
    });

    expect(connectorProblem(oauth, [])).toBe("Slack is not connected yet — signing in stores SLACK_TOKEN.");
  });

  /**
   * Not a special case for `none`, and the test says so: "every name it
   * asked for has a value" is vacuously true of a connector that asked
   * for nothing, which is why there is no branch on the kind.
   */
  it("is connected when it declares no secret, whatever the kind", () => {
    const nothing = setup({ kind: "none", secretNames: [] });

    expect(connectorConnected(nothing, [])).toBe(true);
    expect(connectorProblem(nothing, [])).toBeNull();
  });
});

describe("what makes a definition well-formed", () => {
  it("accepts one a pack would ship", () => {
    expect(connectorSetupProblems(setup())).toEqual([]);
  });

  it("refuses a connector with nothing to put on its button", () => {
    expect(connectorSetupProblems(setup({ label: " " }))).toEqual(["A connector needs a name to put on its Connect button."]);
  });

  it("refuses a secret name that could not be an environment variable", () => {
    // Held to the same shape `mcpServers.ts` holds `envNames` to, and
    // for the sharper reason written there: a name becomes a filename
    // under the secrets directory, and the path builder refuses anything
    // else by throwing.
    expect(connectorSetupProblems(setup({ secretNames: ["1TOKEN"] }))).toEqual([
      '"1TOKEN" is not an environment-variable name: use letters, digits and underscores, not starting with a digit.',
    ]);
  });

  it("refuses the same name twice", () => {
    expect(connectorSetupProblems(setup({ secretNames: ["TOKEN", "TOKEN"] }))).toEqual([
      '"TOKEN" is listed twice — one name holds one value.',
    ]);
  });

  it("refuses a token connector with nothing to paste into", () => {
    expect(connectorSetupProblems(setup({ secretNames: [] }))).toEqual([
      '"Slack" is connected by pasting a value, but declares no secret to paste it into.',
    ]);
  });

  it("refuses an oauth connector that says nothing about where", () => {
    expect(connectorSetupProblems(setup({ kind: "oauth" }))).toEqual([
      '"Slack" signs in with OAuth but says nothing about where — it needs an authorize URL, a token URL and a client id.',
    ]);
  });

  /**
   * The failure this one catches is the quiet one: a flow that completes,
   * a token stored under a name nothing reads, and a line that stays red
   * after a successful sign-in.
   */
  it("refuses an oauth connector storing its token under a name it does not declare", () => {
    const wrong = setup({
      kind: "oauth",
      secretNames: ["SLACK_BOT_TOKEN"],
      oauth: {
        authorizeUrl: "https://slack.test/authorize",
        tokenUrl: "https://slack.test/token",
        clientId: "eo",
        scopes: [],
        tokenSecretName: "SLACK_USER_TOKEN",
      },
    });

    // Both halves of the mismatch, because they are two different things
    // to fix: the token has nowhere declared to go, and the name that
    // *is* declared is one nothing could fill.
    expect(connectorSetupProblems(wrong)).toEqual([
      '"SLACK_USER_TOKEN" is where the token would be stored, but it is not one of the secrets "Slack" declares.',
      '"Slack" signs in with OAuth, which stores one value — so it cannot also ask for SLACK_BOT_TOKEN. ' +
        "A connector that needs a value somebody types is a `token` connector.",
    ]);
  });

  /**
   * The failure this keeps out of somebody's needs check: a connector
   * that signs in successfully and stays red on a name the sign-in never
   * produces and no box exists to type. A red line with no button that
   * fixes it is the one thing the design says a red line
   * may never be.
   */
  it("refuses an oauth connector that asks for anything beside its token", () => {
    const withExtra = setup({
      kind: "oauth",
      secretNames: ["SLACK_TOKEN", "SLACK_TEAM_ID"],
      oauth: { authorizeUrl: "https://slack.test/authorize", tokenUrl: "https://slack.test/token", clientId: "eo", scopes: [], tokenSecretName: "SLACK_TOKEN" },
    });

    expect(connectorSetupProblems(withExtra)).toEqual([
      '"Slack" signs in with OAuth, which stores one value — so it cannot also ask for SLACK_TEAM_ID. ' +
        "A connector that needs a value somebody types is a `token` connector.",
    ]);
  });

  /**
   * The other unfixable red line, from the other end: `none` draws no
   * button — a Connect that did nothing is the control invariant 12
   * rules out — so a `none` connector needing a value could never be
   * turned green.
   */
  it("refuses a `none` connector that needs a value, since nothing would set it", () => {
    expect(connectorSetupProblems(setup({ kind: "none", secretNames: ["SLACK_BOT_TOKEN"] }))).toEqual([
      '"Slack" has nothing to connect, so it cannot need SLACK_BOT_TOKEN — there would be no button to set them with. ' +
        "Say `token` or `oauth` if it needs a value.",
    ]);
  });

  /**
   * Blank was the only thing refused until review, which left a typo
   * passing every gate and then throwing out of `new URL` at the moment
   * somebody clicked Connect — a pack author's mistake surfacing as an
   * exception in front of the person who installed it.
   */
  it("refuses an oauth URL that is not one, not only an empty one", () => {
    const malformed = (authorizeUrl: string, tokenUrl: string) =>
      connectorSetupProblems(
        setup({
          kind: "oauth",
          secretNames: ["SLACK_TOKEN"],
          oauth: { authorizeUrl, tokenUrl, clientId: "eo", scopes: [], tokenSecretName: "SLACK_TOKEN" },
        }),
      );

    expect(malformed("slack.test/authorize", "https://slack.test/token")).toEqual([
      'The URL the person is sent to is not a URL — "slack.test/authorize" has to start with http:// or https://.',
    ]);
    expect(malformed("https://slack.test/authorize", "ftp://slack.test/token")).toEqual([
      'The URL the code is exchanged at has to be http or https — "ftp://slack.test/token" is ftp.',
    ]);
    expect(malformed("https:///authorize", "https://slack.test/token")).toEqual([
      'The URL the person is sent to has no host in it — "https:///authorize".',
    ]);
    expect(malformed("", "")).toEqual([
      "An OAuth connector needs the URL the person is sent to.",
      "An OAuth connector needs the URL the code is exchanged at.",
    ]);
  });

  it("accepts a `none` connector with nothing but words", () => {
    expect(connectorSetupProblems(setup({ kind: "none", secretNames: [] }))).toEqual([]);
  });

  it("accepts an oauth connector that declares exactly the one its sign-in stores", () => {
    const good = setup({
      kind: "oauth",
      secretNames: ["SLACK_TOKEN"],
      oauth: { authorizeUrl: "https://slack.test/authorize", tokenUrl: "https://slack.test/token", clientId: "eo", scopes: ["chat:write"], tokenSecretName: "SLACK_TOKEN" },
    });

    expect(connectorSetupProblems(good)).toEqual([]);
  });
});
