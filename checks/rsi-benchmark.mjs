import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultDataDir } from "../src/paths.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_UI_EXT = new Set([".js", ".mjs", ".html", ".css"]);
const PRE_MERGE_LEGACY = new Set(["ui/app.js", "ui/index.html"]);
const FREEZE_COMMIT = "b25aedadaaa95f80f5492595010a0ca8b33b64a1";

const SECURITY_RULES = Object.freeze([
  { id: "innerHTML", re: /\binnerHTML\b/ },
  { id: "outerHTML", re: /\bouterHTML\b/ },
  { id: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/ },
  { id: "document.write", re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/ },
  { id: "eval", re: /(?<![\w$.])eval\s*\(/ },
  { id: "new Function", re: /\bnew\s+Function\s*\(/ },
  { id: "javascript: url", re: /javascript\s*:/i },
  { id: "inline on* handler", re: /<[a-zA-Z][^>\n]*\son[a-z]+\s*=/ },
  { id: "inline style attribute", re: /<[a-zA-Z][^>\n]*\sstyle\s*=/i },
  { id: "inline style attribute (html)", re: /^\s*style\s*=/i, ext: [".html"] },
  { id: "setAttribute style", re: /setAttribute\(\s*["'`]style["'`]/ },
  { id: "element.style write", re: /\.style\s*(?:\.\s*[\w$]+\s*=(?!=)|\[[^\]]+\]\s*=(?!=)|=(?!=)|\.\s*(?:setProperty|cssText)\b)/ },
  { id: "transition: all", re: /transition(?:-property)?\s*:[^;}\n]*\ball\b/i },
  { id: "blocking dialog", re: /(?<![\w$.])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\(/ },
  { id: "external script/link", re: /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external @import", re: /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external css url()", re: /url\(\s*["']?\s*(?:https?:)?\/\//i },
  { id: "external ES import", re: /\bimport\s*(?:\(\s*|[^"'`;]*?\bfrom\s*)["'`](?:https?:)?\/\//i },
  { id: "external fetch", re: /\bfetch\s*\(\s*["'`]https?:\/\//i },
]);

function scanSourceLocal(source, ext = ".html") {
  const hits = [];
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  lines.forEach((text, i) => {
    for (const rule of SECURITY_RULES) {
      if (rule.ext && !rule.ext.includes(ext)) continue;
      if (rule.re.test(text)) hits.push({ rule: rule.id, line: i + 1, text: text.trim().slice(0, 120) });
    }
  });
  return hits;
}

function walkUiFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkUiFiles(abs, out);
    else if (SCANNED_UI_EXT.has(path.extname(name).toLowerCase())) out.push(abs);
  }
  return out;
}

function untouchedLegacy(rootDir, rel, content) {
  if (!PRE_MERGE_LEGACY.has(rel)) return false;
  try {
    const frozen = execFileSync("git", ["show", `${FREEZE_COMMIT}:${rel}`], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return frozen.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
}

let importCounter = 0;
async function importTargetModule(rootDir, relPath) {
  const abs = path.resolve(rootDir, relPath);
  if (!existsSync(abs)) {
    throw new Error(`Missing target module: ${relPath}`);
  }
  importCounter += 1;
  return import(`${pathToFileURL(abs).href}?v=${importCounter}`);
}

function scoreChecks(checks) {
  let score = 0;
  let regressions = 0;
  const failures = [];
  for (const chk of checks) {
    try {
      chk.fn();
      score += chk.points;
    } catch (err) {
      regressions += 1;
      failures.push(`${chk.name}: ${err?.message || err}`);
    }
  }
  return { score, maxScore: checks.reduce((s, c) => s + c.points, 0), regressions, failures };
}

function medianNum(values) {
  const nums = (values || []).filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10;
}

/**
 * Compute continuous operational headroom metrics (real latency, offload, first-pass rate, fallback rate)
 * strictly read-only from the local Overdrive SQLite store without touching showcase fixtures.
 */
export function computeOperationalMetrics({
  dataDir = defaultDataDir(),
  benchmarkDurationMs = 0,
  invariantScore = 100,
  invariantMaxScore = 100,
} = {}) {
  const dbPath = path.join(String(dataDir || defaultDataDir()), "overdrive.sqlite");
  let firstPassLaneVerifyRate = null;
  let realOffloadPct = null;
  let medianVerifyLatencyMs = null;
  let medianIntegrateLatencyMs = null;
  let routingFallbackRate = null;
  const sampleSizes = { missions: 0, lanes: 0, receipts: 0, plannedEvents: 0 };

  if (existsSync(dbPath)) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const missions = db.prepare("SELECT id FROM missions WHERE fixture_version IS NULL AND slug != 'overdrive-showcase-v03'").all();
      sampleSizes.missions = missions.length;
      if (missions.length > 0) {
        const lanes = db
          .prepare(
            "SELECT l.offload, l.verifier_json FROM lanes l JOIN missions m ON m.id = l.mission_id WHERE m.fixture_version IS NULL AND m.slug != 'overdrive-showcase-v03'",
          )
          .all();
        sampleSizes.lanes = lanes.length;
        if (lanes.length > 0) {
          let offloaded = 0;
          for (const l of lanes) {
            let eff = "";
            try {
              eff = JSON.parse(l.verifier_json || "{}")?.effectiveOffload || "";
            } catch {}
            const raw = String(l.offload || "");
            const effLow = String(eff).toLowerCase();
            if (
              ["aipc", "aipc-gpu", "devin-vm", "cloud-agent"].includes(raw) ||
              effLow.includes("aipc") ||
              effLow.includes("devin-vm") ||
              effLow.includes("cloud")
            ) {
              offloaded += 1;
            }
          }
          realOffloadPct = Math.round((offloaded / lanes.length) * 1000) / 10;
        }

        const receipts = db
          .prepare(
            "SELECT r.status, r.telemetry_json FROM receipts r JOIN missions m ON m.id = r.mission_id WHERE r.kind = 'lane_verify' AND m.fixture_version IS NULL AND m.slug != 'overdrive-showcase-v03'",
          )
          .all();
        sampleSizes.receipts = receipts.length;
        if (receipts.length > 0) {
          let verifiedCount = 0;
          const durations = [];
          for (const r of receipts) {
            if (r.status === "verified") verifiedCount += 1;
            try {
              const tel = JSON.parse(r.telemetry_json || "{}");
              if (typeof tel?.durationMs === "number" && Number.isFinite(tel.durationMs)) {
                durations.push(tel.durationMs);
              }
            } catch {}
          }
          firstPassLaneVerifyRate = Math.round((verifiedCount / receipts.length) * 1000) / 10;
          medianVerifyLatencyMs = medianNum(durations);
        }

        const intEvents = db
          .prepare(
            "SELECT e.payload_json FROM events e JOIN missions m ON m.id = e.mission_id WHERE e.type IN ('integration_verified', 'integration_failed') AND m.fixture_version IS NULL AND m.slug != 'overdrive-showcase-v03'",
          )
          .all();
        const intDurs = [];
        for (const ev of intEvents) {
          try {
            const p = JSON.parse(ev.payload_json || "{}");
            const ms = p?.durationMs ?? p?.elapsedMs;
            if (typeof ms === "number" && Number.isFinite(ms)) intDurs.push(ms);
          } catch {}
        }
        medianIntegrateLatencyMs = medianNum(intDurs);

        const planEvents = db
          .prepare(
            "SELECT e.payload_json FROM events e JOIN missions m ON m.id = e.mission_id WHERE e.type = 'topology_planned' AND m.fixture_version IS NULL AND m.slug != 'overdrive-showcase-v03'",
          )
          .all();
        sampleSizes.plannedEvents = planEvents.length;
        if (planEvents.length > 0) {
          let fallbackCount = 0;
          for (const ev of planEvents) {
            try {
              const p = JSON.parse(ev.payload_json || "{}");
              if (Array.isArray(p?.routingWarnings) && p.routingWarnings.length > 0) fallbackCount += 1;
            } catch {}
          }
          routingFallbackRate = Math.round((fallbackCount / planEvents.length) * 1000) / 10;
        }
      }
    } catch {
      // Non-fatal: missing tables or locked store leave operational telemetry empty.
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const invPct = invariantMaxScore > 0 ? Math.max(0, Math.min(100, (invariantScore / invariantMaxScore) * 100)) : 0;
  const speedHeadroomScore = Math.max(0, Math.min(100, Math.round((100 - Math.min(100, benchmarkDurationMs / 80)) * 10) / 10));
  const rawScore =
    sampleSizes.receipts > 0
      ? invPct * 0.45 +
        speedHeadroomScore * 0.2 +
        (firstPassLaneVerifyRate ?? invPct) * 0.2 +
        (100 - (routingFallbackRate ?? 0)) * 0.15
      : invPct * 0.7 + speedHeadroomScore * 0.3;
  const operationalScore = Math.round(rawScore * 10) / 10;
  const compositeScore = Math.round((invPct * 0.5 + operationalScore * 0.5) * 10) / 10;

  return {
    benchmarkDurationMs,
    speedHeadroomScore,
    firstPassLaneVerifyRate,
    realOffloadPct,
    medianVerifyLatencyMs,
    medianIntegrateLatencyMs,
    routingFallbackRate,
    operationalScore,
    compositeScore,
    sampleSizes,
  };
}

/**
 * Execute the 5-dimension deterministic Overdrive Golden Eval Suite against `rootDir`,
 * plus continuous operational headroom telemetry.
 */
export async function runRsiBenchmark({ rootDir = DEFAULT_ROOT, dataDir } = {}) {
  const t0 = Date.now();
  const resolvedRoot = path.resolve(rootDir);
  if (resolvedRoot !== path.resolve(DEFAULT_ROOT) && process.env.OVERDRIVE_BENCH_CHILD !== "1") {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--json-only", "--root", resolvedRoot],
      {
        cwd: resolvedRoot,
        env: { ...process.env, OVERDRIVE_BENCH_CHILD: "1" },
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (child.status !== 0) {
      throw new Error(`Isolated RSI benchmark subprocess failed (${child.status ?? -1}): ${(child.stderr || child.stdout || "").trim()}`);
    }
    const lines = String(child.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }
  const partition = await importTargetModule(resolvedRoot, "src/partition.mjs");
  const contracts = await importTargetModule(resolvedRoot, "ui/contracts.js");
  const srvContracts = await importTargetModule(resolvedRoot, "src/ui-contracts.mjs");
  const routing = await importTargetModule(resolvedRoot, "src/routing.mjs");
  const diff = await importTargetModule(resolvedRoot, "src/diff.mjs");
  const intentions = await importTargetModule(resolvedRoot, "src/intentions.mjs");

  // Dimension 1: Partition & ownedRegions collision soundness (20 pts)
  const d1 = scoreChecks([
    {
      name: "partition.disjoint-globs-and-regions",
      points: 5,
      fn: () => {
        const ok = partition.validateTopology({
          sharedContracts: [{ path: "ui/contracts.js" }],
          lanes: [
            {
              id: "lane-a",
              ownedGlobs: ["src/a/**"],
              ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_A", endAnchor: "// END_A" }],
              offload: "devin-vm",
              verifyCmd: "node --test",
            },
            {
              id: "lane-b",
              ownedGlobs: ["src/b/**"],
              ownedRegions: [{ path: "bin/monolith.mjs", startAnchor: "// BEGIN_B", endAnchor: "// END_B" }],
              offload: "cloud-agent",
              verifyCmd: "node --test",
            },
          ],
          gates: [{ id: "g1", cmd: "node --test", offload: "aipc-gpu" }],
        });
        assert.equal(ok.ok, true);
        assert.equal(ok.collisions.length, 0);
      },
    },
    {
      name: "partition.glob-and-contract-collision",
      points: 5,
      fn: () => {
        const bad = partition.validateTopology({
          sharedContracts: ["src/contracts.mjs"],
          lanes: [
            { id: "a", ownedGlobs: ["src/**"], verifyCmd: "node -v" },
            { id: "b", ownedGlobs: ["src/ui/**"], verifyCmd: "node -v" },
          ],
        });
        assert.equal(bad.ok, false);
        assert.ok(bad.collisions.some((c) => c.kind === "contract_lane_overlap"));
        assert.ok(bad.collisions.some((c) => c.kind === "lane_lane_overlap"));
      },
    },
    {
      name: "partition.region-duplicate-anchor-and-glob-overlap",
      points: 5,
      fn: () => {
        const dup = partition.validateTopology({
          lanes: [
            { id: "a", ownedGlobs: ["src/a/**"], ownedRegions: [{ path: "bin/app.mjs", startAnchor: "// SEC", endAnchor: "// END" }], verifyCmd: "node -v" },
            { id: "b", ownedGlobs: ["src/b/**"], ownedRegions: [{ path: "bin/app.mjs", startAnchor: "// SEC", endAnchor: "// END" }], verifyCmd: "node -v" },
          ],
        });
        assert.equal(dup.ok, false);
        assert.ok(dup.collisions.some((c) => c.kind === "region_duplicate_anchor"));

        const selfOverlap = partition.validateTopology({
          lanes: [
            { id: "a", ownedGlobs: ["bin/**"], ownedRegions: [{ path: "bin/app.mjs", startAnchor: "// S", endAnchor: "// E" }], verifyCmd: "node -v" },
          ],
        });
        assert.equal(selfOverlap.ok, false);
        assert.ok(selfOverlap.collisions.some((c) => c.kind === "region_glob_overlap"));
      },
    },
    {
      name: "partition.catchall-and-offload-guards",
      points: 5,
      fn: () => {
        assert.throws(() => partition.normalizeRelPattern("**/*"), /Catch-all/);
        assert.throws(() => partition.normalizeRelPattern("../escape"), /traversal/);
        const badOffload = partition.validateTopology({
          lanes: [{ id: "a", ownedGlobs: ["src/a/**"], offload: "bogus-mode", verifyCmd: "node -v" }],
        });
        assert.equal(badOffload.ok, false);
      },
    },
  ]);

  // Dimension 2: UI Security & CSP header strictness (20 pts)
  const d2 = scoreChecks([
    {
      name: "security.csp-strictness",
      points: 6,
      fn: () => {
        const directives = Object.fromEntries(
          contracts.CSP_HEADER.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
            const [k, ...v] = s.split(/\s+/);
            return [k, v.join(" ")];
          }),
        );
        assert.equal(directives["default-src"], "'self'");
        assert.equal(directives["script-src"], "'self'");
        assert.equal(directives["style-src"], "'self'");
        assert.equal(directives["object-src"], "'none'");
        assert.equal(directives["frame-ancestors"], "'none'");
        assert.doesNotMatch(contracts.CSP_HEADER, /unsafe-inline|unsafe-eval|unsafe-hashes|https?:|\*/i);
      },
    },
    {
      name: "security.static-allowlist-path-traversal",
      points: 5,
      fn: () => {
        assert.equal(srvContracts.resolveAllowedStaticAsset(resolvedRoot, "/etc/passwd"), null);
        assert.equal(srvContracts.resolveAllowedStaticAsset(resolvedRoot, "/../package.json"), null);
        assert.equal(srvContracts.resolveAllowedStaticAsset(resolvedRoot, "/src/server.mjs"), null);
        const home = srvContracts.resolveAllowedStaticAsset(resolvedRoot, "/");
        assert.ok(home && home.absPath.startsWith(resolvedRoot));
      },
    },
    {
      name: "security.xss-rule-calibration",
      points: 4,
      fn: () => {
        assert.ok(scanSourceLocal("el.inner" + "HTML = x;", ".js").length > 0);
        assert.ok(scanSourceLocal("new Func" + "tion('return 1');", ".js").length > 0);
        assert.ok(scanSourceLocal('<div sty' + 'le="color:red">', ".html").length > 0);
        assert.equal(scanSourceLocal("node.textContent = '<script>';", ".js").length, 0);
      },
    },
    {
      name: "security.ui-assets-clean",
      points: 5,
      fn: () => {
        const uiFiles = walkUiFiles(path.join(resolvedRoot, "ui"));
        assert.ok(uiFiles.length > 0, "ui/ assets missing");
        const violations = [];
        for (const abs of uiFiles) {
          const rel = path.relative(resolvedRoot, abs).split(path.sep).join("/");
          const content = readFileSync(abs, "utf8");
          const hits = scanSourceLocal(content, path.extname(abs).toLowerCase());
          if (hits.length > 0 && !untouchedLegacy(resolvedRoot, rel, content)) {
            violations.push(`${rel}:${hits[0].line}[${hits[0].rule}]`);
          }
        }
        assert.deepEqual(violations, []);
      },
    },
  ]);

  // Dimension 3: Playbook Routing & Banned Model Policy (20 pts)
  const d3 = scoreChecks([
    {
      name: "routing.playbook-free-first-and-cross-family",
      points: 6,
      fn: () => {
        const fleet = {
          harnesses: {
            antigravity: { installed: true, family: "google" },
            codex: { installed: true, family: "openai" },
            claude: { installed: true, family: "anthropic" },
            devin: { installed: true, family: "devin" },
          },
          infra: { aipc: { ready: true, path: "/opt/remote-offload/offload.py" } },
        };
        const out = routing.resolveMissionRouting(
          { routingMode: "playbook-auto", activeHarness: "antigravity" },
          [
            { id: "core", complexity: "hard", ownedGlobs: ["src/core/**"], verifyCmd: "node -v", offload: "auto" },
            { id: "fast", complexity: "fast", ownedGlobs: ["test/**"], verifyCmd: "node -v", offload: "local" },
          ],
          fleet,
        );
        assert.equal(out.lanes[1].worker.harness, "devin");
        assert.equal(out.lanes[1].worker.model, "swe-2-flash");
        assert.equal(out.lanes[0].effectiveOffload, "aipc auto");
        assert.equal(out.lanes[0].verifier.crossFamily, true);
        assert.notEqual(out.lanes[0].verifier.family, out.lanes[0].worker.family);
      },
    },
    {
      name: "routing.banned-models-rejected",
      points: 5,
      fn: () => {
        for (const bad of [
          { harness: "claude", model: "kimi-k2" },
          { harness: "opencode", provider: "lithos", model: "gpt-6" },
          { harness: "opencode", provider: "inco", model: "default" },
          { harness: "opencode", provider: "makora", model: "default" },
          { harness: "opencode", provider: "friendli", model: "default" },
          { harness: "opencode", provider: "nanogpt", model: "default" },
        ]) {
          assert.throws(() => routing.assertModelPolicy(bad), /Policy violation/);
        }
      },
    },
    {
      name: "routing.off-harness-antigravity-rejected",
      points: 5,
      fn: () => {
        assert.throws(() => routing.assertModelPolicy({ harness: "omp", model: "gemini-4-carbon" }), /Antigravity/);
        assert.throws(() => routing.assertModelPolicy({ harness: "omp", provider: "google-antigravity", model: "x" }), /Policy violation/);
        routing.assertModelPolicy({ harness: "antigravity", model: "gemini-4-carbon" }, "antigravity");
      },
    },
    {
      name: "routing.single-harness-and-mix-and-match",
      points: 4,
      fn: () => {
        const fleet = { harnesses: { antigravity: { installed: true }, claude: { installed: true }, devin: { installed: true } }, infra: { aipc: { ready: false } } };
        const s = routing.resolveMissionRouting(
          { routingMode: "single-harness", activeHarness: "claude" },
          [{ id: "core", complexity: "hard", ownedGlobs: ["src/**"], verifyCmd: "node -v", offload: "local" }],
          fleet,
        );
        assert.equal(s.lanes[0].worker.harness, "claude");
        assert.equal(s.lanes[0].worker.family, "anthropic");

        const m = routing.resolveMissionRouting(
          { routingMode: "mix-and-match", activeHarness: "antigravity" },
          [{ id: "core", complexity: "hard", ownedGlobs: ["src/**"], verifyCmd: "node -v", worker: { harness: "codex", model: "gpt-6-astra" } }],
          fleet,
        );
        assert.equal(m.lanes[0].worker.family, "openai");
        assert.notEqual(m.lanes[0].verifier.family, "openai");
      },
    },
  ]);

  // Dimension 4: Replay Determinism & Diff Integrity (20 pts)
  const d4 = scoreChecks([
    {
      name: "replay.envelope-version-and-compat",
      points: 5,
      fn: () => {
        assert.equal(contracts.validateReplayEnvelope(contracts.CONTRACT_FIXTURES.replayCheckpoint).ok, true);
        assert.equal(contracts.validateReplayEnvelope({ ...contracts.CONTRACT_FIXTURES.replayDelta, targetVersion: "0.2.0" }).ok, true);
        assert.equal(contracts.validateReplayEnvelope({ ...contracts.CONTRACT_FIXTURES.replayDelta, targetVersion: "0.3.0" }).ok, true);
        assert.equal(contracts.validateReplayEnvelope({ ...contracts.CONTRACT_FIXTURES.replayDelta, targetVersion: "9.9.9" }).ok, false);
        assert.equal(contracts.validateReplayEnvelope({ version: 2, changes: [], causes: [] }).ok, false);
      },
    },
    {
      name: "diff.caps-and-utf8-safety",
      points: 5,
      fn: () => {
        const many = Array.from({ length: contracts.DIFF_CAPS.maxFiles + 4 }, (_, i) => ({
          path: `src/f${i}.mjs`,
          ownership: i === contracts.DIFF_CAPS.maxFiles + 2 ? "out_of_scope" : "owned",
          patch: "+x",
        }));
        const capped = diff.enforceDiffCaps(many, contracts.DIFF_CAPS);
        assert.equal(capped.truncated, true);
        assert.equal(capped.files.length, contracts.DIFF_CAPS.maxFiles);
        assert.equal(capped.omittedFiles, 4);
        assert.ok(capped.files.some((f) => f.ownership === "out_of_scope"), "violations prioritized inside cap");

        const multiByte = "+" + "é".repeat(40000);
        const trunc = diff.truncatePatch(multiByte, contracts.DIFF_CAPS);
        assert.equal(trunc.truncated, true);
        assert.ok(Buffer.byteLength(trunc.patch, "utf8") <= contracts.DIFF_CAPS.maxFileBytes);
        assert.equal(trunc.patch.includes("\uFFFD"), false);
      },
    },
    {
      name: "diff.name-status-z-parser",
      points: 5,
      fn: () => {
        const parsed = diff.parseNameStatusZ(Buffer.from("M\0src/a.mjs\0R095\0ui/old.js\0ui/new.js\0D\0src/del.mjs\0A\0src/new.mjs\0", "utf8"));
        assert.deepEqual(
          parsed.map((p) => [p.status, p.path, p.oldPath]),
          [
            ["modified", "src/a.mjs", null],
            ["renamed", "ui/new.js", "ui/old.js"],
            ["deleted", "src/del.mjs", null],
            ["added", "src/new.mjs", null],
          ],
        );
      },
    },
    {
      name: "diff.ownership-and-rename-boundary",
      points: 5,
      fn: () => {
        const lane = { ownedGlobs: ["ui/**"] };
        const cs = [{ path: "ui/contracts.js" }];
        assert.equal(diff.classifyOwnership("ui/app.js", null, lane, cs).ownership, "owned");
        assert.equal(diff.classifyOwnership("src/core.mjs", null, lane, cs).ownership, "out_of_scope");
        assert.equal(diff.classifyOwnership("ui/contracts.js", null, lane, cs).ownership, "contract_tampered");
        assert.equal(diff.classifyOwnership("ui/stolen.mjs", "src/secret.mjs", lane, cs).ownership, "out_of_scope");
      },
    },
  ]);

  // Dimension 5: Intention Privacy & Ratchet Guard (20 pts)
  const d5 = scoreChecks([
    {
      name: "ratchet.holdout-anti-leakage",
      points: 5,
      fn: () => {
        const raw = { metrics: [{ name: "parity", baseline: 94.2, op: ">=", maxRegression: 0 }], holdoutCmd: "node secret_holdout.mjs" };
        assert.equal(contracts.validateRatchetSpec(raw, { allowHoldout: false }).ok, false);
        assert.equal(contracts.validateRatchetSpec(raw, { allowHoldout: true }).ok, true);
        const pub = contracts.toPublicRatchetSpec(raw);
        assert.equal(pub.holdoutCmd, undefined);
        assert.equal(pub.holdoutConfigured, true);
        assert.equal(contracts.validateRatchetSpec(pub, { allowHoldout: false }).ok, true);
      },
    },
    {
      name: "ratchet.result-fail-closed",
      points: 5,
      fn: () => {
        assert.equal(
          contracts.validateRatchetResult({ ok: true, exitCode: 1, metrics: { p: 99 }, baseline: { p: 94 }, deltas: { p: 5 }, violations: [] }).ok,
          false,
        );
        assert.equal(
          contracts.validateRatchetResult({ ok: true, exitCode: 0, metrics: { p: 99 }, baseline: { p: 94 }, deltas: { p: 5 }, violations: ["regress"] }).ok,
          false,
        );
        assert.equal(
          contracts.validateRatchetResult({ ok: true, exitCode: 0, metrics: { p: 96.8 }, baseline: { p: 94.2 }, deltas: { p: 2.6 }, violations: [], holdoutConfigured: true, holdoutPassed: false }).ok,
          false,
        );
        assert.equal(
          contracts.validateRatchetResult({ ok: true, exitCode: 0, metrics: { p: 96.8 }, baseline: { p: 94.2 }, deltas: { p: 2.6 }, violations: [], holdoutConfigured: true, holdoutPassed: true }).ok,
          true,
        );
      },
    },
    {
      name: "intentions.strict-local-redaction-and-quiet-guard",
      points: 5,
      fn: () => {
        const redacted = intentions.redactPrivateSignals(
          "User alice@example.com in C:\\Users\\alice\\repo with sk-1234567890abcdef and /home/bob/work",
        );
        assert.ok(!redacted.includes("alice@example.com"));
        assert.ok(!redacted.includes("alice"));
        assert.ok(!redacted.includes("bob"));
        assert.ok(!redacted.includes("sk-1234567890abcdef"));

        const badQuiet = {
          schemaVersion: 1,
          generatedAt: "2026-11-18T12:00:00Z",
          privacyMode: "strict_local",
          totalSessions: 5,
          cloudOffloadPct: 40,
          freePoolPct: 60,
          activeFocus: [{ project: "dormant", quietHours: 96 }],
          wentQuietQuestions: [{ kind: "candidate_goal", autoDispatch: true, question: "auto" }],
          frictionHotspots: [],
          driftAlerts: [],
        };
        assert.equal(contracts.validateIntentionDigest(badQuiet).ok, false);
      },
    },
    {
      name: "rsi.candidate-tier-harness-crossfamily-guard",
      points: 5,
      fn: () => {
        const base = {
          id: "c1",
          category: "routing-efficiency",
          targetRepo: "overdrive",
          tier: "self_sandbox",
          title: "Improve routing",
          rationale: "Free first",
          evidenceRefs: ["ledger:sessions"],
          status: "promoted",
          baselineScore: 90,
          candidateScore: 95,
          regressions: 0,
          touchesHarness: false,
          prePromoteCommit: "deadbeef",
          proposer: { family: "google", modelId: "gemini-4-carbon" },
          audit: { verdict: "approve", auditorFamily: "openai", auditorModel: "gpt-6-astra" },
        };
        assert.equal(contracts.validateRsiCandidate(base).ok, true);
        assert.equal(contracts.validateRsiCandidate({ ...base, touchesHarness: true }).ok, false);
        assert.equal(contracts.validateRsiCandidate({ ...base, tier: "proposal_only" }).ok, false);
        assert.equal(contracts.validateRsiCandidate({ ...base, tier: "proposal_only", humanApproved: true }).ok, true);
        assert.equal(contracts.validateRsiCandidate({ ...base, audit: { verdict: "approve", auditorFamily: "google" } }).ok, false);
      },
    },
  ]);

  const partitionScore = d1.score;
  const securityScore = d2.score;
  const routingScore = d3.score;
  const replayScore = d4.score;
  const ratchetScore = d5.score;
  const score = partitionScore + securityScore + routingScore + replayScore + ratchetScore;
  const maxScore = d1.maxScore + d2.maxScore + d3.maxScore + d4.maxScore + d5.maxScore;
  const regressions = d1.regressions + d2.regressions + d3.regressions + d4.regressions + d5.regressions;
  const failures = [...d1.failures, ...d2.failures, ...d3.failures, ...d4.failures, ...d5.failures];

  const benchmarkDurationMs = Math.max(1, Date.now() - t0);
  const operationalMetrics = computeOperationalMetrics({
    ...(dataDir ? { dataDir } : {}),
    benchmarkDurationMs,
    invariantScore: score,
    invariantMaxScore: maxScore,
  });

  return {
    schemaVersion: 1,
    ok: regressions === 0,
    score,
    maxScore,
    regressions,
    partitionScore,
    securityScore,
    routingScore,
    ratchetScore,
    replayScore,
    operationalScore: operationalMetrics.operationalScore,
    compositeScore: operationalMetrics.compositeScore,
    operationalMetrics,
    dimensions: {
      partition: d1,
      security: d2,
      routing: d3,
      replay: d4,
      ratchet: d5,
    },
    failures,
    measuredAt: new Date().toISOString(),
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.includes("--json-only")) {
    const rootArgIdx = process.argv.indexOf("--root");
    const targetRoot = rootArgIdx >= 0 && process.argv[rootArgIdx + 1] ? process.argv[rootArgIdx + 1] : DEFAULT_ROOT;
    const summary = await runRsiBenchmark({ rootDir: targetRoot });
    console.log(JSON.stringify(summary));
  } else {
    const { describe, it } = await import("node:test");
    let summary = null;
    describe("Overdrive v0.3.0 Golden RSI Benchmark Suite", () => {
      it("passes all 5 benchmark dimensions with 0 regressions and emits OVERDRIVE_METRICS_JSON", async () => {
        summary = await runRsiBenchmark({ rootDir: DEFAULT_ROOT });
        const metricsPayload = {
          score: summary.score,
          maxScore: summary.maxScore,
          regressions: summary.regressions,
          partitionScore: summary.partitionScore,
          securityScore: summary.securityScore,
          routingScore: summary.routingScore,
          ratchetScore: summary.ratchetScore,
          replayScore: summary.replayScore,
          operationalScore: summary.operationalScore,
          compositeScore: summary.compositeScore,
          benchmarkDurationMs: summary.operationalMetrics.benchmarkDurationMs,
        };
        console.log(`OVERDRIVE_METRICS_JSON: ${JSON.stringify(metricsPayload)}`);
        assert.equal(summary.regressions, 0, summary.failures.join("\n"));
        assert.equal(summary.score, summary.maxScore);
      });
    });
  }
}
