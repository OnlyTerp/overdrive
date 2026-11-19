import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireSlot, isPidAlive, runWithCompute, withSlot } from "../src/compute.mjs";
import { integrateMission } from "../src/integrate.mjs";
import { createToolHandler } from "../src/mcp.mjs";
import {
  evaluateRatchet,
  extractOverdriveMetrics,
  loadPrivateHoldout,
  privateHoldoutPath,
  savePrivateHoldout,
} from "../src/ratchet.mjs";
import { detectFleet, resolveMissionRouting } from "../src/routing.mjs";
import {
  ANCHOR_ERRORS,
  mergeRegions,
  resolveRegionInBase,
  validateBaseSeams,
  verifyLaneRegionContainment,
} from "../src/seam.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { validateRatchetResult, validateRatchetSpec } from "../src/ui-contracts.mjs";
import {
  auditAndVerifyLane,
  buildLaneBrief,
  cleanupWorktrees,
  DEFAULT_IGNORE_UNTRACKED_GLOBS,
  laneScratchEnv,
  mountReadOnlyJunctions,
  provisionWorktrees,
  runMissionGate,
  unmountJunctionSafe,
} from "../src/worktree.mjs";
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

function setTempEnv(key, value) {
  const prev = process.env[key];
  process.env[key] = value;
  cleanupFns.push(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function runGit(cwd, ...argv) {
  const r = spawnSync("git", ["-C", cwd, ...argv], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r;
}

function initMonolithRepo() {
  const repo = makeTempDir("sys-repo");
  runGit(repo, "init");
  runGit(repo, "config", "user.email", "systems-test@example.com");
  runGit(repo, "config", "user.name", "Systems Test");
  runGit(repo, "config", "core.autocrlf", "false");

  mkdirSync(path.join(repo, "src", "core"), { recursive: true });
  mkdirSync(path.join(repo, "src", "ui"), { recursive: true });
  mkdirSync(path.join(repo, "bin"), { recursive: true });

  writeFileSync(path.join(repo, "src", "contracts.mjs"), "export const API_VERSION = 3;\n", "utf8");
  writeFileSync(path.join(repo, "src", "core", "calc.mjs"), "export const score = () => 96;\n", "utf8");
  writeFileSync(path.join(repo, "src", "ui", "badge.mjs"), "export const badge = () => 'v3';\n", "utf8");
  writeFileSync(path.join(repo, "tracked.log"), "initial tracked log\n", "utf8");
  // Adjacent anchor boundaries (END_A immediately followed by BEGIN_B) so git diff3 conflicts!
  writeFileSync(
    path.join(repo, "bin", "monolith.mjs"),
    [
      "// HEADER",
      "// BEGIN_A",
      "export const partA = 'base-a';",
      "// END_A",
      "// BEGIN_B",
      "export const partB = 'base-b';",
      "// END_B",
      "// FOOTER",
      "",
    ].join("\n"),
    "utf8",
  );

  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-m", "initial commit");
  return repo;
}

describe("v0.3.0 ratchet extraction, evaluation & private holdout isolation", () => {
  it("enforces exact single OVERDRIVE_METRICS_JSON emit, finite numbers, nonce & requiredKeys", () => {
    const ok = extractOverdriveMetrics(
      "noise\nOVERDRIVE_METRICS_JSON:[nonce=abc-1]: {\"parity\": 97.5, \"cases\": 40}\ndone\n",
      { expectedNonce: "abc-1", requiredKeys: ["parity", "cases"] },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.nonce, "abc-1");
    assert.deepEqual(ok.metrics, { parity: 97.5, cases: 40 });

    // Missing emit
    const missing = extractOverdriveMetrics("just plain stdout\n");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "METRICS_MISSING");

    // Multi-emit spoof rejection
    const multi = extractOverdriveMetrics(
      "OVERDRIVE_METRICS_JSON: {\"parity\": 50}\nOVERDRIVE_METRICS_JSON: {\"parity\": 99}\n",
    );
    assert.equal(multi.ok, false);
    assert.equal(multi.code, "METRICS_AMBIGUOUS_MULTI_EMIT");

    // Array / null / malformed JSON rejection
    const arr = extractOverdriveMetrics("OVERDRIVE_METRICS_JSON: [1, 2, 3]\n");
    assert.equal(arr.ok, false);
    assert.equal(arr.code, "METRICS_INVALID_JSON");

    const nil = extractOverdriveMetrics("OVERDRIVE_METRICS_JSON: null\n");
    assert.equal(nil.ok, false);
    assert.equal(nil.code, "METRICS_INVALID_JSON");

    // Non-finite numbers (1e500 -> Infinity in JSON.parse; "NaN" string; null value)
    const infRes = extractOverdriveMetrics("OVERDRIVE_METRICS_JSON: {\"parity\": 1e500}\n");
    assert.equal(infRes.ok, false);
    assert.equal(infRes.code, "METRICS_NON_FINITE");

    const nanStr = extractOverdriveMetrics("OVERDRIVE_METRICS_JSON: {\"parity\": \"NaN\"}\n");
    assert.equal(nanStr.ok, false);
    assert.equal(nanStr.code, "METRICS_NON_FINITE");

    // Nonce mismatch and missing required key
    const badNonce = extractOverdriveMetrics(
      "OVERDRIVE_METRICS_JSON:[nonce=wrong]: {\"parity\": 99}\n",
      { expectedNonce: "right" },
    );
    assert.equal(badNonce.ok, false);
    assert.equal(badNonce.code, "METRICS_NONCE_MISMATCH");

    const missKey = extractOverdriveMetrics("OVERDRIVE_METRICS_JSON: {\"parity\": 99}\n", {
      requiredKeys: ["parity", "cases"],
    });
    assert.equal(missKey.ok, false);
    assert.equal(missKey.code, "METRICS_MISSING_KEY");
  });

  it("evaluates operators, coverageFloor, bad-exit spoof, regression fail-closed & private holdouts", () => {
    const spec = {
      metrics: [
        { name: "parity", baseline: 95, op: ">=", maxRegression: 0.5 },
        { name: "latencyMs", baseline: 120, op: "<=", tolerance: 10 },
        { name: "exact", target: 7, op: "==", tolerance: 0 },
        { name: "gain", baseline: 10, target: 2, op: "delta>=" },
        { name: "errs", baseline: 5, target: -1, op: "delta<=" },
      ],
      coverageFloor: { countMetric: "cases", minValue: 20 },
      holdoutCmd: "node secret-holdout.mjs",
    };

    // Passing evaluation
    const good = evaluateRatchet(spec, {
      exitCode: 0,
      stdout:
        'OVERDRIVE_METRICS_JSON: {"parity": 94.6, "latencyMs": 128, "exact": 7, "gain": 12.5, "errs": 3, "cases": 25}\n',
      holdoutExitCode: 0,
      holdoutMetrics: { parity: 96, latencyMs: 115, exact: 7, gain: 13, errs: 2 },
    });
    assert.equal(good.ok, true);
    assert.equal(good.holdoutConfigured, true);
    assert.equal(good.holdoutPassed, true);
    assert.equal(good.holdoutCmd, undefined);
    assert.equal(good.spec.holdoutCmd, undefined);
    assert.equal(validateRatchetResult(good).ok, true);

    // Bad-exit spoof rejection: metrics look great, but command exited 1
    const badExit = evaluateRatchet(spec, {
      exitCode: 1,
      stdout:
        'OVERDRIVE_METRICS_JSON: {"parity": 99, "latencyMs": 50, "exact": 7, "gain": 20, "errs": 0, "cases": 50}\n',
    });
    assert.equal(badExit.ok, false);
    assert.match(badExit.violation, /EXIT_NONZERO/);
    assert.equal(validateRatchetResult(badExit).ok, true);

    // exitCode === 0 with regressed metric -> METRIC_REGRESSION fail-closed
    const regressed = evaluateRatchet(spec, {
      exitCode: 0,
      stdout:
        'OVERDRIVE_METRICS_JSON: {"parity": 93.0, "latencyMs": 120, "exact": 7, "gain": 12, "errs": 4, "cases": 25}\n',
    });
    assert.equal(regressed.ok, false);
    assert.match(regressed.violation, /^METRIC_REGRESSION:/);
    assert.equal(validateRatchetResult(regressed).ok, true);

    // coverageFloor violation
    const lowCov = evaluateRatchet(spec, {
      exitCode: 0,
      stdout:
        'OVERDRIVE_METRICS_JSON: {"parity": 96, "latencyMs": 110, "exact": 7, "gain": 12, "errs": 4, "cases": 5}\n',
    });
    assert.equal(lowCov.ok, false);
    assert.match(lowCov.violation, /COVERAGE_FLOOR_VIOLATION/);
    assert.equal(validateRatchetResult(lowCov).ok, true);

    // Holdout failure fails result cleanly without leaking holdout keys
    const badHoldout = evaluateRatchet(spec, {
      exitCode: 0,
      stdout:
        'OVERDRIVE_METRICS_JSON: {"parity": 98, "latencyMs": 100, "exact": 7, "gain": 13, "errs": 3, "cases": 30}\n',
      holdoutExitCode: 1,
    });
    assert.equal(badHoldout.ok, false);
    assert.equal(badHoldout.holdoutPassed, false);
    assert.equal(badHoldout.holdoutCmd, undefined);
    assert.equal(validateRatchetResult(badHoldout).ok, true);

    // Private holdout persistence under OVERDRIVE_PRIVATE_DIR
    const privDir = makeTempDir("priv-holdout");
    setTempEnv("OVERDRIVE_PRIVATE_DIR", privDir);
    const savedPath = savePrivateHoldout("mission-xyz", "lane:core", {
      holdoutCmd: "node secret_eval.mjs --token=supersecret",
      metrics: [{ name: "parity", baseline: 95, op: ">=" }],
    });
    assert.ok(savedPath.startsWith(privDir.replaceAll("\\", "/")));
    assert.equal(privateHoldoutPath("mission-xyz"), savedPath);
    const loaded = loadPrivateHoldout("mission-xyz", "lane:core");
    assert.equal(loaded.holdoutCmd, "node secret_eval.mjs --token=supersecret");
  });

  it("strips holdoutCmd from buildLaneBrief and fails lane on exitCode 0 metric regression in auditAndVerifyLane", () => {
    const repo = initMonolithRepo();
    const dataDir = makeTempDir("ratchet-data");
    const wtBase = makeTempDir("ratchet-wt");
    const lockDir = makeTempDir("ratchet-locks");
    const scratchBase = makeTempDir("ratchet-scratch");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({ title: "Ratchet Lane Test", goal: "Fail closed on regression", repoRoot: repo });
    const ratchetSpec = {
      metrics: [{ name: "parity", baseline: 95, op: ">=", maxRegression: 0 }],
      holdoutCmd: "node secret_holdout_check.mjs",
    };
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "core",
          title: "Core",
          ownedGlobs: ["src/core/**"],
          offload: "local",
          ratchet: ratchetSpec,
          verifyCmd:
            "node -e \"console.log(JSON.stringify({temp:process.env.TEMP,scratch:process.env.OVERDRIVE_SCRATCH_DIR,art:process.env.ANTIGRAVITY_ARTIFACTS_DIR})); console.log('OVERDRIVE_METRICS_JSON: ' + JSON.stringify({parity: 91.2}))\"",
        },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: frozen } = provisionWorktrees(store, m.id);
    const lane = frozen.lanes[0];
    const brief = buildLaneBrief(frozen, { ...lane, ratchet: ratchetSpec });
    assert.equal(brief.includes("secret_holdout_check"), false);
    assert.equal(brief.includes("holdoutCmd"), false);
    assert.match(brief, /holdoutConfigured/);
    assert.ok(brief.includes(scratchBase.replaceAll("\\", "/")), "brief must include configured scratch workspace");
    assert.match(brief, /isolated per lane/);

    // Verify laneScratchEnv paths & METRIC_REGRESSION fail-closed on exitCode === 0
    const ver = auditAndVerifyLane(store, m.id, "core", {
      runCmd: true,
      ratchet: ratchetSpec,
      lockDir,
    });
    assert.equal(ver.result.exitCode, 0);
    assert.equal(ver.result.ok, false);
    assert.match(ver.result.violation, /^METRIC_REGRESSION:/);
    assert.equal(ver.mission.lanes[0].status, "failed");
    assert.equal(validateRatchetResult(ver.result.ratchet).ok, true);
    assert.equal(validateRatchetSpec(ver.result.ratchet.spec, { allowHoldout: false }).ok, true);
    const envTail = JSON.parse(ver.result.stdoutTail.trim().split(/\r?\n/)[0]);
    assert.ok(envTail.scratch.startsWith(scratchBase.replaceAll("\\", "/")));
    assert.ok(envTail.temp.startsWith(scratchBase.replaceAll("\\", "/")));
    assert.ok(envTail.art.startsWith(scratchBase.replaceAll("\\", "/")));

    cleanupWorktrees(store, m.id);
  });
});

describe("v0.3.0 compute semaphores, stale-PID reaper, aipc & devin-vm cleanup", () => {
  it("enforces cross-process slot limits, waits cleanly, and reaps stale dead-PID lockfiles", async () => {
    const lockDir = makeTempDir("sem-locks");

    // 1. Default limits: aipc allows 2 concurrent slots; 3rd rejects with SLOT_BUSY
    const s1 = acquireSlot("aipc", { lockDir });
    const s2 = acquireSlot("aipc", { lockDir });
    assert.throws(() => acquireSlot("aipc", { lockDir, waitMs: 60 }), /SLOT_BUSY/);
    s1.release();
    const s3 = acquireSlot("aipc", { lockDir, waitMs: 50 });
    s2.release();
    s3.release();

    // 2. Stale dead-PID reaper: spawn a process that exits immediately, write lockfile with dead PID
    const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"], { shell: false, windowsHide: true });
    assert.equal(isPidAlive(deadChild.pid), false);
    const staleLockPath = path.join(lockDir, "local-heavy.slot-0.lock");
    writeFileSync(
      staleLockPath,
      JSON.stringify({ pid: deadChild.pid, resourceKey: "local-heavy", slot: 0, acquiredAt: Date.now(), nonce: "dead" }),
      "utf8",
    );
    const reapedSlot = acquireSlot("local-heavy", { lockDir, waitMs: 100 });
    assert.equal(reapedSlot.pid, process.pid);
    reapedSlot.release();

    // 3. Cross-process contention: child holds local-heavy for 250ms then releases; parent waits & acquires
    const holdScript = [
      `import { acquireSlot } from ${JSON.stringify(new URL("../src/compute.mjs", import.meta.url).href)};`,
      `const s = acquireSlot("local-heavy", { lockDir: ${JSON.stringify(lockDir)}, waitMs: 100 });`,
      `console.log("HELD");`,
      `setTimeout(() => { s.release(); process.exit(0); }, 250);`,
    ].join(" ");
    const child = spawn(process.execPath, ["--input-type=module", "-e", holdScript], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("HELD")) resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!buf.includes("HELD")) reject(new Error(`child exited ${code}`));
      });
    });

    // While child holds slot, short waitMs fails; longer waitMs acquires after child releases
    assert.throws(() => acquireSlot("local-heavy", { lockDir, waitMs: 40 }), /SLOT_BUSY/);
    const waited = acquireSlot("local-heavy", { lockDir, waitMs: 3000 });
    waited.release();
    await new Promise((resolve) => child.on("close", resolve));

    // 4. withSlot releases on thrown error
    assert.throws(
      () =>
        withSlot("aipc-gpu", { lockDir }, () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    const afterErr = acquireSlot("aipc-gpu", { lockDir, waitMs: 10 });
    afterErr.release();
  });

  it("routes aipc / aipc-gpu without OVERDRIVE_ALLOW_AIPC, falls back local, and guarantees devin-vm archive", async () => {
    const lockDir = makeTempDir("compute-locks");
    const workDir = makeTempDir("compute-cwd");
    const mockAipc = path.join(workDir, "mock_aipc.py");
    writeFileSync(
      mockAipc,
      [
        "import sys, json",
        'print("MOCK_AIPC_ARGS:" + json.dumps(sys.argv[1:]))',
      ].join("\n"),
      "utf8",
    );

    const prevAllow = process.env.OVERDRIVE_ALLOW_AIPC;
    delete process.env.OVERDRIVE_ALLOW_AIPC;
    cleanupFns.push(() => {
      if (prevAllow !== undefined) process.env.OVERDRIVE_ALLOW_AIPC = prevAllow;
    });

    // aipc-gpu routes directly to python mock_aipc.py auto --gpu -- cmd without OVERDRIVE_ALLOW_AIPC
    const gpuRes = runWithCompute("echo gpu-ok", {
      cwd: workDir,
      offload: "aipc-gpu",
      aipcScript: mockAipc,
      lockDir,
    });
    assert.equal(gpuRes.ok, true);
    assert.equal(gpuRes.machine, "aipc-gpu");
    const argsLine = gpuRes.stdout.trim().replace(/^MOCK_AIPC_ARGS:/, "");
    assert.deepEqual(JSON.parse(argsLine), ["auto", "--gpu", "--", "echo gpu-ok"]);

    // P0.3: offload: "auto" dispatches through aipc auto when OVERDRIVE_DISABLE_AIPC is not "1", matching routing.mjs!
    const prevDisableAipc = process.env.OVERDRIVE_DISABLE_AIPC;
    delete process.env.OVERDRIVE_DISABLE_AIPC;
    cleanupFns.push(() => {
      if (prevDisableAipc !== undefined) process.env.OVERDRIVE_DISABLE_AIPC = prevDisableAipc;
      else delete process.env.OVERDRIVE_DISABLE_AIPC;
    });
    const fakeFleetAipc = {
      harnesses: {
        antigravity: { installed: true, family: "google" },
        codex: { installed: true, family: "openai" },
        claude: { installed: true, family: "anthropic" },
        devin: { installed: true, family: "devin" },
      },
      infra: { aipc: { ready: true, path: mockAipc } },
    };
    const autoRoute = resolveMissionRouting(
      { routingMode: "playbook-auto", activeHarness: "antigravity" },
      [{ id: "core", complexity: "hard", ownedGlobs: ["src/**"], verifyCmd: "echo auto-ok", offload: "auto" }],
      fakeFleetAipc,
    );
    assert.equal(autoRoute.lanes[0].effectiveOffload, "aipc auto");
    const autoRes = runWithCompute("echo auto-ok", {
      cwd: workDir,
      offload: "auto",
      aipcScript: mockAipc,
      lockDir,
    });
    assert.equal(autoRes.ok, true);
    assert.equal(autoRes.machine, "aipc-auto");
    const autoArgsLine = autoRes.stdout.trim().replace(/^MOCK_AIPC_ARGS:/, "");
    assert.deepEqual(JSON.parse(autoArgsLine), ["auto", "--", "echo auto-ok"]);

    process.env.OVERDRIVE_DISABLE_AIPC = "1";
    const autoDisabledRes = runWithCompute("node -e \"console.log('DISABLED_AUTO_LOCAL')\"", {
      cwd: workDir,
      offload: "auto",
      aipcScript: mockAipc,
      lockDir,
    });
    assert.equal(autoDisabledRes.ok, true);
    assert.equal(autoDisabledRes.machine, "local");
    delete process.env.OVERDRIVE_DISABLE_AIPC;

    // Missing aipcScript falls back cleanly to local PowerShell/sh
    const fbRes = runWithCompute("node -e \"console.log('LOCAL_FALLBACK')\"", {
      cwd: workDir,
      offload: "aipc",
      aipcScript: path.join(workDir, "does-not-exist.py"),
      lockDir,
    });
    assert.equal(fbRes.ok, true);
    assert.equal(fbRes.machine, "local");
    assert.match(fbRes.stdout, /LOCAL_FALLBACK/);

    // devin-vm guarantees try ... finally archive even when exec throws
    let archivedId = null;
    await assert.rejects(
      async () =>
        runWithCompute("pytest", {
          cwd: workDir,
          offload: "devin-vm",
          lockDir,
          runner: {
            async spawn() {
              return { session_id: "vm-999" };
            },
            async exec() {
              throw new Error("VM_EXEC_CRASH");
            },
            async archive(id) {
              archivedId = id;
            },
          },
        }),
      /VM_EXEC_CRASH/,
    );
    assert.equal(archivedId, "vm-999");

    // Slot was also released in finally despite thrown error
    const slotAfterCrash = acquireSlot("devin-vm", { lockDir, waitMs: 50 });
    slotAfterCrash.release();
  });

  it("allows ancestor-to-descendant slot reentrancy without self-deadlock and ignores dead-PID tokens", async () => {
    const lockDir = makeTempDir("reentrant-locks");
    const workDir = makeTempDir("reentrant-cwd");
    const computeUrl = new URL("../src/compute.mjs", import.meta.url).href;
    const childScript = path.join(workDir, "child.mjs");
    writeFileSync(
      childScript,
      [
        `import { runWithCompute } from ${JSON.stringify(computeUrl)};`,
        `const res = runWithCompute("node -e \\"console.log('CHILD_OK')\\"", {`,
        `  cwd: ${JSON.stringify(workDir)},`,
        `  offload: "local",`,
        `  lockDir: ${JSON.stringify(lockDir)},`,
        `  limit: 1,`,
        `  waitMs: 50,`,
        `});`,
        `if (res.exitCode !== 0 || !res.stdout.includes("CHILD_OK")) process.exit(2);`,
        `console.log("NESTED_RUN_OK");`,
      ].join("\n"),
      "utf8",
    );

    const parentRes = runWithCompute(`node "${childScript}"`, {
      cwd: workDir,
      offload: "local",
      lockDir,
      limit: 1,
      waitMs: 1000,
    });
    assert.equal(parentRes.exitCode, 0);
    assert.match(parentRes.stdout, /NESTED_RUN_OK/);

    // Negative control: dead-PID token in OVERDRIVE_HELD_SLOTS does NOT bypass a live holder.
    const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"], { shell: false, windowsHide: true });
    assert.ok(deadChild && deadChild.pid > 0);
    const deadPid = deadChild.pid;
    const heldSlot = acquireSlot("local-heavy", { lockDir, limit: 1, waitMs: 50 });
    try {
      const resolved = path.resolve(lockDir);
      const normRoot = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const forgedEnv = {
        OVERDRIVE_HELD_SLOTS: JSON.stringify([{ token: `local-heavy@${normRoot}`, pid: deadPid }]),
      };
      await assert.rejects(
        async () =>
          runWithCompute("echo should-block", {
            cwd: workDir,
            offload: "local",
            lockDir,
            limit: 1,
            waitMs: 50,
            env: forgedEnv,
          }),
        /SLOT_BUSY/,
      );
    } finally {
      heldSlot.release();
    }
  });
});

describe("v0.3.0 seam regions, untracked ignore globs & junction safety", () => {
  it("enforces anchor uniqueness, line-ending preservation, non-overlap & deterministic mergeRegions", () => {
    const baseCRLF = [
      "// HEADER",
      "// BEGIN_A",
      "const a = 1;",
      "// END_A",
      "// BEGIN_B",
      "const b = 2;",
      "// END_B",
      "// FOOTER",
    ].join("\r\n");

    const regA = { path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" };
    const regB = { path: "bin/monolith.mjs", startAnchor: "// BEGIN_B", endAnchor: "// END_B" };

    // Missing & ambiguous anchor checks
    assert.throws(() => resolveRegionInBase(baseCRLF, { startAnchor: "// NOPE", endAnchor: "// END_A" }), /ANCHOR_MISSING/);
    assert.throws(
      () => resolveRegionInBase(`${baseCRLF}\r\n// BEGIN_A`, regA),
      /ANCHOR_AMBIGUOUS/,
    );
    assert.throws(
      () => resolveRegionInBase(baseCRLF, { startAnchor: "// END_A", endAnchor: "// BEGIN_A" }),
      /ANCHOR_ORDER/,
    );

    // Adjacent regions (END_A on line 3, BEGIN_B on line 4) pass validateBaseSeams
    const seamOk = validateBaseSeams(() => baseCRLF, [
      { id: "a", ownedRegions: [regA] },
      { id: "b", ownedRegions: [regB] },
    ]);
    assert.equal(seamOk.ok, true);

    // Overlapping regions fail with ANCHOR_OVERLAP
    const seamOverlap = validateBaseSeams(() => baseCRLF, [
      { id: "a", ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_B" }] },
      { id: "b", ownedRegions: [regB] },
    ]);
    assert.equal(seamOverlap.ok, false);
    assert.equal(seamOverlap.code, ANCHOR_ERRORS.ANCHOR_OVERLAP);

    // Containment positive & negative controls
    const laneAText = baseCRLF.replace("const a = 1;", "const a = 100;\r\nconst a2 = 200;");
    const laneBText = baseCRLF.replace("const b = 2;", "const b = 999;");
    assert.equal(verifyLaneRegionContainment(baseCRLF, laneAText, [regA]).ok, true);

    const outsideEdit = laneAText.replace("// FOOTER", "// HACKED_FOOTER");
    const badCont = verifyLaneRegionContainment(baseCRLF, outsideEdit, [regA]);
    assert.equal(badCont.ok, false);
    assert.equal(badCont.code, ANCHOR_ERRORS.REGION_OUTSIDE_EDIT);

    const dupAnchor = baseCRLF.replace("const a = 1;", "// BEGIN_A\r\nconst a = 1;");
    const badDup = verifyLaneRegionContainment(baseCRLF, dupAnchor, [regA]);
    assert.equal(badDup.ok, false);
    assert.equal(badDup.code, ANCHOR_ERRORS.ANCHOR_AMBIGUOUS);

    // Deterministic mergeRegions even when passed in reverse lane order & with adjacent lines
    const merged = mergeRegions({
      baseText: baseCRLF,
      laneVersions: [
        { laneId: "b", regions: [regB], text: laneBText },
        { laneId: "a", regions: [regA], text: laneAText },
      ],
    });
    assert.equal(merged.ok, true);
    assert.ok(merged.text.includes("const a = 100;\r\nconst a2 = 200;\r\n// END_A\r\n// BEGIN_B\r\nconst b = 999;"));
    assert.ok(merged.text.endsWith("// FOOTER"));
  });

  it("ignores untracked build/log artifacts while flagging out-of-scope source and tracked .log edits, and unmounts junctions safely", () => {
    const repo = initMonolithRepo();
    const dataDir = makeTempDir("ign-data");
    const wtBase = makeTempDir("ign-wt");
    const lockDir = makeTempDir("ign-locks");
    const scratchBase = makeTempDir("ign-scratch");
    const sharedTarget = makeTempDir("junc-target");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);

    writeFileSync(path.join(sharedTarget, "precious.txt"), "DO_NOT_DELETE\n", "utf8");

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({ title: "Ignore & Junction", goal: "Verify untracked ignores & safe junction unmount", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "core",
          title: "Core",
          ownedGlobs: ["src/core/**"],
          offload: "local",
          ignoreUntrackedGlobs: ["*.tmpbuild"],
          readOnlyMounts: [{ source: sharedTarget, target: "vendor/shared" }],
          verifyCmd: "node -e \"console.log('OK')\"",
        },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const coreWt = swarming.lanes[0].worktreePath;

    // Mount junction directly (also works if store didn't persist readOnlyMounts)
    mountReadOnlyJunctions(coreWt, [{ source: sharedTarget, target: "vendor/shared" }]);
    assert.equal(readFileSync(path.join(coreWt, "vendor", "shared", "precious.txt"), "utf8"), "DO_NOT_DELETE\n");

    // Refuse non-junction real directory in unmountJunctionSafe
    assert.throws(() => unmountJunctionSafe(path.join(coreWt, "src")), /REFUSE_NON_JUNCTION/);

    // Write dirty untracked .log, .pdb, __pycache__, .fleet, and custom *.tmpbuild
    assert.ok(DEFAULT_IGNORE_UNTRACKED_GLOBS.includes("*.log"));
    writeFileSync(path.join(coreWt, "build.log"), "noisy\n", "utf8");
    writeFileSync(path.join(coreWt, "src", "core", "app.pdb"), "pdb\n", "utf8");
    mkdirSync(path.join(coreWt, "src", "__pycache__"), { recursive: true });
    writeFileSync(path.join(coreWt, "src", "__pycache__", "mod.pyc"), "pyc\n", "utf8");
    mkdirSync(path.join(coreWt, ".fleet"), { recursive: true });
    writeFileSync(path.join(coreWt, ".fleet", "state.json"), "{}\n", "utf8");
    writeFileSync(path.join(coreWt, "artifact.tmpbuild"), "tmp\n", "utf8");

    // Owned change + ignored untracked artifacts -> PASS!
    writeFileSync(path.join(coreWt, "src", "core", "calc.mjs"), "export const score = () => 99;\n", "utf8");
    const okIgnored = auditAndVerifyLane(store, m.id, "core", {
      runCmd: true,
      ignoreUntrackedGlobs: ["*.tmpbuild"],
      readOnlyMounts: [{ source: sharedTarget, target: "vendor/shared" }],
    });
    assert.equal(okIgnored.result.ok, true, okIgnored.result.violation);
    assert.equal(okIgnored.result.scopeOk, true);

    // Out-of-scope untracked .mjs -> SCOPE_VIOLATION!
    writeFileSync(path.join(coreWt, "src", "ui", "intruder.mjs"), "export const bad = 1;\n", "utf8");
    const badSrc = auditAndVerifyLane(store, m.id, "core", {
      runCmd: true,
      readOnlyMounts: [{ source: sharedTarget, target: "vendor/shared" }],
    });
    assert.equal(badSrc.result.ok, false);
    assert.match(badSrc.result.violation, /SCOPE_VIOLATION.*intruder\.mjs/);
    rmSync(path.join(coreWt, "src", "ui", "intruder.mjs"));

    // Negative control: modifying a TRACKED .log file outside ownedGlobs is NEVER ignored!
    writeFileSync(path.join(coreWt, "tracked.log"), "tampered tracked log\n", "utf8");
    const badTrackedLog = auditAndVerifyLane(store, m.id, "core", {
      runCmd: true,
      readOnlyMounts: [{ source: sharedTarget, target: "vendor/shared" }],
    });
    assert.equal(badTrackedLog.result.ok, false);
    assert.match(badTrackedLog.result.violation, /SCOPE_VIOLATION.*tracked\.log/);

    // cleanupWorktrees unmounts junction safely BEFORE git worktree remove, leaving sharedTarget intact
    const removed = cleanupWorktrees(store, m.id);
    assert.equal(removed.length, 1);
    assert.equal(existsSync(coreWt), false);
    assert.equal(readFileSync(path.join(sharedTarget, "precious.txt"), "utf8"), "DO_NOT_DELETE\n");
  });
});

describe("v0.3.0 atomic integrateMission (-integrate, seam merge, holdouts & negative controls)", () => {
  it("merges disjoint lanes + adjacent ownedRegions monolith, ignores dirty logs, passes gates/holdouts, and fast-forwards repoRoot", async () => {
    const repo = initMonolithRepo();
    const dataDir = makeTempDir("int-data");
    const wtBase = makeTempDir("int-wt");
    const lockDir = makeTempDir("int-locks");
    const privDir = makeTempDir("int-priv");
    const scratchBase = makeTempDir("int-scratch");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_PRIVATE_DIR", privDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);
    setTempEnv("OVERDRIVE_DISABLE_AIPC", "1");

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const regA = [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" }];
    const regB = [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_B", endAnchor: "// END_B" }];

    const m = store.createMission({ title: "Atomic Integrate", goal: "Merge adjacent monolith seams safely", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "lane-a",
          title: "Lane A",
          ownedGlobs: ["src/core/**"],
          ownedRegions: regA,
          offload: "local",
          verifyCmd: "node -e \"console.log('OVERDRIVE_METRICS_JSON: ' + JSON.stringify({parity: 98.0}))\"",
        },
        {
          id: "lane-b",
          title: "Lane B",
          ownedGlobs: ["src/ui/**"],
          ownedRegions: regB,
          offload: "local",
          verifyCmd: "node -e \"console.log('LANE_B_OK')\"",
        },
      ],
      gates: [
        {
          id: "g-merged",
          title: "Check merged monolith",
          offload: "local",
          required: true,
          cmd: 'node --input-type=module -e "import { partA, partB } from \'./bin/monolith.mjs\'; if (partA !== \'lane-a-v2\' || partB !== \'lane-b-v2\') process.exit(1); console.log(\'MERGED_OK\');"',
        },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const wtA = swarming.lanes.find((l) => l.id === "lane-a").worktreePath;
    const wtB = swarming.lanes.find((l) => l.id === "lane-b").worktreePath;

    // Lane A edits src/core/calc.mjs + Region A of bin/monolith.mjs + leaves dirty untracked debug.log (must NOT be staged!)
    writeFileSync(path.join(wtA, "src", "core", "calc.mjs"), "export const score = () => 98;\n", "utf8");
    writeFileSync(
      path.join(wtA, "bin", "monolith.mjs"),
      readFileSync(path.join(wtA, "bin", "monolith.mjs"), "utf8").replace("export const partA = 'base-a';", "export const partA = 'lane-a-v2';"),
      "utf8",
    );
    writeFileSync(path.join(wtA, "debug.log"), "transient lane log\n", "utf8");
    runGit(wtA, "add", "src/core/calc.mjs", "bin/monolith.mjs");
    runGit(wtA, "commit", "-m", "lane-a changes");

    // Lane B edits src/ui/badge.mjs + adjacent Region B of bin/monolith.mjs (left uncommitted to also test clean auto-commit without .log!)
    writeFileSync(path.join(wtB, "src", "ui", "badge.mjs"), "export const badge = () => 'v3-ready';\n", "utf8");
    writeFileSync(
      path.join(wtB, "bin", "monolith.mjs"),
      readFileSync(path.join(wtB, "bin", "monolith.mjs"), "utf8").replace("export const partB = 'base-b';", "export const partB = 'lane-b-v2';"),
      "utf8",
    );
    writeFileSync(path.join(wtB, "b.log"), "do not stage\n", "utf8");

    const ratchetA = { metrics: [{ name: "parity", baseline: 95, op: ">=", maxRegression: 0 }] };
    const verA = auditAndVerifyLane(store, m.id, "lane-a", { ownedRegions: regA, ratchet: ratchetA });
    const verB = auditAndVerifyLane(store, m.id, "lane-b", { ownedRegions: regB });
    assert.equal(verA.result.ok, true);
    assert.equal(verB.result.ok, true);

    // Save private holdout that verifies merged calc + badge in -integrate
    savePrivateHoldout(m.id, "lane:lane-a", {
      holdoutCmd:
        "node --input-type=module -e \"import { score } from './src/core/calc.mjs'; import { badge } from './src/ui/badge.mjs'; if (score() !== 98 || badge() !== 'v3-ready') process.exit(1); console.log('OVERDRIVE_METRICS_JSON: ' + JSON.stringify({parity: 98.5}))\"",
    });

    const out = await integrateMission(store, m.id, {
      lanesConfig: {
        "lane-a": { ownedRegions: regA, ratchet: ratchetA },
        "lane-b": { ownedRegions: regB },
      },
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.fastForwarded, true);
    assert.equal(out.seamMergeApplied, true);
    assert.equal(out.gatesPassed, true);
    assert.deepEqual(out.mergedLanes, ["lane-a", "lane-b"]);
    assert.equal(out.ratchetResult?.ok, true);
    assert.equal(out.ratchetResult?.holdoutPassed, true);
    assert.equal(validateRatchetResult(out.ratchetResult).ok, true);
    assert.equal(out.cleanup.removed, true);
    assert.equal(existsSync(out.integrateWorktree), false);

    // Verify repoRoot received clean merge, WITHOUT debug.log or b.log!
    const rootHead = runGit(repo, "rev-parse", "HEAD").stdout.trim();
    assert.equal(rootHead, out.integratedCommit);
    const mergedMonolith = readFileSync(path.join(repo, "bin", "monolith.mjs"), "utf8");
    assert.match(mergedMonolith, /partA = 'lane-a-v2'/);
    assert.match(mergedMonolith, /partB = 'lane-b-v2'/);
    assert.equal(existsSync(path.join(repo, "debug.log")), false);
    assert.equal(existsSync(path.join(repo, "b.log")), false);

    const events = store.listMissionEvents(m.id, { afterSeq: 0, limit: 100 }).events;
    assert.ok(events.some((e) => e.type === "integration_verified"));

    cleanupWorktrees(store, m.id);
  });

  it("supports mission-level holdouts without spec.metrics (P0.1) and laneIds/gateId/cleanupWorktrees in overdrive_integrate (P0.2)", async () => {
    const repo = initMonolithRepo();
    const dataDir = makeTempDir("p01-data");
    const wtBase = makeTempDir("p01-wt");
    const lockDir = makeTempDir("p01-locks");
    const privDir = makeTempDir("p01-priv");
    const scratchBase = makeTempDir("p01-scratch");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_PRIVATE_DIR", privDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);
    setTempEnv("OVERDRIVE_DISABLE_AIPC", "1");

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({ title: "Holdout & Partial Integrate", goal: "Verify P0.1 and P0.2", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        { id: "lane-a", title: "Lane A", ownedGlobs: ["src/core/**"], offload: "local", verifyCmd: "node -e \"process.exit(0)\"" },
        { id: "lane-b", title: "Lane B", ownedGlobs: ["src/ui/**"], offload: "local", verifyCmd: "node -e \"process.exit(0)\"" },
      ],
      gates: [
        { id: "g1", title: "Gate 1", cmd: "node -e \"console.log('G1')\"", offload: "local", required: true },
        { id: "g2", title: "Gate 2", cmd: "node -e \"console.log('G2')\"", offload: "local", required: true },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const wtA = swarming.lanes.find((l) => l.id === "lane-a").worktreePath;
    const wtB = swarming.lanes.find((l) => l.id === "lane-b").worktreePath;

    writeFileSync(path.join(wtA, "src", "core", "calc.mjs"), "export const score = () => 99;\n", "utf8");
    runGit(wtA, "add", "-A");
    runGit(wtA, "commit", "-m", "lane a");
    writeFileSync(path.join(wtB, "src", "ui", "badge.mjs"), "export const badge = () => 'v4';\n", "utf8");
    runGit(wtB, "add", "-A");
    runGit(wtB, "commit", "-m", "lane b");

    assert.equal(auditAndVerifyLane(store, m.id, "lane-a").result.ok, true);
    assert.equal(auditAndVerifyLane(store, m.id, "lane-b").result.ok, true);

    // P0.1: mission-level private holdout WITHOUT spec.metrics (used to crash with ReferenceError: toPublicRatchetSpec)
    savePrivateHoldout(m.id, "mission", {
      holdoutCmd: "node -e \"console.log('MISSION_HOLDOUT_PASS')\"",
    });

    const handler = createToolHandler(store);
    // Partial gateId run with promoteToRepoRoot: true must fail because g2 is still pending
    const badPartial = await handler("overdrive_integrate", { missionId: m.id, laneIds: ["lane-a"], gateId: "g1", promoteToRepoRoot: true });
    assert.equal(badPartial.ok, false);
    assert.match(badPartial.error, /UNVERIFIED_GATES/);

    // Partial laneIds + gateId with promoteToRepoRoot: false succeeds, evaluates mission holdout cleanly, and strips private fields
    const partial = await handler("overdrive_integrate", {
      missionId: m.id,
      laneIds: ["lane-a"],
      gateId: "g1",
      promoteToRepoRoot: false,
      cleanupWorktrees: false,
    });
    assert.equal(partial.ok, true);
    assert.deepEqual(partial.mergedLanes, ["lane-a"]);
    assert.equal(partial.fastForwarded, false);
    assert.ok(partial.ratchetResult, "mission-level holdout result must be returned");
    assert.equal(partial.ratchetResult.ok, true);
    assert.equal(partial.ratchetResult.holdoutConfigured, true);
    assert.equal(partial.ratchetResult.holdoutPassed, true);
    assert.equal(partial.ratchetResult.spec.holdoutCmd, undefined);

    // Full integrate with cleanupWorktrees: true fast-forwards repoRoot and cleans up both lane worktrees
    const full = await handler("overdrive_integrate", {
      missionId: m.id,
      cleanupWorktrees: true,
    });
    assert.equal(full.ok, true);
    assert.equal(full.fastForwarded, true);
    assert.ok(Array.isArray(full.laneWorktreesCleaned) && full.laneWorktreesCleaned.length === 2);
    assert.equal(existsSync(wtA), false);
    assert.equal(existsSync(wtB), false);
  });

  it("leaves repoRoot HEAD and working tree 100% untouched on gate failure, holdout failure, or dirty repo overlap", async () => {
    const repo = initMonolithRepo();
    const initialHead = runGit(repo, "rev-parse", "HEAD").stdout.trim();
    const initialCalc = readFileSync(path.join(repo, "src", "core", "calc.mjs"), "utf8");
    const dataDir = makeTempDir("fail-int-data");
    const wtBase = makeTempDir("fail-int-wt");
    const lockDir = makeTempDir("fail-int-locks");
    const privDir = makeTempDir("fail-int-priv");
    const scratchBase = makeTempDir("fail-int-scratch");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_PRIVATE_DIR", privDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);
    setTempEnv("OVERDRIVE_DISABLE_AIPC", "1");

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({ title: "Fail Closed Integrate", goal: "Do not touch repoRoot on failure", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "core",
          title: "Core",
          ownedGlobs: ["src/core/**"],
          offload: "local",
          verifyCmd: "node -e \"console.log('CORE_OK')\"",
        },
      ],
      gates: [
        {
          id: "g-fail",
          title: "Failing Gate",
          offload: "local",
          required: true,
          cmd: "node -e \"process.exit(1)\"",
        },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const coreWt = swarming.lanes[0].worktreePath;
    writeFileSync(path.join(coreWt, "src", "core", "calc.mjs"), "export const score = () => 123;\n", "utf8");
    runGit(coreWt, "add", "src/core/calc.mjs");
    runGit(coreWt, "commit", "-m", "core edit");
    const ver = auditAndVerifyLane(store, m.id, "core");
    assert.equal(ver.result.ok, true);

    // 1. Failing required gate -> repoRoot 100% untouched, -integrate cleaned
    const gateFailOut = await integrateMission(store, m.id);
    assert.equal(gateFailOut.ok, false);
    assert.equal(gateFailOut.fastForwarded, false);
    assert.equal(gateFailOut.gatesPassed, false);
    assert.equal(gateFailOut.cleanup.removed, true);
    assert.equal(existsSync(gateFailOut.integrateWorktree), false);
    assert.equal(runGit(repo, "rev-parse", "HEAD").stdout.trim(), initialHead);
    assert.equal(readFileSync(path.join(repo, "src", "core", "calc.mjs"), "utf8"), initialCalc);

    // 2. Gate skipped, but private holdout fails -> repoRoot 100% untouched!
    savePrivateHoldout(m.id, "lane:core", {
      holdoutCmd: "node -e \"process.exit(1)\"",
      metrics: [{ name: "parity", baseline: 95, op: ">=" }],
    });
    const holdoutFailOut = await integrateMission(store, m.id, {
      runGates: false,
      runHoldouts: true,
      lanesConfig: {
        core: {
          ratchet: { metrics: [{ name: "parity", baseline: 95, op: ">=" }] },
          verifyCmd: "node -e \"console.log('OVERDRIVE_METRICS_JSON: ' + JSON.stringify({parity: 99}))\"",
        },
      },
    });
    assert.equal(holdoutFailOut.ok, false);
    assert.equal(holdoutFailOut.fastForwarded, false);
    assert.equal(holdoutFailOut.ratchetResult?.holdoutPassed, false);
    assert.equal(runGit(repo, "rev-parse", "HEAD").stdout.trim(), initialHead);
    assert.equal(readFileSync(path.join(repo, "src", "core", "calc.mjs"), "utf8"), initialCalc);

    // 3. Dirty overlapping tracked file in repoRoot -> DIRTY_REPO_OVERLAP, repoRoot HEAD untouched
    writeFileSync(path.join(repo, "src", "core", "calc.mjs"), "export const score = () => 777;\n", "utf8");
    const dirtyFail = await integrateMission(store, m.id, { runGates: false, runHoldouts: false });
    assert.equal(dirtyFail.ok, false);
    assert.match(dirtyFail.error, /DIRTY_REPO_OVERLAP/);
    assert.equal(runGit(repo, "rev-parse", "HEAD").stdout.trim(), initialHead);
    assert.equal(readFileSync(path.join(repo, "src", "core", "calc.mjs"), "utf8"), "export const score = () => 777;\n");

    const evs = store.listMissionEvents(m.id, { afterSeq: 0, limit: 100 }).events;
    assert.ok(evs.some((e) => e.type === "integration_failed"));

    cleanupWorktrees(store, m.id);
  });

  it("rejects outside-region edits in real worktrees via auditAndVerifyLane and enforces gate ratchets in runMissionGate", () => {
    const repo = initMonolithRepo();
    const dataDir = makeTempDir("reg-gate-data");
    const wtBase = makeTempDir("reg-gate-wt");
    const lockDir = makeTempDir("reg-gate-locks");
    const scratchBase = makeTempDir("reg-gate-scratch");
    setTempEnv("OVERDRIVE_WT_ROOT", wtBase);
    setTempEnv("OVERDRIVE_LOCK_DIR", lockDir);
    setTempEnv("OVERDRIVE_SCRATCH_DIR_BASE", scratchBase);

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const regA = [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" }];
    const m = store.createMission({ title: "Region & Gate Ratchet", goal: "Verify region fail & gate ratchet", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        {
          id: "lane-a",
          title: "Lane A",
          ownedGlobs: ["src/core/**"],
          ownedRegions: regA,
          offload: "local",
          verifyCmd: "node -e \"console.log('OK')\"",
        },
      ],
      gates: [
        {
          id: "g-ratchet",
          title: "Gate Ratchet",
          offload: "local",
          required: true,
          cmd: "node -e \"console.log('OVERDRIVE_METRICS_JSON: ' + JSON.stringify({parity: 88.0}))\"",
        },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const regionBrief = buildLaneBrief(swarming, { ...swarming.lanes[0], ownedRegions: regA });
    assert.match(regionBrief, /\/\/ BEGIN_A/);
    assert.match(regionBrief, /\/\/ END_A/);
    const wtA = swarming.lanes[0].worktreePath;

    // Negative control: lane-a edits outside its (BEGIN_A, END_A) region in bin/monolith.mjs -> SCOPE_VIOLATION
    const origMono = readFileSync(path.join(wtA, "bin", "monolith.mjs"), "utf8");
    writeFileSync(
      path.join(wtA, "bin", "monolith.mjs"),
      origMono.replace("export const partB = 'base-b';", "export const partB = 'trespassed';"),
      "utf8",
    );
    const badReg = auditAndVerifyLane(store, m.id, "lane-a", { ownedRegions: regA });
    assert.equal(badReg.result.ok, false);
    assert.equal(badReg.result.scopeOk, false);
    assert.match(badReg.result.violation, /SCOPE_VIOLATION/);
    assert.match(badReg.result.violation, /REGION_OUTSIDE_EDIT/);

    // Repair monolith to valid in-region edit -> PASS
    writeFileSync(
      path.join(wtA, "bin", "monolith.mjs"),
      origMono.replace("export const partA = 'base-a';", "export const partA = 'ok-a';"),
      "utf8",
    );
    const okReg = auditAndVerifyLane(store, m.id, "lane-a", { ownedRegions: regA });
    assert.equal(okReg.result.ok, true, okReg.result.violation);

    // Gate ratchet regression fail even though command exited 0
    const badGate = runMissionGate(store, m.id, "g-ratchet", {
      ratchet: { metrics: [{ name: "parity", baseline: 95, op: ">=", maxRegression: 0 }] },
    });
    assert.equal(badGate.result.exitCode, 0);
    assert.equal(badGate.result.ok, false);
    assert.match(badGate.result.violation, /^METRIC_REGRESSION:/);

    // Gate ratchet pass when threshold satisfied
    const okGate = runMissionGate(store, m.id, "g-ratchet", {
      ratchet: { metrics: [{ name: "parity", baseline: 85, op: ">=", maxRegression: 0 }] },
      cleanupAfterPass: true,
    });
    assert.equal(okGate.result.ok, true);
    assert.equal(okGate.mission.state, "completed");
    assert.equal(existsSync(wtA), false);
  });
});
