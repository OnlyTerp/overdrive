import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileMatchesAnyGlob, fileMatchesGlob, normalizeRelPattern } from "./partition.mjs";
import { DIFF_CAPS, SCHEMA_VERSION } from "./ui-contracts.mjs";

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const UNTRACKED_SNIFF_BYTES = 8192;

function normalizePathSafe(raw) {
  if (!raw || typeof raw !== "string") return "";
  try {
    return normalizeRelPattern(raw);
  } catch {
    return raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  }
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256FileSafe(filePath) {
  const st = statSync(filePath);
  if (!st.isFile()) return null;
  const fd = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(65536);
    let offset = 0;
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n <= 0) break;
      hash.update(n === chunk.length ? chunk : chunk.subarray(0, n));
      offset += n;
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function runGitBuf(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function runGitText(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function tryGitText(cwd, args) {
  try {
    return runGitText(cwd, args);
  } catch {
    return null;
  }
}

function mapGitStatusCode(code) {
  switch (code) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
    case "T":
    case "U":
    default:
      return "modified";
  }
}

/** Parse null-delimited output of `git diff --name-status -z -M`. */
export function parseNameStatusZ(rawBuf) {
  const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString("utf8") : String(rawBuf || "");
  if (!text) return [];
  const tokens = text.split("\0");
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const statusTok = tokens[i++];
    if (!statusTok) continue;
    const code = statusTok[0];
    if (code === "R" || code === "C") {
      const oldPath = normalizePathSafe(tokens[i++] || "");
      const newPath = normalizePathSafe(tokens[i++] || "");
      if (newPath) {
        out.push({
          rawStatus: statusTok,
          status: code === "R" ? "renamed" : "added",
          path: newPath,
          oldPath: oldPath || null,
        });
      }
    } else {
      const filePath = normalizePathSafe(tokens[i++] || "");
      if (filePath) {
        out.push({
          rawStatus: statusTok,
          status: mapGitStatusCode(code),
          path: filePath,
          oldPath: null,
        });
      }
    }
  }
  return out;
}

/** Count added and deleted content lines in a unified diff string. */
export function countUnifiedPatchLines(patch) {
  const text = String(patch || "");
  if (!text) return { additions: 0, deletions: 0 };
  const lines = text.split(/\r?\n/);
  const hasHunkHeaders = lines.some((l) => l.startsWith("@@"));
  let additions = 0;
  let deletions = 0;
  let inHunk = !hasHunkHeaders;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = !hasHunkHeaders;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** Truncate a single file patch to `maxLines` and UTF-8 `maxBytes` without splitting codepoints. */
export function truncatePatch(
  patchText,
  { maxLines = DIFF_CAPS.maxLinesPerFile, maxBytes = DIFF_CAPS.maxFileBytes } = {},
) {
  const raw = String(patchText || "");
  let truncated = false;
  let out = raw;
  const lines = raw.split(/\r?\n/);
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    const buf = Buffer.from(out, "utf8").subarray(0, maxBytes);
    let end = buf.length;
    if (end > 0) {
      let start = end - 1;
      while (start >= Math.max(0, end - 4) && (buf[start] & 0xc0) === 0x80) start--;
      const lead = buf[start];
      const seqLen =
        (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
      if (start + seqLen > end) end = start;
    }
    out = buf.subarray(0, end).toString("utf8");
    truncated = true;
  }
  return { patch: out, truncated };
}

/** Classify whether a changed/renamed path is owned by the lane, out of scope, or a tampered contract. */
export function classifyOwnership(filePath, oldPath, lane, contracts = []) {
  const normPath = normalizePathSafe(filePath);
  const normOld = oldPath ? normalizePathSafe(oldPath) : null;
  const contractSet = new Set((contracts || []).map((c) => normalizePathSafe(c.path)));

  if (contractSet.has(normPath) || (normOld && contractSet.has(normOld))) {
    return { ownership: "contract_tampered", matchedGlob: null };
  }

  const globs = lane?.ownedGlobs || [];
  let matchedGlob = null;
  for (const g of globs) {
    try {
      if (fileMatchesGlob(normPath, g)) {
        matchedGlob = g;
        break;
      }
    } catch {}
  }

  if (!matchedGlob) {
    return { ownership: "out_of_scope", matchedGlob: null };
  }
  if (normOld) {
    let oldOwned = false;
    try {
      oldOwned = fileMatchesAnyGlob(normOld, globs);
    } catch {
      oldOwned = false;
    }
    if (!oldOwned) return { ownership: "out_of_scope", matchedGlob: null };
  }
  return { ownership: "owned", matchedGlob };
}

/** Check frozen contract SHA-256 hashes on disk (or via git tree / synthetic fixture). */
export function auditContracts(mission, targetDir, { branchRef = null, syntheticContracts = null } = {}) {
  if (Array.isArray(syntheticContracts)) {
    return syntheticContracts.map((c) => ({
      path: c.path,
      description: c.description || "",
      expected: c.expected ?? c.sha256 ?? null,
      observed: c.observed ?? c.sha256 ?? null,
      intact: c.intact !== undefined ? Boolean(c.intact) : (c.expected ?? c.sha256 ?? null) === (c.observed ?? c.sha256 ?? null),
    }));
  }

  const contracts = mission?.contracts || [];
  return contracts.map((c) => {
    const expected = c.sha256 || null;
    let observed = null;
    if (targetDir && existsSync(targetDir)) {
      const full = path.join(targetDir, c.path);
      if (existsSync(full)) {
        try {
          observed = sha256FileSafe(full);
        } catch {
          observed = null;
        }
      }
    } else if (branchRef && mission?.repoRoot && existsSync(mission.repoRoot)) {
      try {
        const buf = runGitBuf(mission.repoRoot, ["show", `${branchRef}:${c.path}`]);
        observed = sha256Buffer(buf);
      } catch {
        observed = null;
      }
    } else if (mission?.isShowcase || mission?.fixtureVersion) {
      observed = expected;
    }

    const intact = expected ? observed === expected : observed !== null;
    return {
      path: c.path,
      description: c.description || "",
      expected,
      observed,
      intact,
    };
  });
}

function readUntrackedPatch(targetDir, relPath, caps) {
  const full = path.join(targetDir, relPath);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { binary: false, patch: "", additions: 0, deletions: 0 };
  }
  if (st.isSymbolicLink()) {
    return {
      binary: false,
      patch: [`--- /dev/null`, `+++ b/${relPath}`, "@@ -0,0 +1 @@", "+[symbolic link]"].join("\n"),
      additions: 1,
      deletions: 0,
    };
  }
  if (!st.isFile()) return { binary: false, patch: "", additions: 0, deletions: 0 };
  try {
    const rootReal = realpathSync(targetDir);
    const fullReal = realpathSync(full);
    if (fullReal !== rootReal && !fullReal.startsWith(rootReal + path.sep)) {
      return { binary: false, patch: "", additions: 0, deletions: 0 };
    }
  } catch {
    return { binary: false, patch: "", additions: 0, deletions: 0 };
  }

  const readLimit = Math.min(st.size, Math.max(caps.maxFileBytes * 2, 131072));
  const buf = Buffer.allocUnsafe(readLimit);
  let bytesRead = 0;
  const fd = openSync(full, "r");
  try {
    bytesRead = readSync(fd, buf, 0, readLimit, 0);
  } finally {
    closeSync(fd);
  }
  const slice = buf.subarray(0, bytesRead);
  const sniff = slice.subarray(0, Math.min(bytesRead, UNTRACKED_SNIFF_BYTES));
  if (sniff.includes(0)) {
    return { binary: true, patch: `Binary file ${relPath} added (${st.size} bytes)`, additions: 0, deletions: 0 };
  }

  const text = slice.toString("utf8");
  const rawLines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const body = rawLines.map((l) => `+${l}`).join("\n");
  const header = `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${rawLines.length} @@`;
  const patch = body ? `${header}\n${body}` : header;
  return { binary: false, patch, additions: rawLines.length, deletions: 0 };
}

/** Enforce DIFF_CAPS across files (maxFiles, maxFileBytes, maxLinesPerFile, maxTotalBytes). */
export function enforceDiffCaps(rawFiles, caps = DIFF_CAPS) {
  const list = Array.isArray(rawFiles) ? rawFiles : [];
  let ordered = list;
  if (list.length > caps.maxFiles) {
    // Keep scope/contract violations inside the visible window if there are more than maxFiles.
    const violations = list.filter((f) => f.ownership && f.ownership !== "owned");
    const owned = list.filter((f) => !f.ownership || f.ownership === "owned");
    ordered = [...violations, ...owned];
  }

  const keptCandidates = ordered.slice(0, caps.maxFiles);
  let omittedFiles = Math.max(0, ordered.length - keptCandidates.length);
  let anyTruncated = omittedFiles > 0;
  let totalBytes = 0;
  const files = [];

  for (let idx = 0; idx < keptCandidates.length; idx++) {
    const f = keptCandidates[idx];
    const perFile = truncatePatch(f.patch || "", {
      maxLines: caps.maxLinesPerFile,
      maxBytes: caps.maxFileBytes,
    });
    let patch = perFile.patch;
    let fileTruncated = Boolean(f.truncated || perFile.truncated);
    let patchBytes = Buffer.byteLength(patch, "utf8");

    const remaining = caps.maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      omittedFiles += keptCandidates.length - idx;
      anyTruncated = true;
      break;
    }
    if (patchBytes > remaining) {
      if (remaining < 256 && files.length > 0) {
        omittedFiles += keptCandidates.length - idx;
        anyTruncated = true;
        break;
      }
      const fit = truncatePatch(patch, { maxLines: caps.maxLinesPerFile, maxBytes: remaining });
      patch = fit.patch;
      patchBytes = Buffer.byteLength(patch, "utf8");
      fileTruncated = true;
    }

    if (fileTruncated) anyTruncated = true;
    totalBytes += patchBytes;
    files.push({
      path: f.path,
      oldPath: f.oldPath ?? null,
      status: f.status || "modified",
      ownership: f.ownership || "owned",
      matchedGlob: f.matchedGlob ?? null,
      additions: Number.isFinite(f.additions) ? f.additions : 0,
      deletions: Number.isFinite(f.deletions) ? f.deletions : 0,
      binary: Boolean(f.binary),
      truncated: fileTruncated,
      patch,
    });
  }

  return { files, truncated: anyTruncated, omittedFiles, totalBytes };
}

function buildFilesAndSummary(rawEntries, lane, contracts, caps) {
  const normalized = rawEntries.map((entry) => {
    const cls = classifyOwnership(entry.path, entry.oldPath, lane, contracts);
    const counts =
      Number.isFinite(entry.additions) && Number.isFinite(entry.deletions)
        ? { additions: entry.additions, deletions: entry.deletions }
        : countUnifiedPatchLines(entry.patch);
    return {
      path: normalizePathSafe(entry.path),
      oldPath: entry.oldPath ? normalizePathSafe(entry.oldPath) : null,
      status: entry.status || "modified",
      ownership: entry.ownership || cls.ownership,
      matchedGlob: entry.matchedGlob !== undefined ? entry.matchedGlob : cls.matchedGlob,
      additions: counts.additions,
      deletions: counts.deletions,
      binary: Boolean(entry.binary),
      truncated: Boolean(entry.truncated),
      patch: String(entry.patch || ""),
    };
  });

  const capped = enforceDiffCaps(normalized, caps);
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of normalized) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }
  const scopeOk =
    normalized.every((f) => f.ownership === "owned") &&
    contracts.every((c) => c.intact);

  return { capped, totalAdditions, totalDeletions, scopeOk };
}

function resolveArgs(arg1, arg2, arg3, arg4) {
  if (arg1 && typeof arg1.requireMission === "function") {
    const store = arg1;
    const mission = store.requireMission(arg2);
    const lane = mission.lanes.find((l) => l.id === arg3);
    if (!lane) {
      const err = new Error(`Unknown lane "${arg3}" in mission "${mission.id}".`);
      err.status = 404;
      throw err;
    }
    const opts = arg4 || {};
    const receipt = opts.receiptId ? store.getReceipt(mission.id, opts.receiptId) : null;
    if (opts.receiptId && (!receipt || receipt.laneId !== lane.id)) {
      const err = new Error(`Unknown receipt "${opts.receiptId}" for lane "${lane.id}".`);
      err.status = 404;
      throw err;
    }
    return { mission, lane, receipt, opts };
  }

  if (arg1 && typeof arg1 === "object" && Array.isArray(arg1.lanes)) {
    const mission = arg1;
    const lane = mission.lanes.find((l) => l.id === arg2);
    if (!lane) {
      const err = new Error(`Unknown lane "${arg2}" in mission "${mission.id}".`);
      err.status = 404;
      throw err;
    }
    return { mission, lane, receipt: arg3?.receipt || null, opts: arg3 || {} };
  }

  const opts = arg1 || {};
  return {
    mission: opts.mission,
    lane: opts.lane,
    receipt: opts.receipt || null,
    opts,
  };
}

/**
 * Collect and cap unified diffs + contract hashes + scope ownership for one lane.
 * Supports live git worktree, branch commit diff, stored receipt snapshot, and synthetic fixtures.
 */
export function collectLaneDiff(arg1, arg2, arg3, arg4) {
  const { mission, lane, receipt, opts } = resolveArgs(arg1, arg2, arg3, arg4);
  const caps = { ...DIFF_CAPS, ...(opts.caps || {}) };

  if (receipt?.diff) {
    const saved = receipt.diff;
    const contracts = auditContracts(mission, null, { syntheticContracts: saved.contracts || receipt.contracts || [] });
    const { capped, totalAdditions, totalDeletions, scopeOk } = buildFilesAndSummary(
      saved.files || [],
      lane,
      contracts,
      caps,
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      missionId: mission.id,
      laneId: lane.id,
      source: "receipt",
      receiptId: receipt.id,
      freezeCommit: saved.freezeCommit ?? mission.freezeCommit ?? null,
      headSha: saved.headSha ?? receipt.headSha ?? lane.headSha ?? null,
      capturedAt: saved.capturedAt || receipt.createdAt,
      truncated: Boolean(saved.truncated || capped.truncated),
      omittedFiles: (Number(saved.omittedFiles) || 0) + (Number(capped.omittedFiles) || 0),
      totalBytes: capped.totalBytes,
      totalAdditions,
      totalDeletions,
      scopeOk,
      files: capped.files,
      contracts,
    };
  }

  const wtDir = opts.targetDir || (lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : null);
  const branchRef = lane.branchName && mission.repoRoot && existsSync(mission.repoRoot)
    ? tryGitText(mission.repoRoot, ["rev-parse", "--verify", lane.branchName])?.trim() || null
    : null;

  let source = "empty";
  let headSha = lane.headSha || null;
  let rawEntries = [];
  let contracts = [];

  if (wtDir && existsSync(wtDir) && mission.freezeCommit) {
    source = "worktree";
    headSha = tryGitText(wtDir, ["rev-parse", "HEAD"])?.trim() || headSha;
    contracts = auditContracts(mission, wtDir);

    const nsBuf = runGitBuf(wtDir, ["diff", "--name-status", "-z", "-M", mission.freezeCommit]);
    const trackedEntries = parseNameStatusZ(nsBuf);
    const untrackedBuf = runGitBuf(wtDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untrackedPaths = untrackedBuf
      .toString("utf8")
      .split("\0")
      .map((p) => normalizePathSafe(p))
      .filter(Boolean);

    const allStubs = [
      ...trackedEntries.map((e) => ({ ...e, isUntracked: false, ...classifyOwnership(e.path, e.oldPath, lane, mission.contracts) })),
      ...untrackedPaths.map((p) => ({ status: "added", path: p, oldPath: null, isUntracked: true, ...classifyOwnership(p, null, lane, mission.contracts) })),
    ];

    const prioritized =
      allStubs.length > caps.maxFiles
        ? [...allStubs.filter((s) => s.ownership !== "owned"), ...allStubs.filter((s) => s.ownership === "owned")]
        : allStubs;

    const toRead = prioritized.slice(0, caps.maxFiles);
    const extraOmitted = Math.max(0, prioritized.length - toRead.length);

    for (const item of toRead) {
      if (item.isUntracked) {
        const u = readUntrackedPatch(wtDir, item.path, caps);
        rawEntries.push({ ...item, ...u });
      } else {
        const pathArgs = item.oldPath ? [item.oldPath, item.path] : [item.path];
        const patch = tryGitText(wtDir, ["diff", "--no-color", "-M", mission.freezeCommit, "--", ...pathArgs]) || "";
        const binary = /^Binary files .* differ$/m.test(patch);
        const counts = binary ? { additions: 0, deletions: 0 } : countUnifiedPatchLines(patch);
        rawEntries.push({ ...item, binary, patch, ...counts });
      }
    }

    const { capped, totalAdditions, totalDeletions, scopeOk } = buildFilesAndSummary(rawEntries, lane, contracts, caps);
    return {
      schemaVersion: SCHEMA_VERSION,
      missionId: mission.id,
      laneId: lane.id,
      source,
      receiptId: receipt?.id || lane.lastVerify?.receiptId || null,
      freezeCommit: mission.freezeCommit,
      headSha,
      capturedAt: new Date().toISOString(),
      truncated: capped.truncated || extraOmitted > 0,
      omittedFiles: capped.omittedFiles + extraOmitted,
      totalBytes: capped.totalBytes,
      totalAdditions,
      totalDeletions,
      scopeOk,
      files: capped.files,
      contracts,
    };
  }

  if (branchRef && mission.freezeCommit && existsSync(mission.repoRoot)) {
    source = "git";
    headSha = branchRef;
    contracts = auditContracts(mission, null, { branchRef: lane.branchName });
    const nsBuf = runGitBuf(mission.repoRoot, ["diff", "--name-status", "-z", "-M", `${mission.freezeCommit}..${lane.branchName}`]);
    const trackedEntries = parseNameStatusZ(nsBuf).map((e) => ({
      ...e,
      ...classifyOwnership(e.path, e.oldPath, lane, mission.contracts),
    }));
    const prioritized =
      trackedEntries.length > caps.maxFiles
        ? [...trackedEntries.filter((s) => s.ownership !== "owned"), ...trackedEntries.filter((s) => s.ownership === "owned")]
        : trackedEntries;
    const toRead = prioritized.slice(0, caps.maxFiles);
    const extraOmitted = Math.max(0, prioritized.length - toRead.length);

    for (const item of toRead) {
      const pathArgs = item.oldPath ? [item.oldPath, item.path] : [item.path];
      const patch = tryGitText(mission.repoRoot, ["diff", "--no-color", "-M", `${mission.freezeCommit}..${lane.branchName}`, "--", ...pathArgs]) || "";
      const binary = /^Binary files .* differ$/m.test(patch);
      const counts = binary ? { additions: 0, deletions: 0 } : countUnifiedPatchLines(patch);
      rawEntries.push({ ...item, binary, patch, ...counts });
    }

    const { capped, totalAdditions, totalDeletions, scopeOk } = buildFilesAndSummary(rawEntries, lane, contracts, caps);
    return {
      schemaVersion: SCHEMA_VERSION,
      missionId: mission.id,
      laneId: lane.id,
      source,
      receiptId: receipt?.id || lane.lastVerify?.receiptId || null,
      freezeCommit: mission.freezeCommit,
      headSha,
      capturedAt: new Date().toISOString(),
      truncated: capped.truncated || extraOmitted > 0,
      omittedFiles: capped.omittedFiles + extraOmitted,
      totalBytes: capped.totalBytes,
      totalAdditions,
      totalDeletions,
      scopeOk,
      files: capped.files,
      contracts,
    };
  }

  if (lane.syntheticDiff) {
    source = receipt ? "receipt" : "synthetic";
    contracts = auditContracts(mission, null, { syntheticContracts: lane.syntheticDiff.contracts || null });
    rawEntries = Array.isArray(lane.syntheticDiff.files) ? lane.syntheticDiff.files : [];
    const { capped, totalAdditions, totalDeletions, scopeOk } = buildFilesAndSummary(rawEntries, lane, contracts, caps);
    return {
      schemaVersion: SCHEMA_VERSION,
      missionId: mission.id,
      laneId: lane.id,
      source,
      receiptId: receipt?.id || lane.lastVerify?.receiptId || null,
      freezeCommit: mission.freezeCommit || null,
      headSha: lane.syntheticDiff.headSha || headSha,
      capturedAt: lane.syntheticDiff.capturedAt || receipt?.createdAt || new Date().toISOString(),
      truncated: capped.truncated,
      omittedFiles: capped.omittedFiles,
      totalBytes: capped.totalBytes,
      totalAdditions,
      totalDeletions,
      scopeOk,
      files: capped.files,
      contracts,
    };
  }

  contracts = auditContracts(mission, null);
  return {
    schemaVersion: SCHEMA_VERSION,
    missionId: mission.id,
    laneId: lane.id,
    source: receipt ? "receipt" : "empty",
    receiptId: receipt?.id || lane.lastVerify?.receiptId || null,
    freezeCommit: mission.freezeCommit || null,
    headSha,
    capturedAt: receipt?.createdAt || new Date().toISOString(),
    truncated: false,
    omittedFiles: 0,
    totalBytes: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    scopeOk: lane.scopeOk !== false && contracts.every((c) => c.intact),
    files: [],
    contracts,
  };
}
