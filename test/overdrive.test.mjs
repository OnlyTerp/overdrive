import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildEscalationPacket, listAdhdSessions, readAdhdSessionDetail } from "../src/adhd-bridge.mjs";
import { install } from "../src/install.mjs";
import { TOOLS, createToolHandler, handleJsonRpc } from "../src/mcp.mjs";
import { fileMatchesAnyGlob, globOverlaps, validateTopology } from "../src/partition.mjs";
import { assertModelPolicy, resolveMissionRouting } from "../src/routing.mjs";
import { startStudioServer } from "../src/server.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { VERSION } from "../src/version.mjs";
import { auditAndVerifyLane, cleanupWorktrees, provisionWorktrees, runMissionGate } from "../src/worktree.mjs";
import { defaultTestScratchBase } from "../src/paths.mjs";

const TEST_SCRATCH_BASE = defaultTestScratchBase();
mkdirSync(TEST_SCRATCH_BASE, { recursive: true });

const cleanupFns = [];
afterEach(async () => {
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try {
      await fn();
    } catch {}
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(TEST_SCRATCH_BASE, `${prefix}-`));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initTempGitRepo() {
  const repo = makeTempDir("repo");
  const run = (...argv) => {
    const r = spawnSync("git", ["-C", repo, ...argv], { shell: false, windowsHide: true, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
  };
  run("init");
  run("config", "user.email", "overdrive-test@example.com");
  run("config", "user.name", "Overdrive Test");
  run("config", "core.autocrlf", "false");

  mkdirSync(path.join(repo, "src", "core"), { recursive: true });
  mkdirSync(path.join(repo, "src", "ui"), { recursive: true });
  writeFileSync(path.join(repo, "src", "contracts.mjs"), 'export const API_VERSION = 1;\n', "utf8");
  writeFileSync(path.join(repo, "src", "core", "engine.mjs"), "export const add = (a, b) => a + b;\n", "utf8");
  writeFileSync(path.join(repo, "src", "ui", "view.mjs"), "export const render = () => 'ok';\n", "utf8");
  run("add", "-A");
  run("commit", "-m", "initial commit");
  return repo;
}

describe("partition & collision engine", () => {
  it("detects exact, prefix, wildcard, and contract overlaps", () => {
    assert.equal(globOverlaps("src/core/**", "src/core/db.mjs"), true);
    assert.equal(globOverlaps("src/*.mjs", "src/contracts.mjs"), true);
    assert.equal(globOverlaps("src/core", "src/core/engine.mjs"), true);
    assert.equal(globOverlaps("src/core/**", "src/ui/**"), false);
    assert.equal(fileMatchesAnyGlob("src/core/sub/x.mjs", ["src/core/**"]), true);
    assert.equal(fileMatchesAnyGlob("src/ui/x.mjs", ["src/core/**"]), false);

    const bad = validateTopology({
      sharedContracts: ["src/contracts.mjs"],
      lanes: [
        { id: "a", ownedGlobs: ["src/**"], verifyCmd: "node -v" },
        { id: "b", ownedGlobs: ["src/ui/**"], verifyCmd: "node -v" },
      ],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.collisions.some((c) => c.kind === "contract_lane_overlap"));
    assert.ok(bad.collisions.some((c) => c.kind === "lane_lane_overlap"));

    const good = validateTopology({
      sharedContracts: ["src/contracts.mjs"],
      lanes: [
        { id: "core", ownedGlobs: ["src/core/**"], verifyCmd: "node -v" },
        { id: "ui", ownedGlobs: ["src/ui/**"], verifyCmd: "node -v" },
      ],
      gates: [{ id: "g1", cmd: "node -v" }],
    });
    assert.equal(good.ok, true);
    assert.equal(good.collisions.length, 0);
  });
});

describe("flexible routing & playbook policy", () => {
  const fakeFleet = {
    harnesses: {
      antigravity: { installed: true, family: "google" },
      codex: { installed: true, family: "openai" },
      claude: { installed: true, family: "anthropic" },
      devin: { installed: true, family: "devin" },
    },
    infra: { aipc: { ready: true, path: "/opt/remote-offload/offload.py" } },
  };

  it("supports single-harness, playbook-auto (free-first + cross-family), and mix-and-match", () => {
    const lanes = [
      { id: "kernel", complexity: "hard", ownedGlobs: ["src/core/**"], verifyCmd: "node -v", offload: "auto" },
      { id: "tests", complexity: "fast", ownedGlobs: ["test/**"], verifyCmd: "node -v", offload: "auto" },
    ];

    const s1 = resolveMissionRouting({ routingMode: "single-harness", activeHarness: "antigravity" }, lanes, fakeFleet);
    assert.equal(s1.lanes[0].worker.harness, "antigravity");
    assert.equal(s1.lanes[0].worker.model, "gemini-4-carbon");
    assert.equal(s1.lanes[1].worker.model, "gemini-4-hydrogen");

    const s2 = resolveMissionRouting({ routingMode: "playbook-auto", activeHarness: "antigravity" }, lanes, fakeFleet);
    assert.equal(s2.lanes[1].worker.harness, "devin");
    assert.equal(s2.lanes[1].worker.model, "swe-2-flash");
    assert.equal(s2.lanes[0].effectiveOffload, "aipc auto");
    assert.equal(s2.lanes[0].verifier.crossFamily, true);
    assert.notEqual(s2.lanes[0].verifier.family, s2.lanes[0].worker.family);

    const mixLanes = [
      { id: "kernel", complexity: "hard", ownedGlobs: ["src/core/**"], verifyCmd: "node -v", worker: { harness: "claude", model: "claude-opus-5-5", effort: "high" } },
      { id: "ui", complexity: "fast", ownedGlobs: ["src/ui/**"], verifyCmd: "node -v" },
    ];
    const s3 = resolveMissionRouting({ routingMode: "mix-and-match", activeHarness: "antigravity" }, mixLanes, fakeFleet);
    assert.equal(s3.lanes[0].worker.harness, "claude");
    assert.equal(s3.lanes[1].worker.harness, "devin");
  });

  it("rejects cancelled/banned models and antigravity routes outside antigravity", () => {
    assert.throws(() => assertModelPolicy({ harness: "claude", model: "kimi-k2" }), /Policy violation/);
    assert.throws(() => assertModelPolicy({ harness: "opencode", provider: "lithos", model: "gpt-6" }), /Policy violation/);
    assert.throws(() => assertModelPolicy({ harness: "omp", model: "gemini-4-carbon" }), /only run inside Antigravity/);
  });
});

describe("git worktree freeze, scope audit, negative controls & escalation", () => {
  it("enforces disjoint ownership, catches contract tampering, and builds escalation evidence", () => {
    const repo = initTempGitRepo();
    const dataDir = makeTempDir("data");
    const wtBase = makeTempDir("wt");
    const prevWt = process.env.OVERDRIVE_WT_ROOT;
    const prevAipc = process.env.OVERDRIVE_DISABLE_AIPC;
    process.env.OVERDRIVE_WT_ROOT = wtBase;
    process.env.OVERDRIVE_DISABLE_AIPC = "1";
    cleanupFns.push(() => {
      if (prevWt === undefined) delete process.env.OVERDRIVE_WT_ROOT;
      else process.env.OVERDRIVE_WT_ROOT = prevWt;
      if (prevAipc === undefined) delete process.env.OVERDRIVE_DISABLE_AIPC;
      else process.env.OVERDRIVE_DISABLE_AIPC = prevAipc;
    });

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({
      title: "Engine & UI Split",
      goal: "Verify strict isolation across lanes",
      repoRoot: repo,
      routingMode: "playbook-auto",
      activeHarness: "antigravity",
    });

    const planned = store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs", description: "Frozen API version" }],
      lanes: [
        {
          id: "core",
          title: "Core math",
          complexity: "hard",
          ownedGlobs: ["src/core/**"],
          verifyCmd: "node -e \"console.log('CORE_OK')\"",
        },
        {
          id: "ui",
          title: "UI view",
          complexity: "fast",
          ownedGlobs: ["src/ui/**"],
          verifyCmd: "node -e \"console.log('UI_OK')\"",
        },
      ],
      gates: [{ id: "g-final", title: "Final check", cmd: "node -e \"console.log('GATE_OK')\"", offload: "local" }],
    });
    assert.equal(planned.ok, true);

    store.freezeContracts(m.id);
    const { mission: frozen, briefs } = provisionWorktrees(store, m.id);
    assert.equal(frozen.state, "swarming");
    assert.ok(briefs.core.includes("src/core/**"));
    const coreWt = frozen.lanes.find((l) => l.id === "core").worktreePath;
    const uiWt = frozen.lanes.find((l) => l.id === "ui").worktreePath;

    // Valid edit inside core lane -> PASS
    writeFileSync(path.join(coreWt, "src", "core", "engine.mjs"), "export const add = (a, b) => Number(a) + Number(b);\n", "utf8");
    const okCore = auditAndVerifyLane(store, m.id, "core", { runCmd: true });
    assert.equal(okCore.result.ok, true);
    assert.equal(okCore.result.scopeOk, true);

    // Negative control 1: UI lane edits out-of-scope file -> SCOPE_VIOLATION
    writeFileSync(path.join(uiWt, "src", "core", "sneaky.mjs"), "export const bad = 1;\n", "utf8");
    const badScope = auditAndVerifyLane(store, m.id, "ui", { runCmd: true });
    assert.equal(badScope.result.ok, false);
    assert.equal(badScope.result.scopeOk, false);
    assert.match(badScope.result.violation, /SCOPE_VIOLATION/);

    const esc = buildEscalationPacket(store.getMission(m.id), { laneId: "ui" });
    assert.equal(esc.status, "observed");
    assert.match(esc.text, /SCOPE_VIOLATION/);

    // Negative control 2: Repair sneaky file, but tamper frozen contract -> CONTRACT_TAMPERED
    rmSync(path.join(uiWt, "src", "core", "sneaky.mjs"));
    writeFileSync(path.join(uiWt, "src", "contracts.mjs"), "export const API_VERSION = 999;\n", "utf8");
    const badContract = auditAndVerifyLane(store, m.id, "ui", { runCmd: true });
    assert.equal(badContract.result.ok, false);
    assert.match(badContract.result.violation, /CONTRACT_TAMPERED/);

    // Clean UI lane + gate pass -> completed + worktree cleanup
    writeFileSync(path.join(uiWt, "src", "contracts.mjs"), "export const API_VERSION = 1;\n", "utf8");
    writeFileSync(path.join(uiWt, "src", "ui", "view.mjs"), "export const render = () => 'overdrive';\n", "utf8");
    const okUi = auditAndVerifyLane(store, m.id, "ui", { runCmd: true });
    assert.equal(okUi.result.ok, true);

    const gateOut = runMissionGate(store, m.id, "g-final", { cleanupAfterPass: true });
    assert.equal(gateOut.result.ok, true);
    assert.equal(gateOut.mission.state, "completed");
    assert.equal(existsSync(coreWt), false);
    cleanupWorktrees(store, m.id);
  });
});

describe("ADHD bridge, HTTP studio security & stdio MCP", () => {
  it("reads live ADHD sessions if present and enforces studio token/Host/CSP security", async () => {
    const adhdList = listAdhdSessions();
    if (adhdList.available && adhdList.sessions.length > 0) {
      const target = adhdList.sessions.find((s) => s.id === "fb6e6864-c111-413b-8e56-a18d179697c9") || adhdList.sessions[0];
      const detail = readAdhdSessionDetail(target.id);
      assert.ok(detail);
      assert.ok(detail.goal.length > 0);
    }

    const dataDir = makeTempDir("studio-data");
    const store = new OverdriveStore(dataDir);
    const srv = await startStudioServer(store, { port: 0, fixedPort: false });
    cleanupFns.push(async () => {
      await srv.close();
      store.close();
    });

    // Public shell returns 200 with strict CSP (no inline script/style allowed)
    const homeRes = await fetch(`${srv.origin}/`);
    assert.equal(homeRes.status, 200);
    const csp = homeRes.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("'unsafe-inline'"));

    const cssRes = await fetch(`${srv.origin}/styles.css`);
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(`${srv.origin}/app.js`);
    assert.equal(jsRes.status, 200);

    // Unauthenticated API refused with 403
    const noTok = await fetch(`${srv.origin}/api/state`);
    assert.equal(noTok.status, 403);

    // Cross-origin POST refused with 403 even with valid token
    const badOrigin = await fetch(`${srv.origin}/api/missions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "X-Overdrive-Token": srv.token,
      },
      body: JSON.stringify({ title: "x", goal: "y", repoRoot: dataDir }),
    });
    assert.equal(badOrigin.status, 403);

    // Valid token GET /api/state returns 200
    const okState = await fetch(`${srv.origin}/api/state`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(okState.status, 200);
    const stateJson = await okState.json();
    assert.equal(stateJson.version, VERSION);
  });

  it("handles MCP initialize, tools/list, and overdrive_status over stdio", async () => {
    const dataDir = makeTempDir("mcp-data");
    const store = new OverdriveStore(dataDir);
    const handler = createToolHandler(store);
    const init = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, handler);
    assert.equal(init.result.serverInfo.name, "overdrive");
    store.close();

    // Live child process stdio round-trip
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["bin/overdrive.mjs", "mcp", "--data", dataDir], {
        cwd: path.resolve(import.meta.dirname, ".."),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.on("error", reject);

      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "overdrive_status", arguments: {} } }) + "\n");
      child.stdin.end();
    });
    assert.equal(out.code, 0, out.stderr);
    const replies = out.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(replies.length, 3);
    assert.equal(replies[1].result.tools.length, 17);
    assert.equal(replies[1].result.tools.length, TOOLS.length);
    const toolNames = new Set(replies[1].result.tools.map((t) => t.name));
    assert.ok(toolNames.has("overdrive_pod_plan"));
    assert.ok(toolNames.has("overdrive_assistants"));
    assert.ok(toolNames.has("overdrive_rsi_audit"));
    assert.ok(replies[2].result.structuredContent.version);

    const store2 = new OverdriveStore(dataDir);
    cleanupFns.push(() => store2.close());
    const h2 = createToolHandler(store2);
    const statusWithRsi = await h2("overdrive_status", { includeRsi: true });
    assert.ok(statusWithRsi.rsiOverview?.digest);
    assert.ok(Array.isArray(statusWithRsi.routingWarnings));
    assert.ok(Array.isArray(statusWithRsi.degradedAccounts));
    const podPlan = await h2("overdrive_pod_plan", { goal: "Scale architecture", totalThinkers: 10 });
    assert.equal(podPlan.mode, "two-pass-tournament");
    const asst = await h2("overdrive_assistants", { role: "research" });
    assert.ok(asst.pool);
    assert.ok(asst.selection);
  });

  it("supports isolated dry-run/sandbox install into temp home without touching real user configs", async () => {
    const fakeHome = makeTempDir("fake-home");
    mkdirSync(path.join(fakeHome, ".gemini", "config"), { recursive: true });
    mkdirSync(path.join(fakeHome, ".cursor"), { recursive: true });
    const prev = process.env.OVERDRIVE_INSTALL_HOME;
    process.env.OVERDRIVE_INSTALL_HOME = fakeHome;
    cleanupFns.push(() => {
      if (prev === undefined) delete process.env.OVERDRIVE_INSTALL_HOME;
      else process.env.OVERDRIVE_INSTALL_HOME = prev;
    });

    const dry = await install({ harnesses: ["cursor"], dryRun: true });
    assert.equal(dry[0].ok, true);
    assert.match(dry[0].message, /would update/);

    const real = await install({ harnesses: ["cursor"] });
    assert.equal(real[0].ok, true);
    const cursorCfg = JSON.parse(readFileSync(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorCfg.mcpServers.overdrive);
  });
});
