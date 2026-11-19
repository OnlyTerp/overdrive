import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultAdhdDataDir } from "./paths.mjs";
import { assertModelPolicy, detectFleet, modelFamilyOf } from "./routing.mjs";

export function adhdDataDir() {
  return defaultAdhdDataDir();
}

function openAdhdReadOnly(dataDir) {
  const dbPath = path.join(dataDir, "studio.sqlite");
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/** List recent sessions from the local ADHD studio SQLite store. */
export function listAdhdSessions({ dataDir = adhdDataDir(), limit = 20 } = {}) {
  const db = openAdhdReadOnly(dataDir);
  if (!db) return { available: false, dataDir, sessions: [] };
  try {
    const rows = db
      .prepare(`
        SELECT w.id, w.request_id, w.goal, w.created_at,
               r.state, r.config, r.detail,
               e.source_head, e.revision_head, e.path AS doc_path, e.updated_at AS export_at,
               (SELECT COUNT(*) FROM sources s WHERE s.session_id = w.id) AS source_count,
               (SELECT COUNT(*) FROM revisions rv WHERE rv.session_id = w.id) AS revision_count
        FROM workspaces w
        LEFT JOIN runs r ON r.session_id = w.id
        LEFT JOIN exports e ON e.session_id = w.id
        ORDER BY w.created_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(50, limit)));

    const sessions = rows.map((row) => {
      let config = {};
      try {
        config = row.config ? JSON.parse(row.config) : {};
      } catch {}
      const thinkers = Array.isArray(config.thinkers) ? config.thinkers : [];
      const docPath = row.doc_path || path.join(dataDir, row.id, "research.md");
      return {
        id: row.id,
        requestId: row.request_id,
        goal: row.goal,
        state: row.state || "ready",
        createdAt: row.created_at,
        sourceCount: row.source_count || 0,
        revisionCount: row.revision_count || 0,
        thinkers: thinkers.map((t) => `${t.backend || "?"}/${t.modelId || "?"} (${t.reasoning || "default"})`),
        tracker: config.tracker ? `${config.tracker.backend}/${config.tracker.modelId} (${config.tracker.reasoning})` : "default",
        documentPath: existsSync(docPath) ? docPath.replaceAll("\\", "/") : null,
      };
    });
    return { available: true, dataDir, sessions };
  } finally {
    db.close();
  }
}

/** Read the latest tracker synthesis, open feedback questions, and tail of research.md for one session. */
export function readAdhdSessionDetail(sessionId, { dataDir = adhdDataDir() } = {}) {
  const db = openAdhdReadOnly(dataDir);
  if (!db) return null;
  try {
    const w = db.prepare("SELECT * FROM workspaces WHERE id=?").get(sessionId);
    if (!w) return null;
    const rev = db.prepare("SELECT * FROM revisions WHERE session_id=? ORDER BY sequence DESC LIMIT 1").get(sessionId);
    const evCount = db.prepare("SELECT COUNT(*) n FROM evidence WHERE session_id=?").get(sessionId)?.n || 0;
    const srcCount = db.prepare("SELECT COUNT(*) n FROM sources WHERE session_id=?").get(sessionId)?.n || 0;
    const docPath = path.join(dataDir, sessionId, "research.md");
    let feedback = null;
    try {
      feedback = rev?.feedback ? JSON.parse(rev.feedback) : null;
    } catch {}
    let markdownExcerpt = "";
    if (existsSync(docPath)) {
      const full = readFileSync(docPath, "utf8");
      markdownExcerpt = full.slice(0, 6000);
    } else if (rev?.markdown) {
      markdownExcerpt = rev.markdown;
    }
    return {
      id: w.id,
      goal: w.goal,
      sourceCount: srcCount,
      evidenceCount: evCount,
      latestRevision: rev ? { sequence: rev.sequence, throughSource: rev.through_source, markdown: rev.markdown } : null,
      openQuestions: (feedback?.questions || []).filter((q) => q.status === "open"),
      documentPath: existsSync(docPath) ? docPath.replaceAll("\\", "/") : null,
      markdownExcerpt,
    };
  } finally {
    db.close();
  }
}

/** Build a structured observed evidence packet ready to post to `goal_loop_evidence`. */
export function buildEscalationPacket(mission, { laneId = null, gateId = null, note = "" } = {}) {
  const lane = laneId ? mission.lanes.find((l) => l.id === laneId) : null;
  const gate = gateId ? mission.gates.find((g) => g.id === gateId) : null;

  const lines = [
    `Overdrive Execution Escalation for Mission "${mission.title}" (\`${mission.id}\`)`,
    `- **Freeze Commit**: \`${mission.freezeCommit || "unfrozen"}\``,
    `- **Routing Mode**: \`${mission.routingMode}\``,
  ];

  if (lane) {
    lines.push(
      `- **Failed Lane**: \`${lane.id}\` (${lane.title}) · status=\`${lane.status}\` · scopeOk=${lane.scopeOk}`,
      `- **Owned Globs**: ${lane.ownedGlobs.join(", ")}`,
      `- **Verify Cmd**: \`${lane.verifyCmd}\``,
    );
    if (lane.lastVerify) {
      lines.push(
        `- **Violation / Exit**: ${lane.lastVerify.violation || `exit=${lane.lastVerify.exitCode}`}`,
        `- **Out-of-Scope Files**: ${(lane.lastVerify.outOfScopeFiles || []).join(", ") || "none"}`,
        `- **Tampered Contracts**: ${(lane.lastVerify.tamperedContracts || []).map((c) => c.path).join(", ") || "none"}`,
        "",
        "### Verification Output Tail",
        "```text",
        (lane.lastVerify.stderrTail || lane.lastVerify.stdoutTail || "(no output)").slice(-2500),
        "```",
      );
    }
  }

  if (gate) {
    lines.push(
      `- **Failed Gate**: \`${gate.id}\` (${gate.title}) · cmd=\`${gate.cmd}\``,
      `- **Exit / Machine**: exit=${gate.lastRun?.exitCode ?? "?"} · machine=${gate.lastRun?.machine ?? "?"}`,
      "",
      "### Gate Output Tail",
      "```text",
      (gate.lastRun?.stderrTail || gate.lastRun?.stdoutTail || "(no output)").slice(-2500),
      "```",
    );
  }

  if (note) {
    lines.push("", "### Coordinator Diagnosis / Request", note);
  }

  lines.push(
    "",
    "Please diagnose why the frozen contract or partition failed and propose exact minimal contract/topology updates (`sharedContracts`, `lanes`, `gates`) for the next wave.",
  );

  const suffix = gateId ? `gate-${gateId}` : laneId ? `lane-${laneId}` : "mission";
  return {
    requestId: `overdrive-esc-${mission.slug}-${suffix}-${Date.now()}`,
    text: lines.join("\n"),
    provenance: `overdrive.verify/gate @ ${mission.repoRoot}`,
    sourceRevision: mission.freezeCommit || "HEAD",
    observedAt: new Date().toISOString(),
    status: "observed",
  };
}

/** Post escalation packet to a running ADHD loopback HTTP server if adhdOrigin is supplied. */
export async function submitToAdhdLoopback(adhdOrigin, sessionId, packet) {
  const u = new URL(adhdOrigin);
  const host = String(u.hostname || "").toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !isLoopback) {
    throw new Error(`adhdOrigin must be an http(s) loopback URL (127.0.0.1, localhost, or ::1); got "${adhdOrigin}".`);
  }
  const headers = { Host: u.host, Origin: u.origin, "Content-Type": "application/json" };
  const stRes = await fetch(`${u.origin}/api/tools`, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({ name: "session_status", arguments: { sessionId } }),
  });
  const st = await stRes.json();
  if (!stRes.ok) throw new Error(`ADHD session_status error: ${JSON.stringify(st)}`);

  const evRes = await fetch(`${u.origin}/api/runtime/evidence`, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({
      sessionId,
      evidence: {
        ...packet,
        expectedInputRevision: st.inputRevision,
      },
    }),
  });
  const posted = await evRes.json();
  if (!evRes.ok) throw new Error(`ADHD evidence post failed: ${JSON.stringify(posted)}`);
  return posted;
}

const POD_LENSES = [
  "contracts-and-schemas",
  "concurrency-and-state-machines",
  "failure-modes-and-security",
  "performance-and-cloud-offload",
  "testing-ratchets-and-verification",
  "ergonomics-migration-and-compat",
  "data-integrity-and-replay",
  "adversarial-red-team",
];

const SUB_LENSES = [
  "invariants",
  "interfaces",
  "edge-cases",
  "failure-recovery",
  "performance",
  "attacker-merger",
];

function buildThinkerCatalog(fleet, activeHarness) {
  const h = fleet?.harnesses || {};
  const normHarness = String(activeHarness || "antigravity").toLowerCase();
  const canAgy =
    (normHarness === "antigravity" || normHarness === "agy") &&
    (h.antigravity ? Boolean(h.antigravity.installed) : true);
  const hasAnyFlag = Object.keys(h).length > 0;
  const isOn = (id, fallback = true) => (hasAnyFlag && h[id] ? Boolean(h[id].installed) : fallback);

  const pool = [];
  if (isOn("devin", true)) {
    pool.push({
      backend: "devin",
      harness: "devin",
      modelId: "swe-2-flash",
      speedId: "standard",
      reasoning: "default",
      family: "devin",
      costTier: "free",
    });
  }
  if (isOn("codex", true)) {
    pool.push({
      backend: "codex",
      harness: "codex",
      modelId: "gpt-6.1-terra",
      speedId: "priority",
      reasoning: "max",
      family: "openai",
      costTier: "included",
    });
  }
  if (isOn("claude", true)) {
    pool.push({
      backend: "claude",
      harness: "claude",
      modelId: "claude-opus-5-5",
      speedId: "standard",
      reasoning: "high",
      family: "anthropic",
      costTier: "included",
    });
  }
  if (canAgy) {
    pool.push({
      backend: "antigravity",
      harness: "antigravity",
      modelId: "gemini-4-carbon",
      speedId: "standard",
      reasoning: "high",
      family: "google",
      costTier: "included",
    });
  }

  if (pool.length === 0) {
    const fb =
      normHarness === "claude"
        ? { backend: "claude", harness: "claude", modelId: "claude-opus-5-5", speedId: "standard", reasoning: "high", family: "anthropic", costTier: "included" }
        : normHarness === "codex"
          ? { backend: "codex", harness: "codex", modelId: "gpt-6.1-terra", speedId: "priority", reasoning: "max", family: "openai", costTier: "included" }
          : normHarness === "devin"
            ? { backend: "devin", harness: "devin", modelId: "swe-2-flash", speedId: "standard", reasoning: "default", family: "devin", costTier: "free" }
            : { backend: "antigravity", harness: "antigravity", modelId: "gemini-4-carbon", speedId: "standard", reasoning: "high", family: "google", costTier: "included" };
    pool.push(fb);
  }

  for (const t of pool) {
    assertModelPolicy({ harness: t.harness, model: t.modelId }, normHarness);
  }
  return pool;
}

function pickFastTracker(fleet, activeHarness, podIdx = 0) {
  const h = fleet?.harnesses || {};
  const normHarness = String(activeHarness || "antigravity").toLowerCase();
  const hasAnyFlag = Object.keys(h).length > 0;
  const isOn = (id, fallback = true) => (hasAnyFlag && h[id] ? Boolean(h[id].installed) : fallback);
  const canAgy =
    (normHarness === "antigravity" || normHarness === "agy") &&
    (h.antigravity ? Boolean(h.antigravity.installed) : true);

  const trackers = [];
  if (isOn("claude", true)) {
    trackers.push({ backend: "claude", harness: "claude", modelId: "claude-sonnet-5-5", speedId: "standard", reasoning: "medium", family: "anthropic" });
  }
  if (isOn("codex", true)) {
    trackers.push({ backend: "codex", harness: "codex", modelId: "gpt-6.1-sol", speedId: "priority", reasoning: "medium", family: "openai" });
  }
  if (canAgy) {
    trackers.push({ backend: "antigravity", harness: "antigravity", modelId: "gemini-4-hydrogen", speedId: "standard", reasoning: "medium", family: "google" });
  }
  if (isOn("devin", true)) {
    trackers.push({ backend: "devin", harness: "devin", modelId: "swe-2-flash", speedId: "standard", reasoning: "default", family: "devin" });
  }

  const chosen = trackers.length > 0
    ? trackers[podIdx % trackers.length]
    : { backend: normHarness, harness: normHarness, modelId: "default", speedId: "standard", reasoning: "medium", family: modelFamilyOf({ harness: normHarness }) };
  assertModelPolicy({ harness: chosen.harness, model: chosen.modelId }, normHarness);
  return { ...chosen, dedicatedPodIdx: podIdx + 1 };
}

function partitionPodSizes(totalThinkers, podSize) {
  if (totalThinkers <= 5) return [totalThinkers];
  if (totalThinkers === 6) return [6];
  if (totalThinkers === 7) return [4, 3];
  const preferred = Math.min(6, Math.max(4, Math.round(podSize || 5)));
  const minPods = Math.ceil(totalThinkers / 6);
  const maxPods = Math.floor(totalThinkers / 4);
  const podCount = Math.max(minPods, Math.min(maxPods, Math.ceil(totalThinkers / preferred)));
  const base = Math.floor(totalThinkers / podCount);
  const rem = totalThinkers % podCount;
  return Array.from({ length: podCount }, (_, i) => (i < rem ? base + 1 : base));
}

function computeBackendConcurrency(thinkers) {
  const counts = {};
  for (const t of thinkers) {
    counts[t.backend] = Math.min(4, (counts[t.backend] || 0) + 1);
  }
  return counts;
}

/**
 * Plan a 1-40 thinker ADHD tournament:
 * - <= 5 thinkers: single bounded pod.
 * - >= 6 thinkers: Pass 1 pods of 4..6 thinkers each with a dedicated fast tracker + disjoint lens,
 *   plus a Pass 2 4-judge cross-family Apex tournament seeded from Pass 1 `research.md` outputs.
 */
export function planPodTournament({
  goal = "Architecture & Swarm Topology Design",
  contextSummary = "",
  totalThinkers = 12,
  podSize = 5,
  fleet = null,
  activeHarness = "antigravity",
} = {}) {
  if (!Number.isInteger(totalThinkers) || totalThinkers < 1 || totalThinkers > 40) {
    throw new Error(`totalThinkers must be an integer within [1, 40]; got ${String(totalThinkers)}.`);
  }

  const resolvedFleet = fleet || detectFleet();
  const catalog = buildThinkerCatalog(resolvedFleet, activeHarness);
  const sizes = partitionPodSizes(totalThinkers, podSize);

  let thinkerOffset = 0;
  const pass1Pods = sizes.map((count, podIdx) => {
    const podId = `pod-${podIdx + 1}`;
    const podFocus = POD_LENSES[podIdx % POD_LENSES.length];
    const thinkers = [];
    for (let i = 0; i < count; i++) {
      const base = catalog[(thinkerOffset + i) % catalog.length];
      const subLens = i === count - 1 && count >= 3 ? "attacker-merger" : SUB_LENSES[i % (SUB_LENSES.length - 1)];
      thinkers.push({
        backend: base.backend,
        modelId: base.modelId,
        speedId: base.speedId,
        reasoning: base.reasoning,
        family: base.family,
        costTier: base.costTier,
        focus: `${podFocus}:${subLens}`,
      });
    }
    thinkerOffset += count;

    const tracker = pickFastTracker(resolvedFleet, activeHarness, podIdx);
    const backendConcurrency = computeBackendConcurrency(thinkers);
    return {
      podId,
      focus: podFocus,
      thinkerCount: count,
      outputPath: `${podId}/research.md`,
      configuration: {
        thinkers,
        tracker,
        maxConcurrentThinkers: Math.min(count, 6),
        backendConcurrency,
        maxRounds: totalThinkers <= 5 ? 4 : 3,
        maxMinutes: 30,
      },
    };
  });

  if (totalThinkers <= 5) {
    return {
      mode: "single-pod",
      goal,
      contextSummary,
      totalThinkers,
      podCount: 1,
      pass1Pods,
      pass2Apex: null,
    };
  }

  // Build 4 cross-family Apex judges (ordering distinct families first, then strong variants).
  const normHarness = String(activeHarness || "antigravity").toLowerCase();
  const canAgy =
    (normHarness === "antigravity" || normHarness === "agy") &&
    (resolvedFleet?.harnesses?.antigravity ? Boolean(resolvedFleet.harnesses.antigravity.installed) : true);
  const apexPool = [];
  if (canAgy) {
    apexPool.push({ backend: "antigravity", modelId: "gemini-4-carbon", speedId: "standard", reasoning: "high", family: "google" });
  }
  if (!resolvedFleet?.harnesses?.claude || resolvedFleet.harnesses.claude.installed) {
    apexPool.push({ backend: "claude", modelId: "claude-opus-5-5", speedId: "standard", reasoning: "high", family: "anthropic" });
  }
  if (!resolvedFleet?.harnesses?.codex || resolvedFleet.harnesses.codex.installed) {
    apexPool.push({ backend: "codex", modelId: "gpt-6-astra", speedId: "priority", reasoning: "high", family: "openai" });
  }
  if (!resolvedFleet?.harnesses?.devin || resolvedFleet.harnesses.devin.installed) {
    apexPool.push({ backend: "devin", modelId: "swe-2", speedId: "standard", reasoning: "default", family: "devin" });
  }
  if (apexPool.length === 0) {
    if (normHarness === "antigravity" || normHarness === "agy") {
      apexPool.push({ backend: "antigravity", modelId: "gemini-4-carbon", speedId: "standard", reasoning: "high", family: "google" });
    }
    apexPool.push(
      { backend: "claude", modelId: "claude-opus-5-5", speedId: "standard", reasoning: "high", family: "anthropic" },
      { backend: "codex", modelId: "gpt-6-astra", speedId: "priority", reasoning: "high", family: "openai" },
      { backend: "devin", modelId: "swe-2", speedId: "standard", reasoning: "default", family: "devin" },
    );
  }
  const baseSource = apexPool.length > 0 ? apexPool : catalog;

  const apexRoles = [
    "apex-cross-examiner-contracts",
    "apex-adversarial-concurrency-audit",
    "apex-offload-ratchet-verifier",
    "apex-topology-consolidator",
  ];
  const apexJudges = Array.from({ length: 4 }, (_, i) => {
    const picked = baseSource[i % baseSource.length];
    assertModelPolicy({ harness: picked.backend, model: picked.modelId }, normHarness);
    return {
      backend: picked.backend,
      modelId: picked.modelId,
      speedId: picked.speedId,
      reasoning: picked.reasoning,
      family: picked.family,
      focus: apexRoles[i],
    };
  });

  const podResearchFiles = pass1Pods.map((p) => p.outputPath);
  const pass2Apex = {
    podId: "apex",
    judgeCount: 4,
    seedMode: "contextFile",
    contextFile: podResearchFiles[0],
    contextFiles: podResearchFiles,
    task: "Cross-examine all Pass 1 pod research.md artifacts, resolve contradictions, and emit one Swarm-Ready Topology.",
    requiredOutputKeys: ["sharedContracts", "lanes", "ownedRegions", "gates", "ratchet"],
    outputSchema: {
      sharedContracts: "Frozen concrete file paths to lock SHA-256 at HEAD before swarm execution.",
      lanes: "Disjoint worker lanes with { id, title, complexity, ownedGlobs, verifyCmd, offload }.",
      ownedRegions: "Optional exclusive anchor ranges for shared monolith edits.",
      gates: "End-to-end verification commands with offload settings.",
      ratchet: "Numeric baseline/target metric gates with holdout separation.",
    },
    configuration: {
      thinkers: apexJudges,
      tracker: pickFastTracker(resolvedFleet, activeHarness, pass1Pods.length),
      maxConcurrentThinkers: 4,
      backendConcurrency: computeBackendConcurrency(apexJudges),
      maxRounds: 2,
      maxMinutes: 25,
    },
  };

  return {
    mode: "two-pass-tournament",
    goal,
    contextSummary,
    totalThinkers,
    podCount: pass1Pods.length,
    pass1Pods,
    pass2Apex,
  };
}
