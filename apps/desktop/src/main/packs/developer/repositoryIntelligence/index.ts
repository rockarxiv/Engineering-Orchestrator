/**
 * Repository intelligence: a queryable description of a checkout that
 * an agent navigates instead of grepping (EO-141, EO-145).
 *
 * This is the whole public face of the subsystem. Everything outside
 * this directory imports from here and gets a port, a service, a model,
 * the switch that decides whether any of it runs at all (EO-148), the
 * answer to whether a dispatch gets a query server (EO-151), the sync
 * that runs where an item's work changes hands (EO-153), the decision
 * that turns an agent's broad `grep -rn` into a sentence naming the call
 * that answers it (EO-165) and — for EO's own cleanliness checks —
 * where an index sits on disk and how to dispose of one, never an
 * implementation.
 * `architecturalInvariants.test.ts` beside this file is what keeps that
 * true once nobody is watching.
 */
export {
  type RepositoryIndex,
  type RepositoryIndexBuild,
  type RepositoryIndexProbe,
  type RepositoryIndexQueryServer,
  type RepositoryIndexRemoval,
  type RepositoryIndexStatus,
  type RepositoryIndexTarget,
  type RepositoryIntelligenceProvider,
} from "./port.js";
export { canTransitionIndex, refuseIndexTransition, LEGAL_INDEX_TRANSITIONS } from "./transitions.js";
export { discardRepositoryIndexes, isRepositoryIndexPath, withoutRepositoryIndex, type StubbornRepositoryIndex } from "./indexPaths.js";
export {
  DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG,
  readRepositoryIntelligenceConfig,
  repositoryIntelligenceFingerprint,
  REPOSITORY_INTELLIGENCE_ENABLED_KEY,
  REPOSITORY_INTELLIGENCE_PROVIDER_KEY,
  writeRepositoryIntelligenceConfig,
} from "./gate.js";
export {
  createRepositoryIntelligenceService,
  type RepositoryIndexOutcome,
  type RepositoryIntelligenceService,
  type RepositoryIntelligenceServiceDeps,
} from "./service.js";
export {
  repositoryQueryServerFor,
  type RepositoryQueryServerDelivery,
  type RepositoryQueryServerRequest,
} from "./agentServer.js";
export {
  syncRepositoryIndexAtHandover,
  type RepositoryHandoverSync,
  type RepositoryHandoverSyncRequest,
} from "./handover.js";
export { sayable } from "./sayable.js";
export {
  broadSearchIn,
  broadSearchInCommand,
  nudgeFor,
  repositorySearchNudge,
  type BroadSearch,
  type BroadSearchKind,
  type NudgeRequest,
  type SearchCandidate,
  type SearchInterception,
} from "./broadSearch.js";
export {
  fallbackRepositoryIntelligenceRoot,
  repositoryIntelligenceFor,
  repositoryIntelligenceRoot,
  REPOSITORY_INDEX_DIRECTORIES,
  type RepositoryIntelligenceFactory,
  type RepositoryIntelligenceOptions,
  type RepositoryIntelligenceRuntime,
} from "./composition.js";
