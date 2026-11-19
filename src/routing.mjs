import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateAccountPool,
  mergeTeamBriefIntoPool,
  readAccountPool,
  readTeamBrief,
  summarizeDegradedAccounts,
} from "./assistants.mjs";
import {
  defaultAdhdDataDir,
  defaultAipcScript,
  defaultConnectAnythingBin,
  defaultDevinVmBridge,
} from "./paths.mjs";

export const ROUTING_MODES = ["single-harness", "playbook-auto", "mix-and-match"];

const BANNED_PATTERNS = [
  { re: /\bkimi\b|kimi[-_]/i, reason: "Kimi is cancelled per owner playbook." },
  { re: /\blithos\b/i, reason: "Lithos is a paid per-call route; disallowed per owner playbook." },
  { re: /\binco\b/i, reason: "Inco is a paid per-call route; disallowed per owner playbook." },
  { re: /\bmakora\b/i, reason: "Makora is a paid per-call route; disallowed per owner playbook." },
  { re: /\bfriendli\b/i, reason: "Friendli is a paid per-call route; disallowed per owner playbook." },
  { re: /\bnanogpt\b/i, reason: "NanoGPT is a paid per-call route; disallowed per owner playbook." },
];

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LOCAL_APPDATA = process.env.LOCALAPPDATA || "";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

function commandExists(name, candidates = []) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const r = spawnSync(locator, [name], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  }
  return null;
}

/** Determine vendor model family so cross-family verification never self-grades. */
export function modelFamilyOf(spec = {}) {
  const m = String(spec?.model || "").toLowerCase();
  const h = String(spec?.harness || "").toLowerCase();
  if (/carbon|hydrogen|argon|gemini/.test(m) || h === "antigravity" || h === "agy") return "google";
  if (/astra|\bsol\b|terra|gpt|codex|dots/.test(m) || h === "codex" || h === "codex-cloud" || h === "dots") return "openai";
  if (/opus|fable|sonnet|claude/.test(m) || h === "claude" || h === "claude-cloud" || h === "claude-desktop") return "anthropic";
  if (/swe-2|devin/.test(m) || h === "devin" || h === "devin-cloud" || h === "devin-vm") return "devin";
  if (/glm/.test(m) || h === "zcode") return "zai";
  if (/qwen/.test(m) || h === "qwen") return "qwen";
  if (/mimo/.test(m)) return "mimo";
  if (/muse/.test(m) || h === "muse" || h === "muse_ai") return "muse";
  if (/grok/.test(m) || h === "grok" || h === "grokbot") return "grok";
  return h || "unknown";
}

function isBannedSpec(spec = {}) {
  const fields = [spec?.model, spec?.harness, spec?.provider, spec?.backend, spec?.dispatch]
    .filter(Boolean)
    .map((x) => String(x));
  const combined = fields.join(" ");
  for (const { re, reason } of BANNED_PATTERNS) {
    if (re.test(combined)) return { banned: true, combined, reason };
  }
  return { banned: false, combined, reason: null };
}

/** Reject banned models/routes and off-harness google-antigravity routing. */
export function assertModelPolicy(spec = {}, activeHarness = "antigravity") {
  const ban = isBannedSpec(spec);
  if (ban.banned) {
    throw new Error(`Policy violation in route "${ban.combined}": ${ban.reason}`);
  }
  const h = String(spec?.harness || "").toLowerCase();
  const m = String(spec?.model || "").toLowerCase();
  const p = String(spec?.provider || "").toLowerCase();
  if ((p.includes("google-antigravity") || m.startsWith("gemini-4-")) && h && h !== "antigravity" && h !== "agy") {
    throw new Error(`Policy violation: Antigravity models (${spec.model}) must only run inside Antigravity itself, not through "${spec.harness}".`);
  }
  if (h === "omp" && p.includes("google-antigravity")) {
    throw new Error("Policy violation: google-antigravity routes from OMP are disallowed.");
  }
  if ((h === "antigravity" || h === "agy") && String(activeHarness || "antigravity").toLowerCase() !== "antigravity" && spec?.dispatch === "native-swarm") {
    // Allowed if explicitly spawned via agy CLI / connect-anything
  }
}

/** Probe installed harnesses, cloud bridges, account pool, ADHD data store, connect-anything, and aipc offload. */
export function detectFleet(overrides = {}) {
  const win = process.platform === "win32";
  const aipcScript = defaultAipcScript();
  const aipcBin = overrides.aipcBin !== undefined ? overrides.aipcBin : commandExists("aipc", [aipcScript && existsSync(aipcScript) ? aipcScript : null]);
  const caCfg = defaultConnectAnythingBin();
  const caBin = overrides.connectAnything !== undefined ? overrides.connectAnything : ((caCfg && existsSync(caCfg) ? caCfg : null) || commandExists("connect-anything"));
  const adhdDir = overrides.adhdDir || defaultAdhdDataDir();
  const adhdDb = path.join(adhdDir, "studio.sqlite");

  const defaultClaudeCloud = path.join(HOME, ".agents", "skills", "claude-cloud", "claude-cloud.ps1");
  const claudeCloudPath =
    overrides.claudeCloud !== undefined
      ? (typeof overrides.claudeCloud === "string" ? overrides.claudeCloud : overrides.claudeCloud?.path || (overrides.claudeCloud ? defaultClaudeCloud : null))
      : (existsSync(defaultClaudeCloud) ? defaultClaudeCloud : null);

  const codexBin = commandExists("codex");
  const codexInstalled = Boolean(codexBin || existsSync(path.join(HOME, ".codex")));
  const codexCloudReady =
    overrides.codexCloud !== undefined
      ? Boolean(typeof overrides.codexCloud === "object" ? overrides.codexCloud?.ready : overrides.codexCloud)
      : codexInstalled;

  const defaultDevinVm = defaultDevinVmBridge();
  const devinVmPath =
    overrides.devinVm !== undefined
      ? (typeof overrides.devinVm === "string" ? overrides.devinVm : overrides.devinVm?.path || (overrides.devinVm ? defaultDevinVm : null))
      : (defaultDevinVm && existsSync(defaultDevinVm) ? defaultDevinVm : null);

  const accountPool =
    overrides.accountPool !== undefined
      ? (overrides.accountPool && overrides.accountPool.summary ? overrides.accountPool : evaluateAccountPool(overrides.accountPool))
      : readAccountPool(overrides.accountPoolOpts || {});

  const harnesses = {
    antigravity: {
      id: "antigravity",
      name: "Antigravity (Carbon / Hydrogen)",
      installed: Boolean(commandExists("agy") || commandExists("antigravity") || existsSync(path.join(HOME, ".gemini", "config"))),
      models: ["gemini-4-carbon", "gemini-4-hydrogen"],
      costTier: "included",
      family: "google",
    },
    claude: {
      id: "claude",
      name: "Claude Code (Opus 5.5 / Fable 2)",
      installed: Boolean(commandExists("claude", [existsSync(path.join(APPDATA, "Claude/claude-code")) ? path.join(APPDATA, "Claude/claude-code") : null])),
      models: ["claude-opus-5-5", "fable-2", "claude-sonnet-5-5"],
      costTier: "included",
      family: "anthropic",
    },
    codex: {
      id: "codex",
      name: "Codex / ChatGPT (Dots/Astra, 6.1 Sol, Terra Max)",
      installed: codexInstalled,
      models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"],
      costTier: "free-dots-then-included",
      family: "openai",
    },
    devin: {
      id: "devin",
      name: "Devin CLI (swe-2, swe-2-flash FREE)",
      installed: Boolean(commandExists("devin")),
      models: ["swe-2-flash", "swe-2", "swe-2-lightning"],
      costTier: "free-swe2",
      family: "devin",
    },
    muse: {
      id: "muse",
      name: "Muse Code / Muse AI (high weekly quota)",
      installed: Boolean(commandExists("muse", [win ? path.join(LOCAL_APPDATA, "Programs/muse") : null])),
      models: ["muse", "muse-ai"],
      costTier: "included-high-quota",
      family: "muse",
    },
    cursor: {
      id: "cursor",
      name: "Cursor",
      installed: Boolean(commandExists("cursor") || existsSync(path.join(HOME, ".cursor"))),
      models: ["default"],
      costTier: "included",
      family: "cursor",
    },
    grok: {
      id: "grok",
      name: "Grok CLI / Grokbot (X search)",
      installed: Boolean(commandExists("grok")),
      models: ["grok"],
      costTier: "included",
      family: "grok",
    },
    qwen: {
      id: "qwen",
      name: "Qwen Code (Qwen 4 Max)",
      installed: Boolean(commandExists("qwen") || existsSync(path.join(HOME, ".qwen"))),
      models: ["qwen-4-max"],
      costTier: "included",
      family: "qwen",
    },
    opencode: {
      id: "opencode",
      name: "OpenCode",
      installed: Boolean(commandExists("opencode") || existsSync(path.join(HOME, ".config", "opencode"))),
      models: ["default"],
      costTier: "included",
      family: "opencode",
    },
    hermes: {
      id: "hermes",
      name: "Hermes Agent",
      installed: Boolean(commandExists("hermes")),
      models: ["default"],
      costTier: "included",
      family: "hermes",
    },
    "claude-desktop": {
      id: "claude-desktop",
      name: "Claude Desktop",
      installed: Boolean(existsSync(path.join(APPDATA, "Claude"))),
      models: ["claude-opus-5-5"],
      costTier: "included",
      family: "anthropic",
    },
  };

  const claudeCloud = {
    ready: Boolean(overrides.claudeCloud?.ready ?? claudeCloudPath),
    path: claudeCloudPath || null,
  };
  const codexCloud = {
    ready: codexCloudReady,
    command: codexBin || null,
  };
  const devinVm = {
    ready: Boolean(overrides.devinVm?.ready ?? devinVmPath),
    path: devinVmPath || null,
  };

  const aipcDisabled = process.env.OVERDRIVE_DISABLE_AIPC === "1";
  const aipcReady = !aipcDisabled && Boolean(aipcBin);
  const teamBrief =
    overrides.teamBrief !== undefined
      ? overrides.teamBrief
      : overrides.skipTeamBrief
        ? null
        : readTeamBrief(overrides.teamBriefOpts || {});
  const mergedAccountPool = mergeTeamBriefIntoPool(accountPool, teamBrief, overrides.accountPoolOpts || {});
  const { degradedAccounts, routingWarnings } = summarizeDegradedAccounts(mergedAccountPool);
  if (aipcDisabled) {
    routingWarnings.push("aipc offload is disabled (OVERDRIVE_DISABLE_AIPC=1); auto offload will run locally.");
  }

  return {
    checkedAt: new Date().toISOString(),
    harnesses,
    routingWarnings,
    degradedAccounts,
    infra: {
      aipc: { ready: aipcReady, path: aipcBin || null, ...(aipcDisabled ? { disabled: true } : {}) },
      connectAnything: { ready: Boolean(caBin), path: caBin || null },
      adhd: { ready: existsSync(adhdDb), dataDir: adhdDir, dbPath: adhdDb },
      claudeCloud,
      codexCloud,
      devinVm,
      accountPool: mergedAccountPool,
      teamBriefSummary: teamBrief
        ? {
            available: Boolean(teamBrief.available),
            asOf: teamBrief.asOf ?? null,
            usageNote: teamBrief.usage?.note || null,
            reason: teamBrief.reason || null,
          }
        : null,
    },
  };
}

function cleanModelId(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  let m = raw.trim();
  if (m.includes("/")) m = m.split("/").pop();
  m = m.replace(/:(?:xhigh|high|max|medium|low)(?:\/(?:xhigh|high|max|medium|low))?$/i, "");
  if (m.toLowerCase() === "claude-sonnet") m = "claude-sonnet-5-5";
  if (isBannedSpec({ model: m }).banned) return fallback;
  return m || fallback;
}

function normalizePool(rawPool) {
  if (!rawPool || typeof rawPool !== "object") return null;
  if (rawPool.summary && rawPool.accounts) return rawPool;
  if (rawPool.accounts && typeof rawPool.accounts === "object") {
    return evaluateAccountPool(rawPool);
  }
  return null;
}

function selectPoolAccount(pool, providers, preferredIds = []) {
  if (!pool || !pool.accounts || typeof pool.accounts !== "object") {
    return { tracked: false, eligible: true, account: null, fallbackSelected: false };
  }
  const provSet = new Set(providers.map((p) => String(p).toLowerCase()));
  const entries = Object.entries(pool.accounts)
    .filter(([id, a]) => {
      const p = String(a?.provider || "").toLowerCase();
      return provSet.has(p) || preferredIds.includes(id);
    })
    .map(([id, a]) => ({ accountId: id, ...a }));

  if (entries.length === 0) {
    return { tracked: false, eligible: true, account: null, fallbackSelected: false };
  }

  const eligible = entries.filter((e) => {
    if (e.eligible === false) return false;
    const candidateModel = e.fallbackModel || e.id;
    if (candidateModel && isBannedSpec({ model: candidateModel, provider: e.provider }).banned) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      tracked: true,
      eligible: false,
      account: null,
      fallbackSelected: false,
      reason: entries[0]?.reason || "pool_ineligible",
    };
  }

  eligible.sort((a, b) => {
    const ai = preferredIds.indexOf(a.accountId);
    const bi = preferredIds.indexOf(b.accountId);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return (b.quotaRemaining ?? 0) - (a.quotaRemaining ?? 0);
  });

  const best = eligible[0];
  const bestRank = preferredIds.indexOf(best.accountId);
  const fallbackSelected = entries.some((e) => {
    if (e.eligible !== false) return false;
    const rank = preferredIds.indexOf(e.accountId);
    if (bestRank !== -1 && rank !== -1) return rank < bestRank;
    if (rank !== -1 && bestRank === -1) return true;
    return entries.indexOf(e) < entries.indexOf(best);
  });
  return { tracked: true, eligible: true, account: best, fallbackSelected };
}

function defaultWorkerSingleHarness(harness, complexity) {
  const h = String(harness || "antigravity").toLowerCase();
  if (h === "antigravity" || h === "agy") {
    return complexity === "hard"
      ? { dispatch: "native-swarm", harness: "antigravity", model: "gemini-4-carbon", effort: "high", costTier: "included", family: "google" }
      : { dispatch: "native-swarm", harness: "antigravity", model: "gemini-4-hydrogen", effort: "medium", costTier: "included", family: "google" };
  }
  if (h === "claude" || h === "claude-cloud") {
    return complexity === "fast"
      ? { dispatch: h === "claude-cloud" ? "claude-cloud" : "native-subagent", harness: h, model: "claude-sonnet-5-5", effort: "medium", costTier: "included", family: "anthropic" }
      : { dispatch: h === "claude-cloud" ? "claude-cloud" : "native-subagent", harness: h, model: "claude-opus-5-5", effort: "high", costTier: "included", family: "anthropic" };
  }
  if (h === "codex" || h === "codex-cloud") {
    const dispatch = h === "codex-cloud" ? "codex-cloud" : "native-subagent";
    if (complexity === "hard") return { dispatch, harness: h, model: "gpt-6-astra", speedTier: "fast", effort: "high", costTier: "free-dots-then-included", family: "openai" };
    if (complexity === "standard") return { dispatch, harness: h, model: "gpt-6.1-sol", speedTier: "fast", effort: "medium", costTier: "included", family: "openai" };
    return { dispatch, harness: h, model: "gpt-6.1-terra", speedTier: "fast", effort: "max", costTier: "included", family: "openai" };
  }
  if (h === "devin" || h === "devin-cloud") {
    return {
      dispatch: h === "devin-cloud" ? "devin-cloud" : "native-subagent",
      harness: h,
      model: complexity === "fast" ? "swe-2-flash" : "swe-2",
      effort: "default",
      costTier: "free",
      family: "devin",
    };
  }
  return { dispatch: "native-subagent", harness: h, model: "default", effort: "medium", costTier: "included", family: modelFamilyOf({ harness: h }) };
}

function buildOpenAiWorker({ dispatch, harness, complexity, poolSel }) {
  const acct = poolSel?.account;
  const defaultModel = complexity === "hard" ? "gpt-6-astra" : complexity === "standard" ? "gpt-6.1-sol" : "gpt-6.1-terra";
  const model =
    poolSel?.fallbackSelected && acct
      ? cleanModelId(acct.fallbackModel || acct.id, defaultModel)
      : defaultModel;
  return {
    dispatch,
    harness,
    model,
    speedTier: "fast",
    effort: complexity === "hard" ? "high" : complexity === "fast" ? "max" : "medium",
    costTier: acct?.cost || "free-dots-then-included",
    family: "openai",
    ...(acct ? { account: acct.accountId } : {}),
    ...(poolSel?.fallbackSelected ? { fallbackSelected: true } : {}),
  };
}

function buildAnthropicWorker({ dispatch, harness, complexity, poolSel }) {
  const acct = poolSel?.account;
  const defaultModel = complexity === "fast" ? "claude-sonnet-5-5" : "claude-opus-5-5";
  const model =
    poolSel?.fallbackSelected && acct
      ? cleanModelId(acct.fallbackModel || acct.id, defaultModel)
      : defaultModel;
  return {
    dispatch,
    harness,
    model,
    effort: complexity === "fast" ? "medium" : "high",
    costTier: "included",
    family: "anthropic",
    ...(acct ? { account: acct.accountId } : {}),
    ...(poolSel?.fallbackSelected ? { fallbackSelected: true } : {}),
  };
}

function pickCrossFamilyVerifier(authorWorkers, fleet, activeHarness, pool) {
  const authorFamilies = new Set(authorWorkers.map((w) => w.family || modelFamilyOf(w)));
  const openaiPool = selectPoolAccount(pool, ["openai"], ["dot", "chatgpt_500", "omp_astra", "dot2", "chatgpt_200", "codex_zero_cost"]);
  const anthropicPool = selectPoolAccount(pool, ["anthropic"], ["claude_1_200", "claude_2_200", "claude_3_200"]);
  const devinPool = selectPoolAccount(pool, ["devin"], ["swe2", "devin", "devin_vm"]);
  const musePool = selectPoolAccount(pool, ["muse"], ["muse_ai"]);

  const candidates = [];
  if (fleet?.harnesses?.codex?.installed && openaiPool.eligible) {
    candidates.push(buildOpenAiWorker({ dispatch: "connect-anything-ask", harness: "codex", complexity: "hard", poolSel: openaiPool }));
  }
  if (fleet?.harnesses?.claude?.installed && anthropicPool.eligible) {
    candidates.push(buildAnthropicWorker({ dispatch: "connect-anything-ask", harness: "claude", complexity: "hard", poolSel: anthropicPool }));
  }
  if (fleet?.harnesses?.devin?.installed && devinPool.eligible) {
    candidates.push({ dispatch: "connect-anything-ask", harness: "devin", model: "swe-2", effort: "default", costTier: "free", family: "devin" });
  }
  if (fleet?.harnesses?.muse?.installed && musePool.eligible) {
    candidates.push({ dispatch: "assistant-relay", harness: "muse", model: "muse-ai", effort: "medium", costTier: "included-high-quota", family: "muse" });
  }
  if (String(activeHarness || "").toLowerCase() === "antigravity" && fleet?.harnesses?.antigravity?.installed) {
    candidates.push({ dispatch: "native-swarm", harness: "antigravity", model: "gemini-4-carbon", effort: "high", costTier: "included", family: "google" });
  }

  const diffFamily = candidates.find((c) => !authorFamilies.has(c.family));
  if (diffFamily) return { ...diffFamily, crossFamily: true };
  if (candidates.length > 0) return { ...candidates[0], crossFamily: false, note: "Fallback to same family because no alternate-family harness was detected." };
  const fb = defaultWorkerSingleHarness(activeHarness, "hard");
  return { ...fb, crossFamily: false, note: "Single-harness fallback verifier." };
}

function hasExplicitAccountDenial(pool, providers, preferredIds = []) {
  if (!pool || !pool.accounts || typeof pool.accounts !== "object") return false;
  const provSet = new Set(providers.map((p) => String(p).toLowerCase()));
  const matching = Object.entries(pool.accounts)
    .filter(([id, a]) => provSet.has(String(a?.provider || "").toLowerCase()) || preferredIds.includes(id))
    .map(([, a]) => a);
  if (matching.length === 0) return false;
  const usable = matching.filter((a) => {
    const st = String(a?.status || "").toLowerCase();
    const deniedStatus = /(?:402|403|retired|exhausted|denied|blocked|parked)/i.test(st) || String(a?.reason || "").startsWith("unavailable:");
    const exhaustedQuota = typeof a?.quotaRemaining === "number" && a.quotaRemaining <= 0;
    const highWindow = a?.reason === "window_usage_high" || a?.reason === "brief_window_usage_high";
    return !deniedStatus && !exhaustedQuota && !highWindow && a?.reason !== "quota_exhausted";
  });
  return usable.length === 0;
}

function resolveDevinEligibility(pool, hDevin, openaiPool, anthropicPool, freeTierPolicy) {
  const devinPool = selectPoolAccount(pool, ["devin"], ["swe2", "devin", "devin_vm"]);
  const installed = Boolean(hDevin?.installed);
  if (!installed) return { eligible: false, freeFallbackUsed: false, devinPool };
  if (devinPool.eligible) return { eligible: true, freeFallbackUsed: false, devinPool };
  if (hasExplicitAccountDenial(pool, ["devin"], ["swe2", "devin", "devin_vm"])) {
    return { eligible: false, freeFallbackUsed: false, devinPool };
  }
  const hasPaidFresh = (openaiPool.tracked && openaiPool.eligible) || (anthropicPool.tracked && anthropicPool.eligible);
  if (!hasPaidFresh && freeTierPolicy !== "require_fresh_pool") {
    return { eligible: true, freeFallbackUsed: true, devinPool };
  }
  return { eligible: false, freeFallbackUsed: false, devinPool };
}

function pickPlaybookWorker(complexity, idx, fleet, activeHarness, { lane = {}, preferCloud = false, pool = null, freeTierPolicy = "local_cli_free_unless_denied" } = {}) {
  const h = fleet?.harnesses || {};
  const infra = fleet?.infra || {};
  const canAgy = String(activeHarness || "antigravity").toLowerCase() === "antigravity" && h.antigravity?.installed;

  const openaiPool = selectPoolAccount(pool, ["openai"], ["dot", "chatgpt_500", "omp_astra", "dot2", "chatgpt_200", "codex_zero_cost"]);
  const anthropicPool = selectPoolAccount(pool, ["anthropic"], ["claude_1_200", "claude_2_200", "claude_3_200"]);
  const musePool = selectPoolAccount(pool, ["muse"], ["muse_ai"]);
  const devinGate = resolveDevinEligibility(pool, h.devin, openaiPool, anthropicPool, freeTierPolicy);
  const devinPool = devinGate.devinPool;

  const canDevin = devinGate.eligible;
  const canCodex = Boolean(h.codex?.installed) && openaiPool.eligible;
  const canClaude = Boolean(h.claude?.installed) && anthropicPool.eligible;
  const canMuse = Boolean(h.muse?.installed) && musePool.eligible;

  const hasClaudeCloud = Boolean(infra.claudeCloud?.ready) && anthropicPool.eligible;
  const hasCodexCloud = Boolean(infra.codexCloud?.ready) && openaiPool.eligible;
  const hasDevinCloud = Boolean(infra.devinVm?.ready) && devinPool.eligible;
  const wantsCloudAgent = lane.offload === "cloud-agent";
  const allowCloudScripts =
    (wantsCloudAgent || (preferCloud && lane.offload !== "local" && lane.offload !== "aipc" && lane.offload !== "aipc-gpu")) &&
    (complexity === "hard" || complexity === "standard" || wantsCloudAgent);

  // Cloud-first offload for heavy parallel coding lanes when cloud scripts exist or offload === "cloud-agent".
  if (allowCloudScripts && (hasClaudeCloud || hasCodexCloud || (wantsCloudAgent && (canClaude || canCodex || hasDevinCloud || canDevin)))) {
    if (complexity === "hard") {
      const cloudOptions = [];
      if (hasClaudeCloud || (wantsCloudAgent && canClaude)) {
        cloudOptions.push(buildAnthropicWorker({ dispatch: "claude-cloud", harness: "claude-cloud", complexity: "hard", poolSel: anthropicPool }));
      }
      if (hasCodexCloud || (wantsCloudAgent && canCodex)) {
        cloudOptions.push(buildOpenAiWorker({ dispatch: "codex-cloud", harness: "codex-cloud", complexity: "hard", poolSel: openaiPool }));
      }
      if (wantsCloudAgent && (hasDevinCloud || canDevin) && cloudOptions.length === 0) {
        cloudOptions.push({
          dispatch: hasDevinCloud ? "devin-cloud" : "connect-anything-ask",
          harness: "devin",
          model: "swe-2",
          effort: "default",
          costTier: "free",
          family: "devin",
          ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
        });
      }
      if (cloudOptions.length > 0) {
        return cloudOptions[idx % cloudOptions.length];
      }
    }

    if (complexity === "standard") {
      // Spend free capacity #1 (Devin swe-2) before billed cloud models unless devin is denied.
      if (canDevin) {
        return {
          dispatch: wantsCloudAgent && hasDevinCloud ? "devin-cloud" : "connect-anything-ask",
          harness: "devin",
          model: "swe-2",
          effort: "default",
          costTier: "free",
          family: "devin",
          ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
        };
      }
      if (hasCodexCloud || (wantsCloudAgent && canCodex)) {
        return buildOpenAiWorker({ dispatch: "codex-cloud", harness: "codex-cloud", complexity: "standard", poolSel: openaiPool });
      }
      if (hasClaudeCloud || (wantsCloudAgent && canClaude)) {
        return buildAnthropicWorker({ dispatch: "claude-cloud", harness: "claude-cloud", complexity: "standard", poolSel: anthropicPool });
      }
    }

    if (complexity === "fast" && wantsCloudAgent) {
      if (canDevin) {
        return {
          dispatch: hasDevinCloud ? "devin-cloud" : "connect-anything-ask",
          harness: "devin",
          model: "swe-2-flash",
          effort: "default",
          costTier: "free",
          family: "devin",
          ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
        };
      }
      if (hasCodexCloud || canCodex) {
        return buildOpenAiWorker({ dispatch: "codex-cloud", harness: "codex-cloud", complexity: "fast", poolSel: openaiPool });
      }
      if (hasClaudeCloud || canClaude) {
        return buildAnthropicWorker({ dispatch: "claude-cloud", harness: "claude-cloud", complexity: "fast", poolSel: anthropicPool });
      }
    }
  }

  // Free research/audit role hint when Muse AI is available.
  if (lane.role && /research|audit|review/i.test(String(lane.role)) && canMuse) {
    return { dispatch: "assistant-relay", harness: "muse", model: "muse-ai", effort: "medium", costTier: "included-high-quota", family: "muse" };
  }

  // Standard v0.2 playbook ordering (respecting exhausted / >=80% / stale pool exclusions).
  if (complexity === "hard") {
    const hardOptions = [];
    if (canAgy) hardOptions.push(defaultWorkerSingleHarness("antigravity", "hard"));
    if (canCodex) hardOptions.push(buildOpenAiWorker({ dispatch: "connect-anything-ask", harness: "codex", complexity: "hard", poolSel: openaiPool }));
    if (canClaude) hardOptions.push(buildAnthropicWorker({ dispatch: "connect-anything-ask", harness: "claude", complexity: "hard", poolSel: anthropicPool }));
    if (hardOptions.length > 0) return hardOptions[idx % hardOptions.length];
    if (canDevin) {
      return {
        dispatch: "connect-anything-ask",
        harness: "devin",
        model: "swe-2",
        effort: "default",
        costTier: "free",
        family: "devin",
        ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
      };
    }
  }

  if (complexity === "fast") {
    if (canDevin) {
      return {
        dispatch: "connect-anything-ask",
        harness: "devin",
        model: "swe-2-flash",
        effort: "default",
        costTier: "free",
        family: "devin",
        ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
      };
    }
    if (canAgy) return defaultWorkerSingleHarness("antigravity", "fast");
    if (canCodex) return buildOpenAiWorker({ dispatch: "connect-anything-ask", harness: "codex", complexity: "fast", poolSel: openaiPool });
    if (canClaude) return buildAnthropicWorker({ dispatch: "connect-anything-ask", harness: "claude", complexity: "fast", poolSel: anthropicPool });
  }

  // Standard complexity: free Devin swe-2 first, then Dots/Codex/Hydrogen/Opus.
  if (canDevin) {
    return {
      dispatch: "connect-anything-ask",
      harness: "devin",
      model: "swe-2",
      effort: "default",
      costTier: "free",
      family: "devin",
      ...(devinGate.freeFallbackUsed ? { freeTierOverride: "local_cli_free_unless_denied" } : {}),
    };
  }
  if (canCodex) return buildOpenAiWorker({ dispatch: "connect-anything-ask", harness: "codex", complexity: "standard", poolSel: openaiPool });
  if (canAgy) return defaultWorkerSingleHarness("antigravity", "standard");
  if (canClaude) return buildAnthropicWorker({ dispatch: "connect-anything-ask", harness: "claude", complexity: "standard", poolSel: anthropicPool });

  return defaultWorkerSingleHarness(activeHarness, complexity);
}

/**
 * Assign concrete worker + verifier + offload execution routes for every lane
 * under the mission's selected routing mode.
 */
export function resolveMissionRouting(mission, lanes, fleet = detectFleet(), opts = {}) {
  const mode = ROUTING_MODES.includes(mission?.routingMode) ? mission.routingMode : "single-harness";
  const activeHarness = String(mission?.activeHarness || "antigravity").toLowerCase();
  const freeTierPolicy = opts.freeTierPolicy || "local_cli_free_unless_denied";
  const aipcDisabled = process.env.OVERDRIVE_DISABLE_AIPC === "1";
  const aipcReady = !aipcDisabled && Boolean(fleet?.infra?.aipc?.ready);
  const devinVmReady = Boolean(fleet?.infra?.devinVm?.ready);
  const preferCloud = opts.preferCloud ?? (mode === "playbook-auto" && lanes.length >= 2);
  const pool = normalizePool(opts.accountPool !== undefined ? opts.accountPool : fleet?.infra?.accountPool || null);
  const { degradedAccounts, routingWarnings: poolWarnings } = pool
    ? summarizeDegradedAccounts(pool)
    : { degradedAccounts: fleet?.degradedAccounts || [], routingWarnings: fleet?.routingWarnings ? [...fleet.routingWarnings] : [] };
  const routingWarnings = [...poolWarnings];
  let devinFreeBypassNoted = false;

  const resolvedLanes = lanes.map((lane, idx) => {
    let worker;
    if (mode === "single-harness") {
      worker = defaultWorkerSingleHarness(activeHarness, lane.complexity);
    } else if (mode === "playbook-auto") {
      worker = pickPlaybookWorker(lane.complexity, idx, fleet, activeHarness, { lane, preferCloud, pool, freeTierPolicy });
      if (worker?.freeTierOverride) devinFreeBypassNoted = true;
    } else {
      // mix-and-match: keep explicit worker if provided, otherwise fall back cleanly
      if (lane.worker && typeof lane.worker === "object" && (lane.worker.harness || lane.worker.model)) {
        const fam = lane.worker.family || modelFamilyOf(lane.worker);
        worker = {
          dispatch: lane.worker.dispatch || (String(lane.worker.harness || "").toLowerCase() === activeHarness ? "native-swarm" : "connect-anything-ask"),
          harness: lane.worker.harness || activeHarness,
          model: lane.worker.model || "default",
          effort: lane.worker.effort || "medium",
          speedTier: lane.worker.speedTier || "standard",
          costTier: lane.worker.costTier || "custom",
          ...(lane.worker.account ? { account: lane.worker.account } : {}),
          family: fam,
        };
      } else {
        worker = pickPlaybookWorker(lane.complexity, idx, fleet, activeHarness, { lane, preferCloud, pool, freeTierPolicy });
        if (worker?.freeTierOverride) devinFreeBypassNoted = true;
      }
    }
    assertModelPolicy(worker, activeHarness);

    const rawOffload = lane.offload || "auto";
    let offloadActual = rawOffload;
    if (rawOffload === "local") {
      offloadActual = "local";
    } else if (rawOffload === "cloud-agent") {
      offloadActual = "cloud-agent";
    } else if (rawOffload === "devin-vm") {
      offloadActual = devinVmReady ? "devin-vm" : aipcReady ? "aipc auto" : "local";
    } else if (rawOffload === "aipc-gpu") {
      offloadActual = aipcReady ? "aipc --gpu" : "local";
    } else if (rawOffload === "aipc") {
      offloadActual = aipcReady ? "aipc auto" : "local";
    } else if (rawOffload === "auto") {
      if (["claude-cloud", "codex-cloud", "devin-cloud"].includes(worker.dispatch)) {
        offloadActual = "cloud-agent";
      } else {
        offloadActual = aipcReady ? "aipc auto" : "local";
      }
    }

    return { ...lane, worker, effectiveOffload: offloadActual };
  });

  if (devinFreeBypassNoted) {
    routingWarnings.push(
      "Free-tier local Devin CLI (swe-2 / swe-2-flash) kept active under local_cli_free_unless_denied policy while paid accounts are stale/unavailable.",
    );
  }

  let fallbackVerifierNoted = false;
  // Assign verifiers (1 shared verifier group per 1-3 author lanes; mix-and-match preserves explicit).
  const finalLanes = resolvedLanes.map((lane, idx) => {
    let verifier;
    if (mode === "mix-and-match" && lane.verifier && typeof lane.verifier === "object" && (lane.verifier.harness || lane.verifier.model)) {
      verifier = {
        ...lane.verifier,
        family: lane.verifier.family || modelFamilyOf(lane.verifier),
        crossFamily: modelFamilyOf(lane.verifier) !== lane.worker.family,
      };
    } else if (mode === "single-harness") {
      const v = defaultWorkerSingleHarness(activeHarness, "hard");
      verifier = { ...v, groupIndex: Math.floor(idx / 3) + 1, crossFamily: false, note: `Verifies lanes inside ${activeHarness} (${v.model}).` };
    } else {
      const groupStart = Math.floor(idx / 3) * 3;
      const groupAuthors = resolvedLanes.slice(groupStart, groupStart + 3).map((l) => l.worker);
      verifier = { ...pickCrossFamilyVerifier(groupAuthors, fleet, activeHarness, pool), groupIndex: Math.floor(idx / 3) + 1 };
      if (!verifier.crossFamily) fallbackVerifierNoted = true;
    }
    assertModelPolicy(verifier, activeHarness);
    return { ...lane, verifier };
  });

  if (fallbackVerifierNoted && mode !== "single-harness") {
    routingWarnings.push(
      "Cross-family verifier fell back to same-family reviewer because alternate-family accounts/harnesses were excluded or missing.",
    );
  }

  return {
    mode,
    activeHarness,
    preferCloud,
    freeTierPolicy,
    lanes: finalLanes,
    routingWarnings: Array.from(new Set(routingWarnings)),
    degradedAccounts,
  };
}
