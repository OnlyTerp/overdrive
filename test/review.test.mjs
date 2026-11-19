import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CONTRACT_FIXTURES, DIFF_CAPS, OFFLOAD_MODES, UI_CLASSES } from "../ui/contracts.js";
import { createMockDom } from "../ui/dom.js";
import { buildSplitRows, parseUnifiedDiff } from "../ui/parse-patch.js";
import { createInspector, humanizeModel, normalizeDiffFiles } from "../ui/inspector.js";
import { OFFLOAD_OPTIONS, PRESETS, createComposer } from "../ui/composer.js";
import { renderRsiView } from "../ui/rsi-view.js";

const MULTI = [
  "diff --git a/src/app.mjs b/src/app.mjs",
  "index 1111111..2222222 100644",
  "--- a/src/app.mjs",
  "+++ b/src/app.mjs",
  "@@ -1,4 +1,5 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  " return a;",
  "@@ -10,2 +11,2 @@",
  "-old tail",
  "+new tail",
  " end",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+body",
  "\\ No newline at end of file",
  "diff --git a/old/gone.js b/old/gone.js",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old/gone.js",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "diff --git a/src/before.mjs b/src/after.mjs",
  "similarity index 100%",
  "rename from src/before.mjs",
  "rename to src/after.mjs",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "",
].join("\n");

function filePatch(path, lines) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines.length} +1,${lines.length} @@`, ...lines.map((l) => ` ${l}`)].join("\n");
}

function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes || []) walk(c, fn);
}

function assertNoInlineStyleOrHandlers(root) {
  walk(root, (n) => {
    if (n.nodeType !== 1) return;
    for (const k of Object.keys(n._attrs)) {
      assert.notEqual(k.toLowerCase(), "style", `inline style on <${n.tagName}>`);
      assert.ok(!/^on/i.test(k), `inline handler attribute ${k} on <${n.tagName}>`);
    }
    assert.ok(!["script", "img", "iframe"].includes(String(n.tagName).toLowerCase()), `unexpected <${n.tagName}> element`);
  });
}

describe("parse-patch: parseUnifiedDiff", () => {
  it("parses multi-file diffs with modify/add/delete/rename/binary", () => {
    const out = parseUnifiedDiff(MULTI);
    assert.equal(out.truncated, false);
    assert.deepEqual(
      out.files.map((f) => [f.path, f.status, f.isBinary]),
      [
        ["src/app.mjs", "modified", false],
        ["docs/new.md", "added", false],
        ["old/gone.js", "deleted", false],
        ["src/after.mjs", "renamed", false],
        ["assets/logo.png", "modified", true],
      ],
    );
    const [mod, added, deleted, renamed] = out.files;
    assert.equal(mod.additions, 3);
    assert.equal(mod.deletions, 2);
    assert.equal(mod.hunks.length, 2);
    const h0 = mod.hunks[0];
    assert.deepEqual([h0.oldStart, h0.oldCount, h0.newStart, h0.newCount], [1, 4, 1, 5]);
    assert.equal(h0.lines[0].type, "hunk");
    const c = h0.lines.find((l) => l.content === "const c = 4;");
    assert.deepEqual([c.type, c.oldLine, c.newLine], ["add", null, 3]);
    const d = h0.lines.find((l) => l.content === "const d = 5;");
    assert.deepEqual([d.type, d.oldLine, d.newLine], ["context", 3, 4]);
    assert.equal(mod.hunks[1].lines.find((l) => l.type === "del").oldLine, 10);
    assert.equal(added.oldPath, null);
    assert.equal(added.additions, 2);
    assert.equal(added.hunks[0].lines.at(-1).type, "note");
    assert.equal(deleted.newPath, null);
    assert.equal(deleted.deletions, 1);
    assert.equal(renamed.oldPath, "src/before.mjs");
    assert.equal(renamed.hunks.length, 0);
    assert.ok(out.totalLines > 0);
  });

  it("parses headerless ---/+++ patches like the frozen diff fixture", () => {
    const out = parseUnifiedDiff(CONTRACT_FIXTURES.diff.files[0].patch);
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0].path, "ui/app.js");
    assert.equal(out.files[0].additions, 1);
  });

  it("does not treat '--- ' content inside a hunk as a new file header", () => {
    const out = parseUnifiedDiff(["--- a/x.md", "+++ b/x.md", "@@ -1,2 +1,1 @@", "--- not a header", " keep"].join("\n"));
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0].deletions, 1);
    assert.equal(out.files[0].hunks[0].lines[1].content, "-- not a header");
  });

  it("enforces DIFF_CAPS maxFiles / maxLinesPerFile / maxRenderedHunkLines", () => {
    const three = [filePatch("a.txt", ["1"]), filePatch("b.txt", ["2"]), filePatch("c.txt", ["3"])].join("\n");
    const capped = parseUnifiedDiff(three, { ...DIFF_CAPS, maxFiles: 2 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.omittedFiles, 1);
    assert.equal(capped.truncated, true);

    const long = filePatch("big.txt", Array.from({ length: 20 }, (_, i) => `line ${i}`));
    const perFile = parseUnifiedDiff(long, { ...DIFF_CAPS, maxLinesPerFile: 5 });
    assert.equal(perFile.truncated, true);
    assert.equal(perFile.files[0].truncated, true);
    assert.equal(perFile.files[0].hunks[0].lines.length, 5);

    const global = parseUnifiedDiff([filePatch("x.txt", ["a", "b", "c"]), filePatch("y.txt", ["d", "e", "f"])].join("\n"), { ...DIFF_CAPS, maxRenderedHunkLines: 6 });
    const rendered = global.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
    assert.equal(rendered, 6);
    assert.equal(global.truncated, true);
    assert.equal(parseUnifiedDiff(null).files.length, 0);
  });
});

describe("parse-patch: buildSplitRows", () => {
  it("pairs del/add blocks with null spacers and mirrors context", () => {
    const { files } = parseUnifiedDiff(["--- a/f", "+++ b/f", "@@ -1,5 +1,4 @@", " a", "-b", "-c", "+B", " d", "+e", "-z"].join("\n"));
    const rows = buildSplitRows(files[0].hunks[0]);
    assert.deepEqual(
      rows.map((r) => [r.type, r.left?.content ?? null, r.right?.content ?? null]),
      [
        ["hunk", "@@ -1,5 +1,4 @@", "@@ -1,5 +1,4 @@"],
        ["context", "a", "a"],
        ["change", "b", "B"],
        ["change", "c", null],
        ["context", "d", "d"],
        ["change", null, "e"],
        ["change", "z", null],
      ],
    );
    assert.deepEqual(buildSplitRows(null), []);
  });
});

describe("ui DOM components (mock DOM)", () => {
  let prevDoc;
  let doc;
  before(() => {
    prevDoc = globalThis.document;
    doc = createMockDom();
    globalThis.document = doc;
  });
  after(() => {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  });

  const lane = {
    id: "core",
    title: "Core <b>engine</b>",
    status: "verified",
    complexity: "hard",
    offload: "aipc",
    branch: "overdrive/m/core",
    worktreePath: ".overdrive/worktrees/overdrive/m-core",
    verifyCmd: "node --test",
    worker: { harness: "claude", model: "opus" },
  };
  const mission = { id: "m1", lanes: [lane, { id: "ui", status: "planned" }] };

  function mount(extra = {}) {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const events = { selected: [], closed: 0 };
    const insp = createInspector({ container, store: null, api: null, onSelectLane: (id) => events.selected.push(id), onClose: () => events.closed++, ...extra });
    return { container, insp, events };
  }

  it("inspector renders XSS payloads in filenames and patch lines strictly as text", () => {
    const { container, insp } = mount();
    const evilPath = "<script>alert(1)</script>.js";
    const evilLine = '<img src=x onerror=alert(1)>';
    const patch = [`diff --git a/${evilPath} b/${evilPath}`, `--- a/${evilPath}`, `+++ b/${evilPath}`, "@@ -1,1 +1,1 @@", `-${evilLine}`, `+${evilLine}`].join("\n");
    insp.update({ mission, lane, diffData: { patch }, inspectionData: { verification: { ok: true, output: "<script>x()</script> ok" } } });
    const card = container.querySelector("[data-file-path]");
    assert.ok(card, "file card rendered");
    assert.equal(card.getAttribute("data-file-path"), evilPath);
    assert.ok(container.textContent.includes(evilLine));
    assert.ok(container.textContent.includes("Core <b>engine</b>"));
    assert.equal(container.querySelector("script"), null);
    assert.equal(container.querySelector("img"), null);
    assert.equal(container.querySelector("b"), null);
    assert.equal(container.querySelector("details").querySelector("summary").textContent, "Check output");
    assert.equal(container.querySelector("[data-verify-output]").textContent, "<script>x()</script> ok");
    assertNoInlineStyleOrHandlers(container);
    insp.destroy();
    assert.equal(container.childNodes.length, 0);
  });

  it("inspector humanizes model IDs, telemetry, scope pill and contract lock", () => {
    assert.equal(humanizeModel("antigravity", "gemini-4-carbon"), "Gemini 4 Carbon");
    assert.equal(humanizeModel("claude", "claude-opus-5-5"), "Claude Opus 5.5");
    assert.equal(humanizeModel("devin", "swe-2"), "Devin SWE-2");
    assert.equal(humanizeModel("codex", "gpt-6-astra"), "GPT-6 Astra");
    assert.equal(humanizeModel("antigravity/gemini-4-carbon"), "Gemini 4 Carbon");

    const { container, insp, events } = mount();
    insp.update({
      mission,
      selectedLaneId: "core",
      diffData: CONTRACT_FIXTURES.diff,
      inspectionData: { telemetry: { durationMs: 83000, tokensIn: 123456, tokensOut: 789, costUsd: 0.5 }, verification: { ok: false, cmd: "node --test", output: "1 failing" } },
    });
    const metric = (k) => container.querySelector(`[data-metric="${k}"]`).textContent;
    assert.match(metric("duration"), /1m 23s/);
    assert.match(metric("tokens in"), /123,456/);
    assert.match(metric("cost"), /\$0\.5000/);
    assert.equal(container.querySelector("[data-scope-ok]").getAttribute("data-scope-ok"), "false");
    assert.match(container.querySelector("[data-scope-ok]").textContent, /Outside assigned files/);
    assert.equal(container.querySelector("[data-contract-lock]").getAttribute("data-contract-lock"), "locked");
    assert.equal(container.querySelector("[data-contract-lock]").textContent, "Shared rules intact");
    assert.equal(container.querySelector('[data-pill="model"]').textContent, "Claude Opus");
    assert.ok(container.textContent.includes(".overdrive/worktrees/overdrive/m-core"));
    assert.ok(container.querySelector(".is-out-of-scope"), "out-of-scope file flagged");
    container.querySelector('[data-action="close"]').click();
    assert.equal(events.closed, 1);
    const sel = container.querySelector("[data-lane-select]");
    sel.value = "ui";
    sel.dispatchEvent({ type: "change" });
    assert.deepEqual(events.selected, ["ui"]);
    insp.destroy();
  });

  it("inspector switches unified/split and navigates hunks with nextHunk/prevHunk and [ ]", () => {
    const { container, insp } = mount();
    insp.update({ mission, lane, diffData: { patch: MULTI } });
    const table = () => container.querySelector(`.${UI_CLASSES.diffTable}`);
    const modeGroup = container.querySelector(".od-insp-mode-group");
    assert.equal(modeGroup.querySelector('[data-diff-mode="unified"]').textContent, "Unified");
    assert.equal(modeGroup.querySelector('[data-diff-mode="split"]').textContent, "Side-by-side");
    assert.equal(table().classList.contains("is-split"), false);
    assert.ok(container.querySelectorAll(".is-add").length > 0);
    assert.ok(container.querySelectorAll(".is-del").length > 0);
    assert.ok(container.querySelectorAll(".is-ctx").length > 0);
    assert.ok(container.querySelector(".od-diff-gutter"));

    assert.equal(insp.setDiffMode("split"), "split");
    assert.equal(table().classList.contains("is-split"), true);
    assert.ok(container.querySelectorAll('[data-side="left"]').length > 0);
    assert.ok(container.querySelectorAll('[data-side="right"]').length > 0);
    assert.equal(container.querySelectorAll(".od-diff-cell").length % 2, 0, "every split row has a left and right code cell");
    assert.ok(container.querySelector(".is-empty"), "null spacer rendered for unbalanced change block");
    assert.equal(insp.setDiffMode("bogus"), "split");
    container.querySelector('[data-diff-mode="unified"]').click();
    assert.equal(table().classList.contains("is-split"), false);

    const total = container.querySelectorAll(`.${UI_CLASSES.diffHunkHeader}`).length;
    assert.equal(total, 4);
    assert.equal(insp.nextHunk(), 0);
    assert.equal(insp.nextHunk(), 1);
    assert.equal(insp.prevHunk(), 0);
    insp.root.dispatchEvent({ type: "keydown", key: "]" });
    insp.root.dispatchEvent({ type: "keydown", key: "]" });
    insp.root.dispatchEvent({ type: "keydown", key: "]" });
    insp.root.dispatchEvent({ type: "keydown", key: "]" });
    const active = container.querySelectorAll(".is-active").filter((n) => n.classList.contains(UI_CLASSES.diffHunkHeader));
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute("data-hunk-index"), "3");
    assert.equal(container.querySelector("[data-hunk-badge]").textContent, "Change 4 of 4");
    insp.root.dispatchEvent({ type: "keydown", key: "[" });
    assert.equal(container.querySelector("[data-hunk-badge]").textContent, "Change 3 of 4");
    insp.destroy();
  });

  it("inspector filters files, collapses headers and handles empty/loading/error states", () => {
    const { container, insp } = mount();
    insp.update({});
    assert.equal(container.querySelector("[data-state]").getAttribute("data-state"), "empty");
    insp.update({ mission, lane, loading: true });
    assert.ok(container.querySelector('[data-state="loading"]'));
    insp.update({ mission, lane, error: new Error("boom <x>") });
    assert.match(container.querySelector('[data-state="error"]').textContent, /boom <x>/);

    insp.update({ mission, lane, diffData: { patch: MULTI } });
    assert.equal(container.querySelectorAll("[data-file-path]").length, 5);
    container.querySelector('[data-filter-path="docs/new.md"]').click();
    assert.equal(container.querySelectorAll("[data-file-path]").length, 1);
    container.querySelector('[data-filter-path="*"]').click();
    assert.equal(container.querySelectorAll("[data-file-path]").length, 5);

    const head = container.querySelector(`.${UI_CLASSES.diffFileHead}`);
    head.click();
    const card = container.querySelector('[data-file-path="src/app.mjs"]');
    assert.ok(card.classList.contains("is-collapsed"));
    assert.equal(card.querySelector("table"), null);
    insp.destroy();
  });

  it("inspector shows a truncation banner when DIFF_CAPS are hit", () => {
    const { container, insp } = mount();
    const files = Array.from({ length: DIFF_CAPS.maxFiles + 3 }, (_, i) => ({ path: `f${i}.txt`, status: "modified", additions: 1, deletions: 0, patch: `--- a/f${i}.txt\n+++ b/f${i}.txt\n@@ -0,0 +1,1 @@\n+x` }));
    const norm = normalizeDiffFiles({ files });
    assert.equal(norm.files.length, DIFF_CAPS.maxFiles);
    assert.equal(norm.omittedFiles, 3);
    insp.update({ mission, lane, diffData: { files, contracts: [] } });
    const banner = container.querySelector("[data-truncated]");
    assert.ok(banner);
    assert.match(banner.textContent, /3 file\(s\) omitted/);
    insp.destroy();
  });

  function mountComposer(api) {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const created = [];
    let closed = 0;
    const comp = createComposer({ container, store: null, api, onCreated: (res, meta) => created.push({ res, meta }), onClose: () => closed++ });
    return { container, comp, created, closedCount: () => closed };
  }

  function typeInto(el, value) {
    el.value = value;
    el.dispatchEvent({ type: "input" });
  }

  it("composer loads presets and live-detects src/*.mjs vs src/server.mjs collisions", () => {
    const { container, comp } = mountComposer({});
    comp.open("feature-ui-api");
    assert.equal(comp.isOpen, true);
    assert.equal(container.querySelector(".od-comp-eyebrow").textContent, "Zero file conflicts by design");
    assert.equal(container.querySelector("h2").textContent, "Start a parallel build");
    assert.equal(container.querySelector('[data-preset="feature-ui-api"]').textContent, "Full Feature (UI + Backend + Review)");
    assert.equal(container.querySelector('[data-preset="research-harden"]').textContent, "Explore & Harden");
    assert.ok(container.textContent.includes("What are you building?"));
    assert.ok(container.textContent.includes("Project folder"));
    assert.ok(container.textContent.includes("How should models be chosen?"));
    assert.equal(container.querySelectorAll(`.${UI_CLASSES.compLaneRow}`).length, PRESETS["feature-ui-api"].lanes.length);
    const submit = container.querySelector('[data-action="submit"]');
    assert.equal(submit.disabled, true, "repoRoot missing keeps submit disabled");
    typeInto(container.querySelector('[data-field="repoRoot"]'), "/workspace/demo");
    assert.equal(submit.disabled, false);
    assert.equal(comp.validate().ok, true);

    const globs = container.querySelectorAll('[data-field="ownedGlobs"]');
    typeInto(globs[0], "src/*.mjs");
    let v = comp.validate();
    assert.equal(v.collisions.length, 1, "src/*.mjs swallows frozen contract src/contracts.mjs");
    assert.equal(v.collisions[0].kind, "contract_lane_overlap");
    assert.equal(container.querySelector('[data-field="sharedContracts"]').classList.contains("is-collision"), true);
    typeInto(container.querySelector('[data-field="sharedContracts"]'), "");
    typeInto(globs[1], "src/server.mjs");
    v = comp.validate();
    assert.equal(v.ok, false);
    assert.deepEqual(v.collisions.map((c) => c.kind), ["lane_lane_overlap"]);
    const rows = container.querySelectorAll(`.${UI_CLASSES.compLaneRow}`);
    assert.equal(rows[0].classList.contains("is-collision"), true);
    assert.equal(rows[1].classList.contains("is-collision"), true);
    assert.equal(rows[2].classList.contains("is-collision"), false);
    assert.equal(globs[0].classList.contains("is-collision"), true);
    assert.equal(submit.disabled, true);
    const overlapMsg = container.querySelector('[data-kind="lane_lane_overlap"]').textContent;
    assert.ok(overlapMsg.includes("src/server.mjs"));
    assert.match(overlapMsg, /overlap/i);

    typeInto(globs[1], "src/api/**");
    assert.equal(comp.validate().ok, true);
    assert.equal(rows[0].classList.contains("is-collision"), false);
    assert.equal(submit.disabled, false);

    container.querySelector('[data-preset="research-harden"]').click();
    assert.equal(container.querySelectorAll(`.${UI_CLASSES.compLaneRow}`).length, 2);
    assert.equal(comp.draft.repoRoot, "/workspace/demo", "preset keeps repo root");
    assertNoInlineStyleOrHandlers(container);
    comp.destroy();
  });

  it("composer submits a clean topology via api.createMission and closes", async () => {
    const calls = [];
    const { container, comp, created, closedCount } = mountComposer({ createMission: async (body) => (calls.push(body), { ok: true, mission: { id: "m9" } }) });
    comp.open({ ...PRESETS["feature-ui-api"], title: "Ship <script>x</script>", repoRoot: "/workspace/demo" });
    const res = await comp.submit();
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, "Ship <script>x</script>");
    assert.equal(calls[0].lanes.length, 3);
    assert.deepEqual(calls[0].lanes[0].ownedGlobs, ["src/core/**", "test/core/**"]);
    assert.equal(calls[0].routingMode, "mix-and-match");
    assert.equal(created[0].res.mission.id, "m9");
    assert.equal(comp.isOpen, false);
    assert.equal(closedCount(), 1);
    assert.equal(container.querySelector("script"), null);
    comp.destroy();
  });

  it("composer blocks invalid submits and shows inline errors instead of dialogs", async () => {
    const { container, comp } = mountComposer({
      createMission: async () => {
        throw new Error("repoRoot does not exist");
      },
    });
    comp.open("blank");
    const blocked = await comp.submit();
    assert.equal(blocked.ok, false);
    assert.equal(container.querySelector("[data-banner]").hidden, false);
    comp.open({ ...PRESETS["research-harden"], title: "R", repoRoot: "/workspace/nope" });
    const failed = await comp.submit();
    assert.equal(failed.ok, false);
    assert.match(container.querySelector("[data-banner]").textContent, /repoRoot does not exist/);
    assert.equal(comp.isOpen, true);
    comp.destroy();
  });

  it("composer Seed Showcase Demo is wired to api.seedDemo", async () => {
    let seeded = 0;
    const { container, comp, created } = mountComposer({
      seedDemo: async () => {
        seeded++;
        return { schemaVersion: 1, missionId: "demo-1", fixtureVersion: "overdrive-showcase-v0.2.0" };
      },
    });
    comp.open();
    container.querySelector('[data-action="seed-demo"]').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(seeded, 1);
    assert.equal(created[0].meta.demo, true);
    assert.equal(created[0].res.missionId, "demo-1");
    assert.equal(comp.isOpen, false);
    comp.destroy();
  });

  it("inspector displays stdoutTail/stderrTail and switches inspectorTab (brief/audit/diff)", () => {
    const { container, insp } = mount();
    insp.update({
      mission,
      lane: { ...lane, brief: "Build replay core", ownedGlobs: ["src/core/**"] },
      inspectorTab: "diff",
      diffData: { patch: MULTI },
      inspectionData: { lastVerify: { ok: false, cmd: "node --test", stdoutTail: "1 test failed", stderrTail: "AssertionError" } },
    });
    const out = container.querySelector("[data-verify-output]").textContent;
    assert.match(out, /1 test failed/);
    assert.match(out, /AssertionError/);

    insp.update({ mission, lane: { ...lane, brief: "Build replay core", ownedGlobs: ["src/core/**"] }, inspectorTab: "brief", diffData: { patch: MULTI } });
    assert.match(container.querySelector("[data-lane-brief]").textContent, /Build replay core/);

    insp.update({
      mission: { ...mission, freezeCommit: "deadbeef" },
      lane,
      inspectorTab: "audit",
      diffData: CONTRACT_FIXTURES.diff,
      inspectionData: { contracts: CONTRACT_FIXTURES.diff.contracts, dirtyFiles: [] },
    });
    assert.match(container.querySelector('[data-panel="audit"]').textContent, /deadbeef/);
    insp.destroy();
  });

  it("composer unwraps topology mode, preserves gates & briefs, and saves via api.planMission", async () => {
    const plannedCalls = [];
    const { container, comp } = mountComposer({
      planMission: async (id, body) => (plannedCalls.push({ id, body }), { ok: true, mission: { id } }),
    });
    comp.open({
      mode: "topology",
      mission: {
        id: "m-edit",
        title: "Existing Mission",
        goal: "Polish DAG",
        repoRoot: "/workspace/demo",
        routingMode: "playbook-auto",
        activeHarness: "antigravity",
        contracts: [{ path: "ui/contracts.js" }],
        lanes: [{ id: "ui", title: "UI", brief: "Keep clean brief", complexity: "hard", offload: "local", ownedGlobs: ["ui/app.js"], verifyCmd: "npm test" }],
        gates: [{ id: "g1", title: "Unit suite", cmd: "npm test", offload: "local", required: true }],
      },
    });
    assert.match(container.querySelector("h2").textContent, /Update team/i);
    assert.equal(comp.validate().ok, true);
    const res = await comp.submit();
    assert.equal(res.ok, true);
    assert.equal(plannedCalls.length, 1);
    assert.equal(plannedCalls[0].id, "m-edit");
    assert.equal(plannedCalls[0].body.lanes[0].brief, "Keep clean brief");
    assert.equal(plannedCalls[0].body.gates.length, 1);
    comp.destroy();
  });

  it("inspector renders cloud compute target pill and Metric Ratchet card without leaking holdout commands", () => {
    const { container, insp } = mount();
    const cloudLane = {
      ...lane,
      offload: "cloud-agent",
      worker: { harness: "claude", model: "claude-opus-5-5", dispatch: "claude-cloud" },
      ratchet: {
        metrics: [{ name: "parity", baseline: 94.2, op: ">=", maxRegression: 0 }],
        holdoutConfigured: true,
        holdoutCmd: "SECRET_NEVER_PRINT_THIS_CMD --token=xyz",
      },
      lastVerify: {
        ok: true,
        ratchet: {
          ok: true,
          exitCode: 0,
          metrics: { parity: 96.5 },
          baseline: { parity: 94.2 },
          deltas: { parity: 2.3 },
          violations: [],
          holdoutConfigured: true,
          holdoutPassed: true,
        },
      },
    };
    insp.update({
      mission: { ...mission, lanes: [cloudLane] },
      lane: cloudLane,
      inspectorTab: "audit",
      diffData: CONTRACT_FIXTURES.diff,
      inspectionData: { contracts: CONTRACT_FIXTURES.diff.contracts, dirtyFiles: [] },
    });

    const computePill = container.querySelector('[data-pill="compute"]');
    assert.ok(computePill);
    assert.equal(computePill.classList.contains(UI_CLASSES.cloudBadge), true);
    assert.equal(computePill.textContent, "Claude Cloud");

    const ratchetCard = container.querySelector("[data-ratchet-card]");
    assert.ok(ratchetCard);
    const ratchetBadge = ratchetCard.querySelector(`.${UI_CLASSES.ratchetBadge}`);
    assert.ok(ratchetBadge);
    assert.equal(ratchetBadge.textContent, "Passed");
    assert.match(ratchetCard.textContent, /94\.2/);
    assert.match(ratchetCard.textContent, /96\.5/);
    assert.match(ratchetCard.textContent, /Coordinator holdout active/);
    assert.equal(container.textContent.includes("SECRET_NEVER_PRINT_THIS_CMD"), false);

    // Check regressed state + Devin Cloud VM target
    insp.update({
      mission,
      lane: {
        ...lane,
        offload: "devin-vm",
        worker: { harness: "devin", model: "swe-2" },
        lastVerify: {
          ok: false,
          ratchet: {
            ok: false,
            exitCode: 1,
            metrics: { parity: 91.0 },
            baseline: { parity: 94.2 },
            deltas: { parity: -3.2 },
            violations: ["parity regressed below 94.2"],
            holdoutConfigured: true,
            holdoutPassed: false,
          },
        },
      },
      inspectorTab: "audit",
      diffData: CONTRACT_FIXTURES.diff,
    });
    assert.equal(container.querySelector('[data-pill="compute"]').textContent, "Devin Cloud VM");
    assert.equal(container.querySelector("[data-ratchet-status]").textContent, "Regressed");
    assertNoInlineStyleOrHandlers(container);
    insp.destroy();
  });

  it("composer exposes all 6 OFFLOAD_MODES, Cloud Swarm preset, and per-lane Metric Ratchet helper", () => {
    assert.equal(OFFLOAD_OPTIONS.length, OFFLOAD_MODES.length);
    for (const mode of OFFLOAD_MODES) {
      assert.ok(OFFLOAD_OPTIONS.some((o) => o.value === mode), `missing offload mode ${mode}`);
    }

    const { container, comp } = mountComposer({});
    comp.open("cloud-swarm");
    assert.equal(comp.draft.routingMode, "playbook-auto");
    assert.equal(comp.draft.lanes[0].offload, "cloud-agent");
    assert.equal(container.querySelector('[data-preset="cloud-swarm"]').textContent, "Cloud Swarm (Zero Local Load)");

    const offloadOpts = [...container.querySelector('[data-field="offload"]').childNodes].map((o) => o.getAttribute("value"));
    for (const mode of OFFLOAD_MODES) {
      assert.ok(offloadOpts.includes(mode), `missing <option> for ${mode}`);
    }

    // Use baseline metric helper on lane 0 and reject coordinator-private holdoutCmd
    typeInto(container.querySelector('[data-field="repoRoot"]'), "/workspace/demo");
    typeInto(container.querySelector('[data-field="ratchetMetricName"]'), "parity");
    typeInto(container.querySelector('[data-field="ratchetMetricBaseline"]'), "94.2");
    container.querySelector('[data-action="apply-ratchet-metric"]').click();
    assert.equal(comp.validate().ok, true);
    assert.equal(comp.draft.lanes[0].ratchet.metrics[0].name, "parity");
    assert.equal(comp.draft.lanes[0].ratchet.metrics[0].baseline, 94.2);

    typeInto(container.querySelector('[data-field="ratchetJson"]'), '{"metrics":[{"name":"parity","baseline":94.2}],"holdoutCmd":"secret"}');
    assert.equal(comp.validate().ok, false);
    assert.ok(container.querySelector('[data-kind="ratchet"]'));
    assertNoInlineStyleOrHandlers(container);
    comp.destroy();
  });

  it("renderRsiView renders backend frictionHotspots, driftAlerts, and totalTokens cleanly without blanks", () => {
    const doc = createMockDom();
    const container = doc.createElement("div");
    renderRsiView({
      container,
      rsi: {
        loading: false,
        error: null,
        overview: {
          benchmark: { score: 100, maxScore: 100 },
          candidates: [],
          digest: {
            totalSessions: 33802,
            privacyMode: "strict_local",
            cloudOffloadPct: 46.5,
            freePoolPct: 34.7,
            activeFocus: [{ project: "analytics-engine", sessions: 9, totalTokens: 192000, lastActiveAt: "2026-11-18T10:00:00Z" }],
            wentQuietQuestions: [],
            frictionHotspots: [
              { kind: "duplicate_tool", label: "X search:", count: 109487, detail: "X search: repeated 109487 duplicate call(s)" },
            ],
            driftAlerts: [
              { source: "cursor-acp", severity: "info", message: "ACP session dirs store only cwd" },
            ],
          },
        },
      },
    });
    const focusText = container.querySelector("[data-rsi-focus-list]").textContent;
    assert.match(focusText, /analytics-engine/);
    assert.match(focusText, /192\.0k tokens/);
    const frictionText = container.querySelector("[data-rsi-friction-list]").textContent;
    assert.match(frictionText, /X search:/);
    assert.match(frictionText, /duplicate tool/);
    assert.match(frictionText, /109,487×/);
    assert.match(frictionText, /repeated 109487 duplicate call/);
    const driftText = container.querySelector("[data-rsi-drift-list]").textContent;
    assert.match(driftText, /cursor-acp/);
    assert.match(driftText, /info/);
    assert.match(driftText, /ACP session dirs store only cwd/);
    assertNoInlineStyleOrHandlers(container);
  });
});
