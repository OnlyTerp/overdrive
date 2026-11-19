import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRsiBenchmark } from "../checks/rsi-benchmark.mjs";
import { mineIntentionDigest, redactPrivateSignals } from "./intentions.mjs";
import { detectFleet } from "./routing.mjs";
import { SCHEMA_VERSION, validateIntentionDigest, validateRsiCandidate } from "./ui-contracts.mjs";
import {
  defaultConnectAnythingBin,
  defaultExternalRepoHints,
  defaultScratchBase,
  defaultWorktreeRoot,
} from "./paths.mjs";
import { unmountAllJunctions, worktreeRootBase } from "./worktree.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROTECTED_HARNESS_PATHS = Object.freeze([
  "checks/rsi-benchmark.mjs",
  "checks/ui-security.mjs",
  "ui/contracts.js",
  "src/partition.mjs",
  "test/contract-smoke.test.mjs",
]);
const PROTECTED_HARNESS_SET = new Set(PROTECTED_HARNESS_PATHS);

const EXTERNAL_REPO_HINT_RE = /\b(?:canonical_rules\.md|agents\.md)\b/i;

function hasExternalRepoHint(text) {
  const value = String(text || "");
  if (EXTERNAL_REPO_HINT_RE.test(value)) return true;
  const hints = defaultExternalRepoHints();
  const lower = value.toLowerCase();
  return hints.some((hint) => lower.includes(String(hint).toLowerCase()));
}

export const RSI_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS rsi_candidates (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    tier TEXT NOT NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed',
    baseline_score REAL,
    candidate_score REAL,
    regressions INTEGER NOT NULL DEFAULT 0,
    touches_harness INTEGER NOT NULL DEFAULT 0,
    human_approved INTEGER NOT NULL DEFAULT 0,
    branch_name TEXT,
    pre_promote_commit TEXT,
    proposer_json TEXT,
    audit_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rsi_runs (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    baseline_score REAL,
    candidate_score REAL,
    regressions INTEGER NOT NULL DEFAULT 0,
    touches_harness INTEGER NOT NULL DEFAULT 0,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    audit_json TEXT,
    commit_sha TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rsi_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rsi_runs_candidate ON rsi_runs(candidate_id, created_at DESC);
`;

function iso() {
  return new Date().toISOString();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeRelPath(p) {
  return String(p || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

export function touchesProtectedHarness(files = []) {
  return (Array.isArray(files) ? files : []).some((f) => PROTECTED_HARNESS_SET.has(normalizeRelPath(f)));
}

function classifyCandidateTier(targetRepo, textForScan = "", { isOverdriveInternal = false } = {}) {
  const repoStr = String(targetRepo || "").trim();
  if (hasExternalRepoHint(textForScan) || hasExternalRepoHint(repoStr)) return "proposal_only";
  const repoNorm = repoStr.replaceAll("\\", "/").toLowerCase();
  const defaultRepoNorm = DEFAULT_REPO_ROOT.replaceAll("\\", "/").toLowerCase();
  const scratchPrefix = `${defaultScratchBase().replaceAll("\\", "/").toLowerCase()}/`;
  const wtPrefix = `${String(defaultWorktreeRoot()).replaceAll("\\", "/").toLowerCase()}/overdrive/`;
  const isOverdriveRepo =
    repoNorm === defaultRepoNorm ||
    repoNorm === "overdrive" ||
    repoNorm.endsWith("/overdrive") ||
    repoNorm.includes("/overdrive-v0-");
  const isSandboxTestFixture =
    repoNorm.startsWith(scratchPrefix) || repoNorm.startsWith(wtPrefix) || repoNorm.includes("/overdrive/tests/");
  if (isOverdriveInternal && (isOverdriveRepo || isSandboxTestFixture)) return "self_sandbox";
  return isOverdriveRepo ? "self_sandbox" : "proposal_only";
}

function resolveGitCommitSha(repoRoot, fallbackSeed) {
  for (const dir of [repoRoot, DEFAULT_REPO_ROOT].filter(Boolean)) {
    if (!existsSync(dir)) continue;
    const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (r.status === 0 && /^[0-9a-f]{7,40}$/i.test((r.stdout || "").trim())) {
      return r.stdout.trim();
    }
  }
  return createHash("sha256").update(String(fallbackSeed || "overdrive-rsi")).digest("hex").slice(0, 40);
}

function pickCrossFamilyAuditor(proposerFamily = "google") {
  const fam = String(proposerFamily || "google").toLowerCase();
  if (fam !== "openai") return { auditorFamily: "openai", auditorModel: "gpt-6-astra" };
  return { auditorFamily: "anthropic", auditorModel: "claude-opus-5-5" };
}

function hydrateCandidate(c) {
  if (!c) return null;
  return {
    id: c.id,
    category: c.category,
    targetRepo: c.targetRepo ?? c.target_repo,
    tier: c.tier,
    title: c.title,
    rationale: c.rationale,
    evidenceRefs: Array.isArray(c.evidenceRefs) ? c.evidenceRefs : [],
    status: c.status || "proposed",
    baselineScore: c.baselineScore ?? null,
    candidateScore: c.candidateScore ?? null,
    regressions: Number(c.regressions ?? 0),
    touchesHarness: Boolean(c.touchesHarness),
    humanApproved: Boolean(c.humanApproved),
    branchName: c.branchName || null,
    prePromoteCommit: c.prePromoteCommit || null,
    proposer: c.proposer || { family: "google", modelId: "gemini-4-carbon" },
    audit: c.audit || null,
    metadata: c.metadata || {},
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function buildValidatedCandidate(raw) {
  const c = hydrateCandidate({
    ...raw,
    title: redactPrivateSignals(raw.title),
    rationale: redactPrivateSignals(raw.rationale),
    targetRepo: redactPrivateSignals(raw.targetRepo),
    evidenceRefs: (raw.evidenceRefs || []).map((r) => redactPrivateSignals(String(r))),
  });
  const check = validateRsiCandidate(c);
  if (!check.ok) {
    throw httpError(400, `Invalid RSI candidate "${c.id}": ${check.errors.join("; ")}`);
  }
  return c;
}

function upsertPreservingLifecycle(store, candidate) {
  const existing = store.getRsiCandidate(candidate.id);
  if (existing && ["evaluated", "evaluated_pending_audit", "audited", "promoted", "rolled_back"].includes(existing.status)) {
    return existing;
  }
  return store.upsertRsiCandidate(candidate);
}

/** Build deterministic showcase RSI digest, benchmark, and candidate items when DB has no scan yet. */
export function buildShowcaseRsiSeed({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const now = "2026-11-18T00:12:15.000Z";
  const digest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    privacyMode: "strict_local",
    totalSessions: 48,
    cloudOffloadPct: 62.5,
    freePoolPct: 71.0,
    activeFocus: [
      {
        project: "overdrive",
        sessions: 14,
        totalTokens: 284000,
        costUsd: 0.42,
        harnesses: ["antigravity", "devin", "codex"],
        models: ["gemini-4-carbon", "swe-2-flash", "gpt-6-astra"],
        lastActiveAt: now,
        quietHours: 0.5,
        momentum: 166.9,
        signal: "active",
      },
      {
        project: "analytics-engine",
        sessions: 9,
        totalTokens: 192000,
        costUsd: 0.18,
        harnesses: ["claude", "devin"],
        models: ["claude-opus-5-5", "swe-2"],
        lastActiveAt: "2026-11-17T18:00:00.000Z",
        quietHours: 6.2,
        momentum: 116.0,
        signal: "active",
      },
    ],
    wentQuietQuestions: [
      {
        kind: "owner_question",
        autoDispatch: false,
        project: "search-core",
        quietHours: 96,
        lastActiveAt: "2026-11-14T00:12:15.000Z",
        recentSessions: 4,
        question: 'Project "search-core" had 4 session(s) recently and has been quiet for ~96h. Keep paused, archive, or resume with a targeted mission?',
      },
    ],
    frictionHotspots: [
      { kind: "tool_error", label: "Bash", count: 3, detail: "Local Windows quoting retries before spawn(shell:false) normalization" },
      { kind: "compaction", label: "compaction", count: 2, detail: "Long session context compactions mitigated by fast_pack" },
    ],
    driftAlerts: [
      { source: "devin", severity: "info", message: 'Source "devin" lacks local transcript parser (IDE state)' },
    ],
  };

  const benchmark = {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    score: 100,
    maxScore: 100,
    regressions: 0,
    partitionScore: 20,
    securityScore: 20,
    routingScore: 20,
    ratchetScore: 20,
    replayScore: 20,
    failures: [],
    measuredAt: now,
  };

  const candidates = [
    buildValidatedCandidate({
      id: "rsi-cloud-offload-swe2",
      category: "cloud-offload",
      targetRepo: repoRoot,
      tier: "self_sandbox",
      title: "Route fast/standard validation lanes to free Devin SWE-2 & aipc auto",
      rationale: "Reduces local workstation freeze risk while keeping free pool utilization above 70%.",
      evidenceRefs: ["ledger:free_pool", "benchmark:routing"],
      status: "audited",
      baselineScore: 98,
      candidateScore: 100,
      regressions: 0,
      touchesHarness: false,
      branchName: "rsi/cloud-offload-swe2",
      proposer: { family: "google", modelId: "gemini-4-carbon" },
      audit: {
        verdict: "approve",
        auditKind: "showcase_preview",
        modelExecuted: true,
        auditorFamily: "openai",
        auditorModel: "gpt-6-astra",
        auditedAt: now,
        notes: "Cross-family verification passed all 5 benchmark dimensions.",
      },
      metadata: { touchesFiles: ["src/routing.mjs"], isShowcase: true },
      createdAt: now,
      updatedAt: now,
    }),
    buildValidatedCandidate({
      id: "rsi-proposal-analytics-ratchet",
      category: "project-proposal",
      targetRepo: "analytics-engine",
      tier: "proposal_only",
      title: "Adopt coordinator-private holdout parity ratchet in analytics-engine",
      rationale: "Active focus project analytics-engine benefits from hidden holdout verification on parity 94.2% -> 96.8%.",
      evidenceRefs: ["ledger:active_focus:analytics-engine"],
      status: "proposed",
      baselineScore: 100,
      candidateScore: null,
      regressions: 0,
      touchesHarness: false,
      humanApproved: false,
      proposer: { family: "google", modelId: "gemini-4-carbon" },
      metadata: { touchesFiles: ["src/ratchet.mjs"], isShowcase: true },
      createdAt: now,
      updatedAt: now,
    }),
  ];

  const checkDigest = validateIntentionDigest(digest);
  if (!checkDigest.ok) throw new Error(`Showcase RSI digest invalid: ${checkDigest.errors.join("; ")}`);
  return { digest, benchmark, candidates };
}

/** Seed showcase RSI state only when the store has no RSI scan/candidates yet. */
export function seedShowcaseRsiIfEmpty(store, options = {}) {
  const existing = store.listRsiCandidates();
  const cachedDigest = store.getRsiKv("latest_digest");
  if (existing.length > 0 && cachedDigest) {
    return {
      seeded: false,
      digest: cachedDigest,
      benchmark: store.getRsiKv("latest_benchmark"),
      candidates: existing,
    };
  }
  const seed = buildShowcaseRsiSeed(options);
  store.tx(() => {
    if (!cachedDigest) store.setRsiKv("latest_digest", seed.digest);
    if (!store.getRsiKv("latest_benchmark")) store.setRsiKv("latest_benchmark", seed.benchmark);
    if (existing.length === 0) {
      for (const c of seed.candidates) store.upsertRsiCandidate(c);
    }
  });
  return {
    seeded: true,
    digest: store.getRsiKv("latest_digest"),
    benchmark: store.getRsiKv("latest_benchmark"),
    candidates: store.listRsiCandidates(),
  };
}

/**
 * Scan local intentions + Golden Benchmark + fleet readiness, synthesize ranked Tier A/Tier B
 * RSI candidates, persist to SQLite, and cache the latest digest & benchmark snapshots.
 */
export async function scanRsiOpportunities(
  store,
  { intentionsOpts = {}, benchmarkRoot = DEFAULT_REPO_ROOT, fleet = null, repoRoot = DEFAULT_REPO_ROOT, missionId = null } = {},
) {
  const digest = mineIntentionDigest(intentionsOpts);
  const benchmark = await runRsiBenchmark({ rootDir: benchmarkRoot });
  const detectedFleet = fleet || detectFleet();
  const now = iso();

  const candidates = [];
  const pushCandidate = (spec) => {
    const combinedText = `${spec.title} ${spec.rationale} ${(spec.evidenceRefs || []).join(" ")}`;
    const tier = classifyCandidateTier(spec.targetRepo, combinedText, {
      isOverdriveInternal: Boolean(spec.isOverdriveInternal),
    });
    const touchesHarness = touchesProtectedHarness(spec.metadata?.touchesFiles || []);
    candidates.push(
      buildValidatedCandidate({
        ...spec,
        tier,
        touchesHarness,
        status: "proposed",
        baselineScore: benchmark.score,
        candidateScore: null,
        regressions: 0,
        humanApproved: false,
        proposer: spec.proposer || { family: "google", modelId: "gemini-4-carbon" },
        createdAt: now,
        updatedAt: now,
      }),
    );
  };

  // 1. Self-modernize candidate from benchmark or Overdrive-relevant friction hotspots
  const isOverdriveRelevantFriction = (h) => {
    if (!h || typeof h !== "object") return false;
    const harness = String(h.harness || "").toLowerCase();
    const proj = String(h.project || "").toLowerCase();
    const label = String(h.label || "").toLowerCase();
    if (harness.includes("grok") && !proj.includes("overdrive")) return false;
    if (/^(?:x|web)\s*search\b|twitter/i.test(label) && !proj.includes("overdrive")) return false;
    return true;
  };
  const topFriction = (digest.frictionHotspots || []).find(isOverdriveRelevantFriction) || null;
  pushCandidate({
    id: "rsi-self-modernize-routing",
    category: "self-modernize",
    targetRepo: repoRoot,
    isOverdriveInternal: true,
    title:
      benchmark.regressions > 0
        ? `Repair ${benchmark.regressions} Golden Benchmark regression(s) in Overdrive`
        : topFriction
          ? `Reduce "${topFriction.label}" friction (${topFriction.count} events) in Overdrive orchestration`
          : "Modernize Overdrive v0.3 lane brief templates & telemetry normalization",
    rationale: topFriction
      ? `Observed ${topFriction.count} ${topFriction.kind} events (${topFriction.detail}); refine Overdrive sandbox heuristics without touching evaluator harness.`
      : `Golden Benchmark scored ${benchmark.score}/${benchmark.maxScore}; maintain zero-regression orchestration quality.`,
    evidenceRefs: [
      `benchmark:${benchmark.score}/${benchmark.maxScore}`,
      ...(topFriction ? [`ledger:friction:${topFriction.kind}:${topFriction.label}`] : ["ledger:sessions"]),
    ],
    branchName: "rsi/self-modernize-routing",
    metadata: { touchesFiles: ["src/routing.mjs"], priority: benchmark.regressions > 0 ? 100 : 72 },
  });

  // 2. Cloud-offload candidate
  if (digest.cloudOffloadPct < 60 || detectedFleet?.infra?.aipc?.ready) {
    pushCandidate({
      id: "rsi-cloud-offload-default",
      category: "cloud-offload",
      targetRepo: repoRoot,
      isOverdriveInternal: true,
      title: `Increase cloud/remote lane offload above ${Math.round(digest.cloudOffloadPct)}% using aipc & devin-vm`,
      rationale: `Recent cloud/subagent offload share is ${digest.cloudOffloadPct}%. Route heavy verification suites to aipc auto / devin-vm to protect interactive workstation responsiveness.`,
      evidenceRefs: [`ledger:cloud_offload_pct:${digest.cloudOffloadPct}`],
      branchName: "rsi/cloud-offload-default",
      metadata: { touchesFiles: ["src/routing.mjs", "src/worktree.mjs"], priority: digest.cloudOffloadPct < 40 ? 95 : 80 },
    });
  }

  // 3. Routing-efficiency candidate (free-first pool optimization)
  pushCandidate({
    id: "rsi-routing-efficiency-free-pool",
    category: "routing-efficiency",
    targetRepo: repoRoot,
    isOverdriveInternal: true,
    title: `Prioritize free swe-2 / Dots / Muse AI capacity (current free share ${digest.freePoolPct}%)`,
    rationale: `Observed free-pool share is ${digest.freePoolPct}%. Tune Overdrive playbook-auto worker selection for standard/fast lanes before spending paid quota.`,
    evidenceRefs: [`ledger:free_pool_pct:${digest.freePoolPct}`],
    branchName: "rsi/routing-efficiency-free-pool",
    metadata: { touchesFiles: ["src/routing.mjs"], priority: digest.freePoolPct < 60 ? 90 : 75 },
  });

  // 4. Skill-sync candidate (Overdrive local skill docs; never auto-edits CANONICAL_RULES.md!)
  if (digest.driftAlerts.length > 0 || digest.totalSessions >= 0) {
    pushCandidate({
      id: "rsi-skill-sync-overdrive",
      category: "skill-sync",
      targetRepo: repoRoot,
      isOverdriveInternal: true,
      title: "Synchronize Overdrive SKILL.md playbooks with verified v0.3 cloud-first workflows",
      rationale: `Detected ${digest.driftAlerts.length} coverage/drift notice(s) across local tools; keep Overdrive SKILL.md aligned with verified routing & ratchet contracts.`,
      evidenceRefs: ["skill:skills/overdrive/SKILL.md", ...digest.driftAlerts.slice(0, 2).map((d) => `drift:${d.source}`)],
      branchName: "rsi/skill-sync-overdrive",
      metadata: { touchesFiles: ["skills/overdrive/SKILL.md"], priority: 68 },
    });
  }

  // 5. External project proposals (strictly Tier B proposal_only!)
  const externalFocus = digest.activeFocus.filter((f) => !/overdrive/i.test(f.project)).slice(0, 3);
  for (const proj of externalFocus) {
    const slug = proj.project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    pushCandidate({
      id: `rsi-proposal-${slug}`,
      category: "project-proposal",
      targetRepo: proj.project,
      title: `Propose Overdrive v0.3 ratchet & cloud-first workflow for "${proj.project}"`,
      rationale: `External project "${proj.project}" has high recent momentum (${proj.sessions} sessions, ${proj.totalTokens ?? 0} tokens). Requires explicit human approval before dispatching work outside Overdrive.`,
      evidenceRefs: [`ledger:active_focus:${proj.project}`],
      branchName: `proposal/${slug}`,
      metadata: { touchesFiles: [], momentum: proj.momentum, priority: 78 },
    });
  }

  // 6. Always ensure external CANONICAL_RULES sync stays Tier B proposal_only if drift alerts reference external harnesses
  if (digest.driftAlerts.some((d) => d.severity === "warn")) {
    pushCandidate({
      id: "rsi-proposal-canonical-rules-audit",
      category: "project-proposal",
      targetRepo: "external-rules",
      title: "Review CANONICAL_RULES.md & local harness drift warnings with owner",
      rationale: "References CANONICAL_RULES.md outside Overdrive; strictly proposal_only until owner explicitly approves.",
      evidenceRefs: ["rules:CANONICAL_RULES.md"],
      branchName: "proposal/canonical-rules-audit",
      metadata: { touchesFiles: [], priority: 60 },
    });
  }

  candidates.sort((a, b) => Number(b.metadata?.priority || 0) - Number(a.metadata?.priority || 0));

  const quietProjects = new Set(
    (digest.wentQuietQuestions || []).map((q) => String(q.project || "").trim().toLowerCase()).filter(Boolean),
  );

  const saved = store.tx(() => {
    store.setRsiKv("latest_digest", digest);
    store.setRsiKv("latest_benchmark", benchmark);
    if (quietProjects.size > 0) {
      for (const prev of store.listRsiCandidates()) {
        if (prev.status !== "proposed") continue;
        const projKey = String(prev.targetRepo || "").trim().toLowerCase();
        const projBase = path.basename(projKey);
        if (quietProjects.has(projKey) || quietProjects.has(projBase)) {
          store.deleteRsiCandidate?.(prev.id);
        }
      }
    }
    const out = candidates.map((c) => upsertPreservingLifecycle(store, c));
    if (missionId) {
      const m = store.getMission(missionId);
      if (m && !m.isShowcase) {
        store.recordEvent(m.id, "coordinator", "rsi_scanned", {
          candidateCount: out.length,
          score: benchmark.score,
          maxScore: benchmark.maxScore,
        });
      }
    }
    return out;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    digest,
    benchmark,
    candidates: saved,
  };
}

function connectAnythingAgentForFamily(family = "openai") {
  const f = String(family || "openai").toLowerCase();
  if (f === "openai") return "codex";
  if (f === "anthropic") return "claude";
  if (f === "devin") return "devin";
  return "codex";
}

function parseCrossFamilyAuditOutput(rawText) {
  const txt = String(rawText || "").trim();
  if (!txt) return null;
  const jsonMatch = txt.match(/\{[\s\S]*"verdict"\s*:\s*"(?:approve|reject)"[\s\S]*\}/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const v = String(parsed?.verdict || "").toLowerCase();
      if (v === "approve" || v === "reject") {
        return {
          verdict: v,
          notes: String(parsed.notes || parsed.summary || txt.slice(0, 240)),
          reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
          auditorModel: parsed.auditorModel || null,
          receiptRef: parsed.receiptRef || null,
        };
      }
    } catch {}
  }
  const hasApprove = /\bAPPROVE\b/.test(txt);
  const hasReject = /\bREJECT\b/.test(txt);
  if (hasApprove && !hasReject) return { verdict: "approve", notes: txt.slice(0, 240), reasons: [] };
  if (hasReject && !hasApprove) return { verdict: "reject", notes: txt.slice(0, 240), reasons: ["Cross-family reviewer returned REJECT."] };
  return null;
}

/**
 * Evaluate a candidate in a verification cycle:
 * checks harness tampering, measures baseline vs candidate benchmark, records `rsi_runs` receipt,
 * and either stays `evaluated_pending_audit` (deterministic_local_gate) or records a real
 * cross-family model audit (`modelExecuted: true`) before allowing `audited` -> promotion.
 */
export async function runRsiVerificationCycle(
  store,
  candidateId,
  {
    evaluatorFn = null,
    crossFamilyAuditFn = null,
    runCrossFamilyAudit = false,
    auditRunner = null,
    connectAnythingPath = defaultConnectAnythingBin(),
    crossFamilyAgent = null,
    worktreeRoot = DEFAULT_REPO_ROOT,
    touchesFiles = [],
    proposerFamily = null,
    auditorFamily = null,
    auditorModel = null,
    missionId = null,
  } = {},
) {
  const existing = store.getRsiCandidate(candidateId);
  if (!existing) throw httpError(404, `Unknown RSI candidate "${candidateId}".`);

  const explicitFiles = Array.isArray(touchesFiles) && touchesFiles.length > 0 ? touchesFiles : [];
  let gitTouched = [];
  if (worktreeRoot && existsSync(path.join(worktreeRoot, ".git"))) {
    const isIsolatedWorktree = path.resolve(worktreeRoot) !== path.resolve(DEFAULT_REPO_ROOT);
    const brRes = spawnSync("git", ["-C", worktreeRoot, "branch", "--show-current"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    const currentBranch = brRes.status === 0 ? (brRes.stdout || "").trim() : "";
    const isCandidateBranch = Boolean(existing.branchName && currentBranch === existing.branchName);
    if (isIsolatedWorktree || isCandidateBranch) {
      const st = spawnSync("git", ["-C", worktreeRoot, "status", "--porcelain", "-uall"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      });
      if (st.status === 0 && st.stdout) {
        gitTouched = st.stdout
          .split(/\r?\n/)
          .map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"))
          .map((p) => (p.includes(" -> ") ? p.split(" -> ").pop() : p))
          .filter(Boolean);
      }
    }
  }
  const baseFiles = explicitFiles.length > 0
    ? explicitFiles
    : (Array.isArray(existing.metadata?.touchesFiles) ? existing.metadata.touchesFiles : []);
  const allTouched = Array.from(new Set([...baseFiles, ...gitTouched].map(normalizeRelPath).filter(Boolean)));
  const harnessTouched = touchesProtectedHarness(allTouched) || (explicitFiles.length === 0 && Boolean(existing.touchesHarness));

  const cachedBench = store.getRsiKv("latest_benchmark");
  const baselineBench = cachedBench || (await runRsiBenchmark({ rootDir: worktreeRoot }));
  const baselineScore = existing.baselineScore ?? baselineBench.score;

  let evalOutcome;
  if (typeof evaluatorFn === "function") {
    evalOutcome = await evaluatorFn(existing, { store, worktreeRoot, baseline: baselineBench, touchesFiles: allTouched });
  } else {
    evalOutcome = await runRsiBenchmark({ rootDir: worktreeRoot });
  }

  const candidateScore = Number(evalOutcome?.candidateScore ?? evalOutcome?.score ?? 0);
  const regressions = Math.max(0, Math.trunc(Number(evalOutcome?.regressions ?? 0)));
  const finalTouchesHarness = harnessTouched || Boolean(evalOutcome?.touchesHarness);

  const pFamily = proposerFamily || existing.proposer?.family || "google";
  const proposer = {
    family: pFamily,
    modelId: existing.proposer?.modelId || "gemini-4-carbon",
  };

  const deterministicReasons = [];
  if (finalTouchesHarness) deterministicReasons.push("Candidate touches protected evaluator/harness paths.");
  if (regressions > 0) deterministicReasons.push(`Golden Benchmark reported ${regressions} regression(s).`);
  if (!Number.isFinite(candidateScore) || candidateScore < baselineScore) {
    deterministicReasons.push(`Candidate score (${candidateScore}) regressed below baseline (${baselineScore}).`);
  }
  if (auditorFamily && String(auditorFamily).trim().toLowerCase() === String(pFamily).trim().toLowerCase()) {
    deterministicReasons.push("Cross-family audit requires auditorFamily !== proposer.family.");
  }
  const deterministicPassed = deterministicReasons.length === 0;
  const defaultAud = pickCrossFamilyAuditor(pFamily);
  const chosenFamily = auditorFamily || defaultAud.auditorFamily;
  const chosenModel = auditorModel || defaultAud.auditorModel;

  let audit;
  if (typeof crossFamilyAuditFn === "function") {
    const rawAudit = await crossFamilyAuditFn(existing, {
      baselineScore,
      candidateScore,
      regressions,
      touchesHarness: finalTouchesHarness,
      proposer,
    });
    const isDet = rawAudit?.auditKind === "deterministic_local_gate";
    audit = {
      ...(rawAudit || {}),
      auditKind: rawAudit?.auditKind || "cross_family_model",
      modelExecuted: isDet ? false : (rawAudit?.modelExecuted !== undefined ? Boolean(rawAudit.modelExecuted) : true),
    };
  } else if (runCrossFamilyAudit === true && deterministicPassed) {
    const agentId = crossFamilyAgent || connectAnythingAgentForFamily(chosenFamily);
    const auditPrompt = `Read-only Overdrive RSI audit for candidate "${existing.id}" (${existing.title}). Touched files: ${allTouched.join(", ") || "none"}. Benchmark: ${candidateScore} vs baseline ${baselineScore}, regressions=${regressions}. Reply strictly with JSON {"verdict":"approve"|"reject","notes":"brief reason"}.`;
    let modelOut = null;
    let modelErr = null;
    if (chosenFamily === pFamily) {
      modelErr = "Cross-family audit requires auditorFamily !== proposer.family.";
    } else if (typeof auditRunner === "function") {
      modelOut = await auditRunner({
        agentId,
        auditorFamily: chosenFamily,
        auditorModel: chosenModel,
        prompt: auditPrompt,
        candidate: existing,
        worktreeRoot,
      });
    } else if (connectAnythingPath && existsSync(connectAnythingPath)) {
      const caRes = spawnSync(
        process.execPath,
        [connectAnythingPath, "ask", agentId, "--model", chosenModel, "--wait", "60", auditPrompt],
        {
          cwd: worktreeRoot || DEFAULT_REPO_ROOT,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: 90_000,
        },
      );
      if (caRes.status === 0 && caRes.stdout) {
        modelOut = parseCrossFamilyAuditOutput(caRes.stdout);
        if (!modelOut) modelErr = "connect-anything output did not include a clear JSON APPROVE/REJECT verdict";
      } else {
        modelErr = (caRes.stderr || caRes.stdout || `exit ${caRes.status}`).trim().slice(0, 200);
      }
    } else {
      modelErr = connectAnythingPath
        ? `connect-anything binary not found at "${connectAnythingPath}"`
        : "connect-anything binary not configured (set OVERDRIVE_CONNECT_ANYTHING or ~/.overdrive/config.json)";
    }

    if (modelOut && (modelOut.verdict === "approve" || modelOut.verdict === "reject")) {
      audit = {
        verdict: modelOut.verdict,
        auditKind: "connect_anything_model",
        modelExecuted: true,
        auditorFamily: chosenFamily,
        auditorModel: modelOut.auditorModel || chosenModel,
        agent: agentId,
        receiptRef: modelOut.receiptRef || `ca-${randomUUID().slice(0, 10)}`,
        auditedAt: iso(),
        notes: redactPrivateSignals(modelOut.notes || "Cross-family model audit executed via connect-anything."),
        reasons: Array.isArray(modelOut.reasons) ? modelOut.reasons : [],
      };
    } else {
      audit = {
        verdict: "pending_audit",
        auditKind: "deterministic_local_gate",
        modelExecuted: false,
        auditorFamily: null,
        auditorModel: null,
        recommendedAuditorFamily: chosenFamily,
        recommendedAuditorModel: chosenModel,
        auditedAt: iso(),
        reasons: [],
        notes: redactPrivateSignals(
          `Deterministic checks passed, but live cross-family audit did not execute (${modelErr || "unavailable"}); awaiting real audit receipt.`,
        ),
      };
    }
  } else {
    audit = {
      verdict: deterministicPassed ? "pending_audit" : "reject",
      auditKind: "deterministic_local_gate",
      modelExecuted: false,
      auditorFamily: null,
      auditorModel: null,
      recommendedAuditorFamily: chosenFamily !== pFamily ? chosenFamily : defaultAud.auditorFamily,
      recommendedAuditorModel: chosenFamily !== pFamily ? chosenModel : defaultAud.auditorModel,
      auditedAt: iso(),
      reasons: deterministicReasons,
      notes: deterministicPassed
        ? `Deterministic local benchmark checks passed (${candidateScore} >= ${baselineScore}); no cross-family model executed yet.`
        : deterministicReasons.join(" "),
    };
  }

  const sameFamily = Boolean(audit?.auditorFamily && proposer.family && audit.auditorFamily === proposer.family);
  if (sameFamily && audit?.verdict === "approve") {
    audit = {
      ...audit,
      verdict: "reject",
      reasons: [...(Array.isArray(audit.reasons) ? audit.reasons : []), "Cross-family audit requires auditorFamily !== proposer.family."],
    };
  }
  const hasRealModelAudit = Boolean(audit?.modelExecuted === true && audit?.auditKind !== "deterministic_local_gate");
  const passedAudit = deterministicPassed && hasRealModelAudit && audit?.verdict === "approve" && !sameFamily;
  const rejected = !deterministicPassed || audit?.verdict === "reject" || sameFamily;
  const nextStatus = rejected ? "rejected" : passedAudit ? "audited" : "evaluated_pending_audit";

  const updated = buildValidatedCandidate({
    ...existing,
    status: nextStatus,
    baselineScore,
    candidateScore,
    regressions,
    touchesHarness: finalTouchesHarness,
    proposer,
    audit,
    metadata: {
      ...(existing.metadata || {}),
      touchesFiles: allTouched.map(normalizeRelPath).filter(Boolean),
    },
    updatedAt: iso(),
  });

  const run = {
    id: `rsi-run-${randomUUID().slice(0, 12)}`,
    candidateId: updated.id,
    kind: "verify_cycle",
    baselineScore,
    candidateScore,
    regressions,
    touchesHarness: finalTouchesHarness,
    metrics: evalOutcome?.metrics || {
      score: candidateScore,
      baselineScore,
      regressions,
      partitionScore: evalOutcome?.partitionScore ?? null,
      securityScore: evalOutcome?.securityScore ?? null,
      routingScore: evalOutcome?.routingScore ?? null,
      ratchetScore: evalOutcome?.ratchetScore ?? null,
      replayScore: evalOutcome?.replayScore ?? null,
    },
    audit,
    commitSha: null,
    note: passedAudit
      ? "Verification cycle and cross-family model audit passed."
      : nextStatus === "evaluated_pending_audit"
        ? "Deterministic benchmark passed; awaiting real cross-family model audit."
        : (audit?.reasons || []).join(" ") || "Verification cycle rejected.",
    createdAt: iso(),
  };

  store.tx(() => {
    store.upsertRsiCandidate(updated);
    store.insertRsiRun(run);
    if (missionId) {
      const m = store.getMission(missionId);
      if (m && !m.isShowcase) {
        store.recordEvent(m.id, "verifier", "rsi_evaluated", {
          candidateId: updated.id,
          status: updated.status,
          baselineScore,
          candidateScore,
          regressions,
          modelExecuted: Boolean(audit?.modelExecuted),
        });
      }
    }
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: !rejected,
    readyToPromote: passedAudit,
    candidate: updated,
    run,
  };
}

/**
 * Record an explicit, non-fabricated cross-family model audit receipt for an evaluated candidate.
 */
export async function submitRsiAuditReceipt(
  store,
  candidateId,
  {
    auditorFamily,
    auditorModel,
    verdict,
    notes = "",
    receiptRef = null,
    modelExecuted = true,
    auditKind = "external_model_receipt",
    missionId = null,
  } = {},
) {
  const existing = store.getRsiCandidate(candidateId);
  if (!existing) throw httpError(404, `Unknown RSI candidate "${candidateId}".`);
  if (existing.metadata?.isShowcase === true) {
    throw httpError(400, `Candidate "${candidateId}" is a read-only showcase preview.`);
  }
  if (modelExecuted !== true || auditKind === "deterministic_local_gate") {
    throw httpError(400, "Audit receipt must come from an actually executed cross-family model (modelExecuted: true).");
  }
  const audFam = String(auditorFamily || "").trim().toLowerCase();
  const audMod = String(auditorModel || "").trim();
  const normVerdict = String(verdict || "").trim().toLowerCase();
  if (!audFam || !audMod) {
    throw httpError(400, "auditorFamily and auditorModel are required.");
  }
  if (normVerdict !== "approve" && normVerdict !== "reject") {
    throw httpError(400, `verdict must be "approve" or "reject"; got "${String(verdict)}".`);
  }

  const propFam = String(existing.proposer?.family || "google").trim().toLowerCase();
  if (normVerdict === "approve" && audFam === propFam) {
    throw httpError(400, `Cross-family audit requires auditorFamily ("${audFam}") !== proposer.family ("${propFam}").`);
  }
  if (normVerdict === "approve") {
    if (existing.touchesHarness === true) {
      throw httpError(400, `Candidate "${candidateId}" touches protected evaluator/harness paths.`);
    }
    if ((existing.regressions ?? 0) > 0) {
      throw httpError(400, `Candidate "${candidateId}" has ${existing.regressions} regression(s).`);
    }
    if (!Number.isFinite(existing.baselineScore) || !Number.isFinite(existing.candidateScore) || existing.candidateScore < existing.baselineScore) {
      throw httpError(400, `Candidate "${candidateId}" must pass deterministic benchmark before approving audit receipt.`);
    }
  }

  const audit = {
    verdict: normVerdict,
    auditKind,
    modelExecuted: true,
    auditorFamily: audFam,
    auditorModel: audMod,
    receiptRef: receiptRef ? redactPrivateSignals(String(receiptRef)) : `aud-${randomUUID().slice(0, 10)}`,
    notes: redactPrivateSignals(String(notes || "").trim()),
    auditedAt: iso(),
    reasons: normVerdict === "reject" && notes ? [redactPrivateSignals(String(notes))] : [],
  };

  const updated = buildValidatedCandidate({
    ...existing,
    status: normVerdict === "approve" ? "audited" : "rejected",
    audit,
    updatedAt: iso(),
  });

  const run = {
    id: `rsi-run-${randomUUID().slice(0, 12)}`,
    candidateId: updated.id,
    kind: "audit_receipt",
    baselineScore: updated.baselineScore,
    candidateScore: updated.candidateScore,
    regressions: updated.regressions,
    touchesHarness: updated.touchesHarness,
    metrics: { baselineScore: updated.baselineScore, candidateScore: updated.candidateScore },
    audit,
    commitSha: null,
    note: `Recorded cross-family audit receipt from ${audFam}/${audMod}: ${normVerdict}.`,
    createdAt: iso(),
  };

  store.tx(() => {
    store.upsertRsiCandidate(updated);
    store.insertRsiRun(run);
    if (missionId) {
      const m = store.getMission(missionId);
      if (m && !m.isShowcase) {
        store.recordEvent(m.id, "verifier", "rsi_evaluated", {
          candidateId: updated.id,
          status: updated.status,
          auditorFamily: audFam,
          auditorModel: audMod,
          modelExecuted: true,
        });
      }
    }
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: normVerdict === "approve",
    candidate: updated,
    run,
  };
}

/**
 * Promote an audited RSI candidate, failing closed on Tier B without human approval,
 * harness tampering, regressions, score drop, or missing/same-family audit.
 * Records `prePromoteCommit` BEFORE promotion for deterministic rollback.
 */
export async function promoteRsiCandidate(
  store,
  candidateId,
  {
    humanApproved = false,
    repoRoot = DEFAULT_REPO_ROOT,
    prePromoteCommit = null,
    applyGitMerge = false,
    sourceBranch = null,
    gitMergeFn = null,
    missionId = null,
  } = {},
) {
  const existing = store.getRsiCandidate(candidateId);
  if (!existing) throw httpError(404, `Unknown RSI candidate "${candidateId}".`);
  if (existing.metadata?.isShowcase === true) {
    throw httpError(400, `Candidate "${candidateId}" is a read-only showcase preview; run an RSI scan and verification cycle first.`);
  }

  const approved = humanApproved === true || existing.humanApproved === true;
  if (existing.tier === "proposal_only" && !approved) {
    throw httpError(400, `Candidate "${candidateId}" is proposal_only and cannot auto-promote without humanApproved: true.`);
  }
  if (existing.touchesHarness === true) {
    throw httpError(400, `Candidate "${candidateId}" touches protected evaluator/harness paths and is blocked from promotion.`);
  }
  if ((existing.regressions ?? 0) > 0) {
    throw httpError(400, `Candidate "${candidateId}" has ${existing.regressions} regression(s) and cannot be promoted.`);
  }
  if (
    !Number.isFinite(existing.baselineScore) ||
    !Number.isFinite(existing.candidateScore) ||
    existing.candidateScore < existing.baselineScore
  ) {
    throw httpError(
      400,
      `Candidate "${candidateId}" did not meet or beat baselineScore (${existing.candidateScore ?? "null"} < ${existing.baselineScore ?? "null"}).`,
    );
  }
  if (existing.audit?.modelExecuted === false || existing.audit?.auditKind === "deterministic_local_gate") {
    throw httpError(
      400,
      `Candidate "${candidateId}" only passed deterministic local checks without an executed cross-family model audit.`,
    );
  }
  if (!existing.audit || existing.audit.verdict !== "approve") {
    throw httpError(400, `Candidate "${candidateId}" requires a passing cross-family audit (verdict === "approve").`);
  }
  if (existing.proposer?.family && existing.audit.auditorFamily && existing.audit.auditorFamily === existing.proposer.family) {
    throw httpError(400, `Candidate "${candidateId}" failed cross-family requirement (auditorFamily === proposer.family).`);
  }
  if (!["audited", "promoted"].includes(existing.status)) {
    throw httpError(400, `Candidate "${candidateId}" must be in "audited" state before promotion (currently "${existing.status}").`);
  }

  const commitSha =
    prePromoteCommit && /^[0-9a-f]{7,40}$/i.test(String(prePromoteCommit))
      ? String(prePromoteCommit)
      : resolveGitCommitSha(repoRoot || existing.targetRepo, `${candidateId}:${existing.updatedAt}`);

  const targetBranch = sourceBranch || existing.branchName || null;
  let mergeState = "approved_only_no_git_merge";
  let mergedCommit = null;

  if (typeof gitMergeFn === "function") {
    const mergeOut = await gitMergeFn(existing, { repoRoot, prePromoteCommit: commitSha, sourceBranch: targetBranch });
    mergeState = mergeOut?.mergeState || "merged_ff_only";
    mergedCommit = mergeOut?.mergedCommit || resolveGitCommitSha(repoRoot || existing.targetRepo, commitSha);
  } else if (applyGitMerge === true) {
    if (!repoRoot || !existsSync(path.join(repoRoot, ".git"))) {
      throw httpError(400, `applyGitMerge requires a valid git repository at repoRoot ("${repoRoot}").`);
    }
    if (!targetBranch) {
      throw httpError(400, `applyGitMerge requires sourceBranch or candidate.branchName.`);
    }
    const dirtyRes = spawnSync("git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (dirtyRes.status !== 0 || (dirtyRes.stdout || "").trim().length > 0) {
      throw httpError(400, `Refusing applyGitMerge: repoRoot "${repoRoot}" has uncommitted tracked changes.`);
    }
    const refRes = spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], {
      shell: false,
      windowsHide: true,
    });
    if (refRes.status !== 0) {
      throw httpError(400, `Refusing applyGitMerge: branch "${targetBranch}" does not exist in "${repoRoot}".`);
    }
    const ancRes = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", "HEAD", targetBranch], {
      shell: false,
      windowsHide: true,
    });
    if (ancRes.status !== 0) {
      throw httpError(400, `Refusing applyGitMerge: HEAD is not an ancestor of "${targetBranch}" (fast-forward impossible).`);
    }

    const trialWt = path.join(worktreeRootBase(), "rsi-trial", `trial-${randomUUID().slice(0, 8)}`).replaceAll("\\", "/");
    mkdirSync(path.dirname(trialWt), { recursive: true });
    try {
      const addWt = spawnSync("git", ["-C", repoRoot, "worktree", "add", "--detach", trialWt, targetBranch], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      });
      if (addWt.status !== 0) {
        throw httpError(400, `Trial worktree creation failed: ${(addWt.stderr || addWt.stdout || "").trim()}`);
      }
      if (existsSync(path.join(trialWt, "src", "partition.mjs")) && existsSync(path.join(trialWt, "ui", "contracts.js"))) {
        const trialBench = await runRsiBenchmark({ rootDir: trialWt });
        if (trialBench.regressions > 0 || trialBench.score < existing.baselineScore) {
          throw httpError(
            400,
            `Trial merge benchmark failed (${trialBench.score}/${trialBench.maxScore}, regressions=${trialBench.regressions}); repoRoot untouched.`,
          );
        }
      } else {
        const diffChk = spawnSync("git", ["-C", trialWt, "diff", "--check", "HEAD"], {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
        });
        if (diffChk.status !== 0) {
          throw httpError(400, `Trial merge git diff --check failed: ${(diffChk.stderr || diffChk.stdout || "").trim()}`);
        }
      }
    } finally {
      unmountAllJunctions(trialWt);
      spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", trialWt], { shell: false, windowsHide: true });
      try {
        rmSync(trialWt, { recursive: true, force: true });
      } catch {}
    }

    const mergeRes = spawnSync("git", ["-C", repoRoot, "merge", "--ff-only", targetBranch], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (mergeRes.status !== 0) {
      throw httpError(400, `git merge --ff-only "${targetBranch}" failed: ${(mergeRes.stderr || mergeRes.stdout || "").trim()}`);
    }
    mergeState = "merged_ff_only";
    mergedCommit = resolveGitCommitSha(repoRoot, targetBranch);
  }

  const promoted = buildValidatedCandidate({
    ...existing,
    status: "promoted",
    humanApproved: approved,
    prePromoteCommit: commitSha,
    metadata: {
      ...(existing.metadata || {}),
      mergeState,
      ...(mergedCommit ? { mergedCommit } : {}),
    },
    updatedAt: iso(),
  });

  const run = {
    id: `rsi-run-${randomUUID().slice(0, 12)}`,
    candidateId: promoted.id,
    kind: "promote",
    baselineScore: promoted.baselineScore,
    candidateScore: promoted.candidateScore,
    regressions: promoted.regressions,
    touchesHarness: false,
    metrics: {
      baselineScore: promoted.baselineScore,
      candidateScore: promoted.candidateScore,
      mergeState,
      ...(mergedCommit ? { mergedCommit } : {}),
    },
    audit: promoted.audit,
    commitSha,
    note: `Promoted ${promoted.tier} candidate (${mergeState}, prePromoteCommit=${commitSha.slice(0, 8)}).`,
    createdAt: iso(),
  };

  store.tx(() => {
    store.upsertRsiCandidate(promoted);
    store.insertRsiRun(run);
    if (missionId) {
      const m = store.getMission(missionId);
      if (m && !m.isShowcase) {
        store.recordEvent(m.id, "coordinator", "rsi_promoted", {
          candidateId: promoted.id,
          prePromoteCommit: commitSha,
          tier: promoted.tier,
          mergeState,
          ...(mergedCommit ? { mergedCommit } : {}),
        });
      }
    }
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    mergeState,
    mergedCommit,
    candidate: promoted,
    run,
  };
}

/**
 * Roll back a promoted RSI candidate to `prePromoteCommit`, invoking optional `gitResetFn`
 * or resetting an isolated sandbox worktree if configured, and recording an immutable receipt.
 */
export async function rollbackRsiCandidate(
  store,
  candidateId,
  { gitResetFn = null, repoRoot = null, applyGitReset = false, missionId = null } = {},
) {
  const existing = store.getRsiCandidate(candidateId);
  if (!existing) throw httpError(404, `Unknown RSI candidate "${candidateId}".`);
  if (!existing.prePromoteCommit || !/^[0-9a-f]{7,40}$/i.test(String(existing.prePromoteCommit))) {
    throw httpError(400, `Candidate "${candidateId}" has no recorded prePromoteCommit SHA to roll back to.`);
  }

  let gitResult = "recorded";
  if (typeof gitResetFn === "function") {
    await gitResetFn(existing.prePromoteCommit, existing);
    gitResult = "gitResetFn";
  } else if (applyGitReset === true && repoRoot && existsSync(repoRoot)) {
    const dirtyCheck = spawnSync("git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (dirtyCheck.status !== 0 || (dirtyCheck.stdout || "").trim().length > 0) {
      throw httpError(400, `Refusing git reset --hard: repository "${repoRoot}" has uncommitted tracked changes.`);
    }
    const ancestorCheck = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", existing.prePromoteCommit, "HEAD"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (ancestorCheck.status !== 0) {
      throw httpError(
        400,
        `Refusing git reset --hard: commit "${existing.prePromoteCommit}" is not an ancestor of HEAD in "${repoRoot}".`,
      );
    }
    const r = spawnSync("git", ["-C", repoRoot, "reset", "--hard", existing.prePromoteCommit], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw httpError(400, `git reset --hard failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
    gitResult = "git_reset_hard";
  }

  const rolledBack = buildValidatedCandidate({
    ...existing,
    status: "rolled_back",
    updatedAt: iso(),
  });

  const run = {
    id: `rsi-run-${randomUUID().slice(0, 12)}`,
    candidateId: rolledBack.id,
    kind: "rollback",
    baselineScore: rolledBack.baselineScore,
    candidateScore: rolledBack.candidateScore,
    regressions: rolledBack.regressions,
    touchesHarness: rolledBack.touchesHarness,
    metrics: { restoredCommit: rolledBack.prePromoteCommit, mode: gitResult },
    audit: rolledBack.audit,
    commitSha: rolledBack.prePromoteCommit,
    note: `Rolled back candidate to prePromoteCommit=${rolledBack.prePromoteCommit.slice(0, 8)} (${gitResult}).`,
    createdAt: iso(),
  };

  store.tx(() => {
    store.upsertRsiCandidate(rolledBack);
    store.insertRsiRun(run);
    if (missionId) {
      const m = store.getMission(missionId);
      if (m && !m.isShowcase) {
        store.recordEvent(m.id, "coordinator", "rsi_rolled_back", {
          candidateId: rolledBack.id,
          restoredCommit: rolledBack.prePromoteCommit,
        });
      }
    }
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    candidate: rolledBack,
    restoredCommit: rolledBack.prePromoteCommit,
    run,
  };
}

/** Return cached RSI digest, benchmark snapshot, candidates, and runs (auto-seeding showcase state if empty). */
export function getRsiOverview(store, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const seeded = seedShowcaseRsiIfEmpty(store, { repoRoot });
  const runs = store.listRsiRuns(null, 25);
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    digest: seeded.digest,
    benchmark: seeded.benchmark,
    candidates: seeded.candidates,
    runs,
  };
}

/** Lightweight read-only summary for GET /api/state without triggering heavy scans. */
export function getRsiSummary(store) {
  const candidates = store.listRsiCandidates();
  const digest = store.getRsiKv("latest_digest");
  const benchmark = store.getRsiKv("latest_benchmark");
  return {
    schemaVersion: SCHEMA_VERSION,
    candidateCount: candidates.length,
    pendingAuditCount: candidates.filter((c) => c.status === "evaluated_pending_audit").length,
    promotedCount: candidates.filter((c) => c.status === "promoted").length,
    auditedCount: candidates.filter((c) => c.status === "audited").length,
    selfSandboxCount: candidates.filter((c) => c.tier === "self_sandbox").length,
    proposalOnlyCount: candidates.filter((c) => c.tier === "proposal_only").length,
    latestScore: benchmark?.score ?? null,
    maxScore: benchmark?.maxScore ?? 100,
    totalSessions: digest?.totalSessions ?? 0,
    cloudOffloadPct: digest?.cloudOffloadPct ?? 0,
    freePoolPct: digest?.freePoolPct ?? 0,
    wentQuietCount: digest?.wentQuietQuestions?.length ?? 0,
  };
}
