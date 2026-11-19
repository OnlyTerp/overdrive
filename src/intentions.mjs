import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultArpdDir, defaultDriftPath, defaultLedgerPath, defaultMemoryPath } from "./paths.mjs";
import { SCHEMA_VERSION, validateIntentionDigest } from "./ui-contracts.mjs";

export const DEFAULT_LEDGER_PATH = defaultLedgerPath();
export const DEFAULT_MEMORY_PATH = defaultMemoryPath();
export const DEFAULT_DRIFT_PATH = defaultDriftPath();
export const DEFAULT_ARPD_DIR = defaultArpdDir();

const FORBIDDEN_RAW_KEYS = new Set([
  "rawPrompt",
  "rawTranscript",
  "rawMessages",
  "rawSqlRow",
  "cookies",
  "tokens",
  "env",
]);

const FREE_MODEL_RE = /\b(?:swe-2(?:-flash)?|dots|astra-free|muse[-_ ]?ai|free)\b/i;
const PAID_MODEL_RE = /\b(?:opus|sonnet|fable|gpt-6|astra|sol|terra|carbon|hydrogen|grok|qwen|mimo|swe-2-lightning)\b/i;
const CLOUD_HARNESS_RE = /\b(?:cloud|devin|codex-cloud|claude-cloud|spawn|remote|aipc|arpd|muse|grok|factory|dsh)\b/i;

/**
 * Strip emails, OS user home usernames, API tokens, private keys, and raw prompt excerpts
 * so local intention mining strictly obeys `privacyMode: "strict_local"`.
 */
export function redactPrivateSignals(text) {
  if (text === null || text === undefined) return "";
  let out = String(text);

  // 1. Private keys (multi-line PEM blocks or header-only fragments)
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
    "[REDACTED_PRIVATE_KEY]",
  );

  // 2. Prompt block wrappers and explicit raw prompt excerpts
  out = out.replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/gi, "[REDACTED_PROMPT]");
  out = out.replace(
    /\b(?:raw_?prompt|user_?prompt|system_?prompt|prompt_?excerpt)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]{1,500})/gi,
    "[REDACTED_PROMPT]",
  );

  // 3. Credentials / bearer tokens / provider API keys / env assignments
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  out = out.replace(
    /\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    "[REDACTED_TOKEN]",
  );
  out = out.replace(
    /\b([A-Za-z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|OAUTH_TOKEN|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)\s*[:=]\s*)['"]?[^\s'"`,;]{4,}['"]?/gi,
    "$1[REDACTED_TOKEN]",
  );

  // 4. Email addresses
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");

  // 5. Windows & POSIX home directory usernames (including URL-encoded backslash variants)
  out = out.replace(/(?:[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/|\/Users\/|\/home\/)[^\\/\s"'`]+/gi, "[HOME]");
  out = out.replace(/(?:[A-Za-z]%3A%5CUsers%5C|%2FUsers%2F|%2Fhome%2F)[^%\s"'`]+/gi, "[HOME]");

  return out;
}

function sanitizeStrictValue(val) {
  if (typeof val === "string") return redactPrivateSignals(val);
  if (Array.isArray(val)) return val.map((item) => sanitizeStrictValue(item));
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_RAW_KEYS.has(k)) continue;
      out[k] = sanitizeStrictValue(v);
    }
    return out;
  }
  return val;
}

function round1(n) {
  return Math.round(Number(n || 0) * 10) / 10;
}

function round4(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

function openReadOnlyDb(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return { db: null, status: "missing", error: null };
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    return { db, status: "ok", error: null };
  } catch (err) {
    try {
      db?.close();
    } catch {}
    return {
      db: null,
      status: "error",
      error: redactPrivateSignals(err?.message || "Failed to open SQLite database read-only"),
    };
  }
}

function tableColumns(db, tableName) {
  try {
    const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all();
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function safeGet(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function normalizeProjectName(project, cwd, harness) {
  const rawProj = String(project || "").trim();
  if (rawProj && rawProj !== "." && rawProj !== "~") {
    const clean = redactPrivateSignals(rawProj).replace(/^\[HOME\][\\/]?/i, "");
    if (clean) return clean;
  }
  const rawCwd = String(cwd || "").trim();
  if (rawCwd) {
    const norm = rawCwd.replaceAll("\\", "/").replace(/\/+$/, "");
    const parts = norm.split("/").filter(Boolean);
    const tail = parts[parts.length - 1] || "";
    if (tail && !/^[A-Za-z]:$/.test(tail) && !/^(users|home)$/i.test(tail)) {
      return redactPrivateSignals(tail);
    }
  }
  return redactPrivateSignals(String(harness || "workspace").trim() || "workspace");
}

function parseDateMs(raw) {
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function parseModelsList(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || "").trim()).filter(Boolean);
    } catch {}
  }
  return s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isFreeCall(model, costUsd, harness = "") {
  const m = String(model || "").trim();
  const h = String(harness || "").trim();
  if (FREE_MODEL_RE.test(m) || /\bdevin\b/i.test(h)) {
    return !/\b(?:swe-2-lightning)\b/i.test(m);
  }
  if (costUsd !== null && costUsd !== undefined && Number.isFinite(Number(costUsd)) && Number(costUsd) === 0) {
    if (m && !PAID_MODEL_RE.test(m)) return true;
    if (!m && h && !/antigravity|claude|codex|grok/i.test(h)) return true;
  }
  return false;
}

function mineLedger(ledgerPath, nowMs, driftAlerts) {
  const result = {
    available: false,
    totalSessions: 0,
    latestSessionAt: null,
    ledgerStaleHours: null,
    cloudOffloadPct: 0,
    freePoolPct: 0,
    activeFocus: [],
    wentQuietQuestions: [],
    frictionHotspots: [],
    unparseableSources: 0,
  };

  if (!ledgerPath) return result;
  const opened = openReadOnlyDb(ledgerPath);
  if (!opened.db) {
    if (opened.status === "error") {
      driftAlerts.push({
        source: "ledger.sqlite",
        severity: "error",
        message: redactPrivateSignals(`Ledger SQLite unreadable/locked: ${opened.error}`),
      });
    } else {
      driftAlerts.push({
        source: "ledger.sqlite",
        severity: "info",
        message: "Ledger SQLite not found at configured path; intention digest running with empty session baseline.",
      });
    }
    return result;
  }

  const db = opened.db;
  try {
    result.available = true;
    const sessCols = tableColumns(db, "sessions");
    if (sessCols.size > 0) {
      const countRow = safeGet(db, "SELECT COUNT(*) AS n FROM sessions");
      result.totalSessions = Number(countRow?.n || 0);
      const tsExpr =
        sessCols.has("ended_at") && sessCols.has("started_at")
          ? "COALESCE(ended_at, started_at)"
          : sessCols.has("ended_at")
            ? "ended_at"
            : sessCols.has("started_at")
              ? "started_at"
              : null;
      if (result.totalSessions > 0 && tsExpr) {
        const latestRow = safeGet(db, `SELECT MAX(${tsExpr}) AS latest FROM sessions`);
        const latestMs = parseDateMs(latestRow?.latest);
        if (latestMs !== null) {
          result.latestSessionAt = new Date(latestMs).toISOString();
          result.ledgerStaleHours = Math.max(0, Math.round(((nowMs - latestMs) / 3_600_000) * 10) / 10);
          if (nowMs - latestMs > 48 * 3_600_000 && Array.isArray(driftAlerts)) {
            driftAlerts.push({
              source: "ledger.sqlite",
              severity: "warn",
              message: redactPrivateSignals(
                `Session ledger is ${Math.round(result.ledgerStaleHours / 24)}d (${result.ledgerStaleHours}h) stale (newest session ${result.latestSessionAt}); activeFocus and wentQuietQuestions may be stale.`,
              ),
            });
          }
        }
      }

      const sel = [
        sessCols.has("uid") ? "uid" : "rowid AS uid",
        sessCols.has("harness") ? "harness" : "'' AS harness",
        sessCols.has("project") ? "project" : "'' AS project",
        sessCols.has("cwd") ? "cwd" : "'' AS cwd",
        sessCols.has("started_at") ? "started_at" : "NULL AS started_at",
        sessCols.has("ended_at") ? "ended_at" : "NULL AS ended_at",
        sessCols.has("models") ? "models" : "'' AS models",
        sessCols.has("tokens_in") ? "tokens_in" : "0 AS tokens_in",
        sessCols.has("tokens_out") ? "tokens_out" : "0 AS tokens_out",
        sessCols.has("cost_usd") ? "cost_usd" : "NULL AS cost_usd",
        sessCols.has("is_subagent") ? "is_subagent" : "0 AS is_subagent",
      ].join(", ");

      const orderCol = sessCols.has("started_at") ? "started_at DESC" : "rowid DESC";
      const rows = safeAll(db, `SELECT ${sel} FROM sessions ORDER BY ${orderCol} LIMIT 8000`);

      const marksCols = tableColumns(db, "marks");
      const offloadedSessions = new Set();
      if (marksCols.has("session_uid") && marksCols.has("kind")) {
        for (const mr of safeAll(
          db,
          "SELECT DISTINCT session_uid FROM marks WHERE kind IN ('subagent_spawn', 'cloud_offload', 'aipc_offload', 'remote_offload')",
        )) {
          if (mr.session_uid) offloadedSessions.add(String(mr.session_uid));
        }
      }

      const thirtyDaysAgoMs = nowMs - 30 * 86_400_000;
      const recentWindow = rows.filter((r) => {
        const ts = parseDateMs(r.ended_at || r.started_at);
        return ts !== null && ts >= thirtyDaysAgoMs;
      });
      const sampleRows = recentWindow.length > 0 ? recentWindow : rows.slice(0, 500);

      let offloadHits = 0;
      let freeSessHits = 0;
      const byProject = new Map();

      for (const r of sampleRows) {
        const uid = String(r.uid || "");
        const harness = String(r.harness || "");
        const modelsStr = String(r.models || "");
        const isOffloaded =
          Number(r.is_subagent) === 1 ||
          offloadedSessions.has(uid) ||
          CLOUD_HARNESS_RE.test(harness) ||
          /\b(?:swe-2|cloud|remote|aipc)\b/i.test(modelsStr);
        if (isOffloaded) offloadHits++;

        const modelsArr = parseModelsList(modelsStr);
        const sessFree =
          modelsArr.some((m) => isFreeCall(m, r.cost_usd, harness)) ||
          (modelsArr.length === 0 && isFreeCall("", r.cost_usd, harness));
        if (sessFree) freeSessHits++;
      }

      for (const r of rows) {
        const tsMs = parseDateMs(r.ended_at || r.started_at);
        if (tsMs === null) continue;
        const proj = normalizeProjectName(r.project, r.cwd, r.harness);
        let agg = byProject.get(proj);
        if (!agg) {
          agg = {
            project: proj,
            sessions: 0,
            tokens: 0,
            costUsd: 0,
            harnesses: new Set(),
            models: new Set(),
            lastActiveMs: tsMs,
            lastActiveAt: new Date(tsMs).toISOString(),
          };
          byProject.set(proj, agg);
        }
        agg.sessions += 1;
        agg.tokens += Math.max(0, Number(r.tokens_in || 0)) + Math.max(0, Number(r.tokens_out || 0));
        if (Number.isFinite(Number(r.cost_usd))) agg.costUsd += Number(r.cost_usd);
        if (r.harness) agg.harnesses.add(redactPrivateSignals(String(r.harness)));
        for (const m of parseModelsList(r.models)) {
          agg.models.add(redactPrivateSignals(m));
        }
        if (tsMs > agg.lastActiveMs) {
          agg.lastActiveMs = tsMs;
          agg.lastActiveAt = new Date(tsMs).toISOString();
        }
      }

      if (sampleRows.length > 0) {
        result.cloudOffloadPct = Math.min(100, Math.max(0, round1((offloadHits / sampleRows.length) * 100)));
      }

      // Prefer llm_calls for freePoolPct when present, falling back to session-level model/cost heuristics.
      const llmCols = tableColumns(db, "llm_calls");
      let llmComputed = false;
      if (llmCols.size > 0 && llmCols.has("model")) {
        const recentUids = new Set(sampleRows.map((r) => String(r.uid || "")).filter(Boolean));
        const costCol = llmCols.has("cost_usd") ? "cost_usd" : "NULL AS cost_usd";
        const suidCol = llmCols.has("session_uid") ? "session_uid" : "'' AS session_uid";
        const calls = safeAll(db, `SELECT ${suidCol}, model, ${costCol} FROM llm_calls ORDER BY rowid DESC LIMIT 4000`);
        const scopedCalls = recentUids.size > 0
          ? calls.filter((c) => recentUids.has(String(c.session_uid || "")))
          : calls;
        const targetCalls = scopedCalls.length > 0 ? scopedCalls : calls;
        if (targetCalls.length > 0) {
          let freeCount = 0;
          for (const c of targetCalls) {
            if (isFreeCall(c.model, c.cost_usd)) freeCount++;
          }
          result.freePoolPct = Math.min(100, Math.max(0, round1((freeCount / targetCalls.length) * 100)));
          llmComputed = true;
        }
      }
      if (!llmComputed && sampleRows.length > 0) {
        result.freePoolPct = Math.min(100, Math.max(0, round1((freeSessHits / sampleRows.length) * 100)));
      }

      const activeFocus = [];
      const wentQuietQuestions = [];
      for (const agg of byProject.values()) {
        const quietHours = Math.max(0, (nowMs - agg.lastActiveMs) / 3_600_000);
        const roundedQuiet = round1(quietHours);
        if (roundedQuiet < 72) {
          const momentum = round1(agg.sessions * 10 + Math.log10(1 + agg.tokens) * 5 - quietHours * 0.08);
          activeFocus.push({
            project: agg.project,
            sessions: agg.sessions,
            totalTokens: agg.tokens,
            costUsd: round4(agg.costUsd),
            harnesses: Array.from(agg.harnesses).slice(0, 6),
            models: Array.from(agg.models).slice(0, 6),
            lastActiveAt: agg.lastActiveAt,
            quietHours: roundedQuiet,
            momentum,
            signal: "active",
          });
        } else if (roundedQuiet >= 72 && quietHours <= 14 * 24) {
          const roundedHours = Math.max(72, Math.round(quietHours));
          wentQuietQuestions.push({
            kind: "owner_question",
            autoDispatch: false,
            project: agg.project,
            quietHours: roundedHours,
            lastActiveAt: agg.lastActiveAt,
            recentSessions: agg.sessions,
            question: redactPrivateSignals(
              `Project "${agg.project}" had ${agg.sessions} session(s) recently and has been quiet for ~${roundedHours}h. Keep paused, archive, or resume with a targeted mission?`,
            ),
          });
        }
      }

      activeFocus.sort((a, b) => b.momentum - a.momentum || b.totalTokens - a.totalTokens || b.sessions - a.sessions);
      wentQuietQuestions.sort((a, b) => b.recentSessions - a.recentSessions || a.quietHours - b.quietHours);
      result.activeFocus = activeFocus.slice(0, 15);
      result.wentQuietQuestions = wentQuietQuestions.slice(0, 10);
    }

    // Recent-window friction hotspots (last 30d) tagged by harness + project so stale/unrelated history cannot skew Overdrive
    const hotspots = [];
    const cutoffIso = new Date(nowMs - 30 * 86_400_000).toISOString();
    const sessJoin = sessCols.has("uid");
    const harnessSel = sessCols.has("harness") ? "COALESCE(s.harness, '')" : "''";
    const projSel = sessCols.has("project") ? "COALESCE(s.project, '')" : "''";
    const toolCols = tableColumns(db, "tool_calls");
    if (toolCols.has("tool") && toolCols.has("status")) {
      const canFilterTs = toolCols.has("ts_start") || (sessJoin && toolCols.has("session_uid"));
      const joinClause = sessJoin && toolCols.has("session_uid") ? "LEFT JOIN sessions s ON t.session_uid = s.uid" : "";
      const tsExpr = toolCols.has("ts_start")
        ? (sessJoin && toolCols.has("session_uid") ? "COALESCE(t.ts_start, s.ended_at, s.started_at)" : "t.ts_start")
        : "COALESCE(s.ended_at, s.started_at)";
      const whereErr = canFilterTs
        ? `t.status != 'ok' AND (${tsExpr} IS NULL OR ${tsExpr} >= ?)`
        : "t.status != 'ok'";
      const errParams = canFilterTs ? [cutoffIso] : [];
      const groupBy = sessJoin && toolCols.has("session_uid") ? `t.tool, ${harnessSel}, ${projSel}` : "t.tool";
      const hCol = sessJoin && toolCols.has("session_uid") ? `${harnessSel} AS harness, ${projSel} AS project` : "'' AS harness, '' AS project";
      if (canFilterTs || !result.latestSessionAt || Date.parse(result.latestSessionAt) >= nowMs - 30 * 86_400_000) {
        for (const r of safeAll(
          db,
          `SELECT t.tool AS tool, ${hCol}, COUNT(*) AS n FROM tool_calls t ${joinClause} WHERE ${whereErr} GROUP BY ${groupBy} ORDER BY n DESC LIMIT 5`,
          errParams,
        )) {
          const harness = redactPrivateSignals(String(r.harness || "").trim());
          const project = r.project ? normalizeProjectName(r.project, "", r.harness) : "";
          hotspots.push({
            kind: "tool_error",
            label: redactPrivateSignals(String(r.tool || "unknown_tool")),
            ...(harness ? { harness } : {}),
            ...(project ? { project } : {}),
            count: Number(r.n || 0),
            detail: redactPrivateSignals(`${harness ? `[${harness}] ` : ""}${r.tool} failed ${r.n} time(s)`),
          });
        }
      }
    }
    if (toolCols.has("tool") && toolCols.has("duplicate_of")) {
      const canFilterTs = toolCols.has("ts_start") || (sessJoin && toolCols.has("session_uid"));
      const joinClause = sessJoin && toolCols.has("session_uid") ? "LEFT JOIN sessions s ON t.session_uid = s.uid" : "";
      const tsExpr = toolCols.has("ts_start")
        ? (sessJoin && toolCols.has("session_uid") ? "COALESCE(t.ts_start, s.ended_at, s.started_at)" : "t.ts_start")
        : "COALESCE(s.ended_at, s.started_at)";
      const whereDup = canFilterTs
        ? `t.duplicate_of IS NOT NULL AND (${tsExpr} IS NULL OR ${tsExpr} >= ?)`
        : "t.duplicate_of IS NOT NULL";
      const dupParams = canFilterTs ? [cutoffIso] : [];
      const groupBy = sessJoin && toolCols.has("session_uid") ? `t.tool, ${harnessSel}, ${projSel}` : "t.tool";
      const hCol = sessJoin && toolCols.has("session_uid") ? `${harnessSel} AS harness, ${projSel} AS project` : "'' AS harness, '' AS project";
      if (canFilterTs || !result.latestSessionAt || Date.parse(result.latestSessionAt) >= nowMs - 30 * 86_400_000) {
        for (const r of safeAll(
          db,
          `SELECT t.tool AS tool, ${hCol}, COUNT(*) AS n FROM tool_calls t ${joinClause} WHERE ${whereDup} GROUP BY ${groupBy} ORDER BY n DESC LIMIT 4`,
          dupParams,
        )) {
          const harness = redactPrivateSignals(String(r.harness || "").trim());
          const project = r.project ? normalizeProjectName(r.project, "", r.harness) : "";
          hotspots.push({
            kind: "duplicate_tool",
            label: redactPrivateSignals(String(r.tool || "unknown_tool")),
            ...(harness ? { harness } : {}),
            ...(project ? { project } : {}),
            count: Number(r.n || 0),
            detail: redactPrivateSignals(`${harness ? `[${harness}] ` : ""}${r.tool} repeated ${r.n} duplicate call(s)`),
          });
        }
      }
    }
    const llmCols = tableColumns(db, "llm_calls");
    if (llmCols.has("status") || llmCols.has("retries")) {
      const errExpr = llmCols.has("error_type") ? "COALESCE(NULLIF(l.error_type,''), l.status, 'error')" : "COALESCE(l.status, 'error')";
      const retriesExpr = llmCols.has("retries") ? "SUM(COALESCE(l.retries, 0))" : "0";
      const whereParts = [];
      if (llmCols.has("status")) whereParts.push("l.status != 'ok'");
      if (llmCols.has("retries")) whereParts.push("l.retries > 0");
      const canFilterTs = llmCols.has("ts_start") || (sessJoin && llmCols.has("session_uid"));
      const joinClause = sessJoin && llmCols.has("session_uid") ? "LEFT JOIN sessions s ON l.session_uid = s.uid" : "";
      const tsExpr = llmCols.has("ts_start")
        ? (sessJoin && llmCols.has("session_uid") ? "COALESCE(l.ts_start, s.ended_at, s.started_at)" : "l.ts_start")
        : "COALESCE(s.ended_at, s.started_at)";
      const fullWhere = canFilterTs
        ? `(${whereParts.join(" OR ")}) AND (${tsExpr} IS NULL OR ${tsExpr} >= ?)`
        : whereParts.join(" OR ");
      const params = canFilterTs ? [cutoffIso] : [];
      const hCol = sessJoin && llmCols.has("session_uid") ? `${harnessSel} AS harness, ${projSel} AS project` : "'' AS harness, '' AS project";
      const groupBy = sessJoin && llmCols.has("session_uid") ? `err, ${harnessSel}, ${projSel}` : "err";
      if (canFilterTs || !result.latestSessionAt || Date.parse(result.latestSessionAt) >= nowMs - 30 * 86_400_000) {
        for (const r of safeAll(
          db,
          `SELECT ${errExpr} AS err, ${hCol}, COUNT(*) AS n, ${retriesExpr} AS retry_sum FROM llm_calls l ${joinClause} WHERE ${fullWhere} GROUP BY ${groupBy} ORDER BY n DESC LIMIT 5`,
          params,
        )) {
          const harness = redactPrivateSignals(String(r.harness || "").trim());
          const project = r.project ? normalizeProjectName(r.project, "", r.harness) : "";
          hotspots.push({
            kind: Number(r.retry_sum || 0) > 0 && String(r.err) === "ok" ? "llm_retry" : "llm_error",
            label: redactPrivateSignals(String(r.err || "llm_error")),
            ...(harness ? { harness } : {}),
            ...(project ? { project } : {}),
            count: Number(r.n || 0),
            retries: Number(r.retry_sum || 0),
            detail: redactPrivateSignals(`${harness ? `[${harness}] ` : ""}LLM ${r.err}: ${r.n} call(s), ${r.retry_sum || 0} retry(s)`),
          });
        }
      }
    }
    const marksCols = tableColumns(db, "marks");
    if (marksCols.has("kind")) {
      const canFilterTs = marksCols.has("ts") || (sessJoin && marksCols.has("session_uid"));
      const joinClause = sessJoin && marksCols.has("session_uid") ? "LEFT JOIN sessions s ON m.session_uid = s.uid" : "";
      const tsExpr = marksCols.has("ts")
        ? (sessJoin && marksCols.has("session_uid") ? "COALESCE(m.ts, s.ended_at, s.started_at)" : "m.ts")
        : "COALESCE(s.ended_at, s.started_at)";
      const whereClause = canFilterTs
        ? `m.kind IN ('compaction', 'turn_aborted', 'llm_retry') AND (${tsExpr} IS NULL OR ${tsExpr} >= ?)`
        : "m.kind IN ('compaction', 'turn_aborted', 'llm_retry')";
      const params = canFilterTs ? [cutoffIso] : [];
      const hCol = sessJoin && marksCols.has("session_uid") ? `${harnessSel} AS harness` : "'' AS harness";
      const groupBy = sessJoin && marksCols.has("session_uid") ? `m.kind, ${harnessSel}` : "m.kind";
      if (canFilterTs || !result.latestSessionAt || Date.parse(result.latestSessionAt) >= nowMs - 30 * 86_400_000) {
        for (const r of safeAll(
          db,
          `SELECT m.kind AS kind, ${hCol}, COUNT(*) AS n FROM marks m ${joinClause} WHERE ${whereClause} GROUP BY ${groupBy} ORDER BY n DESC LIMIT 5`,
          params,
        )) {
          const harness = redactPrivateSignals(String(r.harness || "").trim());
          hotspots.push({
            kind: redactPrivateSignals(String(r.kind)),
            label: redactPrivateSignals(String(r.kind)),
            ...(harness ? { harness } : {}),
            count: Number(r.n || 0),
            detail: redactPrivateSignals(`${harness ? `[${harness}] ` : ""}Mark "${r.kind}" occurred ${r.n} time(s)`),
          });
        }
      }
    }

    hotspots.sort((a, b) => b.count - a.count);
    result.frictionHotspots = hotspots.slice(0, 10);

    // Sources coverage / drift signals from ledger.sources
    const srcCols = tableColumns(db, "sources");
    if (srcCols.has("name")) {
      const parseCol = srcCols.has("parseable") ? "parseable" : "1 AS parseable";
      const noteCol = srcCols.has("note") ? "note" : "'' AS note";
      const lastCol = srcCols.has("last_ts") ? "last_ts" : "NULL AS last_ts";
      for (const s of safeAll(db, `SELECT name, ${parseCol}, ${noteCol}, ${lastCol} FROM sources`)) {
        if (Number(s.parseable) === 0) {
          result.unparseableSources += 1;
          driftAlerts.push({
            source: redactPrivateSignals(String(s.name)),
            severity: "info",
            message: redactPrivateSignals(`Source "${s.name}" lacks local transcript parser (${s.note || "unparsed"})`),
          });
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {}
  }
  return result;
}

function mineMemoryDb(memoryPath, driftAlerts) {
  const summary = { available: false, memoriesCount: 0, factsCount: 0, eventsCount: 0 };
  if (!memoryPath) return summary;
  const opened = openReadOnlyDb(memoryPath);
  if (!opened.db) {
    if (opened.status === "error") {
      driftAlerts.push({
        source: "unified_memory.db",
        severity: "warn",
        message: redactPrivateSignals(`unified_memory.db unreadable/locked: ${opened.error}`),
      });
    }
    return summary;
  }
  const db = opened.db;
  try {
    summary.available = true;
    const memCols = tableColumns(db, "memories");
    if (memCols.size > 0) summary.memoriesCount = Number(safeGet(db, "SELECT COUNT(*) AS n FROM memories")?.n || 0);
    const factCols = tableColumns(db, "memory_facts");
    if (factCols.size > 0) {
      summary.factsCount = Number(safeGet(db, "SELECT COUNT(*) AS n FROM memory_facts WHERE deleted=0")?.n || 0);
    }
    const evCols = tableColumns(db, "memory_events");
    if (evCols.size > 0) {
      summary.eventsCount = Number(safeGet(db, "SELECT COUNT(*) AS n FROM memory_events WHERE deleted=0")?.n || 0);
    }
  } finally {
    try {
      db.close();
    } catch {}
  }
  return summary;
}

function mineDriftJson(driftPath, nowMs, driftAlerts) {
  const summary = { available: false, ok: true, checkCount: 0, generatedAt: null };
  if (!driftPath || !existsSync(driftPath)) return summary;
  try {
    const parsed = JSON.parse(readFileSync(driftPath, "utf8"));
    summary.available = true;
    summary.ok = parsed?.ok !== false;
    summary.generatedAt = parsed?.generated_at ? redactPrivateSignals(String(parsed.generated_at)) : null;
    const checks = Array.isArray(parsed?.checks) ? parsed.checks : [];
    summary.checkCount = checks.length;
    for (const chk of checks) {
      if (chk && chk.ok === false) {
        driftAlerts.push({
          source: redactPrivateSignals(String(chk.check || "drift")),
          severity: "warn",
          message: redactPrivateSignals(String(chk.detail || `Drift check ${chk.check || "unknown"} failed`)),
        });
      }
    }
    const genMs = parseDateMs(parsed?.generated_at);
    if (genMs !== null) {
      const ageDays = (nowMs - genMs) / 86_400_000;
      if (ageDays > 14) {
        driftAlerts.push({
          source: "drift.json",
          severity: "info",
          message: `Drift snapshot is ${Math.round(ageDays)}d old; run local RSI ledger rescan if fresh harness coverage is needed.`,
        });
      }
    }
  } catch (err) {
    driftAlerts.push({
      source: "drift.json",
      severity: "warn",
      message: redactPrivateSignals(`Failed to parse drift.json: ${err?.message || "invalid JSON"}`),
    });
  }
  return summary;
}

function mineArpdDir(arpdDir) {
  const summary = { available: false, runCount: 0, recentProjects: [] };
  if (!arpdDir || !existsSync(arpdDir)) return summary;
  const hasScript = existsSync(path.join(arpdDir, "arpd.py"));
  const runsPath = path.join(arpdDir, "mirror", "runs.json");
  summary.available = hasScript || existsSync(runsPath);
  if (!existsSync(runsPath)) return summary;
  try {
    const parsed = JSON.parse(readFileSync(runsPath, "utf8"));
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : Array.isArray(parsed) ? parsed : [];
    summary.runCount = runs.length;
    const seen = new Set();
    for (const r of runs) {
      if (r?.project) {
        const clean = redactPrivateSignals(String(r.project).trim());
        if (clean && !seen.has(clean)) seen.add(clean);
      }
      if (seen.size >= 8) break;
    }
    summary.recentProjects = Array.from(seen);
  } catch {}
  return summary;
}

/**
 * Local-only, read-only intention and friction miner across ledger.sqlite,
 * unified_memory.db, drift.json, and autoresearch-daemon mirrors.
 */
export function mineIntentionDigest({
  ledgerPath = defaultLedgerPath(),
  memoryPath = defaultMemoryPath(),
  driftPath = defaultDriftPath(),
  arpdDir = defaultArpdDir(),
  now = new Date(),
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const driftAlerts = [];

  const ledger = mineLedger(ledgerPath, nowMs, driftAlerts);
  const memory = mineMemoryDb(memoryPath, driftAlerts);
  const drift = mineDriftJson(driftPath, nowMs, driftAlerts);
  const arpd = mineArpdDir(arpdDir);

  const digest = sanitizeStrictValue({
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    privacyMode: "strict_local",
    totalSessions: ledger.totalSessions,
    cloudOffloadPct: ledger.cloudOffloadPct,
    freePoolPct: ledger.freePoolPct,
    activeFocus: ledger.activeFocus,
    wentQuietQuestions: ledger.wentQuietQuestions,
    frictionHotspots: ledger.frictionHotspots,
    driftAlerts: driftAlerts.slice(0, 12),
    sourcesSummary: {
      ledgerAvailable: ledger.available,
      latestSessionAt: ledger.latestSessionAt,
      ledgerStaleHours: ledger.ledgerStaleHours,
      memoryAvailable: memory.available,
      memoryFactsCount: memory.factsCount,
      driftAvailable: drift.available,
      arpdAvailable: arpd.available,
      arpdRunCount: arpd.runCount,
      unparseableSources: ledger.unparseableSources,
    },
  });

  const check = validateIntentionDigest(digest);
  if (!check.ok) {
    throw new Error(`Strict-local intention digest failed validation: ${check.errors.join("; ")}`);
  }
  return digest;
}
