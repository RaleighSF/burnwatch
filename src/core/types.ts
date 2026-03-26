/**
 * Confidence tiers for spend tracking.
 *
 * LIVE  — Real billing API data
 * CALC  — Fixed monthly cost, user-entered
 * EST   — Estimated from usage signals + pricing formula
 * BLIND — Detected in project, no tracking configured
 */
export type ConfidenceTier = "live" | "calc" | "est" | "blind" | "excluded";

export const CONFIDENCE_BADGES: Record<ConfidenceTier, string> = {
  live: "✅ LIVE",
  calc: "🟡 CALC",
  est: "🟠 EST",
  blind: "🔴 BLIND",
  excluded: "⬚ SKIP",
};

/** How a service charges — determines tracking strategy. */
export type BillingModel =
  | "token_usage" // Per-token (Anthropic, OpenAI, Gemini)
  | "credit_pool" // Fixed credit bucket (Scrapfly)
  | "per_unit" // Per-email, per-session, per-command (Resend, Browserbase, Upstash)
  | "percentage" // Percentage of transaction (Stripe)
  | "flat_monthly" // Fixed monthly subscription (PostHog, Inngest free tier)
  | "tiered" // Free up to X, then jumps (PostHog, Supabase)
  | "compute" // Compute-time based (Vercel, AWS)
  | "unknown";

/** How cost scales — helps the agent reason about future spend. */
export type ScalingShape =
  | "linear" // Each unit costs the same
  | "linear_burndown" // Fixed pool, each use depletes it
  | "tiered_jump" // Free until threshold, then expensive
  | "percentage" // Proportional to revenue/volume
  | "fixed" // Flat monthly, no scaling
  | "unknown";

/** A plan tier option for a service in the registry. */
export interface PlanTier {
  /** Human-readable plan name */
  name: string;
  /** Plan type: usage (pay-as-you-go), flat (fixed monthly), exclude (don't track) */
  type: "usage" | "flat" | "exclude";
  /** Monthly base cost for flat plans */
  monthlyBase?: number;
  /** Suggested starting budget for usage plans (reasonable dev-stage default) */
  suggestedBudget?: number;
  /** Whether this plan requires an API key for tracking */
  requiresKey?: boolean;
  /** Whether this is the default/most common plan */
  default?: boolean;
  /** Included units for credit-pool plans (e.g., 1M credits on Scrapfly Pro) */
  includedUnits?: number;
  /** Unit name for credit-pool plans (e.g., "credits", "sessions") */
  unitName?: string;
}

/** Risk category for service grouping in interactive init. */
export type ServiceRiskCategory = "llm" | "usage" | "infra" | "flat";

/** A service definition from the registry. */
export interface ServiceDefinition {
  /** Unique service identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Package names in npm/pip that indicate this service */
  packageNames: string[];
  /** Env var patterns that indicate this service */
  envPatterns: string[];
  /** Import patterns to scan for (regex strings) */
  importPatterns: string[];
  /** Keywords that indicate mentions in prompts */
  mentionKeywords: string[];
  /** Billing model */
  billingModel: BillingModel;
  /** How cost scales */
  scalingShape: ScalingShape;
  /** What tier of tracking is available */
  apiTier: ConfidenceTier;
  /** Billing API endpoint, if available */
  apiEndpoint?: string;
  /** Pricing details */
  pricing?: {
    /** Human-readable formula */
    formula?: string;
    /** Rate per unit, if applicable */
    unitRate?: number;
    /** Unit name (token, credit, email, session, etc.) */
    unitName?: string;
    /** Monthly base cost, if flat */
    monthlyBase?: number;
  };
  /** Known gotchas that affect cost */
  gotchas?: string[];
  /** Alternative services (free or cheaper) */
  alternatives?: string[];
  /** Documentation URL */
  docsUrl?: string;
  /** Last time pricing was verified */
  lastVerified?: string;
  /** Notes about recent pricing changes */
  pricingNotes?: string;
  /** Available plan tiers for interactive init */
  plans?: PlanTier[];
  /** Whether the plan can be auto-detected from an API key */
  autoDetectPlan?: boolean;
}

/** A tracked service instance — a service definition + user config. */
export interface TrackedService {
  /** Service definition ID */
  serviceId: string;
  /** How this service was detected */
  detectedVia: DetectionSource[];
  /** User-configured monthly budget */
  budget?: number;
  /** Whether the user has provided an API/billing key */
  hasApiKey: boolean;
  /** Override confidence tier (e.g., user provided billing key upgrades to LIVE) */
  tierOverride?: ConfidenceTier;
  /** User-entered monthly plan cost (for CALC tier) */
  planCost?: number;
  /** When this service was first detected */
  firstDetected: string;
  /** Explicitly excluded from tracking by user */
  excluded?: boolean;
  /** Plan name selected during interactive init */
  planName?: string;
  /** For credit-pool services: the unit allowance included in the plan */
  allowance?: {
    /** Total units included in the plan (e.g., 1000000 credits) */
    included: number;
    /** Unit name (e.g., "credits", "sessions", "commands") */
    unitName: string;
  };
}

export type DetectionSource =
  | "package_json"
  | "env_var"
  | "import_scan"
  | "prompt_mention"
  | "git_diff"
  | "manual";

/** A spend snapshot for a single service at a point in time. */
export interface SpendSnapshot {
  serviceId: string;
  /** Current period spend (or estimate) */
  spend: number;
  /** Is the spend figure exact or estimated? */
  isEstimate: boolean;
  /** Confidence tier for this reading */
  tier: ConfidenceTier;
  /** Budget allocated */
  budget?: number;
  /** Percentage of budget consumed */
  budgetPercent?: number;
  /** Budget status */
  status: "healthy" | "caution" | "over" | "unknown";
  /** Human-readable status label */
  statusLabel: string;
  /** Raw data from billing API, if available */
  raw?: Record<string, unknown>;
  /** Timestamp of this snapshot */
  timestamp: string;
  /** Whether this is a flat-fee plan (spend == budget is expected, not alarming) */
  isFlatPlan?: boolean;
  /** For credit-pool services: unit consumption tracking */
  allowance?: {
    /** Units consumed this period */
    used: number;
    /** Total units included in plan */
    included: number;
    /** Unit name (e.g., "credits") */
    unitName: string;
    /** Percentage of allowance consumed */
    percent: number;
  };
}

/** The full spend brief, injected at session start. */
export interface SpendBrief {
  projectName: string;
  generatedAt: string;
  period: string;
  services: SpendSnapshot[];
  totalSpend: number;
  totalIsEstimate: boolean;
  estimateMargin: number;
  untrackedCount: number;
  alerts: SpendAlert[];
}

export interface SpendAlert {
  serviceId: string;
  type: "over_budget" | "near_budget" | "new_service" | "stale_data" | "blind_service";
  message: string;
  severity: "warning" | "critical" | "info";
}

/** Ledger entry — one row in spend-ledger.md */
export interface LedgerEntry {
  serviceId: string;
  serviceName: string;
  spend: number;
  isEstimate: boolean;
  tier: ConfidenceTier;
  budget?: number;
  statusLabel: string;
}

/** Event logged to events.jsonl */
export interface SpendEvent {
  timestamp: string;
  sessionId: string;
  type:
    | "session_start"
    | "session_end"
    | "service_detected"
    | "service_mentioned"
    | "spend_polled"
    | "budget_alert"
    | "ledger_written"
    | "cost_impact";
  data: Record<string, unknown>;
}

/** A cost impact estimate for a file change. */
export interface CostImpact {
  serviceId: string;
  serviceName: string;
  filePath: string;
  /** Number of SDK call sites found */
  callCount: number;
  /** Detected multipliers (loops, .map(), etc.) */
  multipliers: string[];
  /** Effective multiplier applied to call count */
  multiplierFactor: number;
  /** Estimated monthly invocations */
  monthlyInvocations: number;
  /** Low estimate monthly cost */
  costLow: number;
  /** High estimate monthly cost */
  costHigh: number;
  /** Gotcha-based cost range explanation */
  rangeExplanation?: string;
}

/**
 * Hook input — the JSON received via stdin from Claude Code.
 * Subset of fields we care about.
 */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  // SessionStart
  source?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
  };
}

/**
 * Hook output — the JSON we write to stdout for Claude Code.
 */
export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}
