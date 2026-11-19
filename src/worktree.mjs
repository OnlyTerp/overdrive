import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { runWithCompute } from "./compute.mjs";
import { auditContracts, classifyOwnership, collectLaneDiff, parseNameStatusZ } from "./diff.mjs";
import { fileMatchesAnyGlob, fileMatchesGlob, normalizeRelPattern } from "./partition.mjs";
import { evaluateRatchet, stripPrivateRatchetFields, toPublicRatchetSpec } from "./ratchet.mjs";
import { verifyLaneRegionContainment } from "./seam.mjs";
import { sha256File } from "./store.mjs";
import { defaultScratchBase, defaultWorktreeRoot as resolveDefaultWorktreeRoot } from "./paths.mjs";
import { SCHEMA_VERSION } from "./ui-contracts.mjs";

export const DEFAULT_IGNORE_UNTRACKED_GLOBS = Object.freeze([
  "*.log",
  "*.pdb",
  "*.obj",
  "*.pyc",
  "**/__pycache__/**",
  ".pytest_cache/**",
  ".fleet/**",
]);

export function assertMutableRealMission(mission) {
  if (mission?.isShowcase || mission?.fixtureVersion || mission?.slug === "showcase-v02") {
    const err = new Error("Sample showcase builds are read-only previews; create a real build to run commands or manage workspace copies.");
    err.status = 400;
    throw err;
  }
}

export function worktreeRootBase() {
  return resolveDefaultWorktreeRoot();
}

function repoFolderName(repoRoot) {
  return path.basename(path.resolve(repoRoot)).replace(/[^A-Za-z0-9_.-]/g, "_") || "repo";
}

function safeScratchSegment(raw, fallback = "lane") {
  return String(raw || fallback).replace(/[^A-Za-z0-9_.-]/g, "_") || fallback;
}

function laneScratchPaths(missionSlug, laneId) {
  const root = path.join(defaultScratchBase(), "lanes");
  const baseDir = path.join(root, safeScratchSegment(missionSlug, "mission"), safeScratchSegment(laneId, "lane"));
  const tmpDir = path.join(baseDir, "tmp");
  const artifactsDir = path.join(baseDir, "artifacts");
  return {
    TEMP: tmpDir.replaceAll("\\", "/"),
    TMP: tmpDir.replaceAll("\\", "/"),
    TMPDIR: tmpDir.replaceAll("\\", "/"),
    OVERDRIVE_SCRATCH_DIR: baseDir.replaceAll("\\", "/"),
    ANTIGRAVITY_ARTIFACTS_DIR: artifactsDir.replaceAll("\\", "/"),
  };
}

/**
 * Create and return isolated per-lane scratch/temp environment variables under the configured scratch dir.
 * Prevents child builds/tests from polluting user TEMP or project trees.
 */
export function laneScratchEnv(missionSlug, laneId) {
  const env = laneScratchPaths(missionSlug, laneId);
  mkdirSync(env.OVERDRIVE_SCRATCH_DIR, { recursive: true });
  mkdirSync(env.TEMP, { recursive: true });
  mkdirSync(env.ANTIGRAVITY_ARTIFACTS_DIR, { recursive: true });
  return env;
}

/**
 * Safely unmount a directory junction / symlink without EVER touching target contents.
 * Uses lstatSync(p).isSymbolicLink(), checks realpathSync(p) !== path.resolve(p),
 * and removes ONLY via non-recursive rmdirSync(p).
 */
export function unmountJunctionSafe(junctionPath) {
  const resolved = path.resolve(junctionPath);
  let st;
  try {
    st = lstatSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") return { unmounted: false, path: resolved.replaceAll("\\", "/"), reason: "missing" };
    throw err;
  }

  if (!st.isSymbolicLink()) {
    const err = new Error(
      `REFUSE_NON_JUNCTION: "${resolved}" is not a symbolic link or junction; refusing to remove real directory.`,
    );
    err.code = "REFUSE_NON_JUNCTION";
    throw err;
  }

  try {
    const real = realpathSync(resolved);
    if (real === resolved) {
      const err = new Error(`REFUSE_SELF_PATH: "${resolved}" realpath equals resolved path.`);
      err.code = "REFUSE_SELF_PATH";
      throw err;
    }
  } catch (err) {
    // Dangling junction whose target directory was already deleted still has lstat.isSymbolicLink() === true.
    if (err?.code !== "ENOENT") throw err;
  }

  rmdirSync(resolved);
  return { unmounted: true, path: resolved.replaceAll("\\", "/") };
}

/** Mount read-only directory junctions inside a worktree. */
export function mountReadOnlyJunctions(wtPath, mounts = []) {
  const wtAbs = path.resolve(wtPath);
  const mounted = [];
  for (const m of mounts || []) {
    if (!m || typeof m !== "object" || !m.source || !m.target) continue;
    const relTarget = normalizeRelPattern(m.target);
    const linkAbs = path.resolve(wtAbs, relTarget);
    if (linkAbs !== wtAbs && !linkAbs.startsWith(wtAbs + path.sep)) {
      throw new Error(`readOnlyMounts target "${m.target}" escapes worktree.`);
    }
    const srcAbs = path.resolve(m.source);
    if (!existsSync(srcAbs) || !statSync(srcAbs).isDirectory()) {
      throw new Error(`readOnlyMounts source directory does not exist: "${srcAbs}"`);
    }
    mkdirSync(path.dirname(linkAbs), { recursive: true });
    let existing = null;
    try {
      existing = lstatSync(linkAbs);
    } catch {}
    if (existing) {
      if (existing.isSymbolicLink()) {
        try {
          if (realpathSync(linkAbs) === realpathSync(srcAbs)) {
            mounted.push({ source: srcAbs.replaceAll("\\", "/"), target: relTarget, linkPath: linkAbs.replaceAll("\\", "/") });
            continue;
          }
        } catch {}
        unmountJunctionSafe(linkAbs);
      } else {
        throw new Error(`readOnlyMounts target already exists as a real filesystem entry: "${linkAbs}"`);
      }
    }
    symlinkSync(srcAbs, linkAbs, process.platform === "win32" ? "junction" : "dir");
    mounted.push({ source: srcAbs.replaceAll("\\", "/"), target: relTarget, linkPath: linkAbs.replaceAll("\\", "/") });
  }
  return mounted;
}

/** Walk a worktree directory (never following symlinks) and unmount all junctions safely. */
export function unmountAllJunctions(rootDir, mounts = []) {
  const unmounted = [];
  if (!rootDir) return unmounted;
  const rootAbs = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = lstatSync(rootAbs);
  } catch (err) {
    if (err?.code === "ENOENT") return unmounted;
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    const res = unmountJunctionSafe(rootAbs);
    if (res.unmounted) unmounted.push(res.path);
    return unmounted;
  }

  for (const m of mounts || []) {
    if (!m?.target) continue;
    try {
      const linkAbs = path.resolve(rootAbs, normalizeRelPattern(m.target));
      if (linkAbs.startsWith(rootAbs + path.sep)) {
        const res = unmountJunctionSafe(linkAbs);
        if (res.unmounted) unmounted.push(res.path);
      }
    } catch {}
  }

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const res = unmountJunctionSafe(full);
        if (res.unmounted) unmounted.push(res.path);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };

  walk(rootAbs);
  return unmounted;
}

/** Match an untracked repo-relative path against ignore globs (supports basename globs like "*.log"). */
export function isUntrackedIgnored(relPath, ignoreGlobs = []) {
  if (!relPath || !Array.isArray(ignoreGlobs) || ignoreGlobs.length === 0) return false;
  let norm;
  try {
    norm = normalizeRelPattern(relPath);
  } catch {
    return false;
  }
  for (const rawGlob of ignoreGlobs) {
    if (!rawGlob || typeof rawGlob !== "string") continue;
    try {
      const g = normalizeRelPattern(rawGlob);
      if (fileMatchesGlob(norm, g)) return true;
      if (!g.includes("/") && fileMatchesGlob(norm, `**/${g}`)) return true;
    } catch {}
  }
  return false;
}

function isDeclaredMountedJunction(targetDir, relPath, mounts = []) {
  if (!Array.isArray(mounts) || mounts.length === 0) return false;
  let norm;
  try {
    norm = normalizeRelPattern(relPath);
  } catch {
    return false;
  }
  for (const m of mounts) {
    if (!m?.target || !m?.source) continue;
    try {
      const mTarget = normalizeRelPattern(m.target);
      if (norm !== mTarget && !norm.startsWith(mTarget + "/")) continue;
      const linkAbs = path.resolve(targetDir, mTarget);
      const lst = lstatSync(linkAbs);
      if (!lst.isSymbolicLink()) continue;
      if (realpathSync(linkAbs) === realpathSync(path.resolve(m.source))) return true;
    } catch {}
  }
  return false;
}

function tryGit(cwd, args) {
  if (!cwd || !existsSync(cwd)) return null;
  const r = spawnSync("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout : null;
}

function parseDirtyPorcelain(raw, lane, contracts) {
  if (!raw) return [];
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop().trim() : rawPath;
    const normPath = filePath.replace(/^"|"$/g, "").replaceAll("\\", "/");
    const cls = classifyOwnership(normPath, null, lane, contracts);
    const trimmed = code.trim();
    const status =
      trimmed === "??"
        ? "untracked"
        : trimmed.includes("D")
          ? "deleted"
          : trimmed.includes("A")
            ? "added"
            : trimmed.includes("R")
              ? "renamed"
              : "modified";
    entries.push({ code: trimmed || "M", status, path: normPath, ownership: cls.ownership });
  }
  return entries;
}

function parseGitLog(raw) {
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, shortSha, subject, author, ts] = line.split("\x1f");
    if (sha) {
      out.push({
        sha: sha.trim(),
        shortSha: (shortSha || sha.slice(0, 7)).trim(),
        subject: (subject || "").trim(),
        author: (author || "").trim(),
        ts: (ts || "").trim(),
      });
    }
  }
  return out;
}

/** Build a self-contained worker brief for an isolated lane (strictly stripping private ratchet fields). */
export function buildLaneBrief(mission, lane) {
  const contractLines = mission.contracts?.length
    ? mission.contracts.map((c) => `- \`${c.path}\` (sha256: \`${c.sha256}\`)${c.description ? ` — ${c.description}` : ""}`).join("\n")
    : "- (none)";
  const verifyHint =
    lane.verifier?.effectiveOffload?.startsWith("aipc")
      ? `Heavy verification may offload via \`${lane.verifier.effectiveOffload} -- '${lane.verifyCmd}'\`.`
      : `Verify locally with: \`${lane.verifyCmd}\`.`;
  const ownedGlobsText =
    Array.isArray(lane.ownedGlobs) && lane.ownedGlobs.length > 0
      ? lane.ownedGlobs.map((g) => `- \`${g}\``).join("\n")
      : "- (none — edit only declared `ownedRegions` below)";
  const scratchPaths = laneScratchPaths(mission.slug || mission.id || "mission", lane.id);

  const sections = [
    `## Overdrive Worker Brief — Lane \`${lane.id}\` (${lane.title})`,
    `- **Mission**: ${mission.title} (\`${mission.slug}\`)`,
    `- **Goal**: ${mission.goal}`,
    `- **Worktree**: \`${lane.worktreePath || mission.repoRoot}\` (branch \`${lane.branchName || "HEAD"}\` anchored at \`${mission.freezeCommit}\`)`,
    `- **Assigned Route**: harness=\`${lane.worker?.harness || "unassigned"}\`, model=\`${lane.worker?.model || "default"}\`, effort=\`${lane.worker?.effort || "default"}\``,
    `- **Isolated Scratch Workspace**: \`${scratchPaths.OVERDRIVE_SCRATCH_DIR}\` (\`TEMP\`/\`TMP\`/\`TMPDIR\` isolated per lane)`,
    "",
    "### Strict File Ownership (HARD BOUNDARY)",
    `You may ONLY create/edit files matching:\n${ownedGlobsText}`,
  ];

  if (Array.isArray(lane.ownedRegions) && lane.ownedRegions.length > 0) {
    sections.push(
      "",
      "### Exclusive File Regions (`ownedRegions` — EDIT ONLY BETWEEN ANCHORS)",
      "Keep start/end anchor lines unique (exact count 1) and leave every line outside `(startAnchor, endAnchor)` line-for-line identical to base:",
      ...lane.ownedRegions.map(
        (r) =>
          `- \`${r.path}\`: strictly between \`${r.startAnchor}\` and \`${r.endAnchor}\` (boundaryMode=\`${r.boundaryMode || "exclusive"}\`)`,
      ),
    );
  }

  sections.push(
    "",
    "### Frozen Shared Contracts (READ-ONLY — DO NOT MODIFY)",
    contractLines,
  );

  if (lane.ratchet && typeof lane.ratchet === "object") {
    const publicRatchet = stripPrivateRatchetFields(lane.ratchet);
    sections.push(
      "",
      "### Metric Ratchet Contract (Public)",
      "```json",
      JSON.stringify(publicRatchet, null, 2),
      "```",
    );
  }

  sections.push(
    "",
    "### Task",
    lane.brief || lane.title,
    "",
    "### Verification Requirement (Done Means Checked)",
    verifyHint,
    "When finished, report: changed files, exact verification command + exit status, and any boundary risks.",
  );

  return sections.join("\n");
}

/** Provision isolated git worktrees at <worktreeRoot>/<repo>/<slug>-<laneId> from frozen HEAD commit. */
export function provisionWorktrees(store, missionId) {
  const m = store.requireMission(missionId);
  assertMutableRealMission(m);
  if (!["frozen", "swarming"].includes(m.state)) {
    throw new Error(`Contracts must be frozen before provisioning worktrees (state is "${m.state}").`);
  }
  const baseDir = path.join(worktreeRootBase(), repoFolderName(m.repoRoot));
  mkdirSync(baseDir, { recursive: true });

  for (const lane of m.lanes) {
    const wtPath = path.join(baseDir, `${m.slug}-${lane.id}`).replaceAll("\\", "/");
    const branch = `overdrive/${m.slug}/${lane.id}`;
    if (!existsSync(wtPath)) {
      const r = spawnSync("git", ["-C", m.repoRoot, "worktree", "add", "-B", branch, wtPath, m.freezeCommit], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        throw new Error(`git worktree add failed for lane "${lane.id}": ${(r.stderr || r.stdout || "").trim()}`);
      }
      spawnSync("git", ["-C", wtPath, "config", "core.autocrlf", "false"], { shell: false, windowsHide: true });
    }
    if (Array.isArray(lane.readOnlyMounts) && lane.readOnlyMounts.length > 0) {
      mountReadOnlyJunctions(wtPath, lane.readOnlyMounts);
    }
    store.setLaneWorktree(m.id, lane.id, {
      worktreePath: wtPath,
      branchName: branch,
      status: lane.status === "verified" ? "verified" : "active",
      headSha: m.freezeCommit,
    });
  }

  store.setMissionState(m.id, "swarming", { worktrees: m.lanes.length });
  const updated = store.getMission(m.id);
  return {
    mission: updated,
    briefs: Object.fromEntries(updated.lanes.map((l) => [l.id, buildLaneBrief(updated, l)])),
  };
}

/**
 * Read-only inspection of a lane's worktree (or git branch / receipt / synthetic state).
 * Never creates directories, mutates git state, or runs commands.
 */
export function inspectLaneWorktree(store, missionId, laneId, { receiptId = null } = {}) {
  const mission = store.requireMission(missionId);
  const lane = mission.lanes.find((l) => l.id === laneId);
  if (!lane) {
    const err = new Error(`Unknown lane "${laneId}" in mission "${mission.id}".`);
    err.status = 404;
    throw err;
  }

  const receipt = receiptId ? store.getReceipt(mission.id, receiptId) : null;
  if (receiptId && (!receipt || receipt.laneId !== lane.id)) {
    const err = new Error(`Unknown receipt "${receiptId}" for lane "${lane.id}".`);
    err.status = 404;
    throw err;
  }

  const wtExists = Boolean(lane.worktreePath && existsSync(lane.worktreePath));
  const synthetic = Boolean(lane.syntheticDiff || mission.isShowcase);
  const branch = lane.branchName || lane.branch || null;
  let headSha = lane.headSha || receipt?.headSha || null;
  let dirtyFiles = [];
  let recentCommits = [];
  let contracts = [];
  let source = "unprovisioned";

  if (receipt?.inspection) {
    return {
      ...receipt.inspection,
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      missionId: mission.id,
      laneId: lane.id,
      source: "receipt",
      receiptId: receipt.id,
      exists: wtExists,
    };
  }

  if (wtExists) {
    source = receipt ? "receipt" : "worktree";
    headSha = tryGit(lane.worktreePath, ["rev-parse", "HEAD"])?.trim() || headSha;
    const statusRaw = tryGit(lane.worktreePath, ["status", "--porcelain"]);
    dirtyFiles = parseDirtyPorcelain(statusRaw, lane, mission.contracts);
    const logRaw = tryGit(lane.worktreePath, ["log", "-n", "8", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"]);
    recentCommits = parseGitLog(logRaw);
    contracts = auditContracts(mission, lane.worktreePath);
  } else {
    const branchSha =
      branch && mission.repoRoot && existsSync(mission.repoRoot)
        ? tryGit(mission.repoRoot, ["rev-parse", "--verify", branch])?.trim() || null
        : null;
    if (branchSha) {
      source = receipt ? "receipt" : "git";
      headSha = branchSha;
      const logRaw = tryGit(mission.repoRoot, ["log", "-n", "8", branch, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"]);
      recentCommits = parseGitLog(logRaw);
      contracts = auditContracts(mission, null, { branchRef: branch });
    } else if (synthetic) {
      source = receipt ? "receipt" : "synthetic";
      headSha = receipt?.headSha || lane.syntheticDiff?.headSha || headSha || mission.freezeCommit || null;
      dirtyFiles = Array.isArray(lane.syntheticDiff?.dirtyFiles) ? lane.syntheticDiff.dirtyFiles : [];
      recentCommits = Array.isArray(lane.syntheticDiff?.recentCommits) ? lane.syntheticDiff.recentCommits : [];
      contracts = auditContracts(mission, null, {
        syntheticContracts: receipt?.contracts?.length ? receipt.contracts : lane.syntheticDiff?.contracts || null,
      });
    } else {
      source = receipt ? "receipt" : "unprovisioned";
      contracts = auditContracts(mission, null, {
        syntheticContracts: receipt?.contracts?.length ? receipt.contracts : null,
      });
    }
  }

  const effectiveScopeOk =
    receipt
      ? receipt.scopeOk
      : lane.scopeOk !== null && lane.scopeOk !== undefined
        ? Boolean(lane.scopeOk)
        : dirtyFiles.every((f) => f.ownership === "owned") && contracts.every((c) => c.intact);

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    missionId: mission.id,
    laneId: lane.id,
    title: lane.title,
    status: receipt ? receipt.status : lane.status,
    source,
    synthetic,
    receiptId: receipt?.id || lane.lastReceiptId || lane.lastVerify?.receiptId || null,
    branch,
    worktreePath: lane.worktreePath || null,
    exists: wtExists,
    freezeCommit: mission.freezeCommit || null,
    headSha,
    dirtyFiles,
    recentCommits,
    contracts,
    lastVerify: receipt ? receipt.result : lane.lastVerify || null,
    scopeOk: effectiveScopeOk,
    ownedGlobs: lane.ownedGlobs,
    verifyCmd: lane.verifyCmd,
    offload: lane.offload,
    worker: lane.worker,
    verifier: lane.verifier,
    telemetry: receipt?.telemetry || lane.telemetry || {
      model: lane.model || lane.worker?.model || null,
      harness: lane.harness || lane.worker?.harness || null,
      durationMs: lane.durationMs ?? null,
      tokensIn: lane.tokensIn ?? null,
      tokensOut: lane.tokensOut ?? null,
      costUsd: lane.costUsd ?? null,
      filesChanged: lane.filesChanged ?? null,
    },
    brief: buildLaneBrief(mission, lane),
  };
}

/**
 * Inspect changed + untracked files against freezeCommit, enforce contract immutability,
 * ownedGlobs + ownedRegions containment, untracked artifact filtering, verifyCmd via compute.mjs,
 * and fail-closed ratchet evaluation.
 */
export function auditAndVerifyLane(
  store,
  missionId,
  laneId,
  {
    runCmd = true,
    timeoutMs = 120_000,
    useAipc = false,
    offload = undefined,
    ownedRegions = undefined,
    ignoreUntrackedGlobs = undefined,
    readOnlyMounts = undefined,
    ratchet = undefined,
    expectedNonce = null,
    runner = null,
    aipcScript = undefined,
    devinBridge = undefined,
    lockDir = undefined,
  } = {},
) {
  const m = store.requireMission(missionId);
  assertMutableRealMission(m);
  const lane = m.lanes.find((l) => l.id === laneId);
  if (!lane) {
    const err = new Error(`Unknown lane "${laneId}" in mission "${m.id}".`);
    err.status = 404;
    throw err;
  }
  if (!m.freezeCommit) throw new Error(`Mission "${m.id}" has no freezeCommit.`);

  const targetDir = lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : m.repoRoot;
  const effectiveRegions = Array.isArray(ownedRegions) ? ownedRegions : (lane.ownedRegions || []);
  const effectiveMounts = Array.isArray(readOnlyMounts) ? readOnlyMounts : (lane.readOnlyMounts || []);
  const effectiveIgnoreUntracked = [
    ...DEFAULT_IGNORE_UNTRACKED_GLOBS,
    ...(Array.isArray(lane.ignoreUntrackedGlobs) ? lane.ignoreUntrackedGlobs : []),
    ...(Array.isArray(ignoreUntrackedGlobs) ? ignoreUntrackedGlobs : []),
  ];
  const effectiveRatchet = ratchet ?? lane.ratchet ?? null;

  const diffRes = spawnSync("git", ["-C", targetDir, "diff", "--name-status", "-z", "-M", m.freezeCommit], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (diffRes.status !== 0) {
    throw new Error(`git diff failed in "${targetDir}": ${(diffRes.stderr || diffRes.stdout || "").trim()}`);
  }
  const parsedEntries = parseNameStatusZ(diffRes.stdout);

  const untrackedRes = spawnSync("git", ["-C", targetDir, "ls-files", "--others", "--exclude-standard", "-z"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  const rawUntrackedPaths = (untrackedRes.stdout || "")
    .split("\0")
    .map((s) => s.trim().replaceAll("\\", "/"))
    .filter(Boolean);

  const ignoredUntrackedFiles = [];
  const untrackedPaths = [];
  for (const p of rawUntrackedPaths) {
    if (isDeclaredMountedJunction(targetDir, p, effectiveMounts)) {
      ignoredUntrackedFiles.push(p);
      continue;
    }
    if (isUntrackedIgnored(p, effectiveIgnoreUntracked)) {
      ignoredUntrackedFiles.push(p);
      continue;
    }
    untrackedPaths.push(p);
  }

  const changedFiles = Array.from(new Set([...parsedEntries.map((e) => e.path), ...untrackedPaths]));
  const allTouchedPaths = Array.from(
    new Set([
      ...parsedEntries.flatMap((e) => (e.oldPath ? [e.path, e.oldPath] : [e.path])),
      ...untrackedPaths,
    ]),
  );
  const headSha = tryGit(targetDir, ["rev-parse", "HEAD"])?.trim() || m.freezeCommit;

  let diffSnapshot = null;
  try {
    diffSnapshot = collectLaneDiff({ mission: m, lane, targetDir });
  } catch {}

  const dirtySnapshot = parseDirtyPorcelain(tryGit(targetDir, ["status", "--porcelain"]), lane, m.contracts);
  const commitsSnapshot = parseGitLog(tryGit(targetDir, ["log", "-n", "8", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"]));
  const buildInspectionSnapshot = (status, scopeOk, result) => ({
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    missionId: m.id,
    laneId: lane.id,
    title: lane.title,
    status,
    source: "receipt",
    synthetic: false,
    branch: lane.branchName || lane.branch || null,
    worktreePath: lane.worktreePath || null,
    exists: Boolean(lane.worktreePath && existsSync(lane.worktreePath)),
    freezeCommit: m.freezeCommit || null,
    headSha,
    dirtyFiles: dirtySnapshot,
    recentCommits: commitsSnapshot,
    contracts: diffSnapshot?.contracts || [],
    lastVerify: result,
    scopeOk,
    ownedGlobs: lane.ownedGlobs,
    verifyCmd: lane.verifyCmd,
    offload: lane.offload,
    worker: lane.worker,
    verifier: lane.verifier,
    telemetry: {
      model: lane.worker?.model ?? null,
      harness: lane.worker?.harness ?? null,
      headSha,
      durationMs: result.durationMs ?? null,
      filesChanged: changedFiles,
    },
  });

  // 1. Contract tamper check.
  const tamperedContracts = [];
  for (const c of m.contracts) {
    const full = path.join(targetDir, c.path);
    if (!existsSync(full)) {
      tamperedContracts.push({ path: c.path, reason: "missing" });
      continue;
    }
    const curHash = sha256File(full);
    if (curHash !== c.sha256) {
      tamperedContracts.push({ path: c.path, expected: c.sha256, actual: curHash });
    }
  }

  // 2. Scope ownership check: ownedGlobs + ownedRegions containment (including rename source paths).
  const outOfScopeFiles = [];
  const regionViolations = [];
  const trackedByPath = new Map(parsedEntries.map((e) => [e.path, e]));

  for (const touched of allTouchedPaths) {
    if (fileMatchesAnyGlob(touched, lane.ownedGlobs || [])) continue;

    const fileRegions = effectiveRegions.filter((r) => r.path === touched);
    if (fileRegions.length === 0) {
      outOfScopeFiles.push(touched);
      continue;
    }

    const trackedEntry = trackedByPath.get(touched);
    if (trackedEntry && (trackedEntry.status === "deleted" || trackedEntry.status === "renamed" || trackedEntry.oldPath)) {
      outOfScopeFiles.push(touched);
      regionViolations.push({
        path: touched,
        code: "REGION_OUTSIDE_EDIT",
        error: `Cannot delete or rename shared ownedRegions file "${touched}"`,
      });
      continue;
    }

    const baseRes = spawnSync("git", ["-C", targetDir, "show", `${m.freezeCommit}:${touched}`], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    const laneFull = path.join(targetDir, touched);
    if (baseRes.status !== 0 || !existsSync(laneFull)) {
      outOfScopeFiles.push(touched);
      regionViolations.push({
        path: touched,
        code: "ANCHOR_MISSING",
        error: `Missing base or lane file for ownedRegions "${touched}"`,
      });
      continue;
    }

    const laneText = readFileSync(laneFull, "utf8");
    let containment = verifyLaneRegionContainment(baseRes.stdout, laneText, fileRegions);
    if (!containment.ok && !baseRes.stdout.includes("\r\n") && laneText.includes("\r\n")) {
      const normalized = verifyLaneRegionContainment(baseRes.stdout, laneText.replace(/\r\n/g, "\n"), fileRegions);
      if (normalized.ok) containment = normalized;
    }
    if (!containment.ok) {
      outOfScopeFiles.push(touched);
      regionViolations.push({
        path: touched,
        code: containment.code,
        error: containment.error,
      });
    }
  }

  if (tamperedContracts.length > 0 || outOfScopeFiles.length > 0) {
    const violation =
      tamperedContracts.length > 0
        ? `CONTRACT_TAMPERED: ${tamperedContracts.map((t) => t.path).join(", ")}`
        : regionViolations.length > 0
          ? `SCOPE_VIOLATION: ${regionViolations.map((rv) => `${rv.path} (${rv.error})`).join("; ")}`
          : `SCOPE_VIOLATION: ${outOfScopeFiles.join(", ")}`;
    const result = {
      ok: false,
      scopeOk: false,
      violation,
      tamperedContracts,
      outOfScopeFiles,
      ...(regionViolations.length > 0 ? { regionViolations } : {}),
      changedFiles,
      ignoredUntrackedFiles,
      headSha,
      exitCode: null,
      machine: "none",
      ranCommand: false,
    };
    const mission = store.recordLaneVerification(m.id, laneId, {
      status: "failed",
      scopeOk: false,
      result,
      diff: diffSnapshot,
      inspection: buildInspectionSnapshot("failed", false, result),
      contracts: diffSnapshot?.contracts,
      telemetry: { headSha, filesChanged: changedFiles },
    });
    const updatedLane = mission.lanes.find((l) => l.id === laneId);
    return { result: updatedLane?.lastVerify || result, mission };
  }

  // 3. Execute verification command if requested.
  if (!runCmd) {
    const result = {
      ok: true,
      scopeOk: true,
      changedFiles,
      ignoredUntrackedFiles,
      headSha,
      exitCode: 0,
      machine: "audit-only",
      ranCommand: false,
    };
    const mission = store.recordLaneVerification(m.id, laneId, {
      status: "scope_ok",
      scopeOk: true,
      result,
      diff: diffSnapshot,
      inspection: buildInspectionSnapshot("scope_ok", true, result),
      contracts: diffSnapshot?.contracts,
      telemetry: { headSha, filesChanged: changedFiles },
    });
    const updatedLane = mission.lanes.find((l) => l.id === laneId);
    return { result: updatedLane?.lastVerify || result, mission };
  }

  const effectiveOffload =
    offload ?? (useAipc ? (lane.offload === "aipc-gpu" ? "aipc-gpu" : "aipc") : (lane.offload || "auto"));
  const scratchEnv = laneScratchEnv(m.slug || m.id, lane.id);
  const execRes = runWithCompute(lane.verifyCmd, {
    cwd: targetDir,
    offload: effectiveOffload,
    timeoutMs,
    env: scratchEnv,
    runner,
    aipcScript,
    devinBridge,
    lockDir,
  });

  let ratchetResult = null;
  let ok = execRes.exitCode === 0;
  let violation = execRes.exitCode === 0 ? null : `VERIFY_CMD_FAILED (exit ${execRes.exitCode})`;

  if (effectiveRatchet) {
    ratchetResult = evaluateRatchet(effectiveRatchet, {
      stdout: execRes.stdout,
      exitCode: execRes.exitCode,
      expectedNonce,
    });
    if (!ratchetResult.ok) {
      ok = false;
      if (execRes.exitCode === 0) {
        violation = ratchetResult.violation || ratchetResult.violations.join("; ") || "METRIC_REGRESSION: ratchet failed";
      } else {
        violation = `${violation}; ${ratchetResult.violation || "ratchet failed"}`;
      }
    }
  }

  const status = ok ? "verified" : "failed";
  const result = {
    ok,
    scopeOk: true,
    changedFiles,
    ignoredUntrackedFiles,
    headSha,
    cmd: lane.verifyCmd,
    exitCode: execRes.exitCode,
    durationMs: execRes.durationMs,
    machine: execRes.machine,
    stdoutTail: execRes.stdoutTail,
    stderrTail: execRes.stderrTail,
    violation,
    ...(ratchetResult ? { ratchet: ratchetResult } : {}),
    ranCommand: true,
  };

  const mission = store.recordLaneVerification(m.id, laneId, {
    status,
    scopeOk: true,
    result,
    diff: diffSnapshot,
    inspection: buildInspectionSnapshot(status, true, result),
    contracts: diffSnapshot?.contracts,
    telemetry: { headSha, durationMs: execRes.durationMs, filesChanged: changedFiles },
  });

  if (ratchetResult) {
    store.recordEvent(
      m.id,
      "verifier",
      "ratchet_evaluated",
      {
        laneId: lane.id,
        status,
        ok: ratchetResult.ok,
        metrics: ratchetResult.metrics,
        deltas: ratchetResult.deltas,
        violations: ratchetResult.violations,
      },
      { laneId: lane.id, metrics: ratchetResult.metrics },
    );
  }

  const updatedLane = store.getMission(m.id)?.lanes.find((l) => l.id === laneId);
  return { result: updatedLane?.lastVerify || result, mission: store.getMission(m.id) };
}

export function runCommandChecked(
  cmd,
  {
    cwd,
    timeoutMs = 120_000,
    useAipc = false,
    offload = undefined,
    env = {},
    runner = null,
    aipcScript = undefined,
    devinBridge = undefined,
    lockDir = undefined,
  } = {},
) {
  const effectiveOffload = offload ?? (useAipc ? "aipc" : "local");
  const res = runWithCompute(cmd, {
    cwd,
    offload: effectiveOffload,
    timeoutMs,
    env,
    runner,
    aipcScript,
    devinBridge,
    lockDir,
  });
  return {
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    machine: res.machine,
    stdout: res.stdout,
    stderr: res.stderr,
    stdoutTail: res.stdoutTail,
    stderrTail: res.stderrTail,
  };
}

export function runMissionGate(
  store,
  missionId,
  gateId,
  {
    timeoutMs = 180_000,
    cleanupAfterPass = false,
    cwd = null,
    ratchet = undefined,
    offload = undefined,
    runner = null,
    aipcScript = undefined,
    devinBridge = undefined,
    lockDir = undefined,
    expectedNonce = null,
  } = {},
) {
  const m = store.requireMission(missionId);
  assertMutableRealMission(m);
  const gate = m.gates.find((g) => g.id === gateId);
  if (!gate) {
    const err = new Error(`Unknown gate "${gateId}".`);
    err.status = 404;
    throw err;
  }

  const targetCwd = cwd || m.repoRoot;
  const effectiveOffload = offload ?? gate.offload ?? "auto";
  const scratchEnv = laneScratchEnv(m.slug || m.id, `gate-${gate.id}`);
  const execRes = runWithCompute(gate.cmd, {
    cwd: targetCwd,
    offload: effectiveOffload,
    timeoutMs,
    env: scratchEnv,
    runner,
    aipcScript,
    devinBridge,
    lockDir,
  });

  const effectiveRatchet = ratchet ?? gate.ratchet ?? null;
  let ratchetResult = null;
  let ok = execRes.exitCode === 0;
  let violation = ok ? null : `GATE_CMD_FAILED (exit ${execRes.exitCode})`;

  if (effectiveRatchet) {
    ratchetResult = evaluateRatchet(effectiveRatchet, {
      stdout: execRes.stdout,
      exitCode: execRes.exitCode,
      expectedNonce,
    });
    if (!ratchetResult.ok) {
      ok = false;
      violation = execRes.exitCode === 0
        ? (ratchetResult.violation || "METRIC_REGRESSION: gate ratchet failed")
        : `${violation}; ${ratchetResult.violation || "gate ratchet failed"}`;
    }
  }

  const status = ok ? "passed" : "failed";
  const result = {
    exitCode: execRes.exitCode,
    durationMs: execRes.durationMs,
    machine: execRes.machine,
    stdoutTail: execRes.stdoutTail,
    stderrTail: execRes.stderrTail,
    ok,
    cmd: gate.cmd,
    ...(violation ? { violation } : {}),
    ...(ratchetResult ? { ratchet: ratchetResult } : {}),
  };
  let mission = store.recordGateResult(m.id, gateId, { status, result });

  const allReqPassed = mission.gates.every((g) => !g.required || g.status === "passed");
  const allLanesVerified = mission.lanes.length > 0 && mission.lanes.every((l) => l.status === "verified");
  if (allReqPassed && allLanesVerified && mission.gates.length > 0) {
    mission = store.setMissionState(m.id, "completed", { reason: "All lanes verified and required gates passed." });
    if (cleanupAfterPass) {
      cleanupWorktrees(store, m.id);
      mission = store.getMission(m.id);
    }
  } else if (!ok) {
    mission = store.setMissionState(m.id, "verifying", { failedGate: gateId });
  }
  return { result, mission };
}

export function cleanupWorktrees(store, missionId) {
  const m = store.requireMission(missionId);
  assertMutableRealMission(m);
  const removed = [];
  for (const lane of m.lanes) {
    if (!lane.worktreePath) continue;
    if (!existsSync(lane.worktreePath)) {
      store.setLaneWorktree(m.id, lane.id, { worktreePath: null, branchName: lane.branchName, status: lane.status });
      continue;
    }
    unmountAllJunctions(lane.worktreePath, lane.readOnlyMounts || []);
    const r = spawnSync("git", ["-C", m.repoRoot, "worktree", "remove", "--force", lane.worktreePath], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (r.status === 0 || !existsSync(lane.worktreePath)) {
      removed.push(lane.worktreePath);
      store.setLaneWorktree(m.id, lane.id, { worktreePath: null, branchName: lane.branchName, status: lane.status });
    }
  }
  spawnSync("git", ["-C", m.repoRoot, "worktree", "prune"], { shell: false, windowsHide: true });
  store.recordEvent(m.id, "coordinator", "worktrees_cleaned", { removed });
  return removed;
}
