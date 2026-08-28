# Office Viewer 検証台帳

## Task 2 監査時点

- 監査基点: `0e123d9598d9c098e7c6f6dc082a858524301eb7`
- matrix checker: `/Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md`
- 実機ランタイム: 未実施。Desktop / Web / Remote / Mobile への接続、画面操作、スクリーンショットはこのTaskの証跡に含めない。
- 判定: 実機runtimeが未実行のため `implemented` は使用しない。既存matrixはaction/reasonを持つが、行ごとの実在source証跡を持たないため、現行checkerでは未達として拒否される。
- 製品既定値: `paradis.officeViewer.engine=legacy`。既存ユーザー/ワークスペースが明示的に `v1` を選ぶ実験経路は残すが、完成済みとは扱わない。

## 安全フォールバックの行動

新経路の実機証跡がない行は、一律の文言ではなくmatrixの`action`へ従う。`legacy-preview`は既存の読み取り専用preview、`diagnostic`は種類・理由を示して意味差分を確定しない表示、`explicit-unavailable`は必要な接続または既存エディタを案内する表示である。`reason`は未実行という事実ではなく、`fail-closed`、`no-unsupported-projection`、`no-external-fetch`、`no-semantic-claim`の製品ポリシーを示す。外部取得・マクロ・OLE・ActiveXの実行は行わない。これは仕様34節のruntime kill switch、および27.1節のsilent omission禁止に従う暫定分類である。

## 既存ソース証跡（実行結果ではない）

次のテスト・fixtureはリポジトリに存在するが、Task 2では再実行していない。よってmatrixでは `not-run:` と記録した。

- `src/vs/paradis/contrib/fileViewers/test/integration/paradisOfficeDualRead.test.ts` の `preserves legacy spreadsheet values, styles, and effective base diagonal semantics while auditing unchanged overlays` は `common/fixtures/task2-diagonal-border.xlsx` を使う。
- 同テストは `common/fixtures/task2-drawing-line.docx` を使い、表罫線とDrawing lineを別の対象として扱う。
- `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeSanitizer.test.ts` の `preserves line, shape, anchor, transform, and diagonal-border geometry while blocking a DrawingML asset` はgeometryの保持とunsafe assetの遮断を別々に検証する。

これらはraw/effective diagonal一般のランタイム保証ではない。前者fixtureと上記の個別テストが覆う範囲だけをソース証跡として扱う。

## Commit 検証規則

checkerは各行のcommitが現在の`HEAD`の祖先であることを `git merge-base --is-ancestor <sha> HEAD` で検証する。全fixture/unit/runtimeが`not-run:`のsafe-fallbackには、action/reasonに加えて実在するリポジトリ相対パスとsymbol (`source=path#symbol`) を要求する。台帳に個別のTask列挙がない既存commitも、この祖先性を満たす限り検証可能な既存証跡として扱う。祖先でないSHA、`pending`、空欄、存在しないsourceは拒否する。

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

## Task 4 対象検証（2026-08-28）

- 比較基点 SHA: `b6c1ee0dff86040f3828e78c8247b8f0a78c1e78`
- 実行対象: 上記基点に Task 4 harness を適用した worktree。launcher Node `24.18.0`、Electron renderer Node `24.18.1` / Electron `42.8.1` / Chrome `148.0.7778.280`、macOS `26.5.2 (25F84)`、Apple M4（10 cores）、RAM 32 GiB。
- fixture SHA: case `eab6b45f6516a47ddab4b6dcea2e6486b9d7c0745982a8be6267cdbffcca2b3f`、serialized geometry `befa51cea63bb0f69d0cbca37d0c08190dbb3086997372c1982514a728105be5`。
- renderer SHA: source `97fd10e1f0946b42c581a6f247cf4d110d6c618acd2b3c1e7f15d283a7c189f7`、compiled `7464a7be30ff859df946fee63098a7676cbc195e66979543b87ec4d56c39d4ee`。

| 対象 | 実行コマンド | exit | 結果 |
| --- | --- | ---: | --- |
| client transpile | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run transpile-client` | 0 | 9,230 TypeScript files、2,572 resources を処理 |
| security / performance / worker | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/{common/paradisOfficeSanitizer,node/paradisOfficeWorkerHost,performance/paradisOfficePerformance}.test.js'` | 0 | 112 passing。sanitizer と worker の既存境界、Task 4 security/performance 9件 |
| memory | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- node --expose-gc test/unit/node/index.js --runGlob 'vs/paradis/contrib/fileViewers/test/performance/paradisOfficeMemory.test.js'` | 0 | 2 passing。実 semantic snapshot payload、worker cancel、handle close/store dispose、強制 GC 3回、snapshot ownership release 1回、retained snapshot/cache/handle/worker 0、heap <= baseline + 20 MiB |
| client typecheck | `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck-client` | 0 | diagnostics 0 |

固定 fixture は small、100k cells、5M cells、16,384 columns、200 pages の shape だけを表現する。各 case を実際の `ParadisSpreadsheetViewport` と `ParadisSpreadsheetGridRenderer` に渡し、main document へ接続して次の animation frame まで待機したpaint時間、IPC serializer byte length、live DOM countをassertする。200 pages は実 `computePageLayout` / `pageRectangles` path で 200 page model を展開する。5M cells は実体化せず、virtual viewport が tile だけを生成する。実 Word OPC を parser へ渡し、その結果を実 semantic diff の terminal まで処理する。production accountant/spool transport/handle cache/worker host を同時に通した peak は worker 4 MiB、cache 3 MiB、spool 1 MiB、total 10 MiB。協調 cancel は実時間 <=250ms、unresponsive worker は fake clock で正確な 250ms terminate 境界を検証する。旧称visual gateはproduction rendererのdiagonal/drawingから得たserialized geometry bytesの不変条件であり、pixel diffではない。実runtimeのpixel比較Gateは未実施・利用不可であり、この検証で達成済みとは扱わない。

attached paint は 2026-08-28T00:11:55Z に上記 renderer SHA / hardware / runtime identity で small case を実 DOM に attach し、render 後の実 `requestAnimationFrame` まで41回測定した。初回 immutable sample の median は `13.099999994039536ms`、許容上限はその `1.10` 倍の `14.40999999344349ms` である。harness は同じ41回の median を計算して `median <= immutableBaselineMedian * 1.10` を直接 assert し、test 実行中に fixture を生成・更新しない。source SHA、compiled SHA、または OS/kernel/CPU/core/RAM/Node/Electron/Chrome identity が1項目でも異なる場合は skip や再校正をせず、測定前に fail closed とする。

security gate の hard limit は、sanitizer へ渡す source と同じ実 ZIP bytes を `ParadisOfficeNodeArchive` で開き、全 entry body length と central-directory expanded metadata の一致を確認してから実行する。single part 8 MiB、expanded total 32 MiB、4096 entries、per-entry/container 100x は成功し、それぞれ +1 は `zipBomb` または `unsafe` の documented safe outcome になる。per-entry +1 は対象 `padding.bin` だけを100x+1とし、低比率 sibling により aggregate は100x以下に保つ独立 fixture で拒否する。body/metadata が一致する valid ZIP では non-empty entry の compressed bytes は正であり、全 entry が100x以下なら不等式の総和も必ず100x以下になるため、「全entry<=100xかつaggregate=100x+1」の独立 fixture は数学的に構成不能である。production aggregate guard は defense-in-depth として維持し、at-limit fixture 上でもこの含意を明示的に assert する。XXE も実 OOXML ZIP の document part に入れて拒否を確認する。external URL、unsafe SVG/font、macro/OLE、malicious filename、traversal、relationship cycle も fail-closed。Electron runner は `--expose-gc` を受理しないため、memory harness のみ Node runner を直接使う。

## Task 5 Desktop Runtime Verification（2026-08-28）

- 対象 build SHA（launch に渡した worktree source）: `6cc9179c74fb31b0f87aa0ac41b387a2c9c76f64`。この後の文書 commit は build source を変更していない。
- 実行時刻と環境: `2026-08-28T09:21:00+0900`--`2026-08-28T09:21:10+0900`、macOS `26.5.2 (25F84)`、`arm64`、launcher Node `v24.18.0`。
- 実行 action: `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- /Users/magu/github/para-code/.agents/skills/launch/scripts/launch.sh --repo /Users/magu/github/para-code/.worktrees/office-viewer-complete -- /Users/magu/github/para-code/.worktrees/office-viewer-complete`。ランチャーは隔離 profile/extensions/shared-data directory を作り、`--remote-debugging-port=59301`、`--inspect-extensions=59302`、`--inspect=59304`、`--inspect-agenthost=59305` を child command に渡した。しかし pre-launch の非ゼロ終了により launch success JSON は出力されず、CDP endpoint/listen、Playwright session、Desktop window は存在しない（`59301` は利用可能な CDP port ではない）。
- 対象 fixture と SHA-256: `task2-diagonal-border.xlsx` = `bbfc2d9db9fb7fe831afd2f31df00f7b9611fb420a76598f7b550a54882a36c4`、`task2-drawing-line.docx` = `af86e3518fce6f4a73a66dd99af49affd541c83f5ad3611c336e98d34f1dcb10`。算出 command: `rtk sha256sum src/vs/paradis/contrib/fileViewers/test/common/fixtures/task2-diagonal-border.xlsx src/vs/paradis/contrib/fileViewers/test/common/fixtures/task2-drawing-line.docx`。
- compiled UI output identity: launch 予定の worktree output を `rtk sha256sum out/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.js out/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetDiffEditor.js out/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxFileEditor.js out/vs/paradis/contrib/fileViewers/electron-browser/paradisDocxDiffEditor.js` で採取した。順に `dce372ab40c6f1aee90ee66ee824bbd064d35a068389f6d6c9f350c01c0254ec`、`47a433b49c43fc19ddafd768930d23cdb3979df7c3ad89bde635fbcfa828d164`、`6ae1b263c78b42b56973ab9a809244fa7f9553180481945f7c5106fb6e0057cf`、`e7d77ce7e68b56ed9079f1aa350fec7c9d30026cdea9445847b471ac0b09d683`。pre-launch 失敗のため、これらが renderer に実ロードされたことは主張しない。
- launch 失敗: Open VSX の `ms-vscode.vscode-js-profile-table@1.0.11` の取得 bytes SHA-256 が期待値 `50d002706213bc90d695f05f56d42fffd825035945eaf1cb1ba175effb7ff408` と実値 `a962a1e6a3baf74c9354b7f47fa96e6d6f0423a63bff55d7f976b6134a748ae9` で不一致だった。失敗 log は `.superpowers/sdd/2026-08-24-office-viewer-integration/task-5-artifacts/launch-20260828T092100+0900-node24-failure.log` に `cp -p` で byte-preserving 保存し、`cmp -s` で元の `/tmp` log と同一を確認した。artifact SHA-256 は `7f935b7158b8589f0874cd84f6d6fbab3835bcd17f75a2468a60d0d0eaed1261`。
- artifact directory は task-owned かつ `.gitignore` 対象である。画面が起動していないため screenshot は0件であり、存在しない画面証跡を作成していない。

| 確認領域 | Desktop runtime 結果 | 安全な扱い |
| --- | --- | --- |
| Excel View / Diff（numFmt、formula/cache、型、CF、comments/links、hidden、行列挿入、freeze、virtualization、chart/pivot、search、print、keyboard/HC） | 未確認。CDP/画面がないため実 UI を操作できない。 | matrix action `legacy-preview` は Desktop の `paradis.officeViewer.engine=legacy` または `semanticSpreadsheet=false` で適用する。`isParadisSpreadsheetV1Enabled`（`electron-browser/paradisSpreadsheetEditor.ts:82-84`）が false でも、同 editor は workbook を `parseSpreadsheetResource` 後に `_renderSheet()` する（`:645-679`）ため既存 compatible spreadsheet renderer を使い、semantic UI だけを `_clearSemanticUi()` する（`:714-719`）。Browser で `platformBackend=false` または同 semantic flag が無効なら action `diagnostic`: `selectParadisOfficeBrowserInputMode` が `diagnostic` を返す（`browser/paradisOfficeConfiguration.ts:85-95`）し、`ParadisOfficeDiagnosticEditor` は diagnostic/worker-unavailable UI を表示する（`:146-159`）。 |
| Word View / Diff（header/footer、notes/comments、textbox/image、style/theme、table/list、OMML、fields、revisions、DrawingML/SmartArt/chart/OLE、search、print、Final/Original/Markup） | 未確認。CDP/画面がないため実 UI を操作できない。 | matrix action `legacy-preview` は Desktop の `engine=legacy` または `semanticWord=false` で適用する。`isParadisWordV1Enabled`（`electron-browser/paradisDocxFileEditor.ts:69-71`）が false のとき semantic toolbar/inspector を `_clearSemanticUi()` する（`:608-635`）が、既存 docx webview は同 editor の `_buildHtml` で表示する（`:592-594`）。Browser/backend unavailable は上記 `diagnostic` 分岐で、unsupported/worker unavailable を明示する。matrix action `explicit-unavailable` の行は、この起動失敗から UI 結果を補完しない。 |
| lifecycle（rapid switch、cancel、watcher burst、delete/recreate、blank retry、view state restore） | runtime 未確認。Desktop process が起動前に停止した。 | product fallback の確認・主張はしない。 |
| legacy kill switch | UI 操作による確認は未実施。`engine=legacy` は runtime snapshot で spreadsheet/word/platformBackend/searchPrint を false に固定する（`common/paradisOfficeCapabilities.ts:447-456`）。 | source 分岐の存在だけを証跡化し、切替成功とは記録しない。 |

この失敗は Office viewer の UI 結果ではなく、検証環境が検証済み extension artifact を取得できない launcher 前提条件の失敗である。チェックサムを迂回したり、別の profile を共有したり、手動起動に置き換えたりせず fail closed とした。Task 5 では runtime 項目を `implemented` へ更新しない。再試行には、期待 SHA-256 と一致する `ms-vscode.vscode-js-profile-table@1.0.11` の利用可能な built-in extension artifact が必要である。参考の別 commit `9655…` はこの target build に適用していない。artifact source が変わっているため、再試行前に main/current base と extension artifact の双方を再確認する。

## Task 6 Web / Remote / Git / Mobile Matrix（2026-08-28）

- 検証基点 SHA: `2212f25a24db67cf2631a441529307a5e80ee145`。Task 5 と同じ source build（`6cc9179c74fb31b0f87aa0ac41b387a2c9c76f64`）で、Task 6 は台帳だけを変更する。
- 実行環境: Node `v24.18.0`。全コマンドは `rtk /Users/magu/.local/bin/mise exec node@24.18.0 --` を使用した。`transpile-client` は exit 0（9,230 files、2,572 resources）。
- 証跡は ignore 対象の `.superpowers/sdd/2026-08-24-office-viewer-integration/task-6-artifacts/` に保存した。`web-worker-node24.log`=`e822b645f46941bb908593a5f1174c91f6894d39e5c24a63e9cfd52c7df08414`、`remote-channel-node24.log`=`272344be20d25eb9565f9565846181a99ce3252190d9524997214a593643146b`、`git-remote-client-node24.log`=`99b18ae3ec40a933e2ce4ecaa66303649e357b0ba22ea1dfd2ce8ff780631c15`、`mobile-word-relay-node24.log`=`12d92822d3ce7b291bef6d4235a299686c2c6297a32d29ced7115201ec2770bd`、`mobile-capability-node24.log`=`4aebac4349fc466b7a1fbcd36e95b873d4d697dcb015f59108e9469aea8e7e3a`。これらは実機画面証跡ではない。

| 領域 | 実行コマンドと結果 | 記録できる範囲 | 未確認・安全な扱い |
| --- | --- | --- | --- |
| Web worker / CSP | `./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/{browser/paradisOfficeBrowser,browser/paradisOfficeWebArchive,browser/paradisSpreadsheetWebAdapter}.test.js'`、exit 0、25 passing | in-process worker handlerで Excel View/Diff、OOXML 8形式の View（xlsx/xlsm/xltx/xltm/docx/docm/dotx/dotm）、unsupported diagnostic、worker unavailable、exact-origin module worker URL、browser budget/archiveを検証した。テストは外部 origin URLを拒否し、Word fixtureの外部 relationship URLを結果へ露出しない。 | 実ブラウザ page、実 `Worker`、Excel/Word の画面 View/Diff、実ネットワークを起動していない。8形式の Word は View のみであり、Web Workerを通る Word Diff と「外部 request 0」のネットワーク観測は未確認。Browser unavailable は `diagnostic` のままとし、実 UI 成功に更新しない。 |
| Remote | `./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/node/paradisOfficeServerChannel.test.js'`、exit 0、8 passing | in-process server channel は同一 authority の remote bytes、remoteMobile budget、v1 negotiation authority/connection epoch、disconnect cleanup、capability再評価を検証した。actual OOXML fixtureは Git→authority-fenced spool IPC→remote resolver→worker input を通した。 | SSH/Remote host、再接続した実 socket、実 server flag は起動していない。v0 bounded local spool、revision race、capability flipは次行の client simulation 証跡だけであり、Remote runtime 成功ではない。 |
| Remote v0 / race | `./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/browser/paradisOfficeGitSource.test.js'`、exit 0、17 passing | fake repository/channel を用い、v1 descriptor-only channel、old server の bounded local spool warning、新 source ごとの flag negotiation、既存 handle の negotiated route維持、publication前後の cancellation fence/late bind cleanupを検証した。 | 実 remote server との revision race/disconnect-reconnect は未確認。v0 は local spool + warning の simulation 結果であり、実接続時の互換性を pass と扱わない。 |
| Git | 同上、exit 0、17 passing | `HEAD→index`、`index→working` と stage refresh、rename/delete、sideMissing、LFS pointer（fetchせずopaque）、raw content change reject、immutable commit descriptorを fake repository bytes で検証した。 | 実 Git repository/CLI、実 index/worktree、LFS server は使用していない。従って Git の UI runtime は未確認であり、descriptor/diagnostic safety contract のテスト証跡に限る。 |
| Mobile relay | `./scripts/test.sh --runGlob 'vs/paradis/contrib/mobileRelay/test/electron-browser/paradisMobileWordDiffHtml.test.js'`、exit 0、8 passing | PC 側 Word Diff relay bundle はdescriptor-only v1 request、revision cursor mismatch、cancel/close、byte budget、hostile textのHTML escapeを simulation で検証した。relay handler は `paradisMobileWorkspaceProvider.ts:2163-2227` に存在し、hello/cancel/Word Diffを受ける。 | iOS/Android UI、paired device、relay frame、Excel View/Diff、Word View/Diff の end-to-end は未確認。これは desktop launch失敗を代替する runtime 証跡ではない。 |
| Mobile capability / CSP | `npm test -- src/components/officeCapability.test.ts`（`app/mobile`）、exit 0、12 passing | pure helper testは old/new capability matrix、未接続時にhelperが返す standalone `connectToPc` / explicit fallback、CSP `connect-src 'none'`、`about:blank`以外のtop-frame navigation denyと外部URL confirmationを検証した。これはhelper上の期待safe fallbackであり、mobile UI表示の結果ではない。 | `app/mobile/src/components/fileViewer.tsx` は `secureMobileOfficeHtml` と `guardMobileOfficeNavigation` を配線してOffice HTMLをWebViewへ渡す（:575-585、:589-615、:699-716）。従ってCSP/navigation policyはsource上UI配線済みだが、実機WebViewでの実行は未確認である。一方で `resolveMobileOfficeCapabilities` のhelper連携と `office/hello` / `office/wordDiff` のrelay dispatchは未実装であるため、actual mobile UIがhelperのstandalone fallbackを表示すること、およびconnected Excel/Word View/Diffがrelayへ接続済みであることは未確認かつ未実装である。新transport/UIはこのTaskでは実装しない。 |

この表の `passing` は対象 runner 内の source/test simulation の成功だけを意味する。Web page、remote host、Git UI、mobile device のいずれも実 UI/path 未到達であり、Task 5 の launcher checksum mismatch も未解消のため、対応する matrix runtime status を `implemented` へ変更しない。再検証は checksum を満たす launcher artifact と、実ブラウザ・remote server・paired mobile device を用意して別途行う。

## Task 8 最終監査とリリース状態（2026-08-28）

- 最終文書更新前の matrix 対象 SHA: `459628654b5a652389404923644b44e4198b1d42`（`fix(office): keep incomplete semantic paths fail-closed`）。このSHAはこの文書更新 commit の祖先であり、matrix の既存 evidence SHA も同じく祖先性だけを検査対象とする。
- matrix checker: `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md` は exit `1`。173行の all-`not-run` `safe-fallback` が実在する `source=path#symbol` を欠くため、checker が意図どおり拒否する。通過扱いにも、証跡を補った扱いにも変更しない。
- リリース状態: `paradis.officeViewer.engine=legacy` が既定。`v1` は明示的に選ばれる実験的/診断的経路であり、未実装の semantic operation は advertisement せず `featureUnsupported`、`diagnostic`、または `explicit-unavailable` へ fail closed する。これは完全な production semantic viewer の完了を意味しない。
- 最終再レビュー: architecture / security / regression / quality はすべて Critical `0`・Important `0`。Minor として profile/CLI override の JSDoc が production wiring されていない点は残るが、legacy default の安全性を変更しない。Web response byte limit、remote request/handle ownership、mobile capability advertisement、desktop `platformBackend` 選択は安全 remediation の対象として修正済みである。
- 検証済みの範囲: Task 3 の client transpile、client typecheck、layer validation、既存 mobile Office capability test、および Task 4 の sanitizer/worker/performance、forced-GC memory、client transpile/typecheck は Node 24 runner で成功している。これらは source/test harness の成功であって、Desktop/Web/Remote/Git/Mobile の実機 UI 成功ではない。
- 未達・利用不可の gate: Desktop launcher は Open VSX extension checksum mismatch で CDP/window 前に停止し、実 Desktop lifecycle と pixel 比較は未実施・利用不可。Web/Remote/Git/Mobile も simulation/source wiring のみで実 UI runtime は未確認。serialized geometry invariant は pixel gate の代替ではない。完全 Office glob は既知の worker-host runtime fence により非ゼロ、mobile typecheck は既存 `relayClientPresence.test.ts` の13件の `TS2532` により非ゼロであり、いずれも pass と記録しない。

### Task 8 文書更新後の Node 24 再実行

| コマンド | exit | 結果・扱い |
| --- | ---: | --- |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run transpile-client` | 0 | 9,230 files、2,572 resources。npm unknown project config 6件のwarningあり。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'` | 1 | 既知の完全 Office glob 非ゼロ。Electron renderer の `worker_threads` runtime fence を含むため、全体成功や runtime coverage として扱わない。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm test -- src/components/fileViewer.test.tsx src/components/officeCapability.test.ts`（`app/mobile`） | 0 | 既存の `officeCapability.test.ts` のみを検出し、20 tests passed。指定 `fileViewer.test.tsx` は存在しないため、2ファイルの成功とは扱わない。Vite CJS API deprecation warningあり。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck-client` | 0 | diagnostics 0。npm unknown project config 6件のwarningあり。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run valid-layers-check` | 0 | `layersChecker` / `layersTypeCheck` diagnostics 0。npm unknown project config 6件のwarningあり。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- npm run typecheck`（`app/mobile`） | 2 | `src/relayClientPresence.test.ts` の既存 `TS2532` 13件。失敗として維持する。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- ./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/{common/paradisOfficeSanitizer,node/paradisOfficeWorkerHost,performance/paradisOfficePerformance}.test.js'` | 0 | Task 4 security/worker/performance の対象 runner は成功。Electron runner warning（`vm`、Sentry native stacktrace、Node deprecation/WASI）あり。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- node --expose-gc test/unit/node/index.js --runGlob 'vs/paradis/contrib/fileViewers/test/performance/paradisOfficeMemory.test.js'` | 0 | 2 passing。 |
| `rtk /Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md` | 1 | 173行の all-`not-run` evidence を拒否する既知の未達 gate。 |
