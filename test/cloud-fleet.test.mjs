import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { planPodTournament } from "../src/adhd-bridge.mjs";
import {
  ASSISTANT_IDS,
  buildAssistantAssignment,
  mergeTeamBriefIntoPool,
  readAccountPool,
  readTeamBrief,
  selectAssistantForRole,
  summarizeDegradedAccounts,
} from "../src/assistants.mjs";
import {
  DEFAULT_CLAUDE_CLOUD_CAPS,
  archiveDevinSandbox,
  claimSingleAttemptKey,
  dispatchCloudWorker,
  execInDevinSandbox,
  ingestCloudArtifact,
  pollCloudJob,
  redactSecrets,
  spawnDevinSandbox,
} from "../src/cloud-fleet.mjs";
import { createToolHandler } from "../src/mcp.mjs";
import {
  assertModelPolicy,
  detectFleet,
  resolveMissionRouting,
} from "../src/routing.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { provisionWorktrees } from "../src/worktree.mjs";
import { defaultTestScratchBase } from "../src/paths.mjs";

const TEST_SCRATCH_BASE = defaultTestScratchBase();
mkdirSync(TEST_SCRATCH_BASE, { recursive: true });

const cleanupFns = [];
afterEach(() => {
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try {
      fn();
    } catch {}
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(TEST_SCRATCH_BASE, `${prefix}-`));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runGit(repo, ...argv) {
  const r = spawnSync("git", ["-C", repo, ...argv], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function initTempGitRepo() {
  const repo = makeTempDir("cf-repo");
  runGit(repo, "init");
  runGit(repo, "config", "user.email", "cloud-fleet-test@example.com");
  runGit(repo, "config", "user.name", "Cloud Fleet Test");
  runGit(repo, "config", "core.autocrlf", "false");

  mkdirSync(path.join(repo, "src", "core"), { recursive: true });
  writeFileSync(path.join(repo, "src", "contracts.mjs"), "export const CONTRACT_VER = 1;\n", "utf8");
  writeFileSync(path.join(repo, "src", "core", "worker.mjs"), "export const run = () => 'v1';\n", "utf8");
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-m", "initial commit");
  return repo;
}

describe("cloud-fleet: no-double-spend guard, branch binding, secret checks & Devin VM wrapper", () => {
  it("enforces DEFAULT_CLAUDE_CLOUD_CAPS, single-attempt ledger idempotency, and never auto-retries", () => {
    assert.deepEqual(DEFAULT_CLAUDE_CLOUD_CAPS, {
      "claude-opus-5-5": 10,
      "claude-sonnet-5-5": 10,
      "fable-2": 20,
    });

    const repo = initTempGitRepo();
    const dataDir = makeTempDir("cf-store");
    const ledgerDir = makeTempDir("cf-ledger");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({
      title: "Cloud Fleet Guard",
      goal: "Verify single-attempt ledger guard",
      repoRoot: repo,
      routingMode: "playbook-auto",
    });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "engine",
          title: "Engine lane",
          brief: "Implement core worker upgrade",
          complexity: "hard",
          ownedGlobs: ["src/core/**"],
          verifyCmd: "node -v",
        },
      ],
    });

    let calls = 0;
    let capturedArgs = null;
    let reservedObservedBeforeSpawn = false;
    const mockRunner = (_cmd, args) => {
      calls++;
      capturedArgs = args;
      // Ledger file MUST already exist as `reserved` before runner spawns.
      for (const f of readdirSync(ledgerDir)) {
        const rec = JSON.parse(readFileSync(path.join(ledgerDir, f), "utf8"));
        if (rec.laneId === "engine" && rec.status === "reserved") {
          reservedObservedBeforeSpawn = true;
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "spawned",
          route: "omp:1",
          account: "acct-1",
          trigger_id: "trig_abc123",
          session_id: "cse_xyz789",
          link: "https://claude.ai/code/session_xyz789",
          model: "claude-opus-5-5",
        }),
        stderr: "",
      };
    };

    // First verify standalone claimSingleAttemptKey and duplicate rejection
    const c1 = claimSingleAttemptKey("standalone-slug", "lane-a", "claude-cloud", ledgerDir);
    assert.equal(c1.status, "reserved");
    assert.equal(existsSync(c1.recordPath), true);
    assert.throws(
      () => claimSingleAttemptKey("standalone-slug", "lane-a", "claude-cloud", ledgerDir),
      /CLOUD_SPAWN_ALREADY_ATTEMPTED/,
    );

    const dispatched = dispatchCloudWorker(store, m.id, "engine", {
      provider: "claude-cloud",
      model: "fable-2",
      prompt: "Upgrade src/core/worker.mjs cleanly",
      ledgerDir,
      scriptPath: "C:/mock/claude-cloud.ps1",
      runner: mockRunner,
    });
    assert.equal(calls, 1);
    assert.equal(reservedObservedBeforeSpawn, true);
    assert.equal(dispatched.status, "dispatched");
    assert.equal(dispatched.cap, 20);
    assert.equal(dispatched.outputBranch, `cloud/${m.slug}-engine`);
    assert.match(dispatched.boundPrompt, new RegExp(`cloud/${m.slug}-engine`));
    assert.ok(capturedArgs.includes("-Cap") && capturedArgs.includes("20"));
    assert.equal(dispatched.jobRef.triggerId, "trig_abc123");
    assert.equal(dispatched.jobRef.sessionId, "cse_xyz789");

    const ledgerContent = JSON.parse(readFileSync(dispatched.ledgerPath, "utf8"));
    assert.equal(ledgerContent.status, "dispatched");

    // Second dispatch for same (missionId, laneId, provider) MUST refuse with CLOUD_SPAWN_ALREADY_ATTEMPTED
    assert.throws(
      () =>
        dispatchCloudWorker(store, m.id, "engine", {
          provider: "claude-cloud",
          prompt: "Retry duplicate",
          ledgerDir,
          scriptPath: "C:/mock/claude-cloud.ps1",
          runner: mockRunner,
        }),
      /CLOUD_SPAWN_ALREADY_ATTEMPTED/,
    );
    assert.equal(calls, 1);

    // Failed spawn marks failed_no_retry and NEVER auto-retries; subsequent call still blocked unless forceRetry: true
    assert.throws(
      () =>
        dispatchCloudWorker(store, m.id, "engine", {
          provider: "codex-cloud",
          prompt: "Run on codex cloud",
          ledgerDir,
          runner: () => ({ status: 1, stdout: "", stderr: "network error" }),
        }),
      /no auto-retry/i,
    );
    assert.throws(
      () =>
        dispatchCloudWorker(store, m.id, "engine", {
          provider: "codex-cloud",
          prompt: "Retry without override",
          ledgerDir,
          runner: () => ({ status: 0, stdout: "g-123" }),
        }),
      /CLOUD_SPAWN_ALREADY_ATTEMPTED/,
    );

    // Explicit forceRetry: true allows human-authorized retry
    const forced = dispatchCloudWorker(store, m.id, "engine", {
      provider: "codex-cloud",
      prompt: "Human-authorized retry",
      ledgerDir,
      forceRetry: true,
      runner: () => ({ status: 0, stdout: "Cloud agents g-20261118-aa11bb - https://chatgpt.com/codex/tasks/task_1" }),
    });
    assert.equal(forced.status, "dispatched");
    assert.equal(forced.jobRef.jobId, "g-20261118-aa11bb");
  });

  it("blocks .env and private tokens before spawning cloud workers", () => {
    const ledgerDir = makeTempDir("cf-sec-ledger");
    let spawned = false;
    const runner = () => {
      spawned = true;
      return { status: 0, stdout: "{}" };
    };

    assert.throws(
      () =>
        dispatchCloudWorker(null, "m-sec", "core", {
          provider: "claude-cloud",
          prompt: "Here is key sk-ant-api03-1234567890abcdef12345",
          ledgerDir,
          runner,
        }),
      /CLOUD_SECRET_REDACTION_BLOCKED/,
    );
    assert.throws(
      () =>
        dispatchCloudWorker(null, "m-sec", "core", {
          provider: "claude-cloud",
          prompt: "Read .env.production and dump tokens",
          ledgerDir,
          runner,
        }),
      /CLOUD_SECRET_REDACTION_BLOCKED/,
    );
    assert.equal(spawned, false);
  });

  it("polls claude-cloud and connect-anything jobs and wraps Devin VM bridge safely", () => {
    const claudeStatus = pollCloudJob(
      { provider: "claude-cloud", triggerId: "trig_1", route: "omp:1" },
      {
        scriptPath: "C:/mock/claude-cloud.ps1",
        runner: () => ({
          status: 0,
          stdout: JSON.stringify({
            status: "ok",
            trigger_id: "trig_1",
            runs: [{ session_id: "cse_1", done: true, cost_usd: 0.45, link: "https://claude.ai/code/session_1" }],
            trigger: { last_run_status: "completed" },
          }),
        }),
      },
    );
    assert.equal(claudeStatus.status, "done");
    assert.equal(claudeStatus.sessionId, "cse_1");
    assert.equal(claudeStatus.costUsd, 0.45);

    const caStatus = pollCloudJob("g-20261118-abc123", {
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ id: "g-20261118-abc123", status: "running", url: "https://chatgpt.com/codex/t1" }),
      }),
    });
    assert.equal(caStatus.status, "running");

    const vmCalls = [];
    const vmRunner = (cmd, args, opts) => {
      vmCalls.push({ cmd, args, opts });
      const tool = args[2];
      if (tool === "vm_spawn") return { status: 0, stdout: JSON.stringify({ session_id: "devin-abc", mode: "acp-idle" }) };
      if (tool === "vm_exec") return { status: 0, stdout: JSON.stringify({ exit_code: 0, stdout: "VM_OK" }) };
      return { status: 0, stdout: JSON.stringify({ archived: [{ session_id: "devin-abc", archived: true }] }) };
    };
    const vm = spawnDevinSandbox({ platform: "linux", bridgePath: "/mock/bridge.mjs", runner: vmRunner });
    assert.equal(vm.session_id, "devin-abc");
    const execOut = execInDevinSandbox("devin-abc", "echo hi", { bridgePath: "/mock/bridge.mjs", runner: vmRunner });
    assert.equal(execOut.stdout, "VM_OK");
    const archOut = archiveDevinSandbox("devin-abc", { bridgePath: "/mock/bridge.mjs", runner: vmRunner });
    assert.equal(archOut.archived[0].archived, true);
    assert.equal(vmCalls.every((c) => c.opts.shell === false && c.opts.windowsHide === true), true);
  });
});

describe("cloud-fleet: SHA-256 patch ingest, branch ingest & contract tamper protection", () => {
  it("applies SHA-256 verified patches, rejects PATCH_SHA_MISMATCH before writing, and blocks contract mutations", () => {
    const repo = initTempGitRepo();
    const dataDir = makeTempDir("ing-data");
    const wtBase = makeTempDir("ing-wt");
    const prevWt = process.env.OVERDRIVE_WT_ROOT;
    process.env.OVERDRIVE_WT_ROOT = wtBase;
    cleanupFns.push(() => {
      if (prevWt === undefined) delete process.env.OVERDRIVE_WT_ROOT;
      else process.env.OVERDRIVE_WT_ROOT = prevWt;
    });

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    const m = store.createMission({ title: "Ingest Check", goal: "Verify SHA256 ingest", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [{ id: "core", ownedGlobs: ["src/core/**"], verifyCmd: "node -v" }],
    });
    store.freezeContracts(m.id);
    const { mission: frozen } = provisionWorktrees(store, m.id);
    const coreWt = frozen.lanes[0].worktreePath;

    const validPatch = [
      "diff --git a/src/core/worker.mjs b/src/core/worker.mjs",
      "--- a/src/core/worker.mjs",
      "+++ b/src/core/worker.mjs",
      "@@ -1 +1 @@",
      "-export const run = () => 'v1';",
      "+export const run = () => 'v2-cloud';",
      "",
    ].join("\n");
    const validSha = createHash("sha256").update(Buffer.from(validPatch, "utf8")).digest("hex");

    // 1. Tampered digest -> MUST throw PATCH_SHA_MISMATCH before modifying worktree
    assert.throws(
      () =>
        ingestCloudArtifact(store, m.id, "core", {
          patchText: validPatch,
          expectedSha256: "0".repeat(64),
        }),
      /PATCH_SHA_MISMATCH/,
    );
    assert.match(readFileSync(path.join(coreWt, "src", "core", "worker.mjs"), "utf8"), /'v1'/);

    // 2. Patch touching frozen sharedContract -> MUST throw CONTRACT_TAMPERED before writing
    const contractPatch = [
      "diff --git a/src/contracts.mjs b/src/contracts.mjs",
      "--- a/src/contracts.mjs",
      "+++ b/src/contracts.mjs",
      "@@ -1 +1 @@",
      "-export const CONTRACT_VER = 1;",
      "+export const CONTRACT_VER = 999;",
      "",
    ].join("\n");
    const contractSha = createHash("sha256").update(Buffer.from(contractPatch, "utf8")).digest("hex");
    assert.throws(
      () =>
        ingestCloudArtifact(store, m.id, "core", {
          patchText: contractPatch,
          expectedSha256: contractSha,
        }),
      /CONTRACT_TAMPERED/,
    );
    assert.match(readFileSync(path.join(coreWt, "src", "contracts.mjs"), "utf8"), /CONTRACT_VER = 1/);

    // 3. Valid SHA-256 patch -> applies cleanly & records cloud_ingested event
    const ok = ingestCloudArtifact(store, m.id, "core", {
      patchText: validPatch,
      expectedSha256: validSha,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.sha256, validSha);
    assert.match(readFileSync(path.join(coreWt, "src", "core", "worker.mjs"), "utf8"), /'v2-cloud'/);

    const events = store.listMissionEvents(m.id, { afterSeq: 0, limit: 50 }).events;
    assert.ok(events.some((e) => e.type === "cloud_ingested" && e.laneId === "core"));

    // 4. Branch ingest from cloud/* branch
    runGit(repo, "checkout", "-b", `cloud/${m.slug}-core`, frozen.freezeCommit);
    writeFileSync(path.join(repo, "src", "core", "from-branch.mjs"), "export const branchCloud = true;\n", "utf8");
    runGit(repo, "add", "src/core/from-branch.mjs");
    runGit(repo, "commit", "-m", "cloud branch work");
    runGit(repo, "checkout", "-");

    const branchOut = ingestCloudArtifact(store, m.id, "core", { branchRef: `cloud/${m.slug}-core` });
    assert.equal(branchOut.ok, true);
    assert.equal(existsSync(path.join(coreWt, "src", "core", "from-branch.mjs")), true);
  });
});

describe("assistants: account_pool freshness, 80% cap, role selection & safe assignment", () => {
  it("excludes stale (>24h), exhausted, unavailable, and >=80% used accounts strictly", () => {
    const dir = makeTempDir("pool-dir");
    const poolPath = path.join(dir, "account_pool.json");
    const now = new Date("2026-11-18T12:00:00Z");

    writeFileSync(
      poolPath,
      JSON.stringify({
        updated_at: "2026-11-18T11:30:00Z",
        accounts: {
          muse_ai: { provider: "muse", status: "ok", quota_remaining: 0.95, used_percent: 12, observed_at: "2026-11-18T11:45:00Z" },
          dot: { provider: "openai", status: "ok", quota_remaining: 0.8, used_percent: 25, observed_at: "2026-11-18T11:45:00Z" },
          dot2: { provider: "openai", status: "ok", quota_remaining: 0.7, used_percent: 80, observed_at: "2026-11-18T11:45:00Z" },
          grokbot: { provider: "xai", status: "ok", quota_remaining: 0.5, used_percent: 40, observed_at: "2026-11-16T10:00:00Z" },
          claude_dead: { provider: "anthropic", status: "402", quota_remaining: 0.5, observed_at: "2026-11-18T11:45:00Z" },
          swe_zero: { provider: "devin", status: "ok", quota_remaining: 0, observed_at: "2026-11-18T11:45:00Z" },
        },
      }),
      "utf8",
    );

    const pool = readAccountPool({ poolPath, now });
    assert.equal(pool.available, true);
    assert.equal(pool.accounts.muse_ai.eligible, true);
    assert.equal(pool.accounts.dot.eligible, true);
    assert.equal(pool.accounts.dot2.eligible, false);
    assert.equal(pool.accounts.dot2.reason, "window_usage_high");
    assert.equal(pool.accounts.grokbot.eligible, false);
    assert.equal(pool.accounts.grokbot.reason, "observation_stale");
    assert.equal(pool.accounts.claude_dead.eligible, false);
    assert.equal(pool.accounts.swe_zero.eligible, false);

    // Role selection respects preferences + freshness
    const resResearch = selectAssistantForRole("research", { pool });
    assert.equal(resResearch.selected, "muse_ai");
    assert.equal(resResearch.verified, false); // Not in teamBrief -> never falsely marked verified

    const resAstra = selectAssistantForRole("astra", { pool });
    assert.equal(resAstra.selected, "dot");

    // X/web research falls back from stale grokbot to fresh muse_ai
    const resX = selectAssistantForRole("x_research", { pool });
    assert.equal(resX.selected, "muse_ai");

    // Fresh grokbot wins for x_research
    const freshPool = {
      ...pool,
      accounts: {
        ...pool.accounts,
        grokbot: { ...pool.accounts.grokbot, eligible: true, reason: "available_from_reported_snapshot", observedAt: "2026-11-18T11:45:00Z" },
      },
    };
    const resXFresh = selectAssistantForRole("x_research", { pool: freshPool });
    assert.equal(resXFresh.selected, "grokbot");

    // Missing team_cli fails cleanly without throwing
    const missingBrief = readTeamBrief({ scriptPath: path.join(dir, "nope.py") });
    assert.equal(missingBrief.available, false);
    assert.equal(missingBrief.reason, "team_cli_missing");

    // Mocked team_cli brief works and sets verified when listed in members
    const okBrief = readTeamBrief({
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ as_of: 1795000000, members: [{ id: "muse_ai", name: "Muse AI", wake: "webhook" }], team: [], recent_notes: [] }),
      }),
    });
    assert.equal(okBrief.available, true);
    assert.equal(okBrief.untrusted, true);
    const verifiedSelect = selectAssistantForRole("audit", { pool, teamBrief: okBrief });
    assert.equal(verifiedSelect.selected, "muse_ai");
    assert.equal(verifiedSelect.verified, true);

    // Assignment descriptor validates target and never auto-dispatches
    for (const id of ASSISTANT_IDS) {
      const spec = buildAssistantAssignment({ to: id, goal: "Audit partition logic", folder: "/workspace/overdrive", key: "k1" });
      assert.equal(spec.autoDispatched, false);
      assert.equal(spec.executed, false);
      assert.equal(spec.mcp.tool, "assistant_assign");
    }
    assert.throws(() => buildAssistantAssignment({ to: "invalid_bot", goal: "x" }), /Invalid assistant/);
  });
});

describe("routing: preferCloud, devin-vm/cloud-agent offload & exhausted fallback", () => {
  const cloudFleet = {
    harnesses: {
      antigravity: { installed: true, family: "google" },
      codex: { installed: true, family: "openai" },
      claude: { installed: true, family: "anthropic" },
      devin: { installed: true, family: "devin" },
    },
    infra: {
      aipc: { ready: true, path: "/opt/remote-offload/offload.py" },
      claudeCloud: { ready: true, path: "/opt/claude-cloud/claude-cloud.ps1" },
      codexCloud: { ready: true, command: "codex" },
      devinVm: { ready: true, path: "/opt/cloud-vm/bridge.mjs" },
    },
  };

  it("routes parallel hard lanes to claude-cloud/codex-cloud when preferCloud is enabled and honors all 6 OFFLOAD_MODES", () => {
    const lanes = [
      { id: "l1", complexity: "hard", ownedGlobs: ["src/a/**"], verifyCmd: "node -v", offload: "auto" },
      { id: "l2", complexity: "hard", ownedGlobs: ["src/b/**"], verifyCmd: "node -v", offload: "cloud-agent" },
      { id: "l3", complexity: "standard", ownedGlobs: ["src/c/**"], verifyCmd: "node -v", offload: "devin-vm" },
      { id: "l4", complexity: "fast", ownedGlobs: ["src/d/**"], verifyCmd: "node -v", offload: "aipc-gpu" },
      { id: "l5", complexity: "fast", ownedGlobs: ["src/e/**"], verifyCmd: "node -v", offload: "local" },
    ];
    const routed = resolveMissionRouting({ routingMode: "playbook-auto", activeHarness: "antigravity" }, lanes, cloudFleet, { preferCloud: true });
    assert.equal(routed.lanes[0].worker.dispatch, "claude-cloud");
    assert.equal(routed.lanes[0].effectiveOffload, "cloud-agent");
    assert.equal(routed.lanes[1].worker.dispatch, "codex-cloud");
    assert.equal(routed.lanes[1].effectiveOffload, "cloud-agent");
    assert.equal(routed.lanes[2].worker.harness, "devin");
    assert.equal(routed.lanes[2].worker.model, "swe-2");
    assert.equal(routed.lanes[2].effectiveOffload, "devin-vm");
    assert.equal(routed.lanes[3].worker.model, "swe-2-flash");
    assert.equal(routed.lanes[3].effectiveOffload, "aipc --gpu");
    assert.equal(routed.lanes[4].effectiveOffload, "local");
    for (const l of routed.lanes) {
      assert.equal(l.verifier.crossFamily, true);
      assert.notEqual(l.verifier.family, l.worker.family);
    }
  });

  it("skips exhausted / >=80% / stale primary accounts and falls back cleanly while rejecting banned models", () => {
    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const pool = {
      updated_at: nowIso,
      accounts: {
        claude_1_200: { provider: "anthropic", status: "ok", quota_remaining: 0.2, used_percent: 88, fallback_model: "claude-opus-5-5", observed_at: nowIso },
        chatgpt_500: { provider: "openai", status: "402", quota_remaining: 0.0, fallback_model: "gpt-6-astra", observed_at: nowIso },
        chatgpt_200: { provider: "openai", status: "ok", quota_remaining: 0.6, used_percent: 20, fallback_model: "gpt-6.1-sol", observed_at: nowIso },
        swe2: { provider: "devin", status: "ok", quota_remaining: 1.0, observed_at: staleIso },
      },
    };
    const lanes = [
      { id: "core", complexity: "hard", ownedGlobs: ["src/core/**"], verifyCmd: "node -v", offload: "auto" },
      { id: "api", complexity: "standard", ownedGlobs: ["src/api/**"], verifyCmd: "node -v", offload: "auto" },
    ];
    const routed = resolveMissionRouting({ routingMode: "playbook-auto", activeHarness: "antigravity" }, lanes, cloudFleet, {
      preferCloud: true,
      accountPool: pool,
    });
    // Anthropic is >=80% -> claude-cloud skipped, picks codex-cloud using fallback account chatgpt_200!
    assert.equal(routed.lanes[0].worker.dispatch, "codex-cloud");
    assert.equal(routed.lanes[0].worker.account, "chatgpt_200");
    assert.equal(routed.lanes[0].worker.fallbackSelected, true);
    // Devin is stale -> standard lane falls back to codex-cloud chatgpt_200!
    assert.equal(routed.lanes[1].worker.dispatch, "codex-cloud");

    assert.throws(() => assertModelPolicy({ harness: "claude", model: "kimi-k2" }), /Policy violation/);
    assert.throws(() => assertModelPolicy({ harness: "omp", provider: "lithos", model: "gpt-6" }), /Policy violation/);
    assert.throws(() => assertModelPolicy({ harness: "codex", model: "gemini-4-carbon" }), /only run inside Antigravity/);

    const det = detectFleet({
      claudeCloud: "C:/fake/claude-cloud.ps1",
      codexCloud: true,
      devinVm: "/fake/bridge.mjs",
      accountPool: pool,
    });
    assert.equal(det.infra.claudeCloud.ready, true);
    assert.equal(det.infra.codexCloud.ready, true);
    assert.equal(det.infra.devinVm.ready, true);
    assert.equal(det.infra.accountPool.summary.eligible, 1);
  });
});

describe("adhd-bridge: planPodTournament", () => {
  it("plans single-pod for <=5 thinkers and 2-pass multi-pod tournament with dedicated trackers + 4-judge Apex for >=6", () => {
    assert.throws(() => planPodTournament({ totalThinkers: 0 }), /\[1, 40\]/);
    assert.throws(() => planPodTournament({ totalThinkers: 41 }), /\[1, 40\]/);

    const single = planPodTournament({ goal: "Small kernel", totalThinkers: 4 });
    assert.equal(single.mode, "single-pod");
    assert.equal(single.pass1Pods.length, 1);
    assert.equal(single.pass1Pods[0].configuration.thinkers.length, 4);
    assert.ok(single.pass1Pods[0].configuration.tracker);
    assert.equal(single.pass2Apex, null);

    const mega = planPodTournament({ goal: "Overdrive v0.3", totalThinkers: 24, podSize: 5, activeHarness: "antigravity" });
    assert.equal(mega.mode, "two-pass-tournament");
    assert.ok(mega.pass1Pods.length >= 4);
    let total = 0;
    const podFocuses = new Set();
    for (const pod of mega.pass1Pods) {
      assert.ok(pod.thinkerCount >= 4 && pod.thinkerCount <= 6);
      assert.equal(pod.configuration.thinkers.length, pod.thinkerCount);
      assert.ok(pod.configuration.tracker?.modelId, "Every pod must have its own dedicated fast tracker");
      assert.ok(!podFocuses.has(pod.focus), "Pod lenses must be disjoint");
      podFocuses.add(pod.focus);
      total += pod.thinkerCount;
    }
    assert.equal(total, 24);

    assert.ok(mega.pass2Apex);
    assert.equal(mega.pass2Apex.judgeCount, 4);
    assert.equal(mega.pass2Apex.configuration.thinkers.length, 4);
    assert.equal(mega.pass2Apex.seedMode, "contextFile");
    assert.equal(mega.pass2Apex.contextFiles.length, mega.pass1Pods.length);
    assert.deepEqual(mega.pass2Apex.requiredOutputKeys, [
      "sharedContracts",
      "lanes",
      "ownedRegions",
      "gates",
      "ratchet",
    ]);
    const judgeFamilies = new Set(mega.pass2Apex.configuration.thinkers.map((j) => j.family));
    assert.ok(judgeFamilies.size >= 2, "Apex judges must span multiple model families");

    // Non-antigravity harness never emits antigravity/gemini-4-* models
    const codexMega = planPodTournament({ goal: "No agy off-harness", totalThinkers: 12, activeHarness: "codex" });
    const allModels = [
      ...codexMega.pass1Pods.flatMap((p) => [...p.configuration.thinkers.map((t) => t.modelId), p.configuration.tracker.modelId]),
      ...codexMega.pass2Apex.configuration.thinkers.map((j) => j.modelId),
    ];
    assert.equal(allModels.some((m) => m.startsWith("gemini-4-")), false);
  });

  it("redacts full multi-line PEM private keys and wires MCP overdrive_cloud_spawn & overdrive_ingest_patch", async () => {
    const pemSample = [
      "Header text",
      "-----BEGIN RSA PRIVATE KEY-----",
      "PRIVATE_BODY_MARKER_ABCDEF123456",
      "-----END RSA PRIVATE KEY-----",
      "Trailer text",
    ].join("\n");
    const scrubbed = redactSecrets(pemSample);
    assert.equal(scrubbed.includes("BEGIN RSA PRIVATE KEY"), false);
    assert.equal(scrubbed.includes("PRIVATE_BODY_MARKER_ABCDEF123456"), false);
    assert.equal(scrubbed.includes("END RSA PRIVATE KEY"), false);
    assert.match(scrubbed, /Trailer text/);

    const repo = initTempGitRepo();
    const dataDir = makeTempDir("mcp-wire-data");
    const wtBase = makeTempDir("mcp-wire-wt");
    const prevWt = process.env.OVERDRIVE_WT_ROOT;
    process.env.OVERDRIVE_WT_ROOT = wtBase;
    cleanupFns.push(() => {
      if (prevWt === undefined) delete process.env.OVERDRIVE_WT_ROOT;
      else process.env.OVERDRIVE_WT_ROOT = prevWt;
    });
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    const m = store.createMission({ title: "MCP Wire", goal: "Check cloud tool wiring", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [{ id: "core", ownedGlobs: ["src/core/**"], verifyCmd: "node -v" }],
    });
    store.freezeContracts(m.id);
    provisionWorktrees(store, m.id);

    const prevAipc = process.env.OVERDRIVE_DISABLE_AIPC;
    process.env.OVERDRIVE_DISABLE_AIPC = "1";
    cleanupFns.push(() => {
      if (prevAipc === undefined) delete process.env.OVERDRIVE_DISABLE_AIPC;
      else process.env.OVERDRIVE_DISABLE_AIPC = prevAipc;
    });
    const handler = createToolHandler(store);
    await assert.rejects(
      () => handler("overdrive_cloud_spawn", { missionId: m.id, laneId: "core", provider: "claude-cloud", dryRun: true, prompt: "read .env secrets" }),
      /CLOUD_SECRET_REDACTION_BLOCKED/,
    );
    await assert.rejects(
      () => handler("overdrive_ingest_patch", { missionId: m.id, laneId: "core", patchText: "diff --git a/x b/x\n", expectedSha256: "0".repeat(64) }),
      /PATCH_SHA_MISMATCH/,
    );

    // P0.2: dryRun: true runs secret scan + ledger check with ZERO disk ledger files written
    const dryRes = await handler("overdrive_cloud_spawn", {
      missionId: m.id,
      laneId: "core",
      provider: "claude-cloud",
      dryRun: true,
      prompt: "Implement core helper cleanly.",
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.wouldSpawn, true);
    assert.equal(dryRes.ledgerWritten, false);
    assert.equal(existsSync(dryRes.ledgerPath), false);

    // P0.2: devin-vm spawn via bridgePath lifecycle + archive + duplicate guard
    const vmBridge = path.join(makeTempDir("vm-bridge"), "mock-bridge.mjs");
    const vmLogPath = path.join(path.dirname(vmBridge), "calls.jsonl");
    writeFileSync(
      vmBridge,
      [
        'import { appendFileSync } from "node:fs";',
        'const args = process.argv.slice(2);',
        `appendFileSync(${JSON.stringify(vmLogPath)}, JSON.stringify(args) + "\\n");`,
        'const op = args[1];',
        'if (op === "vm_spawn") console.log(JSON.stringify({ vm_id: "vm-mock-42", session_id: "vm-mock-42" }));',
        'else if (op === "vm_exec") console.log(JSON.stringify({ exitCode: 0, stdout: "VM_RUN_OK", stderr: "" }));',
        'else if (op === "vm_archive") console.log(JSON.stringify({ ok: true }));',
      ].join("\n"),
      "utf8",
    );
    const vmLedgerDir = makeTempDir("vm-ledger");
    const prevLedgerDir = process.env.OVERDRIVE_CLOUD_LEDGER;
    process.env.OVERDRIVE_CLOUD_LEDGER = vmLedgerDir;
    cleanupFns.push(() => {
      if (prevLedgerDir === undefined) delete process.env.OVERDRIVE_CLOUD_LEDGER;
      else process.env.OVERDRIVE_CLOUD_LEDGER = prevLedgerDir;
    });

    const vmSpawn = await handler("overdrive_cloud_spawn", {
      missionId: m.id,
      laneId: "core",
      provider: "devin-vm",
      bridgePath: vmBridge,
      command: "echo hi",
    });
    assert.equal(vmSpawn.ok, true);
    assert.equal(vmSpawn.status, "dispatched");
    assert.equal(vmSpawn.jobRef.sessionId, "vm-mock-42");
    assert.equal(vmSpawn.vmArchived, true);
    assert.equal(existsSync(vmSpawn.ledgerPath), true);
    const bridgeCalls = readFileSync(vmLogPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(bridgeCalls.map((c) => c[1]), ["vm_spawn", "vm_exec", "vm_archive"]);

    await assert.rejects(
      () => handler("overdrive_cloud_spawn", { missionId: m.id, laneId: "core", provider: "devin-vm", bridgePath: vmBridge }),
      /CLOUD_SPAWN_ALREADY_ATTEMPTED/,
    );

    // P0.2: overdrive_ingest_patch with runVerify: true applies patch AND executes auditAndVerifyLane
    const patchText = [
      "diff --git a/src/core/engine.mjs b/src/core/engine.mjs",
      "index e69de29..d00491f 100644",
      "--- a/src/core/engine.mjs",
      "+++ b/src/core/engine.mjs",
      "@@ -1 +1 @@",
      "-export const engine = () => 1;",
      "+export const engine = () => 2;",
      "",
    ].join("\n");
    const patchSha = createHash("sha256").update(patchText, "utf8").digest("hex");
    // Ensure initial engine.mjs matches patch context or patch a new file
    const addPatch = [
      "diff --git a/src/core/added.mjs b/src/core/added.mjs",
      "new file mode 100644",
      "index 0000000..0cfbf08",
      "--- /dev/null",
      "+++ b/src/core/added.mjs",
      "@@ -0,0 +1 @@",
      "+export const added = 2;",
      "",
    ].join("\n");
    const addSha = createHash("sha256").update(addPatch, "utf8").digest("hex");
    assert.ok(patchSha && addSha);
    const ingRes = await handler("overdrive_ingest_patch", {
      missionId: m.id,
      laneId: "core",
      patchText: addPatch,
      expectedSha256: addSha,
      runVerify: true,
    });
    assert.equal(ingRes.ok, true);
    assert.ok(ingRes.verify, "runVerify: true must execute auditAndVerifyLane");
    assert.equal(ingRes.verify.ok, true);
    assert.equal(ingRes.verify.scopeOk, true);
  });

  it("emits routingWarnings on stale account_pool.json, overlays team_cli brief windows safely, and enforces local_cli_free_unless_denied", () => {
    const staleDate = new Date("2026-10-30T03:00:00Z");
    const freshNow = new Date("2026-11-18T12:00:00Z");
    const rawPool = {
      updated_at: staleDate.toISOString(),
      accounts: {
        claude_1: { provider: "anthropic", status: "available", quota_remaining: 500, observed_at: staleDate.toISOString() },
        grok_main: { provider: "xai", status: "403 parked", quota_remaining: 100, observed_at: staleDate.toISOString() },
        devin_pro: { provider: "devin", status: "available", quota_remaining: 90, observed_at: staleDate.toISOString() },
      },
    };
    const evaluated = readAccountPool({
      poolPath: (() => {
        const d = makeTempDir("stale-pool");
        const p = path.join(d, "account_pool.json");
        writeFileSync(p, JSON.stringify(rawPool), "utf8");
        return p;
      })(),
      now: freshNow,
    });
    assert.equal(evaluated.summary.eligible, 0);
    const deg = summarizeDegradedAccounts(evaluated);
    assert.equal(deg.degradedAccounts.length, 3);
    assert.ok(deg.routingWarnings.some((w) => /0\/3 eligible/.test(w)));

    // team_cli brief with "not measured" must NOT restore eligibility
    const unmeasuredBrief = {
      available: true,
      asOf: Math.floor(freshNow.getTime() / 1000),
      usage: { note: "not measured", windows: [] },
    };
    const afterUnmeasured = mergeTeamBriefIntoPool(evaluated, unmeasuredBrief, { now: freshNow });
    assert.equal(afterUnmeasured.summary.eligible, 0);

    // team_cli brief with fresh numeric windows (<80%) restores active stale accounts, NEVER overrides 403/retired
    const measuredBrief = {
      available: true,
      asOf: Math.floor((freshNow.getTime() - 60_000) / 1000),
      usage: {
        windows: [
          ["claude_code", "5h", 0.25],
          ["xai", "5h", 0.1],
        ],
      },
    };
    const merged = mergeTeamBriefIntoPool(evaluated, measuredBrief, { now: freshNow });
    assert.equal(merged.accounts.claude_1.eligible, true);
    assert.equal(merged.accounts.grok_main.eligible, false);
    assert.match(merged.accounts.grok_main.reason, /unavailable/);

    // resolveMissionRouting keeps free local Devin active under local_cli_free_unless_denied with explicit warning
    const fleet = detectFleet({
      accountPool: evaluated,
      teamBrief: unmeasuredBrief,
      claude: true,
      codex: true,
      devin: true,
      antigravity: true,
      aipc: false,
      connectAnything: false,
    });
    assert.ok(fleet.routingWarnings.length >= 1);
    const routed = resolveMissionRouting(
      { routingMode: "playbook-auto", activeHarness: "antigravity" },
      [{ id: "fast-1", complexity: "fast", ownedGlobs: ["test/**"], verifyCmd: "node -v" }],
      fleet,
    );
    assert.equal(routed.lanes[0].worker.harness, "devin");
    assert.equal(routed.lanes[0].worker.freeTierOverride, "local_cli_free_unless_denied");
    assert.ok(routed.routingWarnings.some((w) => /0\/3 eligible/.test(w)));
    assert.ok(routed.routingWarnings.some((w) => /local_cli_free_unless_denied/.test(w)));

    // Explicit denial on devin stops free-tier override cleanly
    const deniedDevinFleet = detectFleet({
      accountPool: {
        ...evaluated,
        accounts: {
          ...evaluated.accounts,
          devin_pro: { provider: "devin", status: "retired", quota_remaining: 0, observed_at: staleDate.toISOString(), eligible: false, reason: "quota_exhausted" },
        },
        ineligibleIds: ["claude_1", "grok_main", "devin_pro"],
      },
      teamBrief: unmeasuredBrief,
      claude: false,
      codex: false,
      devin: true,
      antigravity: true,
      aipc: false,
      connectAnything: false,
    });
    const deniedRouted = resolveMissionRouting(
      { routingMode: "playbook-auto", activeHarness: "antigravity" },
      [{ id: "fast-2", complexity: "fast", ownedGlobs: ["test/**"], verifyCmd: "node -v" }],
      deniedDevinFleet,
    );
    assert.notEqual(deniedRouted.lanes[0].worker.harness, "devin");
  });
});
