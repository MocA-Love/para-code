# Office Viewer 検証台帳

## Task 2 監査時点

- 監査基点: `0e123d9598d9c098e7c6f6dc082a858524301eb7`
- matrix checker: `/Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md`
- 実機ランタイム: 未実施。Desktop / Web / Remote / Mobile への接続、画面操作、スクリーンショットはこのTaskの証跡に含めない。
- 判定: 実機runtimeが未実行のため `implemented` は使用しない。各 `safe-fallback` 行はaction/reasonを構造化しており、checkerがrowごとに検証する。

## 安全フォールバックの行動

新経路の実機証跡がない行は、一律の文言ではなくmatrixの`action`へ従う。`legacy-preview`は既存の読み取り専用preview、`diagnostic`は種類・理由を示して意味差分を確定しない表示、`explicit-unavailable`は必要な接続または既存エディタを案内する表示である。`reason`は未実行という事実ではなく、`fail-closed`、`no-unsupported-projection`、`no-external-fetch`、`no-semantic-claim`の製品ポリシーを示す。外部取得・マクロ・OLE・ActiveXの実行は行わない。これは仕様34節のruntime kill switch、および27.1節のsilent omission禁止に従う暫定分類である。

## 既存ソース証跡（実行結果ではない）

次のテスト・fixtureはリポジトリに存在するが、Task 2では再実行していない。よってmatrixでは `not-run:` と記録した。

- `src/vs/paradis/contrib/fileViewers/test/integration/paradisOfficeDualRead.test.ts` の `preserves legacy spreadsheet values, styles, and effective base diagonal semantics while auditing unchanged overlays` は `common/fixtures/task2-diagonal-border.xlsx` を使う。
- 同テストは `common/fixtures/task2-drawing-line.docx` を使い、表罫線とDrawing lineを別の対象として扱う。
- `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeSanitizer.test.ts` の `preserves line, shape, anchor, transform, and diagonal-border geometry while blocking a DrawingML asset` はgeometryの保持とunsafe assetの遮断を別々に検証する。

これらはraw/effective diagonal一般のランタイム保証ではない。前者fixtureと上記の個別テストが覆う範囲だけをソース証跡として扱う。

## Commit 検証規則

checkerは各行のcommitが現在の`HEAD`の祖先であることを `git merge-base --is-ancestor <sha> HEAD` で検証する。台帳に個別のTask列挙がない既存commitも、この祖先性を満たす限り検証可能な既存証跡として扱う。例: `f516d5d52f5` と `aa7a5be4791`。祖先でないSHA、`pending`、空欄は拒否する。

## 次の検証Gate

Task 3以降でfixture/unit/runtimeを実行した後に、該当行だけを `implemented` へ更新する。runtime未確認のままの行は `safe-fallback` を維持する。policyにより提供しない機能は、具体的なUI行動とpolicy理由を記録して `intentional-unsupported` にする。

## Task 3 対象検証（2026-08-28）

- 検証SHA: `c5f12e3d28a09c33d9f65a3ff061fdf0c020667f`
- 比較基点: `c5f12e3d28a09c33d9f65a3ff061fdf0c020667f`（検証SHAと同一。失敗の再現はこの直接の基点で行った。）
- 実行環境: Node `24.18.0`。以下の実行はすべて `rtk` を経由した。実機runtimeは実行していないため、matrixのruntime状態は変更しない。

| 対象 | 実行コマンド | 開始 | 終了 | exit | 件数 | 警告・失敗 |
| --- | --- | --- | --- | ---: | --- | --- |
| client transpile | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run transpile-client` | `2026-08-28T07:36:11+0900` | `2026-08-28T07:36:26+0900` | 0 | 9,227 files found; 2,571 resources copied | npm unknown project config 6件（`disturl`, `target`, `ms_build_id`, `runtime`, `build_from_source`, `timeout`） |
| complete Office glob | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'` | `2026-08-28T07:33:05+0900` | `2026-08-28T07:34:01+0900` | 1 | 958 passing; 1 pending; 2 failing | 下記の基点再現。npm unknown project config 6件、Node `DEP0180`、Electron renderer `vm` 非対応2件、Sentry native stacktrace binary未検出、`DEP0040`、`DEP0025`、WASI experimental warning |
| mobile Office tests（指定2パス） | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm test -- src/components/fileViewer.test.tsx src/components/officeCapability.test.ts`（`app/mobile`） | `2026-08-28T07:34:10+0900` | `2026-08-28T07:34:19+0900` | 0 | 1 test file / 12 tests passed | Vite CJS Node API deprecated。指定した `src/components/fileViewer.test.tsx` はこのSHAに存在せず、Vitestは警告なしで `officeCapability.test.ts` のみを検出した。2ファイルの成功としては扱わない。 |
| client typecheck | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck-client` | `2026-08-28T07:34:24+0900` | `2026-08-28T07:34:44+0900` | 0 | TypeScript diagnostics 0 | npm unknown project config 6件 |
| client layer validation | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run valid-layers-check` | `2026-08-28T07:34:47+0900` | `2026-08-28T07:35:27+0900` | 0 | `layersChecker` と `layersTypeCheck` のdiagnostics 0 | npm unknown project config 6件 |
| mobile typecheck | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck`（`app/mobile`） | `2026-08-28T07:35:46+0900` | `2026-08-28T07:35:58+0900` | 2 | TS2532 13件 | 下記の基点再現 |

### 失敗の基点再現

この検証worktreeのHEADは比較基点 `c5f12e3d28a09c33d9f65a3ff061fdf0c020667f` そのものであり、Office globの上記実行とmobile typecheckの再実行（`2026-08-28T07:35:46+0900`--`2026-08-28T07:35:58+0900`, exit 2）は直接この基点で行った。したがって、以下はTask 3のドキュメント差分起因ではない既知の基点失敗として記録する。修正は行わない。

- Office glob: `ParadisOfficeChannel` の2件。`resolves a local descriptor to bytes and runs package inspection only in the worker` は `engineCrashed` のため `ok: true` を満たさず、`uploads a Task 3 sealed spool and resolves only descriptor state into Task 5 worker bytes` も `false !== true`。集計は 958 passing / 1 pending / 2 failing。
- mobile typecheck: `src/relayClientPresence.test.ts` の 106, 107, 108, 110, 117, 118, 120, 128, 129, 134, 135, 140, 141 行に `TS2532: Object is possibly 'undefined'`（13件）。
