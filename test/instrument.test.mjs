import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CONTRACT_FIXTURES, REPLAY_VERSION, ROUTES, SHORTCUTS } from "../ui/contracts.js";
import { createMockDom, h } from "../ui/dom.js";
import { createStudioApp, handleKeydown } from "../ui/app.js";
import { computeDagLayout, renderDag } from "../ui/dag.js";
import { buildPaletteCommands, createPaletteController, fuzzyScore, renderShortcutsModal } from "../ui/palette.js";
import { renderRsiView } from "../ui/rsi-view.js";
import {
  createStudioStore,
  humanEventSummary,
  humanLaneStatus,
  humanMissionState,
  humanModelName,
  mergeEvents,
  projectMissionAtSeq,
  readHashToken,
} from "../ui/store.js";
import { filterTimelineEvents, renderTimeline } from "../ui/timeline.js";

let prevDoc;

function withMockDom() {
  prevDoc = globalThis.document;
  const doc = createMockDom();
  doc.addEventListener = (type, fn) => doc.body.addEventListener(type, fn);
  doc.removeEventListener = (type, fn) => doc.body.removeEventListener(type, fn);
  globalThis.document = doc;
  return doc;
}

afterEach(() => {
  if (prevDoc === undefined) delete globalThis.document;
  else globalThis.document = prevDoc;
  prevDoc = undefined;
});

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function makeSampleMission() {
  return {
    id: "m-1",
    slug: "showcase-v02",
    title: "Overdrive <script>alert(1)</script> Mission",
    goal: "Verify DAG, timeline & <img src=x onerror=alert(1)> escaping",
    repoRoot: "/workspace/overdrive",
    routingMode: "playbook-auto",
    activeHarness: "antigravity",
    adhdSessionId: "adhd-12345678",
    state: "swarming",
    freezeCommit: "b25aedadaaa95f80f5492595010a0ca8b33b64a1",
    contracts: [
      { path: "ui/contracts.js", sha256: "abc1234567890def" },
    ],
    lanes: [
      {
        id: "instrument",
        title: "Shell & DAG <img src=x onerror=alert(1)>",
        complexity: "hard",
        ownedGlobs: ["ui/app.js", "ui/dag.js"],
        verifyCmd: "node --test test/instrument.test.mjs",
        offload: "local",
        status: "verified",
        scopeOk: true,
        worker: { harness: "antigravity", model: "gemini-4-carbon", costTier: "included" },
        verifier: { harness: "codex", model: "gpt-6-astra", crossFamily: true, effectiveOffload: "local" },
      },
      {
        id: "backend",
        title: "API & Replay",
        complexity: "standard",
        ownedGlobs: ["src/**"],
        verifyCmd: "node --test",
        offload: "auto",
        status: "failed",
        scopeOk: false,
        lastVerify: { ok: false, scopeOk: false, violation: "SCOPE_VIOLATION: ui/app.js" },
        worker: { harness: "devin", model: "swe-2", costTier: "free" },
        verifier: { harness: "claude", model: "claude-opus-5-5", crossFamily: true, effectiveOffload: "aipc auto" },
      },
    ],
    gates: [
      { id: "g1", title: "Smoke", cmd: "node --test test/contract-smoke.test.mjs", required: true, status: "passed" },
      { id: "g2", title: "Full Suite <script>x</script>", cmd: "npm test", required: true, status: "failed" },
    ],
    events: [],
  };
}

describe("ui/store.js — token, SSE deduplication & replay projection", () => {
  it("extracts #t= token, scrubs URL hash, and persists to sessionStorage", () => {
    const doc = withMockDom();
    const storage = makeStorage();
    let replacedUrl = null;
    const tok = readHashToken({
      locationObj: { hash: "#t=tok-abc-123", pathname: "/", search: "" },
      historyObj: { replaceState: (_s, _t, u) => (replacedUrl = u) },
      storage,
      doc,
    });
    assert.equal(tok, "tok-abc-123");
    assert.equal(storage.getItem("overdrive_token"), "tok-abc-123");
    assert.equal(replacedUrl, "/");

    const fromStorage = readHashToken({
      locationObj: { hash: "", pathname: "/", search: "" },
      historyObj: {},
      storage,
      doc,
    });
    assert.equal(fromStorage, "tok-abc-123");
  });

  it("loads state, deduplicates SSE & events by seq, and projects causal replay at cursorSeq", async () => {
    const doc = withMockDom();
    const mission = makeSampleMission();
    const events = [
      {
        seq: 1,
        missionId: mission.id,
        role: "coordinator",
        type: "topology_planned",
        createdAt: "2026-11-18T00:00:01.000Z",
        payload: { laneCount: 2 },
        replay: { ...CONTRACT_FIXTURES.replayCheckpoint, version: REPLAY_VERSION },
      },
      {
        seq: 2,
        missionId: mission.id,
        role: "coordinator",
        type: "contracts_frozen",
        createdAt: "2026-11-18T00:00:02.000Z",
        payload: { freezeCommit: "deadbeef1234" },
        replay: {
          version: 1,
          checkpoint: null,
          changes: [{ op: "put", entity: "mission", id: mission.id, value: { state: "frozen", freezeCommit: "deadbeef1234" } }],
          causes: [1],
          receiptId: null,
        },
      },
      {
        seq: 3,
        missionId: mission.id,
        role: "verifier",
        type: "lane_verified",
        createdAt: "2026-11-18T00:00:03.000Z",
        payload: { laneId: "core", status: "verified", scopeOk: true },
        replay: CONTRACT_FIXTURES.replayDelta,
      },
    ];

    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", headers: init.headers || {} });
      if (url.startsWith("/api/state")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ missions: [mission], activeMission: mission, fleet: { harnesses: {}, infra: {} } }),
        };
      }
      if (url.includes("/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ schemaVersion: 1, missionId: mission.id, events }),
        };
      }
      if (url === ROUTES.demoSeed()) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ schemaVersion: 1, missionId: mission.id, fixtureVersion: "overdrive-showcase-v0.2.0" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    };

    const store = createStudioStore({
      doc,
      token: "secret-xyz",
      storage: makeStorage(),
      localStorage: makeStorage(),
      fetchImpl,
      EventSourceImpl: null,
    });

    await store.refreshState();
    assert.equal(calls[0].headers["X-Overdrive-Token"], "secret-xyz");
    assert.equal(store.getState().events.length, 3);
    assert.equal(store.getState().lastSeq, 3);

    // Duplicate SSE seq 3 should be ignored; seq 4 appended.
    store.handleSsePayload({ ...events[2] });
    assert.equal(store.getState().events.length, 3);
    store.handleSsePayload({
      seq: 4,
      missionId: mission.id,
      role: "gate",
      type: "gate_finished",
      createdAt: "2026-11-18T00:00:04.000Z",
      payload: { gateId: "g1", status: "passed" },
    });
    assert.equal(store.getState().events.length, 4);
    assert.equal(store.getState().lastSeq, 4);

    // Scrub backward to seq 2 -> state should be frozen without verified lane "core"
    store.setCursorSeq(2);
    const at2 = store.getState().activeMission;
    assert.equal(at2.state, "frozen");
    assert.equal(at2.freezeCommit, "deadbeef1234");
    assert.equal(at2.lanes.length, 0);

    // Scrub forward to seq 3 -> replayDelta puts lane "core" with receiptId "rcpt-1"
    store.stepTimeline(1);
    const at3 = store.getState().activeMission;
    assert.equal(at3.lanes[0].id, "core");
    assert.equal(at3.lanes[0].receiptId, "rcpt-1");

    // Jump back to LIVE HEAD -> restores live mission
    store.jumpTimelineLive();
    assert.equal(store.getState().cursorSeq, null);
    assert.equal(store.getState().activeMission.id, mission.id);

    // Seed showcase calls POST /api/demo/seed
    const seeded = await store.seedShowcase();
    assert.equal(seeded.missionId, mission.id);
    assert.ok(calls.some((c) => c.url === ROUTES.demoSeed() && c.method === "POST"));

    // Verify mergeEvents deduplication directly
    const merged = mergeEvents(events, [events[1], { seq: 5, type: "state_completed", payload: {} }], mission.id);
    assert.deepEqual(merged.map((e) => e.seq), [1, 2, 3, 4, 5].filter((x) => x !== 4));

    const projected = projectMissionAtSeq(mission, events, 3);
    assert.equal(projected.replayCursorSeq, 3);
    store.destroy();
  });

  it("switches immediately to showcase mission on seedShowcase despite concurrent SSE refresh", async () => {
    const doc = withMockDom();
    const initialMission = { ...makeSampleMission(), id: "m-initial", title: "Initial Build" };
    const showcaseMission = { ...makeSampleMission(), id: "showcase-v02", title: "Showcase Build" };
    const stateRequests = [];
    const store = createStudioStore({
      doc,
      token: "tok-seed",
      storage: makeStorage(),
      localStorage: makeStorage(),
      EventSourceImpl: null,
      fetchImpl: async (url) => {
        if (url === ROUTES.demoSeed()) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ schemaVersion: 1, ok: true, missionId: showcaseMission.id, slug: "showcase-v02" }),
          };
        }
        if (url.startsWith("/api/state")) {
          stateRequests.push(url);
          const wantsShowcase = url.includes(`missionId=${showcaseMission.id}`);
          if (wantsShowcase) await new Promise((r) => setTimeout(r, 85));
          const active = wantsShowcase ? showcaseMission : initialMission;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              missions: [initialMission, showcaseMission],
              activeMission: active,
              fleet: { harnesses: {}, infra: {} },
            }),
          };
        }
        if (url.includes("/events")) {
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: showcaseMission.id, events: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, files: [], contracts: [] }) };
      },
    });

    await store.refreshState(initialMission.id);
    assert.equal(store.getState().missionId, initialMission.id);

    // Simulate a pending SSE SQLite change event right before clicking Sample build
    store.handleSsePayload({
      schemaVersion: 1,
      missionId: initialMission.id,
      seq: 42,
      type: "state_planned",
      payload: {},
    });
    const seedPromise = store.seedShowcase();
    await new Promise((r) => setTimeout(r, 20));
    // Re-fire another SSE ping during slow refresh: missionId must already point to showcaseMission
    store.handleSsePayload({
      schemaVersion: 1,
      missionId: initialMission.id,
      seq: 43,
      type: "state_planned",
      payload: {},
    });
    await seedPromise;
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(store.getState().missionId, showcaseMission.id);
    assert.equal(store.getState().activeMission?.id, showcaseMission.id);
    assert.ok(!stateRequests.slice(1).some((u) => u.includes(`missionId=${initialMission.id}`)));
    store.destroy();
  });

  it("loads lane diff & inspection details on selection/scrub and guards stale async responses", async () => {
    const doc = withMockDom();
    const mission = makeSampleMission();
    let resolveSlowDiff;
    const store = createStudioStore({
      doc,
      token: "tok-diff",
      storage: makeStorage(),
      localStorage: makeStorage(),
      EventSourceImpl: null,
      fetchImpl: async (url) => {
        if (url.startsWith("/api/state")) {
          return { ok: true, status: 200, json: async () => ({ missions: [mission], activeMission: mission, fleet: { harnesses: {}, infra: {} } }) };
        }
        if (url.includes("/events")) {
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: mission.id, events: [] }) };
        }
        if (url.includes("/lanes/backend/diff")) {
          return new Promise((resolve) => {
            resolveSlowDiff = () =>
              resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, laneId: "backend", files: [{ path: "stale.js" }], contracts: [] }) });
          });
        }
        if (url.includes("/lanes/instrument/diff")) {
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, laneId: "instrument", files: [{ path: "ui/app.js" }], contracts: [] }) };
        }
        if (url.includes("/inspection")) {
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: mission.id, laneId: "instrument" }) };
        }
        return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      },
    });

    assert.equal(store.getState().diffData, null);
    assert.equal(store.getState().inspectionData, null);
    assert.equal(store.getState().diffLoading, false);
    assert.equal(store.getState().diffError, null);

    await store.refreshState();
    // Initial selection picked failed lane "backend"; switch immediately to "instrument" before slow diff resolves
    store.selectLane("instrument");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getState().diffData?.laneId, "instrument");
    assert.equal(store.getState().inspectionData?.laneId, "instrument");

    // Now resolve stale slow diff for "backend" — must NOT overwrite "instrument"
    resolveSlowDiff?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getState().diffData?.laneId, "instrument");

    // Human-readable label helpers
    assert.equal(humanMissionState("swarming"), "Building in parallel");
    assert.equal(humanModelName({ model: "gemini-4-carbon", effort: "high" }), "Gemini 4 Carbon · High");
    assert.equal(humanLaneStatus({ status: "verified" }), "Finished · checks passed");
    assert.equal(humanEventSummary({ type: "contracts_frozen" }), "Shared rules locked");

    store.destroy();
  });

  it("flags tokenRequired on 403 error responses", async () => {
    const doc = withMockDom();
    const store = createStudioStore({
      doc,
      token: "bad-tok",
      storage: makeStorage(),
      localStorage: makeStorage(),
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "Missing or invalid X-Overdrive-Token." }) }),
      EventSourceImpl: null,
    });
    await store.refreshState();
    assert.equal(store.getState().tokenRequired, true);
    store.destroy();
  });
});

describe("ui/dag.js — pure SVG + DOM 5-stage pipeline & XSS isolation", () => {
  it("renders welcome CTA when mission is null", () => {
    const doc = withMockDom();
    const host = h("div");
    doc.body.appendChild(host);
    let seeded = 0;
    renderDag({
      container: host,
      mission: null,
      onSeedShowcase: () => seeded++,
    });
    const btn = host.querySelector("#btn-showcase-cta");
    assert.ok(btn);
    btn.click();
    assert.equal(seeded, 1);
  });

  it("renders SVG connectors, [data-lane-id] nodes, failure isolation, and zero HTML injection", () => {
    const doc = withMockDom();
    const host = h("div");
    doc.body.appendChild(host);
    const mission = makeSampleMission();
    const layout = computeDagLayout(mission);
    assert.equal(layout.laneNodes.length, 2);
    assert.equal(layout.gateNodes.length, 2);

    let selected = null;
    renderDag({
      container: host,
      mission,
      state: { selectedLaneId: "instrument", focusFailureOnly: true },
      onSelectLane: (id) => (selected = id),
    });

    assert.ok(host.querySelector(".od-dag-svg"));
    assert.ok(host.querySelectorAll(".od-dag-edge").length >= 5);
    assert.equal(host.querySelector("script"), null);
    assert.equal(host.querySelector("img"), null);

    const laneBtns = host.querySelectorAll("[data-lane-id]");
    assert.equal(laneBtns.length, 2);
    assert.equal(laneBtns[0].classList.contains("is-selected"), true);
    assert.equal(laneBtns[0].classList.contains("is-dimmed"), true);
    assert.equal(laneBtns[1].classList.contains("is-fail"), true);
    assert.equal(laneBtns[1].classList.contains("is-dimmed"), false);

    laneBtns[1].click();
    assert.equal(selected, "backend");
  });
});

describe("ui/timeline.js — causal events, filtering, highlightMatches & scrubbing", () => {
  it("filters events, highlights matches safely without XSS, and scrubs cursorSeq", () => {
    const doc = withMockDom();
    const host = h("div");
    doc.body.appendChild(host);
    const mission = makeSampleMission();
    const events = [
      { seq: 1, role: "coordinator", type: "mission_created", createdAt: "2026-11-18T00:00:01Z", payload: { title: "alpha" } },
      {
        seq: 2,
        role: "verifier",
        type: "lane_verified",
        createdAt: "2026-11-18T00:00:02Z",
        payload: { laneId: "backend", status: "failed", violation: "<img onerror=alert(1)> SCOPE" },
        replay: { version: 1, checkpoint: null, changes: [], causes: [1], receiptId: "rcpt-2" },
      },
      { seq: 3, role: "gate", type: "gate_finished", createdAt: "2026-11-18T00:00:03Z", payload: { gateId: "g1", status: "passed" } },
    ];

    let scrubbedSeq = null;
    renderTimeline({
      container: host,
      mission,
      events,
      state: { cursorSeq: 2, timelineSearch: "Teammate", timelineFilterKind: "all", timelineFilterLane: "all" },
      onScrub: (seq) => (scrubbedSeq = seq),
    });

    assert.equal(host.querySelector("img"), null);
    assert.ok(host.querySelectorAll("mark").length >= 1);
    const searchInput = host.querySelector(".od-tl-search");
    assert.ok(searchInput);

    // Re-rendering keeps search input element identity intact (preserves focus)
    renderTimeline({
      container: host,
      mission,
      events,
      state: { cursorSeq: 2, timelineSearch: "failed", timelineFilterKind: "all", timelineFilterLane: "all" },
      onScrub: (seq) => (scrubbedSeq = seq),
    });
    assert.equal(host.querySelector(".od-tl-search"), searchInput);

    const row = host.querySelector(".od-tl-row");
    assert.ok(row);
    row.click();
    assert.equal(scrubbedSeq, 2);

    assert.equal(filterTimelineEvents(events, { kind: "errors" }).length, 1);
    assert.equal(filterTimelineEvents(events, { lane: "backend" }).length, 1);
  });
});

describe("ui/palette.js — fuzzy matching, keyboard navigation & shortcuts modal", () => {
  it("scores fuzzy matches, highlights characters, and executes command on Enter", () => {
    const doc = withMockDom();
    const paletteRoot = h("div");
    const shortcutsRoot = h("div");
    doc.body.appendChild(paletteRoot);
    doc.body.appendChild(shortcutsRoot);

    const m = fuzzyScore("shw", "Load Showcase Demo Mission");
    assert.ok(m && m.indices.length === 3);

    let seeded = 0;
    const ctrl = createPaletteController({
      container: paletteRoot,
      onClose: () => {},
    });
    const state = { activeMission: makeSampleMission(), missions: [makeSampleMission()], selectedLaneId: "instrument", theme: "dark" };
    const actions = { seedShowcase: () => seeded++ };
    assert.ok(buildPaletteCommands(state, actions).length >= 10);

    ctrl.open(state, actions);
    assert.equal(ctrl.isOpen(), true);
    ctrl.setQuery("Showcase");
    assert.ok(ctrl.getList().querySelectorAll("mark").length > 0);
    ctrl.getInput().dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
    assert.equal(seeded, 1);
    assert.equal(ctrl.isOpen(), false);

    renderShortcutsModal({ container: shortcutsRoot, open: true, onClose: () => {} });
    assert.equal(shortcutsRoot.querySelectorAll(".od-shortcut-row").length, SHORTCUTS.length);
  });
});

describe("ui/app.js — studio wiring, fallback modules & shortcut dispatching", () => {
  it("boots cleanly without inspector/composer modules and dispatches all core shortcuts", async () => {
    const doc = withMockDom();
    const ids = [
      "od-shell", "mission-rail", "inspector-drawer", "inspector-root", "timeline-dock",
      "timeline-root", "dag-root", "composer-slot", "palette-root", "shortcuts-root",
      "toast-stack", "token-box", "armed-banner", "armed-text", "mission-select",
      "quick-mode", "mission-crumb", "state-pill", "state-dot", "state-text",
      "map-title", "map-goal", "events-count", "build-controls",
      "inspector-header-title", "btn-inspector-wide", "rail-missions-list", "rail-lanes-list",
      "rail-missions-count", "rail-lanes-count", "rail-goal-text", "btn-rail-cta",
      "contracts-list", "gates-list", "freeze-commit-tag", "gates-summary-tag",
      "fleet-grid", "manual-mcp-pre", "adhd-sessions-list", "adhd-dir-tag",
      "adhd-detail-tag", "adhd-detail-pre", "panel-map", "panel-contracts", "panel-adhd",
      "panel-rsi", "rsi-root", "btn-integrate",
      "summary-clock", "summary-caption", "summary-progress-host",
      "fact-team", "fact-conflicts", "fact-rules", "fact-checks",
      "paper-meta-status", "stream-state", "stream-light", "build-footer-summary",
    ];
    for (const id of ids) doc.body.appendChild(h("div", { id }));

    const mission = makeSampleMission();
    let verifyCalled = 0;
    const store = createStudioStore({
      doc,
      token: "tok-1",
      storage: makeStorage(),
      localStorage: makeStorage(),
      EventSourceImpl: null,
      fetchImpl: async (url) => {
        if (url.startsWith("/api/state")) {
          return { ok: true, status: 200, json: async () => ({ missions: [mission], activeMission: mission, fleet: { harnesses: {}, infra: {} } }) };
        }
        if (url.includes("/verify-lane")) {
          verifyCalled++;
          return { ok: true, status: 200, json: async () => ({ ok: true, result: { ok: true } }) };
        }
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: mission.id, events: [] }) };
      },
    });

    const app = await createStudioApp({
      doc,
      store,
      modules: [null, null],
    });

    assert.equal(doc.getElementById("dag-root").querySelectorAll("[data-lane-id]").length, 2);

    // Ctrl+K toggles palette through store state
    handleKeydown({ key: "k", ctrlKey: true, preventDefault() {} }, app);
    assert.equal(store.getState().paletteOpen, true);
    assert.equal(app.palette.isOpen(), true);
    handleKeydown({ key: "Escape", preventDefault() {} }, app);
    assert.equal(store.getState().paletteOpen, false);
    assert.equal(app.palette.isOpen(), false);

    // ? toggles shortcuts modal
    handleKeydown({ key: "?", preventDefault() {} }, app);
    assert.equal(store.getState().shortcutsOpen, true);
    handleKeydown({ key: "Escape", preventDefault() {} }, app);
    assert.equal(store.getState().shortcutsOpen, false);

    // j / k navigate lanes
    assert.equal(store.getState().selectedLaneId, "backend");
    handleKeydown({ key: "j", preventDefault() {} }, app);
    assert.equal(store.getState().selectedLaneId, "instrument");
    handleKeydown({ key: "k", preventDefault() {} }, app);
    assert.equal(store.getState().selectedLaneId, "backend");

    // 1-4 views, d/b/a inspector tabs, w wide, [, ], t, f
    handleKeydown({ key: "3", preventDefault() {} }, app);
    assert.equal(store.getState().activeView, "contracts");
    handleKeydown({ key: "1", preventDefault() {} }, app);
    assert.equal(store.getState().activeView, "map");

    handleKeydown({ key: "d", preventDefault() {} }, app);
    assert.equal(store.getState().inspectorTab, "diff");
    handleKeydown({ key: "w", preventDefault() {} }, app);
    assert.equal(store.getState().inspectorWide, true);

    handleKeydown({ key: "[", preventDefault() {} }, app);
    assert.equal(store.getState().railOpen, false);
    handleKeydown({ key: "t", preventDefault() {} }, app);
    assert.equal(store.getState().timelineOpen, false);
    handleKeydown({ key: "f", preventDefault() {} }, app);
    assert.equal(store.getState().focusFailureOnly, true);

    // Single-key shortcuts ignored inside INPUT
    const handledInput = handleKeydown({ key: "t", target: { tagName: "INPUT" }, preventDefault() {} }, app);
    assert.equal(handledInput, false);
    assert.equal(store.getState().timelineOpen, false);

    // Two-step armed verify (v + Enter)
    handleKeydown({ key: "v", preventDefault() {} }, app);
    assert.ok(store.getState().armedAction);
    handleKeydown({ key: "Enter", preventDefault() {} }, app);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(verifyCalled, 1);

    app.destroy();
  });

  it("store generation guard prevents out-of-order refresh & follows hasMore events + historical-empty before first receipt", async () => {
    const doc = withMockDom();
    const mA = { ...makeSampleMission(), id: "m-A", title: "Mission A" };
    const mB = { ...makeSampleMission(), id: "m-B", title: "Mission B" };
    let resolveA;
    const gateA = new Promise((r) => (resolveA = r));

    const fetchImpl = async (url) => {
      if (url.includes("missionId=m-A")) {
        await gateA;
        return { ok: true, status: 200, json: async () => ({ missions: [mA, mB], activeMission: mA, fleet: { harnesses: {}, infra: {} } }) };
      }
      if (url.includes("missionId=m-B")) {
        return { ok: true, status: 200, json: async () => ({ missions: [mA, mB], activeMission: mB, fleet: { harnesses: {}, infra: {} } }) };
      }
      if (url.includes("/events") && url.includes("after=0")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 1,
            missionId: "m-B",
            hasMore: true,
            nextAfterSeq: 1,
            events: [
              { seq: 1, missionId: "m-B", role: "coordinator", type: "topology_planned", createdAt: "2026-11-18T00:00:01Z", payload: {}, replay: { ...CONTRACT_FIXTURES.replayCheckpoint, version: REPLAY_VERSION } },
            ],
          }),
        };
      }
      if (url.includes("/events") && url.includes("after=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 1,
            missionId: "m-B",
            hasMore: false,
            nextAfterSeq: 2,
            events: [
              { seq: 2, missionId: "m-B", role: "coordinator", type: "lane_provisioned", createdAt: "2026-11-18T00:00:02Z", payload: { laneId: "core", status: "active" } },
            ],
          }),
        };
      }
      if (url.includes("/diff")) {
        return { ok: true, status: 200, json: async () => CONTRACT_FIXTURES.diff };
      }
      if (url.includes("/inspection")) {
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: "m-B", laneId: "core" }) };
      }
      return { ok: true, status: 200, json: async () => ({ missions: [mA, mB], activeMission: mB, fleet: { harnesses: {}, infra: {} } }) };
    };

    const store = createStudioStore({
      doc,
      token: "tok",
      storage: makeStorage(),
      localStorage: makeStorage(),
      fetchImpl,
      EventSourceImpl: null,
    });

    const pA = store.refreshState("m-A");
    const pB = store.refreshState("m-B");
    await pB;
    resolveA();
    await pA;

    assert.equal(store.getState().missionId, "m-B", "stale m-A fetch must not overwrite m-B");
    assert.deepEqual(store.getState().events.map((e) => e.seq), [1, 2], "followed hasMore pagination");

    // Scrub to seq 2 (provisioned, no receipt yet) -> must yield historical-empty diff rather than leaking live HEAD
    store.setCursorSeq(2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getState().diffData?.source, "historical-empty");
    store.destroy();
  });

  it("wires v0.3 RSI actions, integrateMission, shortcut 5, armed promote & human event labels safely", async () => {
    const doc = withMockDom();
    const ids = [
      "od-shell", "mission-rail", "inspector-drawer", "inspector-root", "timeline-dock",
      "timeline-root", "dag-root", "composer-slot", "palette-root", "shortcuts-root",
      "toast-stack", "token-box", "armed-banner", "armed-text", "mission-select",
      "quick-mode", "mission-crumb", "state-pill", "state-dot", "state-text",
      "map-title", "map-goal", "events-count", "build-controls",
      "inspector-header-title", "btn-inspector-wide", "rail-missions-list", "rail-lanes-list",
      "rail-missions-count", "rail-lanes-count", "rail-goal-text", "btn-rail-cta",
      "contracts-list", "gates-list", "freeze-commit-tag", "gates-summary-tag",
      "fleet-grid", "manual-mcp-pre", "adhd-sessions-list", "adhd-dir-tag",
      "adhd-detail-tag", "adhd-detail-pre", "panel-map", "panel-contracts", "panel-adhd",
      "panel-rsi", "rsi-root", "btn-integrate",
      "summary-clock", "summary-caption", "summary-progress-host",
      "fact-team", "fact-conflicts", "fact-rules", "fact-checks",
      "paper-meta-status", "stream-state", "stream-light", "build-footer-summary",
    ];
    for (const id of ids) {
      doc.body.appendChild(h(id === "btn-integrate" ? "button" : "div", { id }));
    }

    const mission = makeSampleMission();
    const sampleOverview = {
      schemaVersion: 1,
      ok: true,
      digest: {
        schemaVersion: 1,
        generatedAt: "2026-11-18T12:00:00Z",
        privacyMode: "strict_local",
        totalSessions: 420,
        cloudOffloadPct: 75,
        freePoolPct: 60,
        activeFocus: [{ project: "overdrive", sessions: 12, outTokens: 48200, lastActiveAt: "2026-11-18T11:55:00Z", category: "infra" }],
        wentQuietQuestions: [{ kind: "owner_question", autoDispatch: false, project: "paused-proj", quietHours: 96, question: "Resume <script>alert(1)</script>?" }],
        frictionHotspots: [{ id: "f1", source: "gates", summary: "Slow check", count: 3 }],
        driftAlerts: [{ id: "d1", harness: "codex", status: "ok", summary: "Rules synced" }],
      },
      benchmark: {
        ok: true,
        exitCode: 0,
        score: 94,
        maxScore: 100,
        baselineScore: 90,
        dimensions: [{ id: "csp", title: "CSP", score: 10, maxScore: 10, ok: true }],
      },
      candidates: [
        {
          id: "cand-sandbox",
          category: "routing",
          targetRepo: "overdrive",
          tier: "self_sandbox",
          title: "Prefer free SWE-2 Flash",
          rationale: "Keeps local CPU cool <img src=x onerror=alert(1)>",
          evidenceRefs: ["ledger:swe2"],
          status: "audited",
          baselineScore: 90,
          candidateScore: 95,
          regressions: 0,
          touchesHarness: false,
          audit: { verdict: "approve", auditorFamily: "openai", auditorModel: "gpt-6-astra" },
        },
        {
          id: "cand-proposal",
          category: "prompt",
          targetRepo: "overdrive",
          tier: "proposal_only",
          title: "Tune verification prompt",
          rationale: "Needs human OK before apply",
          evidenceRefs: ["session:12"],
          status: "promoted",
          baselineScore: 88,
          candidateScore: 92,
          regressions: 0,
          touchesHarness: false,
          prePromoteCommit: "deadbeef",
        },
      ],
    };

    const requests = [];
    let overviewMode = "404";
    const store = createStudioStore({
      doc,
      token: "tok-rsi",
      storage: makeStorage(),
      localStorage: makeStorage(),
      EventSourceImpl: null,
      fetchImpl: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, method: init.method || "GET", body });
        if (url.startsWith("/api/state")) {
          return { ok: true, status: 200, json: async () => ({ missions: [mission], activeMission: mission, fleet: { harnesses: {}, infra: {} } }) };
        }
        if (url === ROUTES.rsiOverview()) {
          if (overviewMode === "404") return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
          return { ok: true, status: 200, json: async () => sampleOverview };
        }
        if (url === ROUTES.rsiScan()) {
          return { ok: true, status: 200, json: async () => sampleOverview };
        }
        if (url === ROUTES.rsiCycle()) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              readyToPromote: true,
              candidate: { ...sampleOverview.candidates[0], status: "audited", candidateScore: 96 },
              benchmark: sampleOverview.benchmark,
            }),
          };
        }
        if (url === ROUTES.rsiPromote("cand-sandbox")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              candidate: { ...sampleOverview.candidates[0], status: "promoted", prePromoteCommit: "abcdef1" },
            }),
          };
        }
        if (url === ROUTES.rsiRollback("cand-sandbox")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              candidate: { ...sampleOverview.candidates[0], status: "rolled_back", prePromoteCommit: "abcdef1" },
            }),
          };
        }
        if (url === ROUTES.missionIntegrate(mission.id)) {
          return { ok: true, status: 200, json: async () => ({ ok: true, integration: { ok: true }, mission }) };
        }
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, missionId: mission.id, events: [] }) };
      },
    });

    const app = await createStudioApp({ doc, store, modules: [null, null] });

    // Backward-compatible 404 handling on /api/rsi/overview
    await store.loadRsiOverview({ quiet: true });
    assert.equal(store.getState().rsi.error, null);
    assert.equal(store.getState().lastError, null);

    // Shortcut "5" switches to Evolution view ("rsi")
    overviewMode = "ok";
    handleKeydown({ key: "5", preventDefault() {} }, app);
    assert.equal(store.getState().activeView, "rsi");
    assert.equal(doc.getElementById("panel-rsi").hidden, false);
    await new Promise((r) => setTimeout(r, 20));

    const rsiRoot = doc.getElementById("rsi-root");
    assert.ok(rsiRoot.textContent.includes("System evolution & daily self-tuning"));
    assert.ok(rsiRoot.textContent.includes("Strict local · private"));
    assert.ok(rsiRoot.textContent.includes("75%"));
    assert.ok(rsiRoot.textContent.includes("60%"));
    assert.ok(rsiRoot.textContent.includes("94 / 100"));
    assert.ok(rsiRoot.textContent.includes("Questions on paused projects"));
    assert.ok(rsiRoot.textContent.includes("never restarts paused work automatically"));
    assert.ok(rsiRoot.textContent.includes("Auto-tested sandbox"));
    assert.ok(rsiRoot.textContent.includes("Needs your OK"));
    assert.equal(rsiRoot.querySelector("script"), null);
    assert.equal(rsiRoot.querySelector("img"), null);

    // Test upgrade button -> POST /api/rsi/cycle
    const sandboxCard = rsiRoot.querySelector('[data-candidate-id="cand-sandbox"]');
    assert.ok(sandboxCard);
    sandboxCard.querySelector('[data-action="rsi-cycle"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.some((r) => r.url === ROUTES.rsiCycle() && r.body?.candidateId === "cand-sandbox"));

    // Apply upgrade arms #armed-banner without blocking confirm(), Enter sends humanApproved:true
    rsiRoot.querySelector('[data-candidate-id="cand-sandbox"]').querySelector('[data-action="rsi-promote"]').click();
    assert.ok(store.getState().armedAction);
    assert.equal(doc.getElementById("armed-banner").hidden, false);
    handleKeydown({ key: "Enter", preventDefault() {} }, app);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.some((r) => r.url === ROUTES.rsiPromote("cand-sandbox") && r.body?.humanApproved === true));
    assert.equal(store.getState().rsi.overview.candidates[0].status, "promoted");

    // Undo button on promoted candidate arms rollback confirmation -> Enter executes rollback
    rsiRoot.querySelector('[data-candidate-id="cand-sandbox"]').querySelector('[data-action="rsi-rollback"]').click();
    assert.ok(store.getState().armedAction);
    handleKeydown({ key: "Enter", preventDefault() {} }, app);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.some((r) => r.url === ROUTES.rsiRollback("cand-sandbox")));

    // Trial merge & check button -> POST /api/missions/:id/integrate
    doc.getElementById("btn-integrate").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.some((r) => r.url === ROUTES.missionIntegrate(mission.id)));

    // Palette commands for v0.3
    const cmds = buildPaletteCommands(store.getState(), app.actions);
    assert.ok(cmds.some((c) => c.label === "Open Evolution & Self-Improvement (5)"));
    assert.ok(cmds.some((c) => c.label === "Scan Sessions for Improvements"));
    assert.ok(cmds.some((c) => c.label === "Trial-Merge Verified Team Work"));

    // Human-readable v0.3 EVENT_TYPES summaries
    for (const type of [
      "cloud_dispatched", "cloud_ingested", "ratchet_evaluated",
      "integration_started", "integration_verified", "integration_failed",
      "rsi_scanned", "rsi_evaluated", "rsi_promoted", "rsi_rolled_back",
    ]) {
      const label = humanEventSummary({ type, payload: {} });
      assert.ok(label && !label.includes("_"), `expected human label for ${type}, got ${label}`);
    }

    // Direct renderRsiView scan & benchmark callbacks
    let scanned = 0;
    let benched = 0;
    const standalone = h("div");
    doc.body.appendChild(standalone);
    renderRsiView({
      container: standalone,
      rsi: { loading: false, error: null, overview: sampleOverview },
      onScan: () => scanned++,
      onRunBenchmark: () => benched++,
    });
    standalone.querySelector('[data-action="rsi-scan"]').click();
    standalone.querySelector('[data-action="rsi-benchmark"]').click();
    assert.equal(scanned, 1);
    assert.equal(benched, 1);

    // Honest deterministic_local_gate card must show honest warning badge and disable Apply upgrade
    renderRsiView({
      container: standalone,
      rsi: {
        loading: false,
        error: null,
        overview: {
          ...sampleOverview,
          candidates: [
            {
              id: "cand-det-only",
              category: "routing-efficiency",
              targetRepo: "overdrive",
              tier: "self_sandbox",
              title: "Pending Audit Candidate",
              rationale: "Awaiting real cross-family audit",
              evidenceRefs: [],
              status: "evaluated_pending_audit",
              baselineScore: 100,
              candidateScore: 100,
              regressions: 0,
              touchesHarness: false,
              audit: {
                verdict: "pending_audit",
                auditKind: "deterministic_local_gate",
                modelExecuted: false,
                recommendedAuditorFamily: "openai",
                recommendedAuditorModel: "gpt-6-astra",
              },
            },
          ],
        },
      },
    });
    assert.ok(standalone.textContent.includes("Local checks only · No model audit"));
    assert.equal(standalone.querySelector('[data-action="rsi-promote"]').disabled, true);

    app.destroy();
  });
});
