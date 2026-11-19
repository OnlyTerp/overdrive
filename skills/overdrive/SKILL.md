---
name: overdrive
description: >-
  End-to-end flagship build pipeline (v0.3.1) fusing cloud-first multi-subscription routing,
  Pod-Tournament ADHD deep thinking, seam/region extraction, metric ratchets with coordinator
  holdouts, scratch-isolated parallel swarm execution, atomic trial-merge integration, and
  ratcheted self-improving RSI. Use when the user says "run overdrive", "hyperbuild",
  "think then swarm", or starts a major new app, rewrite, architecture overhaul, or feature.
---

# Overdrive v0.3.1: Cloud-First Think -> Freeze -> Swarm -> Integrate -> Ratchet -> RSI

Overdrive v0.3.1 is a **7-stage closed-loop orchestration engine** backed by SQLite (`~/.overdrive/data/overdrive.sqlite`), **17 `overdrive_*` MCP tools**, CLI commands (`overdrive ...`), and Studio Mission Control (`overdrive studio`).

## Core Invariants (Enforced Mechanically)
1. **Cloud-first & quota-aware routing (`routingWarnings` never hidden)**: Free capacity (`swe-2`, `swe-2-flash`, `Dots`, `Muse AI`) runs first; account selection respects `ACCOUNT_ROUTER.py` 24h observation freshness + `>80%` window caps + `team_cli.py brief` numeric window overlays, while `local_cli_free_unless_denied` keeps free local `devin` usable unless denied and surfaces explicit `routingWarnings` / `degradedAccounts` across MCP, CLI, API, and Studio UI.
2. **Think before coding**: Hard architecture, seam partitions, and gates come from zero-tool `adhd` (`goal_loop_*`) runs — orchestrated via `overdrive_pod_plan` (`overdrive pod-plan`) for 1–40 thinker Pod-Tournament + Cross-Family Apex panels.
3. **Zero-collision ownership (globs + monolith regions)**: Every lane owns disjoint `ownedGlobs` OR exclusive `ownedRegions` (`{ path, startAnchor, endAnchor, boundaryMode: "exclusive" }`) anchored against frozen SHA-256 `sharedContracts`.
4. **Private holdouts & anti-leakage**: Coordinator-private `holdoutCmd` / `holdoutEnv` / `holdoutMetrics` are stripped via `stripPrivateRatchetFields` / `toPublicRatchetSpec` before briefs, store checkpoints, or UI state are serialized.
5. **Strict-local privacy & honest ratcheted RSI**: Intention mining runs strictly local read-only (`privacyMode: "strict_local"`), emits stale-ledger warnings when `ledger.sqlite` is >48h old, filters unrelated Grok X-search noise from Overdrive routing candidates, keeps `went_quiet >= 72h` projects strictly as `owner_question` (`autoDispatch: false`), and never fakes cross-family model audits (`evaluated_pending_audit` requires a real `overdrive_rsi_audit` or `runCrossFamilyAudit: true` execution before `overdrive_rsi_promote`).

---

## Stage 0: Cloud-First Multi-Subscription Routing & Assistants
Choose routing mode in `overdrive_create` (`single-harness`, `playbook-auto`, or `mix-and-match`) and inspect assistant state via `overdrive_assistants` (`overdrive assistants`):
- **Free pools first**: `devin` (`swe-2-flash`, `swe-2`, plus `devin-vm` offload), `codex` Dots/Astra, and `muse` (`muse-ai`) absorb high-volume execution and research before spending paid subscription quota.
- **Cloud-agent & multi-account fleet**: Route across `claude-cloud` via `omp:1..3`, `codex-cloud`, `devin-vm`, and `copilot-cloud`.
- **Quota & Account Router guards**: Consult `ACCOUNT_ROUTER.py` and `overdrive_assistants` before dispatching scarce accounts; observations older than 24h or accounts above `>=80%` utilization stay excluded and surface in `routingWarnings`.
- **Hard policy bans**: Never select `kimi-*` or pay-per-call routes (`lithos`, `inco`, `makora`, `friendli`, `nanogpt`), and never route `google-antigravity` models (`gemini-4-*`) through OMP or external harnesses.

## Stage 1: Pod-Tournament ADHD Deep Thinking (`overdrive_pod_plan`)
When designs or partitions are not yet settled:
1. Check `overdrive_status({ includeAdhdSessions: true, includeRsi: true })` or generate a 1–40 thinker schedule via `overdrive_pod_plan` (`overdrive pod-plan --goal "..." --thinkers 12`).
2. For large **6–40 thinker** architectural runs, `overdrive_pod_plan` organizes thinkers into **pods of 4–6 thinkers**, each pod paired with its own pod tracker synthesizing pod consensus, followed by a **4-judge Cross-Family Apex** panel emitting `{ sharedContracts, lanes, ownedRegions, gates, ratchet }`.
3. Monitor reactively with `schedule` timers, answer `[HOST?]` prompts via `goal_loop_evidence`, drain with `LAST ROUND / CONSOLIDATE NOW`, and export via `goal_loop_export`.

## Stage 2 & 2.5: Seam Extraction, `ownedRegions` & Metric Ratchets
1. **Monolith seam extraction**: Assign disjoint `ownedRegions` (`{ path, startAnchor, endAnchor, boundaryMode: "exclusive" }`) when parallel lanes touch shared monoliths. `validateTopology` mechanically rejects duplicate anchors and glob-vs-region overlaps.
2. **Metric ratchets & coordinator-private holdouts**: Attach `ratchet` specs (`metrics` with `>=`, `<=`, `==`, `delta>=`, `delta<=`, optional `coverageFloor`, and coordinator-private `holdoutCmd`). `overdrive_plan` strips private holdouts so workers never see holdout commands or secrets.

## Stage 3 & 4: Scratch Isolation, Cloud Dispatch (`dryRun`) & SHA-256 Patch Ingest (`runVerify`)
1. Call `overdrive_freeze({ missionId, provisionWorktrees: true })` to lock `freezeCommit`, SHA-256 contract digests, and isolated `~/.overdrive/worktrees/<repo>/<slug>-<lane>` worktrees.
2. **Scratch & cleanup hygiene**: Keep `TEMP`/`TMP` pointed at isolated per-lane scratch under `~/.overdrive/config.json` `scratchDir` (default `os.tmpdir()/overdrive`), configure `ignoreUntrackedGlobs` for disposable build artifacts, and use `unmountJunctionSafe` before removing worktrees containing junctions.
3. **Single-attempt billed cloud dispatch + `dryRun`**: Preview secret scanning, ledger collision checks, and command construction with `overdrive_cloud_spawn({ ..., dryRun: true })` before live dispatch. Live `provider: "devin-vm"` executes cleanly through the configured `devinVmBridge` and always archives its VM; billed cloud spawns write a single-attempt ledger record (no blind retries without `forceRetry: true`).
4. **SHA-256 `.patch` ingest**: Bring cloud/VM outputs back via `overdrive_ingest_patch({ missionId, laneId, patchPath, expectedSha256, runVerify: true })` to verify SHA-256, apply cleanly, and run `auditAndVerifyLane`.

## Stage 5: Atomic Trial-Merge Integration (`overdrive_integrate`), `aipc auto` & Cross-Family Review
1. Verify individual lanes via `overdrive_verify` (`offload: "auto"` dispatches through `aipc.py auto` when available so heavy tests run off your PC automatically).
2. Execute atomic trial-merge & holdout ratchet gating via `overdrive_integrate` (`laneIds`, `gateId`, `cleanupWorktrees`, `runGates`, `runHoldouts`, `promoteToRepoRoot`) or CLI `overdrive integrate --mission <id> [--lanes a,b] [--gate <id>] [--cleanup]`.
3. Maintain cross-family review (`auditorFamily !== worker.family`) across every lane and gate; escalate genuine design/contract failures back to ADHD via `overdrive_escalate`.

## Stage 6: Honest Continuous Self-Modernizing RSI (`overdrive rsi`)
1. **Strict-local intention mining (`mineIntentionDigest`)**: Reads your locally configured ledger/memory/drift/research sources (`~/.overdrive/config.json`) **read-only** (`privacyMode: "strict_local"`), emits `>48h` stale-ledger `driftAlerts`, applies 30d recent friction windows tagged by `harness`/`project`, excludes unrelated X-search noise from Overdrive routing candidates, and keeps `went_quiet >= 72h` projects strictly as `owner_question` (`autoDispatch: false`).
2. **Continuous + Golden Benchmark**: `checks/rsi-benchmark.mjs` checks all 5 zero-regression invariant dimensions (`100/100`) alongside continuous `operationalMetrics` (`operationalScore`, `compositeScore`, latencies, offload/first-pass/fallback rates).
3. **Honest audit & isolated trial-merge promotion**:
   - `overdrive_rsi_cycle` runs deterministic local checks (`evaluated_pending_audit`, `modelExecuted: false`) unless `runCrossFamilyAudit: true` executes an actual cross-family audit via `connect-anything`.
   - External/peer cross-family reviews submit receipts via `overdrive_rsi_audit` (`POST /api/rsi/candidates/:id/audit`).
   - `overdrive_rsi_promote` fails closed unless `audit.modelExecuted === true`, Tier B has `humanApproved: true`, `touchesHarness === false`, and `regressions === 0`. Pass `applyGitMerge: true` to execute an isolated trial-merge benchmark + `git merge --ff-only` (`mergeState: "merged_ff_only"` vs `"approved_only_no_git_merge"`), and `overdrive_rsi_rollback` to restore `prePromoteCommit`.
