# Office Viewer Integration and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新Kernel/Adapterをdefaultへ切り替え、監査matrix、性能・security・実機・レビューをcloseし、main向けDraft PRを作成する。

**Architecture:** dual-read/shadowの差を解消してsubfeatureを順に有効化し、legacy runtime fallbackを残したまま全platformを検証する。Product AcceptanceとDelivery Checklistを独立して監査する。

**Tech Stack:** VS Code build/test、launch skill、Playwright、Git/Gh CLI、performance harness、security fixtures。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md` sections 24-28, 34-36.

## Global Constraints

- Critical/Importantレビュー指摘が残る状態でdefaultをv1にしない。
- mainとのconflictは勝手に解消しない。
- `--no-verify`を使用しない。
- PR作成前にremote main、branch、diff、test証跡を再取得する。
- Draft PR本文を日本語、絵文字なし、PR template準拠で作成する。

---

## Exact Verification Commands

Use `/Users/magu/.local/bin/mise exec node@24.18.0 --` for every Node/npm command.

| Task | Command | Expected RED/Pass |
|---|---|---|
| 1 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/integration/paradisOfficeDualRead.test.ts` | RED: v1/default switch assertions fail; GREEN: pass |
| 2 | `node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md` | RED until every required column/evidence is populated; GREEN exit 0 |
| 3 | `npm run transpile-client`; `./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'`; `npm run typecheck-client`; `npm run valid-layers-check`; `cd app/mobile && npm test -- src/components/fileViewer.test.tsx src/components/officeCapability.test.ts && npm run typecheck` | all exit 0 |
| 4 | `./scripts/test.sh --run src/vs/paradis/contrib/fileViewers/test/performance/paradisOfficePerformance.test.ts`; `node --expose-gc out/vs/paradis/contrib/fileViewers/test/performance/paradisOfficeMemory.test.js`; `node out/vs/paradis/contrib/fileViewers/test/visual/paradisOfficeVisualGolden.js` | spec thresholds pass |
| 5-6 | launch/browser/mobile/remote commands recorded verbatim in verification doc | every required matrix cell has evidence |
| 7 | four reviewer reports | Critical/Important 0 |
| 8 | repeat Task 3/4 commands after final docs/changelog change | all exit 0 |
| 9 | `git log --format='%H %s' origin/main..HEAD`; matrix SHA checker; `gh pr view` | branch/matrix/PR consistent |

### Task 1: Dual-Read Difference Gate and Default Switch

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/test/integration/paradisOfficeDualRead.test.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeConfiguration.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetViewer.contribution.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxViewer.contribution.ts`
- Modify: `src/vs/paradis/contrib/fileViewers/browser/paradisOfficeBrowser.contribution.ts`

**Interfaces:**
- Consumes: legacy/v1 outputs and diagnostics

- [ ] **Step 1: Write failing dual-read tests**

For existing supported fixture corpus, assert v1 preserves legacy visible values/styles and intentionally adds diagnostics/diffs only where audit matrix expects. Assert `engine=legacy` bypasses all v1 render/diff/search/print.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Resolve unexpected differences and enable flags in order**

Enable Kernel shadow, semantic Spreadsheet, virtualized Spreadsheet, semantic Word, platform backend, search/print only after each track review gate.

- [ ] **Step 4: Set product default to v1 with runtime legacy kill switch**

- [ ] **Step 5: Verify GREEN and commit**

Commit: `feat(office): enable semantic viewer pipeline`.

### Task 2: Close Audit Acceptance Matrix

**Files:**
- Modify: `docs/office-viewer-acceptance-matrix.md`
- Create: `docs/office-viewer-verification.md`
- Create: `scripts/check-office-matrix.ts`
- Modify: `docs/report-officee.html`
- Modify: `docs/report-office-mock.html`

**Interfaces:**
- Produces: requirement→commit→test→runtime evidence mapping

- [ ] **Step 1: Audit every matrix row**

For each A/B/C/D/additional row, inspect current code and test output. Status may be `implemented`, `safe-fallback`, or `intentional-unsupported`; every non-implemented row must identify explicit UI behavior and policy reason.

Start by running the checker and verify RED for missing ownerTask/behavior/fixture/unit/runtime/status/commit fields. Implement the checker to parse the Markdown table, validate allowed statuses and branch SHAs, and reject blank evidence.

- [ ] **Step 2: Reject unsupported completion claims without evidence**

No row closes from source intent or agent summary alone. Record exact test name and runtime evidence location.

- [ ] **Step 3: Update report/mock current-state labels and target-state status**

Keep historical findings, add completion commit/test notes, remove stale claims such as mobile Excel Diff absence.

- [ ] **Step 4: Commit docs evidence**

Commit: `docs(office): close viewer audit matrix`.

### Task 3: Full Targeted Verification

**Files:**
- Modify: `docs/office-viewer-verification.md`

- [ ] **Step 1: Fresh transpile**

Run: `mise exec node@24.18.0 -- npm run transpile-client`.

- [ ] **Step 2: Run complete Office test glob**

Run: `mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'`.

- [ ] **Step 3: Run mobile Office tests**

Run: `cd app/mobile && /Users/magu/.local/bin/mise exec node@24.18.0 -- npm test -- src/components/fileViewer.test.tsx src/components/officeCapability.test.ts`。Expected: Vitest exits 0.

- [ ] **Step 4: Run type and layer validation**

Run `mise exec node@24.18.0 -- npm run typecheck-client`. Run `mise exec node@24.18.0 -- npm run valid-layers-check` because new common/node/browser/remote boundaries are introduced. Run `cd app/mobile && mise exec node@24.18.0 -- npm run typecheck`.

- [ ] **Step 5: Record command, SHA, exit code, counts, warnings**

Do not summarize a partial command as full coverage.

### Task 4: Security and Performance Gates

**Files:**
- Create: `src/vs/paradis/contrib/fileViewers/test/performance/paradisOfficePerformance.test.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/performance/paradisOfficeMemory.test.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/visual/paradisOfficeVisualGolden.ts`
- Create: `src/vs/paradis/contrib/fileViewers/test/visual/fixtures.json`
- Modify: `docs/office-viewer-verification.md`

- [ ] **Step 1: Run security boundary fixtures**

Run hard limits ±1, per-entry/container ratio, XXE, traversal, relationship cycle, unsafe SVG/font, macro/OLE asset denial, external URL, malicious filename, worker deadline/crash.

- [ ] **Step 2: Run deterministic performance harness**

Use fixed seed/fixture hashes for small, 100k cell, 5M cell, 16,384-column, 200-page cases. Record first usable paint, parse/diff terminal time, IPC bytes, live DOM, worker/cache/spool peak, cancellation latency.

Run performance tests with `--expose-gc`; assert handle count 0 after close, run three forced GC cycles, assert snapshot retained objects 0 and heap<=baseline+20MiB.

- [ ] **Step 3: Run visual golden harness**

Run `paradisOfficeVisualGolden.ts` with fixture hash and per sheet/page/object masks. Require <=0.5% diff per region and fail any missing required landmark regardless of global white space.

- [ ] **Step 4: Validate spec thresholds**

Required: small <=110% baseline, live DOM<=10k, initial IPC<=2MiB, extreme terminal outcome<=60s parse/90s diff, cancel<=250ms, no required landmark missing.

- [ ] **Step 5: Record hardware/runtime and commit harness**

Commit: `test(office): add security and performance gates`.

### Task 5: Desktop Runtime Verification with Launch Skill

**Files:**
- Modify: `docs/office-viewer-verification.md`
- Store screenshots under a task-owned ignored artifact directory; do not commit transient profiles.

- [ ] **Step 1: Launch isolated Para Code profile**

Use the `launch` skill and unique ports. Open representative Excel/Word fixtures.

- [ ] **Step 2: Verify Excel View/Diff**

Check numFmt, formula/cache/type inspector, CF, comments/links, hidden sheets, row/column insertion, freeze, virtualization, chart/pivot placeholder, search, print, keyboard/high contrast.

- [ ] **Step 3: Verify Word View/Diff**

Check Header/Footer/notes/comments/textbox, image binary, style/theme, table/list, OMML, fields, revisions, DrawingML/SmartArt/chart/OLE placeholder, search, print, Final/Original/Markup.

- [ ] **Step 4: Verify lifecycle**

Rapid switch, cancel, watcher burst, file delete/recreate, blank retry, view state restore, legacy kill switch.

- [ ] **Step 5: Record exact build SHA, platform, actions, screenshots**

### Task 6: Web, Remote, Git, and Mobile Runtime Matrix

**Files:**
- Modify: `docs/office-viewer-verification.md`

- [ ] **Step 1: Web**

Verify Excel/Word View/Diff worker path, unsupported diagnostic formats, worker unavailable fallback, CSP/network 0 external requests.

- [ ] **Step 2: Remote**

Verify v1 remote backend and simulated v0 bounded local spool, revision race, disconnect/reconnect, runtime flag negotiation.

- [ ] **Step 3: Git**

Verify HEAD→index, index→working, stage refresh, rename/delete, side missing, LFS pointer, immutable commit.

- [ ] **Step 4: Mobile**

Verify old/new compatibility, connected Excel View/Diff, Word View/Diff relay, standalone explicit fallback, CSP/navigation denial.

- [ ] **Step 5: Record matrix evidence**

### Task 7: Independent Final Reviews

**Files:**
- Modify only files required by accepted findings.

- [ ] **Step 1: Dispatch four independent reviewers**

Review `origin/main...HEAD` for code quality, security, architecture, and regression/test completeness. Reviewers are read-only and do not dispatch subagents.

- [ ] **Step 2: Classify findings with file:line evidence**

- [ ] **Step 3: Fix Critical/Important with original implementer**

- [ ] **Step 4: Send fixes to the same reviewer for re-review**

- [ ] **Step 5: Continue until all four reviewers report Critical/Important 0**

### Task 8: Final Branch Audit and Changelog

**Files:**
- Modify: `src/vs/paradis/contrib/fileViewers/electron-browser/media/paradisChangelog.md`
- Modify: `docs/office-viewer-verification.md`

- [ ] **Step 1: Inspect worktree and diff**

Run `git status --short`, `git diff --check`, `git diff --stat origin/main...HEAD`, and inspect every changed file. Remove transient artifacts and unrelated changes.

- [ ] **Step 2: Update changelog and final matrix SHA references**

- [ ] **Step 3: Re-run verification commands after the final change**

- [ ] **Step 4: Commit**

Commit: `docs(changelog): record Office viewer completion`.

### Task 9: Synchronize Main and Create Draft PR

**Files:** none unless conflict resolution is explicitly approved.

- [ ] **Step 1: Fetch origin/main and compare merge base**

If main moved, attempt a non-mutating conflict forecast. If real conflict occurs, stop and ask the user; do not resolve automatically.

- [ ] **Step 2: Verify branch/head and existing PR**

Use `gh` against `MocA-Love/para-code`, not the upstream Microsoft repository.

Compare `git log --format='%H %s' origin/main..HEAD` with the matrix task/commit ledger. Validation is status-aware:

- `verified-existing`: commit must satisfy `git merge-base --is-ancestor <sha> HEAD`; it may be at or before `origin/main`.
- `implemented` / `safe-fallback` / `intentional-unsupported` created by this plan: commit must be in `origin/main..HEAD`.
- every branch commit must appear in the matrix task/commit ledger, including docs/plan/infrastructure commits; it need not be repeated in every requirement row.
- every matrix SHA must exist and be an ancestor of HEAD.

Fail delivery on any mismatch.

- [ ] **Step 3: Push branch**

Push only after all Product Acceptance evidence is current.

- [ ] **Step 4: Create or update main-targeted Draft PR**

PR body follows `.github/PULL_REQUEST_TEMPLATE.md` and includes overview, commit phases, audit matrix, test/runtime commands, performance/security, fallback limits, review outcomes. Assign the current Git user. No emoji.

- [ ] **Step 5: Verify PR state**

Confirm URL, base=`main`, head=`feat/office-viewer-complete`, draft=true, current HEAD SHA, checks started, and no unrelated commits.
