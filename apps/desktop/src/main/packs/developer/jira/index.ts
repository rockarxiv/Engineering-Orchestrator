import { createCloudClient } from "./cloud.js";
import { createDataCenterClient } from "./dataCenter.js";
import type { FetchLike, JiraClient, JiraConnection } from "./client.js";

export * from "./client.js";
export { toAdf, fromAdf } from "./cloud.js";

/**
 * The client for a connection (J-01).
 *
 * `fetchImpl` defaults to the global — Node 22 has one, which is why
 * this integration adds no dependency — and is a parameter so tests
 * never reach the network.
 */
export function createJiraClient(connection: JiraConnection, fetchImpl: FetchLike = fetch): JiraClient {
  return connection.flavour === "cloud" ? createCloudClient(connection, fetchImpl) : createDataCenterClient(connection, fetchImpl);
}
