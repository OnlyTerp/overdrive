import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { submitToAdhdLoopback } from "../src/adhd-bridge.mjs";
import { seedShowcaseMission } from "../src/demo.mjs";
import { collectLaneDiff, enforceDiffCaps, parseNameStatusZ, truncatePatch } from "../src/diff.mjs";
import { getRsiOverview } from "../src/rsi.mjs";
import { OverdriveStore } from "../src/store.mjs";
import {
  DIFF_CAPS,
  EVENT_CAPS,
  SHOWCASE_FIXTURE_VERSION,
  SHOWCASE_SLUG,
  STORE_METHODS,
  validateDemoSeedResponse,
  validateDiffResponse,
  validateEventsResponse,
  validateInspectionResponse,
  validateIntentionDigest,
  validateRatchetResult,
  validateRatchetSpec,
  validateReplayEnvelope,
  validateRsiCandidate,
} from "../src/ui-contracts.mjs";
import { auditAndVerifyLane, cleanupWorktrees, inspectLaneWorktree, provisionWorktrees, runMissionGate } from "../src/worktree.mjs";
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

function runGit(repo, ...argv) {
  const r = spawnSync("git", ["-C", repo, ...argv], { shell: false, windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

function initTempGitRepo() {
  const repo = makeTempDir("ev-repo");
  runGit(repo, "init");
  runGit(repo, "config", "user.email", "evidence-test@example.com");
  runGit(repo, "config", "user.name", "Evidence Test");
  runGit(repo, "config", "core.autocrlf", "false");

  mkdirSync(path.join(repo, "src", "core"), { recursive: true });
  mkdirSync(path.join(repo, "src", "ui"), { recursive: true });
  writeFileSync(path.join(repo, "src", "contracts.mjs"), "export const CONTRACT = 1;\n", "utf8");
  writeFileSync(path.join(repo, "src", "core", "mod.mjs"), "export const v = 1;\n", "utf8");
  writeFileSync(path.join(repo, "src", "core", "old.mjs"), "export const legacy = true;\n", "utf8");
  writeFileSync(path.join(repo, "src", "core", "todel.mjs"), "export const del = true;\n", "utf8");
  writeFileSync(path.join(repo, "src", "ui", "panel.mjs"), "export const panel = () => 'ui';\n", "utf8");
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-m", "initial commit");
  return repo;
}

describe("store event pagination, additive migration, telemetry & receipts", () => {
  it("paginates events cleanly and clamps limit to [1, EVENT_CAPS.maxLimit]", () => {
    const repo = initTempGitRepo();
    const dataDir = makeTempDir("ev-store");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    for (const method of STORE_METHODS) {
      assert.equal(typeof store[method], "function", `OverdriveStore must implement ${method}`);
    }

    const m = store.createMission({ title: "Pagination Test", goal: "Test events pagination", repoRoot: repo });
    for (let i = 1; i <= 12; i++) {
      store.recordEvent(m.id, "coordinator", "state_swarming", { step: i, laneId: "core" });
    }

    const p1 = store.listMissionEvents(m.id, { afterSeq: 0, limit: 5 });
    assert.equal(validateEventsResponse(p1).ok, true);
    assert.equal(p1.events.length, 5);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.limit, 5);
    assert.equal(p1.nextAfterSeq, p1.events[4].seq);
    for (const ev of p1.events) {
      assert.ok(ev.ts && ev.createdAt);
      assert.ok(ev.kind && ev.type);
      assert.ok(ev.actor && ev.role);
      assert.ok(ev.summary);
      assert.equal(validateReplayEnvelope(ev.replay).ok, true);
    }

    const p2 = store.listEventsAfter(m.id, p1.nextAfterSeq, 5);
    assert.equal(p2.events.length, 5);
    assert.equal(p2.hasMore, true);

    const p3 = store.listEventsAfter(m.id, p2.nextAfterSeq, 5);
    assert.equal(p3.events.length, 3); // 1 mission_created + 12 state_swarming = 13 total
    assert.equal(p3.hasMore, false);

    // Clamping limits: 0 -> 1, -10 -> 1, 9999 -> EVENT_CAPS.maxLimit (250)
    const minClamp = store.listMissionEvents(m.id, { afterSeq: 0, limit: 0 });
    assert.equal(minClamp.limit, 1);
    assert.equal(minClamp.events.length, 1);

    const negClamp = store.listMissionEvents(m.id, { afterSeq: 0, limit: -9 });
    assert.equal(negClamp.limit, 1);

    const maxClamp = store.listMissionEvents(m.id, { afterSeq: 0, limit: 5000 });
    assert.equal(maxClamp.limit, EVENT_CAPS.maxLimit);

    const defClamp = store.listMissionEvents(m.id, { afterSeq: 0 });
    assert.equal(defClamp.limit, EVENT_CAPS.defaultLimit);

    // Upper bound throughSeq
    const bounded = store.listMissionEvents(m.id, { afterSeq: 0, throughSeq: p1.events[2].seq, limit: 50 });
    assert.equal(bounded.events.length, 3);
  });

  it("migrates legacy v0.1.0 SQLite databases additively without breaking existing rows", () => {
    const dataDir = makeTempDir("legacy-db");
    const dbPath = path.join(dataDir, "overdrive.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE missions (
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE contracts (
        mission_id TEXT NOT NULL,
        path TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sha256 TEXT,
        frozen_at TEXT,
        PRIMARY KEY (mission_id, path)
      );
      CREATE TABLE lanes (
        mission_id TEXT NOT NULL,
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
        status TEXT NOT NULL DEFAULT 'pending',
        scope_ok INTEGER,
        last_verify_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, id)
      );
      CREATE TABLE gates (
        mission_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        cmd TEXT NOT NULL,
        offload TEXT NOT NULL DEFAULT 'auto',
        required INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        last_run_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, id)
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    raw.prepare("INSERT INTO missions VALUES ('m-old','old-1','Legacy Mission','Goal','/workspace/overdrive','single-harness','antigravity',NULL,'planned',NULL,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO lanes VALUES ('m-old','core','Core','', 'hard','[\"src/**\"]','node -v','auto','{\"harness\":\"antigravity\",\"model\":\"gemini-4-carbon\"}','{}',NULL,NULL,'pending',NULL,NULL,'2026-11-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO events(mission_id, role, type, payload_json, created_at) VALUES ('m-old','coordinator','mission_created','{\"title\":\"Legacy Mission\"}','2026-11-01T00:00:00Z')").run();
    raw.close();

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    for (const method of STORE_METHODS) {
      assert.equal(typeof store[method], "function", `OverdriveStore must implement ${method}`);
    }
    const legacy = store.getMission("m-old");
    assert.ok(legacy);
    assert.equal(legacy.lanes[0].model, "gemini-4-carbon");
    const evs = store.listMissionEvents("m-old");
    assert.equal(validateEventsResponse(evs).ok, true);
    assert.equal(evs.events.length, 1);
    assert.equal(evs.events[0].stage, "thinking");
    assert.equal(validateReplayEnvelope(evs.events[0].replay).ok, true);

    store.updateLaneTelemetry("m-old", "core", { durationMs: 1234, tokensIn: 500, tokensOut: 120, costUsd: 0.02 });
    const after = store.getMission("m-old");
    assert.equal(after.lanes[0].durationMs, 1234);
    assert.equal(after.lanes[0].tokensIn, 500);
  });
});

describe("diff.mjs & worktree.mjs real git diffs, caps & read-only inspection", () => {
  it("classifies added, modified, deleted, renamed, untracked, out_of_scope & contract tamper", () => {
    const repo = initTempGitRepo();
    const dataDir = makeTempDir("diff-data");
    const wtBase = makeTempDir("diff-wt");
    const prevWt = process.env.OVERDRIVE_WT_ROOT;
    process.env.OVERDRIVE_WT_ROOT = wtBase;
    cleanupFns.push(() => {
      if (prevWt === undefined) delete process.env.OVERDRIVE_WT_ROOT;
      else process.env.OVERDRIVE_WT_ROOT = prevWt;
    });

    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    for (const method of STORE_METHODS) {
      assert.equal(typeof store[method], "function", `OverdriveStore must implement ${method}`);
    }

    const m = store.createMission({ title: "Diff Classification", goal: "Verify git diff & inspection", repoRoot: repo });
    store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs", description: "Frozen API" }],
      lanes: [
        { id: "core", title: "Core", ownedGlobs: ["src/core/**"], verifyCmd: "node -e \"console.log('OK')\"" },
        { id: "ui", title: "UI", ownedGlobs: ["src/ui/**"], verifyCmd: "node -e \"console.log('OK')\"" },
      ],
    });
    store.freezeContracts(m.id);
    const { mission: swarming } = provisionWorktrees(store, m.id);
    const coreWt = swarming.lanes.find((l) => l.id === "core").worktreePath;

    // Modify, rename (staged), delete, and add untracked file in core worktree
    writeFileSync(path.join(coreWt, "src", "core", "mod.mjs"), "export const v = 2;\nexport const w = 3;\n", "utf8");
    runGit(coreWt, "mv", "src/core/old.mjs", "src/core/renamed.mjs");
    runGit(coreWt, "rm", "src/core/todel.mjs");
    writeFileSync(path.join(coreWt, "src", "core", "brandnew.mjs"), "export const fresh = true;\n", "utf8");

    const diff = collectLaneDiff(store, m.id, "core");
    assert.equal(validateDiffResponse(diff).ok, true);
    assert.equal(diff.source, "worktree");
    assert.equal(diff.scopeOk, true);
    assert.equal(diff.truncated, false);
    assert.equal(diff.contracts.length, 1);
    assert.equal(diff.contracts[0].intact, true);

    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("src/core/mod.mjs")?.status, "modified");
    assert.equal(byPath.get("src/core/mod.mjs")?.ownership, "owned");
    assert.equal(byPath.get("src/core/mod.mjs")?.matchedGlob, "src/core/**");
    assert.equal(byPath.get("src/core/renamed.mjs")?.status, "renamed");
    assert.equal(byPath.get("src/core/renamed.mjs")?.oldPath, "src/core/old.mjs");
    assert.equal(byPath.get("src/core/todel.mjs")?.status, "deleted");
    assert.equal(byPath.get("src/core/brandnew.mjs")?.status, "added");
    assert.ok(byPath.get("src/core/brandnew.mjs")?.additions >= 1);

    // Commit inside worktree so recentCommits shows commit + inspect worktree read-only
    runGit(coreWt, "add", "-A");
    runGit(coreWt, "commit", "-m", "core changes");
    const ver = auditAndVerifyLane(store, m.id, "core", { runCmd: true });
    assert.equal(ver.result.ok, true);
    assert.ok(ver.result.receiptId);

    // Dirty untracked file for inspection test
    writeFileSync(path.join(coreWt, "src", "core", "scratch.mjs"), "// wip\n", "utf8");
    const insp = inspectLaneWorktree(store, m.id, "core");
    assert.equal(validateInspectionResponse(insp).ok, true);
    assert.equal(insp.exists, true);
    assert.ok(insp.headSha);
    assert.ok(insp.recentCommits.some((c) => c.subject === "core changes"));
    assert.ok(insp.dirtyFiles.some((d) => d.path === "src/core/scratch.mjs"));
    assert.equal(insp.contracts[0].intact, true);
    assert.equal(insp.scopeOk, true);

    // Receipt lookup returns historical verified diff snapshot
    const rcptDiff = collectLaneDiff(store, m.id, "core", { receiptId: ver.result.receiptId });
    assert.equal(rcptDiff.source, "receipt");
    assert.equal(rcptDiff.receiptId, ver.result.receiptId);
    assert.equal(rcptDiff.files.some((f) => f.path === "src/core/scratch.mjs"), false);

    // Out-of-scope + contract tamper detection in diff
    const uiWt = swarming.lanes.find((l) => l.id === "ui").worktreePath;
    writeFileSync(path.join(uiWt, "src", "core", "intruder.mjs"), "export const x = 1;\n", "utf8");
    writeFileSync(path.join(uiWt, "src", "contracts.mjs"), "export const CONTRACT = 999;\n", "utf8");
    const badDiff = collectLaneDiff(store, m.id, "ui");
    assert.equal(badDiff.scopeOk, false);
    assert.equal(badDiff.files.find((f) => f.path === "src/core/intruder.mjs")?.ownership, "out_of_scope");
    assert.equal(badDiff.files.find((f) => f.path === "src/contracts.mjs")?.ownership, "contract_tampered");
    assert.equal(badDiff.contracts[0].intact, false);
  });

  it("enforces DIFF_CAPS (maxFiles, maxLinesPerFile, maxFileBytes, maxTotalBytes)", () => {
    // 1. maxFiles cap (60)
    const manyFiles = Array.from({ length: 65 }, (_, i) => ({
      path: `src/core/f-${String(i).padStart(2, "0")}.mjs`,
      oldPath: null,
      status: "added",
      ownership: "owned",
      additions: 1,
      deletions: 0,
      patch: `--- /dev/null\n+++ b/src/core/f-${i}.mjs\n@@ -0,0 +1,1 @@\n+export const x = ${i};`,
    }));
    const capFiles = enforceDiffCaps(manyFiles, DIFF_CAPS);
    assert.equal(capFiles.files.length, DIFF_CAPS.maxFiles);
    assert.equal(capFiles.omittedFiles, 5);
    assert.equal(capFiles.truncated, true);

    // 2. maxLinesPerFile cap (500)
    const longPatch = Array.from({ length: 620 }, (_, i) => `+line ${i}`).join("\n");
    const lineTrunc = truncatePatch(longPatch, DIFF_CAPS);
    assert.equal(lineTrunc.truncated, true);
    assert.equal(lineTrunc.patch.split("\n").length, DIFF_CAPS.maxLinesPerFile);

    // 3. maxFileBytes cap (65536) with multi-byte UTF-8 boundary safety
    const bigSingleLine = "+" + "é".repeat(40000);
    const byteTrunc = truncatePatch(bigSingleLine, DIFF_CAPS);
    assert.equal(byteTrunc.truncated, true);
    assert.ok(Buffer.byteLength(byteTrunc.patch, "utf8") <= DIFF_CAPS.maxFileBytes);
    assert.equal(byteTrunc.patch.includes("\uFFFD"), false);

    // 4. maxTotalBytes cap (524288)
    const bigFiles = Array.from({ length: 14 }, (_, i) => ({
      path: `src/core/big-${i}.mjs`,
      oldPath: null,
      status: "modified",
      ownership: "owned",
      additions: 100,
      deletions: 0,
      patch: Array.from({ length: 200 }, (__, ln) => `+${"a".repeat(240)}-${i}-${ln}`).join("\n"),
    }));
    const capTotal = enforceDiffCaps(bigFiles, DIFF_CAPS);
    assert.equal(capTotal.truncated, true);
    assert.ok(capTotal.totalBytes <= DIFF_CAPS.maxTotalBytes);
    assert.ok(capTotal.omittedFiles > 0);
  });

  it("parses git diff --name-status -z rename/copy/modify tokens cleanly", () => {
    const raw = Buffer.from("M\0src/a.mjs\0R095\0ui/old.js\0ui/new.js\0D\0src/dead.mjs\0A\0src/new.mjs\0", "utf8");
    const parsed = parseNameStatusZ(raw);
    assert.deepEqual(parsed, [
      { rawStatus: "M", status: "modified", path: "src/a.mjs", oldPath: null },
      { rawStatus: "R095", status: "renamed", path: "ui/new.js", oldPath: "ui/old.js" },
      { rawStatus: "D", status: "deleted", path: "src/dead.mjs", oldPath: null },
      { rawStatus: "A", status: "added", path: "src/new.mjs", oldPath: null },
    ]);
  });

  it("reads showcase synthetic diffs & inspections cleanly without live worktree dirs", () => {
    const dataDir = makeTempDir("demo-data");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());
    for (const method of STORE_METHODS) {
      assert.equal(typeof store[method], "function", `OverdriveStore must implement ${method}`);
    }

    const res1 = seedShowcaseMission(store);
    assert.equal(validateDemoSeedResponse(res1).ok, true);
    assert.equal(res1.slug, SHOWCASE_SLUG);
    assert.equal(res1.fixtureVersion, SHOWCASE_FIXTURE_VERSION);
    assert.equal(res1.created, true);

    const mission = res1.mission;
    assert.equal(mission.lanes.length, 3);
    assert.equal(mission.gates.length, 4);

    // Confirm requested multi-family models & telemetry
    const models = mission.lanes.map((l) => `${l.worker.harness}/${l.worker.model}`);
    assert.ok(models.includes("antigravity/gemini-4-carbon"));
    assert.ok(models.includes("devin/swe-2"));
    assert.ok(models.includes("claude/claude-opus-5-5"));
    for (const l of mission.lanes) {
      assert.equal(typeof l.durationMs, "number");
      assert.equal(typeof l.tokensIn, "number");
      assert.equal(typeof l.tokensOut, "number");
      assert.equal(typeof l.costUsd, "number");
    }

    // Idempotent second seed call preserves missionId & counts
    const res2 = seedShowcaseMission(store);
    assert.equal(res2.created, false);
    assert.equal(res2.missionId, res1.missionId);
    assert.equal(store.listMissions().length, 1);
    assert.equal(
      store.listMissionEvents(res2.missionId, { afterSeq: 0, limit: 250 }).events.length,
      store.listMissionEvents(res1.missionId, { afterSeq: 0, limit: 250 }).events.length,
    );

    // Synthetic diff & inspection without worktree dir creation
    const diff = collectLaneDiff(store, mission.id, "interface");
    assert.equal(validateDiffResponse(diff).ok, true);
    assert.equal(diff.files.some((f) => f.status === "renamed" && f.oldPath === "ui/drawer.js"), true);

    // Historical failed receipt for interface lane
    const failedDiff = collectLaneDiff(store, mission.id, "interface", { receiptId: "rcpt-showcase-interface-1" });
    assert.equal(failedDiff.source, "receipt");
    assert.equal(failedDiff.scopeOk, false);
    assert.equal(failedDiff.files[0].ownership, "out_of_scope");

    const insp = inspectLaneWorktree(store, mission.id, "engine");
    assert.equal(validateInspectionResponse(insp).ok, true);
    assert.equal(insp.exists, false);
    assert.equal(insp.synthetic, true);
    assert.ok(insp.recentCommits.length >= 2);
    assert.equal(existsSync(".overdrive/worktrees/showcase-engine"), false);

    // v0.3 showcase enrichments: cloud/VM offload, 94.2 -> 96.8 parity ratchet, integration_verified event, seeded RSI
    const evLane = mission.lanes.find((l) => l.id === "evidence");
    assert.equal(evLane.offload, "devin-vm");
    const engLane = mission.lanes.find((l) => l.id === "engine");
    assert.equal(validateRatchetSpec(engLane.ratchet, { allowHoldout: false }).ok, true);
    assert.equal(validateRatchetResult(engLane.lastVerify.ratchetResult).ok, true);
    assert.equal(engLane.lastVerify.ratchetResult.baseline.parity, 94.2);
    assert.equal(engLane.lastVerify.ratchetResult.metrics.parity, 96.8);

    const allEvents = store.listMissionEvents(mission.id, { afterSeq: 0, limit: 250 }).events;
    assert.ok(allEvents.some((e) => e.type === "integration_verified"));

    const rsiOv = getRsiOverview(store);
    assert.equal(validateIntentionDigest(rsiOv.digest).ok, true);
    assert.ok(rsiOv.candidates.length >= 1);
    for (const c of rsiOv.candidates) assert.equal(validateRsiCandidate(c).ok, true);
  });

  it("hardens loopback origin, read-only showcase execution, rename scope violation & topology_planned replay checkpoint", async () => {
    await assert.rejects(
      () => submitToAdhdLoopback("https://evil.example", "s1", { text: "x" }),
      /loopback/i,
    );

    const dataDir = makeTempDir("hardening-db");
    setTempEnv("OVERDRIVE_DISABLE_AIPC", "1");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const demo = seedShowcaseMission(store);
    assert.throws(() => cleanupWorktrees(store, demo.missionId), /read-only/i);
    assert.throws(() => runMissionGate(store, demo.missionId, "g1"), /read-only/i);
    assert.throws(() => auditAndVerifyLane(store, demo.missionId, "engine"), /read-only/i);

    const repo = initTempGitRepo();
    const baseCommit = runGit(repo, "rev-parse", "HEAD").stdout.trim();
    const m = store.createMission({ title: "Rename & Checkpoint", goal: "Verify security hardening", repoRoot: repo });
    const planned = store.planMission(m.id, {
      sharedContracts: [{ path: "src/contracts.mjs" }],
      lanes: [
        { id: "ui", title: "UI", ownedGlobs: ["src/ui/**"], verifyCmd: "node -e \"process.exit(0)\"", complexity: "standard", offload: "local" },
      ],
      gates: [{ id: "g1", title: "Pass", cmd: "node -e \"process.exit(0)\"", offload: "local", required: true }],
    });
    assert.equal(planned.ok, true);
    const planEv = store.listMissionEvents(m.id, { afterSeq: 0, limit: 20 }).events.find((e) => e.type === "topology_planned");
    assert.ok(planEv?.replay?.checkpoint?.lanes?.ui);
    assert.ok(planEv?.replay?.checkpoint?.gates?.g1);

    store.freezeContracts(m.id);
    // Rename another lane's file (src/core/mod.mjs) into our owned src/ui/ dir -> must fail SCOPE_VIOLATION!
    runGit(repo, "mv", "src/core/mod.mjs", "src/ui/moved-from-core.mjs");
    const ver = auditAndVerifyLane(store, m.id, "ui", { runCmd: true });
    assert.equal(ver.result.ok, false);
    assert.equal(ver.result.scopeOk, false);
    assert.match(ver.result.violation, /src\/core\/mod\.mjs/);

    const rcptId = ver.result.receiptId;
    const insp = inspectLaneWorktree(store, m.id, "ui", { receiptId: rcptId });
    assert.equal(validateInspectionResponse(insp).ok, true);
    assert.equal(insp.source, "receipt");
    assert.equal(insp.freezeCommit, baseCommit);
  });
});
