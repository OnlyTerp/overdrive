import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "./version.mjs";
import { OFFLOAD_MODES } from "./partition.mjs";
import { detectFleet } from "./routing.mjs";
import {
  getRsiOverview,
  getRsiSummary,
  promoteRsiCandidate,
  rollbackRsiCandidate,
  runRsiVerificationCycle,
  scanRsiOpportunities,
  submitRsiAuditReceipt,
} from "./rsi.mjs";
import { OverdriveStore } from "./store.mjs";
import { provisionWorktrees, auditAndVerifyLane, runMissionGate, cleanupWorktrees } from "./worktree.mjs";
import { listAdhdSessions, readAdhdSessionDetail, buildEscalationPacket, submitToAdhdLoopback, planPodTournament } from "./adhd-bridge.mjs";
import { mergeTeamBriefIntoPool, readAccountPool, readTeamBrief, selectAssistantForRole } from "./assistants.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tryImportOptional(relPath) {
  try {
    return await import(relPath);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Overdrive v0.3.1 fuses Pod-Tournament ADHD deep thinking, mechanical contract freezes, zero-collision parallel swarm execution (globs + monolith ownedRegions), cloud/VM dispatch, and ratcheted cross-family verification into one closed loop (17 tools).
Workflow:
1. overdrive_status (includeAdhdSessions/includeRsi) & overdrive_assistants to inspect fleet health, stale-account warnings, and assistant brief windows.
2. overdrive_pod_plan when designing 1-40 thinker Pod-Tournament + 4-judge Apex topology; then overdrive_create + overdrive_plan with sharedContracts, disjoint ownedGlobs/ownedRegions, ratchets, and gates.
3. overdrive_freeze to lock HEAD SHA-256 contract hashes, provision isolated worktrees, and emit worker briefs.
4. Dispatch lanes in parallel: use overdrive_cloud_spawn (supports dryRun: true and provider: "devin-vm" | "claude-cloud" | ...) and bring results back via overdrive_ingest_patch (SHA-256 verified, optional runVerify: true).
5. Verify finished lanes with overdrive_verify, run overdrive_gate or atomic trial-merge overdrive_integrate (laneIds, gateId, cleanupWorktrees), and use overdrive_escalate on genuine architecture failures.
6. Self-improve strictly locally with overdrive_rsi_scan -> overdrive_rsi_cycle -> overdrive_rsi_audit (executed cross-family model receipt required) -> overdrive_rsi_promote / overdrive_rsi_rollback.`;

const str = { type: "string" };
const bool = { type: "boolean" };

function parseStrictBool(v, fallback = false) {
  if (v === undefined) return fallback;
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0" || v === "" || v === null) return false;
  return Boolean(v);
}

export const TOOLS = [
  {
    name: "overdrive_status",
    description: "Inspect active Overdrive missions, detected agent fleet (harnesses + aipc + connect-anything + routing warnings), and optionally ADHD sessions or RSI overview.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: { ...str, description: "Optional mission ID or slug for full lane/contract/gate detail." },
        includeAdhdSessions: { ...bool, description: "Include recent sessions from the configured ADHD data directory." },
        includeRsi: { ...bool, description: "Include strict-local RSI digest, benchmark score, and candidates overview." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "overdrive_create",
    description: "Create an Overdrive mission workspace linked to a git repository, routing mode (single-harness | playbook-auto | mix-and-match), and optional ADHD session.",
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        goal: str,
        repoRoot: str,
        routingMode: { type: "string", enum: ["single-harness", "playbook-auto", "mix-and-match"] },
        activeHarness: { ...str, description: "e.g. antigravity, claude, codex, devin." },
        adhdSessionId: str,
      },
      required: ["title", "goal", "repoRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_plan",
    description: "Validate and store sharedContracts + disjoint lanes + release gates, resolving per-lane workers, cross-family verifiers, and aipc offload routes. Rejects overlapping globs or disallowed models.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        routingMode: { type: "string", enum: ["single-harness", "playbook-auto", "mix-and-match"] },
        activeHarness: str,
        sharedContracts: {
          type: "array",
          items: {
            oneOf: [
              str,
              { type: "object", properties: { path: str, description: str }, required: ["path"], additionalProperties: false },
            ],
          },
        },
        lanes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: str,
              title: str,
              brief: str,
              complexity: { type: "string", enum: ["hard", "standard", "fast"] },
              ownedGlobs: { type: "array", items: str },
              ownedRegions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: str,
                    startAnchor: str,
                    endAnchor: str,
                    boundaryMode: { type: "string", enum: ["exclusive"] },
                  },
                  required: ["path", "startAnchor", "endAnchor"],
                },
              },
              ignoreUntrackedGlobs: { type: "array", items: str },
              readOnlyMounts: {
                type: "array",
                items: {
                  type: "object",
                  properties: { source: str, target: str },
                  required: ["source", "target"],
                },
              },
              ratchet: { type: "object" },
              verifyCmd: str,
              offload: { type: "string", enum: [...OFFLOAD_MODES] },
              worker: { type: "object" },
              verifier: { type: "object" },
            },
            required: ["id", "verifyCmd"],
            additionalProperties: true,
          },
        },
        gates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: str,
              title: str,
              cmd: str,
              offload: { type: "string", enum: [...OFFLOAD_MODES] },
              required: bool,
              ratchet: { type: "object" },
            },
            required: ["id", "cmd"],
            additionalProperties: false,
          },
        },
      },
      required: ["missionId", "lanes"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_freeze",
    description: "Lock HEAD commit SHA and SHA-256 hashes of every sharedContract file, optionally provision isolated git worktrees, and return self-contained per-lane briefs.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        provisionWorktrees: { ...bool, description: "Default true. Create isolated <worktreeRoot>/<repo>/<slug>-<lane> worktrees." },
        allowDirtyContracts: { ...bool, description: "Allow freezing uncommitted contract files (default false)." },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_verify",
    description: "Audit a lane worktree against freezeCommit (checks contract SHA-256 tamper + git diff outside ownedGlobs) and execute its verifyCmd.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        laneId: str,
        runCmd: { ...bool, description: "Default true." },
        timeoutMs: { type: "number" },
        useAipc: { ...bool },
      },
      required: ["missionId", "laneId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_gate",
    description: "Run one required release gate (or all pending/required gates when gateId is omitted) and optionally clean up worktrees on completion.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        gateId: str,
        cleanupWorktrees: { ...bool },
        timeoutMs: { type: "number" },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_escalate",
    description: "Mark mission escalated and build an observed ADHD goal_loop_evidence packet from failed lane/gate diagnostics (optionally posting directly if adhdOrigin is supplied).",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        laneId: str,
        gateId: str,
        note: str,
        adhdOrigin: { ...str, description: "Optional loopback URL e.g. http://127.0.0.1:65213 to post evidence directly." },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_integrate",
    description: "Run atomic trial-merge integration and holdout ratchet evaluation across verified mission lanes.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        laneIds: { type: "array", items: str },
        gateId: str,
        cleanupWorktrees: bool,
        runGates: bool,
        runHoldouts: bool,
        promoteToRepoRoot: bool,
        ignoreUntrackedGlobs: { type: "array", items: str },
        timeoutMs: { type: "number" },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_ingest_patch",
    description: "Ingest and SHA-256 verify a .patch output from a cloud/VM lane into the lane branch or worktree, optionally running lane verification.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        laneId: str,
        branchRef: str,
        patchPath: str,
        patchText: str,
        expectedSha256: str,
        remote: str,
        runVerify: bool,
        runCmd: bool,
        timeoutMs: { type: "number" },
      },
      required: ["missionId", "laneId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_cloud_spawn",
    description: "Dispatch a single-attempt cloud/VM lane worker (claude-cloud, codex-cloud, devin-cloud, devin-vm, or copilot-cloud), or preview with dryRun: true.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: str,
        laneId: str,
        provider: str,
        branchName: str,
        outputBranch: str,
        account: str,
        model: str,
        prompt: str,
        repo: str,
        attachFiles: { type: "array", items: str },
        cap: { type: "number" },
        forceRetry: bool,
        dryRun: bool,
        redactSecrets: bool,
        command: str,
        cwd: str,
        platform: str,
        mode: str,
        keepAlive: bool,
        bridgePath: str,
        timeoutMs: { type: "number" },
      },
      required: ["missionId", "laneId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_pod_plan",
    description: "Plan a 1-40 thinker Pod-Tournament & Cross-Family Apex ADHD architecture session aligned with local harnesses and free pools.",
    inputSchema: {
      type: "object",
      properties: {
        goal: str,
        contextSummary: str,
        totalThinkers: { type: "number" },
        podSize: { type: "number" },
        activeHarness: str,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "overdrive_assistants",
    description: "Read live assistant brief & quota windows (team_cli.py brief merged with ACCOUNT_ROUTER pool freshness) and select the best eligible assistant for a role.",
    inputSchema: {
      type: "object",
      properties: {
        role: str,
        since: { type: "number" },
        selectRole: bool,
        maxAgeSeconds: { type: "number" },
        maxUsagePct: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "overdrive_rsi_scan",
    description: "Mine local read-only intentions (strict_local) and run the 5-dimension Golden Benchmark to rank RSI candidates.",
    inputSchema: {
      type: "object",
      properties: {
        ledgerPath: str,
        memoryPath: str,
        driftPath: str,
        arpdDir: str,
        benchmarkRoot: str,
        repoRoot: str,
        missionId: str,
      },
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_rsi_cycle",
    description: "Run a ratcheted verification cycle on an RSI candidate (stays evaluated_pending_audit unless runCrossFamilyAudit: true executes a real cross-family model audit).",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: str,
        worktreeRoot: str,
        touchesFiles: { type: "array", items: str },
        proposerFamily: str,
        auditorFamily: str,
        auditorModel: str,
        runCrossFamilyAudit: bool,
        missionId: str,
      },
      required: ["candidateId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_rsi_audit",
    description: "Submit an executed cross-family model audit receipt for an evaluated RSI candidate before promotion.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: str,
        auditorFamily: str,
        auditorModel: str,
        verdict: { type: "string", enum: ["approve", "reject"] },
        notes: str,
        receiptRef: str,
        modelExecuted: bool,
        auditKind: str,
        missionId: str,
      },
      required: ["candidateId", "auditorFamily", "auditorModel", "verdict"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_rsi_promote",
    description: "Promote an audited non-regressing RSI candidate (requires executed cross-family model audit; set applyGitMerge: true to run isolated trial benchmark + git merge --ff-only).",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: str,
        humanApproved: bool,
        repoRoot: str,
        prePromoteCommit: str,
        applyGitMerge: bool,
        sourceBranch: str,
        missionId: str,
      },
      required: ["candidateId"],
      additionalProperties: false,
    },
  },
  {
    name: "overdrive_rsi_rollback",
    description: "Roll back a promoted RSI candidate to its recorded prePromoteCommit and write an immutable rollback receipt.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: str,
        repoRoot: str,
        applyGitReset: bool,
        missionId: str,
      },
      required: ["candidateId"],
      additionalProperties: false,
    },
  },
];

export function createToolHandler(store, { fleetOverride } = {}) {
  return async function callTool(name, args = {}) {
    switch (name) {
      case "overdrive_status": {
        const fleet = fleetOverride || detectFleet();
        const missions = store.listMissions();
        const mission = args.missionId ? store.requireMission(args.missionId) : null;
        const adhd = args.includeAdhdSessions ? listAdhdSessions() : undefined;
        const adhdDetail = mission?.adhdSessionId && args.includeAdhdSessions ? readAdhdSessionDetail(mission.adhdSessionId) : undefined;
        const rsi = getRsiSummary(store);
        const rsiOverview = parseStrictBool(args.includeRsi, false) ? getRsiOverview(store, { repoRoot: REPO_ROOT }) : undefined;
        const routingWarnings = Array.from(
          new Set([...(fleet?.routingWarnings || []), ...(mission?.routingWarnings || [])].filter(Boolean)),
        );
        const degradedAccounts = mission?.degradedAccounts?.length ? mission.degradedAccounts : (fleet?.degradedAccounts || []);
        return {
          version: VERSION,
          dataDir: store.dataDir,
          fleet,
          routingWarnings,
          degradedAccounts,
          missions,
          mission,
          adhd,
          adhdDetail,
          rsi,
          rsiOverview,
        };
      }
      case "overdrive_create":
        return { mission: store.createMission(args) };
      case "overdrive_plan": {
        const { missionId, ...spec } = args;
        return store.planMission(missionId, { ...spec, fleet: fleetOverride });
      }
      case "overdrive_freeze": {
        let mission = store.freezeContracts(args.missionId, { allowDirtyContracts: Boolean(args.allowDirtyContracts) });
        let briefs = {};
        if (args.provisionWorktrees !== false) {
          const prov = provisionWorktrees(store, args.missionId);
          mission = prov.mission;
          briefs = prov.briefs;
        }
        return { mission, briefs };
      }
      case "overdrive_verify":
        return auditAndVerifyLane(store, args.missionId, args.laneId, {
          runCmd: args.runCmd !== false,
          timeoutMs: args.timeoutMs,
          useAipc: Boolean(args.useAipc),
        });
      case "overdrive_gate": {
        if (args.gateId) {
          return runMissionGate(store, args.missionId, args.gateId, {
            timeoutMs: args.timeoutMs,
            cleanupAfterPass: Boolean(args.cleanupWorktrees),
          });
        }
        const m = store.requireMission(args.missionId);
        const results = [];
        let latest = m;
        for (const g of m.gates) {
          const r = runMissionGate(store, args.missionId, g.id, {
            timeoutMs: args.timeoutMs,
            cleanupAfterPass: false,
          });
          results.push({ gateId: g.id, ...r.result });
          latest = r.mission;
          if (!r.result.ok && g.required) break;
        }
        if (args.cleanupWorktrees && latest.state === "completed") {
          cleanupWorktrees(store, args.missionId);
          latest = store.getMission(args.missionId);
        }
        return { results, mission: latest };
      }
      case "overdrive_escalate": {
        let mission = store.requireMission(args.missionId);
        const packet = buildEscalationPacket(mission, args);
        let posted = null;
        if (args.adhdOrigin && mission.adhdSessionId) {
          posted = await submitToAdhdLoopback(args.adhdOrigin, mission.adhdSessionId, packet);
        }
        mission = store.setMissionState(args.missionId, "escalated", {
          laneId: args.laneId || null,
          gateId: args.gateId || null,
          requestId: packet.requestId,
          posted: Boolean(posted),
        });
        return { packet, posted, mission };
      }
      case "overdrive_integrate": {
        const mod = await tryImportOptional("./integrate.mjs");
        const fn = mod?.integrateMission;
        if (!fn) {
          throw new Error("overdrive_integrate requires src/integrate.mjs.");
        }
        return fn(store, args.missionId, {
          ...(Array.isArray(args.laneIds) ? { laneIds: args.laneIds } : {}),
          ...(args.gateId ? { gateId: args.gateId } : {}),
          cleanupWorktrees: parseStrictBool(args.cleanupWorktrees, false),
          runGates: parseStrictBool(args.runGates, true),
          runHoldouts: parseStrictBool(args.runHoldouts, true),
          promoteToRepoRoot: parseStrictBool(args.promoteToRepoRoot, true),
          ...(Array.isArray(args.ignoreUntrackedGlobs) ? { ignoreUntrackedGlobs: args.ignoreUntrackedGlobs } : {}),
          ...(Number.isFinite(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {}),
        });
      }
      case "overdrive_ingest_patch": {
        const mod = await tryImportOptional("./cloud-fleet.mjs");
        const fn = mod?.ingestCloudArtifact;
        if (!fn) {
          throw new Error("overdrive_ingest_patch requires src/cloud-fleet.mjs.");
        }
        if (!args.laneId || typeof args.laneId !== "string") {
          throw new Error("overdrive_ingest_patch requires laneId.");
        }
        const ingested = await fn(store, args.missionId, args.laneId, {
          branchRef: args.branchRef,
          patchPath: args.patchPath,
          patchText: args.patchText,
          expectedSha256: args.expectedSha256,
          remote: args.remote,
        });
        if (ingested?.ok !== false && parseStrictBool(args.runVerify, false)) {
          const verifyOut = auditAndVerifyLane(store, args.missionId, args.laneId, {
            runCmd: args.runCmd !== undefined ? parseStrictBool(args.runCmd, true) : true,
            ...(Number.isFinite(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {}),
          });
          return { ...ingested, verify: verifyOut.result, mission: verifyOut.mission };
        }
        return ingested;
      }
      case "overdrive_cloud_spawn": {
        const mod = await tryImportOptional("./cloud-fleet.mjs");
        const fn = mod?.dispatchCloudWorker;
        if (!fn) {
          throw new Error("overdrive_cloud_spawn requires src/cloud-fleet.mjs.");
        }
        if (!args.laneId || typeof args.laneId !== "string") {
          throw new Error("overdrive_cloud_spawn requires laneId.");
        }
        return fn(store, args.missionId, args.laneId, {
          provider: args.provider,
          branchName: args.branchName,
          outputBranch: args.outputBranch,
          account: args.account,
          model: args.model,
          prompt: args.prompt,
          repo: args.repo,
          attachFiles: args.attachFiles,
          cap: args.cap,
          forceRetry: parseStrictBool(args.forceRetry, false),
          dryRun: parseStrictBool(args.dryRun, false),
          redactSecrets: parseStrictBool(args.redactSecrets, false),
          ...(args.command !== undefined ? { command: args.command } : {}),
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.platform !== undefined ? { platform: args.platform } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.keepAlive !== undefined ? { keepAlive: parseStrictBool(args.keepAlive, false) } : {}),
          ...(args.bridgePath !== undefined ? { bridgePath: args.bridgePath } : {}),
          timeoutMs: args.timeoutMs,
        });
      }
      case "overdrive_pod_plan":
        return planPodTournament({
          ...(args.goal !== undefined ? { goal: args.goal } : {}),
          ...(args.contextSummary !== undefined ? { contextSummary: args.contextSummary } : {}),
          ...(Number.isFinite(args.totalThinkers) ? { totalThinkers: Math.trunc(args.totalThinkers) } : {}),
          ...(Number.isFinite(args.podSize) ? { podSize: Math.trunc(args.podSize) } : {}),
          ...(args.activeHarness !== undefined ? { activeHarness: args.activeHarness } : {}),
          fleet: fleetOverride || detectFleet(),
        });
      case "overdrive_assistants": {
        const poolOpts = {
          ...(Number.isFinite(args.maxAgeSeconds) ? { maxAgeSeconds: args.maxAgeSeconds } : {}),
          ...(Number.isFinite(args.maxUsagePct) ? { maxUsagePct: args.maxUsagePct } : {}),
        };
        const rawPool = readAccountPool(poolOpts);
        const brief = readTeamBrief({ ...(Number.isFinite(args.since) ? { since: args.since } : {}) });
        const pool = mergeTeamBriefIntoPool(rawPool, brief, poolOpts);
        const selection =
          parseStrictBool(args.selectRole, true) || args.role
            ? selectAssistantForRole(args.role || "research", { pool, teamBrief: brief, ...poolOpts })
            : null;
        return { schemaVersion: 1, brief, pool, selection };
      }
      case "overdrive_rsi_scan":
        return scanRsiOpportunities(store, {
          intentionsOpts: {
            ...(args.ledgerPath !== undefined ? { ledgerPath: args.ledgerPath } : {}),
            ...(args.memoryPath !== undefined ? { memoryPath: args.memoryPath } : {}),
            ...(args.driftPath !== undefined ? { driftPath: args.driftPath } : {}),
            ...(args.arpdDir !== undefined ? { arpdDir: args.arpdDir } : {}),
          },
          benchmarkRoot: args.benchmarkRoot || args.repoRoot || REPO_ROOT,
          fleet: fleetOverride,
          repoRoot: args.repoRoot || REPO_ROOT,
          missionId: args.missionId || null,
        });
      case "overdrive_rsi_cycle":
        return runRsiVerificationCycle(store, args.candidateId, {
          worktreeRoot: args.worktreeRoot || REPO_ROOT,
          touchesFiles: Array.isArray(args.touchesFiles) ? args.touchesFiles : [],
          proposerFamily: args.proposerFamily || null,
          auditorFamily: args.auditorFamily || null,
          auditorModel: args.auditorModel || null,
          runCrossFamilyAudit: parseStrictBool(args.runCrossFamilyAudit, false),
          missionId: args.missionId || null,
        });
      case "overdrive_rsi_audit":
        return submitRsiAuditReceipt(store, args.candidateId, {
          auditorFamily: args.auditorFamily,
          auditorModel: args.auditorModel,
          verdict: args.verdict,
          notes: args.notes || "",
          receiptRef: args.receiptRef || null,
          modelExecuted: parseStrictBool(args.modelExecuted, true),
          ...(args.auditKind ? { auditKind: args.auditKind } : {}),
          missionId: args.missionId || null,
        });
      case "overdrive_rsi_promote":
        return promoteRsiCandidate(store, args.candidateId, {
          humanApproved: parseStrictBool(args.humanApproved, false),
          repoRoot: args.repoRoot || REPO_ROOT,
          prePromoteCommit: args.prePromoteCommit || null,
          applyGitMerge: parseStrictBool(args.applyGitMerge, false),
          sourceBranch: args.sourceBranch || null,
          missionId: args.missionId || null,
        });
      case "overdrive_rsi_rollback":
        return rollbackRsiCandidate(store, args.candidateId, {
          repoRoot: args.repoRoot || null,
          applyGitReset: parseStrictBool(args.applyGitReset, false),
          missionId: args.missionId || null,
        });
      default:
        throw new Error(`Unknown tool "${name}".`);
    }
  };
}

export async function handleJsonRpc(msg, callTool) {
  const { id, method, params } = msg || {};
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (id === undefined) return null;

  try {
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "overdrive", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      const out = await callTool(params?.name, params?.arguments || {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    if (method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } };
  }
}

export function runStdioMcp(dataDir) {
  const store = new OverdriveStore(dataDir);
  const callTool = createToolHandler(store);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const reply = await handleJsonRpc(msg, callTool);
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  });
  rl.on("close", () => {
    try {
      store.close();
    } catch {}
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioMcp();
}
