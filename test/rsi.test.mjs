import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runRsiBenchmark } from "../checks/rsi-benchmark.mjs";
import { DEFAULT_LEDGER_PATH, mineIntentionDigest, redactPrivateSignals } from "../src/intentions.mjs";
import { createToolHandler } from "../src/mcp.mjs";
import {
  getRsiOverview,
  promoteRsiCandidate,
  rollbackRsiCandidate,
  runRsiVerificationCycle,
  scanRsiOpportunities,
  submitRsiAuditReceipt,
} from "../src/rsi.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { validateIntentionDigest, validateRatchetSpec, validateRsiCandidate } from "../src/ui-contracts.mjs";

import { defaultTestScratchBase } from "../src/paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const repo = makeTempDir("rsi-git");
  const run = (...argv) => {
    const r = spawnSync("git", ["-C", repo, ...argv], { shell: false, windowsHide: true, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
  };
  run("init");
  run("config", "user.email", "rsi-test@example.com");
  run("config", "user.name", "RSI Test");
  run("config", "core.autocrlf", "false");
  writeFileSync(path.join(repo, "README.md"), "# Temp Overdrive Sandbox\n", "utf8");
  run("add", "-A");
  run("commit", "-m", "initial commit");
  const head = run("rev-parse", "HEAD").stdout.trim();
  return { repo, head, run };
}

function createMockIntentionFixtures(dir, nowDate = new Date("2026-11-18T12:00:00Z")) {
  const ledgerPath = path.join(dir, "ledger.sqlite");
  const memoryPath = path.join(dir, "unified_memory.db");
  const driftPath = path.join(dir, "drift.json");
  const arpdDir = path.join(dir, "arpd");
  mkdirSync(path.join(arpdDir, "mirror"), { recursive: true });

  const nowMs = nowDate.getTime();
  const isoAgo = (hours) => new Date(nowMs - hours * 3_600_000).toISOString();

  const db = new DatabaseSync(ledgerPath);
  db.exec(`
    CREATE TABLE sessions (
      uid TEXT PRIMARY KEY,
      harness TEXT,
      project TEXT,
      cwd TEXT,
      title TEXT,
      started_at TEXT,
      ended_at TEXT,
      models TEXT,
      n_llm INTEGER,
      n_tool INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      is_subagent INTEGER
    );
    CREATE TABLE llm_calls (
      session_uid TEXT,
      model TEXT,
      status TEXT,
      error_type TEXT,
      retries INTEGER
    );
    CREATE TABLE tool_calls (
      session_uid TEXT,
      tool TEXT,
      status TEXT,
      duplicate_of TEXT
    );
    CREATE TABLE marks (
      kind TEXT,
      value TEXT
    );
    CREATE TABLE sources (
      name TEXT,
      last_ts TEXT,
      parseable INTEGER,
      note TEXT
    );
  `);

  const insSess = db.prepare(
    "INSERT INTO sessions(uid, harness, project, cwd, title, started_at, ended_at, models, n_llm, n_tool, tokens_in, tokens_out, cost_usd, is_subagent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // Active project (<72h): analytics-engine (4h ago) and overdrive (2h ago)
  insSess.run("s-active-1", "devin", "analytics-engine", "C:\\Users\\alice\\repos\\analytics-engine", "Fix token sk-secret1234567890abcdef", isoAgo(5), isoAgo(4), "swe-2-flash", 6, 12, 18000, 4200, 0, 1);
  insSess.run("s-active-2", "antigravity", "overdrive", "/workspace/overdrive", "Build RSI with alice@example.com", isoAgo(3), isoAgo(2), "gemini-4-carbon", 8, 10, 22000, 5000, 0.25, 0);
  // Quiet project (>=72h and <=14d): search-core (96h ago) -> MUST ONLY be owner_question with autoDispatch: false
  insSess.run("s-quiet-1", "claude", "search-core", "/Users/alice/work/search-core", "ghp_1234567890abcdefghijklmnop", isoAgo(98), isoAgo(96), "claude-opus-5-5", 4, 8, 12000, 3000, 0.45, 0);
  // Very old (>14d): legacy-app (400h ago) -> ignored from activeFocus & wentQuietQuestions
  insSess.run("s-old-1", "codex", "legacy-app", "/home/bob/legacy-app", "old work", isoAgo(402), isoAgo(400), "gpt-6.1-sol", 2, 3, 5000, 1000, 0.1, 0);

  const insLlm = db.prepare("INSERT INTO llm_calls(session_uid, model, status, error_type, retries) VALUES(?,?,?,?,?)");
  insLlm.run("s-active-1", "swe-2-flash", "ok", null, 0);
  insLlm.run("s-active-1", "swe-2", "ok", null, 0);
  insLlm.run("s-active-2", "gemini-4-carbon", "ok", null, 1);
  insLlm.run("s-quiet-1", "claude-opus-5-5", "error", "rate_limit", 2);

  const insTool = db.prepare("INSERT INTO tool_calls(session_uid, tool, status, duplicate_of) VALUES(?,?,?,?)");
  insTool.run("s-active-1", "Bash C:\\Users\\alice\\secret.sh", "error", null);
  insTool.run("s-active-2", "read_file", "ok", "prev-call-1");
  insTool.run("s-active-2", "edit_file", "ok", null);

  db.prepare("INSERT INTO marks(kind, value) VALUES(?,?)").run("compaction", "compact_boundary");
  db.prepare("INSERT INTO sources(name, last_ts, parseable, note) VALUES(?,?,?,?)").run("devin", isoAgo(10), 0, "C:\\Users\\alice\\.devin IDE state");
  db.close();

  const memDb = new DatabaseSync(memoryPath);
  memDb.exec("CREATE TABLE memory_facts (fact_id TEXT PRIMARY KEY, revision INTEGER, content TEXT, deleted INTEGER DEFAULT 0);");
  memDb.prepare("INSERT INTO memory_facts VALUES ('f1', 1, 'safe note', 0)").run();
  memDb.close();

  writeFileSync(
    driftPath,
    JSON.stringify({
      generated_at: isoAgo(2),
      ok: false,
      checks: [
        { check: "devin.files", ok: false, detail: "missing parser at C:\\Users\\alice\\.devin\\state" },
        { check: "claude.files", ok: true, detail: "ok" },
      ],
    }),
    "utf8",
  );
  writeFileSync(path.join(arpdDir, "mirror", "runs.json"), JSON.stringify({ exported_at: 1, runs: [{ project: "analytics-engine" }] }), "utf8");

  return { ledgerPath, memoryPath, driftPath, arpdDir, now: nowDate };
}

describe("Overdrive v0.3.0 strict_local intention miner & redaction", () => {
  it("redacts emails, home paths, tokens, private keys, and raw prompt excerpts", () => {
    const dirty = [
      "Contact alice@example.com or bob.smith+dev@sub.domain.org",
      "Win: C:\\Users\\alice\\.ssh\\id_rsa and D:/Users/bob/proj",
      "Posix: /Users/charlie/Desktop and /home/dave/.env",
      "Tokens: sk-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz12 xoxb-1234567890-abcdef Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "rawPrompt: \"secret instruction here\"",
      "<USER_REQUEST>do secret thing</USER_REQUEST>",
    ].join("\n");
    const clean = redactPrivateSignals(dirty);
    assert.ok(!clean.includes("alice@example.com"));
    assert.ok(!clean.includes("bob.smith+dev@sub.domain.org"));
    assert.ok(!clean.includes("C:\\Users\\alice"));
    assert.ok(!clean.includes("D:/Users/bob"));
    assert.ok(!clean.includes("/Users/charlie"));
    assert.ok(!clean.includes("/home/dave"));
    assert.ok(!clean.includes("sk-1234567890abcdef"));
    assert.ok(!clean.includes("ghp_abcdefghijklmnopqrstuvwxyz12"));
    assert.ok(!clean.includes("xoxb-1234567890-abcdef"));
    assert.ok(!clean.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert.ok(!clean.includes("BEGIN RSA PRIVATE KEY"));
    assert.ok(!clean.includes("secret instruction here"));
    assert.ok(!clean.includes("do secret thing"));
  });

  it("mines mocked ledger.sqlite with went_quiet >= 72h strictly as owner_question + autoDispatch:false", () => {
    const dir = makeTempDir("intentions-mock");
    const opts = createMockIntentionFixtures(dir);
    const digest = mineIntentionDigest(opts);

    assert.equal(validateIntentionDigest(digest).ok, true);
    assert.equal(digest.privacyMode, "strict_local");
    assert.equal(digest.totalSessions, 4);
    assert.ok(digest.cloudOffloadPct > 0);
    assert.ok(digest.freePoolPct >= 50);

    // Active projects (<72h): analytics-engine and overdrive, sorted by momentum
    assert.ok(digest.activeFocus.some((f) => f.project === "analytics-engine"));
    assert.ok(digest.activeFocus.some((f) => f.project === "overdrive"));
    assert.equal(digest.activeFocus.some((f) => f.project === "search-core"), false);
    assert.equal(digest.activeFocus.some((f) => f.project === "legacy-app"), false);

    // Quiet >= 72h & <= 14d: search-core ONLY in wentQuietQuestions with owner_question + autoDispatch:false
    assert.equal(digest.wentQuietQuestions.length, 1);
    assert.equal(digest.wentQuietQuestions[0].project, "search-core");
    assert.equal(digest.wentQuietQuestions[0].kind, "owner_question");
    assert.equal(digest.wentQuietQuestions[0].autoDispatch, false);
    assert.ok(digest.wentQuietQuestions[0].quietHours >= 72);

    assert.ok(digest.frictionHotspots.length >= 3);
    assert.ok(digest.driftAlerts.length >= 2);
  });

  it("handles missing or corrupt SQLite files gracefully without crashing", () => {
    const dir = makeTempDir("intentions-corrupt");
    const badLedger = path.join(dir, "corrupt.sqlite");
    writeFileSync(badLedger, "not a sqlite database at all", "utf8");

    const missingDigest = mineIntentionDigest({
      ledgerPath: path.join(dir, "does-not-exist.sqlite"),
      memoryPath: path.join(dir, "no-mem.db"),
      driftPath: path.join(dir, "no-drift.json"),
      arpdDir: path.join(dir, "no-arpd"),
    });
    assert.equal(validateIntentionDigest(missingDigest).ok, true);
    assert.equal(missingDigest.totalSessions, 0);

    const corruptDigest = mineIntentionDigest({
      ledgerPath: badLedger,
      memoryPath: null,
      driftPath: null,
      arpdDir: null,
    });
    assert.equal(validateIntentionDigest(corruptDigest).ok, true);
    assert.equal(corruptDigest.totalSessions, 0);
    assert.ok(corruptDigest.driftAlerts.some((d) => d.source === "ledger.sqlite"));
  });

  it("probes live configured ledger read-only without crashing or leaking PII if present", () => {
    if (!existsSync(DEFAULT_LEDGER_PATH)) return;
    const digest = mineIntentionDigest();
    assert.equal(validateIntentionDigest(digest).ok, true);
    assert.equal(digest.privacyMode, "strict_local");
    assert.ok(digest.totalSessions > 0);
  });
});

describe("Overdrive v0.3.0 Golden Benchmark, Ratcheted RSI & Rollback", () => {
  it("runs 5-dimension Golden Benchmark cleanly on the worktree with continuous operationalMetrics", async () => {
    const bench = await runRsiBenchmark({ rootDir: REPO_ROOT });
    assert.equal(bench.ok, true, bench.failures.join("\n"));
    assert.equal(bench.regressions, 0);
    assert.equal(bench.score, 100);
    assert.equal(bench.maxScore, 100);
    assert.equal(bench.partitionScore, 20);
    assert.equal(bench.securityScore, 20);
    assert.equal(bench.routingScore, 20);
    assert.equal(bench.ratchetScore, 20);
    assert.equal(bench.replayScore, 20);
    assert.ok(bench.operationalMetrics);
    assert.ok(typeof bench.operationalScore === "number" && bench.operationalScore > 0 && bench.operationalScore <= 100);
    assert.ok(typeof bench.compositeScore === "number" && bench.compositeScore > 0 && bench.compositeScore <= 100);
    assert.ok(bench.operationalMetrics.benchmarkDurationMs >= 1);
  });

  it("emits >48h stale ledger driftAlert, filters 30d friction window, and excludes Grok X search from Overdrive routing candidates", async () => {
    const dir = makeTempDir("intentions-stale");
    const ledgerPath = path.join(dir, "ledger.sqlite");
    const db = new DatabaseSync(ledgerPath);
    db.exec(`
      CREATE TABLE sessions (uid TEXT PRIMARY KEY, harness TEXT, project TEXT, cwd TEXT, title TEXT, started_at TEXT, ended_at TEXT, models TEXT, n_llm INTEGER, n_tool INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, is_subagent INTEGER);
      CREATE TABLE tool_calls (session_uid TEXT, tool TEXT, status TEXT, duplicate_of TEXT);
      CREATE TABLE llm_calls (session_uid TEXT, model TEXT, status TEXT, error_type TEXT, retries INTEGER);
      CREATE TABLE marks (session_uid TEXT, kind TEXT, value TEXT, ts TEXT);
      CREATE TABLE sources (name TEXT, last_ts TEXT, parseable INTEGER, note TEXT);
    `);
    const nowMs = new Date("2026-11-18T12:00:00Z").getTime();
    const isoDaysAgo = (d) => new Date(nowMs - d * 86_400_000).toISOString();
    // Newest session 5 days ago (>48h), plus old session 45 days ago (>30d window)
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s-grok", "grok", "grok-research", "/workspace/grok", "search", isoDaysAgo(6), isoDaysAgo(5), "grok", 5, 10, 1000, 500, 0, 0,
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s-old-45d", "claude", "overdrive", "/workspace/overdrive", "old work", isoDaysAgo(46), isoDaysAgo(45), "claude-opus-5-5", 2, 2, 1000, 500, 0, 0,
    );
    db.prepare("INSERT INTO tool_calls VALUES(?,?,?,?)").run("s-grok", "X search: crypto", "error", null);
    db.prepare("INSERT INTO tool_calls VALUES(?,?,?,?)").run("s-old-45d", "AncientTooOldTool", "error", null);
    db.close();

    const digest = mineIntentionDigest({
      ledgerPath,
      memoryPath: path.join(dir, "no-mem.db"),
      driftPath: path.join(dir, "no-drift.json"),
      arpdDir: path.join(dir, "no-arpd"),
      now: new Date(nowMs),
    });
    assert.ok(digest.sourcesSummary.ledgerStaleHours >= 119);
    assert.ok(digest.driftAlerts.some((a) => a.source === "ledger.sqlite" && a.severity === "warn" && /stale/i.test(a.message)));
    assert.equal(digest.frictionHotspots.some((h) => /AncientTooOldTool/i.test(h.label)), false);
    const grokHot = digest.frictionHotspots.find((h) => /X search/i.test(h.label));
    assert.ok(grokHot);
    assert.equal(grokHot.harness, "grok");

    const store = new OverdriveStore(makeTempDir("grok-filter-store"));
    cleanupFns.push(() => store.close());
    const scan = await scanRsiOpportunities(store, {
      intentionsOpts: { ledgerPath, memoryPath: null, driftPath: null, arpdDir: null, now: new Date(nowMs) },
      benchmarkRoot: REPO_ROOT,
      repoRoot: REPO_ROOT,
    });
    const modCand = scan.candidates.find((c) => c.id === "rsi-self-modernize-routing");
    assert.ok(modCand);
    assert.equal(modCand.title.includes("X search"), false);
  });

  it("enforces Tier A vs Tier B, regression blocking, harness protection, cross-family audit, and prePromoteCommit rollback", async () => {
    const fxDir = makeTempDir("rsi-fx");
    const intentionsOpts = createMockIntentionFixtures(fxDir);
    const { repo, head, run } = initTempGitRepo();
    const dataDir = makeTempDir("rsi-store");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const scan = await scanRsiOpportunities(store, {
      intentionsOpts,
      benchmarkRoot: REPO_ROOT,
      repoRoot: repo,
    });
    assert.equal(scan.ok, true);
    assert.ok(scan.candidates.length >= 4);

    const selfCand = scan.candidates.find((c) => c.tier === "self_sandbox");
    const propCand = scan.candidates.find((c) => c.tier === "proposal_only" && c.targetRepo === "analytics-engine");
    assert.ok(selfCand, "expected at least one self_sandbox candidate");
    assert.ok(propCand, "expected proposal_only candidate for external repo analytics-engine");

    // 1. Regression blocks promotion
    const regCycle = await runRsiVerificationCycle(store, selfCand.id, {
      worktreeRoot: REPO_ROOT,
      evaluatorFn: async () => ({ score: 85, regressions: 1 }),
    });
    assert.equal(regCycle.ok, false);
    assert.equal(regCycle.candidate.status, "rejected");
    await assert.rejects(() => promoteRsiCandidate(store, selfCand.id, { repoRoot: repo }), /regress/i);

    // 2. Protected harness tampering blocks promotion even with high score
    const tamperCycle = await runRsiVerificationCycle(store, selfCand.id, {
      worktreeRoot: REPO_ROOT,
      touchesFiles: ["checks/rsi-benchmark.mjs"],
      evaluatorFn: async () => ({ score: 100, regressions: 0 }),
    });
    assert.equal(tamperCycle.ok, false);
    assert.equal(tamperCycle.candidate.touchesHarness, true);
    assert.equal(tamperCycle.candidate.status, "rejected");
    await assert.rejects(() => promoteRsiCandidate(store, selfCand.id, { repoRoot: repo }), /harness/i);

    // 3. Same-family audit blocks promotion
    const sameFamCycle = await runRsiVerificationCycle(store, selfCand.id, {
      worktreeRoot: REPO_ROOT,
      touchesFiles: ["src/routing.mjs"],
      proposerFamily: "google",
      auditorFamily: "google",
      evaluatorFn: async () => ({ score: 100, regressions: 0 }),
    });
    assert.equal(sameFamCycle.ok, false);
    assert.equal(sameFamCycle.candidate.status, "rejected");
    await assert.rejects(() => promoteRsiCandidate(store, selfCand.id, { repoRoot: repo }), /approve|cross-family/i);

    // 4. Default cycle without cross-family execution returns evaluated_pending_audit and blocks promote until real audit receipt!
    const detOnly = await runRsiVerificationCycle(store, selfCand.id, {
      worktreeRoot: REPO_ROOT,
      touchesFiles: ["src/routing.mjs"],
      proposerFamily: "google",
      evaluatorFn: async () => ({ score: 100, regressions: 0 }),
    });
    assert.equal(detOnly.ok, true);
    assert.equal(detOnly.readyToPromote, false);
    assert.equal(detOnly.candidate.status, "evaluated_pending_audit");
    assert.equal(detOnly.candidate.audit.auditKind, "deterministic_local_gate");
    assert.equal(detOnly.candidate.audit.modelExecuted, false);
    await assert.rejects(() => promoteRsiCandidate(store, selfCand.id, { repoRoot: repo }), /executed cross-family model audit|audited/i);

    // 4b. Submitting real cross-family audit receipt moves candidate to audited -> promote records prePromoteCommit -> rollback restores
    const auditRes = await submitRsiAuditReceipt(store, selfCand.id, {
      auditorFamily: "openai",
      auditorModel: "gpt-6-astra",
      verdict: "approve",
      modelExecuted: true,
      notes: "Verified zero regressions in routing patch.",
      receiptRef: "test-receipt-1",
    });
    assert.equal(auditRes.ok, true);
    assert.equal(auditRes.candidate.status, "audited");
    assert.equal(auditRes.candidate.audit.modelExecuted, true);

    const promoted = await promoteRsiCandidate(store, selfCand.id, { repoRoot: repo });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.mergeState, "approved_only_no_git_merge");
    assert.equal(promoted.candidate.status, "promoted");
    assert.equal(promoted.candidate.prePromoteCommit, head);
    assert.equal(validateRsiCandidate(promoted.candidate).ok, true);

    // Advance temp git repo by one commit, then verify rollback resets back to prePromoteCommit!
    writeFileSync(path.join(repo, "README.md"), "# Promoted change\n", "utf8");
    run("add", "-A");
    run("commit", "-m", "post-promote commit");
    const advancedHead = run("rev-parse", "HEAD").stdout.trim();
    assert.notEqual(advancedHead, head);

    const rolled = await rollbackRsiCandidate(store, selfCand.id, { repoRoot: repo, applyGitReset: true });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.candidate.status, "rolled_back");
    assert.equal(rolled.restoredCommit, head);
    assert.equal(run("rev-parse", "HEAD").stdout.trim(), head);

    // 4c. runCrossFamilyAudit: true with injected auditRunner records connect_anything_model receipt,
    // and applyGitMerge: true verifies trial worktree benchmark + fast-forward merges candidate branch
    run("checkout", "-b", "rsi/real-merge-test");
    writeFileSync(path.join(repo, "NOTES.md"), "Clean RSI improvement\n", "utf8");
    run("add", "-A");
    run("commit", "-m", "candidate commit on branch");
    const branchTip = run("rev-parse", "HEAD").stdout.trim();
    run("checkout", "-");
    assert.equal(run("rev-parse", "HEAD").stdout.trim(), head);

    const liveAudCycle = await runRsiVerificationCycle(store, selfCand.id, {
      worktreeRoot: REPO_ROOT,
      touchesFiles: ["src/routing.mjs"],
      proposerFamily: "google",
      runCrossFamilyAudit: true,
      auditRunner: async () => ({ verdict: "approve", notes: "Codex CLI approved.", receiptRef: "ca-live-1" }),
      evaluatorFn: async () => ({ score: 100, regressions: 0 }),
    });
    assert.equal(liveAudCycle.readyToPromote, true);
    assert.equal(liveAudCycle.candidate.status, "audited");
    assert.equal(liveAudCycle.candidate.audit.auditKind, "connect_anything_model");
    assert.equal(liveAudCycle.candidate.audit.modelExecuted, true);

    const mergedProm = await promoteRsiCandidate(store, selfCand.id, {
      repoRoot: repo,
      applyGitMerge: true,
      sourceBranch: "rsi/real-merge-test",
    });
    assert.equal(mergedProm.ok, true);
    assert.equal(mergedProm.mergeState, "merged_ff_only");
    assert.equal(mergedProm.mergedCommit, branchTip);
    assert.equal(run("rev-parse", "HEAD").stdout.trim(), branchTip);
    // Rollback after ff-merge cleanly resets back to prePromoteCommit!
    const rolledMerged = await rollbackRsiCandidate(store, selfCand.id, { repoRoot: repo, applyGitReset: true });
    assert.equal(rolledMerged.restoredCommit, head);
    assert.equal(run("rev-parse", "HEAD").stdout.trim(), head);

    // 5. Tier B proposal_only fails closed on missing cross-family audit AND on humanApproved: false
    const propCycle = await runRsiVerificationCycle(store, propCand.id, {
      worktreeRoot: REPO_ROOT,
      evaluatorFn: async () => ({ score: 100, regressions: 0 }),
    });
    assert.equal(propCycle.ok, true);
    assert.equal(propCycle.candidate.status, "evaluated_pending_audit");
    await submitRsiAuditReceipt(store, propCand.id, {
      auditorFamily: "anthropic",
      auditorModel: "claude-opus-5-5",
      verdict: "approve",
      modelExecuted: true,
      receiptRef: "test-prop-audit",
    });
    await assert.rejects(
      () => promoteRsiCandidate(store, propCand.id, { humanApproved: false, repoRoot: repo }),
      /humanApproved/,
    );
    const propPromoted = await promoteRsiCandidate(store, propCand.id, { humanApproved: true, repoRoot: repo });
    assert.equal(propPromoted.ok, true);
    assert.equal(propPromoted.candidate.status, "promoted");
    assert.equal(propPromoted.candidate.humanApproved, true);

    const runs = store.listRsiRuns(selfCand.id, 20);
    assert.ok(runs.some((r) => r.kind === "verify_cycle"));
    assert.ok(runs.some((r) => r.kind === "audit_receipt"));
    assert.ok(runs.some((r) => r.kind === "promote" && r.commitSha === head));
    assert.ok(runs.some((r) => r.kind === "rollback" && r.commitSha === head));
  });

  it("persists ownedRegions, ignoreUntrackedGlobs, readOnlyMounts, and strips holdouts in OverdriveStore", async () => {
    const { repo } = initTempGitRepo();
    const dataDir = makeTempDir("v03-store");
    const store = new OverdriveStore(dataDir);
    cleanupFns.push(() => store.close());

    const m = store.createMission({ title: "v0.3 Contracts & Regions", goal: "Verify anti-leakage", repoRoot: repo });
    const planned = store.planMission(m.id, {
      sharedContracts: [{ path: "README.md", description: "Frozen doc" }],
      lanes: [
        {
          id: "core-a",
          title: "Core A",
          ownedGlobs: ["src/a/**"],
          ownedRegions: [{ path: "bin/app.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" }],
          ignoreUntrackedGlobs: ["target/**"],
          readOnlyMounts: [{ source: "/workspace/fixtures-data", target: "fixtures/data" }],
          offload: "devin-vm",
          ratchet: {
            metrics: [{ name: "parity", baseline: 94.2, target: 96.8, op: ">=", maxRegression: 0 }],
            holdoutCmd: "node secret_holdout.mjs",
            holdoutEnv: { SECRET: "top-secret" },
          },
          verifyCmd: "node -v",
        },
      ],
      gates: [
        {
          id: "g1",
          title: "Parity Gate",
          cmd: "node -v",
          offload: "aipc-gpu",
          ratchet: {
            metrics: [{ name: "parity", baseline: 94.2, op: ">=" }],
            holdoutCmd: "node secret_gate_holdout.mjs",
          },
        },
      ],
    });
    assert.equal(planned.ok, true);
    const hydrated = store.getMission(m.id);
    const lane = hydrated.lanes[0];
    assert.equal(lane.offload, "devin-vm");
    assert.deepEqual(lane.ownedRegions, [{ path: "bin/app.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A", boundaryMode: "exclusive" }]);
    assert.deepEqual(lane.ignoreUntrackedGlobs, ["target/**"]);
    assert.deepEqual(lane.readOnlyMounts, [{ source: "/workspace/fixtures-data", target: "fixtures/data" }]);
    assert.equal(lane.ratchet.holdoutConfigured, true);
    assert.equal(lane.ratchet.holdoutCmd, undefined);
    assert.equal(lane.ratchet.holdoutEnv, undefined);
    assert.equal(validateRatchetSpec(lane.ratchet, { allowHoldout: false }).ok, true);

    const gate = hydrated.gates[0];
    assert.equal(gate.offload, "aipc-gpu");
    assert.equal(gate.ratchet.holdoutConfigured, true);
    assert.equal(gate.ratchet.holdoutCmd, undefined);

    // Ensure topology_planned replay checkpoint also stripped holdouts
    const planEv = store.listMissionEvents(m.id, { afterSeq: 0, limit: 20 }).events.find((e) => e.type === "topology_planned");
    assert.equal(planEv.replay.checkpoint.lanes["core-a"].ratchet.holdoutCmd, undefined);
    assert.equal(planEv.replay.checkpoint.lanes["core-a"].ratchet.holdoutConfigured, true);
    assert.equal(planEv.replay.checkpoint.gates.g1.ratchet.holdoutCmd, undefined);

    // Overview auto-seeds on empty DB and MCP handler wires all RSI tools
    const handler = createToolHandler(store);
    const ov = getRsiOverview(store, { repoRoot: REPO_ROOT });
    assert.equal(ov.ok, true);
    assert.ok(ov.candidates.length >= 1);

    // Showcase preview candidates must not be promoted directly without real verification
    await assert.rejects(() => promoteRsiCandidate(store, "rsi-cloud-offload-swe2", { repoRoot: repo }), /showcase/i);

    const mcpScan = await handler("overdrive_rsi_scan", {
      ...createMockIntentionFixtures(makeTempDir("mcp-fx")),
      benchmarkRoot: REPO_ROOT,
      repoRoot: repo,
    });
    assert.equal(mcpScan.ok, true);
    const candId = mcpScan.candidates.find((c) => c.tier === "self_sandbox").id;
    const mcpCycle = await handler("overdrive_rsi_cycle", { candidateId: candId, worktreeRoot: REPO_ROOT });
    assert.equal(mcpCycle.ok, true);
    assert.equal(mcpCycle.readyToPromote, false);
    assert.equal(mcpCycle.candidate.status, "evaluated_pending_audit");
    await assert.rejects(() => handler("overdrive_rsi_promote", { candidateId: candId, repoRoot: repo }), /audit/i);
    const mcpAudit = await handler("overdrive_rsi_audit", {
      candidateId: candId,
      auditorFamily: "openai",
      auditorModel: "gpt-6-astra",
      verdict: "approve",
      modelExecuted: true,
      receiptRef: "mcp-audit-1",
    });
    assert.equal(mcpAudit.ok, true);
    assert.equal(mcpAudit.candidate.status, "audited");
    const mcpProm = await handler("overdrive_rsi_promote", { candidateId: candId, repoRoot: repo });
    assert.equal(mcpProm.ok, true);
    assert.equal(mcpProm.mergeState, "approved_only_no_git_merge");
    const mcpRoll = await handler("overdrive_rsi_rollback", { candidateId: candId });
    assert.equal(mcpRoll.ok, true);
    assert.equal(mcpRoll.candidate.status, "rolled_back");

    // String "false" for humanApproved on proposal_only must NOT coerce to true
    const extCand = mcpScan.candidates.find((c) => c.tier === "proposal_only");
    await handler("overdrive_rsi_cycle", { candidateId: extCand.id, worktreeRoot: REPO_ROOT });
    await handler("overdrive_rsi_audit", {
      candidateId: extCand.id,
      auditorFamily: "openai",
      auditorModel: "gpt-6-astra",
      verdict: "approve",
      modelExecuted: true,
      receiptRef: "mcp-audit-ext",
    });
    await assert.rejects(
      () => handler("overdrive_rsi_promote", { candidateId: extCand.id, humanApproved: "false", repoRoot: repo }),
      /humanApproved/,
    );

    // Dirty tracked edit in repo blocks rollbackRsiCandidate git reset --hard
    writeFileSync(path.join(repo, "README.md"), "# Uncommitted dirty work\n", "utf8");
    await assert.rejects(
      () => handler("overdrive_rsi_rollback", { candidateId: candId, repoRoot: repo, applyGitReset: true }),
      /uncommitted tracked/i,
    );

    // Env assignment secret redaction check
    const scrubbedEnv = redactPrivateSignals("diagnostic API_TOKEN=supersecret_999 value");
    assert.equal(scrubbedEnv.includes("supersecret_999"), false);
  });
});
