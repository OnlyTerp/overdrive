import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runWithCompute, withSlot } from "./compute.mjs";
import { auditContracts, parseNameStatusZ } from "./diff.mjs";
import { fileMatchesAnyGlob } from "./partition.mjs";
import {
  evaluateRatchet,
  extractOverdriveMetrics,
  loadPrivateHoldout,
  stripPrivateRatchetFields,
} from "./ratchet.mjs";
import { mergeRegions, validateBaseSeams, verifyLaneRegionContainment } from "./seam.mjs";
import { validateRatchetResult } from "./ui-contracts.mjs";
import {
  assertMutableRealMission,
  cleanupWorktrees,
  DEFAULT_IGNORE_UNTRACKED_GLOBS,
  isUntrackedIgnored,
  laneScratchEnv,
  mountReadOnlyJunctions,
  unmountAllJunctions,
  worktreeRootBase,
} from "./worktree.mjs";

function repoFolderName(repoRoot) {
  return path.basename(path.resolve(repoRoot)).replace(/[^A-Za-z0-9_.-]/g, "_") || "repo";
}

function repoLockKey(repoRoot) {
  const hash = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
  return `repo-integrate-${hash}`;
}

function runGit(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in "${cwd}": ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r;
}

function gitText(cwd, args) {
  const r = runGit(cwd, args);
  return r.stdout;
}

function gitShowText(cwd, rev, relPath) {
  const r = runGit(cwd, ["show", `${rev}:${relPath}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

function parsePorcelainZ(raw) {
  const tokens = String(raw || "").split("\0");
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (!tok) continue;
    const x = tok[0] || " ";
    const y = tok[1] || " ";
    const relPath = tok.slice(3).replaceAll("\\", "/");
    let oldPath = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = (tokens[i++] || "").replaceAll("\\", "/") || null;
    }
    out.push({
      xy: `${x}${y}`,
      untracked: x === "?" && y === "?",
      path: relPath,
      oldPath,
    });
  }
  return out;
}

function resolveLaneConfigOverride(lanesConfig, laneId) {
  if (!lanesConfig) return {};
  if (lanesConfig instanceof Map) return lanesConfig.get(laneId) || {};
  if (Array.isArray(lanesConfig)) return lanesConfig.find((l) => l?.id === laneId) || {};
  if (typeof lanesConfig === "object") return lanesConfig[laneId] || {};
  return {};
}

function commitCleanOwnedWorktreeEdits(lane, m, extraIgnoreGlobs) {
  const wt = lane.worktreePath;
  if (!wt || !existsSync(wt)) return;

  const porcelainRaw = gitText(wt, ["status", "--porcelain", "-z"]);
  const dirty = parsePorcelainZ(porcelainRaw);
  if (dirty.length === 0) return;

  const ignoreGlobs = [
    ...DEFAULT_IGNORE_UNTRACKED_GLOBS,
    ...(Array.isArray(lane.ignoreUntrackedGlobs) ? lane.ignoreUntrackedGlobs : []),
    ...extraIgnoreGlobs,
  ];
  const contractSet = new Set((m.contracts || []).map((c) => c.path));
  const regionPaths = new Set((lane.ownedRegions || []).map((r) => r.path));
  const untrackedToAdd = [];
  let hasTrackedDirty = false;

  for (const item of dirty) {
    if (item.untracked) {
      if (isUntrackedIgnored(item.path, ignoreGlobs)) {
        // Ignored untracked artifacts must NEVER be staged.
        continue;
      }
      if (contractSet.has(item.path)) {
        throw new Error(`CONTRACT_TAMPERED: lane "${lane.id}" modified contract "${item.path}"`);
      }
      const inGlobs = fileMatchesAnyGlob(item.path, lane.ownedGlobs || []);
      const inRegion = regionPaths.has(item.path);
      if (!inGlobs && !inRegion) {
        throw new Error(`SCOPE_VIOLATION: lane "${lane.id}" has uncommitted out-of-scope file "${item.path}"`);
      }
      untrackedToAdd.push(item.path);
    } else {
      hasTrackedDirty = true;
      for (const p of [item.path, item.oldPath].filter(Boolean)) {
        if (contractSet.has(p)) {
          throw new Error(`CONTRACT_TAMPERED: lane "${lane.id}" modified contract "${p}"`);
        }
        if (!fileMatchesAnyGlob(p, lane.ownedGlobs || []) && !regionPaths.has(p)) {
          throw new Error(`SCOPE_VIOLATION: lane "${lane.id}" has uncommitted out-of-scope tracked file "${p}"`);
        }
      }
    }
  }

  if (!hasTrackedDirty && untrackedToAdd.length === 0) return;

  if (hasTrackedDirty) {
    runGit(wt, ["add", "-u"]);
  }
  if (untrackedToAdd.length > 0) {
    runGit(wt, ["add", "--", ...untrackedToAdd]);
  }
  const staged = runGit(wt, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.status !== 0) {
    runGit(wt, [
      "-c",
      "user.name=Overdrive",
      "-c",
      "user.email=overdrive@local",
      "commit",
      "-m",
      `chore(overdrive): commit verified lane ${lane.id}`,
    ]);
  }
}

function combineRatchetResults(results) {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  const metrics = {};
  const baseline = {};
  const deltas = {};
  const violations = [];
  let holdoutConfigured = false;
  let holdoutPassed = null;
  let exitCode = 0;

  for (const r of results) {
    Object.assign(metrics, r.metrics || {});
    Object.assign(baseline, r.baseline || {});
    Object.assign(deltas, r.deltas || {});
    if (Array.isArray(r.violations)) violations.push(...r.violations);
    if (r.holdoutConfigured) {
      holdoutConfigured = true;
      if (r.holdoutPassed === false) holdoutPassed = false;
      else if (holdoutPassed === null && r.holdoutPassed === true) holdoutPassed = true;
    }
    if (Number.isInteger(r.exitCode) && r.exitCode !== 0 && exitCode === 0) {
      exitCode = r.exitCode;
    }
  }
  const ok = results.every((r) => r.ok) && violations.length === 0 && exitCode === 0 && (!holdoutConfigured || holdoutPassed !== false);
  const combined = {
    ok,
    exitCode,
    metrics,
    baseline,
    deltas,
    violations,
    violation: violations.length ? violations.join("; ") : null,
    holdoutConfigured,
    holdoutPassed,
  };
  return combined;
}

/**
 * Atomically integrate verified lane branches in an ephemeral -integrate worktree:
 * - Acquires per-repo semaphore lock
 * - Checks repoRoot has no overlapping dirty tracked files before promoting
 * - Merges verified lane branches with deterministic seam.mergeRegions for shared ownedRegions files
 * - Verifies frozen contracts, required gates, and coordinator-private holdouts/ratchets inside -integrate
 * - Fast-forwards repoRoot ONLY on 100% pass (leaves repoRoot 100% untouched on ANY failure)
 * - Always cleans up -integrate worktree (unmounting junctions first) and records integration_verified / integration_failed
 */
export async function integrateMission(
  store,
  missionId,
  {
    runGates = true,
    runHoldouts = true,
    promoteToRepoRoot = true,
    laneIds = null,
    gateId = null,
    cleanupWorktrees: shouldCleanupLanes = false,
    lanesConfig = null,
    ignoreUntrackedGlobs = [],
    computeRunner = null,
    timeoutMs = 180_000,
    lockDir = undefined,
    aipcScript = undefined,
    devinBridge = undefined,
  } = {},
) {
  const m = store.requireMission(missionId);
  assertMutableRealMission(m);
  if (!m.freezeCommit) {
    throw new Error(`Mission "${m.id}" has no freezeCommit; freeze contracts before integrating.`);
  }

  let selectedRawLanes = m.lanes || [];
  if (Array.isArray(laneIds) && laneIds.length > 0) {
    const byId = new Map(selectedRawLanes.map((l) => [l.id, l]));
    for (const reqId of laneIds) {
      if (!byId.has(reqId)) {
        throw new Error(`UNKNOWN_LANE: lane "${reqId}" not found in mission "${m.id}".`);
      }
    }
    const want = new Set(laneIds);
    selectedRawLanes = selectedRawLanes.filter((l) => want.has(l.id));
  }

  const preIntegrateHead = gitText(m.repoRoot, ["rev-parse", "HEAD"]).trim();
  const baseWtDir = path.join(worktreeRootBase(), repoFolderName(m.repoRoot));
  const candidateWt = path.join(baseWtDir, `${m.slug}-integrate`).replaceAll("\\", "/");
  const hasIntegrateCollision = (m.lanes || []).some(
    (l) =>
      l.id === "integrate" ||
      (l.worktreePath && path.resolve(l.worktreePath) === path.resolve(candidateWt)),
  );
  const integrateWt = hasIntegrateCollision
    ? path.join(baseWtDir, `${m.slug}--overdrive-integrate`).replaceAll("\\", "/")
    : candidateWt;
  const extraIgnore = Array.isArray(ignoreUntrackedGlobs) ? ignoreUntrackedGlobs : [];

  return withSlot(repoLockKey(m.repoRoot), { limit: 1, lockDir, waitMs: 10_000 }, async () => {
    store.recordEvent(m.id, "coordinator", "integration_started", {
      preIntegrateHead,
      freezeCommit: m.freezeCommit,
    });

    const effectiveLanes = selectedRawLanes.map((l) => {
      const cfg = resolveLaneConfigOverride(lanesConfig, l.id);
      return {
        ...l,
        ownedRegions: cfg.ownedRegions ?? l.ownedRegions ?? [],
        ignoreUntrackedGlobs: cfg.ignoreUntrackedGlobs ?? l.ignoreUntrackedGlobs ?? [],
        ratchet: cfg.ratchet ?? l.ratchet ?? null,
      };
    });

    const mergedLanes = [];
    const ratchetChecks = [];
    let seamMergeApplied = false;
    let gatesPassed = true;
    let integratedCommit = null;
    let fastForwarded = false;
    let ratchetResult = null;
    let failureError = null;
    let cleanupInfo = { removed: false, worktreePath: integrateWt, junctionsUnmounted: [] };
    let createdWorktree = false;

    try {
      if (effectiveLanes.length === 0) {
        throw new Error("NO_LANES: mission has no lanes to integrate.");
      }

      const unverified = effectiveLanes.filter((l) => l.status !== "verified");
      if (unverified.length > 0) {
        throw new Error(
          `UNVERIFIED_LANES: cannot integrate unverified lane(s): ${unverified.map((l) => `${l.id}(${l.status})`).join(", ")}`,
        );
      }

      // 1. Ensure any verified dirty owned changes in lane worktrees are committed cleanly (never staging ignored globs).
      for (const lane of effectiveLanes) {
        commitCleanOwnedWorktreeEdits(lane, m, extraIgnore);
      }

      // 2. Collect every lane's branch diff against freezeCommit & check file ownership / collisions.
      const laneRefs = new Map();
      const fileToLanes = new Map();
      const allTouchedByLanes = new Set();
      const contractSet = new Set((m.contracts || []).map((c) => c.path));

      for (const lane of effectiveLanes) {
        const ref =
          lane.branchName ||
          (lane.worktreePath && existsSync(lane.worktreePath) ? gitText(lane.worktreePath, ["rev-parse", "HEAD"]).trim() : null) ||
          `overdrive/${m.slug}/${lane.id}`;
        const refCheck = runGit(m.repoRoot, ["rev-parse", "--verify", ref], { allowFail: true });
        if (refCheck.status !== 0) {
          throw new Error(`MISSING_LANE_REF: branch/ref "${ref}" for lane "${lane.id}" not found.`);
        }
        const sha = refCheck.stdout.trim();
        laneRefs.set(lane.id, { ref, sha });

        const nsBuf = spawnSync(
          "git",
          ["-C", m.repoRoot, "diff", "--name-status", "-z", "-M", m.freezeCommit, sha],
          { shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        );
        if (nsBuf.status !== 0) {
          throw new Error(`git diff failed for lane "${lane.id}": ${String(nsBuf.stderr || "")}`);
        }
        const entries = parseNameStatusZ(nsBuf.stdout);
        const regionPaths = new Set((lane.ownedRegions || []).map((r) => r.path));
        for (const e of entries) {
          for (const p of [e.path, e.oldPath].filter(Boolean)) {
            if (contractSet.has(p)) {
              throw new Error(`CONTRACT_TAMPERED: lane "${lane.id}" modified frozen contract "${p}"`);
            }
            const inGlobs = fileMatchesAnyGlob(p, lane.ownedGlobs || []);
            const inRegion = regionPaths.has(p) && e.status !== "deleted" && e.status !== "renamed" && !e.oldPath;
            if (!inGlobs && !inRegion) {
              throw new Error(`SCOPE_VIOLATION: lane "${lane.id}" touched out-of-scope path "${p}"`);
            }
          }
          allTouchedByLanes.add(e.path);
          if (e.oldPath) allTouchedByLanes.add(e.oldPath);
          if (!fileToLanes.has(e.path)) fileToLanes.set(e.path, []);
          fileToLanes.get(e.path).push(lane);
        }
      }

      // 3. Check repoRoot has no dirty tracked files overlapping lane changes if promoteToRepoRoot.
      if (promoteToRepoRoot) {
        const repoDirty = parsePorcelainZ(gitText(m.repoRoot, ["status", "--porcelain", "-z"]));
        const overlapping = repoDirty.filter((d) => {
          const hit = allTouchedByLanes.has(d.path) || (d.oldPath && allTouchedByLanes.has(d.oldPath));
          if (!hit) return false;
          return !d.untracked || allTouchedByLanes.has(d.path);
        });
        if (overlapping.length > 0) {
          throw new Error(
            `DIRTY_REPO_OVERLAP: repoRoot has uncommitted changes overlapping lane edits: ${overlapping.map((o) => o.path).join(", ")}`,
          );
        }
      }

      // 4. Validate base seams across all lanes with ownedRegions.
      if (effectiveLanes.some((l) => (l.ownedRegions || []).length > 0)) {
        const seamCheck = validateBaseSeams((p) => gitShowText(m.repoRoot, m.freezeCommit, p), effectiveLanes);
        if (!seamCheck.ok) {
          throw new Error(seamCheck.error);
        }
      }

      // 5. Verify every file touched by multiple lanes is covered by disjoint ownedRegions and compute deterministic seam merge.
      const seamMergedFiles = new Map();
      for (const [filePath, touchingLanes] of fileToLanes.entries()) {
        const anyRegion = touchingLanes.some((l) => (l.ownedRegions || []).some((r) => r.path === filePath));
        if (touchingLanes.length < 2 && !anyRegion) continue;

        const baseText = gitShowText(m.repoRoot, m.freezeCommit, filePath);
        if (baseText === null) {
          throw new Error(`ANCHOR_MISSING: base file "${filePath}" missing at freezeCommit ${m.freezeCommit}`);
        }

        if (touchingLanes.length >= 2) {
          for (const tl of touchingLanes) {
            const regs = (tl.ownedRegions || []).filter((r) => r.path === filePath);
            if (regs.length === 0) {
              throw new Error(
                `SEAM_CONFLICT: multiple lanes (${touchingLanes.map((x) => x.id).join(", ")}) modified "${filePath}" without disjoint ownedRegions`,
              );
            }
          }
        }

        const laneVersions = [];
        for (const tl of touchingLanes) {
          const regs = (tl.ownedRegions || []).filter((r) => r.path === filePath);
          if (regs.length === 0) continue; // Single-lane glob-owned file without regions
          const sha = laneRefs.get(tl.id).sha;
          const text = gitShowText(m.repoRoot, sha, filePath);
          if (text === null) {
            throw new Error(`REGION_OUTSIDE_EDIT: lane "${tl.id}" deleted "${filePath}"`);
          }
          const cCheck = verifyLaneRegionContainment(baseText, text, regs);
          if (!cCheck.ok) {
            throw new Error(`SCOPE_VIOLATION: lane "${tl.id}" failed region containment on "${filePath}": ${cCheck.error}`);
          }
          laneVersions.push({ laneId: tl.id, regions: regs, text });
        }

        if (laneVersions.length >= 2) {
          const merged = mergeRegions({ baseText, laneVersions, filePath });
          seamMergedFiles.set(filePath, merged.text);
        }
      }

      // 6. Provision ephemeral -integrate worktree from freezeCommit.
      mkdirSync(baseWtDir, { recursive: true });
      if (existsSync(integrateWt)) {
        unmountAllJunctions(integrateWt);
        runGit(m.repoRoot, ["worktree", "remove", "--force", integrateWt], { allowFail: true });
        if (existsSync(integrateWt)) rmSync(integrateWt, { recursive: true, force: true });
        runGit(m.repoRoot, ["worktree", "prune"], { allowFail: true });
      }
      runGit(m.repoRoot, ["worktree", "add", "--detach", integrateWt, m.freezeCommit]);
      createdWorktree = true;
      runGit(integrateWt, ["config", "core.autocrlf", "false"], { allowFail: true });

      // 7. Merge each verified lane branch cleanly (--no-ff), using deterministic seam.mergeRegions on shared region conflicts.
      for (const lane of effectiveLanes) {
        const { ref, sha } = laneRefs.get(lane.id);
        const ahead = Number(gitText(m.repoRoot, ["rev-list", "--count", `${m.freezeCommit}..${sha}`]).trim() || "0");
        if (ahead === 0) {
          mergedLanes.push(lane.id);
          continue;
        }

        const mergeRes = runGit(
          integrateWt,
          ["-c", "user.name=Overdrive", "-c", "user.email=overdrive@local", "merge", "--no-ff", "--no-edit", sha],
          { allowFail: true },
        );

        if (mergeRes.status !== 0) {
          const conflictedRaw = gitText(integrateWt, ["diff", "--name-only", "--diff-filter=U"]);
          const conflicted = conflictedRaw
            .split(/\r?\n/)
            .map((s) => s.trim().replaceAll("\\", "/"))
            .filter(Boolean);

          const canResolveViaSeam =
            conflicted.length > 0 && conflicted.every((cf) => seamMergedFiles.has(cf));
          if (!canResolveViaSeam) {
            runGit(integrateWt, ["merge", "--abort"], { allowFail: true });
            throw new Error(
              `MERGE_CONFLICT: failed merging lane "${lane.id}" (${ref}): ${(conflicted.join(", ") || mergeRes.stderr || mergeRes.stdout).trim()}`,
            );
          }

          for (const cf of conflicted) {
            writeFileSync(path.join(integrateWt, cf), seamMergedFiles.get(cf), "utf8");
            runGit(integrateWt, ["add", "--", cf]);
          }
          runGit(integrateWt, [
            "-c",
            "user.name=Overdrive",
            "-c",
            "user.email=overdrive@local",
            "commit",
            "--no-edit",
          ]);
          seamMergeApplied = true;
        }

        mergedLanes.push(lane.id);
      }

      // Ensure final shared region files match deterministic seam.mergeRegions byte-for-byte.
      for (const [filePath, expectedText] of seamMergedFiles.entries()) {
        seamMergeApplied = true;
        const full = path.join(integrateWt, filePath);
        const currentText = existsSync(full) ? readFileSync(full, "utf8") : "";
        if (currentText !== expectedText) {
          writeFileSync(full, expectedText, "utf8");
          runGit(integrateWt, ["add", "--", filePath]);
          const staged = runGit(integrateWt, ["diff", "--cached", "--quiet"], { allowFail: true });
          if (staged.status !== 0) {
            runGit(integrateWt, [
              "-c",
              "user.name=Overdrive",
              "-c",
              "user.email=overdrive@local",
              "commit",
              "-m",
              `chore(overdrive): apply deterministic seam merge for ${filePath}`,
            ]);
          }
        }
      }

      // 8. Verify frozen contract SHA-256 hashes inside -integrate.
      const contractAudit = auditContracts(m, integrateWt);
      const tampered = contractAudit.filter((c) => !c.intact);
      if (tampered.length > 0) {
        throw new Error(`CONTRACT_TAMPERED in -integrate: ${tampered.map((t) => t.path).join(", ")}`);
      }

      // Mount read-only junctions if any lanes declare them, so gates/holdouts inside -integrate see them too.
      for (const lane of effectiveLanes) {
        if (Array.isArray(lane.readOnlyMounts) && lane.readOnlyMounts.length > 0) {
          mountReadOnlyJunctions(integrateWt, lane.readOnlyMounts);
        }
      }

      const holdoutMap = runHoldouts ? (loadPrivateHoldout(m.id, null) || {}) : {};
      const allGates = Array.isArray(m.gates) ? m.gates : [];
      let gatesToRun = allGates;
      if (gateId) {
        gatesToRun = allGates.filter((g) => g.id === gateId);
        if (gatesToRun.length === 0) {
          throw new Error(`UNKNOWN_GATE: gate "${gateId}" not found in mission "${m.id}".`);
        }
      }

      // 9. Run gates inside -integrate.
      if (runGates && gatesToRun.length > 0) {
        for (const gate of gatesToRun) {
          const gateScratch = laneScratchEnv(m.slug || m.id, `integrate-gate-${gate.id}`);
          const execRes = await runWithCompute(gate.cmd, {
            cwd: integrateWt,
            offload: gate.offload || "auto",
            timeoutMs,
            env: gateScratch,
            runner: computeRunner,
            lockDir,
            aipcScript,
            devinBridge,
          });

          const gateHoldout = runHoldouts ? (holdoutMap[`gate:${gate.id}`] || holdoutMap[gate.id] || null) : null;
          const gateRatchetSpec = gate.ratchet || gateHoldout
            ? { ...(gate.ratchet || {}), ...(gateHoldout || {}) }
            : null;

          let gateHoldoutExit = null;
          let gateHoldoutMetrics = null;
          if (runHoldouts && gateRatchetSpec?.holdoutCmd) {
            const hRes = await runWithCompute(gateRatchetSpec.holdoutCmd, {
              cwd: integrateWt,
              offload: gate.offload || "auto",
              timeoutMs,
              env: gateScratch,
              runner: computeRunner,
              lockDir,
              aipcScript,
              devinBridge,
            });
            gateHoldoutExit = hRes.exitCode;
            const ext = extractOverdriveMetrics(hRes.stdout);
            if (ext.ok) gateHoldoutMetrics = ext.metrics;
            else if (hRes.exitCode === 0 && (gateRatchetSpec.holdoutMetrics || gateRatchetSpec.holdoutMetricsSpec || ext.code !== "METRICS_MISSING")) {
              throw new Error(ext.error || `METRICS_INVALID_JSON: gate "${gate.id}" holdout emitted invalid metrics`);
            }
          }

          let gateRatchet = null;
          let gateOk = execRes.exitCode === 0;
          if (gateRatchetSpec) {
            if (Array.isArray(gateRatchetSpec.metrics) && gateRatchetSpec.metrics.length > 0) {
              gateRatchet = evaluateRatchet(gateRatchetSpec, {
                stdout: execRes.stdout,
                exitCode: execRes.exitCode,
                holdoutExitCode: gateHoldoutExit,
                holdoutMetrics: gateHoldoutMetrics,
              });
            } else {
              gateRatchet = {
                ok: gateHoldoutExit === null || gateHoldoutExit === 0,
                exitCode: execRes.exitCode,
                metrics: gateHoldoutMetrics || {},
                baseline: {},
                deltas: {},
                violations: gateHoldoutExit !== null && gateHoldoutExit !== 0 ? [`HOLDOUT_FAILED: exit ${gateHoldoutExit}`] : [],
                violation: gateHoldoutExit !== null && gateHoldoutExit !== 0 ? `HOLDOUT_FAILED: exit ${gateHoldoutExit}` : null,
                holdoutConfigured: Boolean(gateRatchetSpec.holdoutCmd || gateRatchetSpec.holdoutMetrics || gateRatchetSpec.holdoutMetricsSpec),
                holdoutPassed: gateHoldoutExit === null ? null : gateHoldoutExit === 0,
                spec: stripPrivateRatchetFields(gateRatchetSpec),
              };
            }
            ratchetChecks.push(gateRatchet);
            if (!gateRatchet.ok) gateOk = false;
          }

          const gateResultPayload = {
            exitCode: execRes.exitCode,
            durationMs: execRes.durationMs,
            machine: execRes.machine,
            stdoutTail: execRes.stdoutTail,
            stderrTail: execRes.stderrTail,
            ok: gateOk,
            cmd: gate.cmd,
            ...(gateRatchet ? { ratchet: gateRatchet } : {}),
          };
          store.recordGateResult(m.id, gate.id, {
            status: gateOk ? "passed" : "failed",
            result: gateResultPayload,
          });

          if (!gateOk && gate.required !== false) {
            gatesPassed = false;
            throw new Error(
              gateRatchet?.violation || `GATE_FAILED: required gate "${gate.id}" failed (exit ${execRes.exitCode})`,
            );
          }
        }
      }

      // 10. Run coordinator-private lane/mission holdouts & ratchets inside -integrate.
      const consumedHoldoutKeys = new Set();
      for (const gate of m.gates || []) {
        consumedHoldoutKeys.add(`gate:${gate.id}`);
        consumedHoldoutKeys.add(gate.id);
      }

      for (const lane of effectiveLanes) {
        const laneHoldout = runHoldouts ? (holdoutMap[`lane:${lane.id}`] || holdoutMap[lane.id] || null) : null;
        if (holdoutMap[`lane:${lane.id}`]) consumedHoldoutKeys.add(`lane:${lane.id}`);
        if (holdoutMap[lane.id]) consumedHoldoutKeys.add(lane.id);

        const combinedSpec =
          lane.ratchet || laneHoldout
            ? { ...(lane.ratchet || {}), ...(laneHoldout || {}) }
            : null;
        if (!combinedSpec) continue;

        let holdoutExitCode = null;
        let holdoutMetrics = null;
        if (runHoldouts && combinedSpec.holdoutCmd) {
          const hScratch = laneScratchEnv(m.slug || m.id, `integrate-holdout-${lane.id}`);
          const hRes = await runWithCompute(combinedSpec.holdoutCmd, {
            cwd: integrateWt,
            offload: lane.offload || "auto",
            timeoutMs,
            env: hScratch,
            runner: computeRunner,
            lockDir,
            aipcScript,
            devinBridge,
          });
          holdoutExitCode = hRes.exitCode;
          const ext = extractOverdriveMetrics(hRes.stdout);
          if (ext.ok) holdoutMetrics = ext.metrics;
          else if (hRes.exitCode === 0 && (combinedSpec.holdoutMetrics || combinedSpec.holdoutMetricsSpec || ext.code !== "METRICS_MISSING")) {
            throw new Error(ext.error || `METRICS_INVALID_JSON: lane "${lane.id}" holdout emitted invalid metrics`);
          }
        }

        let evalRes;
        if (Array.isArray(combinedSpec.metrics) && combinedSpec.metrics.length > 0) {
          let primaryMetrics = lane.lastVerify?.ratchet?.metrics || null;
          let primaryStdout = "";
          let primaryExit = 0;
          if (!primaryMetrics) {
            const lScratch = laneScratchEnv(m.slug || m.id, `integrate-lane-${lane.id}`);
            const lRes = await runWithCompute(lane.verifyCmd, {
              cwd: integrateWt,
              offload: lane.offload || "auto",
              timeoutMs,
              env: lScratch,
              runner: computeRunner,
              lockDir,
              aipcScript,
              devinBridge,
            });
            primaryStdout = lRes.stdout;
            primaryExit = lRes.exitCode;
          }
          evalRes = evaluateRatchet(combinedSpec, {
            stdout: primaryStdout,
            exitCode: primaryExit,
            metrics: primaryMetrics,
            holdoutExitCode,
            holdoutMetrics,
          });
        } else {
          const okHoldout = holdoutExitCode === null || holdoutExitCode === 0;
          evalRes = {
            ok: okHoldout,
            exitCode: holdoutExitCode ?? 0,
            metrics: holdoutMetrics || {},
            baseline: {},
            deltas: {},
            violations: okHoldout ? [] : [`HOLDOUT_FAILED: lane "${lane.id}" holdout exited with ${holdoutExitCode}`],
            violation: okHoldout ? null : `HOLDOUT_FAILED: lane "${lane.id}" holdout exited with ${holdoutExitCode}`,
            holdoutConfigured: Boolean(combinedSpec.holdoutCmd || combinedSpec.holdoutMetrics || combinedSpec.holdoutMetricsSpec),
            holdoutPassed: holdoutExitCode === null ? null : okHoldout,
            spec: stripPrivateRatchetFields(combinedSpec),
          };
        }

        ratchetChecks.push(evalRes);
        if (!evalRes.ok) {
          throw new Error(evalRes.violation || `RATCHET_FAILED: lane "${lane.id}" failed ratchet/holdout`);
        }
      }

      if (runHoldouts) {
        for (const [k, spec] of Object.entries(holdoutMap)) {
          if (consumedHoldoutKeys.has(k) || !spec || typeof spec !== "object") continue;
          let hExit = null;
          let hMetrics = null;
          if (spec.holdoutCmd) {
            const mScratch = laneScratchEnv(m.slug || m.id, `integrate-holdout-${k}`);
            const hRes = await runWithCompute(spec.holdoutCmd, {
              cwd: integrateWt,
              offload: spec.offload || "auto",
              timeoutMs,
              env: mScratch,
              runner: computeRunner,
              lockDir,
              aipcScript,
              devinBridge,
            });
            hExit = hRes.exitCode;
            const ext = extractOverdriveMetrics(hRes.stdout);
            if (ext.ok) hMetrics = ext.metrics;
            else if (hRes.exitCode === 0 && (spec.holdoutMetrics || spec.holdoutMetricsSpec || ext.code !== "METRICS_MISSING")) {
              throw new Error(ext.error || `METRICS_INVALID_JSON: holdout "${k}" emitted invalid metrics`);
            }
          }
          let evalRes;
          if (Array.isArray(spec.metrics) && spec.metrics.length > 0) {
            evalRes = evaluateRatchet(spec, {
              exitCode: 0,
              metrics: hMetrics || {},
              holdoutExitCode: hExit,
              holdoutMetrics: hMetrics,
            });
          } else {
            const okHoldout = hExit === null || hExit === 0;
            evalRes = {
              ok: okHoldout,
              exitCode: hExit ?? 0,
              metrics: hMetrics || {},
              baseline: {},
              deltas: {},
              violations: okHoldout ? [] : [`HOLDOUT_FAILED: "${k}" exited with ${hExit}`],
              violation: okHoldout ? null : `HOLDOUT_FAILED: "${k}" exited with ${hExit}`,
              holdoutConfigured: Boolean(spec.holdoutCmd || spec.holdoutMetrics || spec.holdoutMetricsSpec),
              holdoutPassed: hExit === null ? null : okHoldout,
              spec: stripPrivateRatchetFields(spec),
            };
          }
          ratchetChecks.push(evalRes);
          if (!evalRes.ok) {
            throw new Error(evalRes.violation || `HOLDOUT_FAILED: "${k}" failed`);
          }
        }
      }

      ratchetResult = combineRatchetResults(ratchetChecks);
      if (ratchetResult) {
        const vr = validateRatchetResult(ratchetResult);
        if (!vr.ok) {
          throw new Error(`CONTRACT_INVALID: ${vr.errors.join("; ")}`);
        }
      }

      integratedCommit = gitText(integrateWt, ["rev-parse", "HEAD"]).trim();

      // 11. Promote to repoRoot ONLY if 100% passed AND promoteToRepoRoot.
      if (promoteToRepoRoot) {
        const currentMissionState = store.getMission(m.id);
        const gatesToVerify = currentMissionState?.gates || m.gates || [];
        if ((!runGates || gateId) && gatesToVerify.some((g) => g.required !== false && g.status !== "passed")) {
          gatesPassed = false;
          throw new Error(
            "UNVERIFIED_GATES: cannot promoteToRepoRoot while required gates have not passed.",
          );
        }
        if (!runHoldouts && Object.keys(loadPrivateHoldout(m.id, null) || {}).length > 0) {
          throw new Error(
            "UNVERIFIED_HOLDOUTS: cannot promoteToRepoRoot with runHoldouts=false when private holdouts are configured.",
          );
        }
        const curHead = gitText(m.repoRoot, ["rev-parse", "HEAD"]).trim();
        if (curHead !== preIntegrateHead) {
          throw new Error(`REPO_HEAD_MOVED: repoRoot HEAD moved from ${preIntegrateHead} to ${curHead} during integration.`);
        }
        const ff = runGit(m.repoRoot, ["merge", "--ff-only", integratedCommit], { allowFail: true });
        if (ff.status !== 0) {
          throw new Error(`FF_ONLY_FAILED: ${(ff.stderr || ff.stdout || "").trim()}`);
        }
        fastForwarded = true;
      }
    } catch (err) {
      failureError = err?.message || String(err);
      if (!ratchetResult && ratchetChecks.length > 0) {
        ratchetResult = combineRatchetResults(ratchetChecks);
      }
    } finally {
      if (createdWorktree && existsSync(integrateWt)) {
        const unmounted = unmountAllJunctions(integrateWt);
        const rmWt = runGit(m.repoRoot, ["worktree", "remove", "--force", integrateWt], { allowFail: true });
        if (rmWt.status !== 0 && existsSync(integrateWt)) {
          rmSync(integrateWt, { recursive: true, force: true });
        }
        runGit(m.repoRoot, ["worktree", "prune"], { allowFail: true });
        cleanupInfo = {
          removed: !existsSync(integrateWt),
          worktreePath: integrateWt,
          junctionsUnmounted: unmounted,
        };
      }
    }

    const ok = failureError === null;
    let laneWorktreesCleaned = null;
    if (ok) {
      store.recordEvent(m.id, "coordinator", "integration_verified", {
        preIntegrateHead,
        integratedCommit,
        fastForwarded,
        mergedLanes,
        seamMergeApplied,
        gatesPassed,
        ratchetOk: ratchetResult ? ratchetResult.ok : null,
      });
      const refreshed = store.getMission(m.id);
      const allReqGatesPassed = !refreshed?.gates?.length || refreshed.gates.every((g) => !g.required || g.status === "passed");
      if (allReqGatesPassed) {
        store.setMissionState(m.id, "completed", { integratedCommit, fastForwarded });
      }
      if (shouldCleanupLanes) {
        laneWorktreesCleaned = cleanupWorktrees(store, m.id);
      }
    } else {
      store.recordEvent(m.id, "coordinator", "integration_failed", {
        preIntegrateHead,
        integratedCommit: null,
        fastForwarded: false,
        mergedLanes,
        seamMergeApplied,
        gatesPassed,
        error: failureError,
      });
    }

    return {
      ok,
      missionId: m.id,
      integrateWorktree: integrateWt,
      preIntegrateHead,
      integratedCommit: ok ? integratedCommit : null,
      fastForwarded,
      mergedLanes,
      seamMergeApplied,
      gatesPassed,
      ratchetResult,
      cleanup: cleanupInfo,
      ...(laneWorktreesCleaned ? { laneWorktreesCleaned } : {}),
      ...(failureError ? { error: failureError, violation: failureError } : {}),
    };
  });
}

