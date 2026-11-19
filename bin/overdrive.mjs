#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runRsiBenchmark } from "../checks/rsi-benchmark.mjs";
import { planPodTournament } from "../src/adhd-bridge.mjs";
import { mergeTeamBriefIntoPool, readAccountPool, readTeamBrief, selectAssistantForRole } from "../src/assistants.mjs";
import { install } from "../src/install.mjs";
import { runStdioMcp } from "../src/mcp.mjs";
import { validateTopology } from "../src/partition.mjs";
import { detectFleet, resolveMissionRouting } from "../src/routing.mjs";
import { getRsiOverview, scanRsiOpportunities } from "../src/rsi.mjs";
import { startStudioServer } from "../src/server.mjs";
import { OverdriveStore, defaultDataDir } from "../src/store.mjs";
import { VERSION } from "../src/version.mjs";
import { auditAndVerifyLane } from "../src/worktree.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args.shift() : "help";

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const val = args[i + 1];
  return val && !val.startsWith("-") ? val : "";
}
const has = (name) => args.includes(name);
const dataDir = flag("--data") || defaultDataDir();

function usage() {
  console.log(`overdrive v${VERSION} — Think -> Contract Freeze -> Parallel Swarm -> Cross-Family Verify

Usage:
  overdrive mcp [--data <dir>]                           Start stdio MCP server
  overdrive studio [--port 7878] [--data <dir>]          Start Overdrive Mission Control UI
  overdrive doctor                                       Check harnesses, ADHD data, connect-anything & aipc
  overdrive install [--dry-run] [--uninstall] [--harnesses a,b]
                                                         Register MCP + skill into detected harnesses
  overdrive validate <topology.json> [--mode ...]        Mechanically validate zero glob overlaps & routing
  overdrive status [--data <dir>]                        Show missions in SQLite store
  overdrive verify-lane --mission <id> --lane <id> [--data <dir>]
                                                         Audit scope + run verifyCmd for a lane
  overdrive integrate --mission <id> [--lanes a,b] [--gate <id>] [--cleanup] [--no-gates] [--no-holdouts] [--no-promote] [--data <dir>]
                                                         Run atomic trial-merge & holdout ratchet
  overdrive pod-plan [--goal "..."] [--thinkers 12] [--pod-size 5] [--harness antigravity]
                                                         Plan a 1-40 thinker Pod-Tournament + 4-judge Apex topology
  overdrive assistants [--role research] [--since <ts>]  Read team_cli.py brief merged with ACCOUNT_ROUTER pool freshness
  overdrive rsi <scan|benchmark|overview> [--data <dir>] [--root <dir>]
                                                         Run strict-local RSI scan, benchmark, or overview
`);
}

if (cmd === "help" || has("--help") || has("-h")) {
  usage();
  process.exit(0);
}

if (cmd === "mcp") {
  runStdioMcp(dataDir);
} else if (cmd === "doctor") {
  const fleet = detectFleet();
  console.log(JSON.stringify(fleet, null, 2));
} else if (cmd === "install") {
  const rawH = flag("--harnesses");
  const harnesses = rawH ? rawH.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const res = await install({ harnesses, dryRun: has("--dry-run"), uninstall: has("--uninstall") });
  for (const r of res) {
    console.log(`${r.ok ? "[OK]" : "[--]"} ${r.harness}: ${r.message}`);
  }
} else if (cmd === "validate") {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    console.error("Usage: overdrive validate <topology.json> [--mode single-harness|playbook-auto|mix-and-match]");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(file, "utf8"));
  const check = validateTopology(spec);
  if (!check.ok) {
    console.error(JSON.stringify({ ok: false, errors: check.errors, collisions: check.collisions }, null, 2));
    process.exit(1);
  }
  const mode = flag("--mode") || spec.routingMode || "playbook-auto";
  const routed = resolveMissionRouting({ routingMode: mode, activeHarness: flag("--harness") || "antigravity" }, check.normalized.lanes);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: routed.mode,
        freeTierPolicy: routed.freeTierPolicy,
        routingWarnings: routed.routingWarnings,
        degradedAccounts: routed.degradedAccounts,
        lanes: routed.lanes,
      },
      null,
      2,
    ),
  );
} else if (cmd === "status") {
  const store = new OverdriveStore(dataDir);
  try {
    console.log(JSON.stringify({ dataDir: store.dataDir, missions: store.listMissions() }, null, 2));
  } finally {
    store.close();
  }
} else if (cmd === "verify-lane") {
  const missionId = flag("--mission");
  const laneId = flag("--lane");
  if (!missionId || !laneId) {
    console.error("Usage: overdrive verify-lane --mission <id> --lane <id>");
    process.exit(2);
  }
  const store = new OverdriveStore(dataDir);
  try {
    const out = auditAndVerifyLane(store, missionId, laneId, { runCmd: !has("--no-run") });
    console.log(JSON.stringify(out.result, null, 2));
    if (!out.result.ok) process.exit(1);
  } finally {
    store.close();
  }
} else if (cmd === "integrate") {
  const missionId = flag("--mission");
  if (!missionId) {
    console.error("Usage: overdrive integrate --mission <id> [--data <dir>]");
    process.exit(2);
  }
  let mod;
  try {
    mod = await import("../src/integrate.mjs");
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") {
      console.error("src/integrate.mjs is not present in this isolated worktree yet.");
      process.exit(1);
    }
    throw err;
  }
  const fn = mod.integrateMission || mod.integrateLanes || mod.runIntegration || mod.integrate;
  if (!fn) {
    console.error("No integration entry point exported by src/integrate.mjs.");
    process.exit(1);
  }
  const store = new OverdriveStore(dataDir);
  try {
    const rawLanes = flag("--lanes");
    const laneIds = rawLanes ? rawLanes.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const gateId = flag("--gate") || null;
    const out = await fn(store, missionId, {
      ...(laneIds ? { laneIds } : {}),
      ...(gateId ? { gateId } : {}),
      cleanupWorktrees: has("--cleanup"),
      runGates: !has("--no-gates"),
      runHoldouts: !has("--no-holdouts"),
      promoteToRepoRoot: !has("--no-promote"),
    });
    console.log(JSON.stringify(out, null, 2));
    if (out?.ok === false) process.exit(1);
  } finally {
    store.close();
  }
} else if (cmd === "pod-plan") {
  const thinkersRaw = flag("--thinkers");
  const podSizeRaw = flag("--pod-size");
  const plan = planPodTournament({
    ...(flag("--goal") ? { goal: flag("--goal") } : {}),
    ...(flag("--context") ? { contextSummary: flag("--context") } : {}),
    ...(thinkersRaw ? { totalThinkers: Number(thinkersRaw) } : {}),
    ...(podSizeRaw ? { podSize: Number(podSizeRaw) } : {}),
    ...(flag("--harness") ? { activeHarness: flag("--harness") } : {}),
  });
  console.log(JSON.stringify(plan, null, 2));
} else if (cmd === "assistants") {
  const sinceRaw = flag("--since");
  const role = flag("--role") || "research";
  const rawPool = readAccountPool();
  const brief = readTeamBrief({ ...(sinceRaw ? { since: Number(sinceRaw) } : {}) });
  const pool = mergeTeamBriefIntoPool(rawPool, brief);
  const selection = selectAssistantForRole(role, { pool, teamBrief: brief });
  console.log(JSON.stringify({ role, brief, pool, selection }, null, 2));
} else if (cmd === "rsi") {
  const sub = args.find((a) => !a.startsWith("-")) || "overview";
  const rootDir = flag("--root") || REPO_ROOT;
  if (sub === "benchmark") {
    const bench = await runRsiBenchmark({ rootDir });
    console.log(JSON.stringify(bench, null, 2));
    console.log(
      `OVERDRIVE_METRICS_JSON: ${JSON.stringify({
        score: bench.score,
        maxScore: bench.maxScore,
        regressions: bench.regressions,
        partitionScore: bench.partitionScore,
        securityScore: bench.securityScore,
        routingScore: bench.routingScore,
        ratchetScore: bench.ratchetScore,
        replayScore: bench.replayScore,
        operationalScore: bench.operationalScore,
        compositeScore: bench.compositeScore,
        benchmarkDurationMs: bench.operationalMetrics?.benchmarkDurationMs,
      })}`,
    );
    if (bench.regressions > 0) process.exit(1);
  } else if (sub === "scan") {
    const store = new OverdriveStore(dataDir);
    try {
      const out = await scanRsiOpportunities(store, { benchmarkRoot: rootDir, repoRoot: rootDir });
      console.log(JSON.stringify(out, null, 2));
    } finally {
      store.close();
    }
  } else if (sub === "overview") {
    const store = new OverdriveStore(dataDir);
    try {
      const out = getRsiOverview(store, { repoRoot: rootDir });
      console.log(JSON.stringify(out, null, 2));
    } finally {
      store.close();
    }
  } else {
    console.error(`Unknown rsi subcommand: ${sub}. Expected scan | benchmark | overview.`);
    process.exit(2);
  }
} else if (cmd === "studio") {
  const store = new OverdriveStore(dataDir);
  const port = Number(flag("--port") || 7878);
  const srv = await startStudioServer(store, { port });
  console.log(`Overdrive Mission Control: ${srv.launchUrl}`);
  const shutdown = async () => {
    await srv.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}
