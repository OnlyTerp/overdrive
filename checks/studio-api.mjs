import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startStudioServer } from "../src/server.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { defaultTestScratchBase } from "../src/paths.mjs";
import {
  CSP_HEADER,
  REPLAY_VERSION,
  SHOWCASE_FIXTURE_VERSION,
  SHOWCASE_SLUG,
  STATIC_ASSET_MANIFEST,
  validateDemoSeedResponse,
  validateDiffResponse,
  validateEventsResponse,
  validateInspectionResponse,
  validateIntentionDigest,
  validateReplayEnvelope,
  validateRsiCandidate,
} from "../src/ui-contracts.mjs";
import { VERSION } from "../src/version.mjs";

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

describe("Overdrive Studio v0.2.0 HTTP API & security gate (g3)", () => {
  it("serves allowlisted assets with CSP, enforces token/origin 403, seeds showcase, and passes contract validators", async () => {
    const dataDir = mkdtempSync(path.join(TEST_SCRATCH_BASE, "studio-api-"));
    cleanupFns.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const store = new OverdriveStore(dataDir);
    const srv = await startStudioServer(store, { port: 0, fixedPort: false });
    cleanupFns.push(async () => {
      await srv.close();
      store.close();
    });

    // 1. Allowlisted static assets & strict CSP
    for (const [urlPath, expectedMime] of [
      ["/", "text/html"],
      ["/styles.css", "text/css"],
      ["/app.js", "application/javascript"],
      ["/contracts.js", "application/javascript"],
      ["/dom.js", "application/javascript"],
      ["/src/partition.mjs", "application/javascript"],
    ]) {
      const res = await fetch(`${srv.origin}${urlPath}`);
      assert.equal(res.status, 200, `${urlPath} should return 200`);
      assert.equal(res.headers.get("content-security-policy"), CSP_HEADER);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-type") || "", new RegExp(expectedMime));
    }

    // Optional/peer-lane manifest assets return 200 if merged or clean 404 if unmerged
    for (const asset of STATIC_ASSET_MANIFEST) {
      const res = await fetch(`${srv.origin}${asset.urlPath}`);
      assert.ok(res.status === 200 || res.status === 404, `${asset.urlPath} returned unexpected ${res.status}`);
      assert.equal(res.headers.get("content-security-policy"), CSP_HEADER);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cache-control"), "no-store");
    }

    // Non-allowlisted source files must never be exposed
    const blockedNoTok = await fetch(`${srv.origin}/src/server.mjs`);
    assert.equal(blockedNoTok.status, 403);
    const blockedWithTok = await fetch(`${srv.origin}/src/server.mjs`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(blockedWithTok.status, 404);

    // 2. Auth & origin security checks
    const unauthState = await fetch(`${srv.origin}/api/state`);
    assert.equal(unauthState.status, 403);

    const unauthSeed = await fetch(`${srv.origin}/api/demo/seed`, { method: "POST" });
    assert.equal(unauthSeed.status, 403);

    const badOriginSeed = await fetch(`${srv.origin}/api/demo/seed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "X-Overdrive-Token": srv.token,
      },
      body: "{}",
    });
    assert.equal(badOriginSeed.status, 403);

    const crossSiteGet = await fetch(`${srv.origin}/api/state`, {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "X-Overdrive-Token": srv.token,
      },
    });
    assert.equal(crossSiteGet.status, 403);

    // 3. POST /api/demo/seed (idempotent) + validateDemoSeedResponse
    const seedRes = await fetch(`${srv.origin}/api/demo/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: "{}",
    });
    assert.equal(seedRes.status, 200);
    const seedJson = await seedRes.json();
    assert.equal(validateDemoSeedResponse(seedJson).ok, true);
    assert.equal(seedJson.slug, SHOWCASE_SLUG);
    assert.equal(seedJson.fixtureVersion, SHOWCASE_FIXTURE_VERSION);
    assert.equal(seedJson.created, true);

    const seedRes2 = await fetch(`${srv.origin}/api/demo/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: "{}",
    });
    assert.equal(seedRes2.status, 200);
    const seedJson2 = await seedRes2.json();
    assert.equal(seedJson2.created, false);
    assert.equal(seedJson2.missionId, seedJson.missionId);

    // 4. GET /api/state
    const stateRes = await fetch(`${srv.origin}/api/state`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.version, VERSION);
    assert.equal(stateJson.replayVersion, REPLAY_VERSION);
    assert.equal(stateJson.activeMission.slug, SHOWCASE_SLUG);
    assert.ok(stateJson.rsi && typeof stateJson.rsi.candidateCount === "number");

    // 5. GET /api/missions/:id/events paginated
    const evRes1 = await fetch(`${srv.origin}/api/missions/${seedJson.missionId}/events?after=0&limit=5`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(evRes1.status, 200);
    const evJson1 = await evRes1.json();
    assert.equal(validateEventsResponse(evJson1).ok, true);
    assert.equal(evJson1.events.length, 5);
    assert.equal(evJson1.hasMore, true);
    for (const ev of evJson1.events) {
      assert.equal(validateReplayEnvelope(ev.replay).ok, true);
    }

    const evRes2 = await fetch(
      `${srv.origin}/api/missions/${seedJson.missionId}/events?after=${evJson1.nextAfterSeq}&limit=250`,
      { headers: { "X-Overdrive-Token": srv.token } },
    );
    assert.equal(evRes2.status, 200);
    const evJson2 = await evRes2.json();
    assert.equal(validateEventsResponse(evJson2).ok, true);
    assert.equal(evJson2.hasMore, false);
    assert.ok(evJson2.events.length >= 10);

    // 6. GET /api/missions/:id/lanes/:laneId/diff & inspection
    const diffRes = await fetch(`${srv.origin}/api/missions/${seedJson.missionId}/lanes/engine/diff`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(diffRes.status, 200);
    const diffJson = await diffRes.json();
    assert.equal(validateDiffResponse(diffJson).ok, true);
    assert.equal(diffJson.files.length, 2);
    assert.equal(diffJson.scopeOk, true);

    const inspRes = await fetch(`${srv.origin}/api/missions/${seedJson.missionId}/lanes/interface/inspection`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(inspRes.status, 200);
    const inspJson = await inspRes.json();
    assert.equal(validateInspectionResponse(inspJson).ok, true);
    assert.equal(inspJson.laneId, "interface");
    assert.equal(inspJson.telemetry.model, "claude-opus-5-5");

    // 7. POST /api/missions with invalid vs valid topology
    const badCreate = await fetch(`${srv.origin}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({
        title: "Invalid Overlap",
        goal: "Should fail before inserting mission",
        repoRoot: dataDir,
        lanes: [
          { id: "a", ownedGlobs: ["src/**"], verifyCmd: "node -v" },
          { id: "b", ownedGlobs: ["src/ui/**"], verifyCmd: "node -v" },
        ],
      }),
    });
    assert.equal(badCreate.status, 400);
    assert.equal(store.listMissions().length, 1);

    const goodCreate = await fetch(`${srv.origin}/api/missions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({
        title: "Composer Direct Mission",
        goal: "Create and plan atomically",
        repoRoot: dataDir,
        routingMode: "single-harness",
        activeHarness: "antigravity",
        lanes: [
          { id: "core", ownedGlobs: ["src/core/**"], verifyCmd: "node -v" },
          { id: "ui", ownedGlobs: ["ui/**"], verifyCmd: "node -v" },
        ],
      }),
    });
    assert.equal(goodCreate.status, 200);
    const goodJson = await goodCreate.json();
    assert.equal(goodJson.ok, true);
    assert.equal(goodJson.mission.state, "planned");
    assert.equal(goodJson.mission.lanes.length, 2);

    // 8. SSE /api/stream emits initial connected frame and closes cleanly
    const abortCtrl = new AbortController();
    const sseRes = await fetch(`${srv.origin}/api/stream?token=${encodeURIComponent(srv.token)}`, {
      signal: abortCtrl.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") || "", /text\/event-stream/);
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const firstChunk = new TextDecoder().decode(value);
    assert.match(firstChunk, /"type":"connected"/);
    abortCtrl.abort();
    await reader.cancel().catch(() => {});

    // 9. v0.3 /api/rsi/* routes: auth/CSRF/CSP enforcement & fail-closed promotion/rollback
    for (const [method, p] of [
      ["GET", "/api/rsi/overview"],
      ["POST", "/api/rsi/scan"],
      ["POST", "/api/rsi/cycle"],
      ["POST", "/api/rsi/candidates/c1/promote"],
      ["POST", "/api/rsi/candidates/c1/rollback"],
      ["POST", `/api/missions/${goodJson.mission.id}/integrate`],
    ]) {
      const noTok = await fetch(`${srv.origin}${p}`, { method });
      assert.equal(noTok.status, 403, `${method} ${p} must require token`);
      const badOrigin = await fetch(`${srv.origin}${p}`, {
        method,
        headers: { Origin: "https://evil.example", "X-Overdrive-Token": srv.token, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(badOrigin.status, 403, `${method} ${p} must reject cross-site origin`);
      const crossSite = await fetch(`${srv.origin}${p}`, {
        method,
        headers: { "Sec-Fetch-Site": "cross-site", "X-Overdrive-Token": srv.token, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(crossSite.status, 403, `${method} ${p} must reject cross-site Sec-Fetch-Site`);
    }

    const rsiOverviewRes = await fetch(`${srv.origin}/api/rsi/overview`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(rsiOverviewRes.status, 200);
    assert.equal(rsiOverviewRes.headers.get("content-security-policy"), CSP_HEADER);
    const rsiOverview = await rsiOverviewRes.json();
    assert.equal(rsiOverview.ok, true);
    assert.equal(validateIntentionDigest(rsiOverview.digest).ok, true);
    assert.ok(rsiOverview.candidates.length >= 1);
    for (const c of rsiOverview.candidates) {
      assert.equal(validateRsiCandidate(c).ok, true);
    }

    // Isolated mocked ledger for POST /api/rsi/scan
    const ledgerDir = mkdtempSync(path.join(TEST_SCRATCH_BASE, "api-rsi-ledger-"));
    cleanupFns.push(() => rmSync(ledgerDir, { recursive: true, force: true }));
    const mockLedgerPath = path.join(ledgerDir, "ledger.sqlite");
    const ldb = new DatabaseSync(mockLedgerPath);
    ldb.exec(`
      CREATE TABLE sessions (uid TEXT PRIMARY KEY, harness TEXT, project TEXT, cwd TEXT, title TEXT, started_at TEXT, ended_at TEXT, models TEXT, n_llm INT, n_tool INT, tokens_in INT, tokens_out INT, cost_usd REAL, is_subagent INT);
      CREATE TABLE llm_calls (session_uid TEXT, model TEXT, status TEXT, error_type TEXT, retries INT);
      CREATE TABLE tool_calls (session_uid TEXT, tool TEXT, status TEXT, duplicate_of TEXT);
      CREATE TABLE marks (kind TEXT, value TEXT);
      CREATE TABLE sources (name TEXT, last_ts TEXT);
    `);
    const nowIso = new Date().toISOString();
    const quietIso = new Date(Date.now() - 96 * 3_600_000).toISOString();
    ldb.prepare("INSERT INTO sessions VALUES ('s1','devin','analytics-engine','/workspace/analytics-engine','title',?,?, 'swe-2-flash',1,1,1000,200,0,1)").run(nowIso, nowIso);
    ldb.prepare("INSERT INTO sessions VALUES ('s2','claude','search-core','/workspace/search-core','quiet',?,?, 'claude-opus-5-5',1,1,1000,200,0.4,0)").run(quietIso, quietIso);
    ldb.close();

    const scanRes = await fetch(`${srv.origin}/api/rsi/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({
        intentionsOpts: { ledgerPath: mockLedgerPath, memoryPath: null, driftPath: null, arpdDir: null },
        benchmarkRoot: REPO_ROOT,
        repoRoot: REPO_ROOT,
      }),
    });
    assert.equal(scanRes.status, 200);
    const scanJson = await scanRes.json();
    assert.equal(scanJson.ok, true);
    assert.equal(validateIntentionDigest(scanJson.digest).ok, true);
    const selfCand = scanJson.candidates.find((c) => c.tier === "self_sandbox");
    const propCand = scanJson.candidates.find((c) => c.tier === "proposal_only");
    assert.ok(selfCand && propCand);

    // Cycle stays evaluated_pending_audit until an executed cross-family audit receipt is recorded
    for (const cid of [selfCand.id, propCand.id]) {
      const cyc = await fetch(`${srv.origin}/api/rsi/cycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
        body: JSON.stringify({ candidateId: cid, worktreeRoot: REPO_ROOT }),
      });
      assert.equal(cyc.status, 200);
      const cycJson = await cyc.json();
      assert.equal(cycJson.ok, true);
      assert.equal(cycJson.readyToPromote, false);
      assert.equal(cycJson.candidate.status, "evaluated_pending_audit");
      assert.equal(cycJson.candidate.audit.modelExecuted, false);

      // Promote fails closed prior to cross-family model audit receipt -> 400
      const noAuditPromote = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(cid)}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
        body: JSON.stringify({ humanApproved: true }),
      });
      assert.equal(noAuditPromote.status, 400);

      const aud = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(cid)}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
        body: JSON.stringify({
          auditorFamily: "openai",
          auditorModel: "gpt-6-astra",
          verdict: "approve",
          modelExecuted: true,
          receiptRef: `studio-api-${cid}`,
        }),
      });
      assert.equal(aud.status, 200);
      const audJson = await aud.json();
      assert.equal(audJson.candidate.status, "audited");
    }

    const podRes = await fetch(`${srv.origin}/api/adhd/pod-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({ goal: "API test", totalThinkers: 8 }),
    });
    assert.equal(podRes.status, 200);
    assert.equal((await podRes.json()).plan.mode, "two-pass-tournament");

    const asstRes = await fetch(`${srv.origin}/api/assistants?role=research`, {
      headers: { "X-Overdrive-Token": srv.token },
    });
    assert.equal(asstRes.status, 200);
    const asstJson = await asstRes.json();
    assert.equal(asstJson.ok, true);

    const blockedProp = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(propCand.id)}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({ humanApproved: false }),
    });
    assert.equal(blockedProp.status, 400);

    const okProp = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(propCand.id)}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({ humanApproved: true }),
    });
    assert.equal(okProp.status, 200);

    const okSelf = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(selfCand.id)}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({ repoRoot: REPO_ROOT }),
    });
    assert.equal(okSelf.status, 200);
    const selfPromJson = await okSelf.json();
    assert.equal(selfPromJson.candidate.status, "promoted");
    assert.equal(selfPromJson.mergeState, "approved_only_no_git_merge");

    const okRollback = await fetch(`${srv.origin}/api/rsi/candidates/${encodeURIComponent(selfCand.id)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: JSON.stringify({}),
    });
    assert.equal(okRollback.status, 200);
    assert.equal((await okRollback.json()).candidate.status, "rolled_back");

    const intRes = await fetch(`${srv.origin}/api/missions/${goodJson.mission.id}/integrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Overdrive-Token": srv.token },
      body: "{}",
    });
    assert.ok([200, 400, 501].includes(intRes.status), `unexpected /integrate status ${intRes.status}`);
  });
});
