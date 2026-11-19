import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAdhdSessions, readAdhdSessionDetail, buildEscalationPacket, submitToAdhdLoopback, planPodTournament } from "./adhd-bridge.mjs";
import { mergeTeamBriefIntoPool, readAccountPool, readTeamBrief, selectAssistantForRole } from "./assistants.mjs";
import { seedShowcaseMission } from "./demo.mjs";
import { collectLaneDiff } from "./diff.mjs";
import { install, manualConfig, HARNESSES } from "./install.mjs";
import { validateTopology } from "./partition.mjs";
import { detectFleet, resolveMissionRouting, ROUTING_MODES } from "./routing.mjs";
import {
  getRsiOverview,
  getRsiSummary,
  promoteRsiCandidate,
  rollbackRsiCandidate,
  runRsiVerificationCycle,
  scanRsiOpportunities,
  submitRsiAuditReceipt,
} from "./rsi.mjs";
import {
  CSP_HEADER,
  EVENT_CAPS,
  REPLAY_VERSION,
  SCHEMA_VERSION,
  STATIC_MANIFEST_BY_URL,
  resolveAllowedStaticAsset,
} from "./ui-contracts.mjs";
import { VERSION } from "./version.mjs";
import {
  provisionWorktrees,
  auditAndVerifyLane,
  runMissionGate,
  cleanupWorktrees,
  inspectLaneWorktree,
} from "./worktree.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SSE_HEARTBEAT_MS = 15_000;

function parseStrictBool(v, fallback = false) {
  if (v === undefined) return fallback;
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0" || v === "" || v === null) return false;
  return Boolean(v);
}

async function tryImportOptional(relPath) {
  try {
    return await import(relPath);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

export function loadOrCreateToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const tokPath = path.join(dataDir, "token");
  if (!existsSync(tokPath)) {
    writeFileSync(tokPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  return readFileSync(tokPath, "utf8").trim();
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p >= start + 30) return reject(new Error(`No free port between ${start} and ${start + 29}.`));
      const s = createServer();
      s.once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

function mimeTypeForAsset(asset) {
  const ext = path.extname(asset.repoRelPath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  return asset.contentType || "application/octet-stream";
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const ch of req) {
    bytes += ch.length;
    if (bytes > 512_000) {
      const err = new Error("Request body too large.");
      err.status = 413;
      throw err;
    }
    chunks.push(ch);
  }
  const txt = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  if (!txt.trim()) return {};
  const parsed = JSON.parse(txt);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON request body must be an object.");
  }
  return parsed;
}

export async function startStudioServer(store, { port = 7878, fixedPort = false, fleetOverride } = {}) {
  const requestedPort = port === 0 ? 0 : fixedPort ? port : await freePort(port);
  const tok = loadOrCreateToken(store.dataDir);
  let actualPort = requestedPort;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  const sseClients = new Map(); // res -> timer

  const onStoreChange = (ev) => {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const [res, timer] of sseClients) {
      try {
        res.write(frame);
      } catch {
        clearInterval(timer);
        sseClients.delete(res);
      }
    }
  };
  store.on("change", onStoreChange);

  const server = createServer(async (req, res) => {
    const send = (status, body, contentType = "application/json; charset=utf-8") => {
      res.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": CSP_HEADER,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    try {
      const host = String(req.headers.host || "").toLowerCase();
      if (!allowedHosts.has(host)) return send(403, { error: "Origin/host not permitted." });

      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(String(origin).toLowerCase())) {
        return send(403, { error: "Cross-site origin refused." });
      }
      const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      if (fetchSite === "cross-site") {
        return send(403, { error: "Cross-site browser request refused." });
      }

      const url = new URL(req.url || "/", `http://${host}`);

      // Public static assets strictly allowlisted via STATIC_ASSET_MANIFEST (holds NO token).
      if (req.method === "GET" && STATIC_MANIFEST_BY_URL.has(url.pathname)) {
        const asset = resolveAllowedStaticAsset(REPO_ROOT, url.pathname);
        if (!asset || !existsSync(asset.absPath)) {
          return send(404, { error: `Static asset not available: ${url.pathname}` });
        }
        return send(200, readFileSync(asset.absPath, "utf8"), mimeTypeForAsset(asset));
      }

      // Authenticated API + SSE routes
      const suppliedTok = req.headers["x-overdrive-token"] || url.searchParams.get("token");
      if (!sameSecret(suppliedTok, tok)) {
        return send(403, { error: "Missing or invalid X-Overdrive-Token." });
      }

      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": CSP_HEADER,
        });
        const missions = store.listMissions();
        res.write(
          `data: ${JSON.stringify({
            type: "connected",
            seq: 0,
            version: VERSION,
            replayVersion: REPLAY_VERSION,
            missionCount: missions.length,
          })}\n\n`,
        );
        const timer = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            clearInterval(timer);
            sseClients.delete(res);
          }
        }, SSE_HEARTBEAT_MS);
        timer.unref?.();
        sseClients.set(res, timer);
        req.on("close", () => {
          clearInterval(timer);
          sseClients.delete(res);
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const fleet = fleetOverride || detectFleet();
        const missions = store.listMissions();
        const activeId = url.searchParams.get("missionId") || missions[0]?.id || null;
        const activeMission = activeId ? store.getMission(activeId) : null;
        const adhd = listAdhdSessions({ limit: 15 });
        const rsi = getRsiSummary(store);
        const routingWarnings = Array.from(
          new Set([...(fleet?.routingWarnings || []), ...(activeMission?.routingWarnings || [])].filter(Boolean)),
        );
        const degradedById = new Map();
        for (const item of [...(fleet?.degradedAccounts || []), ...(activeMission?.degradedAccounts || [])]) {
          if (item && item.accountId && !degradedById.has(item.accountId)) {
            degradedById.set(item.accountId, item);
          }
        }
        return send(200, {
          schemaVersion: SCHEMA_VERSION,
          version: VERSION,
          replayVersion: REPLAY_VERSION,
          dataDir: store.dataDir,
          fleet,
          routingWarnings,
          degradedAccounts: [...degradedById.values()],
          harnessesMeta: Object.keys(HARNESSES).map((id) => ({ id, name: HARNESSES[id].name })),
          manualConfig: manualConfig(),
          missions,
          activeMission,
          adhd,
          rsi,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/rsi/overview") {
        return send(200, getRsiOverview(store, { repoRoot: REPO_ROOT }));
      }

      if (req.method === "GET" && url.pathname === "/api/assistants") {
        const sinceParam = url.searchParams.get("since");
        const maxAgeParam = url.searchParams.get("maxAgeSeconds");
        const maxUsageParam = url.searchParams.get("maxUsagePct");
        const poolOpts = {
          ...(maxAgeParam !== null && Number.isFinite(Number(maxAgeParam)) ? { maxAgeSeconds: Number(maxAgeParam) } : {}),
          ...(maxUsageParam !== null && Number.isFinite(Number(maxUsageParam)) ? { maxUsagePct: Number(maxUsageParam) } : {}),
        };
        const rawPool = readAccountPool(poolOpts);
        const brief = readTeamBrief({
          ...(sinceParam !== null && Number.isFinite(Number(sinceParam)) ? { since: Number(sinceParam) } : {}),
        });
        const pool = mergeTeamBriefIntoPool(rawPool, brief, poolOpts);
        const role = url.searchParams.get("role") || "research";
        const selection = selectAssistantForRole(role, { pool, teamBrief: brief, ...poolOpts });
        return send(200, { schemaVersion: SCHEMA_VERSION, ok: true, role, brief, pool, selection });
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/adhd/")) {
        const sid = decodeURIComponent(url.pathname.slice("/api/adhd/".length));
        const detail = readAdhdSessionDetail(sid);
        return detail ? send(200, detail) : send(404, { error: "ADHD session not found" });
      }

      if (req.method === "GET") {
        const evMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/events$/);
        if (evMatch) {
          const missionId = decodeURIComponent(evMatch[1]);
          const afterSeq = url.searchParams.get("after") ?? url.searchParams.get("afterSeq") ?? "0";
          const throughSeq = url.searchParams.get("through") ?? url.searchParams.get("throughSeq");
          const limit = url.searchParams.get("limit") ?? String(EVENT_CAPS.defaultLimit);
          return send(200, store.listMissionEvents(missionId, { afterSeq, throughSeq, limit }));
        }

        const diffMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/lanes\/([^/]+)\/diff$/);
        if (diffMatch) {
          const missionId = decodeURIComponent(diffMatch[1]);
          const laneId = decodeURIComponent(diffMatch[2]);
          const receiptId = url.searchParams.get("receipt") ?? url.searchParams.get("receiptId");
          return send(200, collectLaneDiff(store, missionId, laneId, { receiptId }));
        }

        const inspMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/lanes\/([^/]+)\/inspection$/);
        if (inspMatch) {
          const missionId = decodeURIComponent(inspMatch[1]);
          const laneId = decodeURIComponent(inspMatch[2]);
          const receiptId = url.searchParams.get("receipt") ?? url.searchParams.get("receiptId");
          return send(200, inspectLaneWorktree(store, missionId, laneId, { receiptId }));
        }

        return send(404, { error: "Not found" });
      }

      if (req.method !== "POST") return send(404, { error: "Not found" });

      const body = await readJsonBody(req);

      if (url.pathname === "/api/demo/seed") {
        const out = seedShowcaseMission(store, body);
        return send(200, out);
      }

      if (url.pathname === "/api/missions") {
        const routingMode = body.routingMode || "single-harness";
        if (!ROUTING_MODES.includes(routingMode)) {
          return send(400, { ok: false, error: `Invalid routingMode "${routingMode}".` });
        }
        const activeHarness = body.activeHarness || "antigravity";
        const hasTopology = body.lanes !== undefined || body.topology !== undefined;
        let topology = null;
        if (hasTopology) {
          topology = {
            sharedContracts: body.topology?.sharedContracts ?? body.sharedContracts ?? [],
            lanes: body.topology?.lanes ?? body.lanes,
            gates: body.topology?.gates ?? body.gates ?? [],
          };
          const check = validateTopology(topology);
          if (!check.ok) {
            return send(400, {
              ok: false,
              error: check.errors[0] || check.collisions[0]?.message || "Invalid topology.",
              errors: check.errors,
              collisions: check.collisions,
            });
          }
          // Pre-validate routing policy before creating the mission row.
          resolveMissionRouting({ routingMode, activeHarness }, check.normalized.lanes, fleetOverride || detectFleet());
        }

        let mission = store.createMission({
          title: body.title,
          goal: body.goal,
          repoRoot: body.repoRoot,
          routingMode,
          activeHarness,
          adhdSessionId: body.adhdSessionId ?? null,
        });
        if (hasTopology) {
          const planned = store.planMission(mission.id, {
            ...topology,
            routingMode,
            activeHarness,
            fleet: fleetOverride,
          });
          if (!planned.ok) {
            return send(400, planned);
          }
          mission = planned.mission;
        }
        return send(200, { ok: true, mission });
      }

      if (url.pathname === "/api/install/preview") {
        const out = await install({ dryRun: true, harnesses: Array.isArray(body.harnesses) ? body.harnesses : [] });
        return send(200, { ok: true, results: out });
      }

      if (url.pathname === "/api/rsi/scan") {
        const out = await scanRsiOpportunities(store, {
          intentionsOpts: body.intentionsOpts || {
            ...(body.ledgerPath !== undefined ? { ledgerPath: body.ledgerPath } : {}),
            ...(body.memoryPath !== undefined ? { memoryPath: body.memoryPath } : {}),
            ...(body.driftPath !== undefined ? { driftPath: body.driftPath } : {}),
            ...(body.arpdDir !== undefined ? { arpdDir: body.arpdDir } : {}),
            ...(body.now !== undefined ? { now: body.now } : {}),
          },
          benchmarkRoot: body.benchmarkRoot || body.repoRoot || REPO_ROOT,
          fleet: body.fleet || fleetOverride,
          repoRoot: body.repoRoot || REPO_ROOT,
          missionId: body.missionId || null,
        });
        return send(200, out);
      }

      if (url.pathname === "/api/adhd/pod-plan") {
        const plan = planPodTournament({
          ...(body.goal !== undefined ? { goal: body.goal } : {}),
          ...(body.contextSummary !== undefined ? { contextSummary: body.contextSummary } : {}),
          ...(Number.isFinite(body.totalThinkers) ? { totalThinkers: Math.trunc(body.totalThinkers) } : {}),
          ...(Number.isFinite(body.podSize) ? { podSize: Math.trunc(body.podSize) } : {}),
          ...(body.activeHarness !== undefined ? { activeHarness: body.activeHarness } : {}),
          fleet: body.fleet || fleetOverride || detectFleet(),
        });
        return send(200, { ok: true, plan });
      }

      if (url.pathname === "/api/rsi/cycle") {
        if (!body.candidateId) {
          return send(400, { ok: false, error: "candidateId is required." });
        }
        const out = await runRsiVerificationCycle(store, body.candidateId, {
          worktreeRoot: body.worktreeRoot || REPO_ROOT,
          touchesFiles: Array.isArray(body.touchesFiles) ? body.touchesFiles : [],
          proposerFamily: body.proposerFamily || null,
          auditorFamily: body.auditorFamily || null,
          auditorModel: body.auditorModel || null,
          runCrossFamilyAudit: parseStrictBool(body.runCrossFamilyAudit, false),
          missionId: body.missionId || null,
        });
        return send(200, out);
      }

      const rsiAuditMatch = url.pathname.match(/^\/api\/rsi\/candidates\/([^/]+)\/audit$/);
      if (rsiAuditMatch) {
        const candidateId = decodeURIComponent(rsiAuditMatch[1]);
        const out = await submitRsiAuditReceipt(store, candidateId, {
          auditorFamily: body.auditorFamily,
          auditorModel: body.auditorModel,
          verdict: body.verdict,
          notes: body.notes || "",
          receiptRef: body.receiptRef || null,
          modelExecuted: parseStrictBool(body.modelExecuted, true),
          ...(body.auditKind ? { auditKind: body.auditKind } : {}),
          missionId: body.missionId || null,
        });
        return send(200, out);
      }

      const rsiPromoteMatch = url.pathname.match(/^\/api\/rsi\/candidates\/([^/]+)\/promote$/);
      if (rsiPromoteMatch) {
        const candidateId = decodeURIComponent(rsiPromoteMatch[1]);
        const out = await promoteRsiCandidate(store, candidateId, {
          humanApproved: parseStrictBool(body.humanApproved, false),
          repoRoot: body.repoRoot || REPO_ROOT,
          prePromoteCommit: body.prePromoteCommit || null,
          applyGitMerge: parseStrictBool(body.applyGitMerge, false),
          sourceBranch: body.sourceBranch || null,
          missionId: body.missionId || null,
        });
        return send(200, out);
      }

      const rsiRollbackMatch = url.pathname.match(/^\/api\/rsi\/candidates\/([^/]+)\/rollback$/);
      if (rsiRollbackMatch) {
        const candidateId = decodeURIComponent(rsiRollbackMatch[1]);
        const out = await rollbackRsiCandidate(store, candidateId, {
          repoRoot: body.repoRoot || null,
          applyGitReset: parseStrictBool(body.applyGitReset, false),
          missionId: body.missionId || null,
        });
        return send(200, out);
      }

      const m = url.pathname.match(/^\/api\/missions\/([^/]+)\/([a-z-]+)$/);
      if (!m) return send(404, { error: "Unknown API route" });
      const missionId = decodeURIComponent(m[1]);
      const action = m[2];

      if (action === "settings") {
        const mission = store.updateMissionSettings(missionId, { ...body, fleet: fleetOverride });
        return send(200, { ok: true, mission });
      }
      if (action === "validate") {
        const existing = store.requireMission(missionId);
        const check = validateTopology(body);
        if (!check.ok) return send(200, { ok: false, errors: check.errors, collisions: check.collisions });
        const routing = resolveMissionRouting(
          { routingMode: body.routingMode || existing.routingMode, activeHarness: body.activeHarness || existing.activeHarness },
          check.normalized.lanes,
          fleetOverride || detectFleet(),
        );
        return send(200, { ok: true, errors: [], collisions: [], normalized: check.normalized, routing });
      }
      if (action === "plan") {
        const out = store.planMission(missionId, { ...body, fleet: fleetOverride });
        return send(out.ok ? 200 : 400, out);
      }
      if (action === "freeze") {
        let mission = store.freezeContracts(missionId, { allowDirtyContracts: parseStrictBool(body.allowDirtyContracts, false) });
        let briefs = {};
        if (body.provisionWorktrees !== false) {
          const prov = provisionWorktrees(store, mission.id);
          mission = prov.mission;
          briefs = prov.briefs;
        }
        return send(200, { ok: true, mission, briefs });
      }
      if (action === "verify-lane") {
        const out = auditAndVerifyLane(store, missionId, body.laneId, {
          runCmd: body.runCmd !== false,
          useAipc: parseStrictBool(body.useAipc, false),
        });
        return send(200, { ok: true, ...out });
      }
      if (action === "run-gate") {
        const out = runMissionGate(store, missionId, body.gateId, { cleanupAfterPass: parseStrictBool(body.cleanupWorktrees, false) });
        return send(200, { ok: true, ...out });
      }
      if (action === "escalate") {
        const mission = store.requireMission(missionId);
        const packet = buildEscalationPacket(mission, body);
        let posted = null;
        if (body.adhdOrigin && mission.adhdSessionId) {
          posted = await submitToAdhdLoopback(body.adhdOrigin, mission.adhdSessionId, packet);
        }
        const updated = store.setMissionState(mission.id, "escalated", {
          laneId: body.laneId || null,
          gateId: body.gateId || null,
          requestId: packet.requestId,
        });
        return send(200, { ok: true, packet, posted, mission: updated });
      }
      if (action === "cleanup") {
        const removed = cleanupWorktrees(store, missionId);
        return send(200, { ok: true, removed, mission: store.getMission(missionId) });
      }
      if (action === "integrate") {
        const mod = await tryImportOptional("./integrate.mjs");
        const fn = mod?.integrateMission;
        if (!fn) {
          return send(501, { ok: false, error: "Integration module (src/integrate.mjs) is not available." });
        }
        const out = await fn(store, missionId, {
          ...(Array.isArray(body.laneIds) ? { laneIds: body.laneIds } : {}),
          ...(body.gateId ? { gateId: body.gateId } : {}),
          cleanupWorktrees: parseStrictBool(body.cleanupWorktrees, false),
          runGates: parseStrictBool(body.runGates, true),
          runHoldouts: parseStrictBool(body.runHoldouts, true),
          promoteToRepoRoot: parseStrictBool(body.promoteToRepoRoot, true),
          ...(Array.isArray(body.ignoreUntrackedGlobs) ? { ignoreUntrackedGlobs: body.ignoreUntrackedGlobs } : {}),
          ...(Number.isFinite(body.timeoutMs) ? { timeoutMs: body.timeoutMs } : {}),
        });
        return send(out?.ok === false ? 400 : 200, out);
      }
      if (action === "ingest-patch") {
        const mod = await tryImportOptional("./cloud-fleet.mjs");
        const fn = mod?.ingestCloudArtifact;
        if (!fn) {
          return send(501, { ok: false, error: "Cloud patch ingest module is not available." });
        }
        if (!body.laneId || typeof body.laneId !== "string") {
          return send(400, { ok: false, error: "ingest-patch requires laneId." });
        }
        const ingested = await fn(store, missionId, body.laneId, {
          branchRef: body.branchRef,
          patchPath: body.patchPath,
          patchText: body.patchText,
          expectedSha256: body.expectedSha256,
          remote: body.remote,
        });
        if (ingested?.ok !== false && parseStrictBool(body.runVerify, false)) {
          const verifyOut = auditAndVerifyLane(store, missionId, body.laneId, {
            runCmd: body.runCmd !== undefined ? parseStrictBool(body.runCmd, true) : true,
            ...(Number.isFinite(body.timeoutMs) ? { timeoutMs: body.timeoutMs } : {}),
          });
          return send(verifyOut?.result?.ok === false ? 400 : 200, {
            ...ingested,
            verify: verifyOut.result,
            mission: verifyOut.mission,
          });
        }
        return send(ingested?.ok === false ? 400 : 200, ingested);
      }
      if (action === "cloud-spawn") {
        const mod = await tryImportOptional("./cloud-fleet.mjs");
        const fn = mod?.dispatchCloudWorker;
        if (!fn) {
          return send(501, { ok: false, error: "Cloud fleet module (src/cloud-fleet.mjs) is not available." });
        }
        if (!body.laneId || typeof body.laneId !== "string") {
          return send(400, { ok: false, error: "cloud-spawn requires laneId." });
        }
        const out = await fn(store, missionId, body.laneId, {
          provider: body.provider,
          branchName: body.branchName,
          outputBranch: body.outputBranch,
          account: body.account,
          model: body.model,
          prompt: body.prompt,
          repo: body.repo,
          attachFiles: body.attachFiles,
          cap: body.cap,
          forceRetry: parseStrictBool(body.forceRetry, false),
          dryRun: parseStrictBool(body.dryRun, false),
          redactSecrets: parseStrictBool(body.redactSecrets, false),
          ...(body.command !== undefined ? { command: body.command } : {}),
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.platform !== undefined ? { platform: body.platform } : {}),
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.keepAlive !== undefined ? { keepAlive: parseStrictBool(body.keepAlive, false) } : {}),
          timeoutMs: body.timeoutMs,
        });
        return send(out?.ok === false ? 400 : 200, out);
      }

      return send(404, { error: "Unknown mission action" });
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 400;
      return send(status, { error: String(e?.message || e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });

  actualPort = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
  const origin = `http://127.0.0.1:${actualPort}`;
  const close = () => {
    store.off("change", onStoreChange);
    for (const [res, timer] of sseClients) {
      clearInterval(timer);
      try {
        res.end();
      } catch {}
    }
    sseClients.clear();
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  };

  return {
    port: actualPort,
    origin,
    token: tok,
    launchUrl: `${origin}/#t=${encodeURIComponent(tok)}`,
    close,
  };
}
