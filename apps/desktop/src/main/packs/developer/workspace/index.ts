export {
  branchExists,
  canonicalPath,
  checkGitAvailable,
  currentBranch,
  git,
  isGitRepo,
  listWorktrees,
  samePath,
  statusPorcelain,
  type WorktreeEntry,
} from "./git.js";
export { createImplementationVerifier } from "./implementationVerifier.js";
export { resolveRemoteRef, type RemoteRefResolution, type RemoteRefResolver } from "./remoteRef.js";
export { baseRefFor, branchFor, resolveItemStackTarget } from "./stackTarget.js";
export { runCommand, type CommandOutcome, type RunCommandOptions } from "../../../process/runCommand.js";
export {
  formatVerificationComment,
  verifyImplementation,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS,
  type CheckCommands,
  type VerificationResult,
  type VerificationStep,
  type VerifyOptions,
} from "./verify.js";
export {
  createWorktreeWorkspace,
  forgetIndexesForReleasedWorktrees,
  releaseStaleWorktrees,
  releaseWorktree,
  worktreeConfigFor,
  type FailedWorktreeRelease,
  type PrepareWorkspaceResult,
  type WorktreeCleanupSummary,
} from "./dispatchWorkspace.js";
export {
  branchNameFor,
  checkRepoReady,
  createWorktree,
  defaultWorktreeRoot,
  ensureWorktree,
  listStaleWorktrees,
  removeWorktree,
  worktreePathFor,
  type CreatedWorktree,
  type RemovalRefusal,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  type StaleWorktree,
  type StartPointResolver,
  type WorktreeConfig,
  type WorktreeResult,
} from "./worktrees.js";
