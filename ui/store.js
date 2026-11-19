import {
  EVENT_CAPS,
  REPLAYABLE,
  REPLAY_VERSION,
  ROUTES,
  createUiStore,
  validateDemoSeedResponse,
  validateEventsResponse,
  validateReplayEnvelope,
} from "./contracts.js";

export { createUiStore };

const TOKEN_STORAGE_KEY = "overdrive_token";
const THEME_STORAGE_KEY = "overdrive_theme";
const MAX_TOASTS = 4;

const STATE_LABELS = Object.freeze({
  draft: "Ready",
  idle: "Ready",
  thinking: "Deep thinking",
  planned: "Plan ready",
  frozen: "Rules locked",
  swarming: "Building in parallel",
  verifying: "Checking work",
  completed: "Complete",
  escalated: "Needs attention",
  failed: "Needs attention",
});

const MODEL_LABELS = Object.freeze({
  "gemini-4-carbon": "Gemini 4 Carbon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-4-argon": "Gemini 4 Argon",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "fable-2": "Fable 2",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-terra": "GPT-6.1 Terra",
  "swe-2-flash": "Devin SWE-2 Flash",
  "swe-2": "Devin SWE-2",
  "swe-2-lightning": "Devin SWE-2 Lightning",
  "glm-5.3": "GLM 5.3",
  "glm-5-3": "GLM 5.3",
  "mimo-v2.6-pro": "MiMo v2.6 Pro",
  "mimo-v2-6-pro": "MiMo v2.6 Pro",
  "qwen-4-max": "Qwen 4 Max",
  "grok": "Grok",
  "muse": "Muse",
  "muse-ai": "Muse AI",
});

export function humanMissionState(state) {
  return STATE_LABELS[String(state || "").toLowerCase()] || String(state || "Ready");
}

export function humanModelName(spec = {}) {
  if (!spec || typeof spec !== "object") return "Unassigned";
  const rawModel = String(spec.model || "").trim();
  const base = MODEL_LABELS[rawModel.toLowerCase()] || rawModel || String(spec.harness || "Auto");
  const effort = spec.effort && spec.effort !== "default" ? `${spec.effort[0].toUpperCase()}${spec.effort.slice(1)}` : "";
  const isFree = String(spec.costTier || "").includes("free");
  const parts = [base];
  if (effort) parts.push(effort);
  if (isFree) parts.push("Free");
  return parts.join(" · ");
}

export function humanLaneStatus(lane) {
  if (!lane) return "Waiting";
  if (lane.status === "failed" || lane.scopeOk === false || lane.lastVerify?.ok === false) return "Needs attention";
  if (lane.status === "verified") return "Finished · checks passed";
  if (lane.status === "scope_ok") return "In bounds · awaiting checks";
  if (lane.status === "active") return "Building in parallel";
  return "Waiting to start";
}

export function humanEventSummary(ev) {
  const type = String(ev?.type || "");
  const p = ev?.payload || {};
  switch (type) {
    case "mission_created":
      return "Build created";
    case "mission_settings_updated":
      return "Build settings updated";
    case "topology_planned":
      return "Team & file split planned";
    case "contracts_frozen":
      return "Shared rules locked";
    case "lane_provisioned":
      return "Workspace prepared";
    case "lane_verified":
      if (p.status === "verified") return "Teammate checks passed";
      if (p.status === "scope_ok") return "File boundaries checked";
      return "Teammate check failed";
    case "gate_finished":
      return p.status === "passed" ? "Release check passed" : "Release check failed";
    case "state_thinking":
      return "Deep thinking started";
    case "state_planned":
      return "Build plan ready";
    case "state_frozen":
      return "Shared rules locked";
    case "state_swarming":
      return "Team building in parallel";
    case "state_verifying":
      return "Running final checks";
    case "state_completed":
      return "Build complete";
    case "state_escalated":
      return "Prepared failure note";
    case "worktrees_cleaned":
      return "Temporary copies cleaned up";
    case "cloud_dispatched":
      return p.provider ? `Sent to ${p.provider}` : "Sent to cloud worker";
    case "cloud_ingested":
      return p.laneId ? `Cloud patch imported (${p.laneId})` : "Cloud patch imported";
    case "ratchet_evaluated":
      return p.ok === false ? "Metric check regressed" : "Metric check passed";
    case "integration_started":
      return "Trial merge started";
    case "integration_verified":
      return "Trial merge & checks passed";
    case "integration_failed":
      return "Trial merge failed";
    case "rsi_scanned":
      return "Sessions scanned for improvements";
    case "rsi_evaluated":
      return "Self-upgrade tested in sandbox";
    case "rsi_promoted":
      return "Self-upgrade applied";
    case "rsi_rolled_back":
      return "Self-upgrade undone";
    default:
      return type.replaceAll("_", " ") || "Update";
  }
}

/** Extract launch token from URL fragment `#t=...`, persist to sessionStorage, and scrub URL. */
export function readHashToken({ locationObj = globalThis.location, historyObj = globalThis.history, storage = safeSessionStorage(), doc = globalThis.document } = {}) {
  try {
    const hash = String(locationObj?.hash || "");
    const m = hash.match(/[#&?]t=([^&]+)/);
    if (m) {
      const tok = decodeURIComponent(m[1]);
      storage?.setItem?.(TOKEN_STORAGE_KEY, tok);
      if (historyObj?.replaceState && locationObj) {
        historyObj.replaceState(null, "", `${locationObj.pathname || "/"}${locationObj.search || ""}`);
      }
      return tok;
    }
    const stored = storage?.getItem?.(TOKEN_STORAGE_KEY);
    if (stored) return stored;
    const meta = doc?.querySelector?.('[name="overdrive-token"]');
    const metaTok = meta?.getAttribute?.("content")?.trim?.();
    if (metaTok) return metaTok;
  } catch {
    // Ignore storage/location access issues in sandboxed tests.
  }
  return "";
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function detectInitialTheme({ local = safeLocalStorage(), win = globalThis.window } = {}) {
  try {
    const saved = local?.getItem?.(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    if (win?.matchMedia?.("(prefers-color-scheme: light)")?.matches) return "light";
  } catch {}
  return "dark";
}

export function normalizeEvent(raw, fallbackMissionId = null) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Number(raw.seq);
  if (!Number.isFinite(seq)) return null;
  const type = String(raw.type || raw.kind || "unknown");
  const createdAt = raw.createdAt || raw.ts || new Date().toISOString();
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const replay = raw.replay ?? null;
  const receiptId = raw.receiptId || replay?.receiptId || payload.receiptId || null;
  return {
    ...raw,
    seq,
    missionId: raw.missionId || fallbackMissionId || null,
    role: String(raw.role || "coordinator"),
    type,
    createdAt,
    ts: createdAt,
    payload,
    replay,
    receiptId,
  };
}

export function mergeEvents(existing = [], incoming = [], missionId = null) {
  const bySeq = new Map();
  for (const item of existing) {
    const norm = normalizeEvent(item, missionId);
    if (norm) bySeq.set(norm.seq, norm);
  }
  for (const item of incoming) {
    const norm = normalizeEvent(item, missionId);
    if (norm) bySeq.set(norm.seq, norm);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function applyLegacyProjection(ctx, ev, liveMission) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "mission_created":
      if (p.title) ctx.mission.title = p.title;
      if (p.routingMode) ctx.mission.routingMode = p.routingMode;
      if (p.activeHarness) ctx.mission.activeHarness = p.activeHarness;
      if (p.adhdSessionId !== undefined) ctx.mission.adhdSessionId = p.adhdSessionId;
      ctx.mission.state = p.adhdSessionId ? "thinking" : "draft";
      break;
    case "mission_settings_updated":
      if (p.routingMode) ctx.mission.routingMode = p.routingMode;
      if (p.activeHarness) ctx.mission.activeHarness = p.activeHarness;
      if (p.adhdSessionId !== undefined) ctx.mission.adhdSessionId = p.adhdSessionId;
      break;
    case "topology_planned":
      ctx.mission.state = "planned";
      ctx.mission.freezeCommit = null;
      if (p.routingMode) ctx.mission.routingMode = p.routingMode;
      if (Array.isArray(p.contracts)) {
        ctx.contracts.clear();
        for (const c of p.contracts) ctx.contracts.set(c.path, { ...c, sha256: null });
      } else if (liveMission?.contracts?.length && ctx.contracts.size === 0) {
        for (const c of liveMission.contracts) ctx.contracts.set(c.path, { ...c, sha256: null, frozen_at: null });
      }
      if (Array.isArray(p.lanes)) {
        ctx.lanes.clear();
        for (const l of p.lanes) ctx.lanes.set(l.id, { ...l, status: "pending", worktreePath: null, lastVerify: null });
      } else if (liveMission?.lanes?.length && ctx.lanes.size === 0) {
        for (const l of liveMission.lanes) {
          ctx.lanes.set(l.id, { ...l, status: "pending", scopeOk: null, worktreePath: null, lastVerify: null, receiptId: null });
        }
      }
      if (Array.isArray(p.gates)) {
        ctx.gates.clear();
        for (const g of p.gates) ctx.gates.set(g.id, { ...g, status: "pending", lastRun: null });
      } else if (liveMission?.gates?.length && ctx.gates.size === 0) {
        for (const g of liveMission.gates) ctx.gates.set(g.id, { ...g, status: "pending", lastRun: null });
      }
      break;
    case "contracts_frozen":
      ctx.mission.state = "frozen";
      if (p.freezeCommit) ctx.mission.freezeCommit = p.freezeCommit;
      for (const c of p.contracts || []) {
        const cur = ctx.contracts.get(c.path) || { path: c.path, description: "" };
        ctx.contracts.set(c.path, { ...cur, sha256: c.sha256, frozenAt: ev.createdAt });
      }
      break;
    case "lane_provisioned":
      if (p.laneId) {
        const cur = ctx.lanes.get(p.laneId) || { id: p.laneId, ownedGlobs: [], worker: {}, verifier: {} };
        ctx.lanes.set(p.laneId, {
          ...cur,
          worktreePath: p.worktreePath ?? cur.worktreePath,
          branchName: p.branchName ?? cur.branchName,
          status: p.status || "active",
        });
      }
      break;
    case "lane_verified":
      if (p.laneId) {
        const cur = ctx.lanes.get(p.laneId) || { id: p.laneId, ownedGlobs: [], worker: {}, verifier: {} };
        ctx.lanes.set(p.laneId, {
          ...cur,
          status: p.status || cur.status,
          scopeOk: p.scopeOk !== undefined ? Boolean(p.scopeOk) : cur.scopeOk,
          receiptId: ev.receiptId || p.receiptId || cur.receiptId || null,
          lastVerify: p.result || {
            ok: p.status === "verified" || p.status === "scope_ok",
            scopeOk: p.scopeOk,
            exitCode: p.exitCode,
            violation: p.violation || null,
          },
        });
      }
      break;
    case "gate_finished":
      if (p.gateId) {
        const cur = ctx.gates.get(p.gateId) || { id: p.gateId };
        ctx.gates.set(p.gateId, {
          ...cur,
          status: p.status || cur.status,
          lastRun: { exitCode: p.exitCode, machine: p.machine, ok: p.status === "passed" },
        });
      }
      break;
    case "worktrees_cleaned":
      for (const [id, l] of ctx.lanes.entries()) {
        ctx.lanes.set(id, { ...l, worktreePath: null });
      }
      break;
    default:
      if (ev.type.startsWith("state_")) {
        ctx.mission.state = ev.type.slice("state_".length);
      }
      break;
  }
}

/** Pure causal projection of a mission at `cursorSeq` (`null` returns `liveMission`). */
export function projectMissionAtSeq(liveMission, events = [], cursorSeq = null) {
  if (!liveMission || cursorSeq === null || cursorSeq === undefined) return liveMission;
  const targetSeq = Number(cursorSeq);
  if (!Number.isFinite(targetSeq)) return liveMission;

  const sorted = mergeEvents([], events, liveMission.id).filter((e) => e.seq <= targetSeq);
  if (sorted.length === 0) return liveMission;

  let startIdx = 0;
  const ctx = {
    mission: {
      ...liveMission,
      state: "draft",
      freezeCommit: null,
    },
    contracts: new Map(),
    lanes: new Map(),
    gates: new Map(),
  };

  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i].replay;
    if (r && r.version === REPLAY_VERSION && r.checkpoint && validateReplayEnvelope(r).ok) {
      const cp = r.checkpoint;
      if (cp.mission) ctx.mission = { ...ctx.mission, ...cp.mission };
      if (cp.contracts && typeof cp.contracts === "object") {
        for (const [k, v] of Object.entries(cp.contracts)) ctx.contracts.set(k, { ...v });
      }
      if (cp.lanes && typeof cp.lanes === "object") {
        for (const [k, v] of Object.entries(cp.lanes)) ctx.lanes.set(k, { ...v });
      }
      if (cp.gates && typeof cp.gates === "object") {
        for (const [k, v] of Object.entries(cp.gates)) ctx.gates.set(k, { ...v });
      }
      startIdx = i;
      break;
    }
  }

  for (let i = startIdx; i < sorted.length; i++) {
    const ev = sorted[i];
    const r = ev.replay;
    if (r && r.version === REPLAY_VERSION && validateReplayEnvelope(r).ok) {
      for (const ch of r.changes || []) {
        if (!ch || typeof ch !== "object") continue;
        const map =
          ch.entity === "contract" ? ctx.contracts :
          ch.entity === "lane" ? ctx.lanes :
          ch.entity === "gate" ? ctx.gates : null;
        if (ch.entity === "mission") {
          if (ch.op === "put" && ch.value) ctx.mission = { ...ctx.mission, ...ch.value };
          continue;
        }
        if (!map) continue;
        const key = ch.id || ch.value?.id || ch.value?.path;
        if (!key) continue;
        if (ch.op === "delete") {
          map.delete(key);
        } else if (ch.op === "put" && ch.value) {
          const prev = map.get(key) || {};
          const next = { ...prev, ...ch.value };
          if (ch.entity === "lane" && (r.receiptId || ev.receiptId) && REPLAYABLE[ev.type]?.receiptBound) {
            next.receiptId = r.receiptId || ev.receiptId;
          }
          map.set(key, next);
        }
      }
    } else {
      applyLegacyProjection(ctx, ev, liveMission);
    }
  }

  return {
    ...ctx.mission,
    contracts: [...ctx.contracts.values()],
    lanes: [...ctx.lanes.values()],
    gates: [...ctx.gates.values()],
    events: sorted,
    replayCursorSeq: targetSeq,
  };
}

function resolveReceiptIdForLane(mission, laneId) {
  const lane = (mission?.lanes || []).find((l) => l.id === laneId);
  return lane?.receiptId || lane?.lastReceiptId || lane?.lastVerify?.receiptId || null;
}

export function createStudioStore(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const EventSourceImpl = options.EventSourceImpl || globalThis.EventSource;
  const sessionStore = options.storage !== undefined ? options.storage : safeSessionStorage();
  const localStore = options.localStorage !== undefined ? options.localStorage : safeLocalStorage();
  const locationObj = options.locationObj !== undefined ? options.locationObj : globalThis.location;
  const historyObj = options.historyObj !== undefined ? options.historyObj : globalThis.history;
  const doc = options.doc !== undefined ? options.doc : globalThis.document;
  const win = options.win !== undefined ? options.win : globalThis.window;

  const initialToken =
    options.token !== undefined
      ? String(options.token)
      : readHashToken({ locationObj, historyObj, storage: sessionStore, doc });

  const initialTheme = options.theme || detectInitialTheme({ local: localStore, win });
  if (doc?.documentElement?.dataset) {
    doc.documentElement.dataset.theme = initialTheme;
  }

  const baseStore = createUiStore({
    activeView: "map",
    workspaceSubTab: "graph",
    token: initialToken,
    tokenRequired: !initialToken,
    theme: initialTheme,
    missions: [],
    activeMission: null,
    liveMission: null,
    fleet: null,
    routingWarnings: [],
    degradedAccounts: [],
    harnessesMeta: [],
    manualConfig: null,
    adhd: { available: false, sessions: [] },
    adhdDetail: null,
    adhdDetailSessionId: null,
    events: [],
    lastSeq: 0,
    timelineFilterLane: "all",
    timelineFilterKind: "all",
    timelineSearch: "",
    followTail: true,
    sseStatus: initialToken ? "connecting" : "idle",
    railOpen: true,
    inspectorOpen: true,
    timelineOpen: true,
    paletteOpen: false,
    shortcutsOpen: false,
    composerOpen: false,
    composerMode: "overlay",
    composerPreset: null,
    armedAction: null,
    diffData: null,
    inspectionData: null,
    diffLoading: false,
    diffError: null,
    rsi: { loading: false, error: null, overview: null },
    busy: false,
    lastError: null,
    ...(options.initial || {}),
  });

  let sseSource = null;
  let sseRefreshTimer = null;
  let sseRefreshDeferred = false;
  let destroyed = false;
  let refreshGen = 0;
  let refreshInFlight = 0;
  let detailGen = 0;
  const toastTimers = new Map();
  let toastSeq = 0;

  function toast(message, tone = "info", { durationMs = 4200 } = {}) {
    const id = `toast-${++toastSeq}`;
    const entry = { id, message: String(message || ""), tone, createdAt: Date.now() };
    baseStore.dispatch((s) => ({
      toasts: [...s.toasts, entry].slice(-MAX_TOASTS),
    }));
    if (durationMs > 0) {
      const timer = setTimeout(() => dismissToast(id), durationMs);
      toastTimers.set(id, timer);
    }
    return id;
  }

  function dismissToast(id) {
    const timer = toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    baseStore.dispatch((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
    }));
  }

  async function request(method, url, body = undefined, { silent = false } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch API unavailable");
    const { token } = baseStore.getState();
    const headers = {};
    if (token) headers["X-Overdrive-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 403 && String(data?.error || "").toLowerCase().includes("token")) {
        baseStore.dispatch({ tokenRequired: true, sseStatus: "offline" });
      }
      const errMsg = data?.error || `HTTP ${res.status}`;
      if (!silent) baseStore.dispatch({ lastError: errMsg });
      throw new Error(errMsg);
    }
    return data;
  }

  const api = {
    get: (url) => request("GET", url),
    post: (url, body = {}) => request("POST", url, body),
    getToken: () => baseStore.getState().token,
    getState: (missionId) => request("GET", ROUTES.state(missionId)),
    getMissionEvents: (missionId, opts = {}) => request("GET", ROUTES.missionEvents(missionId, opts), undefined, { silent: true }),
    getLaneDiff: async (missionId, laneId, opts = {}) => {
      const receiptId = opts?.receiptId || null;
      const cacheKey = `${missionId}:${laneId}:${receiptId || "live"}`;
      if (receiptId && baseStore.getState().receiptCache?.[cacheKey]) {
        return baseStore.getState().receiptCache[cacheKey];
      }
      const res = await request("GET", ROUTES.laneDiff(missionId, laneId, opts), undefined, { silent: true });
      if (receiptId && !destroyed) {
        baseStore.dispatch((s) => ({
          receiptCache: { ...s.receiptCache, [cacheKey]: res },
        }));
      }
      return res;
    },
    getLaneInspection: (missionId, laneId, opts = {}) => request("GET", ROUTES.laneInspection(missionId, laneId, opts), undefined, { silent: true }),
    getAdhdSession: (id) => request("GET", ROUTES.adhd(id)),
    planPodTournament: (body = {}) => request("POST", ROUTES.adhdPodPlan(), body),
    getAssistants: (q = {}) => request("GET", ROUTES.assistants(q), undefined, { silent: true }),
    createMission: (body) => request("POST", ROUTES.missions(), body),
    seedDemo: (body = {}) => request("POST", ROUTES.demoSeed(), body),
    previewInstall: (body = {}) => request("POST", ROUTES.installPreview(), body),
    validateTopology: (missionId, body) => request("POST", ROUTES.missionAction(missionId, "validate"), body),
    planMission: (missionId, body) => request("POST", ROUTES.missionAction(missionId, "plan"), body),
    updateSettings: (missionId, body) => request("POST", ROUTES.missionAction(missionId, "settings"), body),
    freezeMission: (missionId, body = { provisionWorktrees: true }) => request("POST", ROUTES.missionAction(missionId, "freeze"), body),
    verifyLane: (missionId, laneId, opts = {}) => request("POST", ROUTES.missionAction(missionId, "verify-lane"), { laneId, ...opts }),
    runGate: (missionId, gateId, opts = {}) => request("POST", ROUTES.missionAction(missionId, "run-gate"), { gateId, ...opts }),
    escalate: (missionId, body = {}) => request("POST", ROUTES.missionAction(missionId, "escalate"), body),
    cleanupMission: (missionId) => request("POST", ROUTES.missionAction(missionId, "cleanup"), {}),
    integrateMission: (missionId, body = {}) => request("POST", ROUTES.missionIntegrate(missionId), body),
    getRsiOverview: () => request("GET", ROUTES.rsiOverview(), undefined, { silent: true }),
    scanRsi: (body = {}) => request("POST", ROUTES.rsiScan(), body),
    runRsiCycle: (candidateId = null, body = {}) =>
      request("POST", ROUTES.rsiCycle(), { ...(candidateId ? { candidateId } : {}), ...body }),
    submitRsiAudit: (id, body = {}) => request("POST", ROUTES.rsiAudit(id), body),
    promoteRsi: (id, body = {}) => request("POST", ROUTES.rsiPromote(id), { ...body, humanApproved: true }),
    rollbackRsi: (id, body = {}) => request("POST", ROUTES.rsiRollback(id), body),
    missionAction: (missionId, action, body = {}) => request("POST", ROUTES.missionAction(missionId, action), body),
  };

  function pickSelectedLane(mission, currentLaneId) {
    const lanes = mission?.lanes || [];
    if (!lanes.length) return null;
    if (currentLaneId && lanes.some((l) => l.id === currentLaneId)) return currentLaneId;
    const failed = lanes.find((l) => l.status === "failed" || l.scopeOk === false);
    return (failed || lanes[0]).id;
  }

  function syncActiveProjection(liveMission, events, cursorSeq) {
    return projectMissionAtSeq(liveMission, events, cursorSeq);
  }

  async function loadSelectedLaneDetails(missionId, laneId, receiptId = null, { historicalNoReceipt = false } = {}) {
    const myDetailGen = ++detailGen;
    if (destroyed) return null;
    if (historicalNoReceipt) {
      baseStore.dispatch({
        diffData: { schemaVersion: 1, missionId, laneId, source: "historical-empty", files: [], contracts: [] },
        inspectionData: null,
        diffLoading: false,
        diffError: null,
      });
      return null;
    }
    if (!missionId || !laneId || !baseStore.getState().token) {
      baseStore.dispatch({
        diffData: null,
        inspectionData: null,
        diffLoading: false,
        diffError: null,
      });
      return null;
    }
    const stateSnap = baseStore.getState();
    if (
      stateSnap.activeMission &&
      (stateSnap.activeMission.id !== missionId ||
        (Array.isArray(stateSnap.activeMission.lanes) &&
          !stateSnap.activeMission.lanes.some((l) => l.id === laneId)))
    ) {
      return null;
    }

    baseStore.dispatch({ diffData: null, inspectionData: null, diffLoading: true, diffError: null });
    try {
      const [diffRes, inspRes] = await Promise.allSettled([
        api.getLaneDiff(missionId, laneId, { receiptId }),
        api.getLaneInspection(missionId, laneId, { receiptId }),
      ]);
      if (destroyed || myDetailGen !== detailGen) return null;
      const cur = baseStore.getState();
      if (cur.missionId !== missionId || cur.selectedLaneId !== laneId) {
        return null;
      }

      const diffData = diffRes.status === "fulfilled" ? diffRes.value : null;
      const inspectionData = inspRes.status === "fulfilled" ? inspRes.value : null;
      const diffError = diffRes.status === "rejected" ? String(diffRes.reason?.message || diffRes.reason || "Failed to load diff") : null;

      baseStore.dispatch({
        diffData,
        inspectionData,
        diffLoading: false,
        diffError,
      });
      return { diffData, inspectionData, diffError };
    } catch (e) {
      if (!destroyed && myDetailGen === detailGen) {
        const cur = baseStore.getState();
        if (cur.missionId === missionId && cur.selectedLaneId === laneId) {
          baseStore.dispatch({
            diffData: null,
            inspectionData: null,
            diffLoading: false,
            diffError: String(e?.message || e),
          });
        }
      }
      return null;
    }
  }

  async function fetchMissionEvents(missionId, { after = 0, through = null, limit = EVENT_CAPS.maxLimit } = {}) {
    if (!missionId) return [];
    const collected = [];
    let cursorAfter = after;
    const maxPages = 5;
    try {
      for (let page = 0; page < maxPages; page++) {
        const res = await api.getMissionEvents(missionId, { after: cursorAfter, through, limit });
        const check = validateEventsResponse(res);
        if (!check.ok) break;
        collected.push(...res.events);
        const nextAfter = Number(res.nextAfterSeq);
        if (!res.hasMore || !Number.isFinite(nextAfter) || nextAfter <= cursorAfter) break;
        cursorAfter = nextAfter;
      }
      return collected;
    } catch {
      return collected;
    }
  }

  async function refreshState(targetMissionId) {
    const myGen = ++refreshGen;
    const cur = baseStore.getState();
    if (!cur.token) {
      baseStore.dispatch({ tokenRequired: true });
      return null;
    }
    const missionId = targetMissionId !== undefined ? targetMissionId : cur.missionId;
    const switchedMission = Boolean(missionId && cur.missionId && missionId !== cur.missionId);
    refreshInFlight += 1;
    baseStore.dispatch({
      busy: true,
      lastError: null,
      ...(switchedMission ? { armedAction: null, diffData: null, inspectionData: null, diffError: null } : {}),
    });
    try {
      const data = await api.getState(missionId || undefined);
      if (destroyed || myGen !== refreshGen) return null;
      const liveMission = data.activeMission || null;
      const nextMissionId = liveMission?.id || null;
      const prevEvents = cur.missionId === nextMissionId ? cur.events : [];
      const missionEvents = liveMission?.events || [];

      let mergedEvents = mergeEvents(prevEvents, missionEvents, nextMissionId);
      if (nextMissionId) {
        const maxKnownSeq = mergedEvents.length ? mergedEvents[mergedEvents.length - 1].seq : 0;
        const needBackfill =
          prevEvents.length === 0 ||
          cur.missionId !== nextMissionId ||
          (liveMission?.eventCount && mergedEvents.length < liveMission.eventCount);
        const deltaEvents = await fetchMissionEvents(nextMissionId, {
          after: needBackfill ? 0 : maxKnownSeq,
        });
        if (destroyed || myGen !== refreshGen) return null;
        if (deltaEvents.length) {
          mergedEvents = mergeEvents(mergedEvents, deltaEvents, nextMissionId);
        }
      } else {
        mergedEvents = [];
      }

      if (destroyed || myGen !== refreshGen) return null;
      const curAfterAwait = baseStore.getState();
      const lastSeq = mergedEvents.length ? mergedEvents[mergedEvents.length - 1].seq : 0;
      const cursorSeq = curAfterAwait.missionId === nextMissionId ? curAfterAwait.cursorSeq : null;
      const activeMission = syncActiveProjection(liveMission, mergedEvents, cursorSeq);
      const selectedLaneId = pickSelectedLane(activeMission, curAfterAwait.selectedLaneId);
      const missionChanged = Boolean(nextMissionId && curAfterAwait.missionId && nextMissionId !== curAfterAwait.missionId);

      baseStore.dispatch({
        tokenRequired: false,
        busy: false,
        missionId: nextMissionId,
        missions: data.missions || [],
        liveMission,
        activeMission,
        events: mergedEvents,
        lastSeq,
        cursorSeq,
        selectedLaneId,
        selectedNodeId: curAfterAwait.selectedNodeId || selectedLaneId,
        fleet: data.fleet || null,
        routingWarnings: Array.isArray(data.routingWarnings)
          ? data.routingWarnings
          : Array.isArray(data.fleet?.routingWarnings)
            ? data.fleet.routingWarnings
            : [],
        degradedAccounts: Array.isArray(data.degradedAccounts)
          ? data.degradedAccounts
          : Array.isArray(data.fleet?.degradedAccounts)
            ? data.fleet.degradedAccounts
            : [],
        harnessesMeta: data.harnessesMeta || [],
        manualConfig: data.manualConfig || null,
        adhd: data.adhd || { available: false, sessions: [] },
        ...(missionChanged ? { armedAction: null } : {}),
      });

      if (nextMissionId && selectedLaneId) {
        const receiptId = resolveReceiptIdForLane(activeMission, selectedLaneId);
        const historicalNoReceipt = cursorSeq !== null && cursorSeq !== undefined && !receiptId;
        void loadSelectedLaneDetails(nextMissionId, selectedLaneId, receiptId, { historicalNoReceipt });
      } else {
        ++detailGen;
        baseStore.dispatch({ diffData: null, inspectionData: null, diffLoading: false, diffError: null });
      }
      return data;
    } catch (e) {
      if (!destroyed && myGen === refreshGen) baseStore.dispatch({ busy: false, lastError: e.message });
      return null;
    } finally {
      refreshInFlight = Math.max(0, refreshInFlight - 1);
      if (refreshInFlight === 0 && sseRefreshDeferred && !destroyed) {
        sseRefreshDeferred = false;
        if (!sseRefreshTimer) {
          sseRefreshTimer = setTimeout(() => {
            sseRefreshTimer = null;
            if (!destroyed) void refreshState(baseStore.getState().missionId || undefined);
          }, 25);
        }
      }
    }
  }

  function handleSsePayload(raw) {
    if (!raw || typeof raw !== "object" || destroyed) return;
    if (raw.type === "connected") {
      baseStore.dispatch({ sseStatus: "live" });
      return;
    }
    const cur = baseStore.getState();
    const norm = normalizeEvent(raw, cur.missionId);
    if (norm) {
      if (norm.replay && !validateReplayEnvelope(norm.replay).ok) return;
      if (norm.missionId && cur.missionId && norm.missionId === cur.missionId) {
        const alreadySeen = cur.events.some((e) => e.seq === norm.seq);
        if (alreadySeen) return;
        const nextEvents = mergeEvents(cur.events, [norm], cur.missionId);
        const lastSeq = nextEvents.length ? nextEvents[nextEvents.length - 1].seq : cur.lastSeq;
        const nextCursor = cur.followTail ? null : cur.cursorSeq;
        const activeMission = syncActiveProjection(cur.liveMission, nextEvents, nextCursor);
        baseStore.dispatch({
          events: nextEvents,
          lastSeq,
          cursorSeq: nextCursor,
          activeMission,
        });
      }
    }
    if (sseRefreshTimer) clearTimeout(sseRefreshTimer);
    sseRefreshTimer = setTimeout(() => {
      sseRefreshTimer = null;
      if (destroyed) return;
      if (refreshInFlight > 0) {
        sseRefreshDeferred = true;
        return;
      }
      void refreshState(baseStore.getState().missionId || undefined);
    }, 60);
  }

  function connectSse() {
    disconnectSse();
    const { token } = baseStore.getState();
    if (!token || typeof EventSourceImpl !== "function") return;
    baseStore.dispatch({ sseStatus: "connecting" });
    const es = new EventSourceImpl(ROUTES.stream(token));
    sseSource = es;
    es.onopen = () => baseStore.dispatch({ sseStatus: "live" });
    es.onerror = () => baseStore.dispatch({ sseStatus: "reconnecting" });
    es.onmessage = (msg) => {
      try {
        const parsed = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
        handleSsePayload(parsed);
      } catch {}
    };
  }

  function disconnectSse() {
    if (sseRefreshTimer) {
      clearTimeout(sseRefreshTimer);
      sseRefreshTimer = null;
    }
    sseRefreshDeferred = false;
    if (sseSource) {
      try {
        sseSource.close?.();
      } catch {}
      sseSource = null;
    }
  }

  function setToken(nextToken) {
    const tok = String(nextToken || "").trim();
    try {
      if (tok) sessionStore?.setItem?.(TOKEN_STORAGE_KEY, tok);
      else sessionStore?.removeItem?.(TOKEN_STORAGE_KEY);
    } catch {}
    baseStore.dispatch({ token: tok, tokenRequired: !tok });
    if (tok) {
      connectSse();
      return refreshState();
    }
    disconnectSse();
    return Promise.resolve(null);
  }

  function setTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    try {
      localStore?.setItem?.(THEME_STORAGE_KEY, next);
    } catch {}
    if (doc?.documentElement?.dataset) doc.documentElement.dataset.theme = next;
    baseStore.dispatch({ theme: next });
    return next;
  }

  function toggleTheme() {
    const cur = baseStore.getState().theme;
    return setTheme(cur === "light" ? "dark" : "light");
  }

  function setView(view) {
    const valid = ["map", "composer", "contracts", "adhd", "rsi"].includes(view) ? view : "map";
    baseStore.dispatch((s) => ({
      activeView: valid,
      composerOpen: valid !== "composer" && s.composerMode === "view" ? false : s.composerOpen,
    }));
  }

  function setWorkspaceSubTab(tab) {
    const valid = ["graph", "timeline", "files"].includes(tab) ? tab : "graph";
    baseStore.dispatch((s) => {
      const patch = {
        workspaceSubTab: valid,
        activeView: "map",
        composerOpen: s.composerMode === "view" ? false : s.composerOpen,
      };
      if (valid === "timeline") patch.timelineOpen = true;
      if (valid === "files") {
        patch.inspectorOpen = true;
        patch.inspectorTab = "diff";
      }
      return patch;
    });
  }

  function selectLane(laneId, { openInspector = true } = {}) {
    const prev = baseStore.getState();
    baseStore.dispatch((s) => ({
      selectedLaneId: laneId,
      selectedNodeId: laneId,
      inspectorOpen: openInspector ? true : s.inspectorOpen,
    }));
    const cur = baseStore.getState();
    if (cur.missionId && laneId && (prev.selectedLaneId !== laneId || !cur.diffData)) {
      const receiptId = resolveReceiptIdForLane(cur.activeMission, laneId);
      const historicalNoReceipt = cur.cursorSeq !== null && cur.cursorSeq !== undefined && !receiptId;
      void loadSelectedLaneDetails(cur.missionId, laneId, receiptId, { historicalNoReceipt });
    }
  }

  function stepLane(delta) {
    const cur = baseStore.getState();
    const lanes = cur.activeMission?.lanes || [];
    if (!lanes.length) return null;
    const idx = lanes.findIndex((l) => l.id === cur.selectedLaneId);
    const nextIdx = idx < 0 ? 0 : (idx + delta + lanes.length) % lanes.length;
    const nextId = lanes[nextIdx].id;
    selectLane(nextId, { openInspector: false });
    return nextId;
  }

  function setCursorSeq(seq) {
    const cur = baseStore.getState();
    const nextSeq = seq === null || seq === undefined ? null : Number(seq);
    const activeMission = syncActiveProjection(cur.liveMission, cur.events, nextSeq);
    const selectedLaneId = pickSelectedLane(activeMission, cur.selectedLaneId);
    baseStore.dispatch({
      cursorSeq: nextSeq,
      followTail: nextSeq === null,
      activeMission,
      selectedLaneId,
    });
    if (cur.missionId && selectedLaneId) {
      const receiptId = resolveReceiptIdForLane(activeMission, selectedLaneId);
      const historicalNoReceipt = nextSeq !== null && nextSeq !== undefined && !receiptId;
      void loadSelectedLaneDetails(cur.missionId, selectedLaneId, receiptId, { historicalNoReceipt });
    } else {
      ++detailGen;
      baseStore.dispatch({ diffData: null, inspectionData: null, diffLoading: false, diffError: null });
    }
  }

  function stepTimeline(delta) {
    const cur = baseStore.getState();
    const evs = cur.events || [];
    if (!evs.length) return;
    if (cur.cursorSeq === null) {
      if (delta < 0) setCursorSeq(evs[Math.max(0, evs.length - 2)].seq);
      return;
    }
    const idx = evs.findIndex((e) => e.seq === cur.cursorSeq);
    const nextIdx = idx < 0 ? evs.length - 1 : idx + delta;
    if (nextIdx >= evs.length) {
      setCursorSeq(null);
    } else if (nextIdx <= 0) {
      setCursorSeq(evs[0].seq);
    } else {
      setCursorSeq(evs[nextIdx].seq);
    }
  }

  function jumpTimelineLive() {
    setCursorSeq(null);
  }

  function setInspectorTab(tab) {
    const valid = ["diff", "brief", "audit"].includes(tab) ? tab : "diff";
    baseStore.dispatch({ inspectorTab: valid });
  }

  function toggleInspectorWide(force) {
    baseStore.dispatch((s) => ({
      inspectorWide: force === undefined ? !s.inspectorWide : Boolean(force),
    }));
  }

  function toggleRail(force) {
    baseStore.dispatch((s) => ({
      railOpen: force === undefined ? !s.railOpen : Boolean(force),
    }));
  }

  function toggleInspector(force) {
    baseStore.dispatch((s) => ({
      inspectorOpen: force === undefined ? !s.inspectorOpen : Boolean(force),
    }));
  }

  function toggleTimeline(force) {
    baseStore.dispatch((s) => ({
      timelineOpen: force === undefined ? !s.timelineOpen : Boolean(force),
    }));
  }

  function toggleFocusFailure(force) {
    baseStore.dispatch((s) => ({
      focusFailureOnly: force === undefined ? !s.focusFailureOnly : Boolean(force),
    }));
  }

  function togglePalette(force) {
    baseStore.dispatch((s) => ({
      paletteOpen: force === undefined ? !s.paletteOpen : Boolean(force),
      shortcutsOpen: false,
    }));
  }

  function toggleShortcuts(force) {
    baseStore.dispatch((s) => ({
      shortcutsOpen: force === undefined ? !s.shortcutsOpen : Boolean(force),
      paletteOpen: false,
    }));
  }

  function openComposer(preset = null, mode = "overlay") {
    baseStore.dispatch({
      composerOpen: true,
      composerMode: mode,
      composerPreset: preset,
      paletteOpen: false,
      shortcutsOpen: false,
    });
  }

  function closeComposer() {
    baseStore.dispatch((s) => ({
      composerOpen: false,
      composerPreset: null,
      activeView: s.activeView === "composer" && s.composerMode === "view" ? "map" : s.activeView,
    }));
  }

  function armAction(actionSpec) {
    baseStore.dispatch({ armedAction: actionSpec });
  }

  function cancelArmedAction() {
    baseStore.dispatch({ armedAction: null });
  }

  async function confirmArmedAction() {
    const cur = baseStore.getState();
    const armed = cur.armedAction;
    if (!armed) return null;
    baseStore.dispatch({ armedAction: null });
    if (typeof armed.execute === "function") {
      return armed.execute();
    }
    return null;
  }

  async function seedShowcase() {
    try {
      const res = await api.seedDemo({});
      const check = validateDemoSeedResponse(res);
      if (!check.ok && !res?.missionId) {
        throw new Error(check.error || "Invalid sample build response");
      }
      if (sseRefreshTimer) {
        clearTimeout(sseRefreshTimer);
        sseRefreshTimer = null;
      }
      sseRefreshDeferred = false;
      baseStore.dispatch({
        missionId: res.missionId,
        cursorSeq: null,
        selectedLaneId: null,
        selectedNodeId: null,
        followTail: true,
      });
      await refreshState(res.missionId);
      toast("Sample build ready to explore", "ok");
      return res;
    } catch (e) {
      toast(`Sample build unavailable: ${e.message}`, "bad");
      return null;
    }
  }

  function mergeRsiResult(prev, { digest, candidates, candidate, benchmark } = {}) {
    const base =
      prev && typeof prev === "object"
        ? { ...prev }
        : { schemaVersion: 1, ok: true, digest: null, benchmark: null, candidates: [] };
    if (digest !== undefined) base.digest = digest;
    if (benchmark !== undefined) base.benchmark = benchmark;
    if (Array.isArray(candidates)) {
      base.candidates = candidates;
    } else if (candidate && candidate.id) {
      const existing = Array.isArray(base.candidates) ? [...base.candidates] : [];
      const idx = existing.findIndex((c) => c.id === candidate.id);
      if (idx >= 0) existing[idx] = candidate;
      else existing.unshift(candidate);
      base.candidates = existing;
    }
    return base;
  }

  async function loadRsiOverview({ quiet = true } = {}) {
    if (!baseStore.getState().token) return null;
    baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: true, error: null } }));
    try {
      const data = await api.getRsiOverview();
      if (destroyed) return null;
      const looksLikeOverview =
        data &&
        typeof data === "object" &&
        (data.digest !== undefined || Array.isArray(data.candidates) || data.benchmark !== undefined);
      if (!looksLikeOverview) {
        baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: false, error: null } }));
        return null;
      }
      baseStore.dispatch({ rsi: { loading: false, error: null, overview: data } });
      return data;
    } catch (e) {
      if (destroyed) return null;
      const msg = String(e?.message || e || "");
      const isMissing = /404|not found/i.test(msg);
      baseStore.dispatch((s) => ({
        rsi: {
          ...s.rsi,
          loading: false,
          error: quiet && isMissing ? null : msg,
        },
      }));
      return null;
    }
  }

  async function scanRsi() {
    baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: true, error: null } }));
    try {
      const res = await api.scanRsi({});
      if (destroyed) return null;
      baseStore.dispatch((s) => ({
        rsi: {
          loading: false,
          error: null,
          overview: mergeRsiResult(s.rsi?.overview, res),
        },
      }));
      toast("Sessions scanned for improvements", "ok");
      return res;
    } catch (e) {
      if (!destroyed) {
        const msg = String(e?.message || e);
        baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: false, error: msg } }));
        toast(msg, "bad");
      }
      return null;
    }
  }

  async function runRsiCycle(candidateId = null) {
    baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: true, error: null } }));
    try {
      const res = await api.runRsiCycle(candidateId);
      if (destroyed) return null;
      baseStore.dispatch((s) => ({
        rsi: {
          loading: false,
          error: null,
          overview: mergeRsiResult(s.rsi?.overview, res),
        },
      }));
      if (res?.candidate) {
        const regs = res.candidate.regressions ?? 0;
        toast(
          regs > 0 ? `Sandbox test finished with ${regs} regression(s)` : "Sandbox upgrade test passed",
          regs > 0 ? "warn" : "ok",
        );
      } else {
        toast("Golden quality checks finished", res?.benchmark?.ok === false ? "warn" : "ok");
      }
      return res;
    } catch (e) {
      if (!destroyed) {
        const msg = String(e?.message || e);
        if (!candidateId && /candidate|404|400/i.test(msg)) {
          const refreshed = await loadRsiOverview({ quiet: false });
          if (refreshed?.benchmark) {
            toast("Golden quality checks refreshed", "ok");
            return refreshed;
          }
        }
        baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: false, error: msg } }));
        toast(msg, "bad");
      }
      return null;
    }
  }

  async function promoteRsi(id) {
    baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: true, error: null } }));
    try {
      const res = await api.promoteRsi(id, { humanApproved: true });
      if (destroyed) return null;
      baseStore.dispatch((s) => ({
        rsi: {
          loading: false,
          error: null,
          overview: mergeRsiResult(s.rsi?.overview, res),
        },
      }));
      toast("Upgrade applied", "ok");
      return res;
    } catch (e) {
      if (!destroyed) {
        const msg = String(e?.message || e);
        baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: false, error: msg } }));
        toast(msg, "bad");
      }
      return null;
    }
  }

  async function rollbackRsi(id) {
    baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: true, error: null } }));
    try {
      const res = await api.rollbackRsi(id);
      if (destroyed) return null;
      baseStore.dispatch((s) => ({
        rsi: {
          loading: false,
          error: null,
          overview: mergeRsiResult(s.rsi?.overview, res),
        },
      }));
      toast("Upgrade undone", "info");
      return res;
    } catch (e) {
      if (!destroyed) {
        const msg = String(e?.message || e);
        baseStore.dispatch((s) => ({ rsi: { ...s.rsi, loading: false, error: msg } }));
        toast(msg, "bad");
      }
      return null;
    }
  }

  async function integrateMission(id) {
    const targetId = id || baseStore.getState().activeMission?.id;
    if (!targetId) return null;
    try {
      const res = await api.integrateMission(targetId, {});
      if (destroyed) return null;
      await refreshState(targetId);
      const ok = res?.integration?.ok ?? res?.ok ?? true;
      toast(ok ? "Trial merge & checks passed" : "Trial merge failed checks", ok ? "ok" : "bad");
      return res;
    } catch (e) {
      if (!destroyed) toast(e.message, "bad");
      return null;
    }
  }

  function destroy() {
    destroyed = true;
    disconnectSse();
    for (const timer of toastTimers.values()) clearTimeout(timer);
    toastTimers.clear();
  }

  return {
    ...baseStore,
    api,
    toast,
    dismissToast,
    refreshState,
    loadSelectedLaneDetails,
    connectSse,
    disconnectSse,
    handleSsePayload,
    setToken,
    setTheme,
    toggleTheme,
    setView,
    setWorkspaceSubTab,
    selectLane,
    stepLane,
    setCursorSeq,
    stepTimeline,
    jumpTimelineLive,
    setInspectorTab,
    toggleInspectorWide,
    toggleRail,
    toggleInspector,
    toggleTimeline,
    toggleFocusFailure,
    togglePalette,
    toggleShortcuts,
    openComposer,
    closeComposer,
    armAction,
    cancelArmedAction,
    confirmArmedAction,
    seedShowcase,
    loadRsiOverview,
    scanRsi,
    runRsiCycle,
    promoteRsi,
    rollbackRsi,
    integrateMission,
    destroy,
  };
}
