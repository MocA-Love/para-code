# Office Viewer / Diff Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excel/Wordの通常表示とDiffを、全Part検出・semantic比較・安全なplaceholder・platform別capabilityを備えたOffice Viewer Kernelへ移行する。

**Architecture:** 共通KernelがSource、bounded OPC inventory、outcome、worker、versioned IPCを所有し、Spreadsheet/Word Adapterが意味モデルと描画を提供する。表示とDiffは意味モデルを正本にし、旧経路をruntime kill switchとして単一PR内に残す。

**Tech Stack:** TypeScript、VS Code workbench/shared process/remote agent、Node Worker Threads、Web Worker、ExcelJS 4.4、JSZip 3.10、docx-preview、Mocha、Electron test runner。

**Spec:** `docs/superpowers/specs/2026-08-24-office-viewer-complete-design.md`

## Global Constraints

- Node.jsは`mise exec node@24.18.0 --`経由で実行する。
- `origin/main`基点、worktreeは`.worktrees/office-viewer-complete`、branchは`feat/office-viewer-complete`。
- macro、ActiveX、OLE、DDE、external relationshipを実行・自動fetchしない。
- Desktop budgetはcompressed 32MiB、expanded 256MiB、20,000 entries、entry/container ratio 200x。
- `No Changes`はterminal completeness、failed/omitted 0、semantic change 0の場合だけ表示する。
- 旧Editor ID、serializer、`parseWorkbook` channelを互換fallbackとして維持する。
- 1 commitは1つのreview可能なdeliverableとし、hookを回避しない。
- conflictが発生した場合は勝手に解消せずユーザーへ確認する。
- 各taskは失敗テスト、最小実装、対象テスト、review、commitの順で行う。

---

## Track Order

1. [Kernel Plan](2026-08-24-office-viewer-kernel.md)
2. Kernel contract freeze review
3. [Platform Plan](2026-08-24-office-viewer-platform.md) Task 1（runtime configuration）とTask 4（sanitizer/asset contract）
4. [Spreadsheet Plan](2026-08-24-office-viewer-spreadsheet.md) Tasks 1-6 と [Word Plan](2026-08-24-office-viewer-word.md) Tasks 1-6 を並列実行
5. Spreadsheet/Word core review gate
6. Platform Plan Tasks 2-8（Remote/Web/Mobile/Search/Print/A11y/Recovery）
7. Platform/security/a11y review gate
8. Spreadsheet/Word Task 7（UI統合）
9. Spreadsheet/Word UI review gate
10. [Integration and Delivery Plan](2026-08-24-office-viewer-integration.md)

## Required Review Protocol

各taskで実装担当とは別のsubagentを使い、次の2段階を実行する。

1. spec compliance review: interface、error/outcome、security、scope
2. code quality review: correctness、lifecycle、performance、tests

Critical/Importantを実装担当へ戻し、同じreviewerが再確認して0件になるまで次taskへ進まない。

各Taskの最終stepは、記載が「Verify GREEN and commit」と短縮されていても、必ず次の順に展開する。

- [ ] 対象testと最小compile/typecheckを実行してGREENを確認する。
- [ ] fresh spec-compliance reviewerへ、Spec・Task・差分・test結果を渡す。
- [ ] 別のcode-quality reviewerへ、correctness・lifecycle・performance・test qualityを渡す。
- [ ] Critical/Importantを実装担当が修正する。
- [ ] 同じreviewerが再確認し、Critical/Important 0を報告する。
- [ ] `git diff --check`とscope確認後にTask記載のmessageでcommitする。

## Standard Commands

```bash
/Users/magu/.local/bin/mise exec node@24.18.0 -- npm run transpile-client
/Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --run <src-test-file>
/Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'
/Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck-client
```

## Commit Sequence

各subplanのTaskとcommit messageの一対一対応を正本とする。Taskをまとめてsquashせず、全Taskは`task ID / commit SHA / reviewer / verification command`を`docs/office-viewer-acceptance-matrix.md`へ記録する。上位phase名はPR本文のgroupingにだけ使い、commit数を14件へ制限しない。

## Completion Evidence

- `docs/office-viewer-acceptance-matrix.md`の全行にstatus、commit、test、runtime evidenceがある。
- targeted tests、Office glob tests、typecheck、必要なlayer checkが成功する。
- launch skillによるDesktop Excel/Word View/Diffの証跡がある。
- Web、Remote、Mobile capability matrixをfixtureまたは実機で確認する。
- performance/security gateの数値結果を`docs/office-viewer-verification.md`へ記録する。
- 4観点の最終subagent reviewでCritical/Important 0。
- `git diff origin/main...HEAD`がOffice scopeだけを含む。
- main向けDraft PRが作成済み。

## Spec Coverage Map

| Spec area | Plan tasks |
|---|---|
| Kernel, inventory, source, outcome, budget, worker, IPC | Kernel Tasks 1-6 |
| Excel semantic, numFmt, CF, structures, objects | Spreadsheet Tasks 1-4 |
| Excel semantic Diff, alignment, virtualization, UI | Spreadsheet Tasks 5-7 |
| Word Story, styles, table/list, object semantics | Word Tasks 1-3 |
| Word matching/package Diff | Word Task 4 |
| Word render adapter, advanced objects, UI | Word Tasks 5-7 |
| Capability, extensions, remote/Git/Web/Mobile | Platform Tasks 1-5 |
| SVG/font/CSP security | Platform Task 4 |
| Search, print, accessibility, recovery, telemetry | Platform Tasks 6-8 |
| Flags, compatibility, audit closure, performance, runtime | Integration Tasks 1-6 |
| Independent reviews, branch audit, PR | Integration Tasks 7-9 |
