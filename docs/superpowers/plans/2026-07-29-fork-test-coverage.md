# Para Code Fork Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Para Code の fork 固有機能に不足している回帰テストを追加し、製品コードを変更せずに実行結果を確認する。

**Architecture:** 既存の VS Code Mocha、app workspace の Vitest、Cloudflare Worker の Vitest を使う。純粋ロジック、サービス契約、パッケージ/CI スモークの順に保護し、外部境界だけを fake にする。

**Tech Stack:** TypeScript、Mocha、Sinon、Vitest、Cloudflare Workers、pnpm、GitHub Actions

## Global Constraints

- Para Code の製品コードは変更しない。
- テストが製品不具合を検出して失敗しても、製品コードを修正しない。
- テストの期待値を既存の誤動作へ合わせて緩めない。
- ソース文字列検索だけのテスト、検証対象そのもののモック、時間待ち依存のテストを追加しない。
- ファイル編集には `apply_patch` を使う。
- コミット、push、PR 作成は行わない。
- 各タスクは対象テストの単独実行と、可能な範囲の関連スイート実行まで行う。

---

## Task 1: Update Worker の feed 契約

**Files:**

- Create: `cloudflare/update-server/src/index.test.ts`
- Create: `cloudflare/update-server/vitest.config.ts`
- Modify: `cloudflare/update-server/package.json`
- Modify: `cloudflare/update-server/package-lock.json` または既存 lockfile

- [x] 不正 path が 404、Access JWT 欠損が 401、未公開/同一 commit が 204 になるテストを追加する。
- [x] macOS/Linux は semantic version、Windows は commit を `version` に使うことを確認する。
- [x] `name`、`notes`、`productVersion`、`sha256hash`、`timestamp` の契約を確認する。
- [x] KV key が `quality:platform` であることを fake KV で確認する。
- [x] `npm run typecheck` と `npm test` を実行する。

## Task 2: Desktop updater の認証ヘッダーと応答契約

**Files:**

- Create or modify tests under: `src/vs/platform/update/test/electron-main/`
- Test: `src/vs/platform/update/electron-main/abstractUpdateService.ts`
- Test: platform-specific updater files under `src/vs/platform/update/electron-main/`

- [x] feed request に Cloudflare Access の client id/secret が同時に付与されることを確認する。
- [x] 資格情報が片方だけの場合に半端な認証要求を送らないことを確認する。
- [ ] 204 は確認済み。不正 JSON、不完全な update payload は未確認。
- [ ] macOS/Windows/Linux 固有の version 伝播を、実ネットワークなしで確認する。
- [x] `npm run typecheck-client` の後に対象 Mocha テストを実行する。

## Task 3: 2次元ターミナルグリッド

**Files:**

- Create: `src/vs/sessions/contrib/terminalGrid/test/browser/sessionTerminalGridGroup.test.ts`
- Test: `src/vs/sessions/contrib/terminalGrid/browser/sessionTerminalGridGroup.ts`

- [ ] 上下左右の drop 判定と中央/境界の非 drop を確認する。
- [ ] 水平/垂直分割で terminal order と relative size が保持されることを確認する。
- [x] cell の remove、move、active instance 変更を確認する（resize は未確認）。
- [ ] 最後の cell、破棄済み instance、重複 drop の防御を確認する。
- [x] instance listener が remove/dispose 時に解放されることを確認する（dispose は製品挙動の失敗を検出、DOM grid cell は未確認）。
- [x] `npm run typecheck-client` の後に対象テストを実行する（12 passing、dispose 契約 1 failing）。

## Task 4: ファイルビューアー

**Files:**

- Modify: `src/vs/paradis/contrib/fileViewers/test/electron-browser/paradisSpreadsheetDiff.test.ts`
- Create tests under: `src/vs/paradis/contrib/fileViewers/test/browser/`
- Test: spreadsheet、PDF、DOCX、HTML、generic diff の production classes
- Create fixtures only under the matching `test/fixtures/` directory

- [x] malformed spreadsheet、空 workbook、複数 sheet、巨大入力の結果を確認する。
- [x] generic diff の両参照取得、片側失敗、dispose 時の参照解放を確認する。
- [x] HTML script policy、CSP、外部 URL、asset resolution を実際の viewer 入力で確認する。
- [ ] PDF/DOCX の拒否入力と上限境界を小さな fixture で確認する。
- [x] `npm run typecheck-client` は成功。browser/electron-browser 対象は TypeScript 直出力の CSS import 配信制約で未実行。

## Task 5: Mobile/Protocol/Relay と実 PC サービス契約

**Files:**

- Modify or create tests under: `app/protocol/test/`
- Modify or create tests under: `app/relay/test/`
- Modify or create tests under: `app/mobile/src/`
- Create or modify tests beside `src/vs/paradis/contrib/mobileRelay/`

- [x] app protocol と PC production codec/mux/crypto を直接つなぐ契約テストを追加する。
- [ ] 再接続、重複 frame、順序逆転、keepalive、認証失敗を確認する。
- [ ] file read/upload の path traversal と symlink 境界を確認する。
- [ ] WebRTC negotiation の offer/answer/ICE、timeout、Relay fallback を確認する。
- [ ] agent の parent session 変更が mobile state へ伝播することを確認する。
- [x] `pnpm -r typecheck` の後に `pnpm -r test` を実行する（36 files、201 tests）。
- [ ] PC 側の対象 Mocha テストを実行する。

## Task 6: Workspace Switch の中央統合

**Files:**

- Create or modify tests under: `src/vs/paradis/contrib/workspaceSwitch/test/`
- Test: workspace service、editor ownership、terminal ownership、restore coordination

- [x] workspace 切替で対象 workspace の editor と terminal ownership が分離・復元されることを確認する。
- [ ] 未保存 editor、split terminal、再起動復元、削除済み workspace を確認する。
- [ ] 切替の競合、途中 cancel、dispose 後 callback を確認する。
- [x] `npm run typecheck-client` は成功。対象テストは TypeScript 直出力の CSS import 配信制約で未実行。

## Task 7: Notifications/Aivis

**Files:**

- Create tests under: `src/vs/paradis/contrib/notifications/test/common/`
- Create tests under: `src/vs/paradis/contrib/notifications/test/node/`
- Create tests under: `src/vs/paradis/contrib/notifications/test/electron-browser/`

- [x] ringtone lookup、filename、template placeholder の未知/重複/欠損を確認する。
- [x] `AudioScheduler` の FIFO、同一 key 合流、rate-limit、retry、fatal、cancel、dispose を fake clock で確認する。
- [x] Aivis API cache の key 分離、null cache、invalidate を確認する。
- [x] 取得サイズ上限、MIME、HTTP status 分類を service 境界で確認する。
- [x] `npm run typecheck-client` の後に Node/Electron 対象テストを実行する。

## Task 8: ccusage、resource monitor、limits monitor

**Files:**

- Create tests under: `src/vs/paradis/contrib/ccusage/test/`
- Create tests under: `src/vs/paradis/contrib/resourceMonitor/test/`
- Modify tests under: `src/vs/paradis/contrib/limitsMonitor/test/`

- [x] ccusage の model 分類、local date、project 名、daily/session/project 集計を確認する。
- [ ] ccusage child process の timeout、終了コード、不正 JSON、出力上限を確認する。
- [x] process tree の子孫探索で cycle、欠損親、重複 PID を確認する。
- [x] CPU/memory 集計と severity の閾値、NaN/Infinity/負値を確認する。
- [x] limits の provider payload 欠損、window duration、境界値を確認する。
- [x] `npm run typecheck-client` の後に対象テストを実行する。

## Task 9: Browser bookmarks と mirror

**Files:**

- Create tests under: `src/vs/paradis/contrib/browserBookmarks/test/common/`
- Create tests under: `src/vs/paradis/contrib/browserBookmarks/test/electron-browser/`
- Create tests under: `src/vs/paradis/contrib/browserMirror/test/electron-main/`

- [x] bookmark tree の insert/remove/move、root move guard、重複 URL、favicon 更新を確認する。
- [x] Netscape bookmark HTML の nested folder、escaped title、invalid entry の import/export を確認する。
- [ ] storage 復元で壊れた JSON と旧 schema を扱うことを確認する。
- [x] mirror capture が target 一致時だけ frame を返し、不一致、欠損、複数候補では deny することを確認する。
- [x] `npm run typecheck-client` は成功。bookmark HTML は実行成功、mirror は Electron main 実行基盤不足で未実行。

## Task 10: Default extensions、Sentry、パッケージ契約

**Files:**

- Create tests under: `src/vs/paradis/contrib/defaultExtensions/test/`
- Extend tests under: `src/vs/paradis/contrib/sentry/test/`
- Create release/package smoke tests in the closest existing test suite

- [ ] bundled VSIX の列挙、重複、欠損、既導入、version 更新条件を確認する。
- [ ] Sentry event の path、query、token、環境変数、process metadata の秘匿化を確認する。
- [ ] update feed が参照する platform artifact 名と release workflow の成果物契約を確認する。
- [x] `npm run typecheck-client` の後に Sentry utility 対象テストを実行する（6 passing）。

## Task 11: 小規模な未テスト contribution

**Files:**

- Create narrowly scoped tests beside:
  - `browserButton`
  - `browserDownloads`
  - `browserExtensions`
  - `browserUserAgent`
  - `keepAwake`
  - `releaseNotes`
  - `viewLayout`
  - `watermark`
  - `windowTransparency`
  - `terminalImagePaste`
  - `terminalShiftEnter`

- [ ] browserDownloads、browserExtensions、browserUserAgent、keepAwake、windowTransparency、terminalImagePaste は確認済み。残り5領域は未確認。
- [ ] 登録だけの contribution は1つの manifest/registration テストへまとめ、実行時に登録情報を読み取る。
- [ ] 対象6領域の外部 API 引数は確認済み。keepAwake の OS blocker lifecycle は未確認。
- [x] `npm run typecheck-client` は成功。4スイートは実行成功、browserDownloads は Electron main 実行基盤不足で未実行。

## Task 12: PR CI のテスト実行経路

**Files:**

- Modify the existing pull-request GitHub Actions workflow under `.github/workflows/`
- Modify: `cloudflare/update-server/package.json`
- Test scripts only; do not alter production build behavior

- [x] `app` workspace の typecheck/test を PR job から実行する。
- [x] Update Worker の typecheck/test を PR job から実行する。
- [x] lockfile、既設 self-hosted toolchain、同一 repository PR 制約が既存方針に一致することを確認する。
- [x] workflow 構文を YAML parser で検証する。

## Task 13: 全体検証と結果分類

**Files:**

- Modify: this plan, checkbox status only
- No production files

- [x] `git diff --check` を実行する。
- [x] 追加テストを runner ごとにまとめて再実行する。
- [x] 関連既存スイートを再実行する。
- [x] 失敗を test defect、baseline/environment、product behavior に分類する。
- [x] `git diff --name-only` で製品コードが変更されていないことを確認する。
- [x] コミットと push が作成されていないことを確認する。
