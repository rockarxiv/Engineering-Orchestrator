/**
 * The app's keychain, as the slice of Electron's `safeStorage` EO uses
 * (KAN-126).
 *
 * The original design is explicit — *"Secrets: OS keychain, never the DB"*
 * — and names `safeStorage`. Everything EO keeps secret goes through
 * this interface: the Jira token (`jira/credentials.ts`), a runtime's
 * API key (`runtimes/apiKey.ts`), a module's named secrets
 * (`modules/secrets.ts`), an attached MCP server's (`mcp/serverSecrets.ts`)
 * and the MCP host's bearer token (`mcpHost/token.ts`). Each of those
 * decides its own file layout under `userData`; what they share is the
 * key, and the key is the OS keychain's.
 *
 * It lived in `jira/credentials.ts`, where the first use was, and moved
 * here when that directory was marked for the developer pack
 * (ARCHITECTURE.md, "The package layout"): the keychain is the app's, not
 * Jira's, and the module host and the runtimes cannot import from a
 * pack.
 *
 * Declared as an interface rather than imported from Electron so tests
 * need no Electron — `safeStorage` satisfies it structurally, and the
 * one place that imports it is the composition root. Nothing here
 * touches SQLite, and nothing here crosses IPC: the renderer is told
 * whether something is configured, never with what.
 */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Which backend Electron actually chose.
   *
   * Optional because it is newer than this interface and only one caller
   * needs it: on Linux `isEncryptionAvailable()` reports true even when
   * safeStorage has fallen back to `basic_text`, which encrypts with a
   * password compiled into Chromium. See `mcpHost/token.ts` for why that
   * distinction matters where a bearer token is concerned.
   */
  getSelectedStorageBackend?(): string;
}
