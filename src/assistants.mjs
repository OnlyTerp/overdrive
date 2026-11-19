import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { defaultAccountPoolPath, defaultAssistantMcpServer, defaultTeamCliPath } from "./paths.mjs";
import { ASSISTANT_IDS } from "./ui-contracts.mjs";

export { ASSISTANT_IDS };

export const DEFAULT_TEAM_CLI_PATH = defaultTeamCliPath();
export const DEFAULT_ACCOUNT_POOL_PATH = defaultAccountPoolPath();

const USABLE_STATUSES = new Set(["ok", "available", "low"]);
const ISO_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bdevin-session-token\$[^\s"']+/,
];

function parseIsoWithTz(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_WITH_TZ_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function toNowMs(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  if (typeof now === "string") {
    const ms = Date.parse(now);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * Read the local assistant team brief (`team_cli.py brief`) in read-only mode.
 * Returns `{ available: false, reason }` cleanly if unavailable, never throwing.
 */
export function readTeamBrief({
  since,
  scriptPath = defaultTeamCliPath(),
  pythonExe = "python",
  runner,
  timeoutMs = 10_000,
} = {}) {
  try {
    if (!runner && (!scriptPath || !existsSync(scriptPath))) {
      return { available: false, reason: "team_cli_missing", scriptPath, untrusted: true };
    }
    const exec =
      typeof runner === "function"
        ? runner
        : (cmd, args, opts) => spawnSync(cmd, args, opts);
    const res = exec(pythonExe, [scriptPath, "brief"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    if (!res || res.error) {
      return {
        available: false,
        reason: res?.error?.message || "team_cli_spawn_failed",
        scriptPath,
        untrusted: true,
      };
    }
    const exitCode = res.status ?? res.exitCode ?? 0;
    if (exitCode !== 0) {
      return {
        available: false,
        reason: `team_cli_exit_${exitCode}`,
        stderrTail: String(res.stderr || res.stdout || "").slice(-500),
        scriptPath,
        untrusted: true,
      };
    }
    const parsed = JSON.parse(String(res.stdout || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { available: false, reason: "team_brief_invalid_json", scriptPath, untrusted: true };
    }
    const sinceNum = since !== undefined && since !== null && Number.isFinite(Number(since)) ? Number(since) : null;
    const recentNotes = Array.isArray(parsed.recent_notes)
      ? (sinceNum !== null ? parsed.recent_notes.filter((n) => (n?.at || 0) > sinceNum) : parsed.recent_notes)
      : [];
    const team = Array.isArray(parsed.team) ? parsed.team : [];
    const members = Array.isArray(parsed.members)
      ? parsed.members
      : team.map((m) => ({ id: m.id, name: m.name, wake: m.can_be_woken ? "webhook" : "poll" }));

    return {
      available: true,
      untrusted: true,
      asOf: parsed.as_of ?? null,
      filteredSince: sinceNum,
      members,
      team,
      work: parsed.work || { yours: [], others: [] },
      recentNotes,
      takeovers: parsed.takeovers || { latest: [], orders: [] },
      usage: parsed.resources?.usage || parsed.usage || null,
      raw: parsed,
    };
  } catch (err) {
    return {
      available: false,
      reason: String(err?.message || err || "team_brief_error"),
      scriptPath,
      untrusted: true,
    };
  }
}

/**
 * Evaluate one account entry strictly matching ACCOUNT_ROUTER.py rules plus 80% window avoidance.
 */
export function evaluateAccountEntry(account, pool, nowMs, { maxAgeSeconds = 86400, maxUsagePct = 80 } = {}) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    return { eligible: false, reason: "account_missing" };
  }
  const status = String(account.status ?? "unknown").trim().toLowerCase();
  if (!USABLE_STATUSES.has(status)) {
    return { eligible: false, reason: `unavailable:${status}`, status };
  }
  const quota = account.quota_remaining;
  if (typeof quota === "boolean" || typeof quota !== "number" || !Number.isFinite(quota)) {
    return { eligible: false, reason: "quota_unknown", status };
  }
  if (quota <= 0) {
    return { eligible: false, reason: "quota_exhausted", status, quotaRemaining: quota };
  }
  const observedRaw = account.observed_at || account.updated_at || pool?.updated_at;
  const observedMs = parseIsoWithTz(observedRaw);
  if (observedMs === null) {
    return { eligible: false, reason: "observation_missing", status, quotaRemaining: quota };
  }
  const ageSeconds = (nowMs - observedMs) / 1000;
  if (ageSeconds < -300) {
    return {
      eligible: false,
      reason: "observation_in_future",
      status,
      quotaRemaining: quota,
      observedAt: observedRaw,
      ageSeconds,
    };
  }
  if (ageSeconds > maxAgeSeconds) {
    return {
      eligible: false,
      reason: "observation_stale",
      status,
      quotaRemaining: quota,
      observedAt: observedRaw,
      ageSeconds,
    };
  }
  const usedPercent = account.used_percent ?? account.usedPercent ?? null;
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= maxUsagePct) {
    return {
      eligible: false,
      reason: "window_usage_high",
      status,
      quotaRemaining: quota,
      usedPercent,
      observedAt: observedRaw,
      ageSeconds,
    };
  }

  return {
    eligible: true,
    reason: "available_from_reported_snapshot",
    status,
    quotaRemaining: quota,
    usedPercent: typeof usedPercent === "number" && Number.isFinite(usedPercent) ? usedPercent : null,
    observedAt: observedRaw,
    ageSeconds,
  };
}

/**
 * Evaluate an in-memory account_pool object using ACCOUNT_ROUTER.py freshness + 80% usage rules.
 */
export function evaluateAccountPool(poolObj, { now = new Date(), maxAgeSeconds = 86400, maxUsagePct = 80, poolPath = null } = {}) {
  const nowMs = toNowMs(now);
  if (!poolObj || typeof poolObj !== "object" || !poolObj.accounts || typeof poolObj.accounts !== "object" || Array.isArray(poolObj.accounts)) {
    return {
      available: false,
      reason: "pool_invalid",
      poolPath,
      checkedAt: new Date(nowMs).toISOString(),
      maxAgeSeconds,
      maxUsagePct,
      accounts: {},
      eligibleIds: [],
      ineligibleIds: [],
      lanes: {},
      summary: { total: 0, eligible: 0, ineligible: 0 },
    };
  }

  const evaluated = {};
  const eligibleIds = [];
  const ineligibleIds = [];
  for (const [id, acct] of Object.entries(poolObj.accounts)) {
    const res = evaluateAccountEntry(acct, poolObj, nowMs, { maxAgeSeconds, maxUsagePct });
    evaluated[id] = {
      accountId: id,
      provider: acct?.provider || null,
      plan: acct?.plan || null,
      id: acct?.id || null,
      fallbackModel: acct?.fallback_model || null,
      role: acct?.role || null,
      ...res,
    };
    if (res.eligible) eligibleIds.push(id);
    else ineligibleIds.push(id);
  }

  return {
    available: true,
    source: "reported_snapshot_not_live_provider_probe",
    poolPath,
    updatedAt: poolObj.updated_at || null,
    checkedAt: new Date(nowMs).toISOString(),
    maxAgeSeconds,
    maxUsagePct,
    accounts: evaluated,
    eligibleIds,
    ineligibleIds,
    lanes: poolObj.lanes && typeof poolObj.lanes === "object" ? poolObj.lanes : {},
    summary: {
      total: eligibleIds.length + ineligibleIds.length,
      eligible: eligibleIds.length,
      ineligible: ineligibleIds.length,
    },
  };
}

/**
 * Read and evaluate `account_pool.json` strictly like `ACCOUNT_ROUTER.py` + 80% window avoidance.
 * Fails cleanly (`{ available: false, reason }`) when missing or unreadable.
 */
export function readAccountPool({
  poolPath = defaultAccountPoolPath(),
  now = new Date(),
  maxAgeSeconds = 86400,
  maxUsagePct = 80,
} = {}) {
  try {
    if (!poolPath || !existsSync(poolPath)) {
      return {
        available: false,
        reason: "pool_missing",
        poolPath,
        checkedAt: new Date(toNowMs(now)).toISOString(),
        maxAgeSeconds,
        maxUsagePct,
        accounts: {},
        eligibleIds: [],
        ineligibleIds: [],
        lanes: {},
        summary: { total: 0, eligible: 0, ineligible: 0 },
      };
    }
    const parsed = JSON.parse(readFileSync(poolPath, "utf8"));
    return evaluateAccountPool(parsed, { now, maxAgeSeconds, maxUsagePct, poolPath });
  } catch (err) {
    return {
      available: false,
      reason: `pool_read_error:${String(err?.message || err)}`,
      poolPath,
      checkedAt: new Date(toNowMs(now)).toISOString(),
      maxAgeSeconds,
      maxUsagePct,
      accounts: {},
      eligibleIds: [],
      ineligibleIds: [],
      lanes: {},
      summary: { total: 0, eligible: 0, ineligible: 0 },
    };
  }
}

const ASSISTANT_ACCOUNT_KEYS = {
  muse_ai: ["muse_ai", "muse-ai", "muse"],
  dot: ["dot", "dot_primary", "dot1", "chatgpt_500"],
  dot2: ["dot2", "dot_secondary", "chatgpt_200"],
  grokbot: ["grokbot", "grok"],
  duet: ["duet", "claude_duet"],
  devin: ["devin", "swe2", "devin_vm"],
};

const ASSISTANT_USAGE_PROVIDERS = {
  muse_ai: ["muse", "muse_ai"],
  dot: ["codex", "openai", "dot"],
  dot2: ["codex", "openai", "dot2"],
  grokbot: ["grok", "grokbot", "xai"],
  duet: ["claude_code", "anthropic", "duet"],
  devin: ["devin"],
};

function rolePreferenceOrder(role) {
  const r = String(role || "general").toLowerCase();
  if (/\b(x|twitter|web)[-_ ]?(search|research)?\b|grok/.test(r)) {
    return ["grokbot", "muse_ai", "dot", "dot2", "devin"];
  }
  if (/research|audit|review|summary|check|verify|second[-_ ]?opinion/.test(r)) {
    return ["muse_ai", "dot", "dot2", "grokbot", "devin"];
  }
  if (/astra|hard|plan|architect|chatgpt|codex|reason/.test(r)) {
    return ["dot", "dot2", "muse_ai", "duet", "devin"];
  }
  return ["muse_ai", "dot", "dot2", "devin", "grokbot", "duet"];
}

function findMatchingPoolEntries(assistantId, evaluatedPool) {
  if (!evaluatedPool?.accounts) return [];
  const aliases = ASSISTANT_ACCOUNT_KEYS[assistantId] || [assistantId];
  const out = [];
  for (const [key, entry] of Object.entries(evaluatedPool.accounts)) {
    const lk = key.toLowerCase();
    const lp = String(entry?.provider || "").toLowerCase();
    if (aliases.includes(lk) || (assistantId === "muse_ai" && lp === "muse") || (assistantId === "grokbot" && lp === "xai")) {
      out.push(entry);
    }
  }
  return out;
}

function briefUsageExceedsCap(assistantId, teamBrief, maxUsagePct) {
  const windows = teamBrief?.usage?.windows || teamBrief?.raw?.resources?.usage?.windows;
  if (!Array.isArray(windows)) return false;
  const providers = new Set(ASSISTANT_USAGE_PROVIDERS[assistantId] || [assistantId]);
  for (const row of windows) {
    const prov = Array.isArray(row) ? row[0] : row?.provider;
    const used = Array.isArray(row) ? row[2] : row?.used;
    const baseProv = String(prov || "").split("@", 1)[0].toLowerCase();
    if (providers.has(baseProv) && typeof used === "number" && Number.isFinite(used)) {
      const pct = used <= 1 ? used * 100 : used;
      if (pct >= maxUsagePct) return true;
    }
  }
  return false;
}

/**
 * Select the best eligible assistant for a role while enforcing account_pool freshness
 * and never assuming an unconnected assistant is verified.
 */
export function selectAssistantForRole(
  role = "research",
  { pool = null, teamBrief = null, maxAgeSeconds = 86400, maxUsagePct = 80 } = {},
) {
  const normPool =
    pool === null || pool === undefined
      ? null
      : pool.summary && pool.accounts && (pool.eligibleIds || pool.available === false)
        ? pool
        : evaluateAccountPool(pool, { maxAgeSeconds, maxUsagePct });

  const briefAvailable = Boolean(teamBrief && teamBrief.available !== false);
  const briefMemberIds = new Set(
    briefAvailable
      ? [
          ...(Array.isArray(teamBrief.members) ? teamBrief.members.map((m) => m?.id) : []),
          ...(Array.isArray(teamBrief.team) ? teamBrief.team.map((m) => m?.id) : []),
        ]
          .filter(Boolean)
          .map((id) => String(id).toLowerCase())
      : [],
  );

  const order = rolePreferenceOrder(role);
  const evaluated = [];

  for (const assistantId of order) {
    const poolEntries = normPool ? findMatchingPoolEntries(assistantId, normPool) : [];
    const inBrief = briefMemberIds.has(assistantId);

    if (normPool && !normPool.available && !inBrief) {
      evaluated.push({ assistant: assistantId, eligible: false, verified: false, reason: normPool.reason || "pool_unavailable" });
      continue;
    }

    if (poolEntries.length > 0) {
      const eligibleEntry = poolEntries.find((e) => e.eligible);
      if (!eligibleEntry) {
        evaluated.push({
          assistant: assistantId,
          eligible: false,
          verified: inBrief,
          reason: poolEntries[0]?.reason || "pool_ineligible",
        });
        continue;
      }
      if (briefAvailable && briefUsageExceedsCap(assistantId, teamBrief, maxUsagePct)) {
        evaluated.push({ assistant: assistantId, eligible: false, verified: inBrief, reason: "brief_window_usage_high" });
        continue;
      }
      const candidate = {
        assistant: assistantId,
        eligible: true,
        verified: inBrief,
        source: inBrief ? "account_pool+team_brief" : "account_pool",
        accountId: eligibleEntry.accountId,
        observedAt: eligibleEntry.observedAt,
        quotaRemaining: eligibleEntry.quotaRemaining,
        usedPercent: eligibleEntry.usedPercent,
        reason: eligibleEntry.reason,
      };
      evaluated.push(candidate);
      return {
        role,
        selected: assistantId,
        assistant: assistantId,
        verified: inBrief,
        noRoute: false,
        ...candidate,
        evaluated,
      };
    }

    if (inBrief) {
      if (briefUsageExceedsCap(assistantId, teamBrief, maxUsagePct)) {
        evaluated.push({ assistant: assistantId, eligible: false, verified: true, reason: "brief_window_usage_high" });
        continue;
      }
      // If pool explicitly contains accounts and has zero fresh entries anywhere, do not bypass stale pool unless brief has fresh asOf.
      const poolAllStale =
        normPool &&
        normPool.available &&
        normPool.summary.total > 0 &&
        normPool.summary.eligible === 0 &&
        normPool.ineligibleIds.every((id) => normPool.accounts[id]?.reason === "observation_stale");
      if (poolAllStale && !teamBrief?.asOf) {
        evaluated.push({ assistant: assistantId, eligible: false, verified: true, reason: "pool_all_stale" });
        continue;
      }
      const candidate = {
        assistant: assistantId,
        eligible: true,
        verified: true,
        source: "team_brief",
        observedAt: teamBrief.asOf ? new Date(Number(teamBrief.asOf) * 1000).toISOString() : null,
        reason: "connected_in_team_brief",
      };
      evaluated.push(candidate);
      return {
        role,
        selected: assistantId,
        assistant: assistantId,
        verified: true,
        noRoute: false,
        ...candidate,
        evaluated,
      };
    }

    evaluated.push({ assistant: assistantId, eligible: false, verified: false, reason: "unconnected_or_unreported" });
  }

  return {
    role,
    selected: null,
    assistant: null,
    verified: false,
    noRoute: true,
    reason: "no_eligible_assistant",
    evaluated,
  };
}

/**
 * Validate an assistant assignment target and build a non-executing assignment descriptor.
 * Respects task authority: never auto-dispatches work.
 */
export function buildAssistantAssignment({ to, goal, folder = null, key = null } = {}) {
  const target = String(to || "").trim();
  if (!ASSISTANT_IDS.includes(target)) {
    throw new Error(`Invalid assistant "${to}". Expected one of: ${ASSISTANT_IDS.join(", ")}`);
  }
  const cleanGoal = typeof goal === "string" ? goal.trim() : "";
  if (!cleanGoal) {
    throw new Error("Assistant assignment requires a non-empty goal.");
  }
  for (const rx of SECRET_PATTERNS) {
    if (rx.test(cleanGoal)) {
      throw new Error("SECRET_REDACTION_FAILED: refusing to include credential/token material in assistant assignment.");
    }
  }
  const cleanFolder = folder ? String(folder).trim() : null;
  const cleanKey = key ? String(key).trim() : null;

  const teamCliScript = defaultTeamCliPath() || "team_cli.py";
  const cliArgs = [teamCliScript, "assign", "--to", target, "--goal", cleanGoal];
  if (cleanFolder) cliArgs.push("--folder", cleanFolder);
  if (cleanKey) cliArgs.push("--key", cleanKey);

  return {
    to: target,
    goal: cleanGoal,
    folder: cleanFolder,
    key: cleanKey,
    autoDispatched: false,
    executed: false,
    requiresExplicitAuthorization: true,
    cli: {
      command: "python",
      args: cliArgs,
    },
    mcp: {
      server: defaultAssistantMcpServer(),
      tool: "assistant_assign",
      arguments: {
        to: target,
        goal: cleanGoal,
        ...(cleanFolder ? { folder: cleanFolder } : {}),
        ...(cleanKey ? { key: cleanKey } : {}),
      },
    },
  };
}

const BRIEF_USAGE_PROVIDERS = {
  anthropic: ["claude_code", "anthropic", "claude"],
  openai: ["codex", "openai"],
  devin: ["devin"],
  muse: ["muse", "muse_ai"],
  xai: ["grok", "grokbot", "xai"],
};

const EXPLICIT_DENY_RE = /(?:402|403|retired|exhausted|denied|blocked|parked)/i;

function recomputePoolSummary(evaluatedPool, accountsMap) {
  const eligibleIds = [];
  const ineligibleIds = [];
  for (const [id, entry] of Object.entries(accountsMap)) {
    if (entry?.eligible) eligibleIds.push(id);
    else ineligibleIds.push(id);
  }
  return {
    ...evaluatedPool,
    accounts: accountsMap,
    eligibleIds,
    ineligibleIds,
    summary: {
      total: eligibleIds.length + ineligibleIds.length,
      eligible: eligibleIds.length,
      ineligible: ineligibleIds.length,
    },
  };
}

/**
 * Overlay fresh numeric usage windows reported by `team_cli.py brief` onto stale
 * `account_pool.json` entries without ever overriding explicit denials (402/403/retired/0-quota)
 * or inventing timestamps when brief usage is "unmeasured".
 */
export function mergeTeamBriefIntoPool(evaluatedPool, teamBrief, { now = new Date(), maxAgeSeconds = 86400, maxUsagePct = 80 } = {}) {
  if (!evaluatedPool || typeof evaluatedPool !== "object" || !evaluatedPool.accounts) return evaluatedPool;
  if (!teamBrief || teamBrief.available === false) return evaluatedPool;
  const windows = teamBrief.usage?.windows || teamBrief.raw?.resources?.usage?.windows;
  if (!Array.isArray(windows) || windows.length === 0) return evaluatedPool;

  const rawAsOf = Number(teamBrief.asOf);
  if (!Number.isFinite(rawAsOf) || rawAsOf <= 0) return evaluatedPool;
  const briefMs = rawAsOf > 1e12 ? rawAsOf : rawAsOf * 1000;
  const nowMs = toNowMs(now);
  const ageSeconds = (nowMs - briefMs) / 1000;
  if (ageSeconds < -300 || ageSeconds > maxAgeSeconds) return evaluatedPool;

  const briefIso = new Date(briefMs).toISOString();
  const nextAccounts = { ...evaluatedPool.accounts };
  let updatedCount = 0;

  for (const [id, entry] of Object.entries(evaluatedPool.accounts)) {
    if (!entry || typeof entry !== "object") continue;
    const statusStr = String(entry.status || "");
    const explicitlyDenied =
      EXPLICIT_DENY_RE.test(statusStr) ||
      (typeof entry.quotaRemaining === "number" && entry.quotaRemaining <= 0) ||
      entry.reason === "quota_exhausted" ||
      String(entry.reason || "").startsWith("unavailable:");
    if (explicitlyDenied) continue;
    if (entry.reason !== "observation_stale" && entry.reason !== "observation_missing") continue;

    const prov = String(entry.provider || "").toLowerCase();
    const aliases = BRIEF_USAGE_PROVIDERS[prov] || [prov];
    const matchingRows = windows.filter((row) => {
      const rp = Array.isArray(row) ? row[0] : row?.provider;
      const baseProv = String(rp || "").split("@", 1)[0].toLowerCase();
      return aliases.includes(baseProv);
    });
    if (matchingRows.length === 0) continue;

    let bestPct = null;
    for (const row of matchingRows) {
      const used = Array.isArray(row) ? row[2] : row?.used;
      if (typeof used === "number" && Number.isFinite(used)) {
        const pct = used <= 1 ? used * 100 : used;
        bestPct = bestPct === null ? pct : Math.max(bestPct, pct);
      }
    }
    if (bestPct === null) continue;

    const ok = bestPct < maxUsagePct;
    nextAccounts[id] = {
      ...entry,
      usedPercent: Math.round(bestPct * 10) / 10,
      observedAt: briefIso,
      ageSeconds,
      eligible: ok,
      reason: ok ? "available_from_team_brief_window" : "window_usage_high",
      source: "team_brief_usage_window",
    };
    updatedCount += 1;
  }

  if (updatedCount === 0) return evaluatedPool;
  return {
    ...recomputePoolSummary(evaluatedPool, nextAccounts),
    teamBriefOverlayCount: updatedCount,
    teamBriefAsOf: briefIso,
  };
}

/** Build structured degradedAccounts & human-readable routingWarnings from an evaluated pool. */
export function summarizeDegradedAccounts(pool) {
  const degradedAccounts = [];
  const routingWarnings = [];
  if (!pool || typeof pool !== "object") {
    return { degradedAccounts, routingWarnings: ["Account pool unavailable; routing fell back to defaults."] };
  }
  if (pool.available === false) {
    return {
      degradedAccounts,
      routingWarnings: [`Account pool unavailable (${pool.reason || "missing"}); paid cloud/CLI eligibility unknown.`],
    };
  }
  const accounts = pool.accounts && typeof pool.accounts === "object" ? pool.accounts : {};
  for (const [accountId, a] of Object.entries(accounts)) {
    if (!a || a.eligible) continue;
    degradedAccounts.push({
      accountId,
      provider: a.provider || null,
      status: a.status || null,
      reason: a.reason || "ineligible",
      quotaRemaining: a.quotaRemaining ?? null,
      usedPercent: a.usedPercent ?? null,
      observedAt: a.observedAt || pool.updatedAt || null,
      ageHours: typeof a.ageSeconds === "number" && Number.isFinite(a.ageSeconds) ? Math.round(a.ageSeconds / 360) / 10 : null,
    });
  }

  const total = pool.summary?.total ?? Object.keys(accounts).length;
  const eligible = pool.summary?.eligible ?? 0;
  if (total > 0 && eligible === 0) {
    const staleAges = degradedAccounts.map((d) => d.ageHours).filter((h) => typeof h === "number");
    const ageNote = staleAges.length > 0 ? ` (~${Math.max(...staleAges)}h old, limit 24h)` : "";
    const reasonSet = Array.from(new Set(degradedAccounts.map((d) => d.reason)));
    routingWarnings.push(
      `Account pool has 0/${total} eligible accounts${ageNote} (${reasonSet.join(", ")}). Refresh account_pool.json or live usage windows; paid cloud routes disabled cleanly.`,
    );
  } else if (degradedAccounts.length > 0) {
    const sample = degradedAccounts.slice(0, 4).map((d) => `${d.accountId}(${d.reason})`).join(", ");
    routingWarnings.push(
      `${degradedAccounts.length}/${total} account(s) degraded/excluded: ${sample}${degradedAccounts.length > 4 ? ", ..." : ""}`,
    );
  }

  return { degradedAccounts, routingWarnings };
}
