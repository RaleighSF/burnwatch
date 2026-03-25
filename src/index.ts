/**
 * burnwatch — Passive cost memory for vibe coding
 *
 * Detects paid services, tracks spend, injects budget context
 * into your AI coding sessions.
 */

export type {
  ConfidenceTier,
  BillingModel,
  ScalingShape,
  ServiceDefinition,
  TrackedService,
  DetectionSource,
  SpendSnapshot,
  SpendBrief,
  SpendAlert,
  LedgerEntry,
  SpendEvent,
  PlanTier,
  ServiceRiskCategory,
  CostImpact,
} from "./core/types.js";

export { CONFIDENCE_BADGES } from "./core/types.js";

export {
  loadRegistry,
  getService,
  getAllServices,
} from "./core/registry.js";

export {
  detectServices,
  detectMentions,
  detectInFileChange,
} from "./detection/detector.js";

export {
  formatBrief,
  formatSpendCard,
  buildBrief,
  buildSnapshot,
} from "./core/brief.js";

export {
  writeLedger,
  logEvent,
  readRecentEvents,
  saveSnapshot,
  readLatestSnapshot,
} from "./core/ledger.js";

export {
  globalConfigDir,
  projectConfigDir,
  projectDataDir,
  readGlobalConfig,
  writeGlobalConfig,
  readProjectConfig,
  writeProjectConfig,
  ensureProjectDirs,
  isInitialized,
} from "./core/config.js";

export {
  analyzeCostImpact,
  formatCostImpactCard,
} from "./cost-impact.js";
