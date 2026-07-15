# 未保存エディターのスペーススコープ分離 実装計画

> 設計: `docs/superpowers/specs/2026-07-15-editor-unsaved-scope-design.md`

## Task 1: Editor Working Set opt-in primitives

対象:

- `src/vs/workbench/services/editor/common/editorGroupsService.ts`
- `src/vs/workbench/browser/parts/editor/editor.ts`
- `src/vs/workbench/browser/parts/editor/editorParts.ts`
- `src/vs/workbench/browser/parts/editor/editorGroupView.ts`
- `src/vs/workbench/common/editor/editorGroupModel.ts`
- editor tests

手順:

1. 除外serializeとretain/detachの失敗テストを追加する。
2. `EditorGroupModel.serialize(predicate)`を最小実装する。
3. EditorParts経由でpredicateをWorking Set保存へ伝播する。
4. 参照カウント式retainと確認なしdetachを実装する。
5. 通常Working Set、Side-by-side、最後の参照disposeを回帰確認する。

## Task 2: Backup Restore Router

対象:

- `src/vs/workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.ts`
- `src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts`
- working copy tests

手順:

1. providerなしrestore、defer、route変更再試行の失敗テストを追加する。
2. delayed singleton routerを実装する。
3. Backup Trackerへhandler保持とrouter filter/retryを実装する。
4. handled/deferred identifierの集合遷移と既定挙動を確認する。

## Task 3: Working Copy ownership ledger

対象:

- `src/vs/paradis/contrib/workspaceSwitch/common/paradisEditorScope.ts`
- pure tests

手順:

1. tuple identity、serialize/parse、legacy/corrupt、route、rekey、retireの失敗テストを追加する。
2. バージョン付きpure ledgerを実装する。
3. stateKey未確定時にrestore/claimしないことを確認する。

## Task 4: Scoped Live Working Set service

対象:

- `src/vs/paradis/contrib/workspaceSwitch/browser/paradisEditorScopeService.ts`
- `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.ts`
- Paradis tests

手順:

1. 対象分類、placement、transactional restoreの失敗テストを追加する。
2. BlockRestore starter、owner永続化、Working Copy listener、route providerを実装する。
3. capture/restoreをEditor opt-in primitives上に実装する。
4. Untitled、Scratchpad、dirty file、custom close handler、Side-by-side/Diff、複数group/selectionを確認する。

## Task 5: Workspace switch transaction

対象:

- `paradisWorkspaceSwitch.ts`
- `paradisWorkspaceSwitchService.ts`
- workspace switch tests

手順:

1. transaction順序、same-URI correction、失敗rollback、連打直列化の失敗テストを追加する。
2. saveをlive captureとserialized exclusionへ置換する。
3. folders/identity/live/panelを含むcommitとrollbackを実装する。
4. backup retryをcommit後へ接続する。

## Task 6: Scope retirement

対象:

- editor scope service
- workspace/worktree interfaces and services
- worktree removal action/view
- retirement tests

手順:

1. Save/Don't Save/Cancel、backup-only、自動missingの失敗テストを追加する。
2. preflight/cancel/commitを実装する。
3. repository removalとworktree removalを非同期化する。
4. 外部削除失敗時にcommitしないことを確認する。

## Task 7: Verification and review

1. 変更ファイルだけをformat/lint観点で確認する。
2. `npm run typecheck-client`を実行する。
3. 関連unit testsをNode 24で実行する。
4. layer validationとpre-commit hygieneを実行する。
5. `git diff --check`と差分自己レビューを行う。
6. Blocker/Highがあれば修正して再検証する。
7. 今回の変更だけを論理単位でstageし、コミットする。pushはしない。

## 計画自己レビュー

- production codeより先に各責務の失敗テストを置く。
- upstream core、Working Copy共通層、Para固有層の依存方向を分離した。
- 既存のterminal/browser/SCM retirement eventは置換せず、commit終端として維持する。
- リロード復元の競合はBlockRestore starterとRestored列挙の位相差で閉じる。
- 未コミットのモバイル変更とはファイル範囲が重ならない。
