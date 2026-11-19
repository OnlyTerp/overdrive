// Canonical frozen contracts shared between backend (src/*) and frontend (ui/*).
import { OFFLOAD_MODES } from "../src/partition.mjs";

export {
  OFFLOAD_MODES,
  normalizeRelPattern,
  globOverlaps,
  fileMatchesGlob,
  fileMatchesAnyGlob,
  validateTopology,
} from "../src/partition.mjs";

export const SCHEMA_VERSION = 1;
export const TARGET_VERSION = "0.3.0";
export const COMPATIBLE_TARGET_VERSIONS = Object.freeze(["0.2.0", "0.3.0"]);
export const REPLAY_VERSION = 1;
export const SHOWCASE_SLUG = "showcase-v02";
export const SHOWCASE_FIXTURE_VERSION = "overdrive-showcase-v0.2.0";

export const DISPATCH_MODES = Object.freeze([
  "native-swarm",
  "native-subagent",
  "connect-anything-ask",
  "connect-anything-spawn",
  "claude-cloud",
  "codex-cloud",
  "devin-cloud",
  "assistant-relay",
]);

export const CLOUD_PROVIDERS = Object.freeze([
  "claude-cloud",
  "codex-cloud",
  "devin-cloud",
  "copilot-cloud",
  "devin-vm",
]);

export const ASSISTANT_IDS = Object.freeze([
  "muse_ai",
  "dot",
  "dot2",
  "grokbot",
  "duet",
  "devin",
]);

export const MODEL_FAMILIES = Object.freeze([
  "google",
  "openai",
  "anthropic",
  "devin",
  "zai",
  "qwen",
  "mimo",
  "muse",
  "grok",
  "local",
  "unknown",
]);

export const RSI_TIERS = Object.freeze(["self_sandbox", "proposal_only"]);
export const PRIVACY_MODES = Object.freeze(["strict_local"]);

export const CSP_HEADER =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'";

export const STATIC_ASSET_MANIFEST = Object.freeze([
  { urlPath: "/", repoRelPath: "ui/index.html", contentType: "text/html; charset=utf-8" },
  { urlPath: "/index.html", repoRelPath: "ui/index.html", contentType: "text/html; charset=utf-8" },
  { urlPath: "/styles.css", repoRelPath: "ui/styles.css", contentType: "text/css; charset=utf-8" },
  { urlPath: "/review.css", repoRelPath: "ui/review.css", contentType: "text/css; charset=utf-8" },
  { urlPath: "/contracts.js", repoRelPath: "ui/contracts.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/dom.js", repoRelPath: "ui/dom.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/app.js", repoRelPath: "ui/app.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/store.js", repoRelPath: "ui/store.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/palette.js", repoRelPath: "ui/palette.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/dag.js", repoRelPath: "ui/dag.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/timeline.js", repoRelPath: "ui/timeline.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/inspector.js", repoRelPath: "ui/inspector.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/composer.js", repoRelPath: "ui/composer.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/parse-patch.js", repoRelPath: "ui/parse-patch.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/rsi-view.js", repoRelPath: "ui/rsi-view.js", contentType: "text/javascript; charset=utf-8" },
  { urlPath: "/src/partition.mjs", repoRelPath: "src/partition.mjs", contentType: "text/javascript; charset=utf-8" },
]);

export const UI_ASSETS = Object.freeze(STATIC_ASSET_MANIFEST.map((a) => a.urlPath));

export const DIFF_CAPS = Object.freeze({
  maxFiles: 60,
  maxFileBytes: 65536,
  maxLinesPerFile: 500,
  maxTotalBytes: 524288,
  maxRenderedHunkLines: 2000,
});

export const EVENT_CAPS = Object.freeze({
  defaultLimit: 100,
  maxLimit: 250,
});

export const STORE_METHODS = Object.freeze([
  "recordLaneVerification",
  "getReceipt",
  "listEventsAfter",
  "upsertShowcase",
]);

export const EVENT_TYPES = Object.freeze([
  "mission_created",
  "mission_settings_updated",
  "topology_planned",
  "contracts_frozen",
  "lane_provisioned",
  "lane_verified",
  "gate_finished",
  "state_thinking",
  "state_planned",
  "state_frozen",
  "state_swarming",
  "state_verifying",
  "state_completed",
  "state_escalated",
  "worktrees_cleaned",
  "cloud_dispatched",
  "cloud_ingested",
  "ratchet_evaluated",
  "integration_started",
  "integration_verified",
  "integration_failed",
  "rsi_scanned",
  "rsi_evaluated",
  "rsi_promoted",
  "rsi_rolled_back",
]);

/** Declarative table describing which store event types map to replay entity projections. */
export const REPLAYABLE = Object.freeze({
  mission_created: { entity: "mission", op: "put" },
  mission_settings_updated: { entity: "mission", op: "put" },
  topology_planned: { entity: "mission", op: "put" },
  contracts_frozen: { entity: "contract", op: "put" },
  lane_provisioned: { entity: "lane", op: "put" },
  lane_verified: { entity: "lane", op: "put", receiptBound: true },
  gate_finished: { entity: "gate", op: "put" },
  state_thinking: { entity: "mission", op: "put" },
  state_planned: { entity: "mission", op: "put" },
  state_frozen: { entity: "mission", op: "put" },
  state_swarming: { entity: "mission", op: "put" },
  state_verifying: { entity: "mission", op: "put" },
  state_completed: { entity: "mission", op: "put" },
  state_escalated: { entity: "mission", op: "put" },
  worktrees_cleaned: { entity: "lane", op: "put" },
  cloud_dispatched: { entity: "lane", op: "put" },
  cloud_ingested: { entity: "lane", op: "put" },
  ratchet_evaluated: { entity: "lane", op: "put" },
  integration_started: { entity: "mission", op: "put" },
  integration_verified: { entity: "mission", op: "put" },
  integration_failed: { entity: "mission", op: "put" },
  rsi_scanned: { entity: "mission", op: "put" },
  rsi_evaluated: { entity: "mission", op: "put" },
  rsi_promoted: { entity: "mission", op: "put" },
  rsi_rolled_back: { entity: "mission", op: "put" },
});

export const ROUTES = Object.freeze({
  state: (missionId) => (missionId ? `/api/state?missionId=${encodeURIComponent(missionId)}` : "/api/state"),
  stream: (token) => `/api/stream?token=${encodeURIComponent(token || "")}`,
  adhd: (id) => `/api/adhd/${encodeURIComponent(id)}`,
  adhdPodPlan: () => "/api/adhd/pod-plan",
  assistants: (q = {}) => {
    const params = new URLSearchParams();
    if (q?.role) params.set("role", String(q.role));
    if (q?.since !== undefined && q?.since !== null) params.set("since", String(q.since));
    const suffix = params.toString();
    return suffix ? `/api/assistants?${suffix}` : "/api/assistants";
  },
  missions: () => "/api/missions",
  installPreview: () => "/api/install/preview",
  demoSeed: () => "/api/demo/seed",
  missionAction: (id, action) => `/api/missions/${encodeURIComponent(id)}/${action}`,
  missionIntegrate: (id) => `/api/missions/${encodeURIComponent(id)}/integrate`,
  missionIngestPatch: (id) => `/api/missions/${encodeURIComponent(id)}/ingest-patch`,
  missionCloudSpawn: (id) => `/api/missions/${encodeURIComponent(id)}/cloud-spawn`,
  rsiOverview: () => "/api/rsi/overview",
  rsiScan: () => "/api/rsi/scan",
  rsiCycle: () => "/api/rsi/cycle",
  rsiAudit: (id) => `/api/rsi/candidates/${encodeURIComponent(id)}/audit`,
  rsiPromote: (id) => `/api/rsi/candidates/${encodeURIComponent(id)}/promote`,
  rsiRollback: (id) => `/api/rsi/candidates/${encodeURIComponent(id)}/rollback`,
  missionEvents: (id, { after = 0, through = null, limit = EVENT_CAPS.defaultLimit } = {}) => {
    const q = new URLSearchParams({ after: String(after), limit: String(limit) });
    if (through !== null && through !== undefined) q.set("through", String(through));
    return `/api/missions/${encodeURIComponent(id)}/events?${q.toString()}`;
  },
  laneDiff: (id, laneId, { receiptId = null } = {}) => {
    const base = `/api/missions/${encodeURIComponent(id)}/lanes/${encodeURIComponent(laneId)}/diff`;
    return receiptId ? `${base}?receipt=${encodeURIComponent(receiptId)}` : base;
  },
  laneInspection: (id, laneId, { receiptId = null } = {}) => {
    const base = `/api/missions/${encodeURIComponent(id)}/lanes/${encodeURIComponent(laneId)}/inspection`;
    return receiptId ? `${base}?receipt=${encodeURIComponent(receiptId)}` : base;
  },
});

export const SHORTCUTS = Object.freeze([
  { id: "palette.toggle", keys: ["Mod+K"], label: "Command Palette", scope: "global", instant: true },
  { id: "view.map", keys: ["1"], label: "Mission Map (DAG)", scope: "global", instant: true },
  { id: "view.composer", keys: ["2"], label: "Topology & Routing Composer", scope: "global", instant: true },
  { id: "view.contracts", keys: ["3"], label: "Contracts, Gates & Fleet", scope: "global", instant: true },
  { id: "view.adhd", keys: ["4"], label: "ADHD Deep-Think Bridge", scope: "global", instant: true },
  { id: "view.rsi", keys: ["5"], label: "Evolution & Self-Improvement (RSI)", scope: "global", instant: true },
  { id: "lane.next", keys: ["j", "ArrowDown"], label: "Next Lane", scope: "workspace", instant: true },
  { id: "lane.prev", keys: ["k", "ArrowUp"], label: "Previous Lane", scope: "workspace", instant: true },
  { id: "inspector.open", keys: ["Enter", "Space"], label: "Inspect Focused Lane", scope: "workspace", instant: true },
  { id: "inspector.tab.diff", keys: ["d"], label: "Inspector: Diff", scope: "inspector", instant: true },
  { id: "inspector.tab.brief", keys: ["b"], label: "Inspector: Brief & Route", scope: "inspector", instant: true },
  { id: "inspector.tab.audit", keys: ["a"], label: "Inspector: Audit & SHA", scope: "inspector", instant: true },
  { id: "inspector.wide", keys: ["w"], label: "Toggle Wide Diff Drawer", scope: "inspector", instant: true },
  { id: "lane.verify", keys: ["v"], label: "Arm Verify Focused Lane (Enter confirms)", scope: "workspace", armed: true },
  { id: "dag.focus", keys: ["f"], label: "Isolate Failure / Causal Path", scope: "workspace", instant: true },
  { id: "mission.escalate", keys: ["e"], label: "Build ADHD Escalation Packet", scope: "workspace", instant: true },
  { id: "gates.review", keys: ["g"], label: "Arm Gate Run Review (Enter confirms)", scope: "workspace", armed: true },
  { id: "timeline.prev", keys: [","], label: "Step Timeline Backward", scope: "timeline", instant: true },
  { id: "timeline.next", keys: ["."], label: "Step Timeline Forward", scope: "timeline", instant: true },
  { id: "timeline.live", keys: ["l"], label: "Jump Timeline to Live Head", scope: "timeline", instant: true },
  { id: "pane.rail", keys: ["["], label: "Toggle Left Mission Rail", scope: "workspace", instant: true },
  { id: "pane.inspector", keys: ["]"], label: "Toggle Right Inspector", scope: "workspace", instant: true },
  { id: "pane.timeline", keys: ["t"], label: "Toggle Bottom Timeline Dock", scope: "workspace", instant: true },
  { id: "help.shortcuts", keys: ["?"], label: "Keyboard Shortcuts Help", scope: "global", instant: true },
  { id: "ui.escape", keys: ["Escape"], label: "Dismiss Top Surface / Cancel Arm", scope: "global", instant: true },
]);

/** Frozen CSS class names shared by instrument, review, and v0.3 RSI/cloud surfaces. */
export const UI_CLASSES = Object.freeze({
  shell: "od-shell",
  topbar: "od-topbar",
  rail: "od-rail",
  center: "od-center",
  inspector: "od-inspector",
  timelineDock: "od-timeline-dock",
  toastStack: "od-toast-stack",
  toast: "od-toast",
  banner: "od-banner",
  btn: "od-btn",
  btnPrimary: "od-btn-primary",
  btnGhost: "od-btn-ghost",
  btnDanger: "od-btn-danger",
  badge: "od-badge",
  kbd: "od-kbd",
  mono: "od-mono",
  tabular: "od-num",
  muted: "od-muted",
  // Inspector & Diff (owned by review + review.css)
  inspRoot: "od-insp",
  inspHeader: "od-insp-head",
  inspTabs: "od-insp-tabs",
  inspTabBtn: "od-insp-tab",
  inspBody: "od-insp-body",
  diffFileList: "od-diff-files",
  diffFileCard: "od-diff-file",
  diffFileHead: "od-diff-file-head",
  diffTable: "od-diff-table",
  diffLine: "od-diff-line",
  diffLineNum: "od-diff-ln",
  diffLineCode: "od-diff-code",
  diffHunkHeader: "od-diff-hunk",
  auditRow: "od-audit-row",
  // Composer (owned by review + review.css)
  compRoot: "od-comp",
  compToolbar: "od-comp-bar",
  compSplit: "od-comp-split",
  compLaneList: "od-comp-lanes",
  compLaneRow: "od-comp-lane",
  compMatrix: "od-comp-matrix",
  compMatrixCell: "od-comp-cell",
  compJsonArea: "od-comp-json",
  // DAG & Timeline & Palette (owned by instrument)
  dagRoot: "od-dag",
  dagSvg: "od-dag-svg",
  dagNode: "od-dag-node",
  dagEdge: "od-dag-edge",
  timelineSvg: "od-tl-svg",
  timelineScrubber: "od-tl-scrubber",
  paletteBackdrop: "od-palette-bg",
  paletteBox: "od-palette",
  paletteInput: "od-palette-input",
  paletteList: "od-palette-list",
  paletteItem: "od-palette-item",
  // v0.3 RSI & Cloud & Ratchet surfaces
  rsiPanel: "od-rsi",
  rsiCard: "od-rsi-card",
  ratchetBadge: "od-ratchet-badge",
  cloudBadge: "od-cloud-badge",
  meterTrack: "od-meter-track",
  meterFill: "od-meter-fill",
});

/** Shared client state store factory ({ getState, dispatch, subscribe }). */
export function createUiStore(initial = {}) {
  let state = {
    missionId: null,
    activeView: "map",
    selectedLaneId: null,
    selectedNodeId: null,
    selectedFilePath: null,
    inspectorTab: "diff",
    inspectorWide: false,
    cursorSeq: null, // null = LIVE HEAD
    focusFailureOnly: false,
    receiptCache: {},
    toasts: [],
    ...initial,
  };
  const listeners = new Set();
  return {
    getState: () => state,
    dispatch(patchOrFn) {
      const nextPatch = typeof patchOrFn === "function" ? patchOrFn(state) : patchOrFn;
      if (!nextPatch || typeof nextPatch !== "object") return state;
      state = { ...state, ...nextPatch };
      for (const fn of listeners) fn(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const METRIC_KEY_RE = /^[a-zA-Z0-9_.-]+$/;
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RATCHET_OPS = new Set([">=", "<=", "==", "delta>=", "delta<="]);
const FORBIDDEN_PUBLIC_HOLDOUT_KEYS = new Set([
  "holdoutCmd",
  "holdoutEnv",
  "holdoutCwd",
  "holdoutMetrics",
  "holdoutStdout",
  "holdoutStderr",
  "holdoutRawOutput",
]);
const STRICT_LOCAL_FORBIDDEN_PATTERNS = Object.freeze([
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/|\/Users\/|\/home\/)[^\\/\s"']+/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);
const FORBIDDEN_RAW_INTENTION_KEYS = new Set([
  "rawPrompt",
  "rawTranscript",
  "rawMessages",
  "rawSqlRow",
  "cookies",
  "tokens",
  "env",
]);

function resultFromErrors(errors) {
  return { ok: errors.length === 0, error: errors[0] || null, errors };
}

export function validateReplayEnvelope(r) {
  if (r === null) return { ok: true };
  if (!r || typeof r !== "object" || r.version !== 1) return { ok: false, error: "replay.version must be 1" };
  if (r.targetVersion !== undefined && !COMPATIBLE_TARGET_VERSIONS.includes(String(r.targetVersion))) {
    return { ok: false, error: `unsupported targetVersion: ${String(r.targetVersion)}` };
  }
  if (!Array.isArray(r.changes)) return { ok: false, error: "replay.changes must be array" };
  if (!Array.isArray(r.causes)) return { ok: false, error: "replay.causes must be array" };
  return { ok: true };
}

export function validateDiffResponse(d) {
  if (!d || typeof d !== "object") return { ok: false, error: "diff response must be object" };
  if (d.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: "invalid schemaVersion" };
  if (!Array.isArray(d.files) || !Array.isArray(d.contracts)) return { ok: false, error: "files and contracts arrays required" };
  return { ok: true };
}

export function validateInspectionResponse(res) {
  if (!res || typeof res !== "object") return { ok: false, error: "inspection response must be object" };
  if (res.schemaVersion !== SCHEMA_VERSION || !res.laneId || !res.missionId) return { ok: false, error: "missing schemaVersion/missionId/laneId" };
  return { ok: true };
}

export function validateEventsResponse(res) {
  if (!res || typeof res !== "object") return { ok: false, error: "events response must be object" };
  if (res.schemaVersion !== SCHEMA_VERSION || !Array.isArray(res.events)) return { ok: false, error: "invalid events payload" };
  return { ok: true };
}

export function validateDemoSeedResponse(res) {
  if (!res || typeof res !== "object") return { ok: false, error: "demo response must be object" };
  if (res.schemaVersion !== SCHEMA_VERSION || !res.missionId || !res.fixtureVersion) {
    return { ok: false, error: "missing schemaVersion/missionId/fixtureVersion" };
  }
  return { ok: true };
}

/** Strip coordinator-private holdout configuration before persisting briefs or exposing public state. */
export function toPublicRatchetSpec(spec) {
  if (!isPlainObject(spec)) return spec;
  const copy = { ...spec };
  for (const key of FORBIDDEN_PUBLIC_HOLDOUT_KEYS) {
    delete copy[key];
  }
  copy.holdoutConfigured = Boolean(spec.holdoutCmd || spec.holdoutConfigured);
  return copy;
}

export function validateRatchetSpec(spec, { allowHoldout = false } = {}) {
  const errors = [];
  if (!isPlainObject(spec)) return resultFromErrors(["ratchet spec must be an object"]);
  if (!allowHoldout) {
    for (const k of FORBIDDEN_PUBLIC_HOLDOUT_KEYS) {
      if (spec[k] !== undefined) errors.push(`ratchet.${k} is coordinator-private and forbidden in worker/public specs`);
    }
  } else if (spec.holdoutCmd !== undefined && !isNonEmptyString(spec.holdoutCmd)) {
    errors.push("ratchet.holdoutCmd must be non-empty when set");
  }
  if (!Array.isArray(spec.metrics) || spec.metrics.length === 0) {
    errors.push("ratchet.metrics must be a non-empty array");
  } else {
    const seen = new Set();
    spec.metrics.forEach((m, idx) => {
      if (!isPlainObject(m)) {
        errors.push(`ratchet.metrics[${idx}] must be an object`);
        return;
      }
      if (!isNonEmptyString(m.name) || !METRIC_KEY_RE.test(m.name)) {
        errors.push(`ratchet.metrics[${idx}].name invalid`);
      } else if (seen.has(m.name)) {
        errors.push(`duplicate metric "${m.name}"`);
      } else {
        seen.add(m.name);
      }
      const op = m.op ?? (m.direction === "lower" ? "<=" : ">=");
      if (!RATCHET_OPS.has(op)) errors.push(`ratchet.metrics[${idx}].op invalid: ${String(op)}`);
      if (m.direction !== undefined && m.direction !== "higher" && m.direction !== "lower") {
        errors.push(`ratchet.metrics[${idx}].direction must be "higher" or "lower"`);
      }
      if (m.baseline !== undefined && !isFiniteNum(m.baseline)) {
        errors.push(`ratchet.metrics[${idx}].baseline must be finite number`);
      }
      if (m.target !== undefined && !isFiniteNum(m.target)) {
        errors.push(`ratchet.metrics[${idx}].target must be finite number`);
      }
      if (m.baseline === undefined && m.target === undefined) {
        errors.push(`ratchet.metrics[${idx}] requires baseline or target`);
      }
      if (m.tolerance !== undefined && (!isFiniteNum(m.tolerance) || m.tolerance < 0)) {
        errors.push(`ratchet.metrics[${idx}].tolerance must be finite >= 0`);
      }
      if (m.maxRegression !== undefined && (!isFiniteNum(m.maxRegression) || m.maxRegression < 0)) {
        errors.push(`ratchet.metrics[${idx}].maxRegression must be finite >= 0`);
      }
    });
  }
  if (spec.coverageFloor !== undefined) {
    if (!isPlainObject(spec.coverageFloor) || !isNonEmptyString(spec.coverageFloor.countMetric) || !isFiniteNum(spec.coverageFloor.minValue) || spec.coverageFloor.minValue < 0) {
      errors.push("ratchet.coverageFloor requires { countMetric, minValue >= 0 }");
    }
  }
  return resultFromErrors(errors);
}

export function validateRatchetResult(res) {
  const errors = [];
  if (!isPlainObject(res)) return resultFromErrors(["ratchetResult must be an object"]);
  for (const k of FORBIDDEN_PUBLIC_HOLDOUT_KEYS) {
    if (res[k] !== undefined) errors.push(`ratchetResult.${k} is forbidden in public payloads`);
  }
  if (typeof res.ok !== "boolean") errors.push("ratchetResult.ok must be boolean");
  if (res.exitCode !== undefined && !Number.isInteger(res.exitCode)) errors.push("ratchetResult.exitCode must be integer");
  if (res.exitCode !== undefined && res.exitCode !== 0 && res.ok === true) {
    errors.push("ratchetResult.ok cannot be true when exitCode !== 0");
  }
  if (!isPlainObject(res.metrics)) errors.push("ratchetResult.metrics must be object");
  else {
    for (const [k, v] of Object.entries(res.metrics)) {
      if (!isFiniteNum(v)) errors.push(`ratchetResult.metrics.${k} must be finite number`);
    }
  }
  if (!isPlainObject(res.baseline)) errors.push("ratchetResult.baseline must be object");
  if (!isPlainObject(res.deltas)) errors.push("ratchetResult.deltas must be object");
  if (!Array.isArray(res.violations)) errors.push("ratchetResult.violations must be array");
  else if (res.violations.length > 0 && res.ok === true) {
    errors.push("ratchetResult.ok cannot be true when violations are non-empty");
  }
  if (res.holdoutConfigured && res.holdoutPassed === false && res.ok === true) {
    errors.push("ratchetResult.ok cannot be true when holdoutPassed is false");
  }
  return resultFromErrors(errors);
}

function scanStrictLocalStrings(val, errors, label) {
  if (typeof val === "string") {
    for (const rx of STRICT_LOCAL_FORBIDDEN_PATTERNS) {
      if (rx.test(val)) {
        errors.push(`${label} contains unredacted PII, home path, or credential material`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(val)) {
    val.forEach((item, idx) => scanStrictLocalStrings(item, errors, `${label}[${idx}]`));
    return;
  }
  if (isPlainObject(val)) {
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_RAW_INTENTION_KEYS.has(k)) {
        errors.push(`${label}.${k} is forbidden under strict_local intention digests`);
      } else {
        scanStrictLocalStrings(v, errors, `${label}.${k}`);
      }
    }
  }
}

export function validateIntentionDigest(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return resultFromErrors(["intentionDigest must be object"]);
  if (doc.schemaVersion !== SCHEMA_VERSION) errors.push("intentionDigest.schemaVersion must be 1");
  if (doc.privacyMode !== "strict_local") errors.push('intentionDigest.privacyMode must be "strict_local"');
  if (!isNonEmptyString(doc.generatedAt) || !ISO_TZ_RE.test(doc.generatedAt)) {
    errors.push("intentionDigest.generatedAt must be timezone-aware ISO timestamp");
  }
  if (!Number.isInteger(doc.totalSessions) || doc.totalSessions < 0) errors.push("totalSessions must be int >= 0");
  if (!isFiniteNum(doc.cloudOffloadPct) || doc.cloudOffloadPct < 0 || doc.cloudOffloadPct > 100) {
    errors.push("cloudOffloadPct must be within [0, 100]");
  }
  if (!isFiniteNum(doc.freePoolPct) || doc.freePoolPct < 0 || doc.freePoolPct > 100) {
    errors.push("freePoolPct must be within [0, 100]");
  }
  for (const field of ["activeFocus", "wentQuietQuestions", "frictionHotspots", "driftAlerts"]) {
    if (!Array.isArray(doc[field])) errors.push(`intentionDigest.${field} must be array`);
  }
  if (Array.isArray(doc.wentQuietQuestions)) {
    doc.wentQuietQuestions.forEach((q, idx) => {
      if (!isPlainObject(q)) {
        errors.push(`wentQuietQuestions[${idx}] must be object`);
        return;
      }
      if (q.kind !== "owner_question") errors.push(`wentQuietQuestions[${idx}].kind must be "owner_question"`);
      if (q.autoDispatch !== false) errors.push(`wentQuietQuestions[${idx}].autoDispatch must strictly be false`);
    });
  }
  if (Array.isArray(doc.activeFocus)) {
    doc.activeFocus.forEach((f, idx) => {
      if (isPlainObject(f) && (f.signal === "went_quiet" || (isFiniteNum(f.quietHours) && f.quietHours >= 72))) {
        errors.push(`activeFocus[${idx}]: quiet >= 72h projects must reside in wentQuietQuestions with autoDispatch:false`);
      }
    });
  }
  scanStrictLocalStrings(doc, errors, "intentionDigest");
  return resultFromErrors(errors);
}

const RSI_STATUS_SET = new Set([
  "proposed",
  "evaluated",
  "evaluated_pending_audit",
  "audited",
  "promoted",
  "rejected",
  "rolled_back",
]);

export function validateRsiCandidate(c) {
  const errors = [];
  if (!isPlainObject(c)) return resultFromErrors(["rsiCandidate must be object"]);
  if (!isNonEmptyString(c.id)) errors.push("rsiCandidate.id required");
  if (!isNonEmptyString(c.category)) errors.push("rsiCandidate.category required");
  if (!isNonEmptyString(c.targetRepo)) errors.push("rsiCandidate.targetRepo required");
  if (!RSI_TIERS.includes(c.tier)) errors.push(`rsiCandidate.tier must be one of: ${RSI_TIERS.join(", ")}`);
  if (!isNonEmptyString(c.title)) errors.push("rsiCandidate.title required");
  if (typeof c.rationale !== "string") errors.push("rsiCandidate.rationale must be string");
  if (!Array.isArray(c.evidenceRefs)) errors.push("rsiCandidate.evidenceRefs must be array");
  if (!RSI_STATUS_SET.has(c.status)) errors.push("rsiCandidate.status invalid");
  if (c.baselineScore !== null && c.baselineScore !== undefined && !isFiniteNum(c.baselineScore)) {
    errors.push("baselineScore must be finite number or null");
  }
  if (c.candidateScore !== null && c.candidateScore !== undefined && !isFiniteNum(c.candidateScore)) {
    errors.push("candidateScore must be finite number or null");
  }
  if (!Number.isInteger(c.regressions ?? 0) || (c.regressions ?? 0) < 0) {
    errors.push("regressions must be int >= 0");
  }
  if (c.touchesHarness !== undefined && typeof c.touchesHarness !== "boolean") {
    errors.push("touchesHarness must be boolean");
  }
  if (c.prePromoteCommit != null && !HEX_SHA_RE.test(String(c.prePromoteCommit))) {
    errors.push("prePromoteCommit must be valid hex commit SHA");
  }
  if (c.status === "promoted" || c.status === "rolled_back") {
    if (!isNonEmptyString(c.prePromoteCommit) || !HEX_SHA_RE.test(String(c.prePromoteCommit))) {
      errors.push("prePromoteCommit SHA required for promoted/rolled_back states");
    }
  }
  if (c.status === "promoted") {
    if (c.tier === "proposal_only" && c.humanApproved !== true) {
      errors.push("proposal_only candidate cannot be promoted without explicit humanApproved: true");
    }
    if (c.touchesHarness === true) {
      errors.push("promoted candidate must not tamper with evaluator harness");
    }
    if ((c.regressions ?? 0) > 0) {
      errors.push("promoted candidate must have 0 regressions");
    }
    if (isFiniteNum(c.baselineScore) && isFiniteNum(c.candidateScore) && c.candidateScore < c.baselineScore) {
      errors.push("promoted candidate must not regress candidateScore below baselineScore");
    }
    if (!isPlainObject(c.audit) || c.audit.verdict !== "approve") {
      errors.push("promoted candidate requires passing audit.verdict === \"approve\"");
    } else if (c.audit.modelExecuted === false || c.audit.auditKind === "deterministic_local_gate") {
      errors.push("promoted candidate cannot rely on deterministic_local_gate without executed cross-family audit");
    } else if (c.proposer?.family && c.audit.auditorFamily && c.audit.auditorFamily === c.proposer.family) {
      errors.push("promoted candidate requires cross-family audit (auditorFamily !== proposer.family)");
    }
  }
  return resultFromErrors(errors);
}

export const CONTRACT_FIXTURES = Object.freeze({
  replayCheckpoint: { version: 1, checkpoint: { mission: { id: "m1", state: "planned" }, contracts: {}, lanes: {}, gates: {} }, changes: [], causes: [], receiptId: null },
  replayDelta: { version: 1, checkpoint: null, changes: [{ op: "put", entity: "lane", id: "core", value: { id: "core", status: "verified", scopeOk: true } }], causes: [2], receiptId: "rcpt-1" },
  diff: {
    schemaVersion: 1,
    missionId: "m1",
    laneId: "interface",
    source: "receipt",
    receiptId: "rcpt-1",
    freezeCommit: "deadbeef",
    capturedAt: "2026-11-18T00:00:00.000Z",
    truncated: false,
    omittedFiles: 0,
    files: [{ path: "ui/app.js", oldPath: null, status: "modified", ownership: "out_of_scope", matchedGlob: null, additions: 1, deletions: 0, binary: false, truncated: false, patch: "--- a/ui/app.js\n+++ b/ui/app.js\n@@ -1,1 +1,2 @@\n+// out of scope" }],
    contracts: [{ path: "ui/contracts.js", expected: "abc", observed: "abc", intact: true }],
  },
});
