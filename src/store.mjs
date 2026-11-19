import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { buildShowcaseSpec } from "./demo.mjs";
import { validateTopology, normalizeRelPattern } from "./partition.mjs";
import { defaultDataDir } from "./paths.mjs";
import { extractPrivateHoldoutFields, savePrivateHoldout, stripPrivateRatchetFields } from "./ratchet.mjs";
import { detectFleet, resolveMissionRouting, ROUTING_MODES } from "./routing.mjs";
import { RSI_TABLE_DDL } from "./rsi.mjs";
import {
  EVENT_CAPS,
  REPLAYABLE,
  REPLAY_VERSION,
  SCHEMA_VERSION,
  SHOWCASE_SLUG,
  toPublicRatchetSpec,
  validateRatchetSpec,
} from "./ui-contracts.mjs";

const iso = () => new Date().toISOString();

export { defaultDataDir };

function slugify(s) {
  return (
    String(s || "mission")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "mission"
  );
}

function safeJsonParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function finiteOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function notFoundError(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

export function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function gitHead(repoRoot) {
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed in "${repoRoot}": ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

function gitDirtyFiles(repoRoot, paths) {
  if (!paths.length) return [];
  const r = spawnSync("git", ["-C", repoRoot, "status", "--porcelain", "--", ...paths], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.trim());
}

function inferStageFromType(type) {
  if (!type) return "unknown";
  if (type === "mission_created" || type === "state_thinking") return "thinking";
  if (type === "topology_planned" || type === "state_planned" || type === "mission_settings_updated") return "planned";
  if (type === "contracts_frozen" || type === "state_frozen") return "frozen";
  if (type === "lane_provisioned" || type === "state_swarming" || type === "cloud_dispatched" || type === "cloud_ingested") return "swarming";
  if (
    type === "lane_verified" ||
    type === "gate_finished" ||
    type === "state_verifying" ||
    type === "ratchet_evaluated" ||
    type === "integration_started" ||
    type === "integration_verified" ||
    type === "integration_failed"
  ) {
    return "verifying";
  }
  if (type === "state_completed" || type === "worktrees_cleaned") return "completed";
  if (type === "state_escalated") return "escalated";
  if (String(type).startsWith("rsi_")) return "rsi";
  return "active";
}

function buildEventSummary(type, role, payload = {}) {
  switch (type) {
    case "mission_created":
      return `Mission "${payload.title || "untitled"}" created (${payload.routingMode || "single-harness"})`;
    case "mission_settings_updated":
      return `Updated routing settings (${payload.routingMode || "single-harness"} / ${payload.activeHarness || "antigravity"})`;
    case "topology_planned":
      return `Planned ${payload.laneCount ?? 0} lanes, ${payload.contractCount ?? 0} contracts, ${payload.gateCount ?? 0} gates`;
    case "contracts_frozen":
      return `Contracts frozen at ${String(payload.freezeCommit || "HEAD").slice(0, 8)}`;
    case "lane_provisioned":
      return `Provisioned lane ${payload.laneId || "?"} (${payload.status || "active"})`;
    case "lane_verified":
      return `Lane ${payload.laneId || "?"} ${payload.status || (payload.scopeOk ? "verified" : "failed")}${payload.violation ? `: ${payload.violation}` : ""}`;
    case "gate_finished":
      return `Gate ${payload.gateId || "?"} ${payload.status || "finished"} (exit ${payload.exitCode ?? "?"})`;
    case "worktrees_cleaned":
      return `Cleaned ${(payload.removed || []).length} worktree(s)`;
    case "cloud_dispatched":
      return `Dispatched lane ${payload.laneId || "?"} to ${payload.provider || "cloud-agent"}`;
    case "cloud_ingested":
      return `Ingested SHA-256 patch for lane ${payload.laneId || "?"}`;
    case "ratchet_evaluated":
      return `Ratchet ${payload.ok ? "passed" : "failed"} for lane ${payload.laneId || "?"}`;
    case "integration_started":
      return `Trial-merge integration started (${payload.laneCount ?? "?"} lane(s))`;
    case "integration_verified":
      return `Trial-merge integration verified (${payload.summary || "all lanes merged cleanly"})`;
    case "integration_failed":
      return `Trial-merge integration failed: ${payload.error || "conflict"}`;
    case "rsi_scanned":
      return `RSI scanned ${payload.candidateCount ?? 0} candidate(s) (benchmark ${payload.score ?? "?"}/${payload.maxScore ?? 100})`;
    case "rsi_evaluated":
      return `RSI evaluated ${payload.candidateId || "?"} -> ${payload.status || "evaluated"}`;
    case "rsi_promoted":
      return `RSI promoted ${payload.candidateId || "?"} (prePromoteCommit ${String(payload.prePromoteCommit || "").slice(0, 8)})`;
    case "rsi_rolled_back":
      return `RSI rolled back ${payload.candidateId || "?"} to ${String(payload.restoredCommit || "").slice(0, 8)}`;
    default:
      if (String(type).startsWith("state_")) {
        return `Mission state -> ${String(type).slice("state_".length)}`;
      }
      return `${role || "coordinator"}: ${type}`;
  }
}

function buildDefaultReplay(type, missionId, payload = {}, causes = [], receiptId = null) {
  const rule = REPLAYABLE[type];
  if (!rule) return null;
  let changes = [];
  if (rule.entity === "mission") {
    const value = { id: missionId };
    if (type.startsWith("state_")) {
      value.state = type.slice("state_".length);
    } else if (type === "mission_created") {
      value.state = payload.adhdSessionId ? "thinking" : "draft";
      if (payload.title) value.title = payload.title;
      if (payload.routingMode) value.routingMode = payload.routingMode;
      if (payload.activeHarness) value.activeHarness = payload.activeHarness;
    } else if (type === "mission_settings_updated") {
      if (payload.routingMode) value.routingMode = payload.routingMode;
      if (payload.activeHarness) value.activeHarness = payload.activeHarness;
      if (payload.adhdSessionId !== undefined) value.adhdSessionId = payload.adhdSessionId;
    } else if (type === "topology_planned") {
      value.state = "planned";
      if (payload.routingMode) value.routingMode = payload.routingMode;
    }
    changes = [{ op: rule.op, entity: "mission", id: missionId, value }];
  } else if (rule.entity === "contract") {
    changes = (Array.isArray(payload.contracts) ? payload.contracts : []).map((c) => ({
      op: "put",
      entity: "contract",
      id: c.path,
      value: { path: c.path, sha256: c.sha256 },
    }));
    changes.push({
      op: "put",
      entity: "mission",
      id: missionId,
      value: { id: missionId, state: "frozen", freezeCommit: payload.freezeCommit || null },
    });
  } else if (rule.entity === "lane" && payload.laneId) {
    const value = { id: payload.laneId };
    if (payload.status !== undefined) value.status = payload.status;
    if (payload.scopeOk !== undefined) value.scopeOk = Boolean(payload.scopeOk);
    if (payload.worktreePath !== undefined) value.worktreePath = payload.worktreePath;
    if (payload.branchName !== undefined) value.branchName = payload.branchName;
    if (receiptId) value.lastReceiptId = receiptId;
    changes = [{ op: "put", entity: "lane", id: payload.laneId, value }];
  } else if (rule.entity === "gate" && payload.gateId) {
    changes = [{ op: "put", entity: "gate", id: payload.gateId, value: { id: payload.gateId, status: payload.status } }];
  }
  return {
    version: REPLAY_VERSION,
    checkpoint: null,
    changes,
    causes: Array.isArray(causes) ? causes : [],
    receiptId: receiptId || null,
  };
}

function extractPublicLaneConfig(l) {
  if (!l || typeof l !== "object") return null;
  const cfg = {};
  if (Array.isArray(l.ownedRegions) && l.ownedRegions.length > 0) cfg.ownedRegions = l.ownedRegions;
  if (Array.isArray(l.ignoreUntrackedGlobs) && l.ignoreUntrackedGlobs.length > 0) {
    cfg.ignoreUntrackedGlobs = l.ignoreUntrackedGlobs;
  }
  if (Array.isArray(l.readOnlyMounts) && l.readOnlyMounts.length > 0) cfg.readOnlyMounts = l.readOnlyMounts;
  if (l.ratchet && typeof l.ratchet === "object") cfg.ratchet = stripPrivateRatchetFields(l.ratchet);
  if (l.cloudDispatch && typeof l.cloudDispatch === "object") cfg.cloudDispatch = l.cloudDispatch;
  return Object.keys(cfg).length > 0 ? cfg : null;
}

function extractPublicGateConfig(g) {
  if (!g || typeof g !== "object") return null;
  if (!g.ratchet || typeof g.ratchet !== "object") return null;
  return { ratchet: stripPrivateRatchetFields(g.ratchet) };
}

function normalizeLaneTelemetry(raw = {}, worker = {}, lastVerify = null, row = {}) {
  const base = raw && typeof raw === "object" ? { ...raw } : {};
  const filesChanged = Array.isArray(base.filesChanged)
    ? base.filesChanged
    : Array.isArray(lastVerify?.changedFiles)
      ? lastVerify.changedFiles
      : null;
  return {
    model: base.model ?? worker?.model ?? null,
    harness: base.harness ?? worker?.harness ?? null,
    durationMs: finiteOrNull(base.durationMs ?? lastVerify?.durationMs),
    tokensIn: finiteOrNull(base.tokensIn),
    tokensOut: finiteOrNull(base.tokensOut),
    costUsd: finiteOrNull(base.costUsd),
    branch: base.branch ?? row.branch_name ?? null,
    worktreePath: base.worktreePath ?? row.worktree_path ?? null,
    headSha: base.headSha ?? row.head_sha ?? lastVerify?.headSha ?? null,
    filesChanged,
  };
}

export class OverdriveStore extends EventEmitter {
  constructor(dataDir = defaultDataDir()) {
    super();
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, "overdrive.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        routing_mode TEXT NOT NULL DEFAULT 'single-harness',
        active_harness TEXT NOT NULL DEFAULT 'antigravity',
        adhd_session_id TEXT,
        state TEXT NOT NULL DEFAULT 'draft',
        freeze_commit TEXT,
        fixture_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contracts (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sha256 TEXT,
        frozen_at TEXT,
        PRIMARY KEY (mission_id, path)
      );

      CREATE TABLE IF NOT EXISTS lanes (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        complexity TEXT NOT NULL DEFAULT 'standard',
        owned_globs_json TEXT NOT NULL,
        verify_cmd TEXT NOT NULL,
        offload TEXT NOT NULL DEFAULT 'auto',
        worker_json TEXT NOT NULL DEFAULT '{}',
        verifier_json TEXT NOT NULL DEFAULT '{}',
        worktree_path TEXT,
        branch_name TEXT,
        head_sha TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        scope_ok INTEGER,
        last_verify_json TEXT,
        last_receipt_id TEXT,
        telemetry_json TEXT NOT NULL DEFAULT '{}',
        synthetic_diff_json TEXT,
        lane_config_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, id)
      );

      CREATE TABLE IF NOT EXISTS gates (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        cmd TEXT NOT NULL,
        offload TEXT NOT NULL DEFAULT 'auto',
        required INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        last_run_json TEXT,
        gate_config_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, id)
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        stage TEXT,
        lane_id TEXT,
        gate_id TEXT,
        actor TEXT,
        summary TEXT,
        metrics_json TEXT,
        receipt_id TEXT,
        causes_json TEXT,
        replay_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        lane_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'lane_verify',
        status TEXT NOT NULL,
        scope_ok INTEGER NOT NULL,
        freeze_commit TEXT,
        head_sha TEXT,
        result_json TEXT NOT NULL,
        diff_json TEXT,
        inspection_json TEXT,
        contracts_json TEXT NOT NULL DEFAULT '[]',
        telemetry_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, seq);
      CREATE INDEX IF NOT EXISTS idx_receipts_mission_lane ON receipts(mission_id, lane_id, created_at DESC);
    `);

    this.#ensureAdditiveSchema();
  }

  #ensureAdditiveSchema() {
    this.db.exec(RSI_TABLE_DDL);
    const ensureColumns = (table, cols) => {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, ddl] of cols) {
        if (!existing.has(name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
        }
      }
    };
    ensureColumns("missions", [["fixture_version", "TEXT"]]);
    ensureColumns("lanes", [
      ["head_sha", "TEXT"],
      ["last_receipt_id", "TEXT"],
      ["telemetry_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["synthetic_diff_json", "TEXT"],
      ["lane_config_json", "TEXT"],
    ]);
    ensureColumns("gates", [["gate_config_json", "TEXT"]]);
    ensureColumns("events", [
      ["stage", "TEXT"],
      ["lane_id", "TEXT"],
      ["gate_id", "TEXT"],
      ["actor", "TEXT"],
      ["summary", "TEXT"],
      ["metrics_json", "TEXT"],
      ["receipt_id", "TEXT"],
      ["causes_json", "TEXT"],
      ["replay_json", "TEXT"],
    ]);
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  #latestEventSeq(missionId) {
    const row = this.db.prepare("SELECT MAX(seq) AS maxSeq FROM events WHERE mission_id=?").get(missionId);
    return row?.maxSeq ?? null;
  }

  recordEvent(missionId, role, type, payload = {}, meta = {}) {
    const at = meta.createdAt || iso();
    const stage = meta.stage || payload?.stage || inferStageFromType(type);
    const laneId = meta.laneId ?? payload?.laneId ?? null;
    const gateId = meta.gateId ?? payload?.gateId ?? null;
    const actor = meta.actor || payload?.actor || role;
    const summary = meta.summary || payload?.summary || buildEventSummary(type, role, payload);
    const metrics = meta.metrics ?? payload?.metrics ?? null;
    const receiptId = meta.receiptId ?? payload?.receiptId ?? null;
    const prevSeq = meta.causes ? null : this.#latestEventSeq(missionId);
    const causes = Array.isArray(meta.causes) ? meta.causes : prevSeq ? [prevSeq] : [];
    const replay =
      meta.replay !== undefined
        ? meta.replay
        : buildDefaultReplay(type, missionId, payload, causes, receiptId);

    const res = this.db
      .prepare(
        `INSERT INTO events(
          mission_id, role, type, payload_json,
          stage, lane_id, gate_id, actor, summary, metrics_json, receipt_id, causes_json, replay_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        missionId,
        role,
        type,
        JSON.stringify(payload),
        stage,
        laneId,
        gateId,
        actor,
        summary,
        metrics ? JSON.stringify(metrics) : null,
        receiptId,
        JSON.stringify(causes),
        replay ? JSON.stringify(replay) : null,
        at,
      );

    const ev = {
      seq: Number(res.lastInsertRowid),
      missionId,
      ts: at,
      createdAt: at,
      kind: payload?.kind || type,
      type,
      stage,
      laneId,
      gateId,
      actor,
      role,
      summary,
      detail: payload?.detail ?? payload,
      payload,
      metrics,
      receiptId,
      causes,
      replay,
    };
    this.emit("change", ev);
    return ev;
  }

  hydrateEventRow(row) {
    const payload = safeJsonParse(row.payload_json, {});
    const stage = row.stage || payload.stage || inferStageFromType(row.type);
    const laneId = row.lane_id ?? payload.laneId ?? null;
    const gateId = row.gate_id ?? payload.gateId ?? null;
    const actor = row.actor || payload.actor || row.role;
    const summary = row.summary || payload.summary || buildEventSummary(row.type, row.role, payload);
    const metrics = row.metrics_json ? safeJsonParse(row.metrics_json, null) : payload.metrics ?? null;
    const receiptId = row.receipt_id ?? payload.receiptId ?? null;
    const causes = row.causes_json
      ? safeJsonParse(row.causes_json, [])
      : Array.isArray(payload.causes)
        ? payload.causes
        : [];
    const replay = row.replay_json
      ? safeJsonParse(row.replay_json, null)
      : payload.replay ?? buildDefaultReplay(row.type, row.mission_id, payload, causes, receiptId);

    return {
      seq: row.seq,
      missionId: row.mission_id,
      ts: row.created_at,
      createdAt: row.created_at,
      kind: payload.kind || row.type,
      type: row.type,
      stage,
      laneId,
      gateId,
      actor,
      role: row.role,
      summary,
      detail: payload.detail ?? payload,
      payload,
      metrics,
      receiptId,
      causes,
      replay,
    };
  }

  hydrateReceiptRow(row) {
    return {
      id: row.id,
      receiptId: row.id,
      missionId: row.mission_id,
      laneId: row.lane_id,
      kind: row.kind,
      status: row.status,
      scopeOk: Boolean(row.scope_ok),
      freezeCommit: row.freeze_commit,
      headSha: row.head_sha,
      result: safeJsonParse(row.result_json, {}),
      diff: safeJsonParse(row.diff_json, null),
      inspection: safeJsonParse(row.inspection_json, null),
      contracts: safeJsonParse(row.contracts_json, []),
      telemetry: safeJsonParse(row.telemetry_json, {}),
      createdAt: row.created_at,
    };
  }

  createMission({ title, goal, repoRoot, routingMode = "single-harness", activeHarness = "antigravity", adhdSessionId = null }) {
    if (!title?.trim()) throw new Error("title is required.");
    if (!goal?.trim()) throw new Error("goal is required.");
    if (!repoRoot?.trim() || !existsSync(repoRoot)) throw new Error(`repoRoot does not exist: "${repoRoot}"`);
    if (!ROUTING_MODES.includes(routingMode)) {
      throw new Error(`Invalid routingMode "${routingMode}". Expected one of: ${ROUTING_MODES.join(", ")}`);
    }

    const id = randomUUID();
    const slug = `${slugify(title)}-${id.slice(0, 6)}`;
    const now = iso();
    const state = adhdSessionId ? "thinking" : "draft";

    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO missions(id, slug, title, goal, repo_root, routing_mode, active_harness, adhd_session_id, state, freeze_commit, fixture_version, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)",
        )
        .run(
          id,
          slug,
          title.trim(),
          goal.trim(),
          path.resolve(repoRoot).replaceAll("\\", "/"),
          routingMode,
          activeHarness,
          adhdSessionId || null,
          state,
          now,
          now,
        );
      this.recordEvent(id, "coordinator", "mission_created", {
        title: title.trim(),
        routingMode,
        activeHarness,
        adhdSessionId,
      });
    });

    return this.getMission(id);
  }

  updateMissionSettings(missionId, { routingMode, activeHarness, adhdSessionId, fleet }) {
    const m = this.requireMission(missionId);
    const nextMode = routingMode || m.routingMode;
    const nextHarness = activeHarness || m.activeHarness;
    const nextAdhd = adhdSessionId !== undefined ? adhdSessionId : m.adhdSessionId;

    this.tx(() => {
      this.db
        .prepare("UPDATE missions SET routing_mode=?, active_harness=?, adhd_session_id=?, updated_at=? WHERE id=?")
        .run(nextMode, nextHarness, nextAdhd, iso(), m.id);

      let routed = null;
      if (m.lanes.length > 0 && (routingMode || activeHarness)) {
        routed = resolveMissionRouting({ routingMode: nextMode, activeHarness: nextHarness }, m.lanes, fleet || detectFleet());
        const stmt = this.db.prepare("UPDATE lanes SET worker_json=?, verifier_json=?, updated_at=? WHERE mission_id=? AND id=?");
        const now = iso();
        for (const l of routed.lanes) {
          stmt.run(JSON.stringify(l.worker), JSON.stringify({ ...l.verifier, effectiveOffload: l.effectiveOffload }), now, m.id, l.id);
        }
      }
      this.recordEvent(m.id, "coordinator", "mission_settings_updated", {
        routingMode: nextMode,
        activeHarness: nextHarness,
        adhdSessionId: nextAdhd,
        ...(routed
          ? {
              freeTierPolicy: routed.freeTierPolicy,
              routingWarnings: routed.routingWarnings || [],
              degradedAccounts: routed.degradedAccounts || [],
            }
          : {}),
      });
    });
    return this.getMission(m.id);
  }

  /** Validate topology & routing mechanically and save contracts + lanes + gates. */
  planMission(missionId, { sharedContracts = [], lanes = [], gates = [], routingMode, activeHarness, fleet } = {}) {
    const m = this.requireMission(missionId);
    if (["swarming", "verifying", "completed"].includes(m.state)) {
      throw new Error(`Cannot re-plan mission while in state "${m.state}". Escalate or reset first.`);
    }

    const check = validateTopology({ sharedContracts, lanes, gates });
    if (!check.ok) {
      return { ok: false, errors: check.errors, collisions: check.collisions, mission: m };
    }

    const ratchetErrors = [];
    for (const l of check.normalized.lanes) {
      if (l.ratchet !== undefined) {
        const rChk = validateRatchetSpec(l.ratchet, { allowHoldout: true });
        if (!rChk.ok) ratchetErrors.push(`Lane "${l.id}": ${rChk.errors.join("; ")}`);
      }
    }
    for (const g of check.normalized.gates) {
      if (g.ratchet !== undefined) {
        const rChk = validateRatchetSpec(g.ratchet, { allowHoldout: true });
        if (!rChk.ok) ratchetErrors.push(`Gate "${g.id}": ${rChk.errors.join("; ")}`);
      }
    }
    if (ratchetErrors.length > 0) {
      return { ok: false, errors: ratchetErrors, collisions: [], mission: m };
    }

    const nextMode = routingMode || m.routingMode;
    const nextHarness = activeHarness || m.activeHarness;
    const resolved = resolveMissionRouting({ routingMode: nextMode, activeHarness: nextHarness }, check.normalized.lanes, fleet || detectFleet());
    const rawById = new Map(lanes.map((l) => [String(l?.id || "").trim(), l]));
    const now = iso();

    this.tx(() => {
      this.db.prepare("DELETE FROM contracts WHERE mission_id=?").run(m.id);
      this.db.prepare("DELETE FROM lanes WHERE mission_id=?").run(m.id);
      this.db.prepare("DELETE FROM gates WHERE mission_id=?").run(m.id);

      const cStmt = this.db.prepare("INSERT INTO contracts(mission_id, path, description, sha256, frozen_at) VALUES(?,?,?,NULL,NULL)");
      for (const c of check.normalized.sharedContracts) {
        cStmt.run(m.id, c.path, c.description);
      }

      const lStmt = this.db.prepare(
        "INSERT INTO lanes(mission_id, id, title, brief, complexity, owned_globs_json, verify_cmd, offload, worker_json, verifier_json, head_sha, telemetry_json, synthetic_diff_json, lane_config_json, status, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)",
      );
      const rawGateById = new Map((gates || []).map((g) => [String(g?.id || "").trim(), g]));
      for (const l of resolved.lanes) {
        const raw = rawById.get(l.id) || {};
        const initialTel = normalizeLaneTelemetry(raw.telemetry || raw, l.worker, null, {});
        const laneCfg = extractPublicLaneConfig(l);
        const privLane = extractPrivateHoldoutFields(raw.ratchet || l.ratchet);
        if (privLane) savePrivateHoldout(m.id, `lane:${l.id}`, privLane);
        lStmt.run(
          m.id,
          l.id,
          l.title,
          l.brief,
          l.complexity,
          JSON.stringify(l.ownedGlobs),
          l.verifyCmd,
          l.offload,
          JSON.stringify(l.worker),
          JSON.stringify({ ...l.verifier, effectiveOffload: l.effectiveOffload }),
          raw.headSha || initialTel.headSha || null,
          JSON.stringify(initialTel),
          raw.syntheticDiff ? JSON.stringify(raw.syntheticDiff) : null,
          laneCfg ? JSON.stringify(laneCfg) : null,
          now,
        );
      }

      const gStmt = this.db.prepare("INSERT INTO gates(mission_id, id, title, cmd, offload, required, gate_config_json, status, updated_at) VALUES(?,?,?,?,?,?,?, 'pending', ?)");
      for (const g of check.normalized.gates) {
        const rawGate = rawGateById.get(g.id) || {};
        const gateCfg = extractPublicGateConfig(g);
        const privGate = extractPrivateHoldoutFields(rawGate.ratchet || g.ratchet);
        if (privGate) savePrivateHoldout(m.id, `gate:${g.id}`, privGate);
        gStmt.run(m.id, g.id, g.title, g.cmd, g.offload, g.required ? 1 : 0, gateCfg ? JSON.stringify(gateCfg) : null, now);
      }

      this.db
        .prepare("UPDATE missions SET routing_mode=?, active_harness=?, state='planned', freeze_commit=NULL, updated_at=? WHERE id=?")
        .run(nextMode, nextHarness, now, m.id);

      this.recordEvent(
        m.id,
        "coordinator",
        "topology_planned",
        {
          routingMode: nextMode,
          freeTierPolicy: resolved.freeTierPolicy,
          routingWarnings: resolved.routingWarnings || [],
          degradedAccounts: resolved.degradedAccounts || [],
          contractCount: check.normalized.sharedContracts.length,
          laneCount: resolved.lanes.length,
          gateCount: check.normalized.gates.length,
        },
        {
          replay: {
            version: REPLAY_VERSION,
            checkpoint: {
              mission: {
                id: m.id,
                state: "planned",
                routingMode: nextMode,
                activeHarness: nextHarness,
                freezeCommit: null,
              },
              contracts: Object.fromEntries(
                check.normalized.sharedContracts.map((c) => [
                  c.path,
                  { path: c.path, description: c.description || "", sha256: null, frozenAt: null },
                ]),
              ),
              lanes: Object.fromEntries(
                resolved.lanes.map((l) => {
                  const pubCfg = extractPublicLaneConfig(l);
                  return [
                    l.id,
                    {
                      id: l.id,
                      title: l.title,
                      complexity: l.complexity,
                      offload: l.offload,
                      ownedGlobs: l.ownedGlobs,
                      ...(pubCfg || {}),
                      verifyCmd: l.verifyCmd,
                      worker: l.worker,
                      verifier: { ...l.verifier, effectiveOffload: l.effectiveOffload },
                      status: "pending",
                      scopeOk: null,
                    },
                  ];
                }),
              ),
              gates: Object.fromEntries(
                check.normalized.gates.map((g) => {
                  const pubCfg = extractPublicGateConfig(g);
                  return [
                    g.id,
                    {
                      id: g.id,
                      title: g.title || g.id,
                      cmd: g.cmd,
                      offload: g.offload || "auto",
                      required: Boolean(g.required),
                      ...(pubCfg || {}),
                      status: "pending",
                      lastRun: null,
                    },
                  ];
                }),
              ),
            },
            changes: [],
            causes: [],
            receiptId: null,
          },
        },
      );
    });

    return {
      ok: true,
      errors: [],
      collisions: [],
      routing: {
        mode: resolved.mode,
        activeHarness: resolved.activeHarness,
        preferCloud: resolved.preferCloud,
        freeTierPolicy: resolved.freeTierPolicy,
        routingWarnings: resolved.routingWarnings || [],
        degradedAccounts: resolved.degradedAccounts || [],
      },
      routingWarnings: resolved.routingWarnings || [],
      degradedAccounts: resolved.degradedAccounts || [],
      mission: this.getMission(m.id),
    };
  }

  /** Lock HEAD commit and SHA-256 of every shared contract file before parallel execution. */
  freezeContracts(missionId, { allowDirtyContracts = false } = {}) {
    const m = this.requireMission(missionId);
    if (!["planned", "frozen"].includes(m.state)) {
      throw new Error(`Mission must be in "planned" state to freeze contracts (currently "${m.state}").`);
    }
    const commit = gitHead(m.repoRoot);
    const contractPaths = m.contracts.map((c) => normalizeRelPattern(c.path));

    if (!allowDirtyContracts && contractPaths.length > 0) {
      const dirty = gitDirtyFiles(m.repoRoot, contractPaths);
      if (dirty.length > 0) {
        throw new Error(`Shared contract files must be committed/clean before freeze: ${dirty.join(", ")}`);
      }
    }

    const now = iso();
    const hashes = [];
    for (const c of m.contracts) {
      const full = path.join(m.repoRoot, c.path);
      if (!existsSync(full)) {
        throw new Error(`Shared contract file missing on disk at freeze time: "${c.path}". Commit interfaces before spawning parallel lanes.`);
      }
      hashes.push({ path: c.path, sha256: sha256File(full) });
    }

    this.tx(() => {
      const stmt = this.db.prepare("UPDATE contracts SET sha256=?, frozen_at=? WHERE mission_id=? AND path=?");
      for (const h of hashes) stmt.run(h.sha256, now, m.id, h.path);
      this.db.prepare("UPDATE missions SET state='frozen', freeze_commit=?, updated_at=? WHERE id=?").run(commit, now, m.id);
      this.recordEvent(m.id, "coordinator", "contracts_frozen", { freezeCommit: commit, contracts: hashes });
    });

    return this.getMission(m.id);
  }

  setMissionState(missionId, state, detail = {}) {
    const m = this.requireMission(missionId);
    const now = iso();
    this.tx(() => {
      this.db.prepare("UPDATE missions SET state=?, updated_at=? WHERE id=?").run(state, now, m.id);
      this.recordEvent(m.id, "coordinator", `state_${state}`, detail);
    });
    return this.getMission(m.id);
  }

  setLaneWorktree(missionId, laneId, { worktreePath, branchName, status, headSha = undefined }) {
    const m = this.requireMission(missionId);
    const now = iso();
    const lane = m.lanes.find((l) => l.id === laneId);
    const nextTel = {
      ...(lane?.telemetry || {}),
      worktreePath,
      branch: branchName,
      ...(headSha !== undefined ? { headSha } : {}),
    };
    this.db
      .prepare(
        "UPDATE lanes SET worktree_path=?, branch_name=?, status=?, head_sha=COALESCE(?, head_sha), telemetry_json=?, updated_at=? WHERE mission_id=? AND id=?",
      )
      .run(worktreePath, branchName, status, headSha ?? null, JSON.stringify(nextTel), now, m.id, laneId);
    this.recordEvent(m.id, "coordinator", "lane_provisioned", { laneId, worktreePath, branchName, status });
  }

  updateLaneTelemetry(missionId, laneId, telemetry = {}) {
    const m = this.requireMission(missionId);
    const lane = m.lanes.find((l) => l.id === laneId);
    if (!lane) throw notFoundError(`Unknown lane "${laneId}" in mission "${m.id}".`);
    const merged = normalizeLaneTelemetry({ ...(lane.telemetry || {}), ...telemetry }, lane.worker, lane.lastVerify, {
      worktree_path: lane.worktreePath,
      branch_name: lane.branchName,
      head_sha: telemetry.headSha ?? lane.headSha,
    });
    const now = iso();
    this.db
      .prepare("UPDATE lanes SET head_sha=?, telemetry_json=?, updated_at=? WHERE mission_id=? AND id=?")
      .run(merged.headSha, JSON.stringify(merged), now, m.id, laneId);
    return this.getMission(m.id);
  }

  recordLaneVerification(
    missionId,
    laneId,
    { status, scopeOk, result = {}, telemetry = null, diff = null, inspection = null, contracts = null, receiptId = null },
  ) {
    const m = this.requireMission(missionId);
    const lane = m.lanes.find((l) => l.id === laneId);
    if (!lane) throw notFoundError(`Unknown lane "${laneId}" in mission "${m.id}".`);

    const now = iso();
    const rcptId = receiptId || result?.receiptId || `rcpt-${randomUUID().slice(0, 12)}`;
    const storedResult = { ...(result || {}), receiptId: rcptId };
    const mergedTel = normalizeLaneTelemetry(
      { ...(lane.telemetry || {}), ...(telemetry || {}) },
      lane.worker,
      storedResult,
      { worktree_path: lane.worktreePath, branch_name: lane.branchName, head_sha: telemetry?.headSha ?? storedResult.headSha ?? lane.headSha },
    );
    const headSha = mergedTel.headSha || null;
    const verifierActor =
      lane.verifier?.harness && lane.verifier?.model
        ? `${lane.verifier.harness}/${lane.verifier.model}`
        : "verifier";
    const metrics = {};
    if (mergedTel.durationMs !== null) metrics.durationMs = mergedTel.durationMs;
    if (mergedTel.tokensIn !== null) metrics.tokensIn = mergedTel.tokensIn;
    if (mergedTel.tokensOut !== null) metrics.tokensOut = mergedTel.tokensOut;
    if (mergedTel.costUsd !== null) metrics.costUsd = mergedTel.costUsd;

    this.tx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO receipts(
            id, mission_id, lane_id, kind, status, scope_ok, freeze_commit, head_sha,
            result_json, diff_json, inspection_json, contracts_json, telemetry_json, created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          rcptId,
          m.id,
          laneId,
          "lane_verify",
          status,
          scopeOk ? 1 : 0,
          m.freezeCommit || null,
          headSha,
          JSON.stringify(storedResult),
          diff ? JSON.stringify(diff) : null,
          inspection ? JSON.stringify(inspection) : null,
          JSON.stringify(contracts || diff?.contracts || []),
          JSON.stringify(mergedTel),
          now,
        );

      this.db
        .prepare(
          "UPDATE lanes SET status=?, scope_ok=?, last_verify_json=?, last_receipt_id=?, head_sha=?, telemetry_json=?, updated_at=? WHERE mission_id=? AND id=?",
        )
        .run(status, scopeOk ? 1 : 0, JSON.stringify(storedResult), rcptId, headSha, JSON.stringify(mergedTel), now, m.id, laneId);

      this.recordEvent(
        m.id,
        "verifier",
        "lane_verified",
        {
          laneId,
          status,
          scopeOk: Boolean(scopeOk),
          exitCode: storedResult.exitCode ?? null,
          violation: storedResult.violation || null,
          receiptId: rcptId,
        },
        {
          actor: verifierActor,
          laneId,
          receiptId: rcptId,
          metrics: Object.keys(metrics).length ? metrics : null,
        },
      );
    });
    return this.getMission(m.id);
  }

  getReceipt(missionIdOrReceiptId, maybeReceiptId) {
    const hasMissionScope = maybeReceiptId !== undefined;
    const receiptId = hasMissionScope ? maybeReceiptId : missionIdOrReceiptId;
    if (!receiptId) return null;
    let row;
    if (hasMissionScope) {
      const m = this.getMission(missionIdOrReceiptId);
      if (!m) return null;
      row = this.db.prepare("SELECT * FROM receipts WHERE id=? AND mission_id=?").get(receiptId, m.id);
    } else {
      row = this.db.prepare("SELECT * FROM receipts WHERE id=?").get(receiptId);
    }
    return row ? this.hydrateReceiptRow(row) : null;
  }

  recordGateResult(missionId, gateId, { status, result }) {
    const m = this.requireMission(missionId);
    const now = iso();
    this.tx(() => {
      this.db
        .prepare("UPDATE gates SET status=?, last_run_json=?, updated_at=? WHERE mission_id=? AND id=?")
        .run(status, JSON.stringify(result), now, m.id, gateId);
      this.recordEvent(
        m.id,
        "gate",
        "gate_finished",
        { gateId, status, exitCode: result.exitCode, machine: result.machine },
        {
          gateId,
          actor: result.machine ? `gate/${result.machine}` : "gate",
          metrics: Number.isFinite(result.durationMs) ? { durationMs: result.durationMs } : null,
        },
      );
    });
    return this.getMission(m.id);
  }

  listMissionEvents(missionId, { afterSeq, after, throughSeq, through, limit } = {}) {
    const mission = this.requireMission(missionId);
    const rawAfter = afterSeq ?? after ?? 0;
    const parsedAfter = rawAfter === null || rawAfter === undefined || rawAfter === "" ? 0 : Number(rawAfter);
    const safeAfter = Number.isFinite(parsedAfter) ? Math.max(0, Math.trunc(parsedAfter)) : 0;

    const rawThrough = throughSeq ?? through ?? null;
    const parsedThrough =
      rawThrough === null || rawThrough === undefined || rawThrough === "" ? null : Number(rawThrough);
    const safeThrough =
      parsedThrough !== null && Number.isFinite(parsedThrough) ? Math.max(0, Math.trunc(parsedThrough)) : null;

    const rawLimit =
      limit === undefined || limit === null || limit === "" ? EVENT_CAPS.defaultLimit : Number(limit);
    const clampedLimit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(EVENT_CAPS.maxLimit, Math.trunc(rawLimit)))
      : EVENT_CAPS.defaultLimit;

    const sql =
      safeThrough !== null
        ? "SELECT * FROM events WHERE mission_id=? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?"
        : "SELECT * FROM events WHERE mission_id=? AND seq > ? ORDER BY seq ASC LIMIT ?";
    const rows =
      safeThrough !== null
        ? this.db.prepare(sql).all(mission.id, safeAfter, safeThrough, clampedLimit + 1)
        : this.db.prepare(sql).all(mission.id, safeAfter, clampedLimit + 1);

    const hasMore = rows.length > clampedLimit;
    const pageRows = hasMore ? rows.slice(0, clampedLimit) : rows;
    const events = pageRows.map((row) => this.hydrateEventRow(row));
    const nextAfterSeq = events.length > 0 ? events[events.length - 1].seq : safeAfter;
    const latestSeq = this.#latestEventSeq(mission.id) ?? 0;

    return {
      schemaVersion: SCHEMA_VERSION,
      missionId: mission.id,
      afterSeq: safeAfter,
      throughSeq: safeThrough,
      limit: clampedLimit,
      nextAfterSeq,
      latestSeq,
      hasMore,
      events,
    };
  }

  listEventsAfter(missionId, afterSeq = 0, limit = EVENT_CAPS.defaultLimit) {
    if (typeof afterSeq === "object" && afterSeq !== null) {
      return this.listMissionEvents(missionId, afterSeq);
    }
    return this.listMissionEvents(missionId, { afterSeq, limit });
  }

  upsertShowcase(specOrOpts = {}, options = {}) {
    const spec =
      specOrOpts && Array.isArray(specOrOpts.lanes) && specOrOpts.fixtureVersion
        ? specOrOpts
        : buildShowcaseSpec(specOrOpts || options);
    const opts = specOrOpts && !Array.isArray(specOrOpts.lanes) ? specOrOpts : options;
    const slug = spec.slug || SHOWCASE_SLUG;

    const existing = this.db.prepare("SELECT id, fixture_version FROM missions WHERE slug=?").get(slug);
    if (existing && existing.fixture_version === spec.fixtureVersion && !opts?.reset && !opts?.force) {
      return { mission: this.getMission(existing.id), created: false, fixtureVersion: spec.fixtureVersion };
    }

    const missionId = existing?.id || spec.id || randomUUID();
    const created = !existing;
    let lastEmitted = null;

    this.tx(() => {
      if (existing) {
        this.db
          .prepare(
            "UPDATE missions SET title=?, goal=?, repo_root=?, routing_mode=?, active_harness=?, adhd_session_id=?, state=?, freeze_commit=?, fixture_version=?, updated_at=? WHERE id=?",
          )
          .run(
            spec.title,
            spec.goal,
            spec.repoRoot,
            spec.routingMode,
            spec.activeHarness,
            spec.adhdSessionId || null,
            spec.state,
            spec.freezeCommit || null,
            spec.fixtureVersion,
            spec.updatedAt || iso(),
            missionId,
          );
        this.db.prepare("DELETE FROM contracts WHERE mission_id=?").run(missionId);
        this.db.prepare("DELETE FROM lanes WHERE mission_id=?").run(missionId);
        this.db.prepare("DELETE FROM gates WHERE mission_id=?").run(missionId);
        this.db.prepare("DELETE FROM receipts WHERE mission_id=?").run(missionId);
        this.db.prepare("DELETE FROM events WHERE mission_id=?").run(missionId);
      } else {
        this.db
          .prepare(
            "INSERT INTO missions(id, slug, title, goal, repo_root, routing_mode, active_harness, adhd_session_id, state, freeze_commit, fixture_version, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            missionId,
            slug,
            spec.title,
            spec.goal,
            spec.repoRoot,
            spec.routingMode,
            spec.activeHarness,
            spec.adhdSessionId || null,
            spec.state,
            spec.freezeCommit || null,
            spec.fixtureVersion,
            spec.createdAt || iso(),
            spec.updatedAt || iso(),
          );
      }

      const cStmt = this.db.prepare(
        "INSERT INTO contracts(mission_id, path, description, sha256, frozen_at) VALUES(?,?,?,?,?)",
      );
      for (const c of spec.contracts || []) {
        cStmt.run(missionId, c.path, c.description || "", c.sha256 || null, c.frozenAt || null);
      }

      const lStmt = this.db.prepare(
        `INSERT INTO lanes(
          mission_id, id, title, brief, complexity, owned_globs_json, verify_cmd, offload,
          worker_json, verifier_json, worktree_path, branch_name, head_sha, status, scope_ok,
          last_verify_json, last_receipt_id, telemetry_json, synthetic_diff_json, lane_config_json, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const l of spec.lanes || []) {
        const tel = normalizeLaneTelemetry(l.telemetry || {}, l.worker, l.lastVerify, {
          worktree_path: l.worktreePath,
          branch_name: l.branchName,
          head_sha: l.headSha,
        });
        const laneCfg = extractPublicLaneConfig(l);
        lStmt.run(
          missionId,
          l.id,
          l.title,
          l.brief || "",
          l.complexity || "standard",
          JSON.stringify(l.ownedGlobs || []),
          l.verifyCmd,
          l.offload || "auto",
          JSON.stringify(l.worker || {}),
          JSON.stringify(l.verifier || {}),
          l.worktreePath || null,
          l.branchName || null,
          l.headSha || null,
          l.status || "pending",
          l.scopeOk === null || l.scopeOk === undefined ? null : l.scopeOk ? 1 : 0,
          l.lastVerify ? JSON.stringify(l.lastVerify) : null,
          l.lastReceiptId || l.lastVerify?.receiptId || null,
          JSON.stringify(tel),
          l.syntheticDiff ? JSON.stringify(l.syntheticDiff) : null,
          laneCfg ? JSON.stringify(laneCfg) : null,
          spec.updatedAt || iso(),
        );
      }

      const gStmt = this.db.prepare(
        "INSERT INTO gates(mission_id, id, title, cmd, offload, required, status, last_run_json, gate_config_json, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      for (const g of spec.gates || []) {
        const gateCfg = extractPublicGateConfig(g);
        gStmt.run(
          missionId,
          g.id,
          g.title || g.id,
          g.cmd,
          g.offload || "auto",
          g.required === false ? 0 : 1,
          g.status || "pending",
          g.lastRun ? JSON.stringify(g.lastRun) : null,
          gateCfg ? JSON.stringify(gateCfg) : null,
          spec.updatedAt || iso(),
        );
      }

      const rStmt = this.db.prepare(
        `INSERT INTO receipts(
          id, mission_id, lane_id, kind, status, scope_ok, freeze_commit, head_sha,
          result_json, diff_json, inspection_json, contracts_json, telemetry_json, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of spec.receipts || []) {
        rStmt.run(
          r.id,
          missionId,
          r.laneId,
          r.kind || "lane_verify",
          r.status,
          r.scopeOk ? 1 : 0,
          r.freezeCommit || spec.freezeCommit || null,
          r.headSha || null,
          JSON.stringify(r.result || {}),
          r.diff ? JSON.stringify(r.diff) : null,
          r.inspection ? JSON.stringify(r.inspection) : null,
          JSON.stringify(r.contracts || []),
          JSON.stringify(r.telemetry || {}),
          r.createdAt || iso(),
        );
      }

      const seqByKey = new Map();
      const evStmt = this.db.prepare(
        `INSERT INTO events(
          mission_id, role, type, payload_json, stage, lane_id, gate_id, actor, summary,
          metrics_json, receipt_id, causes_json, replay_json, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const ev of spec.events || []) {
        const causes = (ev.causeKeys || []).map((k) => seqByKey.get(k)).filter((x) => Number.isInteger(x));
        const baseReplay = ev.replay
          ? { ...ev.replay, version: REPLAY_VERSION, causes, receiptId: ev.receiptId ?? ev.replay.receiptId ?? null }
          : buildDefaultReplay(ev.type, missionId, ev.payload || {}, causes, ev.receiptId || null);
        if (baseReplay?.checkpoint?.mission) {
          baseReplay.checkpoint.mission.id = missionId;
        }
        const info = evStmt.run(
          missionId,
          ev.role || "coordinator",
          ev.type,
          JSON.stringify(ev.payload || {}),
          ev.stage || inferStageFromType(ev.type),
          ev.laneId ?? null,
          ev.gateId ?? null,
          ev.actor || ev.role || "coordinator",
          ev.summary || buildEventSummary(ev.type, ev.role, ev.payload),
          ev.metrics ? JSON.stringify(ev.metrics) : null,
          ev.receiptId ?? null,
          JSON.stringify(causes),
          baseReplay ? JSON.stringify(baseReplay) : null,
          ev.createdAt || iso(),
        );
        const seq = Number(info.lastInsertRowid);
        if (ev.key) seqByKey.set(ev.key, seq);
        lastEmitted = { seq, missionId, type: ev.type, createdAt: ev.createdAt || iso() };
      }
    });

    if (lastEmitted) this.emit("change", lastEmitted);
    return { mission: this.getMission(missionId), created, fixtureVersion: spec.fixtureVersion };
  }

  listMissions() {
    const rows = this.db.prepare("SELECT * FROM missions ORDER BY updated_at DESC").all();
    return rows.map((r) => this.hydrateMissionRow(r, { compact: true }));
  }

  requireMission(missionId) {
    const m = this.getMission(missionId);
    if (!m) throw notFoundError(`Unknown mission "${missionId}".`);
    return m;
  }

  getMission(missionId) {
    const row = this.db.prepare("SELECT * FROM missions WHERE id=? OR slug=?").get(missionId, missionId);
    return row ? this.hydrateMissionRow(row, { compact: false }) : null;
  }

  hydrateMissionRow(r, { compact }) {
    const contracts = this.db
      .prepare("SELECT * FROM contracts WHERE mission_id=? ORDER BY path")
      .all(r.id)
      .map((c) => ({ ...c, frozenAt: c.frozen_at }));

    const lanes = this.db
      .prepare("SELECT * FROM lanes WHERE mission_id=? ORDER BY rowid")
      .all(r.id)
      .map((l) => {
        const worker = safeJsonParse(l.worker_json, {});
        const verifier = safeJsonParse(l.verifier_json, {});
        const lastVerify = safeJsonParse(l.last_verify_json, null);
        const rawTel = safeJsonParse(l.telemetry_json, {});
        const telemetry = normalizeLaneTelemetry(rawTel, worker, lastVerify, l);
        const laneCfg = safeJsonParse(l.lane_config_json, null);
        const lane = {
          id: l.id,
          title: l.title,
          brief: l.brief,
          complexity: l.complexity,
          ownedGlobs: safeJsonParse(l.owned_globs_json, []),
          ...(Array.isArray(laneCfg?.ownedRegions) ? { ownedRegions: laneCfg.ownedRegions } : {}),
          ...(Array.isArray(laneCfg?.ignoreUntrackedGlobs) ? { ignoreUntrackedGlobs: laneCfg.ignoreUntrackedGlobs } : {}),
          ...(Array.isArray(laneCfg?.readOnlyMounts) ? { readOnlyMounts: laneCfg.readOnlyMounts } : {}),
          ...(laneCfg?.ratchet ? { ratchet: toPublicRatchetSpec(laneCfg.ratchet) } : {}),
          ...(laneCfg?.cloudDispatch ? { cloudDispatch: laneCfg.cloudDispatch } : {}),
          verifyCmd: l.verify_cmd,
          offload: l.offload,
          worker,
          verifier,
          worktreePath: l.worktree_path,
          branchName: l.branch_name,
          branch: telemetry.branch,
          headSha: telemetry.headSha,
          status: l.status,
          scopeOk: l.scope_ok === null ? null : Boolean(l.scope_ok),
          lastVerify,
          lastReceiptId: l.last_receipt_id ?? lastVerify?.receiptId ?? null,
          model: telemetry.model,
          harness: telemetry.harness,
          durationMs: telemetry.durationMs,
          tokensIn: telemetry.tokensIn,
          tokensOut: telemetry.tokensOut,
          costUsd: telemetry.costUsd,
          filesChanged: telemetry.filesChanged,
          telemetry,
          updatedAt: l.updated_at,
        };
        if (!compact && l.synthetic_diff_json) {
          lane.syntheticDiff = safeJsonParse(l.synthetic_diff_json, null);
        }
        return lane;
      });

    const gates = this.db
      .prepare("SELECT * FROM gates WHERE mission_id=? ORDER BY rowid")
      .all(r.id)
      .map((g) => {
        const gateCfg = safeJsonParse(g.gate_config_json, null);
        return {
          id: g.id,
          title: g.title,
          cmd: g.cmd,
          offload: g.offload,
          required: Boolean(g.required),
          ...(gateCfg?.ratchet ? { ratchet: toPublicRatchetSpec(gateCfg.ratchet) } : {}),
          status: g.status,
          lastRun: safeJsonParse(g.last_run_json, null),
          updatedAt: g.updated_at,
        };
      });

    const events = compact
      ? []
      : this.db
          .prepare("SELECT * FROM events WHERE mission_id=? ORDER BY seq DESC LIMIT 80")
          .all(r.id)
          .reverse()
          .map((e) => this.hydrateEventRow(e));

    const eventCount = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE mission_id=?").get(r.id)?.n || 0;
    const latestRouteRow = this.db
      .prepare("SELECT payload_json FROM events WHERE mission_id=? AND type IN ('topology_planned', 'mission_settings_updated') ORDER BY seq DESC LIMIT 1")
      .get(r.id);
    const latestRoutePayload = safeJsonParse(latestRouteRow?.payload_json, null);
    const routingWarnings = Array.isArray(latestRoutePayload?.routingWarnings) ? latestRoutePayload.routingWarnings : [];
    const degradedAccounts = Array.isArray(latestRoutePayload?.degradedAccounts) ? latestRoutePayload.degradedAccounts : [];

    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      goal: r.goal,
      repoRoot: r.repo_root,
      routingMode: r.routing_mode,
      activeHarness: r.active_harness,
      adhdSessionId: r.adhd_session_id,
      state: r.state,
      freezeCommit: r.freeze_commit,
      fixtureVersion: r.fixture_version || null,
      isShowcase: r.slug === SHOWCASE_SLUG || Boolean(r.fixture_version),
      replayVersion: REPLAY_VERSION,
      eventCount,
      routingWarnings,
      degradedAccounts,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      contracts,
      lanes,
      gates,
      events,
    };
  }

  getRsiKv(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM rsi_kv WHERE key=?").get(key);
    return row ? safeJsonParse(row.value_json, fallback) : fallback;
  }

  setRsiKv(key, value) {
    this.db
      .prepare(
        "INSERT INTO rsi_kv(key, value_json, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(value), iso());
  }

  #hydrateRsiCandidateRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      category: row.category,
      targetRepo: row.target_repo,
      tier: row.tier,
      title: row.title,
      rationale: row.rationale,
      evidenceRefs: safeJsonParse(row.evidence_refs_json, []),
      status: row.status,
      baselineScore: row.baseline_score ?? null,
      candidateScore: row.candidate_score ?? null,
      regressions: Number(row.regressions ?? 0),
      touchesHarness: Boolean(row.touches_harness),
      humanApproved: Boolean(row.human_approved),
      branchName: row.branch_name || null,
      prePromoteCommit: row.pre_promote_commit || null,
      proposer: safeJsonParse(row.proposer_json, null),
      audit: safeJsonParse(row.audit_json, null),
      metadata: safeJsonParse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRsiCandidates() {
    return this.db
      .prepare("SELECT * FROM rsi_candidates ORDER BY updated_at DESC, rowid ASC")
      .all()
      .map((r) => this.#hydrateRsiCandidateRow(r));
  }

  getRsiCandidate(id) {
    const row = this.db.prepare("SELECT * FROM rsi_candidates WHERE id=?").get(id);
    return this.#hydrateRsiCandidateRow(row);
  }

  upsertRsiCandidate(c) {
    const now = iso();
    this.db
      .prepare(
        `INSERT INTO rsi_candidates(
          id, category, target_repo, tier, title, rationale, evidence_refs_json,
          status, baseline_score, candidate_score, regressions, touches_harness, human_approved,
          branch_name, pre_promote_commit, proposer_json, audit_json, metadata_json, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          category=excluded.category,
          target_repo=excluded.target_repo,
          tier=excluded.tier,
          title=excluded.title,
          rationale=excluded.rationale,
          evidence_refs_json=excluded.evidence_refs_json,
          status=excluded.status,
          baseline_score=excluded.baseline_score,
          candidate_score=excluded.candidate_score,
          regressions=excluded.regressions,
          touches_harness=excluded.touches_harness,
          human_approved=excluded.human_approved,
          branch_name=excluded.branch_name,
          pre_promote_commit=excluded.pre_promote_commit,
          proposer_json=excluded.proposer_json,
          audit_json=excluded.audit_json,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at`,
      )
      .run(
        c.id,
        c.category,
        c.targetRepo,
        c.tier,
        c.title,
        c.rationale,
        JSON.stringify(c.evidenceRefs || []),
        c.status || "proposed",
        c.baselineScore ?? null,
        c.candidateScore ?? null,
        Number(c.regressions ?? 0),
        c.touchesHarness ? 1 : 0,
        c.humanApproved ? 1 : 0,
        c.branchName || null,
        c.prePromoteCommit || null,
        c.proposer ? JSON.stringify(c.proposer) : null,
        c.audit ? JSON.stringify(c.audit) : null,
        JSON.stringify(c.metadata || {}),
        c.createdAt || now,
        c.updatedAt || now,
      );
    return this.getRsiCandidate(c.id);
  }

  deleteRsiCandidate(id) {
    return this.db.prepare("DELETE FROM rsi_candidates WHERE id=?").run(id).changes > 0;
  }

  insertRsiRun(run) {
    const id = run.id || `rsi-run-${randomUUID().slice(0, 12)}`;
    const now = run.createdAt || iso();
    this.db
      .prepare(
        `INSERT INTO rsi_runs(
          id, candidate_id, kind, baseline_score, candidate_score, regressions,
          touches_harness, metrics_json, audit_json, commit_sha, note, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        run.candidateId,
        run.kind,
        run.baselineScore ?? null,
        run.candidateScore ?? null,
        Number(run.regressions ?? 0),
        run.touchesHarness ? 1 : 0,
        JSON.stringify(run.metrics || {}),
        run.audit ? JSON.stringify(run.audit) : null,
        run.commitSha || null,
        run.note || null,
        now,
      );
    return { ...run, id, createdAt: now };
  }

  listRsiRuns(candidateId = null, limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
    const rows = candidateId
      ? this.db.prepare("SELECT * FROM rsi_runs WHERE candidate_id=? ORDER BY created_at DESC LIMIT ?").all(candidateId, safeLimit)
      : this.db.prepare("SELECT * FROM rsi_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit);
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidate_id,
      kind: r.kind,
      baselineScore: r.baseline_score ?? null,
      candidateScore: r.candidate_score ?? null,
      regressions: Number(r.regressions ?? 0),
      touchesHarness: Boolean(r.touches_harness),
      metrics: safeJsonParse(r.metrics_json, {}),
      audit: safeJsonParse(r.audit_json, null),
      commitSha: r.commit_sha || null,
      note: r.note || null,
      createdAt: r.created_at,
    }));
  }
}
