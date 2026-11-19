import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import {
  ASSISTANT_IDS,
  CLOUD_PROVIDERS,
  COMPATIBLE_TARGET_VERSIONS,
  CONTRACT_FIXTURES,
  CSP_HEADER,
  DIFF_CAPS,
  DISPATCH_MODES,
  OFFLOAD_MODES,
  PRIVACY_MODES,
  ROUTES,
  RSI_TIERS,
  STATIC_ASSET_MANIFEST,
  TARGET_VERSION,
  UI_ASSETS,
  UI_CLASSES,
  createUiStore,
  toPublicRatchetSpec,
  validateDemoSeedResponse,
  validateDiffResponse,
  validateEventsResponse,
  validateInspectionResponse,
  validateIntentionDigest,
  validateRatchetResult,
  validateRatchetSpec,
  validateReplayEnvelope,
  validateRsiCandidate,
  validateTopology,
} from "../ui/contracts.js";
import { clear, createMockDom, h, highlightMatches, svg } from "../ui/dom.js";
import * as srvContracts from "../src/ui-contracts.mjs";

describe("v0.3.0 frozen contracts & XSS-safe DOM", () => {
  it("keeps browser ui/contracts.js and server src/ui-contracts.mjs aligned", () => {
    assert.deepEqual(srvContracts.UI_ASSETS, UI_ASSETS);
    assert.deepEqual(srvContracts.DIFF_CAPS, DIFF_CAPS);
    assert.deepEqual(srvContracts.OFFLOAD_MODES, OFFLOAD_MODES);
    assert.deepEqual(srvContracts.DISPATCH_MODES, DISPATCH_MODES);
    assert.equal(srvContracts.CSP_HEADER, CSP_HEADER);
    assert.equal(TARGET_VERSION, "0.3.0");
    assert.deepEqual(COMPATIBLE_TARGET_VERSIONS, ["0.2.0", "0.3.0"]);
    assert.ok(UI_ASSETS.includes("/styles.css"));
    assert.ok(UI_ASSETS.includes("/app.js"));
    assert.ok(UI_ASSETS.includes("/rsi-view.js"));
    assert.ok(UI_ASSETS.includes("/src/partition.mjs"));

    for (const a of STATIC_ASSET_MANIFEST) {
      const resolved = srvContracts.resolveAllowedStaticAsset(REPO_ROOT, a.urlPath);
      assert.ok(resolved, `asset ${a.urlPath} should resolve`);
      assert.ok(resolved.absPath.startsWith(path.resolve(REPO_ROOT)));
    }
    assert.equal(srvContracts.resolveAllowedStaticAsset(REPO_ROOT, "/etc/passwd"), null);
    assert.equal(srvContracts.resolveAllowedStaticAsset(REPO_ROOT, "/src/server.mjs"), null);
  });

  it("enforces zero innerHTML, zero inline style, and safe SVG/text construction", () => {
    const prevDoc = globalThis.document;
    const mock = createMockDom();
    globalThis.document = mock;
    try {
      assert.throws(() => h("div", { innerHTML: "<script>alert(1)</script>" }), /forbids/);
      assert.throws(() => h("div", { style: "color:red" }), /forbids/);
      assert.throws(() => h("button", { onclick: "evil()" }), /forbids/);

      const hostPayload = "<img src=x onerror=alert(1)>";
      const row = h("div", { className: UI_CLASSES.diffLine, dataset: { kind: "add" } }, hostPayload);
      mock.body.appendChild(row);
      assert.equal(row.textContent, hostPayload);
      assert.equal(row.querySelector("img"), null);

      const g = svg("svg", { className: UI_CLASSES.dagSvg, viewBox: "0 0 100 40" }, svg("rect", { x: "0", y: "0", width: "10", height: "10" }));
      assert.equal(g.tagName, "svg");
      assert.equal(g.childNodes.length, 1);

      const marks = highlightMatches("abcde", [1, 3]);
      assert.equal(marks.filter((n) => n.tagName === "mark").length, 2);
      clear(row);
      assert.equal(row.childNodes.length, 0);
    } finally {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
    }
  });

  it("validates shared store, replay, diff, inspection, events, demo and v0.3 topology contracts", () => {
    const store = createUiStore({ missionId: "m1" });
    let seen = 0;
    const off = store.subscribe((st) => {
      seen++;
      assert.equal(st.selectedLaneId, "core");
    });
    store.dispatch({ selectedLaneId: "core" });
    off();
    store.dispatch({ selectedLaneId: "ui" });
    assert.equal(seen, 1);

    assert.equal(validateReplayEnvelope(null).ok, true);
    assert.equal(validateReplayEnvelope(CONTRACT_FIXTURES.replayCheckpoint).ok, true);
    assert.equal(validateReplayEnvelope(CONTRACT_FIXTURES.replayDelta).ok, true);
    assert.equal(validateReplayEnvelope({ ...CONTRACT_FIXTURES.replayDelta, targetVersion: "0.2.0" }).ok, true);
    assert.equal(validateReplayEnvelope({ ...CONTRACT_FIXTURES.replayDelta, targetVersion: "9.9.9" }).ok, false);
    assert.equal(validateReplayEnvelope({ version: 2 }).ok, false);
    assert.equal(validateDiffResponse(CONTRACT_FIXTURES.diff).ok, true);
    assert.equal(validateInspectionResponse({ schemaVersion: 1, missionId: "m1", laneId: "core" }).ok, true);
    assert.equal(validateEventsResponse({ schemaVersion: 1, missionId: "m1", events: [] }).ok, true);
    assert.equal(validateDemoSeedResponse({ schemaVersion: 1, missionId: "m1", fixtureVersion: "v1" }).ok, true);
    assert.match(ROUTES.laneDiff("m1", "core", { receiptId: "r1" }), /\?receipt=r1$/);
    assert.equal(ROUTES.rsiOverview(), "/api/rsi/overview");
    assert.equal(ROUTES.rsiAudit("c1"), "/api/rsi/candidates/c1/audit");
    assert.equal(ROUTES.adhdPodPlan(), "/api/adhd/pod-plan");
    assert.match(ROUTES.assistants({ role: "research" }), /^\/api\/assistants\?role=research$/);
    assert.equal(ROUTES.missionIntegrate("m1"), "/api/missions/m1/integrate");
    assert.equal(ROUTES.rsiPromote("c1"), "/api/rsi/candidates/c1/promote");
    assert.equal(ROUTES.rsiRollback("c1"), "/api/rsi/candidates/c1/rollback");
    const baseRsi = {
      id: "c-base",
      category: "routing-efficiency",
      targetRepo: "overdrive",
      tier: "self_sandbox",
      title: "Base candidate",
      rationale: "Valid candidate fixture",
      evidenceRefs: ["bench:100"],
      baselineScore: 100,
      candidateScore: 100,
      regressions: 0,
      touchesHarness: false,
      prePromoteCommit: "deadbeef",
      proposer: { family: "google", modelId: "gemini-4-carbon" },
    };
    assert.equal(validateRsiCandidate({ ...baseRsi, id: "c-pend", status: "evaluated_pending_audit", audit: { verdict: "pending_audit", auditKind: "deterministic_local_gate", modelExecuted: false } }).ok, true);
    assert.equal(validateRsiCandidate({ ...baseRsi, id: "c-bad", status: "promoted", audit: { verdict: "approve", auditKind: "deterministic_local_gate", modelExecuted: false, auditorFamily: "openai", auditorModel: "gpt-6-astra" } }).ok, false);
    assert.ok(CLOUD_PROVIDERS.includes("claude-cloud"));
    assert.ok(ASSISTANT_IDS.includes("muse_ai"));
    assert.deepEqual(RSI_TIERS, ["self_sandbox", "proposal_only"]);
    assert.deepEqual(PRIVACY_MODES, ["strict_local"]);

    const check = validateTopology({
      sharedContracts: [{ path: "ui/contracts.js" }],
      lanes: [
        {
          id: "core-a",
          ownedGlobs: ["src/a/**"],
          ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" }],
          offload: "devin-vm",
          verifyCmd: "node --test",
        },
        {
          id: "core-b",
          ownedGlobs: ["src/b/**"],
          ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_B", endAnchor: "// END_B" }],
          offload: "cloud-agent",
          verifyCmd: "node --test",
        },
      ],
      gates: [{ id: "g1", cmd: "node --test", offload: "aipc-gpu" }],
    });
    assert.equal(check.ok, true);

    const dupAnchor = validateTopology({
      lanes: [
        { id: "a", ownedGlobs: ["src/a/**"], ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// A", endAnchor: "// END" }], verifyCmd: "node -v" },
        { id: "b", ownedGlobs: ["src/b/**"], ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// A", endAnchor: "// END" }], verifyCmd: "node -v" },
      ],
    });
    assert.equal(dupAnchor.ok, false);
  });

  it("enforces ratchet anti-leakage, intention privacy, and RSI promotion guards", () => {
    const rawRatchet = { metrics: [{ name: "parity", baseline: 94.2, op: ">=", maxRegression: 0 }], holdoutCmd: "node secret_holdout.mjs" };
    assert.equal(validateRatchetSpec(rawRatchet, { allowHoldout: false }).ok, false);
    assert.equal(validateRatchetSpec(rawRatchet, { allowHoldout: true }).ok, true);
    const pubRatchet = toPublicRatchetSpec(rawRatchet);
    assert.equal(pubRatchet.holdoutCmd, undefined);
    assert.equal(pubRatchet.holdoutConfigured, true);
    assert.equal(validateRatchetSpec(pubRatchet).ok, true);

    assert.equal(
      validateRatchetResult({ ok: true, exitCode: 1, metrics: { parity: 99 }, baseline: { parity: 94 }, deltas: { parity: 5 }, violations: [] }).ok,
      false,
    );
    assert.equal(
      validateRatchetResult({ ok: true, exitCode: 0, metrics: { parity: 96 }, baseline: { parity: 94 }, deltas: { parity: 2 }, violations: [], holdoutConfigured: true, holdoutPassed: false }).ok,
      false,
    );
    assert.equal(
      validateRatchetResult({ ok: true, exitCode: 0, metrics: { parity: 96 }, baseline: { parity: 94 }, deltas: { parity: 2 }, violations: [], holdoutConfigured: true, holdoutPassed: true }).ok,
      true,
    );

    const cleanDigest = {
      schemaVersion: 1,
      generatedAt: "2026-11-18T11:25:00Z",
      privacyMode: "strict_local",
      totalSessions: 33802,
      cloudOffloadPct: 42.5,
      freePoolPct: 68,
      activeFocus: [{ project: "analytics-engine", sessions: 12 }],
      wentQuietQuestions: [{ kind: "owner_question", autoDispatch: false, question: "Why did Project X pause 4 days ago?" }],
      frictionHotspots: [],
      driftAlerts: [],
    };
    assert.equal(validateIntentionDigest(cleanDigest).ok, true);
    assert.equal(validateIntentionDigest({ ...cleanDigest, activeFocus: [{ project: "bad", rawPrompt: "secret" }] }).ok, false);
    assert.equal(
      validateIntentionDigest({ ...cleanDigest, wentQuietQuestions: [{ kind: "candidate_goal", autoDispatch: true, question: "auto" }] }).ok,
      false,
    );

    const goodCandidate = {
      id: "rsi-1",
      category: "routing-efficiency",
      targetRepo: "overdrive",
      tier: "self_sandbox",
      title: "Prefer free SWE-2 Flash for fast workers",
      rationale: "Reduces local load",
      evidenceRefs: ["ledger:fast"],
      status: "promoted",
      baselineScore: 88,
      candidateScore: 93,
      regressions: 0,
      touchesHarness: false,
      branchName: "rsi/rsi-1",
      prePromoteCommit: "64201ea",
      proposer: { family: "google", modelId: "gemini-4-carbon" },
      audit: { verdict: "approve", auditorFamily: "openai", auditorModel: "gpt-6-astra" },
    };
    assert.equal(validateRsiCandidate(goodCandidate).ok, true);
    assert.equal(validateRsiCandidate({ ...goodCandidate, audit: { verdict: "approve", auditorFamily: "google" } }).ok, false);
    assert.equal(validateRsiCandidate({ ...goodCandidate, touchesHarness: true }).ok, false);
    assert.equal(validateRsiCandidate({ ...goodCandidate, tier: "proposal_only" }).ok, false);
  });
});
