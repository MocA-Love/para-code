# Para Code - fork運用メモ

Para Code: VS Codeフォークの独自エディタ。`microsoft/vscode`を`upstream`としてfork。

## 経緯（サマリ）

1. VS Code拡張機能のプロトタイプとして以下3機能を作ろうとした
   - 複数リポジトリのワークスペース即時切り替え（状態維持、非アクティブなものは非表示）
   - ターミナルの田の字型（縦横自由）分割
   - ブラウザタブ（CDP）⇔AIエージェントセッションの動的紐づけ
2. 拡張機能の範囲で実装を進めた結果:
   - 機能1は「本物のworkspaceFoldersを操作し、常にインデックス0に触れないダミーのアンカーフォルダを置く」方式で、**Extension Host再起動なしに安定動作することを旧拡張プロトタイプで実証済み**。これは拡張機能のままで解決できた
   - 機能2（ターミナル2Dグリッド）は、旧拡張プロトタイプの`node-pty` + `xterm.js`による自作webviewターミナルで実現可能と確認した
   - 機能3（ブラウザ⇔エージェント）はCDP直結のWebviewPanelで拡張機能のまま実現可能と判明（未実装、設計のみ）
3. つまり**3機能とも技術的には拡張機能のままで実現可能**と分かった。それでもforkを選んだ理由は「今後増えるであろう要望に対して、拡張機能APIの境界に縛られない自由度が欲しい」という戦略的判断（バグドリブンではない）
4. fork方式は「VSCodium型パッチレイヤー」ではなく、LLM Agent（Claude Code）による開発 + 強いCI/テストを前提に、**機能の野心はフルフォーク相当に広げつつ、個々のパッチは可能な限り新規ファイル追加/薄いフック1箇所で完結させる**という設計方針を採用

## 重要な調査結果（今後のパッチ設計の前提）

- `src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`の`WorkspaceChangeExtHostRelauncher`が、`workspace.folders[0].uri`（インデックス0）の変化を検知してExtension Hostを再起動する。根拠は非推奨`workspace.rootPath`互換のみで、現行APIの必須要件ではない
- 2026年2月マージのPR #292783で、VS Code本体が`isSessionsWindow`という「Agent Sessions window」専用モードを追加し、この再起動を明示的にスキップしている。**Microsoft自身が同種のユースケースでこのパターンを実証済み**
- `isSessionsWindow`はcore限定のフラグで拡張機能からは設定できないため、拡張機能側では「インデックス0に触れない」という設計で同じ効果を得た（`ensureAnchorFolder`）
- `src/vs/sessions/`に実験的な「Agent Sessions window」機能が既にある（`WindowEnablement.Sessions`フラグ、安定版では無効）。調査の結論:
  - `contrib/workspace/browser/workspaceFolderManagement.ts`: `IWorkspaceEditingService.updateFolders(0, 1, [newFolder], true)`でインデックス0を都度**置き換え**。複数リポジトリを同時保持する設計ではない（私たちの要件とは異なる）
  - `contrib/browserView/`: CDP（CDPEvent/CDPRequest/CDPResponse）対応済み。`registerContextualFilter()`でアクティブセッションのみブラウザタブを絞る仕組みあり。**機能3の実装で参考・流用価値が高い**
  - `contrib/terminal/`: 1軸split view のみ。2Dグリッド未対応（機能2は自作webviewターミナルで代替する方針を維持）
  - 総合評価: 「薄く拡張するより、必要な部分だけ参考にしてゼロから作る方が早い」（複数リポジトリ同時保持・2Dグリッドが根本的に未実装のため）

## 【重要・実機で確認済み】sessions.common.main.tsは通常ウィンドウでロードされない（2026-07-01）

機能2（ターミナル2Dグリッド）の初回実装で、`sessions.common.main.ts`に登録したcommand（`registerAction2`）が通常のPara Codeウィンドウのコマンドパレットに一切出てこないバグが発生し、実機調査で原因を特定した。

- `src/vs/platform/windows/electron-main/windowImpl.ts:1213`: `configuration.isSessionsWindow`が真の場合のみ`vs/sessions/electron-browser/sessions(-dev).html`をロードし、それ以外（通常ウィンドウ）は`vs/workbench/workbench(-dev).html`経由で`vs/workbench/workbench.desktop.main.ts`（→upstream所有の`workbench.common.main.ts`）をロードする
- `isSessionsWindow`は`src/vs/platform/windows/electron-main/windowsMainService.ts:1599`で`options.workspace.configPath`が`environmentMainService.agentSessionsWorkspace`と一致する場合のみ真になる特殊なワークスペース。通常起動では真にならない
- つまり`src/vs/sessions/sessions.common.main.ts`への集約importは、**Agent Sessionsウィンドウ専用**であり、通常ウィンドウでは該当モジュールの`import`自体が実行されない（`registerAction2`等の副作用が一切発生しない）
- 修正: 通常ウィンドウでも有効にしたい機能（ターミナル2Dグリッドのsplit action等）は、`sessions.common.main.ts`ではなく、既存のDI差し替えポイント（`terminalGroupService.ts`、workbench側で常にロードされる）から直接副作用importするよう変更した。詳細は`CLAUDE.md`の「contributionの登録方法」を参照
- **教訓**: `src/vs/sessions/`配下は「Agent Sessions window専用のworkbenchレイヤー」という説明を字面通りに受け取ると見誤る。実際に通常ウィンドウで機能させたい場合は、必ず実機（`scripts/code.sh`で起動した通常ウィンドウ）でコマンドパレット等から動作確認すること。型チェック・lintが通ってもロードパスの問題は検出できない

## shared process / REH サーバーへの fork チャネルの登録口（2026-09-27）

新しいチャネルを足すたびに `sharedProcessMain.ts` と `serverServices.ts` へ PARA-PATCH を足さなくて済むよう、登録口を1つにまとめた。`src/vs/paradis/common/paradisProcessContributions.ts` の `ParadisSharedProcessContributions` / `ParadisServerContributions` に `register('<id>', ({ server, accessor }) => ...)` し、集約ファイル `src/vs/paradis/paradis.sharedProcess.contribution.ts` / `paradis.server.contribution.ts` へ副作用 import を1行足すだけでよい。upstream 側は各ファイル1回の呼び出しだけ。

- `accessor` は同期的にしか使えない（`invokeFunction` の中から呼ぶ）。`await` の後で `accessor.get` しない
- 1つが例外を投げても残りは登録を続ける。同じ id が2回来たら後から来た方を捨て、`instantiate` のときにログへ出す（登録はモジュール読み込み中に走るので、例外にすると集約ファイルの import ごと落ちてプロセスの起動を巻き込む）
- 型の上では Promise を返せないが、`() => void` として async 関数が紛れ込んだ場合は、失敗をログへ出す
- 既存の `registerParadis*` 直呼びはまだ移していない。agentBrowser → mobileCanvas / mobileRelay のように値を渡し合うものと、REH で pty ホストのサービスを受け取るものがあり、1つずつ引数の出どころを確かめてから移す

## 会話ログの集計 worker と全文索引（agentActivity、2026-09-27）

使用量ダッシュボードの「スペース別」「作業実績」と、セッション履歴の全文索引は、どれも shared process が起動する worker（`src/vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain.ts`）で会話ログを読む。会話ログは合計で数 GB になり、shared process 本体で読むとエージェントの状態通知が遅れるため。なお contrib 名の `agentActivity` は、既存の `mobileRelay/node/paradisAgentActivity.ts`（サブエージェントの活動ツリー）とは別物。全文索引の本体もセッション履歴側ではなくこちらにある。

- worker はパスを指定して起動するのでどこからも import されない。パッケージ版に出力させるため `build/next/index.ts` の `desktopEntryPoints` に PARA-PATCH で1行足し、`build/next/test/entryPoints.test.ts` で検査している。依頼が 90 秒途絶えると終了する
- 読むのは手元の既定のホーム（`$CLAUDE_CONFIG_DIR` / `$CODEX_HOME`、無ければ `~/.claude` / `~/.codex`）の `projects/*/*.jsonl`・`*/<session>/subagents/*.jsonl` と `sessions/**/rollout-*.jsonl` だけ。**複数の Codex ホーム（`~/.codex-2` など）と WSL のホームは読まない**（統合時にホームの一覧を共通の解決関数へ寄せること）。SSH で接続しているウィンドウでは「スペース別」は出さない（ccusage は接続先を数えるので、手元の会話ログで按分すると合わない）。REH サーバーには登録していない
- shared process はファイルごとの集計結果を（大きさ・更新日時・inode が同じなら）使い回す。更新ボタンでも同じ。期間の開始より前に最後に更新されたファイルは読まない。追記されたファイルは先頭から読み直す（途中から読むには解析の状態を持ち越す必要があり、見送った）
- Claude Code の応答（`message.id:requestId`）と依頼（行の `uuid`）は、再開・分岐で前の会話の行が新しいファイルへ写されることがあるので、集計時にファイルをまたいで重複を除く（古いファイルが勝つ）。稼働時間はファイルごとの記録の間隔から出すので、写された区間は重ねて数えることがある
- 金額の按分は ccusage の日別・モデル別の金額を、同じ日・同じモデル（無ければ同じエージェント）のトークン比率で分ける。トークンは種類ごとに重みを付ける（入力 1・出力 5・キャッシュ書き込み 1.25・キャッシュ読み取り 0.1）。生のトークン数で割ると、量は多いが安いキャッシュ読み取りで按分がほぼ決まってしまうため。価格表は持たない。Claude Code・Codex 以外（Gemini など）の金額と、会話ログに対応する記録が無い金額は「未割り当て」に残す
- 全文索引は `<userData>/paradis/sessionIndex/sessionIndex.sqlite`（ディレクトリ 0700、ファイル 0600）。`node:sqlite` の FTS5 の trigram トークナイザを使う（Electron 同梱の Node 24.20 / SQLite 3.53.4 で動作確認）。既定はオンで確認は出さない。会話ログの全文のコピーになるので、そのことを設定の説明に明記している
- **「オフなら索引が残っていない」は shared process（`ParadisAgentActivityService`）が守る**。起動時と設定 `paradis.sessionIndex.*` の変更時に照合し、オフなら消す（起動時もすぐ）。オンのときの保存日数・ツール出力の反映は、起動時だけ 60 秒遅らせ、期限を過ぎた会話が無ければ何も書かない。画面側の更新依頼も、設定がオフなら断る。スキーマは画面側でしか登録されないので、shared process は未設定を既定値（オン・90 日・ツール出力なし）として読む。コマンド「会話の全文索引を削除」は削除して設定もオフにする
- 消した本文をファイルに残さない: SQLite の `secure_delete` と FTS5 の `secure-delete` オプション（消したその場で語のセグメントからも消す）を有効にし、行を消したあとは `wal_checkpoint(TRUNCATE)` だけを行う。FTS5 の `optimize` は索引全体を書き直し、その間は検索も止まるので使わない。DB と WAL の生のバイト列に消した本文が残らないことをテストで確かめている。ツール出力を入れない設定に変わったとき・スキーマが古いとき・開けないときは、DB ファイル一式を消して作り直す。保存日数とツール出力の設定の変更は、会話ログを読まずに今ある索引へすぐ反映する
- 索引の削除は worker の更新と同じ列で「接続を閉じる → ファイルを消す」を行う。打ち切りは世代番号で、打ち切り要求より前に頼まれた更新は、実行中なら行の切れ目で、列に並んでいるなら始まった時点で止まる。削除中の更新依頼と状態の問い合わせでは DB を開かない。使っている途中で `SQLITE_CORRUPT` / `SQLITE_NOTADB` を受けたら、ファイル一式を消して次の依頼で作り直す
- 索引はファイルごとに「どこまで読んだか」と先頭 4KB の指紋を持ち、伸びた分だけ足す。inode が変わった・縮んだ・先頭が書き変わったファイルは読み直し、一覧から消えたファイル（削除、保存日数切れ）の分は消す。読んでいる間に差し替えられたら、入れた分を消して次回読み直す。最後まで読み終えた会話だけを「索引に入っている」とみなし、読みかけ（初回の作成中・打ち切り後）の会話は従来の検索で探す
- ツール出力を入れない設定（既定）では、利用者が打ったシェルコマンドの出力（`<bash-stdout>` など）も発言から除く。Codex の利用者シェルコマンドの記録形式は未確認
- 検索は更新とは別の読み取り専用の接続で行い、更新の列に並ばない。3 文字未満の語を含む検索は索引を使わず従来の検索（会話の先頭と末尾を読む）で探す。画面側は語ごとに「セッション情報か本文のどちらかに含まれる」を見て AND を取る（従来の検索と同じ意味）
- セッション履歴の行メニューの結果（コピーした・見つからない・失敗した）はモーダルの中に出す。通知の層（2545）はモーダル（2700）の下にあって見えないため。作業フォルダを開く前にディレクトリか確かめ、macOS のバンドル（`.app` など）は Finder で場所を見せるだけにする
- 一覧の行との突き合わせは `paradisSessionCatalogId`（agent と正規化したパスのハッシュ）。Codex の一覧は state DB の `rollout_path` から作るので、`CODEX_HOME` をシンボリックリンクにしているとパスの綴りがずれて索引が効かない（その会話は従来の方法で探す）

## リポジトリ構成

- `upstream`: `https://github.com/microsoft/vscode.git`（push無効化済み、fetch専用）
- `origin`: このGitHubリポジトリ（public、2026-07-13確認）
- ブランチ運用は今後要検討（upstreamのタグを定期的に取り込む前提。マージ戦略は未確定）
- **`main`の起点はupstreamスナップショットを1コミットに圧縮したもの**（`git checkout --orphan` + `git add -A`）。以後のPara Code開発コミットは通常どおり積み上げている。Microsoft側のフル履歴は`upstream`から`git log upstream/main`等で参照可能。理由は下記「pushトラブル」参照
- **現在のツリーが対応するupstreamコミット: タグ `1.139.1`**（2026-09-27のsquashマージ `para: merge upstream 1.139.1` で取り込み済み。1.137.0 は試験ブランチ止まりで main には入れず、1.134.0 から直接 1.139.1 へ。次回は `git replace --graft <1.139.1を取り込んだsquashコミット> <その実親> 1.139.1`。手順は下記の通りで、`1.134.0` とある箇所を `1.139.1` に読み替える）。前回のベースは `1.134.0`（2026-08-22のsquashマージ `para: merge upstream 1.134.0` で取り込み済み。2親マージコミットはローカルで試したが、forkの孤立履歴ではupstream全履歴のpushが必要になり不可能だったため、引き続きsquash+graft方式を使う。試作した2親版はブランチ`merge/upstream-1.134.0-real-merge`としてローカルにのみ残している。1.133.0は飛ばして1.132.0から直接1.134.0へ。それ以前のベースは `1.132.0` → `1.130.0` → `1.129.0` → upstream `7ad5744c6852a42e070b6d6045e3e1215cc120fd`＝1.128系）。次回のupstream取り込み手順: (1) `git fetch upstream --tags` (2) `git replace --graft <1.134.0を取り込んだsquashコミット> <その実親> 1.134.0` で共通祖先を教える（replace refはpushされないためリモートには影響しない） (3) worktreeを切って `git merge --squash <新タグ>` で3-wayマージ→解消→`para: merge upstream <新タグ>` でコミット (**pushは必ず単親のsquashコミットで行う**: 2親マージコミットをpushしようとするとupstream側オブジェクトがサーバーに無く転送不能。実測: 差分390MBでもHTTPS/SSH両方で接続切断) (4) `git replace -d`で後片付けし、この行を新タグで更新する。1.129取り込み時の実績: コンフリクト10ファイル/20hunk。1.130取り込み時の実績: コンフリクト9ファイル（うち5件はfork変更を含まない）。1.132取り込み時の実績: コンフリクト20ファイル（うち4件はfork変更を含まない=1.130 endgame由来）、解消方針の詳細はgit log参照。1.134取り込み時の実績: コンフリクト3833ファイル規模のsquashマージを手動解消、型エラー3件（browserViewDebugger.test.ts引数過剰／githubApiClient.tsの廃止定数GITHUB_GRAPHQL_ENDPOINT参照／sessionGithubRequestGate.tsのsuper()引数不足）を修正、意味的レビュー6領域（update/build/editor/terminal/browserview/sessions）でforkパッチ残存確認済み。**マージ前に必ず監査（下記「upstream取り込み前監査」）とマージ後のtypecheck/valid-layers-check/意味的レビューを行うこと**
- **リリースタグを起点にマージすると、マージベースは前回タグそのものにはならない**（release/1.129 と release/1.130 は main から別々に枝分かれするため、`git merge-base` は分岐点＝1.130取り込み時は `be6ed528a43` を返す）。この結果、**前回タグの endgame チェリーピックが「fork側の変更」として扱われ、upstreamが次リリースで別の結論を出した箇所が半端にマージされる**。1.130取り込みでは `editorResolverService.ts` の `markdownDefaultEditorInAgentsWindow` が「コメントは1.130（Defaults to on.）、値は1.129 endgame（false）」という矛盾状態になった（upstream追従＝`true` で解消）。検出手順: `git diff --name-only <新タグ>...<前回タグ>` で endgame が触ったファイルを列挙し、`git diff --cached --name-only <新タグ> -- <それら>` に fork変更ファイル以外が出てこないか確認する。**1.132取り込みでも同じ罠を踏んだ**: `agentSideEffects.ts` で1.130 endgameが足したブロックと1.132本体のブロックが「どちらもfork側/upstream側の追加」と見なされ、コンフリクトにならないまま**同じ処理が2回並ぶ状態で自動マージされた**（fork変更ゼロのファイルなので1.132.0で上書きして解消）。コンフリクトした4ファイル（`telemetryServiceImpl.ts` / `agentService.test.ts` / `runInTerminalTool.ts` とそのtest）も全て同じ由来。**検出手順（必須）**: `git diff --name-only <新タグ>...<前回タグ>` でendgameが触ったファイルを列挙し、マージ後にそれぞれ `git diff <新タグ> -- <file>` が「fork変更のみ」になっているか確認する。fork変更が無いファイルで差分が出たら endgame の半端マージなので `git checkout <新タグ> -- <file>` で潰す

## upstream取り込み前監査の記録（2026-09-27、1.139.1取り込み準備）

ベースタグ`1.134.0`から`1.139.1`へ直接取り込む（1.137.0 の試験ブランチ `merge/upstream-1.137.0` は main 未反映のまま参考扱い）。今回は**ファイル単位に加えて hunk 単位**で監査した。

- ファイル単位: fork 変更247ファイルのうちマーカー無しは31件で、すべてコメント不能ファイル（JSON/画像/lock）かドキュメント（README.md、src/vs/sessions/MOBILE.md）。
- **hunk 単位**: `git diff -U0 1.134.0 HEAD` の各 hunk について「hunk とその直前8行に PARA-PATCH/PARA-CODE があるか」を機械抽出すると205件。領域別にサブエージェントで1件ずつ判断し、関数・オブジェクト冒頭の既存マーカーで説明済みのもの（`terminalMenus.ts` の `disposables.add(` 置換30件など）を除いた**未マークの fork 変更に計162行のマーカーを後付け**した（コメント行の追加のみ、削除0、typecheck-client 通過）。ファイル単位の監査では「同じファイルの別の場所にマーカーがある」だけで合格してしまい、`setTransientTitle` 系（`e7ec0beb0a9`）や Shared Process の自動再起動（`app.ts`、`9eb031a1db1`）などが素通りしていた。**次回からは hunk 単位で監査すること**
- マーカーを入れられなかった箇所: `src/vs/workbench/contrib/webview/browser/pre/index.html` のインライン script（CSP の sha256 で固定されており、1行足すとハッシュ不一致で全 webview が白紙になる）。取り込み時は upstream との差分を手で確認し、変更したらハッシュを再計算して `paradisWebviewServiceWorkerControl.test.ts` を通す
- 規約違反として記録のみ（今回は修正しない）: `editorCommands.ts` の `splitEditor` が既存関数のシグネチャを変えている（`accessor` を先頭に追加し async 化、`fcbac0e0e4c`）／fork 所有の `paradisAgentBrowserService.ts:2408` に `PARA-PATCH:` が付いている（fork 所有ファイルは PARA-CODE ヘッダーのみ）／`agentSessionsControl.ts` に日本語の PARA-PATCH がある／`cd1c92cb614`（PR #73）が `para:` プレフィックス無し
- `git merge-base --is-ancestor 1.134.0 1.139.1` は真、`git diff --name-only 1.139.1...1.134.0` は0ファイル（endgame の半端マージ罠なし）
- 事前調査: fork変更ファイルのうち upstream(1.134→1.139.1)も触ったものは120ファイル/17180行。modify/delete は3件（`build/buildfile.ts`・`build/lib/optimize.ts` は upstream #336126 で旧ビルド基盤ごと削除。fork は同じ内容を `build/next/index.ts` 側にも持っている／`.github/workflows/require-commit-trailer.yml`）。add/add は0件。Electron 42.8.1 → 43.6.0、`.nvmrc` は変更なし

### 1.139.1マージで実際に踏んだ問題（2026-09-27追記）

- **旧ビルド基盤の削除**: upstream #336126 で `build/buildfile.ts`・`build/lib/optimize.ts`・gulp の `bundle-vscode` が消え、esbuild の `build/next/*` に一本化された。fork の追加エントリ（`paradisPtyDaemonBridgeMain`・`paradisPtyHostDaemonEntry`（desktop/server）・`paradisBrowserMcpShim`）と `inlineParadisSentryPlugin` は `build/next/index.ts` に残し、同梱リソース（changelog など）は新規の `build/next/paradisResources.ts` に分けて `resources.ts` から1箇所の PARA-PATCH で読む（minify しない）。`build/gulpfile.vscode.ts` の `vscodeResources` への追記は効かなくなった
- **`npm install` が Sentry を黙って上げる**: lock 再生成で `@sentry/electron` などが上がり、`allowScripts` の検査が落ちた。`@sentry/electron 7.17.0`・`@sentry/node-native 10.70.0`・`@sentry/cli 3.6.2` に固定し直した。lock を作り直したら必ず Sentry の版を確認する
- **自動マージが引数の意味を変えた**: `webContentsViewRendererFeature.ts` の `_refresh(true)` は、fork では `boundsArePushed`、upstream では `restartScreenshot` の意味で、どちらも第1引数だったためコンフリクトせずに混ざった。`_refresh(boundsArePushed = false, restartScreenshot = false)` の2引数に分け、upstream の呼び出しを `this._refresh(false, true)` に直した。**bool 引数を足しているパッチは自動マージ後に全呼び出し点を読むこと**
- **試験ブランチだけにあった修正は再発する**: 1.137 試験で直した phoneLayout.css の通知センター位置（`--modern-ui-notifications-block-start-inset` を渡す形）は main に入っていなかったため 1.139 でも同じ退行が出た。ブラウザ系（`setSharedWithAgent` が新しいモデルを返す、`IBrowserViewSessionOptions` の判別ユニオン化と fork の Profile スコープ、`getOrCreateLazy(data)`）も試験ブランチの fork 所有ファイルの修正を `git apply` で持ち込んだ。試験ブランチで直したものは一覧にしておき、本番マージで必ず確認する
- **Modern UI の変更で fork の見た目が崩れた**: アクティビティバーがプライマリサイドバーと一体のカードになり、同じ `activitybar` クラスを持つ fork の補助アクティビティバーの継ぎ目が崩れた。タブの既定が `connected` になり、ウィンドウ透過中にタブ帯だけ不透明になった（fork の既定設定で `workbench.experimental.modernUIEditorTabStyle: pill` に戻した）。ウォーターマークの上書きは upstream と同じ詳細度で並んでいて、読み込み順だけで勝っていた（クラスを重ねて詳細度を上げた）
- **upstream の挙動変更が fork 所有ファイルを壊した**: `terminalInstance.rename(undefined)` が 1.139 で「static title を消して OSC 購読を張り直す」動きになり、プリセット端末の手動の名前がリロードで消えた（`paradisPresetService.ts` の `_restorePresetTitle` で static title がある端末には呼ばないようにした）。型では検出できないので、fork が upstream API を呼ぶ箇所は意味的レビューで確認する
- **upstream の新しいポーリングがレート制限対策を迂回した**: `codeReviewService.ts` にレビュースレッドの `startPolling()`（GraphQL を60秒ごと）が追加された。fork の `startChangeDrivenReviewThreadsRefresh` に差し替えた。upstream が `startPolling()` を新しく呼んでいないかは毎回 grep する
- **新しいワークフロー**: 1.139 で `.github/workflows/codeql.yml`（main への push・PR・週次、ubuntu-latest）が入った。公開リポジトリなので無料で動くが、時間がかかる
- **upstream 1.139 の新しい lint ルール `code-no-bracket-notation-for-identifiers`**: fork 所有の37ファイルで536件の警告になり、hygiene（警告も失敗扱い）がコミットフックで止まるため `eslint --fix` で一括修正した（`obj['x']` → `obj.x`、実行時の意味は同じ）
- **テストの既知の失敗（マージ前から存在、原因は別）**: node 側を `paradis`・`sessions`・`platform/terminal`・`platform/agentHost` まとめて回すと `CommandAutoApprover`・`SessionPermissionManager`・`AgentSideEffects` が落ちる（agentHost だけなら全件通る。fork のテストが共有状態を汚している疑い。main でも同じ）。`ParadisWarmLeaseController` の2件は node に `globalThis.addEventListener` が無いため。`fileViewers/test/performance` は node ランナーで `window is not defined` になり読み込み自体が止まるので、node テストは `--runGlob` で範囲を絞って回す。Electron 側は `ParadisCcusage warm lease`・`ParadisOfficeMemory`・`ParadisOfficePerformance`・`ParadisMobileCanvasService attachment ledger TTL`（4件）が既存の失敗
- 意味的レビューは7領域（build・CI、エディタ・workbench、browserView・CDP、ターミナル・pty、sessions・モバイル、native・update、CSS）。CSS 専用の担当を置いたことで、型もテストも通る見た目の退行を3件拾えた

## upstream取り込み前監査の記録（2026-07-18、1.129取り込み準備）

1.129取り込み準備中に、ベースコミット（上記`7ad5744c685`）との全差分をマーカーと突き合わせる監査を実施した。結果と対処:

- upstream由来ファイルへのfork変更153ファイルのうち、**32個の.tsファイルにPARA-PATCHマーカーが無かった**。全て`para:`プレフィックスも無い一連のコミット由来（`ff54c8f7aa5` fix: harden Para Browser MCP isolation and recovery / `e07c045da85` fix: preserve terminal recovery and workspace ownership / `8f9c774d82f` fix: harden mobile relay routing and recovery / `b22aec2a71c` feat: pin auxiliary windows to spaces / `ae344defc3d` feat: scope unsaved editors to spaces / `fcbac0e0e4c` feat: optionally open a terminal when splitting editors / `fb3726df103` fix: make scoped retirement crash-safe / `e7ec0beb0a9` feat: add automatic Codex terminal titles / `478af1a1ea8` fix: redraw terminals after window moves）
- 対処: 32ファイル全てにPARA-PATCHマーカーを後付けした（コメント行のみ121行追加、挙動変更なし、typecheck-client通過）。コミットプレフィックス違反の過去履歴は書き換えない（force push回避）。**今後のコミットは必ず`para:`プレフィックスを付けること**
- 判明した副次的な問題: terminal系のupstream由来ファイル（`terminal.ts`等）のフィールド説明コメントに`PARA-CODE:`マーカーが使われている箇所がある。`PARA-CODE`は「fork新規作成ファイル全体」用のマーカーなので、`grep -rl "PARA-CODE:"`のfork所有ファイル一覧に誤って載る。将来の整理候補（実害は小さいので未修正）
- 監査の再現方法: `git diff --name-status <ベースコミット> HEAD` でM（変更）ファイルを列挙し、各ファイルの`PARA-PATCH`有無をgrep。コメント不能ファイルは本ファイルの台帳と突き合わせる

## upstream取り込み前監査の記録（2026-07-27、1.130取り込み準備）

ベースタグ`1.129.0`との全差分（upstream由来ファイルへのfork変更170ファイル）を監査した。結果:

- **PARA-PATCHマーカーの欠落はゼロ**。マーカーが無かった28ファイルは全てコメント不能ファイル（`product.json`・`package.json`/`package-lock.json`・テーマJSON・`i18n.resources.json`・`vscode-known-variables.json`・extensions配下のpackage.json 2件・アイコン/インストーラー画像19件）で、いずれも下記「コメントを書けないファイルへの変更一覧」に記載済みだった。1.129取り込み前に実施したマーカー後付けと`para:`プレフィックスの徹底が効いている
- 1.129監査で「将来の整理候補」とした`PARA-CODE:`のフィールドコメント誤用は**未修正のまま残っている**（`src/vs/platform/terminal/common/terminal.ts` 5箇所 / `src/vs/workbench/contrib/terminal/browser/terminal.ts` 3箇所 / `src/vs/workbench/contrib/terminal/browser/agentHostTerminalService.ts` 1箇所）。これらのファイルはファイル単位では`PARA-PATCH`も持つため監査は通る。実害は小さい
- `npm run valid-layers-check` の`layersChecker.ts`が既定の4GBヒープでOOMする。**これは1.130マージ起因ではなく`main`でも同様に再現する既存の問題**で、`NODE_OPTIONS=--max-old-space-size=8192`を付ければ通過する（fork のソース増加が原因。upstream自身も1.130で`tsec-compile-check`に同じ`--max-old-space-size=8192`を追加している）。恒久対応するなら`package.json`の`valid-layers-check`にPARA-PATCHで同オプションを足すのが自然

## upstream取り込み前監査の記録（2026-08-11、1.132取り込み準備）

ベースタグ`1.130.0`との全差分（upstream由来ファイルへのfork変更188ファイル、fork新規1513ファイル）を監査した。結果:

- **PARA-PATCHマーカーの欠落は1件**: `src/vs/platform/update/test/electron-main/abstractUpdateService.test.ts`（自己ホスト更新フィードのCloudflare Accessヘッダを検証するfork独自テスト108行）。由来コミットは`587361a6e62 test: cover Para Code fork features`で、**`para:`プレフィックスも欠けていた**（この1件のみ。他のコメント不能28ファイルは全て下記台帳に記載済みで1.130監査から増減なし）。対処: マーカー6箇所を後付け（コメント行のみ、挙動変更なし、typecheck-client通過）
- **`PARA-CODE:`マーカーの欠落を新たに検出**。fork新規ファイルのうち、**upstream由来ディレクトリに置かれた6ファイル**（`src/vs/platform/browserView/common/browserViewAutomationInput.ts`とそのtest 3件 / `src/vs/workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.ts`とそのtest 1件）にマーカーが無かった。ここはupstreamが将来同名ファイルを追加するとadd/add衝突になり、かつファイル単体では fork所有と判別できないため後付けした
- **未対処として残したPARA-CODE欠落**（実害が小さいため）: `src/vs/paradis/`・`src/vs/sessions/contrib/`配下のtestファイル約60件、`app/mobile/`のtest 4件、`cloudflare/update-server/`のtest 2件。いずれもディレクトリ構成でfork所有と判別でき、upstreamとのパス衝突リスクも無い。vendor同梱物（chrome-devtools-mcp / react-devtools のbuild成果物、docx-preview等のminified）は規約上マーカー対象外
- **リポジトリルートに用途不明のfork新規HTMLが2件コミットされている**（`mok.html` / `sw.html`）。デバッグ時の一時ファイルが残ったものと思われる。削除するかは未判断
- 1.129監査で挙げた`PARA-CODE:`のフィールドコメント誤用（terminal系3ファイル）は引き続き未修正
- 事前調査の結果: fork変更188ファイルのうちupstream(1.130→1.132)も触ったものは**62ファイル / 3386行**。add/add衝突・modify/delete衝突はいずれもゼロ。upstream churnの上位は`preload-browserView.ts`(1126行)・`package-lock.json`(1039行)・`browserViewInspector.ts`(145行)・`browserViewFrameInspector.ts`(109行)で、**browserView/CDP領域が最大の危険地帯**
- ビルド前提の変更: Electron `42.6.0` → `42.7.1`（`.npmrc`の`target`/`ms_build_id`も追従）。`.nvmrc`は変更なし。`valid-layers-check`スクリプトがupstream側で`layersTypeCheck.ts`方式に置き換わった

### 1.132マージで実際に踏んだ問題（2026-08-11追記）

- **upstreamのリファクタでfork機能が経路から落ちた（型エラーで検出）**: `browserViewInspector.ts` の `getElementHandle()` は1.130までフレームハンドルをそのまま返していたが、1.132で「メンバーを1つずつ転送するラッパーオブジェクト」に書き換えられた。forkが `IElementHandle` に足していた `getOuterHTML()`（ブラウザの右クリック「Copy Element」）がラッパーから漏れ、`typecheck-client` が `TS2741` で検出。ラッパーに1行足して解消。**インターフェースのコンフリクトを解消しただけで満足せず、その実装側がどう変わったかを必ず確認すること**
- **upstreamがCSSトークンを差し替えるとforkの上書きCSSが古い色を指し続ける（型では検出できない）**: 1.132で floating panels（モダンUI）の配色が `agentsPanel.*` → `surface.*` に移行した。fork の透過CSSは `!important` と高い詳細度で勝ち続けるため見た目が壊れることはないが、参照トークンが古いままだと本家と色がずれる。`paradisWindowTransparency.css` を `--vscode-surface-background` に追従させた
- **ソースからの開発ビルドは Sentry の renderer import で起動しない（1.132起因ではなく`main`でも同じ）**: `paradisSentryRenderer.ts` の `import * as Sentry from '@sentry/electron/renderer';` が bare specifier のままコンパイルされるため、`scripts/code.sh` 起動時に renderer が `Failed to resolve module specifier` で落ち、**ワークベンチがスプラッシュのまま止まる**。`main` のビルド成果物でも同一の症状を再現して確認済み（＝マージ由来ではない）。実機確認したいときの回避策は **`out/vs/paradis/paradis.electron-browser.contribution.js` から Sentry の import 1行を外して起動する**（ソースは触らない。検証後に戻す）。パッケージ版は build パイプラインが解決するので影響しない。恒久対応するなら動的importへ寄せる（`sentry-packaging-pitfall` の方針と同じ）
- **`npm install` は root が終わっても続きがある**: root完了後に build/ と extensions/ のサブインストールが走り、全体で1時間近くかかる。`node_modules` ができた時点で終わったと判断しないこと

## pushトラブルの記録（2026-07-01）

フル履歴（2,222,499オブジェクト、1.30 GiB）のまま`git push`すると、TCP接続が`CLOSED`または`CLOSE_WAIT`になって進捗ゼロのままハングする現象が複数回発生（`http.version HTTP/1.1`固定、`http.postBuffer`拡大、`http.lowSpeedLimit`設定を試しても解消せず）。原因はネットワーク経路側の問題と推測されるが特定はできていない。

対策として履歴を1コミットに圧縮（`git checkout --orphan squashed-base` → `git add -A`（`node_modules`/`.build`は`.gitignore`済みで除外される）→ `git commit --no-verify`（huskyのpre-commitフックが200万ファイル規模のインデックスに対して固まったためスキップ。通常の開発コミットではフックを飛ばさないこと）→ `git branch -m main`）してから再push。転送対象が19,683オブジェクト・LFS 272MB + 通常オブジェクト46MBまで減り、成功した。

**今後もし大きな変更を一括で加える場合、同様に転送量に注意すること。**

## hygieneチェックとproduct.jsonの既知の衝突

`gulpfile.hygiene.js`に「`product.json`に`extensionsGallery`キーを含めてはいけない」というMicrosoft本家向けのチェックがある（本家では公式Marketplace設定を別経路で注入するため、独自混入を防ぐルール）。私たちのforkはOpen VSX切り替えのために意図的に`extensionsGallery`を追加しているので、このチェックには**恒常的に引っかかる**。`product.json`を変更するコミットは`--no-verify`が必要になる。将来的には`gulpfile.hygiene.js`側にこのチェックの除外条件を追加するパッチを検討してもよい。

`mise.toml`のような新規追加ファイルも「Missing or bad copyright statement」でhygieneに引っかかる。Microsoftのコピーライトヘッダーを付けるのは適切ではないので、自分たちの新規ファイルに対するhygieneルールの扱いは今後整理が必要（`CLAUDE.md`のコンフリクト最小化ルール策定と合わせて検討）。

## コメントを書けないファイルへの変更一覧（2026-07-02整備）

`PARA-PATCH:` / `PARA-CODE:` マーカーは、その形式で有効なコメント構文を持つファイルへ埋め込む。JSON（コメント非対応の厳密パース）、plist、entitlements、バイナリ資産等にはマーカーを埋め込めないため、代わりにこの一覧を更新すること。upstream取り込み時、この一覧に載っているファイルはコンフリクトしやすい・または本来の意味が変わっていないか要確認。

| ファイル | 変更内容 | 理由 |
|---|---|---|
| `ThirdPartyNotices.txt` | Orca（stablyai/orca、Copyright (c) 2026 Lovecast Inc.、MIT）の項目を PowerShell/EditorSyntax の前に追加 | xterm の IME パッチ（`build/npm/paradisXtermImePatch.ts`）が Orca 由来のコードを製品の `lib/xterm.js` に入れるため。コメント構文が無いのでここに記録する |
| `product.json` | `nameShort`/`nameLong`/`applicationName`/`dataFolderName`/`win32*`/`darwinBundleIdentifier`等ブランディング全般を「Para Code」向けに変更、`extensionsGallery`を追加（Open VSX）、`voiceWsUrl`を削除。upstream 1.139 で追加された `linuxDesktopName`（Linux の `.desktop`/appdata のファイル名と `StartupWMClass`）は `ltd.paradis.ParaCode` にした | Phase 2ブランディング + Open VSX切り替え |
| `product.json` | `quality: "stable"` / `updateUrl` / `downloadUrl` を追加。`updateUrl`はカスタムドメイン`https://paracode-updates.paradis.ltd`（初期デプロイ時の`https://para-code-update-server.cloudflare8234.workers.dev`から切り替え済み、動作確認済み）。**`downloadUrl`のみ`https://updates.paradis.ltd/download`の暫定プレースホルダーのまま**（linux用の「更新あり時に開く案内ページ」で必須ではない） | 自動アップデート基盤の有効化。`quality`未設定だと`abstractUpdateService.ts`の`getProductQuality()`がundefinedを返し更新機構自体が無効化される |
| （現在は差分なし。下の経緯参照） | `builtInExtensions` の `ms-vscode.vscode-js-profile-table` の `sha256` は現在 upstream記録値（marketplace版 `a962a1e6…`）のまま | 2026-08-11時点ではOpen VSX版がmarketplace版と再パッケージによりバイト不一致（差分は`extension.vsixmanifest`・`package.json`整形・同梱ライセンスファイル名・`telemetry.json`有無のみ、実行コードはバイト単位で同一と確認済み）だったため、forkは`extensionsGallery`をOpen VSXに向けている都合上、Open VSX実測値`50d00270…`に**意図的に差し替えていた**。2026-08-27、Open VSXが再度パッケージを更新し**marketplace版とバイト完全一致**（`shasum -a 256`一致を確認）するようになったため、この差し替えは不要になり撤回した（リリースCIが`Checksum mismatch`で落ちたのを機に発覚）。**upstreamがこの拡張のバージョンを上げるたびに再発しうる**: `curl -fsSL https://open-vsx.org/vscode/gallery/publishers/ms-vscode/vsextensions/vscode-js-profile-table/<版>/vspackage \| shasum -a 256` と `curl -fsSL https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode/vsextensions/vscode-js-profile-table/<版>/vspackage \| shasum -a 256` を突き合わせ、不一致ならOpen VSX実測値に差し替える（一致するようになったら差し替えは戻してよい） |
| `build/lib/i18n.resources.json` | `vs/sessions/contrib/terminalGrid` エントリを追加 | 新規contributionディレクトリの`localize()`利用に伴うi18nリソース登録 |
| `extensions/theme-defaults/themes/2026-dark.json` | primary accent色を`#3994BC`系→`#09AFD9`系（button/focusBorder/badge/選択背景等、約25箇所、アルファ値は維持）に置換 | ユーザー指定のブランドカラーへの統一 |
| `extensions/theme-defaults/themes/2026-light.json` | primary accent色を`#0069CC`系→`#0598BD`系（同上、白背景に対するコントラストを保つため若干暗めに調整）に置換 | 同上（ダーク/ライト両テーマでの一貫性） |
| `resources/darwin/code.icns` | アプリアイコンをユーザー指定画像に差し替え | ブランディング |
| `src/vs/paradis/contrib/watermark/browser/media/paradisWatermark.png` | 新規追加（fork所有バイナリ）。空エディタグループwatermarkのletterpress画像の差し替え先（`paradisWatermark.css`から参照） | ユーザー指定のwatermark画像への変更 |
| `src/vs/paradis/contrib/notifications/browser/media/sounds/*.mp3`（11ファイル: shamisen/arcade/ping/supersetquick/supersetdoowap/agentisdonewoman/codecompleteafrican/codecompleteafrobeat/codecompleteedm/comebacktothecode/shabalabadingdong） | 新規追加（fork所有バイナリ）。Superset (`apps/desktop/src/resources/sounds/`) のビルトイン着信音をそのまま移植。`FileAccess.asBrowserUri('vs/paradis/contrib/notifications/browser/media/sounds/<file>.mp3')` で参照（`paradisNotificationSoundPlayer.ts`） | 通知サウンド機能（Phase D）のビルトイン着信音アセット |
| `resources/paradis/extensions/*.vsix`（標準同梱9ファイル: mosapride.zenkaku / AntiAntiSepticeye.vscode-color-picker / netcorext.uuid-generator / ms-vsliveshare.vsliveshare / jeff-hykin.polacode-2019 / yudai1204.polacode-button / VisualStudioExptTeam.vscodeintellicode（68MB） / VisualStudioExptTeam.intellicode-api-usage-examples / evondev.indent-rainbow-palettes（18MB）。後段のContainer Toolsパッチ版1ファイルと合わせて実体は計10ファイル） | 新規追加（Open VSX未公開のため同梱するサードパーティ拡張のVSIX。標準同梱分は合計約92MB）。`paradisDefaultExtensions.contribution.ts` が起動時に `appRoot` 相対で解決し `IExtensionManagementService.install()` でインストール。ビルド時は `build/gulpfile.vscode.ts` の `packageTask` が成果物へコピー | 既定拡張自動インストール機能（VSIX同梱分）。IntelliCodeはMicrosoft独自ライセンス（再配布時は要確認）。サイズが大きいためGit LFS化を将来検討 |
| `extensions/git/package.json` | `git.autofetch` の `agentsWindow.default` を upstream の `true` から `false` へ変更 | GitHubレートリミット対策。Agent Sessionsウィンドウで数百worktreeを開くと180秒ごとに全リポジトリへ `git fetch` が走り、GitHub側の濫用検知（二次制限）に掛かるため。既存ユーザーの明示設定は `sessionParaGithubSettingsMigration.ts` の一回限りマイグレーションでリセット |
| `extensions/git/package.json` / `extensions/git/package.nls.json` | ソース管理の「ブランチの変更点」ビュー用に、設定 `git.paraBranchDiff.enabled`（既定 `true`、`scope: resource`）、`contributes.views.scm` への独自TreeView `git.paraBranchDiff`、submenu `git.paraBranchDiff.viewAndSort` とその項目定義、コマンド6件（`git.paraSelectBranchDiffBase` ほか `git.paraBranchDiff*`。git本体の流儀に合わせ操作系には `"enablement": "!operationInProgress"` 付き）、`view/title` / `view/item/context` / `commandPalette` のメニュー項目、対応する nls 文字列を追加 | 現在のブランチが分岐元から積み上げた差分（`git diff <base>...HEAD`）を、SCMビューコンテナ内の独立パネル（「グラフ」の下）に出す独自ビュー。`order` を指定しないと `Number.MAX_VALUE` 扱いになり自動的に最下段へ並ぶ（`viewsExtensionPoint.ts` の `order` 決定は「そのコンテナを所有する拡張」か `viewOrderDelegate` 持ちのコンテナに限られ、SCMはどちらでもない）。なお同じ `viewsExtensionPoint.ts` の `showCollapsed()` により、SCMコンテナに拡張が足したビューは**初回は必ず折りたたみ状態**で出る（`visibility` では上書き不可）ため、件数は `TreeView.description` に出して畳んだままでも読めるようにしてある。`TreeView.badge` は使わない（ビュー単位ではなくコンテナのアクティビティバッジへ合算され、SCMの未コミット件数と足し算になるため）。実装本体は `extensions/git/src/paraBranchDiff.ts`（算出）と `paraBranchDiffView.ts`（描画）でどちらも PARA-CODE、`repository.ts` / `main.ts` 側は PARA-PATCH |
| `extensions/github/package.json` | `github.branchProtection` に `agentsWindow: { "default": false }` を追加し、`enabledApiProposals` に `agentsWindowConfiguration` を追加（未宣言だと設定ポイントが `agentsWindow` をエラー付きで削除する。git拡張はupstreamが宣言済み） | GitHubレートリミット対策。既定ONだと開いたリポジトリ×remoteごとに起動時GraphQLが2本以上走り、数百worktreeで一斉バーストするため（通常ウィンドウの既定はupstreamのまま `true`） |
| `build/lib/stylelint/vscode-known-variables.json` | `others` に `--paradis-transparency-opacity` / `--paradis-titlebar-bg` / `--paradis-statusbar-bg` / `--paradis-workspace-color` / `--paradis-pr-color` / `--paradis-agent-live-row-height` / `--paradis-preset-cluster-flyout-max-width` / `--paradis-cursor-duration` / `--paradis-agent-color` / `--para-rh-color` / `--paradis-space-accent` / `--paradis-space-accent-unfocused` を追加。**注意: 初回追加時に `others` 配列全体（約70行）をアルファベット順に再ソートしたため、diffは純増分より大幅に広い（±70行超）**。upstream取り込みでこのファイルがコンフリクトした場合、upstream側の配列を丸ごと採用し、上記paradis 9変数だけ再挿入するのが最も安全 | ウィンドウ透過機能・Workspacesビュー色バー・PR状態チップ・エージェント一覧のタイル高さ・コマンドプリセットのクラスター展開幅上限・ブラウザ一覧に描き直すエージェントカーソルの移動時間のカスタムCSS変数（`--paradis-agent-live-row-height` は paracode-93 で `--paradis-agent-live-min-row` から改名。`--para-rh-color` は Para ホストビューの色帯で、導入時に登録が漏れていたぶんを後追いで追加。`--paradis-chip-color` は更新履歴モーダルのカテゴリチップ色で、導入時に名前空間なしの `--chip-color` になっていたぶんを改名して後追い登録。`--paradis-space-accent` / `--paradis-space-accent-unfocused` はエディタタブ上端の色帯へ流すアクティブスペース色とその減光版、フォーカスされていないグループ用）。hygiene の stylelint (Unknown variable) を通すため |
| `package.json` / `package-lock.json` | `dependencies` に `exceljs@^4.4.0` と `jszip@^3.10.1` を追加（`npm install ... --save --ignore-scripts`） | Excelビューア/差分機能。exceljs は xlsx のセル/スタイル/結合のパース（Buffer/stream 依存のため shared process `src/vs/paradis/contrib/fileViewers/node/` でのみ使用）。jszip は xlsx(ZIP) から図形(斜線コネクタ)の drawing XML を取り出すため（同じく shared process）。eslint の node層import許可リスト（`eslint.config.js` の hasNode `allow`）にも `'exceljs'` `'jszip'` を PARA-PATCH で追加済み |
| `package.json` / `package-lock.json` | `@sentry/electron` / `@sentry/node-native` / `@sentry/cli` を追加し、公式CLIとnative stacktrace補助のinstall scriptだけを`allowScripts`で許可 | Para CodeデスクトップのJS例外・Electron native crash収集、Debug ID付きsource mapアップロード |
| `package.json` | `scripts.valid-layers-check` の先頭を `node build/checker/layersChecker.ts` → `node --max-old-space-size=8192 build/checker/layersChecker.ts` に変更（2026-07-27、1.130取り込み時） | forkのソース増加により`layersChecker.ts`が既定4GBヒープで`Ineffective mark-compacts near heap limit`のOOM死する（1.130取り込み前の`main`でも再現する既存問題）。後続の`tsc`各ステップは既定ヒープのままで通るため、パッチはこの1コマンドのみ。upstream自身も同じ理由で`tsec-compile-check`に`--max-old-space-size=8192`を付けている |
| `src/vs/code/electron-browser/workbench/workbench.html` / `workbench-dev.html` | CSP の `trusted-types` 許可ポリシー一覧に `paradisSpreadsheetDrawings` を1トークン追加（`content` 属性内のため行内コメント不可） | Excel図形(斜線)を drawing XML から SVG 化する際、renderer の `DOMParser.parseFromString` が Trusted Types 強制でブロックされる。`createTrustedTypesPolicy('paradisSpreadsheetDrawings', ...)`（`paradisSpreadsheetDrawings.ts`）で作るポリシー名を CSP 許可リストに載せないと `createPolicy` が例外→生文字列fallback→ブロックとなる。通常ウィンドウ(workbench.html)専用機能のため sessions html は対象外 |
| `app/mobile/modules/para-glass-morph/expo-module.config.json` | 新規追加（ローカルExpoモジュールの定義JSON。`apple.modules: ["ParaGlassMorphModule"]`） | ＋メニューのLiquid Glass液体モーフ（SwiftUIのglassEffectID + withAnimation spring）用ネイティブビュー。JSONのためマーカー不可。同モジュールのSwift/podspec/index.tsにはPARA-CODEヘッダーあり |
| `cloudflare/update-server/package.json` / `package-lock.json` / `tsconfig.json` | 新規追加（fork所有、upstreamに同パスなし）。自動アップデートサーバー（Cloudflare Worker）のマニフェスト・lockファイル・tsconfig。同ディレクトリの `src/*.ts` / `wrangler.toml` にはPARA-CODEマーカー記載済み | 自動アップデート基盤（`updateUrl`が指すWorker）の付帯設定ファイル。JSONのためマーカーを埋め込めない |
| `src/vs/paradis/contrib/browserExtensions/electron-main/media/react-devtools/**`（61ファイル） | 新規追加（vendoredサードパーティ成果物、MIT）。React Developer Tools 7.0.1 のChrome拡張をCRX3から展開してそのまま同梱。取得元・更新手順は `src/vs/paradis/contrib/browserExtensions/README.md` 参照 | 内蔵ブラウザへReact DevToolsを既定ロードする機能。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslint/stylelintから除外（`build/filters.ts`・`.eslint-ignore` のPARA-PATCH） |
| `app/mobile/package.json` / `app/mobile/tsconfig.json` / `app/pnpm-lock.yaml` | Expo SDKを52→57へ移行（react-native 0.76→0.86、react 19.0.0→19.2.3）、`@expo/vector-icons` と `react-native-get-random-values` を新規依存として追加。`tsconfig.json` には `expo install --fix` が自動付与した `"extends": "expo/tsconfig.base"` を追加。`pnpm-lock.yaml` は `app/` pnpmワークスペース全体でこれらの依存解決を更新 | SDK 52がXcode 26.6/iOS 26.5ツールチェーンと非互換で、アプリがそもそも起動しなかった（「App entry point not found」）。動作確認済みのvanilla baselineに一致するSDK 57へ切り替えて解決 |
| `app/package.json` | 新規追加（fork所有）。`app/` pnpmワークスペース全体のprivateルートマニフェストと共通scripts | Para Codeモバイルアプリ・protocol・relayを単一ワークスペースとして管理するため |
| `app/protocol/package.json` / `app/protocol/tsconfig.json` | 新規追加（fork所有）。モバイルリレープロトコル共有パッケージのマニフェストとTypeScript設定 | PC・relay・モバイル間で型とプロトコル定義を共有するため |
| `app/relay/package.json` / `app/relay/tsconfig.json` | 新規追加（fork所有）。モバイルリレーサーバーのマニフェストとTypeScript設定 | Para Codeモバイルリレーをビルド・実行するため |
| `app/mobile/modules/para-live-activity/expo-module.config.json` | 新規追加（fork所有）。Para Live Activity Expo moduleのプラットフォーム・モジュール登録設定 | iOS Live ActivityネイティブモジュールをExpoから検出・読み込みするため |
| `app/mobile/modules/para-ipad-input/expo-module.config.json` | 新規追加（fork所有）。`apple.modules: ["ParaIpadInputModule"]` | iPad の外付けキーボードのショートカット（UIKeyCommand）とポインタのホバー（UIPointerInteraction）のローカル Expo モジュールを検出・読み込みするため。JSONのためマーカー不可。同モジュールの Swift・podspec・index.ts には PARA-CODE ヘッダーあり。取り込んだら `app/mobile/ios` で `pod install` が要る |
| `app/mobile/assets/icon.png` / `app/mobile/assets/pairing-logo.png` | 新規追加（fork所有バイナリ）。モバイルアプリアイコンとペアリング画面用ロゴ | Para CodeモバイルのブランディングとペアリングUI表示のため |
| `app/mobile/native/ParaCodeWidgets/Info.plist` | 新規追加（fork所有）。Live Activity / Dynamic Island Widget Extensionの設定ファイル | ParaCodeWidgets拡張のbundle情報と実行設定を追跡・復元するため |
| `mise.toml` | 新規追加（fork所有）。Node.jsツールチェーンのバージョン固定。コメント構文はあるが、`PARA-CODE`を冒頭へ置くとupstream hygieneのcopyright検査に失敗するためファイル内マーカーの代わりに本台帳で管理 | Para Code開発環境のNode.jsバージョンを統一しつつ、不適切なMicrosoft copyrightを付与しないため |
| `app/mobile/assets/xterm/xtermBundle.json` | 新規追加（vendoredサードパーティ、MIT）。`@xterm/xterm@6.1.0-beta.288`（リポジトリroot `node_modules` から取得）の `lib/xterm.js` と `css/xterm.css`、および `@xterm/addon-unicode11@0.10.0-beta.288` の `lib/addon-unicode11.js` を `{version, js, css, unicode11Js, unicode11Version}` の1 JSONにバンドル。`app/mobile/src/components/termView.tsx` がWebViewへ埋め込むHTMLに展開する。更新時は同じ手順で再生成（`</script` を含まないことを確認する） | モバイルのターミナル表示をxterm.jsで行うため（TUI対応、オフライン完結・CDN不要）。unicode11はPC側と文字幅表（絵文字・CJK記号の桁数）を一致させるため必須。JSONのためマーカーを埋め込めない |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `marked` を依存に追加 | モバイルのファイルビューアの `.md` レンダー表示（レンダー/Raw切り替え）用 |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/**`（約190ファイル: pdf.min.mjs / pdf.worker.min.mjs / cmaps / standard_fonts / LICENSE） | 新規追加（vendoredサードパーティ成果物、Apache-2.0）。`pdfjs-dist@6.1.200` の build 成果物と CMap/標準フォントをそのまま同梱。取得元・更新手順は同ディレクトリの `README.md` 参照 | PC版PDFビューア（`paradisPdfFileEditor.ts`）が webview 内で pdf.js を実行するため。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-file-system@~57.0.0` を依存に追加 | モバイルのPDFビューア。リレー経由で受けたPDFバイナリをキャッシュファイルへ書き出し、WKWebViewのネイティブPDF表示に file:// URI で渡すため |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` / `app/mobile/app.json` | `@sentry/react-native` とExpo config pluginを追加。native build scriptsはfork所有のラッパー経由に変更し、repo root `.env` の `SENTRY_PAT` を子Expoプロセスの `SENTRY_AUTH_TOKEN` だけへ渡す | Para Code MobileのJS例外・native crash・app hang収集とHermes source map/native symbolアップロード（トークン自体は成果物・設定ファイルへ保存しない） |
| `resources/paradis/extensions/ms-azuretools.vscode-containers-2.4.107.vsix` | 新規追加（Para Codeパッチ版のContainer Tools拡張、MIT）。upstream `microsoft/vscode-containers` v2.4.5 をベースに、Containers系ビュー（Containers/Images/Volumes/Networks）をワークスペーススコープに絞る機能（設定 `containers.containers.scopeToWorkspace`、既定オン）と、フォルダ入れ替え時の全ビュー即時リフレッシュを追加。**コンテナ**はcomposeの `com.docker.compose.project.working_dir` ラベルが現在のワークスペースフォルダと無関係なものを隠す（composeでないコンテナは常に表示）。**ボリューム/ネットワーク**は `com.docker.compose.project` ラベルが「許可プロジェクト集合」に含まれる場合のみ表示（許可集合＝ワークスペースフォルダのbasenameをcompose正規化した名前 ∪ working_dirが現在ワークスペースに一致するコンテナのプロジェクト名。composeラベルの無いリソース＝ビルトインnetwork等は常に表示）。**イメージ**はcomposeビルドイメージが `<project>-<service>`/`<project>` 命名になる性質を利用し、ホスト上に存在する全composeプロジェクト名（コンテナ/ボリューム/ネットワークのラベルから収集）のうち許可集合に無いプロジェクト名 P について、リポジトリ名が `P-` 始まり or `P` 完全一致のイメージのみを隠す（alpine等の共有ベースイメージや無関係イメージは常に表示。「他スペースのものと確実に分かるものだけ隠す」方針）。WSLのUNCパス（`\\wsl$\...` / `\\wsl.localhost\...`）はLinuxパスへ変換して照合。バージョンはforkを示すためpatch+100系の `2.4.107`。forkソースは別管理のContainer Tools fork（ブランチ `paradis-workspace-scope`。変更点: `src/tree/containers/paradisWorkspaceScope.ts`（コンテナ+新規のimages/volumes/networksフィルタ）、`ContainersTreeItem.ts`/`ImagesTreeItem.ts`/`VolumesTreeItem.ts`/`NetworksTreeItem.ts` へのPARA-PATCH、`package.json`/`package.nls.json` の設定追加）。再ビルドは `npm ci && npm run build:esbuild && npm run package`。`installGivenVersion: true` によりpinnedとなり自動更新では上書きされない（既存のギャラリー版が入っていてもVSIXインストールが置き換える）。upstream拡張の新版へ追従する際はタグにrebaseして同手順で再生成 | スペース切り替え後もContainers系ビューに他スペースのcomposeリソース（コンテナ/イメージ/ボリューム/ネットワーク）が表示され続ける問題の解消（SCMの `paradisScmRepoScope` に相当する拡張側の対応） |
| `resources/win32/code.ico` / `resources/win32/code_150x150.png` / `resources/win32/code_70x70.png` / `resources/linux/code.png` | アプリアイコンを darwin と同じユーザー指定画像に差し替え（`resources/darwin/code.icns` から ImageMagick で生成。ico は 16/20/24/32/48/64/96/128/256px、linux png は 1024px） | ブランディング。darwin のみ差し替え済みで Windows/Linux が本家アイコンのままだった問題の解消 |
| `resources/win32/inno-big-{100..250}.bmp` / `inno-small-{100..250}.bmp`（計14ファイル） | Windowsインストーラー（Inno Setup）のウィザード画像を、白背景中央に Para Code アイコンを配置した画像へ差し替え（icns由来の1024px PNGから ImageMagick で各DPIスケールの寸法どおりに生成、BMP3形式） | ブランディング（インストーラー画面のみ影響）。`resources/win32/appx/` はマニフェストのみで画像アセット無しのため対象外 |
| `app/mobile/app.json` | `expo-notifications` プラグイン追加、iOS `UIBackgroundModes: [remote-notification, audio]` 追加 | APNsリモートプッシュ（アプリ未起動時の通知配送）と、PCから届く音声通知のバックグラウンド再生（`modules/para-voice-session`）。`audio` はユーザーが音声通知を開始している間だけ使う（無音ループでプロセスを保つ）。**注意: `app/mobile/ios/` は `app/.gitignore` で無視されるため、NSEターゲット等のネイティブ変更はリポジトリに残らない**。NSEのソースと復元手順は `app/mobile/native/NotifyExtension/README.md` 参照 |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/**`（docx-preview.min.js / jszip.min.js / LICENSE-docx-preview / LICENSE-jszip / README.md） | 新規追加（vendoredサードパーティ成果物）。`docx-preview@0.3.7`（Apache-2.0）と `jszip@3.10.1`（MIT/GPL-3.0デュアル、MITで使用）のUMD版 dist をそのまま同梱。取得元・更新手順は同ディレクトリの `README.md` 参照 | PC版Word(.docx)ビューア（`paradisDocxFileEditor.ts`）が webview 内で docx-preview を実行し .docx を HTML レンダリングするため。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |
| `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/docx-preview.min.js` | vendored本体への手動パッチ（2026-07-06〜07に7件、2026-08-29に1件追加＝計8件）。①`HtmlRenderer.levelTextToContent()` が番号付き/箇条書きリストの CSS `content` 値をテンプレートリテラルの二重ネストで壊して生成する既知バグ（docx-preview GitHub masterでも未修正）を正しい実装に置換。②VML図形パーサ（`Ce`関数）が`strokecolor`/`strokeweight`属性形式（実務文書で一般的）に対応しておらず、斜線コネクタ等の罫線装飾が透明になり完全に見えなくなる不具合を修正。③縦書き指定`<w:textDirection>`のVバリアント(`tbRlV`等)がマッピングに無く横書きにフォールバックし、セルが横方向にはみ出す不具合を修正。④`valueOfTblLayout`が`<w:tblLayout>`の属性名を`val`ではなく`type`を見るべきところを誤っており、`tblLayout=fixed`指定が常に無視されテーブル・ページ全体が異常な幅に拡大される不具合を修正（本件の核心バグ）。⑤`tblW=auto`かつ`tblLayout=fixed`の場合にgridCol合計から明示的widthを補完、および`tblLayout`省略時にwidth明示があれば`fixed`をデフォルト化。⑥ページ基準(`mso-position-*-relative:page`)のVML図形にleft/top:0を与え、アンカー段落位置との二重オフセットで別ページ上に描かれる位置ズレを修正（ビューア側CSSの`section.docx{position:relative}`とセット）。⑦hanging indent段落の行頭タブがWord仕様(インデント位置へのジャンプ)にならず右端のリーダー付きストップへ飛んで目次レイアウトが崩れる問題を修正。⑧（2026-08-29追加、機能追加であってバグ修正ではない）`parseDrawingWrapper`に`case"docPr"`を足して`wp:docPr@id`を拾い、`renderDrawing`が生成する枠へ`data-paradis-drawing-id`属性として出す。詳細と再パッチ手順は同ディレクトリの `README.md`「既知のバグへの手動パッチ」参照 | ①により番号・箇条書きの記号がブラウザのCSSパースエラーで一切表示されなかった（`content: none`）。②により実務の契約書・重要事項説明書等で使われる斜線コネクタ(直線コネクタ)が完全に非表示だった。③④⑤により複数ページの実務文書でページごとに白紙の幅が大きく食い違って見える不具合があった。⑧はdocx-previewが描かないグラフ・SmartArtを自前のSVGで補うために必要（`paradisWordObjectOverlayHtml.ts`）。docx-previewは理解できないdrawingでも枠だけは残すが、目印が無いと「どの図の枠か」を出現順で推測するしかなく、`mc:AlternateContent`のFallback(VML)を描くケースや画像・ヘッダー複製で必ずずれて別の図の位置に描いてしまう。`wp:docPr@id`で対応づけることでこれを排除している。ビルド済み第三者コードでコメント不可のためここに記録 |
| `app/mobile/native/NotifyExtension/Info.plist` / `NotifyExtension.entitlements` | 新規追加（fork所有）。NSEターゲットの設定ファイル（追跡用コピー。実体は gitignore された `ios/` 内） | プッシュ通知本文のNSE復号。plistはコメント不可のためここに記録 |
| `app/mobile/assets/docxpreview/docxPreviewBundle.json` | 新規追加。PC版Wordビューアの vendored パッチ済み `jszip.min.js` + `docx-preview.min.js` を `{version, jszip, docxPreview}` として同梱（xtermBundle.json と同方式） | モバイルのWordビューア（WebView内レンダリング）用。**PC側の min.js を更新したら再生成が必要**。生成手順は `src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/README.md`「モバイルアプリ用バンドル」参照 |
| `src/vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**`（約350ファイル: package.json / LICENSE / build/**） | 新規追加（vendoredサードパーティ成果物、Apache-2.0）。`chrome-devtools-mcp@1.5.0`（Google）のnpm公開物をそのまま同梱（依存ゼロの自己完結パッケージ、上流README/skillsのみ除外）。取得元・更新手順は同ディレクトリの `README.md` 参照 | para-browser MCPサーバーがペイン毎の子プロセスとしてspawnし、DevToolsツール群をプロキシ合流させるため（`paradisDevtoolsMcpProxy.ts`）。ビルド済み第三者コードのためマーカーを埋め込まず、hygiene/eslintから除外（`build/filters.ts`・`.eslint-ignore`・`.eslint-allowed-javascript-files` のPARA-PATCH。パッケージ更新時は allowlist の再生成が必要、手順は同ファイル内コメント参照）。パッケージ同梱は `build/next/index.ts` と `build/gulpfile.vscode.ts` の両方に glob 追加済み |

| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-screen-corner-radius@^1.1.0` を依存に追加 | ワークスペースドロワーを開いたときにコンテンツへ付ける角丸を、端末のディスプレイ角丸（iPhone 16 Pro=62pt、14 Pro〜16=55pt等）に一致させるため。iOSではプライベートAPI（`UIScreen._displayCornerRadius`）ではなく`uname()`のモデル識別子＋ルックアップテーブルで解決するためApp Store審査を通せる（同種の`react-native-screen-corner-radius`はプライベートAPIを難読化して使うため不採用）。JS側は`src/screenCornerRadius.ts`が`requireOptionalNativeModule`で引き、未リンク時はiOS 55pt/Android 0へフォールバックする |

| `app/mobile/app.json` | `expo.version` をリリースごとに上げる（`0.1.0` → `0.2.0` → `0.2.1` …） | アプリ内「アップデートのお知らせ」の導入にあわせた最初のバージョン。`src/changelog.ts` の `MOBILE_CHANGELOG` 先頭と一致していないとお知らせが出ない／古い内容が出るため、以後この2つは必ず同時に上げる（`src/changelog.test.ts` が一致を検査する） |
| `app/mobile/app.json` | `ios.supportsTablet` を `false` → `true`。あわせて `ios.infoPlist` に `UISupportedInterfaceOrientations`（iPhone: portraitのみ＝従来と同値）と `UISupportedInterfaceOrientations~ipad`（iPad: 4方向すべて）を明示追加 | iPad版対応。トップレベルの `expo.orientation` は `portrait` のまま残す（Androidの `screenOrientation` を従来どおり縦固定に保つため）。`@expo/config-plugins` の `withOrientation` は `createInfoPlistPluginWithPropertyGuard` 実装で、`ios.infoPlist.UISupportedInterfaceOrientations` が明示されている場合は上書きをスキップするため、この2キーがそのまま採用される。iPadだけ回転を許可し、幅が狭いSplit View/Slide Overでは `src/sizeClass.ts` の判定でiPhoneと同じ1カラムへ落ちる |

| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-clipboard@~57.0.1` を依存に追加 | エージェント詳細画面のタイムライン（`src/components/agentIoBlock.tsx`）で、ツールの入力・出力をコピーするボタンを出すため。RN本体の `Clipboard` は非推奨で、Expo SDK 57 の標準モジュールを使う。ネイティブモジュールのため追加後は iOS/Android の再ビルドが必要 |

| `app/mobile/native/ParaCodeWidgets/paracode-logo.png` | 新規追加（fork所有バイナリ）。`app/mobile/assets/pairing-logo.png` を `sips -Z 128` で縮小したコピー（gitignoreされた `ios/ParaCodeWidgets/` にも同一物を配置し、Widgetターゲットの Resources に pbxproj 手動登録済み） | Live Activity / Dynamic Island のロゴをホームタブのPCカードと同じPara Codeロゴにするため（復元手順は同ディレクトリ README 参照）。PNGのためマーカーを埋め込めない。**2026-09-27 の Live Activity 案 D でロゴを出さなくなり、いまはどのコードも読んでいない**（Resources の登録は残してある。消すなら pbxproj の `FD…A6` / `FD…B4` も一緒に外す） |

| `product.json` | Remote-SSH（リモート開発）対応で4点追加。(1) `serverDownloadUrlTemplate` を新設し、固定タグ `reh` のGitHub Releaseから `para-code-server-${os}-${arch}-${commit}.tar.gz` を取得させる。(2) `builtInExtensions` に `jeanp413.open-remote-ssh@0.3.1` を追加（sha256はOpen VSX実測値 `c6f16b22…`、metadataのUUIDは `open-vsx.org/vscode/gallery` の extensionquery から取得）。(3) `extensionEnabledApiProposals` を新設し同拡張へ `resolvers`/`tunnels`/`terminalDataWriteEvent`/`contribRemoteHelp`/`contribViewsRemote` を許可。(4) `remoteExtensionTips` を新設し `ssh-remote` エントリを登録 | MS純正の `ms-vscode-remote.remote-ssh` はライセンス上forkで使えず、リモートへ入れるVS Code Serverも `update.code.visualstudio.com/commit:<commit>` にforkのcommitが存在しないため取得不能。OSS版の open-remote-ssh + 自前REH配布で代替する。**(3)は必須**: proposed APIを許可しないと接続そのものが始まらない（`extensionsProposedApi.ts` のコメント通り、product.json側の指定が拡張のpackage.json宣言を上書きするため、拡張が宣言している2つも含めて列挙する必要がある）。`serverApplicationName`/`serverDataFolderName` は拡張の `getVSCodeServerConfig()` が product.json を直接読むので追加設定は不要。URLに `${commit}` を使うのはクライアントとサーバーの版ずれを原理的に防ぐため（`remote.SSH.serverVersion` の既定 `match` ではGitHub APIを叩かないので任意ホストで動く）。ビルドは `.github/workflows/para-reh.yml` |
| `product.json` / `resources/paradis/builtin/mobile-canvas-vscode-0.1.16.vsix` | `builtInExtensions` に `mobile-canvas-vscode@0.1.16`（Marketplace上の実体は `redth.mobile-canvas`、MIT）を追加。**リポジトリに vendoring した「ランタイム非同梱版」VSIX（123KB）を `vsix` フィールドで指す**。metadataのUUIDは Visual Studio Marketplace の extensionquery から取得 | iOSシミュレータ/Androidエミュレータをライブ表示・操作する Mobile Canvas を標準同梱するため。**ネイティブランタイムを同梱してはいけない（paracode-116 で実際にリリースが落ちた）**: プラットフォーム別VSIX（12〜14MB）は `dist/runtimes/<rid>/mobile-canvas.gz` に実行ファイルを内包しており、これをアプリに入れると **Apple の公証が gzip を展開して中の Mach-O を検査し、`The binary is not signed.` / `The signature does not include a secure timestamp.` / `The executable does not have the hardened runtime enabled.` の3点で拒否する**（拒否パスは `Para Code.app/Contents/Resources/app/extensions/mobile-canvas-vscode/dist/runtimes/osx-x64/mobile-canvas.gz/mobile-canvas` と、.gz の内側まで具体的に示される）。非同梱版は manifest だけを持ち、ランタイムは初回利用時に `~/.mobile-canvas/runtimes/` へ展開されるため、アプリの外に出て公証の対象外になる。取得は `paradisMobileCanvasHostClient.ts` の `_downloadArchive()` が manifest の `distribution`（repository/tag）と各ファイルの `asset` から GitHub Release のURLを組み立てて行い、展開後のsha256をmanifestと突き合わせる。同梱に戻したい場合は、ビルド時に自前で Developer ID 署名＋hardened runtime を付与して再gzipし、manifest の sha256/id も書き換える工程が要る。**`name` を `redth.mobile-canvas` にしてはいけない**: `name` は `.build/extensions/<name>/` のフォルダ名にしか使われず拡張IDは同梱 `package.json` の `publisher`+`name` から決まるが、`vsix` パスやアセット名と揃えておかないと版上げのときに取り違える。版を上げる際は `gh release download <tag> --repo Redth/mobile-canvas-ghcp --pattern "mobile-canvas-vscode-thin.vsix"` で取り直し、`shasum -a 256` の値を `sha256` に反映する（リリース同梱の `SHA256SUMS` はランタイム `.gz` のみでvsixを含まない） |
| `app/mobile/native/ParaCodeWidgets/ParaCodeWidgets.entitlements` | 新規追加（fork所有）。Widget Extension の entitlements（追跡用コピー。実体は gitignore された `ios/ParaCodeWidgets/`）。App Group `group.ltd.paradis.paracode.mobile` だけを持つ | ホーム画面・ロック画面のウィジェットが、アプリ・通知拡張と App Group の要約（`widget-snapshot.json` / `widget-settings.json` / `widget-outbox.json`）を受け渡すため（復元手順は同ディレクトリ README 参照）。plist のためマーカーを埋め込めない |
| `app/mobile/native/NotifyExtension/NotifyExtension.entitlements` | `com.apple.security.application-groups`（`group.ltd.paradis.paracode.mobile`）を追加 | 通知拡張がアプリの閉じている間にウィジェットの要約の要対応を書き換えるため（`WidgetShared.swift` の `WidgetStore.applyNotification`）。実体の `ios/NotifyExtension/` にも同じものを当てる。plist のためマーカーを埋め込めない |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `lucide-react-native@^1.48.0` を依存に追加 | モバイルの画面の作り直し（Orca に合わせたアイコン）で使うアイコン集。JS だけのパッケージで、描画は既存の `react-native-svg` を使う |

`git log --grep '^para:'`（コミットメッセージからの追跡）と合わせた二重の安全網として運用する。新しくJSON/バイナリファイルに変更を加えた場合は、必ずこの表に1行追記すること（`CLAUDE.md`の「既存ファイルへの変更が避けられない場合」ルール参照）。

## CDPゲートウェイとリモートデバッグ（agentBrowser、2026-07-02追加）

ブラウザページ⇔ターミナルペイン紐付け機能（`src/vs/paradis/contrib/agentBrowser/`）に、chrome-devtools-mcp / browser-use 等の既存ブラウザ自動化MCPをCDPで直結させる**CDPゲートウェイ**を追加した（Superset `apps/desktop` の cdp-gateway / cdp-filter-proxy 方式の移植）。

- **生のリモートデバッグポート（要注意）**: `src/main.ts` のPARA-PATCHで、Electron本体が常に `--remote-debugging-port=0`（動的割当）+ `--remote-debugging-address=127.0.0.1` で起動する。実ポートは `<userDataDir>/DevToolsActivePort` の1行目に書かれる。**この生ポートはフィルタ無しで全webContents（ワークベンチウィンドウ本体を含む）にアタッチできる**。Chromiumのremote-debuggingは127.0.0.1にのみバインドされる（`remote-debugging-address` でも明示済み）ため同一マシン内に限定されるが、リモートからのポートフォワード等でこのポートを外部公開してはならない。argv.json / CLI でユーザーが `remote-debugging-port` を明示した場合はそちらが優先される
- **ゲートウェイ**: shared processのagent-browser HTTPサーバー（固定既定ポート `47286`、専有時のみ動的フォールバック＋警告ログ。実ポートは常に `<userDataDir>/paradis-browser-mcp.json`）が `/json/*`・`/cdp/json/*`（GET）と `/devtools/{browser,page}/…`・`/cdp/devtools/…`（WebSocket upgrade）を提供し、上流＝生ポートへのプロキシ時に「呼び出し元ペインにバインドされたページのtargetId（とその子孫）以外は見えない・触れない」フィルタを適用する。`/cdp` プレフィックス無しも受けるのは、puppeteerが `--browserUrl` のパスを落として `/json/version` をルート直下に取りに来るため
- **呼び出し元ペインの識別（3段構え）**: (1) URLクエリ `?pane=<token>`、(2) loopbackピアPID（macOS: `lsof`、Linux: `ss`→`lsof`、Windows: `Get-NetTCPConnection`→`netstat -ano`）の祖先チェーンからenv `PARA_CODE_TERMINAL_PANE_ID` を読む（macOS: `ps eww`、Linux: `/proc/<pid>/environ`。Windowsは不可）、(3) workbenchから同期される「シェルPID⇔トークン」表と祖先チェーンの突合（Windowsの主経路）。実機検証はmacOSのみ、Linux/Windows経路は未検証
- ターミナルenvには `PARA_CODE_CDP_URL=http://127.0.0.1:47286/cdp` が注入される（chrome-devtools-mcpの `--browserUrl` にそのまま渡せる。再起動を跨いで同一文字列）。MCPツール `get_cdp_endpoint` で実URLを取得できる

### chrome-devtools-mcp 対応改善（2026-07-03追加）

CDPフィルタプロキシ（`paradisCdpFilterProxy.ts`）に以下を追加した（変更はすべて `src/vs/paradis/contrib/agentBrowser/` 内で完結、upstreamファイルへの新規PARA-PATCHなし）:

- **take_screenshot委譲**: セッションスコープの `Page.captureScreenshot` は、対象がバインド済みprimaryページなら electron-main のupstream実装 `BrowserView.captureScreenshot()`（可視化キック + `capturePage(stayHidden)` + UnknownVizErrorリトライ + fullPage時のピンチズーム復元）へ `PARADIS_CDP_TARGET_CHANNEL` 経由で委譲し、`{ data: <base64> }` を合成して返す。WebContentsView非表示時（背面タブ/オーバーレイ/最小化）のサーフェスコピー失敗を回避。マッピング不能な組合せ（webp / fromSurface:false / clip.scale≠1 / clip+captureBeyondViewport併用=puppeteerの要素スクショ経路）と委譲失敗時のみ上流へ素通し
- **Input.*直前のフォーカス強制**: sessionId→targetId対応表を維持し、`Input.*` 転送直前に `webContents.focus()` を強制（Chromium内部フォーカスが別webContentsにあると合成入力がターミナルへ飛ぶElectron既知問題。Superset移植）
- **backgroundThrottling**: バインド確立時に `setBackgroundThrottling(false)`、アンバインド時（同ページが他ペインから未参照なら）trueへ復帰。非表示時のnavigate/wait_for停滞対策
- **denylist補強**: `Target.closeTarget` / `Page.close`（共有ビュー破壊防止、close_pageは非対応化） / `Page.setWebLifecycleState` / `Storage.clearDataForOrigin` / `Storage.clearDataForStorageKey` / `Storage.clearCookies` / `Network.clearBrowserCookies` / `Network.clearBrowserCache`（共有パーティション保護、lighthouse_auditの既定フロー対策）を常時拒否に追加。ページレベル透過プロキシもclient→upstream方向のみ同じdenylistを適用
- **resize_page明示エラー**: `Browser.getWindowForTarget` / `Browser.{get,set}WindowBounds` / `Browser.setContentsSize` はElectron未実装（-32601）を素通しせず、-32000で「ワークベンチがレイアウト管理するため非対応、ビューポート変更はemulateを使え」を返す
- **ガイダンス**: `get_cdp_endpoint` 応答に `limitations`（new_page/resize_page/close_page非対応等）を追加

**ツール対応マトリクス（コード根拠ベース、2026-07-03時点）**:

| 判定 | ツール |
|---|---|
| 動く | take_snapshot, wait_for, evaluate_script, navigate_page, list_pages, select_page, upload_file, list_network_requests, get_network_request, list_console_messages, get_console_message, take_heapsnapshot, emulate(CPU/network/UA/viewport), fill, fill_form, click, drag, hover, press_key, type_text（フォーカス強制済み）, take_screenshot（委譲実装済み。要素スクショのみ素通しフォールバック） |
| 条件付き/未検証 | handle_dialog（ElectronのJSダイアログ発火未検証）, performance_start/stop_trace, lighthouse_audit（多domain依存。ストレージ消去は拒否済みなので既定フローの一部が失敗する可能性）, emulate(geolocation)（Browser.grantPermissions依存） |
| 非対応（明示エラー） | new_page（Target.createTarget拒否）, close_page（Target.closeTarget拒否、Para Code UIから閉じる）, resize_page（emulateへ誘導） |

### エージェント通知hookの自動設置（agentBrowser、2026-07-03追加）

Claude Code / Codex の動作完了・要対応通知（Workspacesアイコン変化・通知音・Aivis読み上げ）の唯一の信号源は shared process の `GET /agent-hook` だが、これを叩くhookがどこにも設置されていなかった（Supersetの `setupAgentHooks()` 相当の移植漏れ）。`src/vs/paradis/contrib/agentBrowser/node/paradisAgentHooksSetup.ts`（fork所有）で自動設置を実装し、`ParadisAgentBrowserService` 起動時に冪等実行する:

- **`~/.para-code/hooks/notify.sh` を冪等生成**（0755）。`PARA_CODE_TERMINAL_PANE_ID` / `PARA_CODE_MCP_PORT_FILE` env が無ければ即 exit 0（Para Code外の全Claude/Codexセッションから呼ばれても無害）。あればポートファイルから port を読み、stdin JSON の `hook_event_name`（Claude）/ `type`（Codex notify）を grep/sed でパース（jq非依存）して `curl -s -m 3 ".../agent-hook?pane=$TOKEN&event=$EVENT" || true`。パース失敗時は黙って捨てる（誤った完了通知より安全）
- **`~/.claude/settings.json` へ冪等マージ**。登録イベント: SessionStart / SessionEnd / UserPromptSubmit / Stop / PostToolUse(matcher:*) / PermissionRequest(matcher:*) / Notification。**PreToolUse は登録しない**（permission に正規化されツール実行毎に誤通知になる）。自hookの識別マーカーはスクリプトパス（`.para-code/hooks/notify.sh`）+ 旧手動スニペット形式（`PARA_CODE_MCP_PORT_FILE` かつ `/agent-hook?pane=`）。既存のユーザーhook（Superset notify.sh / AGI_COCKPIT等）は構造ごと保持。**JSONパース失敗時は一切書き込まない**
- **`~/.codex/hooks.json` へ冪等マージ**（SessionStart / UserPromptSubmit / Stop。Supersetの `createCodexHooksJson` と同じ）
- hookコマンドは `$HOME` 参照の固定文字列（`[ -x "$HOME/.para-code/hooks/notify.sh" ] && ... || true`）なので dev/製品ビルドで同一・スクリプト未設置環境でも無害。イベント一覧・コマンド定義は `common/paradisAgentHooks.ts` に集約し、手動フォールバックの「Copy Agent Hooks Setup (Claude Code)」アクションも同一内容を生成する
- Windows は現状スキップ（notify.sh がPOSIX sh前提。必要になったらSupersetの notify.ps1 方式を移植）

あわせて二次問題2件を修正: (1) `paradisNotificationTrigger.contribution.ts` — スコープ未解決（Workspacesビュー未登録フォルダ/エディタ領域ターミナル）でも、ウィンドウが可視+フォーカス中でなければワークスペースフォルダ名をプレースホルダに音+OS通知+Aivisを発火（アイコン変化はスコープ概念依存のため対象外のまま）。(2) `paradisAgentStatus.contribution.ts` — アクティブスコープの review 即acknowledge に「ウィンドウが可視かつフォーカス中」条件を追加（非フォーカス時に通知トリガーの遷移検知を先食いして握り潰す競合の解消）。

### hook の位置を動かさない理由と、自動設置の ON/OFF（2026-09-27）

Codex は信頼した hook を `~/.codex/config.toml` に `[hooks.state."<hooks.json のパス>:<イベント>:<定義の位置>:<hookの位置>"]` の鍵で記録する（手元の config.toml で確認）。以前の `paradisMergeAgentHooksJson` は自hookを毎回いったん全部外して末尾へ付け直していたため、自hookより後ろにユーザーの hook があると、設置し直すたびにユーザー側の位置がずれ、信頼が黙って外れ得た。今は既に置いてある自hookをその位置のまま最新の定義へ差し替え、まだ無いイベントだけ末尾へ足す。

設定ファイルの書き換えは、手元では同じディレクトリの一時ファイルへ書いてから `rename` で差し替える（`paradisWriteFileAtomicallySync`）。symlink は多段でも最後まで辿った実体の側を差し替え（リンク先がまだ無い場合も辿る）、元の mode（`~/.claude.json` の 0600 など）を引き継ぐ。次の場合は差し替えない。

- 所有者の書き込みビットが無い、または `access(W_OK)` が通らないファイル（`chmod 444` で固定している等）は、その場へ書くときと同じく失敗させて触らない。`rename` はディレクトリの権限だけで通るので、差し替えると読み取り専用の意図を黙って破る
- ハードリンク（リンク数が2以上）はその場へ書く。差し替えると片方だけが新しい中身になる
- 一時ファイルを作れない（ディレクトリに書き込めない）・`rename` が通らない（Windows で他のプロセスが開いている等）ときは、従来どおりその場へ書く

既知の制約: 一時ファイルへは所有者・ACL・拡張属性（macOS の `com.apple.*` 等）を引き継がないので、差し替え後はそれらが消える（mode だけは引き継ぐ）。書いてから `rename` までの間にプロセスが落ちると、同じディレクトリに `.<元の名前>.paradis-<uuid>.tmp` が残り、誰も片付けない（Claude Code / Codex はこの名前を読まない）。SSH 接続先のファイルは一時ファイルを経由しない。接続先は `IFileService` 越しにしか触れず、そこでの原子的な書き込み（`atomic: { postfix }`）は元の mode を引き継げず（一時ファイルが umask の既定で作られて元の名前に置き換わる）、symlink にも使えないため。代わりに、書く直前に読み直して、組み立てている間に変わっていたら読み直した中身から組み立て直す。

設定 `paradis.agentHooks.enabled`（既定オン）で自動設置を止められる。取り外すのは**オンからオフへ切り替わったその時だけ**で（shared process の `ParadisAgentHooksAutoInstall`、SSH 接続中のウィンドウは接続先の分を `paradisRemoteAgentHooks.contribution.ts` が外す）、起動時にオフでも取り外さない。hook の設定ファイルは PC 全体で1つなので、起動時に外すと同じ PC の別の Para Code（開発版など）が使っている hook まで消えるため。逆に、別の Para Code がオンのまま動いていれば、こちらで外しても向こうの整合処理（ファイル監視と60秒ごとの監査）が置き直す。notify スクリプト自体は消さない。

- 接続先の設置（ポートが変わるたびの書き直し）と取り外しは、同じ `Sequencer` で1本ずつ流す（`ParadisRemoteAgentHookFiles`）。設置は1ファイルごと・書く直前に設定を見直すので、途中でオフに切り替わっても古い判断で hook を書き戻さない。切り替えた時点で接続先のホームがまだ分からない、またはファイルが読めない・書き換えが3回続いて反映できなかったときは「取り外し待ち」を保持し、30秒ごとの見直しか次の設置で処理する。失敗し続けても警告は 1, 2, 4, 8… 回目だけ出す
- オフにしたときの警告は、通知では出さず「設定 (Para Code)」ダイアログの行の中に出す場合がある。通知の層（z-index 2545）はダイアログの背景（2700）より下で、ダイアログを開いたままだと裏に隠れて「元に戻す」が押せないため。ダイアログが開いているか（`paradisIsSettingsDialogOpen()`）で出し分け、層の順序そのものは他のダイアログやモーダルとの重なりに関わるので変えない。警告と設定の登録は、取り外す側がデスクトップにしか無いので electron-browser に置いている

### Codex の hook の信頼は app-server に付けさせる（agentHookTrust、2026-09-27）

`src/vs/paradis/contrib/agentHookTrust/` に実装。Codex の TUI の「Trust all」と同じ RPC を `codex app-server`（stdio）で呼ぶ: `hooks/list` → `config/batchWrite`（`keyPath: "hooks.state"`、`mergeStrategy: "upsert"`、値は `{ "<鍵>": { "trusted_hash": "<currentHash>" } }`）→ もう一度 `hooks/list` で `trusted` になったかを確かめる。codex-cli 0.155.1 の一時 `CODEX_HOME` で、利用者の hook は `untrusted` のまま、Para Code の hook だけが `trusted` になること、config.toml のコメントが残ることを実測した。

- **ハッシュは自前で計算しない。** Codex の `currentHash` をそのまま書く。Orca は自前計算が Codex の版上げのたびにずれて（Orca #7896 / #7110 / #8699）この方式へ移った
- 対象の判定は3条件: `source: "user"`、`sourcePath` がその CODEX_HOME の hooks.json、`command` が Para Code の書く文字列と完全一致。Codex は CODEX_HOME を実体パスへ直して答える（`/tmp` → `/private/tmp`）ので、実体パス側でも比べる
- **config.toml は Codex にしか書かせず、書くときは必ず版を添える。** 書く直前に `config/read`（`includeLayers: true`）で利用者の層の `version` と `hooks.state` を読み、`config/batchWrite` の `expectedVersion` に渡す。その間に Codex の TUI などが書いていると、Codex が `-32600`（`configVersionConflict`）で断るので、利用者の変更を上書きしない（0.155.1 で実測）
- 確かめが合わなかったときは、ファイルを丸ごと戻さない。もう一度 `config/read` して「今もこちらが書いたハッシュのままの鍵」だけを、書く前の値へ戻すか消し、`hooks.state` を `mergeStrategy: "replace"` で書き直す（これにも読んだ版を添える）。0.155.1 で、この戻し方で版のハッシュまで書く前と同じに戻ることを確かめた。書き込みが時間切れなどで例外になったときは、先にその app-server を止めてから（遅れて届く書き込みを防ぐ）、新しく起こした app-server で同じ戻し方をする。`hooks.state` の表の中に利用者が書いたコメントは、戻したときに消えることがある
- 設定 `paradis.agentHooks.codexTrust`（`ask` 既定 / `auto` / `off`）。`ask` の間は画面側が起動 15 秒後に1回だけ通知で確かめ（窓が複数あっても shared process の `claimPrompt` で1つに絞る。札を使い切るのは実際に通知を出したときだけで、調べられなかった・まだ hook が無かったときは `releasePrompt` で返す。返さずに窓が消えても 2 分で戻る）、「信頼する」で `auto` に書き換えてその場で付ける。`auto` の間は shared process が起動 20 秒後と hooks.json の変化のたびに付ける
- 起動のたびに codex を起こさないよう、「codex のパス + `--version` + hooks.json + config.toml」の指紋を `<userData>/paradis-codex-hook-trust.json` に残し、前回確かめたときと同じなら何もしない
- 複数ホーム（`~/.codex-N`）は `ParadisCodexHookTrustService.autoGrant(home)` / チャネルの `grant`・`getStatus` にホームを渡せば同じ手順で動く。IPC 経由で任意のパスに codex を起こさないよう、受け付けるのは既定のホームと `~/.codex-<名前>` だけ。フェーズ2で hook をそこへ置くときは、置いたあとに `autoGrant(home)` を呼ぶこと（今は既定のホームしか監視していない）
- `codex` は Node のスクリプトなので、shared process の PATH に `node` が無いと `env: node: No such file or directory` で起動できない。ログインシェルの環境（`ParadisCachedShellEnv`）を使っているので通常は問題ないが、失敗したときの outcome は `failed` で detail にこの文言が出る

### hook 所有者判定の既知の制限: 共有した tmux サーバー（2026-09-27）

hook の発信元の仕分けは `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHookOwnership.ts` にあります。所有者のエージェントが終わると、同じペインのトークンで次に hook を送ってきたエージェントが後継の所有者になります。

tmux サーバーの環境変数は、サーバーを起こしたペインのものです。2つのペインで同じ tmux サーバーを使うと、ペイン B から作ったセッションのエージェントも、ペイン A のトークン（`PARA_CODE_TERMINAL_PANE_ID`）で hook を送ります。ペイン A の所有者が生きている間は `invalid` で捨てますが、所有者が終わるとペイン B のエージェントが後継になり、その状態がペイン A のタブに出ます（実機で再現済み）。ペイン A がまだ一度もエージェントを動かしていないときも、同じ理由でペイン B のエージェントが最初の所有者になります（推測、実機では未確認）。

後継を「hook の祖先にペインのシェルがいるとき」に絞る修正は入れて、実機確認の後に外しました。tmux の中のエージェントの祖先は tmux サーバー → launchd で、ペインのシェルを通りません。そのため絞ると、同じペインで tmux のエージェントを起動し直したときに、5つの形のうち4つで状態が出なくなりました（同じセッションの別ウィンドウ、作り直したセッション、`tmux new-session -s x2 claude` の打ち直し、直接起動の後の tmux）。こちらは tmux を使う人がエージェントを2回起動すれば必ず起きるので、共有サーバーの取り違えより影響が大きいと判断しました。両方の形は `paradisAgentHookOwnership.test.ts` に固定してあります。


この制限の続きとして、ペイン B のエージェントがペイン A の所有者になっている間は、ペイン A で `tmux new-session -s x2 claude` を起動し直しても x2 の hook がすべて `invalid` で捨てられ、タブに状態が出ない（2026-09-27 実機で確認）。ペイン B のエージェントを終えると、x2 の次のターンから状態が出る。

将来の直し方の案は、tmux のクライアントでペインとセッションを対応づけることです。tmux の中で動く hook は `$TMUX`（ソケット・サーバー pid・セッション）と `$TMUX_PANE` を持っています。notify スクリプトがこれを送り、shared process が `tmux -S <socket> list-clients -t <session> -F '#{client_pid}'` でそのセッションに付いているクライアントを調べます。クライアントの祖先にこのペインのシェル（`paradisAgentBrowserService.ts` の `_paneShells` の `shellPid`）がいれば、このペインのエージェントとして後継を認めます。ペイン B のエージェントのセッションには、ペイン B のシェルの下のクライアントしか付いていないので弾けます。notify スクリプトの版上げ（schema v4）と、hook ごとに tmux を1回起動するコストの扱いが要ります。

### worktree の「このフォルダを信頼しますか」は元のリポジトリから引き継がれる（2026-09-27 実測、実装なし）

当初の方針は「worktree に信頼が引き継がれなければ、元のリポジトリが信頼済みのときだけ、スペース作成時に worktree のパスへ信頼を書き込む」だったが、両方の CLI とも引き継ぐので実装していない。一時 HOME / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` で、`git worktree add ../repo-worktrees/wt`（Para Code の既定の置き場所と同じ、リポジトリの外の兄弟ディレクトリ）を作って TUI を起動して確かめた。

| CLI | 元のリポジトリが信頼済み | 元のリポジトリが未信頼 | 無関係なフォルダ（対照） |
|---|---|---|---|
| Claude Code 2.1.283 | worktree で確認なし。`.claude.json` の `projects` に worktree のエントリも増えない | worktree で確認が出る | 確認が出る |
| codex-cli 0.155.1 | worktree で確認なし。config.toml は変わらない | 確認が出て「Trusting will apply to the repository root: <元のリポジトリ>」と表示される | 確認が出る |

どちらも「worktree → 元のリポジトリの根」で信頼を引くため、新しい worktree に信頼を書き込む必要は無い。CLI の版上げで挙動が変わったら、この表の手順で測り直すこと（Claude は `hasCompletedOnboarding` と `customApiKeyResponses.approved` を仕込んだ一時 `.claude.json` + ダミーの API キー、Codex は一時 `auth.json` にダミーの `OPENAI_API_KEY` と `check_for_update_on_startup = false` で、ログインや更新の画面を飛ばせる。Para Code のターミナルから測るときは `env -i` で `PARA_CODE_*` / `CLAUDE_CODE_*` を落とす）。

## 内蔵ブラウザの前面オーバーレイ機構（overlayManager、2026-08-15整備）

内蔵ブラウザ（`src/vs/platform/browserView/`）はElectronのネイティブ `WebContentsView` として実装されている。ネイティブビューはOS合成レイヤーで描画されるため、通常のDOM要素はCSSの `z-index` では絶対に上書きできない。

これを回避しているのが `src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts` の `BrowserOverlayManager` で、`OVERLAY_DEFINITIONS`（決め打ちのDOMクラス名ホワイトリスト）に載っている要素がブラウザ領域に重なったことを検知すると、ネイティブビューを一時的に `setVisible(false)` で隠してスクリーンショットに差し替える。DOM側のダイアログはその隠れた瞬間に自然と「上」に描画される、というトリック。

**重要**: この重なり検知は汎用的なz-index判定ではなく、**クラス名の決め打ちホワイトリスト方式**。標準の `monaco-dialog-modal-block` / `quick-input-widget`（`IDialogService`/`IQuickInputService`経由）は最初から登録済みで無条件に機能するが、fork独自の「自前DOM + backdrop方式」のダイアログは、それぞれ固有のbackdropクラス名を持ち、**そのクラス名を `OVERLAY_DEFINITIONS` に個別追加しない限りブラウザの背後に隠れる**。

- 登録済み（問題なし）: `paradis-binding-dialog-backdrop`、`paradis-bookmark-dialog-backdrop`、`paradis-notification-inbox-popover`（通知の受信箱、2026-09-27）
- 2026-08-15時点で判明した未登録（＝ブラウザ表示中に開くと背後に隠れる）:
  1. `paradis-preset-editor-backdrop`（カスタムプリセットコマンドのモーダル、`src/vs/paradis/contrib/terminalPresets/browser/paradisPresetEditorDialog.ts`）
  2. `paradis-create-worktree-backdrop`（ワークスペース切替/worktree作成ダイアログ）
  3. `paradis-notif-settings-backdrop`（通知設定ダイアログ）
  4. `paradis-notif-nested-backdrop`（Aivis辞書設定・YouTubeインポートの入れ子ダイアログ）
  5. `paradis-limits-setup-overlay`（利用上限コード登録ダイアログ）
  - 境界事例（アンカー式ポップオーバーで全画面モーダルではないため優先度低）: `.paradis-limits-panel`、`.paradis-resource-monitor-panel`

**運用ルール**: 内蔵ブラウザと同時に開かれうる場面がある「自前DOM + backdrop方式」の新規ダイアログ・モーダルを追加したら、そのbackdropクラス名を必ず `overlayManager.ts` の `OVERLAY_DEFINITIONS` に追加すること（`{ className: '...', type: BrowserOverlayType.Dialog }` を1行足すだけ）。標準の `IDialogService`/`IQuickInputService` をそのまま使う場合はこの対応は不要（既存ホワイトリストでカバー済み）。2026-09-27 からは共通の印 `paradis-modal-backdrop` を登録済みなので、新しいモーダルは backdrop にこのクラスを併記するだけでよい（`overlayManager.ts` への追加は不要。定期実行・スキルのモーダルが実例）。

### fork の自前モーダルのフォーカスと重なり順（paradisModalFocus、2026-09-27、フェーズ8）

「設定 (Para Code)」・定期実行・スキルの 3 つのモーダルは `paradisSettings/browser/paradisModalFocus.ts` の `ParadisModalFocus` を使う。
- 開く前のフォーカスを覚え、閉じたらそこへ戻す（戻さないと BODY に落ち、続けて打った文字が消える。実機確認の別件1）
- Esc はウィンドウで先に受けるので、描き直しでフォーカスが BODY に落ちていても閉じられる。フォーカスが別の場所（確認ダイアログなど）にあるときと、日本語入力の変換中は受けない。設定の検索欄に文字があるときの Esc は検索語のクリア
- 中身を描き直してフォーカスしていた要素が消えたら、同じ見た目のボタン（無ければモーダル）へ戻す（MutationObserver）
- 同じウィンドウで別のモーダルを開いたら、前のものは閉じる。z-index の段（定期実行・スキルの 2570、確認ダイアログの 2575、設定の 2700）を変えずに「後から開いたものが前」を守るため（設定を開いたままパレットから定期実行を開くと、設定の裏に出ていた。別件4）
- 使用量ダッシュボード・通知設定・セッション履歴など、ほかの fork のモーダルはまだ使っていない

## 内蔵ブラウザの倍率インジケータ（browserZoomIndicator、2026-08-20追加）

`src/vs/paradis/contrib/browserZoomIndicator/` に実装。upstream のファイルは無変更で、公開されている拡張点だけを使う（`BrowserEditor.registerContribution()` と `BrowserWidgetLocation.PostUrl`）。

- **upstream 取り込み時の確認点**: fork の CSS が upstream のズームピル（`.browser-zoom-pill`、`features/browserEditorZoomFeature.ts`）を`display: none` で隠している。クラス名が変わっても型検査・lint は通り、**ある日から同じ数字が二重に出るだけ**になるので、upstream 側にこのクラスが残っているかを目視すること。隠す対象は `.browser-url-bar-widgets:has(.paradis-browser-zoom-stepper)` の内側に限定してある
- 倍率の増減は `BrowserEditorZoomSupport` へ委譲する（`model.zoomIn()` を直接呼ぶと、読み上げ `accessibilityService.status()` とコンテキストキー更新を素通りする）
- **「既定 = 100%」ではない**。`workbench.browser.pageZoom` の既定値は「ウィンドウに合わせる」で、アプリのUI倍率を上げていると既定は 110% 等になる。淡色表示とリセットの文言は `IBrowserZoomService.getEffectiveZoomIndex(undefined, false)` から毎回引く
- ウィジェットは URL ボックスの内側（`.browser-url-bar-widgets`、`overflow: hidden` で右端から刈られる）に入る。order 90 で upstream のボタン（共有 50 / お気に入り 60）より後ろに置き、詰まったときに先に消えるのはこちら側にしてある

## 内蔵ブラウザのパスキー選択は upstream のデバイス選択に乗せている（browserWebAuthn、2026-09-27）

セキュリティキー等に複数のアカウントが入っているとき、どのアカウントでログインするかを選ばせる。Electron の `select-webauthn-account` を受け、upstream が USB / HID / シリアル / Bluetooth の機器選択に使っている流れ（main の `_beginDeviceRequest` → renderer の QuickPick → `selectDevice`）へそのまま流す。選択 UI を自前で持たないので、upstream のファイルへの変更は次の6行（3ファイル、import 2行を含む）だけ。

| ファイル | 触った箇所 | 内容 |
|---|---|---|
| `src/vs/platform/browserView/common/browserPermissions.ts:62` | `BrowserDeviceType` | `'webauthn'` を足す |
| `src/vs/platform/browserView/electron-main/browserSessionPermissions.ts:284`（import は `:27`） | コンストラクタの末尾 | `paradisInstallWebAuthnAccountChooser` でイベントを配線する |
| `src/vs/workbench/contrib/browserView/electron-browser/features/browserPermissionsFeature.ts:180`（import は `:38`） | `deviceTypeLabel` | `'webauthn'` の表示名 |
| 同 `:200` | `showDevicePicker` | `'webauthn'` のときだけタイトルと案内文をアカウント選択向けに替え、探索中の表示（busy）を消す |

**upstream 取り込み時は `BrowserDeviceType` で分岐している箇所を洗い直す。** `switch` に `assertNever` があれば型検査で気付けるが、`if (deviceType === 'usb')` のような分岐や、機器の種類ごとの表を増やされた場合は黙って `'webauthn'` が素通りする。

```sh
grep -rn "BrowserDeviceType\|deviceType ===\|deviceType:\|case 'bluetooth'" src/vs --include='*.ts' | grep -v '/paradis/'
```

## 内蔵ブラウザのダウンロード一覧、エージェントのタブとプロファイル（2026-09-27、フェーズ7 担当A）

ダウンロードの一覧は main が権威で、renderer は写しを持つだけ。`will-download` はセッションごとに配線済み（`browserSession.ts` の既存 PARA-PATCH）なので、そこから main に1つだけある `ParadisBrowserDownloadsTracker` へ集め、`paradisBrowserDownloads` チャネルで流す。チャネルへ渡すのは操作だけの薄い面で、一覧の実体（`track` や `dispose`）は renderer から呼べない。renderer からは main が振った id しか受け取らず、パスは受け取らない。ボタンは `MenuId.BrowserActionsToolbar` のアクションを `IActionViewItemService` で自前の項目に差し替えたもので、進み具合の輪と未確認の点を持つ。一覧は main のメモリだけにあり、再起動で消える（ファイルは消えない）。

「開く」を出すのは、開いても表示されるだけの種類（`paradisIsOpenableDownload` の許可リスト）で、隔離の印を付け終えていて、しかもエージェントのタブ（Agent スコープ、ダウンロードを始めた時点でエージェントの印の付いていたプロファイル）から落ちてきたものでないときだけ。それ以外は「フォルダで表示」だけにし、main も同じ条件で開くのを断る。エージェントが作ったプロファイルの台帳は renderer にしか無いので、renderer が変わるたびに ID の一覧を main へ知らせ（`setAgentProfiles`）、main はダウンロードを始めた時点で由来を決めて持つ（後でプロファイルが消えても変わらない）。出どころは `paradisBrowserDownloadsMain.ts` が Electron のセッションから BrowserSession を引いて決める（`paradisBrowserDownloads.ts` から BrowserSession を import すると `browserSession.ts` と循環するため、登録口を分けた）。

完了したファイルには、OS の隔離の印が無ければ付ける（macOS は `xattr -w com.apple.quarantine`、Windows は `Zone.Identifier` に `ZoneId=3`）。Chromium でこれを付けるのは埋め込み側（Chrome の DownloadManagerDelegate）で、Electron が付けるとは限らないため、完了のたびに有無を確かめている。印を付け終えるまでは一覧に完了として出さず（進行中のまま）、付けられなかったものは「開く」を出さない。【要確認】実機で Electron 43 が既に付けているか（付けていれば何もしない作りなので害は無い）。

| upstream のファイル | 行 | 内容 |
|---|---|---|
| `src/vs/code/electron-main/app.ts` | import 1行 + 登録 1行 | `paradisRegisterBrowserDownloads(mainProcessElectronServer, this.configurationService)`（`browserDownloads/electron-main/paradisBrowserDownloadsMain.ts`） |
| `src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts` | 1行 | `paradis-browser-downloads-popover` を QuickInput 扱いで登録（ネイティブビューの裏に隠れないように） |

エージェントのタブと、ページ共有の「エージェントが要求 → ユーザーが承認」は `agentBrowser/electron-browser/paradisAgentBrowserTabsService.ts`。ペインとページの共有は 1 対 1 のまま変えていない（CDP ゲートウェイとフィルタは共有中の1枚しか見せない）。複数のタブは「共有するタブを移す」ことで扱う。

- エージェントが開くタブは Agent スコープ（ユーザーのログイン情報を持たず、ネットワークの制限が掛かる）で、共有相手を最初からエージェントにして作る。そのため upstream の共有確認は出ない（upstream 自身の open_browser ツールと同じ扱い）
- upstream の共有確認（「Share this browser page with the agent?」、既定のフォーカスが Allow）は、fork 側で承認済みの共有では出さない。`bindTab` は共有の前に、main のブラウザビューへ直接エージェントを共有相手として加え（`IBrowserViewService.setAudience`、main がネットワークの制限を確かめる）、モデルが共有済みになるのを待ってからバインドする。upstream の `setSharedWithAgent` は共有済みなら確認を出さないので、upstream のファイルは触らずに済む。`bindTab` を通るのは、エージェント自身のタブ・承認ダイアログで許可されたタブとプロファイル・そのペインが作ったプロファイルだけ。ネットワークの制限でそのまま共有できないタブは何もせず、upstream の流れ（共有用のタブを開き直す確認）に任せる。ユーザーが共有ボタンから共有するときは、これまでどおり upstream の確認が出る
- ユーザーのタブを使えるのは、そのタブが共有されている間だけ。エージェントが自分のタブへ共有を移したら、戻るにはもう一度 `request_browser_page` で頼む。承認の記録を別に持つと、ユーザーから見えない（共有ボタンで止められない）まま使い続けられるため。共有していないタブの URL は origin だけ返す
- 誰がどのタブを開いたかの台帳（`ParadisAgentTabLedger`）はウィンドウのメモリだけにある。再読み込みすると忘れ、エージェントが開いたタブは普通のタブとして残る（エージェントはもう閉じられない＝安全側）。別のスペースへ退避中のタブは閉じない（エディタを通さずに捨てると復元が壊れる）
- 承認ダイアログ（`askApproval`、プロファイルの承認でも使う）は `custom: true` のワークベンチ内ダイアログで、「拒否」を先頭（既定のフォーカス）に置き、cancelButton を付けない（Esc と閉じるボタンは拒否になる）。ニーモニックは付けない。ペイン名はエージェントが OSC で変えられるので、制御文字と双方向制御を落とし、ターミナル番号とスペース名を並べる
- 承認ダイアログはサービスの `Sequencer` で1つずつ出す（重なると1件目へのダブルクリックが2件目の承認に当たる）。1ペインにつき待てる求めは1つ（2つ目は `busy`）。表示から 1 秒以内の承認は打ちかけのキーとみなして聞き直す。1秒は `prompt()` を呼んだ時刻ではなく、ダイアログが実際に DOM に出た時刻（印のクラスを 50ms ごとに探す）から数える。3回続けば「答えが得られなかった」として打ち切る
- macOS の custom ダイアログは ⌘D で index 1 のボタンを押す（upstream の `dialog.ts`）。2つ目の選択肢（別のページを選ぶ）があれば index 1 に置き、無ければ承認が index 1 になるので、表示中に ⌘D が押されて決まった承認は聞き直す
- ユーザーが拒否したら、同じペインからの求めは 3 分間自動で断る（`recentlyDenied`）。何度も出して承認疲れを誘うのを止める
- fork の自前ダイアログ（z-index 2600〜2800）が開いていても隠れないよう、承認ダイアログの modal block だけ 2850 に上げている（`media/paradisAgentApproval.css`）。「fork の UI は 2575 より上げない」の例外で、止めて答えを求めるセキュリティの確認だから
- 待ち時間は renderer 50 秒（ダイアログから共有の完了までの1本の締め切り）・shared process 55 秒。【要確認】Codex の MCP ツールの既定の時間切れ（`tool_timeout_sec`）が 60 秒という前提で、それより短くしてある（公式の設定の説明で確かめてはいない）。締め切り後に共有が成立したら外し、外し終えるまで同じペインの次の要求を受け付けない（新しい要求の共有を古い共有が上書きしてから外す、を防ぐ）。プロファイルを開く・切り替えるときも同じ締め切りを承認・タブを開く・共有まで掛ける。shared process は時間切れや MCP の取り消しを CancellationToken で renderer へ伝え、ダイアログを閉じさせる。`_callOwningWindow` の既定 10 秒を延ばしているのは、承認を伴う呼び出しと `open_browser_tab`（読み込み待ち）

CDP ゲートウェイ（`paradisCdpFilterProxy.ts`、ページ直結とブラウザ経由の両方）は、Para Code 自身の isolated world（Design Mode の要素選択の world、upstream の preload の world 999）をエージェントから隠す（`paradisCdpIsolatedWorldFilter.ts`）。isDefault:false の `Runtime.executionContextCreated` を落とし、コンテキストを指す引数（`contextId` / `executionContextId` / `uniqueContextId`）は見せたものだけ通す（連番で推測できるので、隠したものを拒むだけでは足りない）。objectId は V8 の「isolate.context.object」の形なら隠したコンテキストのものを拒む。隠した world のスクリプト（`Debugger.scriptParsed` は nonce を含む本文を `getScriptSource` で読めるため）・コンソール出力・例外は届けず、そこで止まった `Debugger.paused` はこちらで再開させる。puppeteer（chrome-devtools-mcp）が自分で作る world は、`Page.createIsolatedWorld` / `Page.addScriptToEvaluateOnNewDocument` の worldName で要求したものとして見せる（名前の無い world と `Electron Isolated Context` は要求されても見せない）。

エージェントによるプロファイル操作は既存の `paradisBrowserProfileMcp` チャネルに相乗りした。

- 台帳の `createdByAgent: true` は「エージェントが作り、ユーザーがまだ自分で使っていない」印。ユーザーが UI から開く・切り替える・名前や色を変えると外れる（`claimForUser`）。ユーザーがエージェントのタブの中でログインした場合は検知できず、印は残る
- 承認なしで使え、`list_browser_profiles` で名前を出すのは、そのペインが作った（`agentOwner` が一致する）印付きのものだけ。ユーザーのものと別のペインが作ったものは数だけ返し、`open_browser_profile` / `switch_browser_profile` で使うときは承認ダイアログを通す（別のペインのタブの中でユーザーがログインしているかもしれないため）。ダイアログには開くサイトの origin を出す
- 削除できるのも作ったペインのエージェントだけ（`agentOwner` はペイントークンの SHA-1 の先頭 16 桁。トークンそのものは保存しない）。CLI を起動し直すとトークンが変わるので、その後は作ったエージェントでも消せない（安全側）
- 名前の有無を黙って探らせない: 作成で名前が既にある場合は空の名前と同じ `invalidName`、削除で自分のものでない名前は「無い」と同じ `unknownProfile` を返す。名前からは制御文字・ゼロ幅文字・双方向制御文字を落とす（見た目だけ似せた名前を作れないように）
- 別のウィンドウの台帳を取り込むときも、印は「外す」向きだけを通す（古い写しで印が戻らないように）
- 切替は「エージェントが自分で開いたタブ」に限り、ネットワークの制限が有効な間は断る（`open_browser_profile` と同じ判断）。`open_browser_profile` で開いたタブもエージェントのタブとして台帳に載り、上限 5 枚に数える

## 内蔵ブラウザの Design Mode とスクリーンショットへの書き込み（browserDesignMode、2026-09-27、フェーズ7 担当B）

`src/vs/paradis/contrib/browserDesignMode/` に実装。ページの要素を選んでコメントを付け（B1）、スクリーンショットに書き込み（B2）、どちらも注釈トレイに溜めて、同じスペースのエージェントのペインの入力欄へまとめて入れる。upstream の「Add Element to Chat」（VS Code のチャット宛て）とは別の経路で、upstream の要素選択（`toggleElementSelection`）は使わない。使うと upstream の `BrowserEditorChatIntegration` が選択のたびにチャットへ添付しに行くため。

upstream への変更は次の3行（2ファイル）だけ。ボタンは `MenuId.BrowserActionsToolbar` への登録、トレイは `BrowserWidgetLocation.Toolbar` のウィジェットで、ツールバーの DOM には触らない。

| ファイル | 内容 |
|---|---|
| `src/vs/code/electron-main/app.ts`（import 1行 + 登録 1行） | main の窓口 `paradisDesignMode` チャネル（`paradisRegisterDesignMode`）。CDP で仕掛けを入れる案より配線が少ないのでこちらにした |
| `src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts`（1行） | 書き込み用の重ね板 `paradis-markup-overlay` を `OVERLAY_DEFINITIONS` に登録 |

- **ページへの仕掛けは専用の isolated world（ID 20731）で動かす**。0（ページの main world）とも 999（upstream の preload と fork のエージェントカーソル演出）とも別で、ページの JS からは仕掛けの関数も戻り値も見えない。ページが触れるのは画面に出した DOM の外枠だけ（閉じた shadow root）で、偽のクリックは `isTrusted` で弾く。スタイルは `element.style` 経由（CSP の style-src に掛からない）、`innerHTML` は使わない（Trusted Types）。`executeJavaScriptInIsolatedWorld` の userGesture は付けない（付けるとページの main world にもユーザー操作の扱いが渡る）
- **ただし CDP からはこの world が見える**。`Runtime.executionContextCreated` で isolated world のコンテキストも通知され、`Runtime.evaluate` の `contextId` 指定で中の式を評価できる。`Debugger.scriptParsed` で仕掛けの本文（nonce を含む）も読める見込み。Design Mode 側でできる対策として、選択を始めるたびに今ある `__paradisDesign` を捨てて入れ直し、main が呼び出しごとに作る nonce を結果に載せて照合し、使う組み込み関数（`Promise`・`addEventListener`・`elementFromPoint`・`getComputedStyle`・`getBoundingClientRect` など）は仕掛けを読み込んだ直後に退避して使う。これで「先に置いた偽の仕掛け」と「読み込んだ後の差し替え」は効かないが、読み込む前に world の組み込み関数を差し替えておくエージェントは防げない。**残作業（CDP フィルタ、担当A）: `paradisCdpFilterProxy.ts` で `isDefault: false` の実行コンテキストを隠すか、`Runtime.evaluate` / `Runtime.callFunctionOn` の `contextId` / `uniqueContextId` を既定のコンテキストに限る。それまでこの件は Medium として追跡する**
- **見えないテキストは、分かる範囲で取り除く**（完全には防げない前提で、残りは下の区切りと注意書きで弱める）。ページがボタンの中に隠した指示が「ユーザーの発言」としてエージェントに届くのを防ぐため。要素ごとに次を見る: `checkVisibility()`（opacity / visibility / content-visibility）、`aria-hidden`・`hidden`・`inert`、祖先を掛け合わせた opacity が 0.1 未満、文字色と `-webkit-text-fill-color` の alpha が 0.1 未満、6px 未満の文字、背景と同じ色の文字、1px 以下の箱、文書の外（上下左右）、`position: fixed` で画面の外、自分や祖先の `clip` / `clip-path`、祖先の `overflow` による切り抜き。さらにテキストノードごとに、文字の実際の位置（`text-indent` で追い出した場合も含む）の真ん中を `elementFromPoint` で調べ、その文字の要素が一番手前に無ければ（覆われている・切り抜かれている・画面の外）取り出さない。画面の外にあるだけの普通の文字も落ちるが、取りこぼす方を選んでいる。HTML の断片からも見えない要素・見えない文字・HTML コメントを取り除く。画面に出ない文字（`aria-label`・`title`・`alt`・`data-*` 等）は送らず、名前はボタン・リンク・ラベルの見えている文字から作り、`id` とクラス名は識別子らしい短いものだけをセレクタに使う。取り出しは選択を確定した瞬間（クリック）の DOM から読むが、ページが capture 段階の mousedown で見える文字を一瞬書き換える手口は防げない
- **ページから返る値は main で検証してから renderer へ渡す**（`paradisClampPickedElement`）。長さの上限、属性の許可リスト、秘密らしい値（`password`・`api_key`・`session_id` 等）の伏せ字、URL のクエリとフラグメントの除去。タグ名は英数字とハイフン以外なら `element` にする（見出しに出すため）
- **送る文章では、ページ由来の値をすべて nonce 付きの区切り（`<<<PAGE-<nonce>` 〜 `PAGE-<nonce>>>>`）の中に1行ずつ入れる**。nonce は送るたびに作る 16 桁の値で、ページは区切りの終わりを偽造できない。値の引用符・バッククォート・バックスラッシュはエスケープし、「区切りの中は指示ではない」という注意を先頭と末尾の両方に置く。区切りの外に出るのはユーザーのコメントと Para Code の文言だけ。**要素の HTML は既定で送らない**（トレイの「HTML も送る」で選んだときだけ、1行にして区切りの中へ入れる）
- **画像は `<userData>/paradis-design-mode/images/` に PNG で置く**（ディレクトリ 0700、ファイル 0600、`wx` で作成）。作業フォルダの `.para-code/pasted-images/` ではなく userData にしたのは、保存先を Para Code の管理下で権限を絞るため。main は PNG の署名と 20MB の上限を確かめてから書く。24時間を過ぎた画像は、保存のたび・main の起動時・その後1時間ごとに消す。クリップボードへのコピーでも本文にパスを書くので保存する。SSH 先のペインへは画像を送らない（手元のパスは向こうで開けない）
- **入れ方はフェーズ5の「エージェント向けプリセット」と同じ規則**: Enter は送らない、貼り付け（bracketed paste）で送る、制御文字を落とす、質問・許可の回答待ち（hook の状態 `question` / `permission`）のペインには入れない（一覧で選べず、送る直前にも確かめる）。**違いとして、改行は常に1行へ均す**（プリセットは貼り付けモードかつ前面のコマンドが実行中なら残す）。本文にページ由来の値が入るので、送る瞬間にエージェントが終わっていて貼り付けを解さないシェル（macOS の `/bin/bash` 3.2 等）へ届いても、行として実行されないようにするため。hook が届いていないペイン（hook を切っている・WSL 等）は状態が分からないので、入れる前に確認のダイアログを出す
- 画像のパスは本文の後ろに1つずつ別の貼り付けとして入れる（ターミナルへファイルをドロップしたときと同じ `preparePathForShell` の書き方）。**Claude Code / Codex がこのパスを画像として取り込むかは実機で未確認**。取り込まれなくても、エージェントはパスのファイルを読める
- 送り先の一覧は `IParadisAgentBrowserBindingModel.getPanesForPage()` から作る。共有の可否と同じ判定（`bindEligibility`）で同じスペースのペインだけ、エージェントが動いた実績（hook）かタイトルでエージェントと分かるペインだけを出す。「新しいエージェントを起動」は、ページのスペース（`IParadisBrowserScopeService.resolveScope`）が前面のスペースと同じで、hook の自動設置がオンのときだけ出す（別スペースのページから前面のスペースへ起動しないため・hook が無いと起動の完了が分からないため）。起動後は hook が届いて TUI が貼り付けモードを有効にするまで最大30秒待ち、エディタのページが替わる・閉じると待つのをやめる。待ちきれなければクリップボードへ回す
- 結果やエラーは通知のトーストではなくトレイの中（書き込み中は道具バーの左端）に出す。fork ではトーストが内蔵ブラウザを止めない設定で、トーストはページの裏に隠れるため。エラーはベル（通知センター）にも残す
- main のチャネルは `pickElement` / `cancelPick` / `setPins` / `saveImage` / `resetPicks` の5つだけを受ける明示の `IServerChannel`（`ProxyChannel.fromService` だと実装の内部のメソッドまで renderer から呼べる）。呼び出し元のウィンドウ（IPC の ctx）ごとに選択中のビューを覚えておき、renderer が起動したとき（`IParadisDesignModeService` を作ったとき）に `resetPicks` で自分の古い選択を取り消す。選択中にウィンドウを再読み込みしても、ページに十字カーソルの覆いが残らない
- 書き込み（Markup）は `captureScreenshot({ format: 'png' })` で撮ったビューポートの画像を、ページの入れ物（`.browser-container`）と同じ位置に重ねて描く。重ね板は `.browser-container-wrapper` の子に置く。wrapper は z-index を持たず重なりの文脈を作らないので、重ね板がエディタの外へはみ出さないのは wrapper の `overflow: hidden` で切り抜かれるから（z-index 20 は同じ wrapper の中の、止めたページの代わりの画像より上に出すためだけ）。背景は透明で、ウィンドウの透過を変えない。**開いている間にエディタの大きさを変えると、重ね板の位置は開いたときのまま**になる
- キーは ⇧⌥⌘C（Windows / Linux は Ctrl+Shift+Alt+C）。当初の ⌥⌘D は macOS の既定で「Dock を自動的に表示/非表示」に取られ、押すと Dock の設定が切り替わるのでやめた。⇧⌥⌘C はワークベンチでは「相対パスのコピー」（エクスプローラーやエディタで使う。Linux も同じキー）なので、`when` を「ブラウザが前面のエディタ」かつ「フォーカスがブラウザのエディタの中（`CONTEXT_BROWSER_FOCUSED`）」にして、エクスプローラーやターミナルにフォーカスがあるときは元の割り当てが効くようにしてある。Windows で AltGr+Shift+C に文字が割り当てられた配列では、ブラウザのエディタの URL 欄でその文字が打てない可能性がある【要確認】

### フェーズ5のプリセットと共有している処理

Design Mode の送信（`paradisDesignModeSender.ts`）は、フェーズ5（エージェント向けプリセット、`terminalPresets`）の判定と整形を `terminalPresets/common/paradisTerminalPresets.ts` から使う。以前はこのブランチの起点に無かったため写しを置いていたが、2026-09-27 に写しを消して寄せた。

| 用途 | 使う処理 | Design Mode 側の渡し方 |
|---|---|---|
| 入力欄へ入れる文章の整形 | `paradisBuildPresetInsertText` | ターミナルへは常に `keepNewlines = false`、クリップボードへは `true` |
| 送り先一覧の「今すぐ入れられるか」 | `paradisAgentPromptAvailability` | `(true, true, status)`。一覧はエージェントのペインに限っているので、hook の実績が無くてもエージェントとして扱う |
| 送る直前の回答待ちの確認 | `paradisThrowIfAgentAwaitingAnswer` | `requireAgentInstance = false` |

プリセットとの違いは2つあり、寄せた後も残している。

- 改行: プリセットの `_insertAgentPrompt` は貼り付けモードかつ前面のコマンドがエージェントなら改行を残す（`keepNewlines`）。Design Mode はページ由来の値が入るので常に1行へ均す
- 回答待ちの確認: 状態は hook の実績が無いペイン（hook を切っている・WSL の中・Codex の hook が届かない構成など）にも transcript から届くことがある。プリセットの「挿入だけ」は `requireAgentInstance = true` で、hook の実績（`isAgentInstance`）があるペインだけを止める。Design Mode は `false` で、hook の実績が無いペインでも回答待ちなら止める（hook が無いペインには入れる前に確認のダイアログも出す）。どちらも写しの時点の挙動のままで、`paradisPresetAction.test.ts` で両方を押さえている

upstream 取り込み時に確認すること:

- `BrowserEditor.registerContribution`・`BrowserWidgetLocation.Toolbar`・`BrowserEditor.layoutBrowserContainer()`（トレイの出し入れで呼ぶ）・`MenuId.BrowserActionsToolbar` と `BrowserActionGroup.Tools` が残っているか
- `IBrowserViewCaptureScreenshotOptions.pageRect` の意味（今はビューポート基準の CSS px。要素の切り抜きに使う）が変わっていないか
- upstream が要素選択の Esc の weight を上げていないか（fork の Esc は `WorkbenchContrib + 1`）、「相対パスのコピー」の既定キーが変わっていないか

## 機能1: ワークスペース即時切り替え（workspaceSwitch、2026-07-02追加）

`src/vs/paradis/contrib/workspaceSwitch/` に実装。単一ウィンドウ・単一 `.code-workspace`（identity固定）のまま `updateFolders` で folders を丸ごと入れ替え、エディタ/ターミナル/ブラウザの状態をリポジトリごとに退避・復元する（Superset方式: 破棄せず隠す）。実装時に判明した落とし穴:

- **`isSessionsWindow` は通常ウィンドウに転用不可（確定）**: フラグは `windowsMainService.ts:1599` で「開くworkspaceのconfigPathが `agentSessionsWorkspace` と一致するか」で自動決定され、trueだとHTMLエントリ自体が `sessions.html` に切り替わる。再起動スキップは `relauncher.contribution.ts` の early return への1行PARA-PATCH（`isParadisManagedWorkspaceWindow()`、module スコープのフラグ。DI注入はコンフリクト面が広がるため意図的に避けた）で解決
- **workspace id は configPath のみ依存**（`workspaces.ts` "IDENTIFIERS HAVE TO REMAIN STABLE"）。folders を何度入れ替えても WORKSPACE スコープ storage は同一。**必ずマルチルート状態で運用**（単一フォルダ状態から `updateFolders` すると `createAndEnterWorkspace` で別workspace化して状態が分断される。サービス側で WORKSPACE 状態を強制）
- **エディタ退避は upstream 純正の working set API**（`saveWorkingSet`/`applyWorkingSet`、雛形は `baseSessionLayoutController.ts`）。dirty エディタは閉じられず切り替え先へ持ち越される仕様（データ保護、確認ダイアログなし）
- **切り替え順序が重要**: `applyWorkingSet`（エディタ入れ替え）を `updateFolders` より**先**に行うこと。逆にすると Git 拡張のフォルダ削除処理（`extensions/git/src/model.ts` の `onDidChangeWorkspaceFolders`）が「可視エディタが使用中」と判定して旧リポジトリを close せず、SCMビューにリポジトリが残留する
- **ターミナルは park/unpark 方式**（`terminalGroupService.ts` にPARA-PATCHで非破壊 park/unpark を追加）。`moveToBackground` は2Dグリッドが空になると自己破棄するため使えない。**park中のグループはレイアウト永続化から漏れる**ため、`terminalService.ts` の `_saveState`（ptyHostへのレイアウト保存）と `_onWillShutdown`（リロード時のdetach対象）にも park 中グループを含めるPARA-PATCHが必須（これを怠るとリロードで退避中ターミナルが消える。`_saveState` はシャットダウン中スキップされるので「シャットダウン時に全unpark」では解決できない）
- **リロード後の再parkは保存済みマッピング（persistentProcessId→リポジトリID）を起動時に一度だけ読む**こと。グループ出現のたびに読み直すと、起動直後の一律タグ付けの persist が正しい対応を上書きして repark が効かなくなる
- **ブラウザは dispose veto + 同一idの getOrCreateLazy で無リロード復帰**: `BrowserEditorInput.onBeforeDispose` の veto（upstream純正フック）を切り替え中(`isSwitching`)だけ効かせると、input と WebContentsView が `_known` に生存したまま。working set 復元時に serializer が同一idを `getOrCreateLazy` して生きた実体へ再接続する（`window.__marker` 一致で無リロードを実証）。ユーザーの手動クローズは veto しない（正しく破棄される）
- **ビュー登録の罠**: `registerViews` の `openCommandActionDescriptor.id` に `<viewId>.focus` を指定してはいけない（ビュー登録が自動生成する focus コマンドと衝突して **workbench 全体が起動不能**になる）
- **キーバインド**: mac の `ctrl+cmd+1`/`ctrl+cmd+9` は upstream の Move Editor into First/Last Group と衝突するため weight +1 で上書き（1〜9の一貫性を優先）。切り替えは `ctrl+cmd+1..9` / `ctrl+cmd+[` `]`（win/linux: `ctrl+alt+…`）
- **SCMコミットメッセージ入力**はリポジトリ close で消える唯一の transient 状態。`onWillSwitchRepository` で退避し、Git再スキャン完了（`onDidAddRepository`）を待って復元する
- **SCMリポジトリ一覧の残留は「閉じる」では解決しない（2026-07-29確定）**: 旧スペースのリポジトリを `git.close` で消そうとしても、GitHub Pull Requests 等の他拡張がそのリポジトリを掴んでいると即座に開き直され、close↔open が繰り返される（実機ログで3往復を確認: `[Model][close]` → 7秒後に `[Model][openRepository]`）。`paradisScmRepoScope` は無限ループ回避のため3回で諦めて「開いたまま非表示」に妥協するが、その非表示は `visibleRepositories`＝「変更」ビューにしか効かず、「リポジトリ」一覧セクションは `ISCMViewService.repositories` を直接描画するため残り続けていた。**対策は閉じることではなく、`ISCMViewService` を fork 実装（`paradisScopedScmViewService.ts`、upstream の `SCMViewService` を内包）へ差し替えて一覧そのものを絞ること**。あわせて `scmRepositoriesViewPane.ts` に1行 PARA-PATCH が必要 — ツリー再構築のトリガーは `ISCMService.onDidAddRepository/onDidRemoveRepository` だけで、`ISCMViewService.onDidChangeRepositories` は upstream では誰も購読していないため、リポジトリの開閉を伴わないフォルダ入れ替えでは一覧が更新されない
- **`git.close` は完全撤去（2026-08-03）**: 上記の対策で一覧を絞れるようになった時点で `git.close` は不要になっていたが、`paradisScmRepoScope` に呼び出しが残っており、モーダル「Git: 利用可能なリポジトリがありません」の原因になっていた。upstream の `git.close` は `{ repository: true }` 登録のため、第一引数からリポジトリを解決できないと `model.pickRepository()` にフォールバックし、git 拡張側で開いているリポジトリが 0件ならモーダル、**1件なら無確認でその1件を閉じ**、2件以上なら QuickPick を出す。解決に失敗するのは日常的で、フォルダ入れ替え時に git 拡張が外れたフォルダのリポジトリを `Model.close` ではなく `OpenRepository.dispose()` で直接破棄する（→ ログにも `closedRepositories` にも残らない）ため、renderer 側の `scmService.repositories` にはまだ見えるのに ext host にはもう無い、という窓が秒単位で開く（Windows は git のプロセス起動が遅く、実機ログでコマンド1本あたり数百ms〜1.7秒）。実機ログ17時間分で `[Model][close]` 2回に対し `Opened repository` 33回という非対称が出るのはこの dispose 経路のため。撤去の代償は「スコープ外リポジトリが git 拡張側では開いたまま残る」こと（`git.pull` 等のリポジトリピッカーに現れる／再帰ウォッチャーと AutoFetcher が回収されない）
- **復元中のparkはsplitを壊す（2026-08-03修正）**: upstreamのレイアウト復元はタブの2枚目以降を `{ parentTerminal: 直前のインスタンス }` で作り、split先を `getGroupForInstance`（`groups` しか見ない）で引く。したがって1枚目のペインが現れた瞬間にparkすると2枚目の復元が `Cannot split a terminal without a group` で落ち、非アクティブスペースのグループはペイン1枚しか復元されない。さらに `_recreateTerminalGroups` のPromiseがrejectして `terminalService.whenConnected` が永久に未完了になり、fork側の復元後処理（`sweepRestoredGroups`／孤児エディタターミナルの回収／台帳prune）とupstreamの `backend.setReady()` がまとめて実行されなくなる。対策は「復元完了まで park を保留し `whenConnected` 後にまとめて流す」（`_deferredParkGroups`）
- **エディタタブのターミナルは「番号」ではなく nonce で繋ぐ（2026-08-03修正、実機ログで確定）**: `persistentProcessId` は世代ローカルで、pty host は再起動のたびに採番を0から振り直す。実機ログでは旧ID 4,5,13,15,17… が新ID 1〜20 に写っており、**旧ID空間と新ID空間が完全に重なる**。エディタタブは working set に前世代のIDを持つため、対応表(`_revivedPtyIdMap`)で補正できないと生のIDで attach し、その番号を引き継いだ無関係な端末を掴む（実機ログに `Persistent process reconnection "84"/"131"/"139" failed` が残っている）。2つの修正を入れた:
  - `_expandTerminalInstance` が対応表のエントリを**消さない**ようにした。パネルのレイアウト復元とエディタタブの復元は別経路で同じ表を引くので、パネルが先に消費するとエディタ側が自分のIDを引けなくなっていた
  - `getRevivedPtyNewId` に `paradisExpectedNonce` を足し、**attach する直前に shell integration nonce で本人確認**する（`attachToRevivedProcess` → `terminalProcessManager` が working set 由来の nonce を渡す）。nonce は revive を跨いで保持されるので、世代に依存せず端末を同定できる。一致しなければ `PARADIS_UNRESOLVABLE_PTY_ID`(-1) を返し、upstream の「attach 失敗 → 新しいシェルを起動」経路に乗せる。**空で開く方が、他ウィンドウから端末を奪うより安全**という既存の方針（`paradisTerminalEditorRevive.ts`）に揃えた
  - 起動時のエディタ復元では fork の revive index（nonce → 現世代ID）がまだ登録されておらず守れない。この nonce 検証は pty host 側で同期的に効くため、その穴を起動シーケンスに手を入れずに塞げる
- **worktreeスコープの台帳は起動時に隔離するが、バリア後は未知のstateKeyも採用する（2026-08-03修正）**: 未知のまま捨てると、その端末はスコープ無し→initial cwdも登録ルート外→「起動時のアクティブスペース」へ恒久的に吸収され、別ディレクトリの端末が現スペースに紛れ込む。スコープが本当に消えた場合は `onDidRetireScope` が明示的に台帳を掃除する
- 2Dグリッドの配置と比率は、fork独自スナップショット（`sessions/contrib/terminalGrid/browser/sessionTerminalGridLayoutService.ts`、WORKSPACEスコープstorage）で復元する。upstreamのレイアウト情報は1タブ＝1次元の `relativeSize` 配列しか持てず2Dを表現できないため、`Grid` のserialize結果を別建てで持ち、復元後（`whenConnected`後）に一度だけ適用して組み直す
  - **persistentProcessIdは世代ローカル**（pty hostは再起動のたびに採番を0から振り直す）。したがって照合には必ず「そのエントリを書いたセッションのID」を使う: 保存は現世代の `persistentProcessId`、復元側は `attachPersistentProcess.paradisRevivedFromPersistentProcessId`（リロード時は `attachPersistentProcess.id`）。**今セッションで新規作成した端末は照合対象にしない**（新IDが前セッションの無関係な端末のIDと偶然一致し、他スペースのレイアウトを奪って消費してしまう）
  - 未claimのエントリは保存時に今世代IDへ**再キー**する（`sessionRekeyGridLayoutEntries`）。しないと、一度も訪問しないスペースのエントリは2世代前のIDのまま取り残されて二度と一致しない。再キーはstorageへ書く値だけに適用し、claim用のin-memory台帳は前世代IDのまま置く（順序に依存しないため）
  - 保存は毎回storageを読み直してマージする（同一ワークスペースを複数ウィンドウで開いたときのlost update回避）。自分のものと他ウィンドウのものは端末IDで判別し、**前世代・今世代の両方のIDを「自分のもの」として扱う**（でないと自分の古い版が他人のものとして温存される）。逆に、**live端末で説明のつかないエントリは書き戻さない**（起動時スナップショットは他ウィンドウの最新版より古い可能性があるため）
  - 既知の限界: 全ペインを閉じたグループのエントリは、説明のつく端末がいなくなるため再キーされず旧世代のIDのままstorageに残る（エントリ上限32件から押し出されるまで）。claimには「ID集合の完全一致」が要るので、古いエントリは無視されるだけで誤マッチはしない
- **WORKSPACEスコープのstorageは全スペースで共有される（2026-08-09整理）**: workspace idがconfigPath依存で固定なので、`state.vscdb`は1つしかない。`paradis.workspaceSwitch.*`（workingSets/terminalRepositories/browserScopes/scmInputs/spaceNotes）は最初から自前でスペースIDをキーに混ぜて分けてきたが、**upstream由来でWORKSPACEスコープを「1つの作業単位」と仮定しているものは混ざったまま**。実機の`state.vscdb`で確認した混在の例: `history.entries`（エディタ履歴、下記で対処済み）、`workbench.tasks.recentlyUsedTasks2`、`memento/workbench.view.search`、および**拡張機能の`workspaceState`**（`vscode.git`/`mhutchie.git-graph`/`GitHub.copilot-chat`等。`extensionStorage.ts`がWORKSPACEスコープへ直接書く）
  - `IStorageService.switch()`（`storage.ts`）でstorage自体を差し替える手はあり、renderer側の`RemoteStorageService.switchToWorkspace()`は実装済み（旧DBをclose→新DBをinit→`switchData`で全キーの変更イベント発火）。だが**upstreamの大半のコンポーネントは起動時に一度読んでメモリに持ち、変更イベントを購読していない**（`HistoryService.ensureHistoryLoaded`が典型）。差し替えても古い値が生き残り、次の保存で新スペースのDBを汚染する。upstreamがこのAPIを使う唯一の場面はuntitled workspaceの保存で、`preserveData`により中身が同一だから顕在化しないだけ。全コンポーネントを追随させるにはウィンドウリロードが必要で、それは機能1の存在意義そのものを否定する
  - したがって方針は「storageごと切り替える」ではなく、**スペース依存の状態を1つずつ、save→clear→loadのフックを書けるものから載せ替える**。拡張機能の`workspaceState`は値を持つのがext host側の拡張コードで、切り替え時に読み直させる手段がない（ext host再起動が必要）ため**現構造では対象外**
- **エディタ履歴のスペース分離（2026-08-09実装、`paradisHistoryScope.ts` + `historyService.ts`のPARA-PATCH）**: Ctrl+Pの「最近開いたもの」に別スペースのファイルが出る報告が発端。実機で`history.entries`178件に7リポジトリ分が混在していることを確認した。保存キーを`history.entries.<フォルダURIのhash>`に分け、`onDidChangeWorkspaceFolders`で「読み込み元のキーへ書き戻す→破棄→次の参照で新スペース分をロード」する。上限200件もスペースごとに独立する。実装で踏んだ/避けた落とし穴:
  - **書き戻し先は「今のキー」ではなく「読み込んだキー」**。メモリ上の履歴がどのスペースのものかを`paradisLoadedHistoryKey`で持つ。今のキーへ書くと切り替え先の履歴を切り替え元の内容で潰す
  - **未ロード状態で書かない**。`ensureHistoryLoaded`は`editorGroupService.isReady`がfalseのとき`history = []`を置いて`whenReady`後に`loadHistory()`する。この窓で`saveState`が走ると空配列でそのスペースの永続履歴を全消去する。`paradisLoadedHistoryKey === undefined`をガードにして塞いだ
  - **リセットの判定は「foldersが入れ替わったか」ではなく「保存先キーが変わったか」**。フォルダ0個からの遷移やマルチルートとの間の遷移でも取りこぼさないため
  - **LRU（上限24スペース）は「これから読むスペース」も必ず先頭へ寄せてから間引く**。保存したときだけ追跡すると、久しぶりに戻るスペースほど捨てられる側に溜まり、戻った瞬間に履歴を失う
  - 既知の制限: (1) 切り替え先スペースがフォルダ外のファイル（ユーザー設定等）を開いていた場合、切り替え元の履歴に残る（除去判定はフォルダ配下かどうかしか見られない。取り切るには切り替えの開始そのものを知る必要がある）。(2) 補助ウィンドウにピン留めしたエディタは`editorService.getEditors`が全パートを列挙するため新スペースの履歴に入り得る。(3) スペースを分ける前の`history.entries`は各スペースが自分の分を引き継げるよう残す（孤児として31KB程度）。(4) Ctrl+Shift+Tのreopenスタックとナビゲーションスタックはスペースを跨いだまま（どちらも非永続でセッション内のみ）
- 既知の制限: ブラウザページはウィンドウリロードを跨ぐと再ロードされる（WebContentsViewがウィンドウに紐づくため。URLはworking set経由で復元）。ブラウザのCookieパーティションは全リポジトリ共有

## 新しいスペースのモデル候補は CLI から取る（agentModelCatalog、2026-09-27）

`src/vs/paradis/contrib/agentModelCatalog/` に実装。shared process が CLI を起こして一覧を取り、`<userData>/paradis-agent-models.json` に残す。CLI のパスか `--version` が変わったとき、または1日経ったときだけ取り直す。取れなければ前回の一覧、それも無ければ固定の候補（`PARADIS_DEFAULT_AGENT_COMMANDS`）のまま。

- Claude Code（2.1.283 で実測）: `claude -p --setting-sources user --settings '{"disableAllHooks":true}' --strict-mcp-config --no-session-persistence --input-format stream-json --output-format stream-json --verbose` の stdin に `{"type":"control_request","request_id":"…","request":{"subtype":"list_models"}}` を1行書いて閉じる。API は呼ばず約2秒で返り、ログインしていなくても答える。`--settings` で hook を止めないと、利用者の SessionStart hook がこの裏のプロセスで走ることを確かめている。`-p` は workspace trust を確かめないので、作業ディレクトリのプロジェクト設定（`.claude/settings.json` の `apiKeyHelper` や `env` など）も読んでしまう。`--setting-sources user` を付けないと作業ディレクトリの hook が走り、付けると走らないことを実測した。作業ディレクトリ自体も `fs.mkdtemp` で作る自分専用（0700）の空のディレクトリにし、終わったら消す（Linux の共有 `/tmp` をそのまま使うと、他の利用者が置いた設定を読みうる。Codex も同じディレクトリで起こす）。`--no-session-persistence` を知らない古い CLI では、stderr にこのフラグ名が出たときだけ外して取り直す。一覧の `default` 行と `disabled` 行は外す。一覧に出ない `opusplan` だけは既定の候補から引き継ぐ
- Codex（0.155.1 で実測）: `codex app-server` の `model/list`（`hidden` は外す）。ログインしていない一時 `CODEX_HOME` でも同梱のカタログを返した。実物の取得は利用者の既定の `CODEX_HOME` で行う
- **置き換えるのは既定の定義だけ。** `paradis.workspaceSwitch.agents` は `getValue` だとスキーマ既定値が返って「書いたか」が分からないので、`inspect` のどこかの層に値があるかで判断する（`paradisIsAgentListUserDefined`）。書いてあれば取得自体をしない
- 画面側は `IParadisAgentModelCatalogService`（electron-browser の singleton）が一覧を持つ。ダイアログ（`_agents`）とモバイルからの作成（`paradisConfiguredAgents`）はどちらもここの `getAgentTemplates()`（中身は `paradisResolveAgentTemplates`）を通す。起動時と、作成ダイアログを開くたびに `refresh()` し、一覧が変わったらダイアログは選んでいるモデルとエフォートを保ったまま並べ直す。shared process は 60 秒は同じ結果を返すので、開くたびに呼んでも CLI は起きない
- `opus[1m]` のような記号入りの id は `--model "opus[1m]"` と二重引用符で包む（zsh では `[...]` がグロブになる）。それでも安全に書けない id は候補から外す
- SSH で接続中のウィンドウでも、候補は手元の CLI から取ったもの（接続先の CLI の版は見ていない）

## フェーズ2との統合で行う作業（2026-09-27、フェーズ3のレビューで判明。まだ未着手）

フェーズ3（hook の信頼・モデル候補）は、フェーズ2（`para/phase2`）が main に入る前に作ったため、次の重複と取りこぼしが残っている。どれもフェーズ2が main に入ってから、この順で片付ける。今コードを寄せないのは、寄せ先がまだ main に無いため。

1. **Codex app-server のクライアントが3つある。** limitsMonitor の `ParadisCodexRpcSession`（`paradisLimitsMonitorChannel.ts`）、フェーズ2の `src/vs/paradis/node/paradisCodexAppServerRpc.ts`、フェーズ3の `src/vs/paradis/node/paradisCodexAppServerSession.ts`。起動の仕方も違う（フェーズ2は `-s read-only -a never app-server` で `jsonrpc: "2.0"` を付ける。フェーズ3はサンドボックス指定なしで `jsonrpc` を付けない）。エラーの型も `ParadisCodexRpcError` と `ParadisCodexRpcMethodNotFoundError` に分かれている。フェーズ2の `paradisCodexAppServerRpc.ts` へ一本化し、足りないもの（`clientInfo.title`、`cwd`、`CODEX_HOME` の上書き、「メソッドが無い」の判定）はオプションとして足す。`model/list` はサンドボックス付きの既定起動で足りる。`config/batchWrite` を読み取り専用サンドボックスのまま書けるかは【要確認】（書けなければ hook の信頼だけサンドボックスを外す）
2. **Codex のホームの一覧をフェーズ2に揃える。** hook の信頼が監視・自動付与するのは既定のホームだけで、受け付ける条件も `~/.codex-[A-Za-z0-9._-]+` とフェーズ2（`/^\.codex-\d+$/` と設定 `paradis.limitsMonitor.codexHomes`。手作りの `.codex-backup` は外す）と違う。`ParadisCodexHookTrustService.resolveHome` をフェーズ2の `paradisCodexHomes()` / `paradisCodexHomeCandidates()` による判定へ置き換え、hook を置いたあとに全ホームへ `autoGrant(home)` を呼び、全ホームの hooks.json を監視する。放置すると `~/.codex-2` でログインした Codex では、フェーズ2が置いた hook に信頼が付かず、状態表示と通知が動かない。会話集計（`agentActivity` の `listTranscripts` が `paradisCodexHome()` の1つだけを読む。WSL も `paradisResolveAgentHomes` を通っていない）も同じ一覧へ揃える必要がある（agentActivity の担当分）
3. **原子的な書き込みが3つある。** `paradisWriteFileAtomicallySync`（`agentBrowser/node/paradisAgentHooksSetup.ts`、ハードリンクと rename 失敗の扱いがある）、`writeConfigAtomic`（`paradisMcpSetup.ts`、書く直前に元のファイルが変わっていないか確かめる）、`paradisWriteFileAtomic`（`src/vs/paradis/node/`、fsync と権限の当て直しはあるが、置き場所は userData 専用の想定）。`src/vs/paradis/node/` へ1つにまとめる。フェーズ2が hooks の設置を触っているので、今は動かさない
4. **CLI の実行ファイルの探し方が5か所に重複している。** limitsMonitor・ccusage・フェーズ2の codexAccounts・`paradisClaudeLogin.ts`・フェーズ3の `paradisResolveAgentCli`（`src/vs/paradis/node/paradisAgentCli.ts`）。`paradisResolveAgentCli` へ寄せる（こちらには `~/.claude/local` を足し済み）
5. `paradis.sharedProcess.contribution.ts` の「登録」欄にフェーズ2も2行足しているので、統合時に1つのブロックへ並べ直す（解消は機械的）

## リリース手順（runbook、2026-07-03確立・v1.128.0-paracode-2で全自動を実証済み）

新しいリリースを出すのに必要な操作は**タグを打ってpushするだけ**:

```bash
git tag -a v1.128.0-paracode-3 -m "para: v1.128.0-paracode-3"   # 番号をインクリメント
git push origin v1.128.0-paracode-3
```

これで `.github/workflows/para-release.yml` が起動し、以下がすべて自動で走る（所要40〜60分）:
1. 5プラットフォーム（darwin x64/arm64・win32 x64/arm64・linux x64）のビルド。macのみコード署名+公証、Windowsは現状無署名
2. publishジョブが成果物をR2（S3互換APIでアップロード）→ 更新フィードKVにメタデータ書き込み（この順序厳守: 先にオブジェクト、後にメタ）
3. 完了した瞬間から、既存インストールの次回更新チェック（起動時または1時間毎）で自動アップデートが配信される

**ルール・注意**:
- タグ名は `v{upstreamバージョン}-paracode-{N}` 形式。`package.json`のversionは**触らない**（`+paracode.N`等のサフィックスはvsce/hygieneが拒否する。詳細は下記の試行1の記録）
- タグは**push済みのcommit**に打つこと。ビルド失敗でタグを付け直す場合は `git tag -d <tag> && git push origin :refs/tags/<tag>` で消してから再作成（このワークフローはタグの上書きを検知しない）
- 進捗確認: `gh run list --workflow=para-release.yml`、失敗調査: `gh run view <id> --log-failed`
- 単一プラットフォームだけ再検証したい場合: `gh workflow run para-release.yml -f platforms=win32`（`darwin`/`linux`も可、カンマ区切り。publishはスキップされる）
- リリース後の動作確認（フィードが新commitを配信しているか）:
  ```bash
  # 1つ前のリリースのcommitを名乗って照会 → 新commitのURLを含むJSONが返ればOK（要Accessヘッダー、値はGitHub Secrets参照）
  curl -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..." \
    "https://paracode-updates.paradis.ltd/api/update/darwin-arm64/stable/<旧commit>"
  ```
- publishだけ失敗した場合（ビルドは成功）: CIを回し直さず、成果物を `gh run download <run-id>` でローカルに落として手動publishできる。手順は下記「リリース完了（2026-07-03）」の記録参照（S3クレデンシャルはCF APIトークンから導出: access key=トークンid、secret=トークン値のSHA-256）

## 配布・自動アップデート基盤（2026-07-03着手）

win/mac/linuxへの配布と自動アップデートの実装。設計の経緯・判断根拠（Cloudflare Access範囲、R2直送を選んだ理由、mac/win署名コスト比較等）はこのセッションの会話ログ参照。ここには実装状態と再開に必要な情報のみ記す。

**方針**: GitHub Actions（`.github/workflows/para-release.yml`、fork所有）でビルド・パッケージング → macのみ署名・公証 → Cloudflare R2へ成果物を直送（設計当時はprivate repoで、GitHub Releasesの`browser_download_url`が未認証404になるため配布経路にしなかった。現在のリポジトリはpublic） → Cloudflare Workers（`cloudflare/update-server/`、fork所有）がKVを引いて更新フィードAPIを返す。フィードAPIのみCloudflare Accessのサービストークンで保護し、R2アセットは非推測パス（`{quality}/{platform}/{commit}/...`）でヘッダーなし公開（macOSのSquirrel.Macがフィード用headersをアセットDLへ転送しない前提のため。R2アセット公開のみで個人認証はしない＝カジュアルアクセス遮断程度の割り切り）。

**実装済み**（以下はコード実装時点の記録。Cloudflare側の反映状況は後続節を参照）:
- `src/vs/base/common/product.ts`: `updateAccessClientId`/`updateAccessClientSecret`フィールド追加（PARA-PATCH）
- `product.json`: `quality: "stable"` / `updateUrl` / `downloadUrl` 追加。`updateUrl`は`https://paracode-updates.paradis.ltd`（カスタムドメイン、動作確認済み。旧`*.workers.dev`のURLからの切り替え履歴は下記参照）。`downloadUrl`のみ`https://updates.paradis.ltd/download`の暫定プレースホルダーのまま（実在しない。ドメインの一貫性も無いので要修正、NOTES.md表の該当行も参照）
- `build/gulpfile.vscode.ts`: `productJsonStream`に、環境変数`PARA_UPDATE_ACCESS_CLIENT_ID`/`PARA_UPDATE_ACCESS_CLIENT_SECRET`が存在する場合のみ`updateAccessClientId`/`updateAccessClientSecret`をproduct.jsonへstampするPARA-PATCH（`agentSdks`スタンプと同じパターン）。ローカル/PRビルドでは常に未設定＝ヘッダー無し
- `src/vs/platform/update/electron-main/abstractUpdateService.ts`: 新規`export function getUpdateAccessHeaders(productService)`を追加（既存`getUpdateRequestHeaders`のシグネチャは不変）。`isLatestVersion()`内の1箇所をPARA-PATCHでマージ
- `updateService.win32.ts`（1箇所）/ `updateService.darwin.ts`（`buildUpdateFeedUrl`と`checkForUpdateNoDownload`の2箇所）/ `updateService.linux.ts`（従来headers未送信だったため新規追加）: いずれも`getUpdateAccessHeaders`をPARA-PATCHで配線済み
- `cloudflare/update-server/`: `GET /api/update/:platform/:quality/:commit`を実装するWorker（`src/index.ts`）。KVスキーマは`{quality}:{platform}`キーで`IReleaseRecord`（commit/version/productVersion/url/sha256hash/timestamp）を格納。`npm run typecheck`通過確認済み
- `.github/workflows/para-release.yml`: tag push(`v*`)/手動dispatchで3プラットフォームをビルド。mac署名は`build/darwin/sign.ts`をそのまま再利用（`AGENT_TEMPDIRECTORY`/`VSCODE_ARCH`/`CODESIGN_IDENTITY`必須）+ `notarytool`公証。**Windowsは意図的に無署名**（SmartScreen警告・AV誤検知リスクは許容、Azure Trusted Signingは後続フェーズ）。publishジョブがR2アップロード→KV更新の順で実行（メタ先行によるURL 404を防ぐため）。**ワークフローが参照する13個のGitHub Actions secretsはすべて登録済み**（2026-07-03、下記参照）。tag pushによる全自動実行は`v1.128.0-paracode-2`で実証済み

**Cloudflareデプロイ先アカウント側（2026-07-03、ユーザー許可の上で実施）**:
- KV namespace: `para-code-update-releases`。**namespaceの命名について**: 当初は汎用名で作成したが、複数プロジェクトが同居するアカウントで識別しにくいため、空のまま削除してプロジェクト名付きで作り直した。**教訓: 複数プロジェクトが同居するCloudflareアカウントでは、KV/R2/Worker等のリソース名に最初からプロジェクトプレフィックス（`para-code-`）を付けること**。wrangler.tomlの`binding`名（`RELEASES`）はWorkerコード内だけのローカルな参照なので、この問題とは無関係（変更不要）
- R2バケット: `para-code-releases`を作成済み。匿名公開（`dev-url enable`）も実施済み。**公開URL: `https://pub-753b4bcb636d45bfad234cefc4414031.r2.dev`**（存在しないキーへのGETは404、一覧性は無いことを確認済み）。GitHub Actions secrets登録時、`CF_R2_PUBLIC_BASE_URL`にこの値をセットする
- Worker: `para-code-update-server`をデプロイ済み。既定URLに加え、カスタムドメイン`https://paracode-updates.paradis.ltd`をCustom Domain機能（`wrangler.toml`の`[[routes]] pattern = "paracode-updates.paradis.ltd", custom_domain = true` → `wrangler deploy`）で紐付け済み。同一アカウント内のゾーンであることを確認し、カスタムドメインの`/api/update/darwin-arm64/stable/<commit>`へ疎通確認済み。サブドメインは`updates.paradis.ltd`ではなく`paracode-updates.paradis.ltd`（KV namespace命名の教訓と同じ理由でプロダクト名プレフィックスを採用）

**GitHub Actions secrets（2026-07-03、このリポジトリに全13個登録済み）**:
- `CF_ACCOUNT_ID` / `CF_API_TOKEN`（トークン名: `para-code-deploy`。`/user/tokens/verify`でactiveと確認済み） / `CF_R2_BUCKET` / `CF_R2_PUBLIC_BASE_URL` / `CF_KV_NAMESPACE_ID`
- `APPLE_TEAM_ID` / `APPLE_CODESIGN_IDENTITY` / `APPLE_CERTIFICATE_P12_BASE64` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`（値はGitHub Secretsのみに保持。ここには書かない）
- `PARA_UPDATE_ACCESS_CLIENT_ID` / `PARA_UPDATE_ACCESS_CLIENT_SECRET`（Service Token名: `para-code-update-client`、Non-expiring。Access Applicationは後続節のとおり設定・動作確認済み）
- 署名証明書とパスワードはGitHub Secretsでのみ管理し、ローカルの保存先・ユーザー名・キーチェーン情報は公開リポジトリへ記録しない

**Cloudflare Access Application（2026-07-03、完了）**:
- ダッシュボードではなく、Cloudflare API（`curl`、一時的に発行した`Access: Apps and Policies`+`Access: Service Tokens`権限のAPIトークン経由）で作成した。`wrangler`はAccess関連のリソースを一切扱えないため不可避
- Application: domain `paracode-updates.paradis.ltd/api/update`（ドメイン全体ではなくパスを絞った。内部IDは公開文書へ記録しない）
- Policy: `decision: "non_identity"`（ダッシュボードの「Service Auth」に相当するAPI上の値）、`include`に`para-code-update-client`のservice token idを指定（内部IDは公開文書へ記録しない）
- **service tokenの内部id（policyのinclude用）はclient_id（`xxxx.access`の`xxxx`部分）とは別物**。`GET /accounts/{id}/access/service_tokens`で引く必要があり、`Access: Service Tokens`権限が別途要る（`Access: Apps and Policies`だけでは403になる）。素朴に「client_idの先頭部分をid扱いする」のは誤り（実際に一度失敗した）
- 動作確認済み: 認証ヘッダー無し→403、正しい`CF-Access-Client-Id`/`CF-Access-Client-Secret`付き→204
- **副産物（意図せず発生、結果的に必要な修正）**: カスタムドメインroute追加時に`workers_dev`を明示していなかったため、`para-code-update-server.cloudflare8234.workers.dev`側が自動的に無効化された（Cloudflareエラー1042）。**これは望ましい**——もし無効化されていなければ、Access保護はカスタムドメイン経由のみに効き、旧workers.dev URLからAccessを完全に迂回できてしまうところだった
- Access設定用に発行した一時APIトークン（`para-code-for-setting-temp`）は、今後Applicationやポリシーを変更しない限り不要。ユーザー側でCloudflareダッシュボードから削除するかの判断待ち（エージェント側からは削除しない）

**残件**:
- `downloadUrl`のドメイン不一致（`updates.paradis.ltd` vs 実際に使っている`paracode-updates.paradis.ltd`）の解消。まだ実在するページが無いため後回し中

**リリースワークフロー試行の記録（2026-07-03、複数回の失敗→原因特定・修正済み）**:

試行1（tag `v1.128.0+paracode.1`、run 28630772747、全ジョブ失敗）:
- **バージョン採番の教訓**: semver build metadata方式（`1.128.0+paracode.1`）は理論上正しいが、このリポジトリでは2重に不採用となった。(1) `build/hygiene.ts`の`checkCopilotEnginesVersion`がroot package.jsonと`extensions/copilot/package.json`の`engines.vscode`の完全一致を要求する。(2) それを合わせても、`build/node_modules/@vscode/vsce/out/validation.js`の`validateEngineCompatibility`の正規表現が`-`サフィックスのみ許可で`+`(build metadata)を弾き、darwin/win32のパッケージング中にvsce（`fromLocalEsbuild`→`vsce.listFiles`のmanifest検証）が落ちる。**結論: package.jsonはupstreamのプレーンなバージョンのまま触らず、fork独自リリースの識別はgitタグ名のみで行う**（タグ形式: `v1.128.0-paracode-1`。更新フィードはcommitハッシュ比較なのでバージョン文字列は表示専用）
- linux: `npm ci`が`kerberos`ネイティブモジュールのビルドで失敗（`gssapi/gssapi.h`欠落）→ `pr-linux-test.yml`と同じ`libkrb5-dev`等のapt installステップを追加して解決

試行2（tag `v1.128.0-paracode-1`、run 28631291130、darwin-x64のみ成功=署名・公証込みで成功実績あり）で判明した3つの新しい問題と対処:
1. **win32（両arch）**: 2026年6月のGitHub公式移行で`windows-latest`が`windows-2025-vs2026`イメージ（VS 2026搭載）になり、upstream `build/npm/preinstall.ts`の`hasSupportedVisualStudioVersion()`（VS 2022/2019のみ許可）が失敗する。**対処: `runs-on: windows-2022`に固定**（GitHubの公式案内どおり。windows-2022はLTSポリシーで当面維持される）。upstreamのファイルは無改変
2. **linux**: `.deb`生成の`dpkg-shlibdeps`スキャンが`VSCode-linux-x64/bin/para-code-tunnel`（Rust製トンネルCLI、`cli/`のcargo bin `code`）を必須として要求（`build/linux/dependencies-generator.ts`にハードコード）。upstreamは別パイプライン（`build/azure-pipelines/cli/cli-compile.yml`）でビルドして配置している。**対処: ワークフローにrustupインストール→`cargo build --release --bin=code`（`VSCODE_CLI_PRODUCT_JSON`指定）→`bin/para-code-tunnel`へ配置、を追加**。加えて`dependencies-generator.ts`の`FAIL_BUILD_FOR_NEW_DEPENDENCIES`を`false`にPARA-PATCH（依存リストがupstreamのMS基準環境の参照リストと完全一致しないとビルド失敗する仕組みで、GitHubランナー上のfork buildでは恒久的に成立しないため警告化。副作用として生成される.debの`libc6`要求バージョンがランナーのglibc（ubuntu-24.04=2.39相当）に引き上がる=古いディストロでは.debがインストール不可な点は許容）
3. **darwin-arm64のみ**: パッケージ済みアプリ内の`extensions/copilot/node_modules/@github/copilot/sdk`が見つからず`prepareBuiltInCopilotRipgrepShim`で失敗。徹底調査の結果: (a) 同一runで**x64は署名・公証込みで完全成功**、(b) 両ジョブの`npm ci`ログはパッケージ数まで完全一致（ソースツリー同一）、(c) ローカル（同じarm64 mac）で`compile-copilot-extension-build`を実行するとsdkは正しく出力される、(d) `npm_config_arch`はoptional dependencyのcpu選択に影響しないことを実験で確認（platform package `@github/copilot-darwin-arm64`は両ジョブとも同じものが入る）。対処: ワークフローに「npm ci直後のSDK存在検証（fail-fast）」と「パッケージング失敗時の3層診断ダンプ（ソース/.build/アプリ内のそれぞれの@github配下）」を追加し、再発時に即座に切り分けられるようにした。`workflow_dispatch`に`platforms`入力（例: `darwin`だけ再実行）も追加してイテレーションコストを削減

試行3（tag付け直し、run 28633263239、**linux成功（CLI修正が有効）**・darwin-x64成功2回目）で残り2問題の根本原因が確定・修正済み:
1. **darwin-arm64（試行2の再発、今回は診断で原因確定）**: 3層診断の結果、ソースは正常・**`.build/extensions/copilot`は診断時点(02:02)ではsdk含め完全**・アプリ内だけsdk欠落、かつ`compile-copilot-extension-build`タスクは01:59:29に完了報告済みなのにパッケージング(02:01:31開始)が取りこぼす、という物証が揃った。**根本原因: `packageCopilotExtensionStream`（`build/lib/extensions.ts`）が拡張バンドルと production node_modules コピー（実測70秒かかる大容量コピー）を`es.merge()`で1本のストリームに束ねており、マージ後のストリームの完了シグナルが依存関係コピーの実書き込み完了より先に発火し得る**（gulpタスクは完了扱い→同一プロセス内の後続packageTaskが書き込み途中の`.build`をglobで読む）。x64ジョブやローカルで再現しなかったのは純粋にタイミング依存のため。upstreamのCIはこのコードパスを使わない（copilotはVSIXダウンロード。「non-CI local builds」用のパス）ので上流では顕在化しにくい。**修正: PARA-PATCHで2つの逐次gulpパイプラインに分割**（`bundle-copilot-extension-build`→`copy-copilot-extension-dependencies-build`、それぞれのdest完了を個別にawait。`build/lib/extensions.ts`+`build/gulpfile.extensions.ts`）。ローカルで分割後の動作とsdk出力を確認済み
2. **win32（両arch、VS2022ランナー修正で前進した先の新問題）**: `package-win32-{arch}`が`gulpfile.vscode.ts`の`quality === 'stable'`分岐で`product.win32ContextMenu![arch]`を非nullアサーション参照して`TypeError: Cannot read properties of undefined`。`win32ContextMenu`（Windows 11エクスプローラのコンテキストメニュー統合のCLSID）と対応するappxアセット（`.build/win32/appx`、explorer command DLL）は**Microsoftの内部distro mixin/パイプラインだけが供給するもので、fork には存在しない**。さらに同じ問題が`gulpfile.vscode.win32.ts`のInno Setup定義（`AppxPackageName`を#defineすると`code.iss`が`skipifsourcedoesntexist`なしでappxファイルを参照→ISCCが失敗）にも潜んでいた。**修正: 両箇所とも`quality`条件に`product.win32ContextMenu`の存在チェックをPARA-PATCHで追加**（fork ではエクスプローラ統合を単に無効化。本体機能に影響なし）

試行4（run 28634483948）: **darwin両arch（ストリーム分割修正が有効と実証）とlinuxが成功**。win32のみ次の層で失敗:
- `patchWin32DependenciesTask`の`stripAuthenticodeSignature`（MSの再署名前に既存Authenticode署名を剥がす工程）が`signtool.exe`をspawnするが、GitHub HostedランナーではWindows SDK内にあるだけでPATHに無く`ENOENT`。無署名配布のforkには署名剥がし自体が不要なので、**`hasAuthenticodeSignature`のspawnエラーがENOENTの場合「署名なし」として扱うPARA-PATCH**で修正済み（commit 65fe25af1ab）。なお`code.iss`の`SignTool=esrp`は`#ifdef Sign`（`--sign`フラグ時のみ）なので無署名ビルドには無害と確認済み
- **win32単独の検証runを`workflow_dispatch platforms=win32`で試行したところ、GitHub Actionsの支払い上限到達で起動不可**（macOSジョブ=分数10倍消費のフルランを4回実行したため）→ リポジトリをpublic化して解消（ユーザー判断。public化前に単語「Paradis」「社内」の除去を実施、commit d33785a4beb）

**リリース完了（2026-07-03、`v1.128.0-paracode-1` = commit 674411c1829）**:
- public化後のwin32検証で2層の追加修正: (1) `patchWin32DependenciesTask`のrcedit が copilot拡張同梱の`@anthropic-ai/claude-agent-sdk/vendor/audio-capture/arm64-darwin/audio-capture.node`（Mach-O）を処理できず失敗 → **MZヘッダの無いファイル（非PE）をスキップするPARA-PATCH**（`gulpfile.vscode.ts`）。(2) ワークフローのsha256収集ステップのパス誤り（Inno Setup出力は`.build/win32-<arch>/user-setup/`、`../VSCode-win32-<arch>-user/`ではない）
- **フルラン（run 28654273918）で史上初の全5ビルドジョブ成功**（darwin×2は署名・公証込み）。publishジョブのみ失敗: **`wrangler r2 object put`は300MiB上限**があり、全成果物（315〜336MB）が超過
- **回避策 兼 恒久修正: R2のS3互換API（マルチパート、サイズ上限実質なし）を使う。CloudflareのAPIトークン（R2 Write権限付きなら何でも）はそのままS3クレデンシャルになる: access key id = トークンのid（`/user/tokens/verify`で取得）、secret access key = トークン値のSHA-256 hex**。aws cliは`AWS_DEFAULT_REGION=auto`と`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`を設定。ワークフローのpublishステップはこの方式に書き換え、`v1.128.0-paracode-2`で全自動publishを実証済み
- 初回リリース自体は、run 28654273918の成果物（sha256検証済み）をローカルにダウンロードし、aws s3 cpでR2へアップロード → `wrangler kv key put`でメタデータ書き込み、という手動publishで完了。**落とし穴: ローカルwranglerはOAuthで複数アカウントが見えるため、`CLOUDFLARE_ACCOUNT_ID`環境変数を指定しないと非対話モードでエラーになる（しかも当初これをパイプで握りつぶして書き込み成功と誤認した。wranglerの成否は必ず出力全体で確認すること）**
- E2E検証済み: 旧commit照会→更新JSON（全5プラットフォーム）、最新commit照会→204、無認証→403、フィードの`url`から実バイナリ取得（zipマジックナンバー確認）
- dependabot PR 2件（actions/cache 5→6、actions/checkout 6→7）もsquashマージ済み（upstream由来ワークフローへの変更なので将来の取り込みで軽微なコンフリクトの可能性あり）
- **SDKの実体に関する知見**: `@github/copilot`のnpmパッケージ本体は`npm-loader.js`のみの空殻で、`sdk/`等の実体は`extensions/copilot/script/postinstall.ts`（`materializeCopilotCliSdkLayout`）が`process.arch`で選ばれたplatform package（`@github/copilot-darwin-arm64`等）からコピーして生成する。パッケージング時は`.build/extensions/copilot`経由で（`packageCopilotExtensionStream`の`getProductionDependencies`ストリーム）アプリに入る
- GitHub Actions側のsecrets登録一式（Apple署名・公証用6種、`CF_API_TOKEN`/`CF_ACCOUNT_ID`/`CF_R2_BUCKET`/`CF_R2_PUBLIC_BASE_URL`/`CF_KV_NAMESPACE_ID`/`PARA_UPDATE_ACCESS_CLIENT_ID`/`_SECRET`）。具体値はGitHub Secretsとデプロイ設定で管理し、公開文書へ重複記載しない

**当時の次アクション（履歴）**: GitHub Actions secrets登録 → Access Application作成 → 実リリースでのE2E確認。secrets登録と初回リリースのE2E確認は上記のとおり完了済み。

## モバイルリレー: Cloudflare Workers/DOデプロイ（2026-07-05）

「Para Code Mobile」（iPhone遠隔操作機能、`src/vs/paradis/contrib/mobileRelay/`）がPCとモバイルの間を中継するリレーサーバー（`app/relay/`、Cloudflare Workers + Durable Objects）を、開発時のプレースホルダーURLのまま放置していたのを本番デプロイした。設計・実装の詳細は設計書（`app/design/mobile-design.md`）参照。ここには配置場所と再開に必要な情報のみ記す。

- **デプロイ先**: 上記の更新配信基盤と同じCloudflareアカウント。ユーザーが明示的に指定して選定
- **デプロイ済みURL**: `wss://para-mobile-relay.cloudflare8234.workers.dev`（`app/relay/`の既定`workers.dev`サブドメイン。カスタムドメインは未設定）。PC側の既定値`PARADIS_MOBILE_DEFAULT_RELAY_URL`（`src/vs/paradis/contrib/mobileRelay/common/paradisMobileRelay.ts`）をこの実URLに更新済み。**それ以前は`wss://para-mobile-relay.paradis.workers.dev`という、実際には一度もデプロイされたことのないプレースホルダーURLのままだった**（セルフホスト設定`paradis.mobile.relayUrl`で上書きしない限り、初回起動時のペアリングが到達不能で必ず失敗する状態だった）
- **account_id固定**: `app/relay/wrangler.jsonc`に`"account_id": "979dbe0328e903a34bb6291b06cca0da"`を追記（PARA-CODEコメント付き）。複数Cloudflareアカウントを持つユーザーの環境では、これが無いと`wrangler deploy`が「More than one account available」で失敗する
- デプロイVersion IDはCloudflare側で確認し、公開文書へ固定値を記録しない
- デプロイ確認: `curl -X POST https://para-mobile-relay.cloudflare8234.workers.dev/device/new/provision`が200 `{"ok":true,"deviceId":"..."}`を返すことを確認済み
- DeviceDO（SQLite-backed、`app/relay/wrangler.jsonc`の`migrations`で`new_sqlite_classes`指定）は初回デプロイ時に自動でマイグレーションされる。以降の再デプロイでスキーマ変更が必要な場合は`migrations`に新しい`tag`エントリを追加すること

## Codexペインapp-serverのWindows対応（loopback ws方式、2026-07-21）

macOS/Linuxの「ペインごとのCodex app-server」（`resources/paradis/bin/codex`のshランチャー + `unix://`ソケット）はWindowsでは使えないため、Windowsだけ別トランスポートで同等機能を実装した。判断根拠はすべてWindows 10.0.26100 / codex-cli 0.144.6 実機での事前調査に基づく。

- **`unix://`を使わない理由**: codex（Rust）自体はWindowsのAF_UNIXで待ち受けできるが、接続側のPara Code shared process（Node/libuv）がWindowsのAF_UNIX接続を未サポートのため、モバイル連携が成立しない。よってWindowsは `--listen ws://127.0.0.1:0`（動的ポート）一本
- **認証**: loopbackでも `--ws-auth capability-token` は有効（実測）。capability tokenには**ペイントークン（`PARA_CODE_TERMINAL_PANE_ID`）をそのまま流用**し、app-serverには `--ws-token-sha256 <hex>` でダイジェストだけを渡す（平文トークンはディスクへ書かない。ポートを記載するendpointファイルに秘密は含まれない）。接続は `Authorization: Bearer <ペイントークン>`。トークン無しはWebSocket upgrade時に401
- **構成**: ランチャーは `codex.cmd`（cmd用）/`codex.ps1`（PowerShell用）の薄い入口 + `paradisCodexPaneLauncher.cjs`（本体）。JSの実行体は**PATH上の`node.exe`を最優先**し、無い場合のみ `PARA_CODE_CODEX_LAUNCHER_NODE`（Para Code自身のexe）+`ELECTRON_RUN_AS_NODE=1` へフォールバックする。**Para Code exeを常用してはならない（2026-07-22実機で発覚）**: WindowsのElectronはGUIサブシステムのため、シェルが待たずに即復帰し、コンソールが継承されず対話TUIが `stdin is not a terminal` で死ぬ。npmでcodexを入れた環境にはnode.exeが必ずあるので、実運用ではフォールバックにほぼ落ちない。`.cmd`は`call`を使わずexeを直接呼ぶ（`call ... %*`は埋め込み引用符・`&`で引数が壊れることを実測済み）。実ポートは `userData\pcx\<token>.endpoint.json` に書き、shared process（`paradisCodexLiveClient`）がそれを読んで `ws://127.0.0.1:<port>` へBearer付きで直接続する
- **実Codexの解決**: PATHからランチャー自身のディレクトリを除外した上で、`codex.exe`直接 → npmインストールのvendored `codex.exe`を探索 → `node_modules/@openai/codex/bin/codex.js`を自Nodeで実行 → 拡張子なし`codex`（非Windowsのdev/test用）の順。**vendored exeをcodex.jsより優先するのは必須**: codex.jsは`process.arch`でネイティブパッケージを選ぶため、自Node（Para Code exe）とnpmのNodeのアーキが異なる環境（例: Windows ARM上でarm64 Para Code + x64 Node）では「Missing optional dependency @openai/codex-win32-arm64」で即死する（2026-07-21実機で発生）。x64のvendored exeはARM64 Windowsのエミュレーションでそのまま動く
- **黒窓の罠（2026-07-22実機で発覚）**: app-serverを`detached`/`windowsHide`でコンソール無し起動すると、app-serverがspawnする各MCPサーバー（コンソールアプリ）が自前のコンソールを確保して黒いウィンドウが乱立する。app-serverはターミナルのコンソールを共有して起動すること（タブを閉じたときの自動道連れという利点もある。TUIがraw modeの間はCtrl+CがコンソールイベントにならないためCtrl+C巻き添えは実用上問題にならない）
- **後始末**: TUI終了時にランチャーが所有するapp-serverをkill（Windowsは`taskkill /T /F`）。Windows Terminalのタブ閉じはNodeがSIGHUP（CTRL_CLOSE_EVENT）として受けるためそこでも掃除する。それでも残った孤児は「pidが死んでいるendpointファイルの起動時sweep」と「同一ペインの次回起動時のowner死亡検出→採用(adopt)→終了時掃除」で回収する
- **梱包**: `build/gulpfile.vscode.ts` で win32 のみ `.cmd`/`.ps1`/`.js` の3点を、非win32はshランチャーのみを同梱（PARA-PATCH済）

## モバイルアプリの配信手順（2026-08-06整備、アーカイブ前に必ず読む）

`app/mobile/ios/` は `app/.gitignore` で**まるごと無視されている**（Expo prebuild の成果物という扱いのため）。したがって **`app.json` の `version` を上げても、実際にアーカイブされるバイナリのバージョンは変わらない**。`npx expo prebuild` は禁止（手動追加の `NotifyExtension` と `ParaCodeWidgets` が消える）なので、`ios/` 側は手で合わせる。

アーカイブ前に上げる箇所（この5つが揃っていないと、拡張と本体の版が食い違って App Store Connect に弾かれる）:

1. `app/mobile/app.json` の `expo.version`
2. `app/mobile/src/changelog.ts` の `MOBILE_CHANGELOG` 先頭に同じ版の節を作る（`src/changelog.test.ts` が1と2の一致を検査する）
3. `app/mobile/ios/ParaCodeMobile.xcodeproj/project.pbxproj` の `MARKETING_VERSION`（6箇所）と `CURRENT_PROJECT_VERSION`（6箇所）
4. `app/mobile/ios/ParaCodeMobile/Info.plist` の `CFBundleShortVersionString` と `CFBundleVersion`（**値がハードコードされている**）
5. `app/mobile/ios/NotifyExtension/Info.plist` の同2つ（同じくハードコード）

`ios/ParaCodeWidgets/Info.plist` だけは `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` を参照しているので3を直せば追従する。**4と5だけ取り残しやすい**（2026-08-06 の 0.5.0 で実際に踏みかけた）。

アーカイブと検証:

```sh
cd app/mobile/ios
xcodebuild archive -workspace ParaCodeMobile.xcworkspace -scheme ParaCodeMobile \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/paracode-archive/ParaCodeMobile.xcarchive -allowProvisioningUpdates
```

生成後、本体と2つの拡張の版が揃っているか必ず確認する（揃っていないまま提出すると弾かれる）:

```sh
A=/tmp/paracode-archive/ParaCodeMobile.xcarchive/Products/Applications/ParaCodeMobile.app
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$A/Info.plist"
for p in "$A/PlugIns"/*.appex; do
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$p/Info.plist"
done
```

提出は Xcode の Organizer（Window → Organizer → Archives）から行う。

### Xcode 27（iOS 27 SDK）でビルドするときの注意（2026-09-26）

- **UIScene ライフサイクルが必須**: iOS 27 SDK でビルドしたアプリは、Scene に対応していないと起動直後に `EXC_BREAKPOINT`（SIGTRAP）で落ちる。クラッシュログの先頭は UIKit の `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`。`ios/` は gitignore 対象なので、次の2点を**このリポジトリ外で手当てしている**（別の Mac でビルドするときは同じ変更が要る）
  - `ios/ParaCodeMobile/Info.plist` に `UIApplicationSceneManifest`（`UIApplicationSupportsMultipleScenes` = false、`UISceneDelegateClassName` = `$(PRODUCT_MODULE_NAME).SceneDelegate`）
  - `ios/ParaCodeMobile/AppDelegate.swift` の `didFinishLaunching` では UIWindow を作らず `launchOptions` だけ保持し、同じファイルに置いた `SceneDelegate` の `scene(_:willConnectTo:options:)` で UIWindow を作って `factory.startReactNative` する。起動時の URL / ユーザーアクティビティ（`connectionOptions`）と `openURLContexts` / `continue userActivity` は AppDelegate の既存メソッドへ中継する（Expo の購読者と `RCTLinkingManager` の両方に届くように）
- **`RNSVG-RNSVGFilters` の deployment target**: react-native-svg のリソースバンドル target が 12.4 のままで、Xcode 27（下限 15.0）ではエラーになる。`xcodebuild ... IPHONEOS_DEPLOYMENT_TARGET=16.4` で本体と同じ値を渡して回避している
- **実機で開発ビルドを動かす手順**: Para Code 本体が 127.0.0.1:8081 を使っているので Metro は 8082 番にする。`RCT_METRO_PORT=8082 SENTRY_DISABLE_AUTO_UPLOAD=true xcodebuild -workspace ParaCodeMobile.xcworkspace -scheme ParaCodeMobile -configuration Debug -destination 'id=<UDID>' -allowProvisioningUpdates IPHONEOS_DEPLOYMENT_TARGET=16.4 build` → `xcrun devicectl device install app` → `pnpm exec expo start --port 8082`。`expo run:ios` は `ios/` を作り直しうるので使わない。開発ビルドでは `src/devProbe.tsx` が表示中の画面を `globalThis.__paraDev` とログに出すので、Metro の `/json/list` から CDP でつなげば画面とログを外から読める（CDP クライアントは `Origin: http://127.0.0.1:8082` を付けないと Metro に拒否される）

### ホーム画面・ロック画面のウィジェットと App Group（2026-09-27）

ホーム画面・ロック画面のウィジェット（案 A 要対応・B エージェント・C PC の状態・D スペース）を足した。`ios/` は gitignore 対象なので、**手で当てた設定をここに記録する**（`npx expo prebuild` 禁止は変わらない）。

| 対象 | 変更 |
|---|---|
| App Group | `group.ltd.paradis.paracode.mobile` を本体・ParaCodeWidgets・NotifyExtension の3つに追加。Developer サイトへの登録とプロビジョニングの更新は `xcodebuild ... -allowProvisioningUpdates` が自動で行った |
| `ios/ParaCodeMobile/ParaCodeMobile.entitlements` | `com.apple.security.application-groups` を追加 |
| `ios/NotifyExtension/NotifyExtension.entitlements` | 同上（追跡用コピーは `app/mobile/native/NotifyExtension/`） |
| `ios/ParaCodeWidgets/ParaCodeWidgets.entitlements` | 新規（それまで ParaCodeWidgets には entitlements ファイルが無かった）。追跡用コピーは `app/mobile/native/ParaCodeWidgets/` |
| `ios/ParaCodeMobile.xcodeproj/project.pbxproj` | ParaCodeWidgets の Debug / Release に `CODE_SIGN_ENTITLEMENTS = ParaCodeWidgets/ParaCodeWidgets.entitlements`。Swift 8本（`WidgetShared` / `WidgetStyle` / `WidgetIntents` / `WidgetTimeline` / `AttentionWidget` / `AgentsWidget` / `PcStatusWidget` / `SpaceWidget`）を ParaCodeWidgets の Sources へ。**`WidgetShared.swift` は NotifyExtension の Sources にも入れる**。ID は既存の手書きの並び（`FD…A7`〜`FD…AF`、`FD…B5`〜`FD…BC`、`FE…B3`）に続けた |

**`ios/` と `native/` の同期**: Swift・entitlements は `app/mobile/native/` を正として編集し、`ios/` へ写す（逆にしない）。2026-09-27 時点で `ios/ParaCodeWidgets/ParaCodeWidgetsBundle.swift` が native 版より古く（Live Activity の `widgetURL` と `privacySensitive` が無かった）、ビルドには古い方が使われていた。写し漏れの確認は次で行う（`README.md` を除いて差が無いこと。`NotifyExtension/Info.plist` の版番号の差は配信手順どおり ios 側だけを上げる運用なので残る）:

```sh
cd app/mobile
for f in native/ParaCodeWidgets/* native/NotifyExtension/*; do b=$(basename "$f"); [ "$b" = README.md ] && continue
  cmp -s "$f" "$(dirname "$f" | sed 's|native|ios|')/$b" || echo "DIFF $f"; done
```

設計の要点（詳細は `app/mobile/native/ParaCodeWidgets/README.md`）:

- ウィジェットは PC・リレーへ繋がない。アプリ（`src/widgets/widgetSync.ts`）と通知拡張が App Group に書いた要約（`widget-snapshot.json`）を読むだけ。アプリのネイティブ側の読み書きは `modules/para-live-activity/ios/ParaLiveActivityModule.swift` の `ParaWidgetFiles`（新しい Expo モジュールを足すと `pod install` が要るので、既存のモジュールに足した）
- 要約の形は JS（`src/widgets/snapshot.ts`）と Swift（`WidgetShared.swift`）の二重定義。版番号 `v` を上げたら両方直す
- 設定 → ウィジェット（`app/settings/widgets.tsx`）の値は `widget-settings.json`。ウィジェット側の設定（長押し →「ウィジェットを編集」）と重なる項目はウィジェット側が優先
- ホーム画面のウィジェットは iOS 17 以上だけ（配信の下限 16.4 では出ない。Live Activity は従来どおり）

### Live Activity を案 D「状態で切り替え」に作り直した（段階 1、2026-09-27）

見た目と動きの正解は `paracode-live-activity-mock.html` の案 D（リポジトリ外のモック）。3 段階のうち**段階 1（アプリだけで直せる部分）**を入れた。更新はいまもアプリの JS が動いている間だけ（`pushType: nil`）。

| 場所 | 役割 |
|---|---|
| `app/mobile/src/liveActivityState.ts`（テスト `liveActivityState.test.ts`） | 中身の組み立て・状態の判定・「終わったもの」の記録・出す／終える判断・4KB に収める削り方。純関数 |
| `app/mobile/src/liveActivitySync.ts` | ストアの購読（0.5 秒の間引き）、前面の間 1 分ごとの送り直し、背面へ移るときの送り直し、オフラインの猶予（10 秒）、ネイティブ呼び出しの直列化 |
| `app/mobile/modules/para-live-activity/`（`index.ts`・`ios/ParaLiveActivityModule.swift`） | `upsert`（同じ PC のものを更新、ほかは終える）・`finish`（完了の要約を載せて終え、`dismissalPolicy: .after` で残す）・`end(includeFinished)` |
| `app/mobile/native/ParaCodeWidgets/ParaCodeLiveActivity.swift`（新規） | compact・minimal・expanded・ロック画面の描画と、押したときのリンク。`ParaCodeWidgetsBundle.swift` からは外した |
| `app/mobile/native/ParaCodeWidgets/ParaCodeActivityAttributes.swift` | 静的属性（`pcId`・`pcName`）と ContentState。**アプリ側の同名コピー・JS の型と3か所で一致させる**。欠けた項目は既定値で読む（古い版の Live Activity と段階 2 の項目追加に備える） |

動きの要点:

- 状態は `attention`（要対応あり）・`running`（実行中だけ）・`done`（全部完了）・`offline`（PC に繋がらない）。オフラインは直前の形のまま灰色にし「◯時点」を出す。出していないときにオフラインや完了のためだけに始めることはしない
- 全部終わったら、この Live Activity の間に終わった（未確認の）ものを要約に載せて終え、ロック画面に最長 15 分残す。その間に全部確認されたら消す。終わったものが無い（止めた・閉じた）なら即座に消す。**終えると Dynamic Island からは消える**（Apple の仕様）ので、完了の compact・minimal はいまは出ない（段階 2 で PC が done を送れば出る）
- `staleDate` は最後の更新の 2 分後。前面の間は 1 分ごとに送り直して先へ送り、背面へ移るときに時刻だけ新しくして送る。アプリが止まると 2 分後に灰色の「◯時点」になる
- 押すと表示していた 1 件のセッションを直接開く（`paracode-mobile:///widget/session?pc=…&space=…&terminal=…`。書き換えはウィジェットと同じ `src/features/links/widgetLinks.ts`）。完了は PC の画面、オフラインはホーム。PC が分からない古い Live Activity の `paracode-mobile:///agent` と `/widget/attention` は従来どおり中継の画面（`/open-session`、最大 8 秒待つ）
- 色はアプリのトークン（要対応 `#ef4444`・実行中 `#eab308`・完了 `#10b981`・ツール名 `#3b82f6`）。キーラインも状態の色で、旧シアン `#09AFD9` とロゴはやめた。「設定 → 色」の主役の色はモックの案 D で使っていないので使わない

段階 2・3 で足す場所:

- 段階 2（プッシュ）: `ParaLiveActivityModule.swift` の `upsert` で `pushType: .token` にし、`activity.pushTokenUpdates`（と iOS 17.2 以降の `Activity.pushToStartTokenUpdates`）を JS へイベントで渡して PC に登録する。PC が `liveActivityState.ts` と同じ形の content-state を作り、リレー（`app/relay/src/apns.ts`）が `apns-push-type: liveactivity`・トピック `<bundleID>.push-type.liveactivity` で送る。要対応の発生と全部完了だけ priority 10 とアラート、ほかは 5。`stale-date` は同じ 2 分。content-state は平文で Widget に届く（NSE を通らない）ので、名前・コマンドは暗号化した項目を足すか、アプリを開いたときだけ出すかを決める
- 段階 3（許可ボタン）: `ParaCodeLiveActivity.swift` の `RequestBlock` のコマンドの右に `Button(intent:)` を 1 つ置く（expanded とロック画面だけ）。ContentState の `AttentionItem` に `interactionId`・`epoch`・`dangerous`（`dangerousCommand.ts` が拾うものはボタンを出さない）を足す
- 通知との重複: いまはリレーが要対応を通常の通知（`apns-push-type: alert`）でも送るので、要対応は通知と Live Activity の両方に出る。段階 2 で Live Activity が出ている間は要対応の通常の通知を止める（Live Activity のアラートに寄せる）

## モバイルアプリのiPad対応（2026-08-05）

`app/mobile` はiPhone専用（portrait固定・`supportsTablet: false`）だったが、iPadを2カラムで使えるようにした。設計の要点:

- **判定は幅だけ**: `src/sizeClass.ts` の `sizeClassFor(width, tablet)` が `compact` / `regular` を返す。しきい値700pt。iPadの全画面（短辺744pt〜）は必ず`regular`、Split Viewで狭くなると`compact`＝iPhoneと同じ1カラムへ自然に落ちる。純関数なので実機なしでテストできる（`src/sizeClass.test.ts`）
- **ナビゲーションツリーには手を入れていない**: `src/ipad/ipadShell.tsx` が `app/_layout.tsx` の `<Stack>` 全体を包み、左にサイドバー・右にスタックを並べるだけ。ディープリンク・通知タップ・戻る操作といった既存の動線がそのまま生きる
- **サイドバーの中身はiPhone版のドロワーそのもの**: `WsDrawerContent`（`src/components/wsDrawer.tsx`）を再利用し、`navigation` スロットに下部タブ相当のLiquid Glassセグメント（`src/ipad/ipadSidebar.tsx`）を差すだけ。ワークスペース一覧・メモ・PCステータスの実装を二重に持たない
- **タブは幅で実装を切り替える**: `regular` では `expo-router/js-tabs` の `Tabs` をタブバー非表示で使い、`compact` では従来どおり `NativeTabs`（iOS 26のLiquid Glassタブバー）。iPadOSではNativeTabsのタブバーの見せ方をOSが決めてしまい、こちらのサイドバーと二重になるため

**ハマったところ（同種の実装で必ず踏むので記録）**:

- **条件分岐でツリーの形を変えると、配下が丸ごと再マウントされる**。`IpadShell` / `WsDrawerLayout` の両方で当初やってしまった。`children`（＝ナビゲーションスタック全体）の階層が変わるとReactが別要素とみなし、ターミナルのWebView・ブラウザのミラー接続・遷移履歴・入力途中の文字が全部消える。**幅0での出し分け**（IpadShell）や **`drawerLockMode` での無効化**（WsDrawerLayout）にして、ツリーの形は常に同じに保つこと。発火するのは幅変化だけでなく、`ready` / `paired` の変化でも通る
- **スタック画面から `router.navigate('/terminal')` を呼ぶと `(tabs)` がもう1枚積まれる**。React NavigationのStackRouterは`pop`指定の無いNAVIGATEで既存routeを探しに行かない。`router.canDismiss()` が真なら `router.dismissTo()` を使う（`src/ipad/ipadSidebar.tsx` の `selectTab`）。**この不具合はiPhone版の `agentInfoSheet.tsx` にも同じ形で残っている**
- **「選択中のタブなら何もしない」は書いてはいけない**。エージェント詳細やブラウザを開いている間もホームタブを選択状態で見せているため、素朴に早期returnすると押しても戻れない死んだボタンになる
- **iPadのフローティングキーボードは画面下端に接していない**。`window.height - keyboard.screenY` をそのまま被覆量に使うとボトムシートが画面外へ飛ぶ。`src/keyboardCoverage.ts` に判定を切り出した。**ここで「幅が画面いっぱいでないものを除外する」判定を足してはいけない**——日本語の片手用キーボード（幅は狭いが下端に接していて実際に覆う）を取りこぼし、入力欄がキーボードに隠れる。接地しているかだけで判定する。あわせて、iOSの「クロスフェードトランジションを優先」が有効だと位置が実座標ではなく `screenY: 0` で報告される既知の挙動も特別扱いしている（RN本体の `KeyboardAvoidingView` も同じ分岐を持つ）
- **UIKitは提示後の `modalPresentationStyle` 変更を無視する**。ファイル/差分ビューアの `pageSheet` / `fullScreen` は開いた瞬間の値で凍結し、ヘッダーの上余白も同じ値から決めること。片方だけ幅に追従させると、開いたまま幅が変わったときにヘッダーがステータスバーへ潜る
- **`DrawerLockMode.LOCKED_CLOSED` はスワイプしか止めない**。RNGHの `openDrawer()` は lock mode を見ずにアニメーションを走らせるので、`useWsDrawer().open()` 側でも幅を見て塞ぐ必要がある（塞がないと中身が null の見えないパネルが開く）
- **`presentationStyle="fullScreen"` のModalはサイドバーごと画面を奪う**。ファイル/差分ビューアは`regular`では`pageSheet`にする
- `@expo/config-plugins` の `withOrientation` は `ios.infoPlist.UISupportedInterfaceOrientations` を明示すると上書きをスキップする。これを使ってiPhoneはportrait固定のまま、iPadだけ4方向を許可している（`app.json`。上の「コメントを書けないファイルへの変更一覧」も参照）

### `expo prebuild` は使えない（2026-08-05、iPad対応時に実地で判明）

**`app/mobile` では `npx expo prebuild` を実行してはいけない。** iPad対応で `app.json` に `ios.supportsTablet: true` を入れた際、それを反映しようと `--clean` **無し**で実行したところ、次が起きた:

- `- Clearing ios` → `✔ Cleared ios code` と表示され、**`--clean` を付けていないのに `ios/` が丸ごと作り直された**（SDK 57の挙動）
- Xcodeプロジェクト名が `ParaCodeMobile` → `ParaCode` に変わった（`expo.name` から導出されるため）
- **手動で追加した `NotifyExtension`（APNs用NSE）と `ParaCodeWidgets`（Live Activity）のターゲットが消えた**。これらはconfig pluginではなくXcode上で足したもので、prebuildは再現しない

`app/mobile/ios/` は `app/.gitignore` で無視されているため**gitで戻せない**。復旧は事前に取っておいたコピーからのrsyncで行った。

したがって**ネイティブ設定の変更は `ios/` へ直接当てる**。`app.json` の `ios.*` は「そういう意図である」ことを示すドキュメントとしてのみ機能し、成果物には自動で反映されない。実行するなら必ず `ios/`（Pods除く。1MB弱）を先に退避すること。

iPad対応で実際に手で当てた設定:

| 対象 | 変更 |
|---|---|
| `ios/ParaCodeMobile.xcodeproj/project.pbxproj` | `TARGETED_DEVICE_FAMILY = 1;` → `= "1,2";` を**6箇所**（本体・ParaCodeWidgets・NotifyExtension × Debug/Release）。拡張だけ1のままだと本体がiPad対応でも埋め込み検証で落ちる |
| `ios/ParaCodeMobile/Info.plist` | `UISupportedInterfaceOrientations~ipad` に4方向を追加（iPhone用の `UISupportedInterfaceOrientations` はportrait 2種のまま） |

**バージョンは全ターゲットで一致必須**（ずれるとApp Store Connectの検証で弾かれる）。今回0.3.0へ上げた際、本体だけ直すと NotifyExtension が 0.1.0 のまま残っていた。揃える箇所は `project.pbxproj` の `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 各6箇所と、`ParaCodeMobile/Info.plist` ・ `NotifyExtension/Info.plist` の `CFBundleShortVersionString` / `CFBundleVersion`（`ParaCodeWidgets/Info.plist` は `$(MARKETING_VERSION)` 参照なので自動追従）。

**既知の制限（許容して出す）**: 幅700ptをまたぐリサイズ（Split Viewへの出入り）では、`(tabs)/_layout.tsx` が `NativeTabs` と `Tabs` のコンポーネント型そのものを入れ替えるため、タブ配下4画面が作り直される（ターミナルのWebViewの表示内容が消えて再同期がかかる）。選択中のタブとルート側スタック（`/agent`・`/browser` 等）は保たれる。iPhoneのiOS 26ネイティブタブバーを捨てないかぎり避けられないトレードオフなので、リサイズという明示操作に限って許容している。

**未対応（v2以降）**: ブラウザ/ターミナルを会話の横に並べるフローティングパネル（`app/mobile/mock/ipad.html` の案Bにあるドラッグ幅変更パネル）、Filesタブの2ペイン化、サイドバーの折りたたみ。現状は右カラム全体を覆うpush遷移。

### 2列を案 A「Orca 忠実の2列」に作り直した（2026-09-27）

上の `IpadShell`（全画面の左にワークスペースのサイドバー）は、作り直し（PC → スペース → セッションの押し進む階層）の後は使われていなかった。これを置き換え、Orca モバイルの iPad と同じ master-detail にした。見た目と動きの正解はリポジトリ外のモック `paracode-ipad/ipad-a.html`。**上の「タブは幅で実装を切り替える」「既知の制限」は旧実装の話で、いまの `app/` には当てはまらない**（`(tabs)` は `legacy-screens/` に退避済み）。

| 場所 | 役割 |
|---|---|
| `app/mobile/app/pc/[pcId]/_layout.tsx` | 2列の器。左の列に PC の画面（`src/features/pc/pcScreen.tsx`）、右の列（詳細の列）にセッション・ソース管理などの Stack。1列では左の列を幅 0 にし、詳細の列の根（`index.tsx`）に PC の画面を出す |
| `app/mobile/app/pc/[pcId]/index.tsx` | 詳細の列の根。2列では「エージェントが開かれていません」。列を根まで戻す手段と「何か開いているか」を `src/ipad/detailColumn.ts` に置く |
| `app/mobile/src/ipad/ipadLayout.ts`（テストあり） | 左の列 280〜560pt（既定 340）、ドックは詳細の列 ≥ 640pt、ドックの幅 280〜560pt で本体に 360pt 残す |
| `app/mobile/src/ipad/ipadLayoutStore.ts` | 左の列とドックの幅（ドラッグを離したときに Keychain へ保存）。左の列を隠す状態は既存の `sidebarCollapsed`（ブラウザのタブの「広く見る」と共有） |
| `app/mobile/src/ipad/sessionDock.tsx` ほか | セッションの右のドック。中身はルートと同じ `SourceControlPanel` / `FileTreePanel` / `SpaceNotePanel`（`dock` を渡すと見出しが X になり、差分・ファイルへ進むときはドックを閉じて押し進める） |
| `app/mobile/src/ipad/shortcuts.ts`（テストあり）・`shortcutRegistry.ts`・`shortcutHost.tsx` | 外付けキーボードのショートカットの一覧と操作の対応、画面ごとの受け口、ネイティブへの受け渡し |
| `app/mobile/modules/para-ipad-input/` | 新しいローカルの Expo モジュール。UIKeyCommand（⌘ 長押しの一覧に出す名前つき）と、ポインタのホバー（UIPointerInteraction の highlight / hover）の入れ物 `ParaPointerHover` |

**`pod install` が要る**: 新しいローカルの Expo モジュール（`modules/para-ipad-input`）を足したので、このブランチを取り込んだら `cd app/mobile/ios && pod install` を1回実行する（`ios/` は gitignore 対象なので、各自の Mac で）。`Info.plist`・entitlements・`project.pbxproj` の手作業は無い（pod install が Pods のプロジェクトを更新するだけ）。`native/` へ写すものも無い。

設計で決めたこと（同種の実装で迷うところ）:

- **1列 ⇄ 2列 で木の形を変えない**: 詳細の列の Stack は常に同じ位置にあり、左の列は幅だけで出し入れする。左の列の中身（PC の画面）は2列のときだけ描くが、これは Stack の兄弟なので Stack は作り直されない。詳細の列の根だけは `regular ? 置き場 : PC の画面` と中身を入れ替える（一覧の状態はそこで作り直されるが、セッションは残る）
- **左の列の行を押すと、詳細の列は積み増さず入れ替える**: `openSession`（と行の操作シートのソース管理・ファイル・メモ）が `resetDetailColumnFor(pcId)` で詳細の列を根まで戻してから積む。2列のときだけセッションの画面の `animation` を `none` にする（Orca と同じく、押し進む動きを付けない）
- **詳細の列の様子（`detailColumn.ts`）は器ごとに置いた順で持つ**: ルートの Stack に PC の画面が2枚積まれることがある（通知の一覧を経由して別の PC のセッションへ入る、など）。1枠だけで持つと、上の画面が外れたときの片付けで枠が空になり、下の画面で左の列を隠すボタン・⌘\ が消えた。器（`_layout.tsx`）が `useId()` の印を `DetailColumnKeyContext` で根・セッションへ渡し、各自は自分の印の分だけを読む。入れ替え（`resetDetailColumnFor`）は最後に置いた＝前面の列にだけ効く
- **左の列の「戻る」は `router.back()` を使わない**: `router.back()` は前面の（一番深い）Stack に効くので、2列で右にセッションが開いていると、PC の画面を閉じる代わりにセッションを閉じてしまう。`useNavigation().goBack()` で、自分のいる Stack から閉じる
- **Esc は閉じるもの（シート・ドック）があるときだけ取る**: ショートカットは「いまの画面で受け口があるもの」だけをネイティブへ渡す（⌘ 長押しの一覧にも、その画面で効くものだけが出る）。なお外付けキーボードの Esc をターミナルへ送る経路は元から無い
- **入力欄より先に効かせる（`wantsPriorityOverSystemBehavior`）のは、入力欄の標準の動きとぶつかるものだけ**（`shortcuts.ts` の `overridesTextInput`。⌘[ ⌘]・⌘Return・⌥⌘↑↓）。全部に付けると、日本語の変換中の Esc（変換の取り消し）までシート・ドックを閉じる側が奪う
- **UIKeyCommand はルートの UIViewController に付け、何もフォーカスを持っていないときだけ見えない起点をファーストレスポンダにする**（`ParaKeyCommandAnchor`）。入力欄や WebView がフォーカスを持っているときは、そこからチェーンをたどってルートの画面まで届く
- **ターミナルの文字の既定は iPad だけ 12pt**（`defaultTerminalFontSize`）。保存済みの設定に文字サイズがあればそちらを使う
- **ポインタの効果（UIPointerInteraction）の置き場所を React の管理するビューにしない**: 効果が出ている間（押した後に消えていく約0.5秒も含む）、UIKit は台やポータルのビューを `UITargetedPreview` の `target.container` へ `insertSubview(_:at:)` で差し込む。置き場所を指定しないと包んだビューの親になり、React が番号で子を足し外しする階層に余計なビューが挟まる。その間にドックを開いてつまみを足すと1つ手前に入り、閉じるときに `Attempt to unmount a view which has a different index` で落ちた（2026-09-27、ヘッダーのソース管理ボタンを2回押して再現）。`ParaPointerHoverView` は React の子を内側の `contentHost` に入れ、効果の置き場所を自分自身にしている。ネイティブのビューで同じ効果（`UIContextMenuInteraction` のプレビューなども同類）を足すときは同じ形にする
- **ネイティブの入れ物で包むと、中の Pressable の hitSlop が効かなくなる**: RN の `betterHitTest` は子が枠からはみ出していないと枠の外の点を捨て、素の UIView も自分の枠で切る。`ParaPointerHover` で包んだ見出しのボタンが、iPad でだけ 44pt から見た目の大きさ（24〜36pt）に縮んでいた。`ParaPointerHoverView` と中身の入れ物（`ParaPointerHoverContentHost`）の `hitTest(_:with:)` で、枠の外の点も React の子に聞き直している。lldb でアプリにアタッチし、Swift の式で `view.window!.hitTest(view.convert(点, to: window), with: nil)` を呼ぶと、画面を触らずに確かめられる
- **PC の外からセッションへ直接入るときは `withAnchor: true` で押す**（通知のタップ・ホームの「再開」・`/open-session`・起動のシート・通知の一覧）。付けないと PC の中の Stack が `[session]` だけになり、詳細の列の根（`index.tsx`）が無いので、2列の入れ替え・左の列を隠すボタンが効かず、1列では戻るとホームまで飛ぶ
- **PC の器は `app/pc/_layout.tsx` の Stack に積む（画面名を `[pcId]` にする）**: Expo Router は遷移先の置き場所を「今の画面と遷移先の画面名がどの階層で食い違うか」で決め、動的な引数を比べるのは画面名が `[pcId]` のように括弧だけのときに限る（`findDivergentState` / `matchDynamicName`）。この入れ物が無いとルートの Stack での画面名が `pc/[pcId]` になり、PC A のセッションの上から PC B のセッションを開くと B のセッションが A の器に積まれた（左の列は A の一覧のまま、1列で戻ると A の一覧へ）。main はルートの Stack が平らだったので起きていなかった。あわせて次が要る
  - **`[pcId]` に `getId` / `dangerouslySingular` を付けない**。付けると、下に積んである PC へ push したときにその器を同じ key のまま最前面へ並べ替え（StackClient に「THIS ACTION IS DANGEROUS」と注記あり）、実際に並べ替えの後で戻ると JS の状態は進むのにネイティブの画面が変わらなくなった。付けない代わりに `navigate` で PC の中へ入らない（前面の画面と画面名が同じなら、ルートを使い回して引数だけ差し替えるため、A の器が B の引数を持つ）。アプリの中は push / replace だけを使い、起動中に OS から届く `/pc/…` のリンクは `+native-intent` が中継の画面（`/open-session?to=…`）経由に書き換える（`src/features/links/runningPcLink.ts`）。起動時のリンクはパスから状態を組み立てるので書き換えない
  - **PC の外から PC の中を開く入口（OS の通知のタップ・通知の一覧・中継の画面）は `openPcRoute`（`src/features/pc/pcOpenPlan.ts` の純関数で決める）を通す**。規則: 器の Stack に同じ PC の器は1枚だけ。開きたい PC の器が器の Stack にあれば、その上の器を閉じて（pop）そこへ戻り、その中で開く。行き先が PC の画面（器の根）なら積まずに器の中を根まで戻す（根を2枚にすると、上の根が同じ印で詳細の列の様子を上書きし、閉じるときに消して2列が壊れた。`index.tsx` も列の一番下の根だけが attach する）。いまその器に出ている画面と同じ（パスと `tab` が一致）なら開き直さず、`latest` があればその画面へ SET_PARAMS で渡す。2列では器の中（詳細の列）を根まで戻してから開く（行を押したときと同じ入れ替え）。無ければ上に新しい器を積む。器の Stack が前面（通知の一覧・中継の画面ならそのすぐ下）に無いときだけ、ルートに新しい器の Stack を積む。戻る順は「開いた画面 → その器で下にあった画面 → その器の下の器」。これが無いと、起動中に Live Activity・ウィジェットを押すたび、また別の PC の通知を交互に押すたびに器が積み増された。コンテナの状態は Expo Router の `__root` 1枚に包まれているので、ルートの Stack はその中を見る
  - 詳細の列の前面は、器が前面に来たときに `bringToFront` で決め直す（器が作り直されずに前面へ戻っても、根の attach は走り直さないため）
  - `withAnchor` は全階層に `initial: false` を付けるので、器を積む Stack にも先頭の画面（`[pcId]`）が引数なしで1枚敷かれる。器（`[pcId]/_layout.tsx`）は `pcId` が無ければ何も描かず、`src/features/pc/pcStackAnchor.ts` で自分を Stack から取り除く
- **`withAnchor` で敷かれた根のルートの引数には `pcId` が入らない**。PC の画面と根は `usePcRouteId()`（`src/features/pc/pcRouteContext.ts`。器が自分の引数から渡す）で PC を引く

シミュレータでの確認の手順と落とし穴（2026-09-27）:

- Xcode 27 には Simulator.app が無く、DeviceHub が代わり。iOS 27 のシミュレータのランタイムが入っていない Mac では `xcodebuild -downloadPlatform iOS` が「Preparing to download...」で止まったままになった（MobileAsset のダウンロードが進まない）。`/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/*.xml` の `__BaseURL` + `__RelativePath` を curl で落とし、`aea decrypt -key-value base64:<ArchiveDecryptionKey>` → 中の pbzx を展開 → `aa extract` → `xcrun simctl runtime add <dmg>` で入れられた
- 向きは開発ビルドの `__paraDev.orientation(true|false)`（`requestGeometryUpdate`）で変えられるが、アプリを起動し直した後は「The current windowing mode does not allow for programmatic changes to interface orientation」で断られることがある。そのときは縦の幅を `__paraDev.setWidth(834)` で代用した
- 外付けキーボードのキーをシミュレータへ送る手段が無かった（DeviceHub の操作は画面の自動操作が要る）ので、開発ビルドの `__paraDev.fireKey(id)` で「登録した UIKeyCommand をレスポンダチェーン経由で送る」ことで確かめた。`__paraDev.keyCommands()` で登録されているものと、いまのファーストレスポンダが読める

開発用（`__DEV__` のときだけ）: ペアリングの無いシミュレータでは、Metro の CDP から `globalThis.__paraDev.demo()` で見本のデータ（`src/dev/demoData.ts`）を入れ、`__paraDev.setWidth(600)` でアプリの幅を狭めて 1列を確かめる（`src/dev/devWidthFrame.tsx`。`setWidth(undefined)` で戻す）。

### ウィンドウアプリの左上の操作ボタンを見出しが避ける（2026-09-27）

iPadOS 26 以降のウィンドウアプリでは、左上に閉じる・最小化・並べるの3点（ウィンドウ操作ボタン）が出る。OS 標準の `UINavigationBar` は自動で避けるが、このアプリの見出しは React Native で描いた自前の帯（全 Stack が `headerShown: false`）なので、何もしないと戻るボタンとタイトルに重なった。

- 測るのはネイティブ（`modules/para-ipad-input` の `ParaWindowControlsObserver`）。ルートの view の `edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))` から素の `safeAreaInsets` を引いた先頭の幅を、JS へ `onWindowControlsInset` で送る。Apple の推奨（WWDC25「Make your UIKit app more flexible」）は `layoutGuide(for: .margins(cornerAdaptation: .horizontal))` で「上端の帯はボタンの右端から始める」こと。見出しは自分の余白を持っているので、ここでは margins ではなく safeArea の領域を使う
- 変化の合図は、ルートの view に敷いた見えない `ParaWindowControlsProbe` の `layoutSubviews` / `safeAreaInsetsDidChange`。大きさが変わらずに領域だけ動く場合に備えて、中の view を `layoutGuide(for:)` に貼り付けてある
- JS は `useWindowControlsInset()`（`src/ipad/windowControls.tsx`）1つ。`ScreenHeader`（`safeTop` のときだけ）・`PcHeader` の上段・`HomeTopBar` が先頭の余白に足す。2列の詳細の列は `app/pc/[pcId]/_layout.tsx` が `WindowLeadingEdge value={!showSidebar}` で包み、左の列が出ている間は 0 になる。ドックの見出しは `safeTop={false}` なので足さない

落とし穴:

- **corner adaptation は操作ボタンだけでなく、画面やウィンドウの角の丸みにも値を返す。** 実測（Xcode 27 / iOS 27 シミュレータ）では、iPhone 17 Pro の縦向きで素のセーフエリアが左右 0 なのに、この領域は左右とも 18 だった。iPad のウィンドウアプリ（幅 469）では左 66・右 9.5。差をそのまま使うと iPhone や全画面の iPad の見出しまでずれるので、先頭の側が末尾の側より大きいときだけボタンがあるとみなしている。念のため iPad 以外は常に 0
- `.margins(cornerAdaptation:)` / `.safeArea(cornerAdaptation:)` は Swift だけの書き方（ObjC では `UIViewLayoutRegion`）。iOS 26 以降なので `#available(iOS 26.0, *)` で囲む
- 開発ビルドでは `__paraDev.windowControls()` で各領域の生の値が読める（1回目の呼び出しで主スレッドに測らせ、2回目で読む）

## 常駐ターミナル（pty デーモン）で踏みうる罠（2026-08-20）

設定 `paradis.terminal.daemon.enabled` を有効にすると、ターミナルのプロセスは Para Code の外の常駐プロセスが持つ。閉じても残せるようになった代わりに、**ローカルの端末が最大24時間 detach 状態で置かれる**という、今まで無かった状態が生まれる。そこに upstream の既存挙動がぶつかる箇所がある。

### 「Terminal: Attach to Session」は、残した端末を巻き添えで殺す

`terminalActions.ts` の Attach to Session は `backend.reduceConnectionGraceTime()` を呼ぶ。これは `ptyService.ts` の `reduceConnectionGraceTime()` で、**猶予待ちの pty を全部**短い猶予（`shortGraceTime`、既定6秒）へ移す。アタッチした1本以外は誰も拾わないので、**別のスペースで残しておいた端末が6秒後に全滅する**。

upstream の挙動そのもので、接続先（SSH）側も同じ露出を持っている。ただしあちらは `_reconnectToRemoteTerminals()` をウィンドウを開くたびに呼ぶので「開いたら拾う」で成立している。ローカルは `_reconnectToLocalTerminals()` がこのコマンド経路では呼ばれないため、事故るのはこのコマンドだけ。

**「残したはずの端末が消えた」という報告が来たら、まずここを疑うこと。** これを知らないと、常駐側の猶予やアイドル終了を延々と調べることになる（そちらは無実）。

### Windows で常駐を無効にしている理由（2026-08-20 調査済み。再調査不要）

`paradisPtyHostStarterFactory.ts` は Windows で常駐を使わず、アプリ内の pty host に倒している。理由は名前付きパイプの偽装で、**こちら側では塞げない**ことを確認済み。

- libuv `src/win/pipe.c` の `open_named_pipe()` にある `CreateFileW` は3箇所とも `dwFlagsAndAttributes` が `FILE_FLAG_OVERLAPPED` のみ。ファイル全体に `SECURITY_SQOS_PRESENT` / `SECURITY_IDENTIFICATION` が存在しない。接続の両パス（即時、`ERROR_PIPE_BUSY` 後のリトライ）ともここを通る
- Microsoft の "Impersonating a Named Pipe Client" に「By default, a server impersonates at the SecurityImpersonation impersonation level」とあり、未指定は危険な側の既定
- ただし `ImpersonateNamedPipeClient` の Remarks より、実際に通るのは偽サーバーが `SeImpersonatePrivilege` を持つ場合（サービスアカウント）か同一ユーザーの場合のみ。**一般ユーザーの別アカウントでは成立しない**

盗聴（打鍵と環境変数を偽物へ渡す）の方は名乗り合い（`paradisPtyDaemonAuth`）で塞いである。残るのは接続時点で成立する偽装だけ。

**開けるときの筋道**: Node の `net` から SQOS フラグを渡す口は無いので、パイプにこだわる限り解決しない。Windows だけループバック TCP に切り替えるのが現実的で、TCP には偽装の仕組みが無いため問題が消える。認証は既存の名乗り合いをそのまま使い、ポート番号は台帳に書く。`ipc.net` の `serve`/`connect` はポートにも対応している。

### `terminal.integrated.enablePersistentSessions` をセッション途中で off にした場合

既に開いている端末は生成時の値で `shouldPersist=true` のままなので「残す」と答えられるが、次回起動時は `_reconnectToLocalTerminals()` が走らないため、24時間の孤児になる。設定を触ってから再起動しない、という狭い条件。塞ぐなら常駐側の `prepare` でこの設定を見て `end` へ倒す（接続先側にも同じ穴がある）。

### 常駐の内部用の環境変数はシェルへ渡さない（2026-09-27）

製品版のターミナルのシェルに `PARADIS_PTY_HOST_STATE_DIR=~/Library/Application Support/Para Code` が入っており、そこから開発版を起動すると、開発版のターミナルが製品版の常駐に作られていた。main が `process.env` に入れっぱなしにした値を pty ホストが継ぎ、`PtyService.getEnvironment()`（= `{ ...process.env }`）がターミナルの基底環境として renderer へ返していたのが経路。SSH 先ではサーバーの `process.env` から `buildUserEnvironment` 経由で同じように漏れる。

- すべてのターミナルが通る `paradisCreateTerminalProcess`（`ptyDaemon/node/paradisTerminalProcessFactory.ts`）で、`paradisPtyEnvHygiene.ts` の一覧（`PARADIS_PTY_HOST_STATE_DIR` と `PARADIS_PTY_DAEMON_SOCKET` / `_LEDGER` / `_BUILD_ID` / `_BUILD_KEY`）をシェルの環境から落とす。ローカル・SSH 先・常駐経由のどれもここを通る
- ローカルでは、main の `process.env` へ入れるのをやめ、pty ホストを起こす `start()` の間だけ足す（`ParadisScopedEnvPtyHostStarter`）。拡張ホストなど main が起こす他のプロセスへも漏れなくなった
- 【未対応】SSH 先の REH サーバーは pty ホストを遅延 fork するため同じ手が使えず、サーバーの `process.env` に残る。シェルへは上の除去で届かないが、接続先の拡張ホストが起こす子プロセスには残る
- ペイントークン（`PARA_CODE_TERMINAL_PANE_ID`）、`PARA_CODE_MCP_PORT_FILE`、`PARA_CODE_VOICE_TOKEN`、`PARA_CODE_CODEX_*`、`PARACODE_PROJECT_ROOT_PATH` はシェルの中のエージェントやスクリプトが読むために入れているので残す。`PARADIS_MIRROR_CAPTURE_VIEW` と `PARADIS_MOBILE_TRAFFIC_DIAGNOSTICS` は開発者が手で設定する診断用で、fork は設定しない

## エディタエリアのターミナル操作の仕掛け（2026-09-27、フェーズ1 担当B）

TM3 / TM4 / TM7 / TM10 / TM21 はすべて `src/vs/paradis/contrib/` の新規ファイルで完結し、upstream への変更は `xtermTerminal.ts` の `getFont()` 1か所（+ import 1行）だけ。upstream 取り込み時に壊れやすいのは次の3点で、どれも upstream 側のファイルに印が無いので、ここで追う。

- **コマンドを `DEFAULT_COMMANDS_TO_SKIP_SHELL` へ起動時に追記している**（`terminalFontZoom` と `terminalReopen` のモジュール先頭）。`terminal.ts` は変更していない。upstream がこの配列を `readonly` にしたり、`TerminalConfigurationService` がモジュール読み込み時にスキップ集合を固めるように変わったら、ターミナルにフォーカスがあるときの `⌘=` / `⌘⇧T` がシェルへ流れる（Windows/Linux で顕著。macOS は ⌘ キーが xterm を素通りするので気づきにくい）。
- **右クリックしたリンクは xterm の非公開 API `raw._core.linkifier.currentLink` から読む**（`terminalLinkMenu`）。xterm を上げたら、実行時に読まれる `node_modules/@xterm/xterm/lib/xterm.js`（`package.json` の `main`。`lib/xterm.mjs` ではない）に `get linkifier(){` と `get currentLink(){` が残っているかを `grep` で確かめる。消えていてもメニュー項目が出なくなるだけで、例外にはならない。メニューは右クリックの mousedown と contextmenu の両方で取り直す（Shift+右クリックは upstream の `handleMouseEvent` が mousedown の直後に開くため）。
- **`⌘⇧T` は fork のコマンドが weight +1 で先に受け、ターミナル以外なら `workbench.action.reopenClosedEditor` へそのまま渡す**（`terminalReopen`）。upstream の `TerminalEditorInput.canReopen()` が `true` になったら（= upstream がターミナルの開き直しを始めたら）、二重に開くのでこちらを畳む。

ターミナルごとの文字サイズ（TM21）は、shell integration の nonce をキーに WORKSPACE storage（`paradis.terminal.fontZoom`、最大 200 件）へ差分を保存し、リロード後の再接続で戻す。nonce はスペースの park/revive と同じ同一性（`paradisTerminalEditorPark.ts` 参照）。キーの割り当ては upstream の `workbench.action.zoomIn` / `zoomOut` / `zoomReset` と同じにしてある（リセットはテンキーの `⌘0` だけ。数字キーの `⌘0` は upstream の `workbench.action.focusSideBar`）。

既知の制約（どれも直していない）:

- **別のウィンドウへ移したターミナルは文字サイズが元に戻る**。移動元では `onDidRequestDetach` → `detachProcessAndDispose(TerminalExitReason.User)` で畳まれ、ふつうに閉じたとき（`dispose(TerminalExitReason.User)`）と見分ける手がかりがインスタンスに無いので、記録は消える。消さずに残しても、保存先が WORKSPACE storage なので移動先のウィンドウ（別のワークスペース）からは読めない
- **ターミナルのサジェストの吹き出しは、ターミナル単体の文字サイズに追従しない**。吹き出し（`terminalSuggestAddon.ts`）は `XtermTerminal.getFont()` ではなく `ITerminalConfigurationService.getFont()` を直接読むので設定の文字サイズで描かれ、fork の差分（`getFont()` の PARA-PATCH）は通らない
- **⌘⇧T のエディタ側の履歴はウィンドウ全体で1本**。fork はスペースごとに「ターミナル」と「エディタを閉じた印」を並べて持つが、エディタの中身は upstream の閉じたエディタの履歴（`workbench.action.reopenClosedEditor`）が持ち、そちらはスペース別ではない。スペース B で押しても、印がエディタならスペース A で最後に閉じたファイルが開くことがある。upstream の履歴から消えた分（上限を超えた・ファイルが消えた等）とも印がずれ、その場合は別のファイルが開くか何も起きない

フォーカスの無いビューの減光（TM7、upstream の `accessibility.dimUnfocused.enabled` を既定オン）は、ウィンドウが非アクティブの間は打ち消す（`contrib/unfocusedDimming/electron-browser/`）。Chromium はウィンドウがフォーカスを失うと、フォーカスを持っていた要素にも `:focus-within` を当てなくなる（`document.activeElement` は残る。Para Code の Electron で2つのウィンドウを使って実測）ので、upstream の `:not(:focus-within)` の規則だけだと、別のアプリへ切り替えただけで全部が薄くなる。

- 「非アクティブ」はネイティブのウィンドウ（BrowserWindow）単位で判定する（`INativeHostService.onDidFocusMainOrAuxiliaryWindow` / `onDidBlurMainOrAuxiliaryWindow` と各ウィンドウの `vscodeWindowId` を突き合わせる。補助ウィンドウも別々）。`document.hasFocus()` で判定すると、内蔵ブラウザ（同じウィンドウの中の別の WebContentsView）をクリックしただけでワークベンチの document が blur し、同じウィンドウの中なのに減光が全部消える（実機で確認）。そのため機能ごと electron-browser に置き、Web ビルドは upstream の動きのまま
- 印は各ウィンドウのワークベンチのコンテナ（`ILayoutService.getContainer(window)`、`.monaco-workbench`）の `data-paradis-window-inactive` 属性に付ける。`<html>` / `<body>` やクラスには付けない。upstream の `auxiliaryWindowService.ts`（`trackAttributes` の3行）がメインの `<html>` と `<body>` の属性すべてと、コンテナの class を補助ウィンドウへ写し続けるので、メインへフォーカスが戻って印が外れると補助ウィンドウの印まで消え、補助ウィンドウの中が薄くなる（実機で確認）。取り込み時に upstream がコンテナの写しを class 以外へ広げていないか（`trackAttributes(this.layoutService.mainContainer, container, ['class'])` のままか）を確かめる
- 打ち消しの CSS は `unfocusedViewDimmingContribution.ts` の規則を1つずつ写してある。**upstream が減光の対象を増やしたら、`paradisUnfocusedDimming.css` にも同じ形で足す。** 取り込み時は `grep -c "rules.add(" src/vs/workbench/contrib/accessibility/browser/unfocusedViewDimmingContribution.ts` と、`paradisUnfocusedDimming.css` の `.monaco-workbench[data-paradis-window-inactive]` で始まるセレクタの数（今は 9）が一致するかを見る

## エージェントの様子をデスクトップへ渡す経路（agentInsights、2026-09-27、フェーズ3 担当B）

サブエージェント・最後の発言・未回答の質問・プロンプトキャッシュの残り時間は、モバイル中継（`mobileRelay/node/paradisMobileAgentChat.ts`）が transcript と hook から既に読んでいる。デスクトップの UI はこれを二重に集計せず、中継に**読み取り口だけ**を足して引く（hook を直接読む集計を別に作ると、PC とスマホで表示が食い違い、Codex のサブエージェントも取れないため）。モバイルへ送るメッセージの形は変えていない。

- 口は `IParadisAgentPaneInsightSource`（`agentInsights/common/paradisAgentInsights.ts`）。中継サービスのチャネル `PARADIS_MOBILE_RELAY_CHANNEL` に `getAgentPaneInsights(tokens)` と `onDidChangeAgentPaneInsights` を足しただけ。renderer 側は `agentInsights/electron-browser` の取得係がこのウィンドウのペイントークン分だけ取り、`IParadisAgentInsightsService`（browser 層のストア）へ置く。知らせの取りこぼしに備えて 10 秒ごとにも取り直す
- **モバイル連携が無効でも動く**。中継サービスは shared process で常に生成され、セッションが確定したペインの status 用 tailer はモバイル接続と無関係に常駐している（`stopTailerIfUnsubscribed` 参照）。ただしモバイル向けの質問・承認の注入（`injectLiveQuestions` / `injectApprovalRequest`）はペアリング済みのモバイルがあるときしか動かないので、デスクトップの「待っている内容」はそれに頼らず hook（`PreToolUse` の AskUserQuestion と `PermissionRequest`）から別に覚えている（`recordDesktopInteraction`）
- ProxyChannel はサービスのイベントをチャネル登録時に `Event.buffer` で購読してしまうため、「購読者がいる間だけ動かす」は効かない。変化の検出は hook・tailer の追記・活動ツリーの更新を契機に 250ms まとめて指紋を比べる方式にした
- プロンプトキャッシュの残り時間は Claude の assistant 行の `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` から決める（両方あれば先に切れる 5 分、読み込みだけのリクエストは直前の長さを引き継ぐ）。起点はその応答を求めたリクエストの時刻で、直前の user 行（ユーザーの発言か tool_result）の `timestamp` で近似する（応答を書き終えた時刻を使うと、生成に2分かかった応答で残りを2分長く見積もる）。エディタのターミナルのバッジは、応答中（状態が「動作中」）と 0 になった後は消す
- **Codex は残り時間を出さない**。OpenAI のプロンプトキャッシュは「おおむね 5〜10 分の無操作で消え、長くても 1 時間」という目安しか公開されておらず、rollout の `token_count` にも `cached_input_tokens` しか無い（有効期限を決める根拠が記録に無い）
- スペース一覧のメタ段の項目 `promptCache` は `paradis.workspaceSwitch.rowMeta` の5項目目で、PR・Issue の右（左寄せの末尾）に出る。**行の高さはターンごとに揺らさない**: 枠を出すかは「そのスペースの Claude ペインにキャッシュの記録があるか」で決め、応答中や期限切れの間は数字を消して炎を薄く残す（応答のたびに枠ごと消すと、メタ段を他に持たない行が 44px ⇔ 60px で上下し、押そうとした行がずれる）。ツリーの組み直しは記録を持つペインの出入りのときだけで、数字は 1 秒ごとに文字だけ書き換える（`ParadisPromptCacheChips`）
- 設定を自分で書いた（「表示する情報」を触った）人の並びに `promptCache` が無いときは、**非表示で**末尾へ足す（すべて非表示にして2段表示を選んでいた人の行が、更新しただけで3段に伸びないように）。後から項目を足すときは `PARADIS_WORKTREE_META_ADDED_LATER` に入れる
- エディタのターミナルのバッジは、ターミナルの検索ウィジェットと同じ右上の角に出る。検索ウィジェットが開いている間は CSS（`:has(.simple-find-part.visible)`）で隠し、ボタンを覆ったりクリックを奪ったりしないようにしている
- エディタエリアのターミナルのバッジは、ペインインジケータと同じく DI を持たない `SessionTerminalEditor` から置く。値の供給元はモジュールのレジストリ（`setParadisPromptCacheBadgeHost`）で、`vs/sessions/contrib/*` から `vs/paradis/contrib/agentInsights/~` を import するための許可を `eslint.config.js` に足している

## エージェント向けの IDE 操作ツールとガイド（agentIde、2026-09-27、フェーズ8 担当A）

O1（Q75）と O4（Q79）。`src/vs/paradis/contrib/agentIde/` に実装し、para-browser MCP サーバーへツールを12個足した。upstream のファイルは触っていない（`sharedProcessMain.ts` も触らずに済むよう、ツールのプロバイダの登録口を足した）。フェーズ8のレビュー（security H1/H2/M1〜M6/L4、correctness 4/7/8/13/14/15、architecture M1〜M4/L1〜L8）を受けて権限を絞り直した。

| ツール | 種類 | 権限 |
|---|---|---|
| `read_para_code_guide` / `list_spaces` / `list_terminals` / `read_terminal` / `wait_for_terminal` | 読み取り（MCP 注釈 `readOnlyHint`） | 常に使える（ただし接続元がそのペインの中か、SSH の戻り経路であることを確かめる）。読めるのは自分のスペースのターミナルと自分が作ったものだけ。別のスペースは `paradis.agentIde.readOtherSpaces`（既定オフ）か、送信の範囲を「同じウィンドウ全体」にしたとき。`read_terminal` の既定は見えている画面 + 上 10 行で、スクロールバックは `scrollback_lines` で明示 |
| `send_terminal_input` / `send_terminal_key` | 送信（`destructiveHint`） | `paradis.agentIde.allowActions`（既定オフ）＋接続元の確認。同じスペース（`actionScope=window` で同じウィンドウ全体）と自分が作ったもの。自分自身・許可待ち・質問中へは何も送らない。Enter は下の規則 |
| `launch_agent` / `create_terminal` / `create_space` | 作成（`destructiveHint`） | 同上。子（エージェントのツールで起動したペイン）は作れない。上限: 呼び出し元ごとに生きている作ったターミナル 5、ウィンドウ全体 12、作ったスペース 3。`create_terminal` と `create_space(run_setup=true)` は `paradis.agentIde.allowShellCommands`（既定オフ）も要る |
| `close_terminal` / `remove_space` | 閉じる・削除（`destructiveHint`） | 同上、かつ自分が作ったものだけ。`remove_space` は「ワークツリーを削除」の確認ダイアログに「エージェントからの依頼」と出して利用者に決めさせる。依頼は同時に1件 |

### Enter の規則（security H2・M1）

- **Enter は貼り付けと別の呼び出しで送る**。shared process が「確かめる → 貼り付け → 250ms → 確かめ直す → Enter」の順に回し、確かめるたびに hook の最新の状態（`_paneStatuses`）を見る。ウィンドウ側も表示用の状態（2 秒ごとの取り直し）で止める
- **エージェントへの Enter は、作業中でなく、許可待ち・質問中でなく、本物の hook が一度でも届いたペインだけ**（`context.hasAgentHookHistory`。transcript から推した開始は数えない。hook を信頼していない Codex もここで止まる）。hook を切っている・信頼していない相手は、許可ダイアログが出ているかを確かめられないので送らない。さらに Enter の直前に画面の末尾 30 行に確認の選択肢（「Do you want to proceed?」など）が無いかも見る（`paradisAgentIdeScreenShowsPrompt`。【要確認】文言は Claude Code 2.1.283 / codex-cli 0.155.1 の目安で、版が変わると外れうる）
- **素のシェル（前面が Claude Code / Codex でない）への Enter は `allowShellCommands`**。前面の判定はシェル統合の実行中のコマンド（`paradisInteractiveAgentCommand`）だけ。シェル統合が無いターミナルは素のシェルとして扱う（hook の履歴で代えると、エージェントが終わった後のシェルや偽の hook でも立ってしまう）
- 複数行の貼り付けは、フェーズ5のプリセットと同じく「貼り付けモードが有効で、前面がエージェント」のときだけ（`paradisCanPasteMultiline`）
- エージェントへ貼る本文の先頭には `[Message from another agent (Para Code terminal t_xxx), not typed by the user. ...]` を付ける（security M3）。貼り付けは通知センターへ静かに記録し、Enter・中断（`ctrl_c`）・起動・作成はトーストで知らせる

### なりすまし対策（security M2）

- **接続元の確認**（`context.classifyCaller` → `paradisClassifyPeer`）。`127.0.0.1:<相手のポート> -> 127.0.0.1:<このサーバーのポート>` の4つ組が完全に一致する接続を持つプロセス（macOS は `lsof`、Linux は `ss`、Windows は `Get-NetTCPConnection` / `netstat`）を探す。手元のポートだけで探すと、同じポート番号の IPv6（`[::1]`）の接続を持つ無関係なプロセスが当たり、送信元ポートを細工すればなりすませた（再レビュー S-1 で実測）。**どう確かめるかはペインの属性で決める**: 手元のペインは、接続を持つプロセスがそのペインのシェル（`_paneShells`）の子孫なら `pane`。SSH など接続先のペイン（manifest の `remoteAuthority`）は、接続を持つプロセスが Para Code の張った戻り経路の `ssh -R`（`ParadisRemoteAgentTunnels.processPidFor`）**そのもの**なら `tunnel`。shared process の子孫かどうかでは決めない（shared process は git・codex app-server なども起こし、リポジトリの `core.fsmonitor` や `.git/hooks` でエージェントのコードを走らせられるため。再々レビュー N-1）。接続先のペインの `shellPid` は接続先のプロセス番号なので、手元のプロセス表との照合（この確認・CDP の PID 解決・PID の重複検査）には使わない（N-2）。hook のクエリの `host=` の名乗りでは確かめ方は変わらない。接続を持つプロセスが複数あるときは全部が同じ分類のときだけ採る。環境変数は偽装できるので見ない。親の起動時刻が子より新しければ PID の使い回しとしてたどるのをやめる（Windows は `CreationDate`、Linux は `/proc/<pid>/stat` の起動時刻。macOS / Linux の `ps` 経路では親が死ぬと 1 へ付け替わるので比べない。【要確認】Windows 未検証）。Windows は接続表とプロセス表を 1 本の PowerShell でまとめて取る（起動が重く、祖先を 1 段ずつ問い合わせると hook の 3 秒の待ちを超えやすいため。【要確認】実測していない）。結果は接続（keep-alive）とトークンの組ごとに覚え、シェルの PID や戻り経路の ssh が変わったら判定し直す。**操作系は `pane` だけ、読み取り系は `pane` か `tunnel`**。SSH の接続先のエージェントは読み取りだけ使える。**`tunnel` が示すのは「戻り経路を通って来た」ことだけ**（R3-4）: 接続先のペインのトークンを持っていれば、接続先の同じユーザーのプロセス、接続先の別のユーザー（`-R` は接続先の 127.0.0.1 で待つので誰でも繋げる）、手元の同じユーザーのプロセス（制御口 `ssh -S <userData>/pcx/ctl-*.sock` や利用者の鍵で接続先へ入れる）のどれでも `tunnel` になる。そのため接続先のペインでは、偽の hook で許可待ちを解けうる。そのため IDE ツールは、接続先のペイン**へ**の Enter を送らない（文字を入れるだけは可。利用者に送ってもらう）。接続先のペイン**から**の操作系も使えない（操作系は `pane` だけ）。フェーズ7 のブラウザのツールのうち、利用者に承認を求めるもの・ページやプロファイルを開く / 切り替える / 消すもの（`request_browser_page`・`open_browser_tab`・`select_browser_tab`・`close_browser_tab`・`open_browser_profile`・`create_browser_profile`・`switch_browser_profile`・`delete_browser_profile`）も `pane` か `tunnel` に限った（R3-3）。一覧だけのもの（`list_browser_tabs`・`list_browser_profiles`・`get_shared_page` など）はダイアログを出さず名前を返すだけなので、トークンだけで使えるままにした。CDP ゲートウェイの接続元の特定（`paradisResolvePaneTokenForPeerPort`）も同じ4つ組で探すが、**CDP は `?pane=` と環境変数でもトークンを受け取るので、トークンを知っていれば操作できる**（前からの仕様。MCP の接続元の確認とは別。N-8）
- **hook の偽装対策**: notify スクリプトはトークンを URL（curl の argv）に載せず、`curl --config -` で標準入力から `Authorization: Bearer` ヘッダーとして渡す（PowerShell 版も `-Headers`）。スクリプトは起動のたびに内容を比べて置き直すので、既存の利用者の手元・SSH 先の分も置き換わる。ただし版（`notify-v3`）は上げていないので、古い版の Para Code（並べて使う別ビルドや、同じ SSH 先に繋ぐ古い版）が起動すると、トークンを URL に載せる内容へ置き戻す。サーバーは `?pane=` も受け付け続けるので動作は壊れない（版を上げると `settings.json` の hook を書き換えることになるので見送った。N-11）。**hook を捨てるのは、許可待ち・質問中のペインで接続元が確かめられない（`pane` / `tunnel` でない）ときだけ**。それ以外の状態では確かめない（hook は頻繁に来るので `lsof` を毎回起こさないため。それ以外の状態を偽装しても、許可ダイアログを Enter で押させることにはつながらない）。curl の待ち（3 秒）が先に切れた後も確かめと状態の更新は続けるが、**効くのは接続の探索が切れる前に済んだ場合だけ**（R3-7）。探索は `ESTABLISHED` の行だけを見るので、curl が先に切れて接続が `FIN_WAIT` / `TIME_WAIT` になると見つからず、hook のプロセスも終わっているので `unverified` になる。確実にするにはスクリプトとの取り決め（門が掛かる状態のときだけ待ちを延ばしてもらう返事など）が要る（未対応）。transcript から許可待ち・質問中が解かれたときは印（`_unconfirmedReleaseTokens`）を付け、IDE 操作ツールはその間 Enter を送らない（transcript は同じユーザーの別プロセスが追記できる。N-9）。**印は hook を捨てる条件には使わない**（R3-1）。印の付いたペインに hook が来たら 1 回だけ接続元を確かめ、確かめられれば印を外す。確かめられなければ hook はそのまま処理し（hook のバス・定期実行の見張り・モバイルの会話は止めない）、印は残して「確かめられないペイン」として覚え、以後は問い合わせない。このペインへの Enter は「利用者に頼んで」と断る。次の許可待ちで確かめた hook が来れば両方外れる。**印は状態の項目とは別に持つ**（`context.getUnconfirmedRelease`）。状態は既読（`acknowledgePaneStatus`）や idle の hook で消えるが、印はそれでは外れない（表示中のスペースで既読になった後に Enter が通っていた。実機確認3 の NG）。**確認を通らない構成（N-10）**: 前の Codex ペインの app-server を採用（adopt）した場合、tmux・screen・zellij の中で動かしたエージェント、WSL・dev container など戻り経路の ssh を持たない接続先のペインは、送り主がペインのシェルの子孫でも Para Code の戻り経路でもないので、IDE ツールが読み取りを含めて使えない。許可待ちの間の hook も無視されるので、利用者が答えた後も表示が許可待ちのまま残りうる（transcript の追跡で解ければ戻る。定期実行ではその回が「要対応」のまま打ち切られうる）。質問に答えた後は IDE ツールの Enter が「利用者に頼んで」と断られ続ける
- **戻り経路の ssh の `-o ControlPath=none`**（R3-8）: 制御口のパスが長すぎて置けないとき（`--user-data-dir` の長い開発ビルドなど、100 バイト超）だけ付ける。そのとき戻り経路の ssh は利用者の既存の `ControlMaster` に相乗りせず、`BatchMode=yes` で新しく認証する。パスワードや二段階認証をマスターの確立で済ませている接続先では、戻り経路が張れず hook も MCP も届かなくなる（前は相乗りで張れていたが、`-R` の接続を利用者のマスターが持つので接続元の確認は通らなかった）。通常の構成（制御口を置ける）は前から `-M -S <制御口>` で利用者の `ControlPath` を上書きしていたので変わらない
- 裏のタブ（`paradisInactive`）は一度もアクティブにならず `TerminalEditorInput.group` が付かないので、park の判定（`parkExplicitlyScopedEditorIfInactive`）は入力を含むグループを `editorGroupsService` から探して、補助ウィンドウに見えているスペースを park しない（R3-9）。シェルの種類が起動直後にまだ届いていないときは、バックスラッシュを含む指示に限って最大 2 秒待ってから引用を決める（R3-11）。Enter の直前の画面の確認は、shared process（貼る前・貼った後）とウィンドウ側（Enter の直前）の両方で行い、貼った本文の部分は、呼び出し側の申告ではなく実際に貼った本文で除いて探す（空白と罫線を落として照合。R3-6）。`list_terminals` の `on_screen` は「今のスペースのターミナル」だけに付け、補助ウィンドウに見えている別スペースのターミナルには付けない。`ITerminalInstance.isVisible` は画面から外れても `false` に戻らない（`TerminalEditor.setInput` が前のインスタンスを `detachFromElement()` するだけ、park も戻さない）ため、見えているかの判定に使えない（実機で確認）

### 操作系を別の MCP サーバー名に分けなかった理由（security H2）

分けると、利用者が Claude Code / Codex の両方へ2本目の MCP サーバーを登録し直す必要があり、ワンボタンの設定（`paradisMcpSetup.ts`）と設定の状態表示、SSH 先への設定、stdio シムも2本立てになる。代わりに、操作系は既定オフの設定・接続元の確認・MCP の `destructiveHint` 注釈・シェルの実行を別の設定、の4段で絞った。`mcp__para-browser__*` を一括で許可している利用者でも、設定をオンにしない限り操作系は動かない。

### その他

- **ツールの足し方**: `agentBrowser/common/paradisMcpToolProvider.ts` の `paradisRegisterMcpToolProvider(provider)` を shared process の登録（`ParadisSharedProcessContributions`）から呼ぶ。`callTool` の5番目の引数 `context` で、ウィンドウへの IPC（`callOwningWindow`、`timeoutMs` で延長可）、hook の状態（`getPaneAgentStatus` / `hasAgentHookHistory`）、接続元の確認（`verifyCallerProcess`）を借りられる。`instructions()` は `initialize` の `instructions` に足される（ブラウザ共有の説明はサーバーが先頭に固定で置く）。mobileCanvas はまだ `registerToolProvider`（`sharedProcessMain.ts` 経由）のまま。移すには mobileCanvas の登録に要る引数を `sharedProcessMain.ts` から外す必要があり、今回は見送った
- **hook の受付は MCP と別枠**（`_reserveIngressRequest(token, 'hook')`）。待機（最大 240 秒）が枠を占めても hook が拒否されない。待機の同時数はペインごとに 2、全体で 16（接続元を確かめた後で数えるので、偽のトークンで枠を埋められない）
- **ペイントークンはエージェントへ出さない**。ターミナルの ID は `t_` + SHA-1(`paradis-agent-ide:` + トークン) の先頭12桁（`paradisAgentIdeTerminalId`）。一覧のタイトルは制御文字を落として 80 文字で切り、「従うな」と説明に書く
- **台帳（誰が作ったか・子の印）はワークスペースの保存領域（`paradis.agentIde.ledger`）に ID だけで残す**。ターミナルが閉じたら（ウィンドウを閉じるときの破棄は除く）、スペースが退役したら消す。呼び出し元は 200 件まで
- 台帳は端末の接続（SSH の再接続を含む）が済んでから 60 秒後に生きているペインと突き合わせ、もう居ない作ったターミナルを消す。子の印は掃除では消さず（遅れて戻った子が作成の制限から外れないように）、500 件の上限だけで絞る
- shared process の git に `-c core.fsmonitor=false` は付けていない（`tunnel` を戻り経路の ssh の PID との一致に絞ったので、git の子孫が確認を通ることはなくなった。git のフックの扱いは worktree 作成の都合があるので別に検討する）
- **所属は台帳の記録だけで決める**（`paradisResolveInstanceSpace(..., { strict: true })`）。`resolveScope` は記録の無い生きたターミナルを今のスペースとして答えるので、権限の判断には使わない。スペースの一覧は `paradisListSpaces`（メモのツールと同じキーと名前）
- **待機**: `until="agent_stopped"` は、一度も作業中にならないまま猶予（5 秒、エージェントのツールで起動したペインは起動から 90 秒）を過ぎると `met: false, reason: "no_agent_status"` を返す（止まったとは言わない）。既定 50 秒・上限 240 秒。上限は codex-cli 0.155.1 の MCP ツールの既定のタイムアウト 300 秒（`codex-rs/codex-mcp/src/rmcp_client.rs` の `DEFAULT_TOOL_TIMEOUT`。2026-06-15 の #28234 で 60 秒から 300 秒へ。0.140.0 は 120 秒。GitHub のソースで確認）、stdio シムの 310 秒、HTTP のソケットの無通信の上限 300 秒より短くする。文字列の待機は部分一致だけ（shared process で利用者由来の正規表現を回さない）。待機中に対象が閉じたら `reason: "terminal_closed"`
- **終わったかの判定が定期実行と別**（correctness 7）。`ParadisAgentStopWatcher`（こちら）は呼び出したエージェントへ今の状況を返すので、許可待ちでも返し、状態が来なければ `no_agent_status` と言う。定期実行の `paradisAdvanceRunWatch` は完了を記録するので、許可待ちは要対応として見張りを続ける。目的が違うため1つにまとめていない
- **起動コマンドのプロンプト**（`paradisBuildAgentCommand`）は入口で制御文字を落とす（`src/vs/paradis/common/paradisTerminalControlCharacters.ts`。MCP の送信本文と同じ関数）。PowerShell は U+2018〜U+201B も二重にし、fish はバックスラッシュとシングルクオートをエスケープする（security M6。fish と pwsh の実機では未確認）
- **起動するエージェントの権限モードは渡せない**（テンプレートの既定のまま）。利用者の CLI の既定（`defaultMode` やカスタムテンプレート）は引き継ぐ
- 設定は4つとも `ConfigurationScope.APPLICATION` + `restricted`。ただしエージェントは利用者の `settings.json` を書き換えられるので、設定で完全には守れない（ガイドとツールの説明で「自分で変えるな」と書いているだけ）
- **起動 API のフォーカス**（architecture M1・実機確認 NG1）: `paradisLaunchAgentInWorkspace` の `preserveFocus` と作成フローの `preserveFocus` / `runAutoRunPresets` を足した。`true` なら**裏のタブとして**開き（`TerminalEditorLocation.paradisInactive` → エディタの `inactive`。`preserveFocus` だけではタブがアクティブになり、利用者が打っていたターミナルが裏へ回って打鍵が失われた）、`setActiveInstance` も呼ばない。場所のオブジェクトは毎回作り直す（terminalService が `viewColumn` を書き換えるため）。`launch_agent`・`create_terminal`・`create_space` と、定期実行（既存スペースへの起動と新しいスペースの作成の両方）がこれを使う。スペースへターミナルを開く手順は `paradisOpenEditorTerminalInSpace` にまとめた（`paradisResumeAgentInWorkspace` とプレビューの所属判定はまだ別）。シェルの種類が分からない（ラッパー経由の起動）ときは、バックスラッシュを含む指示を起動コマンドへ入れずに断り、そのために開いたターミナルは閉じる（fish の引用が閉じ損ねるため。作成ダイアログのプレビューは bash の表記で組むので例外にならない）。起動時の実行ファイル名で種類が決まり、中で `exec fish` する構成は POSIX 式のまま【要確認】
- 【要確認】`remove_space` の確認ダイアログは `window.dialogStyle=custom` のとき z-index 2575 で、fork の 2700 のモーダルの裏に入りうる（regression 7）

### スキルファイルの設置（O4）

「設定 (Para Code)」→「エージェントの操作」→「スキルを設置…」（コマンド `paradis.agentIde.installSkills`）を押したときだけ書く。置き場所は shared process が決め、画面からパスは受け取らない。

- Claude Code: `$CLAUDE_CONFIG_DIR/skills/para-code/SKILL.md`（既定 `~/.claude/skills/...`）。`CLAUDE_CONFIG_DIR` はログインシェルの環境から読む（スキル管理画面の `process.shellEnv()` と揃える。GUI 起動の shared process の `process.env` には rc だけで export した値が入らない）
- Codex: `~/.agents/skills/para-code/SKILL.md`。codex-cli 0.155.1 の利用者スキルの置き場所（`codex-rs/ext/skills/src/host_roots.rs`）。`$CODEX_HOME/skills` は非推奨として読まれるだけなので使わない
- 中身は「MCP の `read_para_code_guide` を呼べ」と指すだけの入口で、本文はアプリが返す（Orca の orca-cli スキルと同じ考え方。版がずれない）
- 置く前に場所と状態（新規・同じ・別の内容・ファイルでない）を見せて確認し、別の内容があれば上書きするかを別に聞く。上書きは、確認したときの中身の指紋（SHA-256）と書く直前の中身が一致したときだけ。新規は排他作成（`wx`）、上書きは同じフォルダの一時ファイルへ書いて確かめ直してから `rename`（確かめた後に `SKILL.md` がリンクへ差し替えられても、先へ書かない）。`skills/`・`para-code/`・`SKILL.md` のどれかがシンボリックリンクなら触らない。手元の PC にだけ置く（SSH 先・WSL への導入はスキル管理（O6）の範囲）

### 担当B（定期実行 O3 など）と共有している部品

| 用途 | 置き場所 | API |
|---|---|---|
| エージェントの起動（フォーカスを奪わない） | `workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.ts`（フェーズ1） | `paradisLaunchAgentInWorkspace({ ..., preserveFocus: true })` / `paradisRunWorktreeCreateFlow(request, { switchToCreated: false, preserveFocus: true })`。どちらも `{ instanceId, paneToken }` を返す |
| 起動コマンドへ入れる文字の整形 | `src/vs/paradis/common/paradisTerminalControlCharacters.ts` | `paradisStripTerminalControlCharacters(text)`（`paradisBuildAgentCommand` の入口で自動で通る） |
| 人の答えを待っているか | `agentIde/common/paradisAgentIde.ts` | `paradisAgentIdeNeedsHuman(paradisAgentIdeStatusLabel(status))` |

## ターミナルの共通化・スペース別履歴・タブの状態表示（2026-09-27、フェーズ5 担当A）

TM1 / TM2 / TM11 / TM18 / TM22。ロジックはすべて `src/vs/paradis/contrib/` の新規ファイル（`terminalSharedPanel` / `terminalSpaceHistory` / `terminalTabStatus` / `terminalResumeBanner`）にあり、upstream 側の変更は次の表だけ。

| ファイル | 行数 | 中身 |
|---|---|---|
| `terminalInstanceService.ts` | 2 | `paradisPrepareTerminalLaunch(shellLaunchConfig, target)`（import + 呼び出し）。`workspaceSwitch/common/paradisTerminalLaunchPreparers.ts` に登録した関数が PTY 起動前に `cwd` / `env` を足す |
| `terminalEditorInput.ts` | +7 / -1 | タブ左のアイコンの差し替え点（`getIcon` / `getLabelExtraClasses` に各2行、描き直しの購読1行、import 1行。-1 は購読の配列の直前の行へカンマを足した分）。提供元は `workspaceSwitch/browser/paradisTerminalTabIconRegistry.ts` |
| `shellIntegration-rc.zsh` / `-bash.sh` / `.fish` | 9 / 9 / 8 | ユーザーの rc の後で `HISTFILE`（fish は `fish_history`）をスペースの履歴へ切り替え、変数を unset。フォルダは umask 077 で作り 0700 にそろえる（macOS の `chmod` は `--` を受け付けないので付けない） |

- **ターミナルを作る直前の処理を足すときは、`paradisRegisterTerminalLaunchPreparer` に登録する**。`TerminalInstanceService.createInstance` には fork の行が3本（`paradisPrepareTerminalIdentity`・`paradisPrepareTerminalPaneEnv`・`paradisPrepareTerminalLaunch`）あり、これ以上 upstream の行は増やさない
- **下部パネルは共通ターミナル（設定 `paradis.terminal.sharedPanel.enabled`、既定オン、再読み込みで反映）**。設定はウィンドウで最初に読んだ値を `paradisSharedPanelEnabledAtStartup` から使う（所属の判定・パネルの開閉・開始フォルダ・シェル履歴の4か所がずれないため）。判定は `paradisTerminalScope.contribution.ts` の `isSharedPanelInstance`（`target === TerminalLocation.Panel` かつユーザーが開いたシェル。タスク・拡張機能・feature・隠しのターミナルは従来どおりスペースに属し、削除で閉じる）。タグ付け・park・退役・台帳への記録をすべて飛ばす。パネルの開閉もスペースごとには切り替えない
  - **所属を尋ねられたら「今のスペース」と答える**（`resolveScope` は `managed(今のスペース)`、`getStateKeyForInstance` は今のスペース。台帳には書かない）。共通ターミナルのエージェントの許可待ち・完了のモバイル通知、スペース一覧の状態、Para Browser の共有が、今見ているスペースのものとして働く。ただし持ち主ではないので、見つけた Issue の URL はスペースへ付けず、完了の既読も「スペースを開いている」ではなくそのターミナルにフォーカスがあるときだけにする（`IParadisTerminalScopeService.isSharedPanelTerminal` で見分ける。`paradisAgentStatusSnapshotConsumer`）。スペースを切り替えると答えが変わるので、共有中のブラウザは binding model の `_reconcileStableScopeChange` が外す（前のスペースのブラウザは裏に隠れるため）。モバイルへ送る形式は変えていない
  - 前のバージョンが台帳へ書いたパネル端末の所属は初見で消すので、**更新直後は、それまで他のスペースに退避していたパネルのターミナルが全部パネルに並ぶ**（1度だけ通知。このウィンドウでエディタのタブからパネルへ移しただけの端末は数えない）。消した所属は `paradis.workspaceSwitch.sharedPanelFormerScopes`（nonce → stateKey）へ控え、設定をオフにして再読み込みすると nonce 台帳へ戻す。前のセッションの pid（attach 先）でも引くこと（再起動で pid が振り直されるので、今の pid だけでは見落とす）
  - 開始フォルダは設定 `paradis.terminal.sharedPanel.cwd`（空ならホーム。upstream の `terminal.integrated.cwd` と同じく `restricted`）。空で `terminal.integrated.cwd` が設定されていればそちらに従う。存在しないフォルダは起動時と設定の変更時に確かめてホームへ落とす（存在しないフォルダを渡すと、それ以降のパネルのターミナルがすべて起動に失敗する）
- **スペース別のシェル履歴（`paradis.terminal.historyPerSpace.enabled`、既定オン）**。`PARA_CODE_SPACE_HISTORY_DIR` / `_ID` で渡し、置き場所はローカルが `<userData>/terminal-history/<sha1(stateKey) 先頭16桁>/`（Windows でも区切りは `/`）、SSH 先が `~/.para-code/terminal-history/...`（接続先が Windows のときは使わない）。fish は置き場所を変えられないので `~/.local/share/fish/paracode_<id>_history`。スペースの削除で消す（閉じたシェルの終了時の書き戻しに備えて10秒後にもう1度。その間に同じスペースでターミナルを開いたら2回目は取り消す）。削除を受け損ねた分は、このワークスペースで作った id の控え（`paradis.terminal.historyPerSpace.createdIds`）から、起動時（worktree の列挙が終わった後）に片付ける。**列挙は一時的に失敗しても成功扱いで終わる**（`paradisWorktreeService.refresh`）ので、1回見つからなかっただけでは消さない。3回続けて見つからず、しかも履歴が14日以上書かれていないものだけを消す（`paradisShouldDeleteOrphanHistory`）。userData は全ワークスペースで共有なので、控えに無いフォルダには触らない
  - 補完候補（`terminalHistorySuggest`）は、アクティブなターミナルのスペースの履歴ファイルを最初に並べ、VS Code 内部の履歴（全スペース共通）、`~/.zsh_history` 等の全体の履歴の順に続ける。復元したエディタのターミナルは起動時の環境変数が残っていないので、今のスペースの履歴を読む
  - 既知の穴: fish の `XDG_DATA_HOME` を変えている環境は消せない（設定の説明に書いた）。シェル統合が注入されないシェルでは効かない。更新直後は既存のスペースでも ↑ が空から始まる（全体の履歴は引き継がない。補完候補には全体の履歴が出る）
- **タブの点（TM11）は upstream のベル表示と同じファイル装飾だが、提供元を自前で起動時に登録している**。upstream の `TabDecorationsProvider` はパネルのタブ一覧を作ったときにしか登録されない（パネルを開いていないとエディタのタブに何も出ない）ため。パネルを開くと同じ `vscode-terminal` の URI に upstream の提供元も並ぶ。ベルが二重にならないよう、upstream のベルの状態（`TerminalStatus.Bell`）が出ている間はこちらは色だけにしている。ベルは `xterm.raw.onBell` を直接購読（upstream は visual bell 設定がオフだと何も出さない）
  - 点を消すのはフォーカスと `xterm.raw.onKey` だけ。`onAnyInstanceDataInput` はカーソル位置の問い合わせへの自動応答・フォーカス報告・他の機能からの送信でも発火するので使わない
  - 許可待ち・質問から直接終わった場合（見ているスペースではすぐ既読になり review を経ない）も完了として点を付ける
  - 見送り: 「作業中 → 状態なし」を完了とみなしている（見ているスペースの完了は状態スナップショットの側がすぐ既読にして、renderer には review が届かないため）。状態の掃除やエージェントの異常終了でも緑の点が付く。見分けるにはスナップショット側（`paradisAgentStatusSnapshotConsumer`）の既読処理を変える必要がある
- **タブ左のアイコン（TM18）で `Codicon.loading` を返してはいけない**。`.codicon-loading` の回転がラベルのルート要素に掛かり、タブの文字ごと回る。作業中は土台を `Codicon.sync` にして、`::before` の中身を loading の文字に替えて回している。upstream の次の要素に依存しているので、取り込みで変わったら直す
  - DOM と詳細度: `.monaco-icon-label.terminal-tab[class*='codicon-']::before`、upstream の `.monaco-workbench .predefined-file-icon[class*='codicon-']::before` と `.monaco-workbench:not(.file-icons-enabled) .predefined-file-icon[class*='codicon-']::before { content: unset !important }`（こちらのセレクタは `.file-icons-enabled` 付き）
  - keyframes の名前 `codicon-spin`。loading の文字は `getCodiconFontCharacters()` から実行時に引く
  - ロゴは SVG を mask にして文字色で塗る（パスデータは `src/vs/paradis/common/paradisAgentLogoPaths.ts`）。`workbench.editor.showIcons` がオフ、またはファイルアイコンテーマなしだと出ない
- **復元タブのバナー（TM22）**。shared process の状態スナップショットに `paneSessions`（ペイントークン → hook の session_id と、その会話で最初に報告された cwd）を足し、renderer が WORKSPACE storage の `paradis.terminal.resumeSessions` に控える。キーはペイントークンのハッシュ（トークンは MCP やペインの app-server の Bearer を兼ねるので平文では書かない。前の版の平文キーは読んだ時点で置き換える）。Codex はタイトルの `codex | <uuid>` からも拾う（パターンは `codexTerminalTitle/common` と共用）。「エージェントが終わった」の判定はシェルのプロセス ID が変わったか（ウィンドウの再読み込みでは変わらないので出ない。常駐ターミナルが引き取った `paradisAdopted` も出さない）。`hasChildProcesses` はエディタタブの直列化が終了時点の値を持ち越すので使えない。「このタブで再開」はシェル統合でプロンプト待ちかつ入力欄が空のときだけ送る（シェル統合が無いターミナルでは送らず、打つコマンドを通知で示す）。表示は共有ドットと同じ `paradisPaneIndicator.ts` の重ね合わせの口（`paradisRegisterEditorTerminalOverlay`）で、検索欄を開いている間は下へずらす
  - **renderer の `paradisAgentStatusSnapshotService` はスナップショットを丸ごと写して凍らせる（フィールドを列挙して詰め直さない）**。列挙していた間に `paneSessions` が落ち、Claude の会話が台帳に入らずバナーが出なかった（8/24 の `agentHookTokenIssueUrls` と同じ漏れ方で2度目）。shared process 側にフィールドを足すときは、写しを直す必要は無い

## プリセットの種類・描画修復・常駐画面の保存・IME パッチ（2026-09-27、フェーズ5 担当B）

TM23 / TM12 / TM14 / TM16。upstream への変更は `localTerminalBackend.ts`（1行 + import）、`build/npm/postinstall.ts`（呼び出し2か所 + import）、`build/filters.ts`（除外2行）、`eslint.config.js`（許可1行）、`ThirdPartyNotices.txt`（Orca の項目。下の台帳に記載）だけ。

依存している既存の PARA-PATCH 点: `xtermTerminal.ts` の `recreateRendererAfterWindowChange`（TM12。upstream のメソッドではなく fork が足したもの）、`terminalService.ts` の終了時に画面保存を飛ばす分岐（TM14 が埋める穴）、`paradisTerminalInputGate.ts` のゲート（TM16 の入力経路にも効かせている）。

### ターミナルの画面を含むファイルは main で 0600 に書く

TM14 の保存画面と TM12 の記録は、renderer の `IFileService` ではなく main プロセスのチャネル（`terminalPrivateFiles`）で書く。`IFileService` は権限を指定できず 0644 になるため。フォルダは 0700、ファイルは 0600 で、一時ファイルに書いてから置き換える。チャネルは app.ts に行を足さないよう、常駐の状態チャネルの登録（`paradisRegisterPtyDaemonStatus`）から一緒に立てている。ワークスペース ID は英数字と `_-` だけを受け付ける（ファイル名になるため）。

### コマンドプリセットの種類（TM23）

プリセットに `action`（`run` / `insert` / `agent-prompt`）と `prompt` を足した。`run` は書かない（従来の定義と同じ形のまま保存する）。

- **`run` 以外の本文は `commands` / `tasks` ではなく `prompt` に置く**。すでに配布した古い版は `action` を知らないので、`commands` があると Enter 付きで実行してしまう。`prompt` だけの定義は古い版では無効として読み飛ばされる。新しい版でも、未知の `action` は読み飛ばす
- `insert` は1行1コマンドの本文を `&&` でつないだ1行にして入れる。**改行は常に残さない**
- `agent-prompt` の改行を残すのは、貼り付けモードで送れて、しかもシェル統合で前面の実行中コマンドが Claude Code / Codex（`paradisInteractiveAgentCommand`）だと確かめられたときだけ。xterm の貼り付けモードの記録は最後に出た `ESC[?2004h/l` でしかなく、エージェントが後始末をせずに落ちると、対応していないシェルでも立ったままになるため
- エージェントが許可・質問の回答を待っている（`question` / `permission`）ターミナルには、`agent-prompt` も `insert` も入れない（先頭の文字が選択肢の操作として食われる）。状態は送る直前に読む
- エージェントかどうかは「hook が1度でも発火したか」（`IParadisAgentStatusStore.isAgentInstance`）。エージェントを終了した後のシェルにも入るが、1行に均して Enter は送らないので実行はされない。タブのアイコン（TM18）・再開バナー（TM22）と判定が揃っていない（アーキテクチャレビュー L1、未対応）
- モバイルの一覧と autoRun からは `run` 以外を外している（入れ先の「今のターミナル」がモバイルからは見えない）。承認の署名には `prompt` も入れてある
- 指紋（`paradisPresetFingerprint`）には `run` 以外のときだけ種類を足す。指紋は「このマシンだけ隠したリポジトリのプリセット」の保存キーにも使っているので、従来のプリセットの指紋を変えると隠したものが出てくる

### 描画ずれの自動修復（TM12）

`terminalRenderer/electron-browser/paradisRenderRepair.contribution.ts`。そのターミナルが見えるようになったときと、そのターミナルにフォーカスが入ったとき（ウィンドウに戻る・スリープから復帰すると、前にフォーカスのあった要素にフォーカスが戻るので、ここに入る）にだけ WebGL の画面を抜き取り、Orca の方式（文字のあるセルの中央に背景色以外の画素が1つも無ければ欠け）で判定する。2回（250ms 空けて）続けて、ビューポートの文字が同じまま同じセルが欠けていたら、`recreateRendererAfterWindowChange` で作り直す。ウィンドウ全体のフォーカスでは見ない（見えている全ターミナルの画面を読み戻すと重い）。

- 「測れなかった」（欠け 95% 以上）ときは、回数を trace ログに出す（`[ParadisRenderRepair] could not measure`）。実機で読み取りが効いているかはこれで確かめる。画面全体が消える型の描画ずれは、この理由で修復しない
- 判定は保守的にしてある: 文字 200 セル以上・欠け 8% 以上 95% 未満・2回で欠けの位置が半分以上重なる。95% 以上は「測れなかった」とみなす（WebGL は `preserveDrawingBuffer` なしで作られており、読み取りの時点でバッファが消えていると全セルが欠けて見える）。細い記号と罫線（`.` `_` `'` `─` など）はセルの中央にインクが無いので数えない。修復後 60 秒は同じターミナルを検査しない。修復後もまだ欠けて見えるなら判定の方が外れているとみなし、そのターミナルでは以後検査しない
- **【要確認】実機で、正常な画面の欠けの割合がほぼ 0 になるか**（`drawImage` で描画バッファを読めているか）をまだ確かめていない。読めていなければ機能は何もしないだけ（95% 以上で判定しない）
- **xterm の非公開のプロパティを読んでいる**: `_core._renderService._isPaused` と `_core._renderService._renderer.value` の `_canvas` / `_charAtlas` / `_themeService.colors.background.rgba` / `dimensions.device.cell`。xterm か addon-webgl を上げたら、`lib/xterm.js` と `addon-webgl/lib/addon-webgl.js` にこれらの名前が残っているかを `grep` で確かめる（merge-upstream スキルにも書いた）。消えていても検査が走らなくなるだけで、例外にはならない
- 記録（既定オフ、`paradis.terminal.renderRepair.recordScreen`）は `<ユーザーデータ>/logs/paradisTerminalRender/<時刻>-<乱数>/`（`before.png` / `after.png` / `info.json`）。`info.json` には画面の文字を入れず、欠けていたセルの座標だけを入れる。logs 直下に1つ置き（upstream の古いログ掃除は日時名のフォルダしか消さない）、記録するたびに7日より古いものを消し、4件を超えたら古いものから消す。Sentry へは件数と割合だけ送る（`render-desync-repaired`、info）

### 常駐ターミナルの画面のディスク保存（TM14）

常駐を使うと、アプリを閉じるときの upstream の画面保存（`persistTerminalState`）を飛ばしている（`terminalService.ts` の PARA-PATCH。起こし直すと生きているプロセスと二重になる）。そのため PC を再起動すると画面もタブも戻らず、常駐を使わない方が再起動に強い状態だった。

- 保存: `ptyDaemon/electron-browser/paradisTerminalScreens.contribution.ts`。**常駐が端末を抱えている間だけ**（`getStatus()` の `running` と、常駐が答えた本数が保存する本数以上あること。`running` は「台帳の常駐プロセスが生きている」という意味で、pty ホストがそれを使っているかまでは表さないので、本数で補う。設定を入れた直後で再起動していないとき・アプリの中の pty ホストに落ちているときは書かない）、pty ホストの `serializeTerminalState` を `<ユーザーデータ>/paradisTerminalScreens/<ワークスペース>.json` へ書く。保存時の常駐の pid と起動時刻も書く。5分ごと（出力があったときだけ。無くても30分に1回）、ターミナルを閉じた2秒後、アプリを閉じる前（`onBeforeShutdown`、上限2秒）。間隔が長めなのは、直列化が端末ごとに cwd の取得（macOS では lsof）とバッファ全体の書き出しを伴うため。対象は upstream が閉じるときに畳む範囲と同じ（待避中のグループとエディタの端末を含む）。1本も無くなったらファイルを消す
- **保存物にはシェルの起動条件の環境変数とシェル統合の nonce が入る**。main が書く前に、秘密の変数（`PARA_CODE_TERMINAL_PANE_ID`、`PARA_CODE_VOICE_TOKEN`、`PARA_CODE_CODEX_APP_SERVER_*`、`PARADIS_PTY_*`。名指しで落とす）とペイントークン（`processDetails.paradisPaneToken`）を落とし、`processLaunchConfig.env`（起動元から引き継いだ全環境変数）は空にする（upstream は復元のときに `shellLaunchConfig.env` から作り直す）。スペース別の履歴（`PARA_CODE_SPACE_HISTORY_*`）や MCP のポートファイルは起こし直したシェルにも要るので残す。ペイン用の値は復元のときにペイントークンのサービスで付け直す。**ペイントークンは nonce から決まるので、このファイルを読めればトークンも分かる**（nonce はエディタのタブと起こし直した端末を結び付けるのに要るので残している）。そのためファイルは本人だけが読める権限で書く。main での解析と書き出しは1回ずつ
- 復元: `localTerminalBackend.ts` の `getTerminalLayoutInfo` で、ストレージに保存物が無いときだけ `paradisTakeSavedTerminalScreens` を呼び、返ってきた文字列を upstream の復元へそのまま流す。配置はストレージの `terminal.integrated.layoutInfo`（常駐のときも upstream が書き続けている）を upstream が使う
- **戻すのは、保存したときの常駐（pid と起動時刻の組）がどこにも居ないと言えるときだけ**（`paradisDecideSavedScreens`）。今の常駐か、別ビルドの常駐（更新前のもの、`status.foreign`）として生きていれば使わない。常駐がまだ動いていなければ最大6秒（1秒おき）待つ。PC を再起動した直後は常駐の起動が pty ホストより遅れるため。それでも動いていなければ、**main プロセスの起動時刻（性能計測の印 `code/didStartMain`）が保存より後か**で決める。後なら、保存物のプロセスを抱えうるアプリの中の pty ホストも居ないので戻す。前なら（ウィンドウの再読み込み）戻さない。使ったらファイルを消す（2回使うと、起こし直したシェルを次の起動でまた起こす）
- 判断が「分からない」で終わったときはファイルを残し、保存側は判断が付くまで上書きしない（上書きすると戻すはずの画面が消える）
- 保存物があって常駐が動いていないときは、ターミナルの復元が最大6秒遅れる
- 【要確認】`reattachAcrossUpdates` の常駐で、更新をまたいだときに今の常駐の pid と起動時刻が変わるか。変わって、かつ更新前の常駐が `foreign` に出ないなら、更新のたびに起こし直しが走る
- 復元の前に保存が走ると、戻すはずの画面を空で上書きする。保存は `take` が済むまで（呼ばれなければ起動から2分）始めない
- 30日より古いものは使わずに消す。開かれなくなったワークスペースの分は、起動5分後に保存フォルダを一度見回って消す。設定 `paradis.terminal.daemon.saveScreens`（既定 true）を切るとその場で消す
- **常駐そのものは既定オフのまま**。実機での再起動の確認がまだで、「Terminal: Attach to Session」が残した端末を巻き添えにする件と、SSH 先の環境変数の件（上の節）が残っているため
- Windows は常駐を使っていないので何もしない（upstream の保存・復元がそのまま働く）。保存の仕組み自体は OS に依存しないので、上の「開けるときの筋道」で Windows の常駐を開ければそのまま効く

### xterm の IME パッチ（TM16）

`build/npm/paradisXtermImePatch.ts` が postinstall で、`node_modules/@xterm/xterm/src/`（配布物に同梱の beta.304 のソース）へ `build/npm/paradisXtermIme/xterm-ime.patch` を当て、esbuild でバンドルし直して `lib/xterm.js`（UMD で包む）と `lib/xterm.mjs` を置き換える。差分は Orca（MIT）の `@xterm__xterm@6.1.0-beta.303.patch` のうち IME の src 部分（CompositionHelper / CoreBrowserTerminal / Types / WidthCache の export）だけ。Orca の lib/ は beta.303 のビルド結果なので使えない。無関係な SortedList の修正は外した。

- **xterm を上げたら**: `PARADIS_XTERM_IME_TARGET_VERSION` と違う版には当てない。手元の install では警告だけ出して素の xterm で動き、**CI（環境変数 `CI`）では install を失敗させる**（当たらないまま配布物を作ると日本語入力の修正が黙って抜ける）。新しい版の `src/` に `git apply --check` が通るか確かめ、通れば版の定数を書き換える。通らなければ Orca の新しいパッチから作り直す（merge-upstream スキルにも書いた）
- 当てたかどうかは `lib/xterm.js` の先頭の印（`v2`）で見る。npm が入れ直せば印ごと消えてまた当たる。印の版を上げると、前の版で作り直したものも作り直す（`src/` が当てた後のものなら逆向きの `--check` で確かめてそのまま使う）
- Orca の MIT の表示は、作り直したバンドルの先頭（esbuild の banner）、パッチファイルの冒頭、`ThirdPartyNotices.txt` の3か所に入れてある
- パッチは `_inputEvent` の先頭に IME の確定を送る経路を足すので、スペース切り替え中の入力ゲートが素通りされうる。`terminalIme/browser/paradisTerminalImeInputGate.contribution.ts` が、ゲート中は xterm の要素のキャプチャ段階で `input` を止め、ゲート中に始まった変換（`compositionstart` / `update` / `end`）も丸ごと xterm に見せない（変換の確定で文字を送る素の xterm の経路もこれで止まる）。ゲートの前から続いている変換だけは、途中で止めると xterm が変換中のまま残るので通す
- Web ビルド（`remote/web` の xterm）には当てていない
- パッチには不可視文字（U+200E）と2スペースのインデントが入るので、`build/filters.ts` の unicode / indentation の検査から `build/npm/paradisXtermIme/**` を外してある

## 通知の受信箱・Dock の件数・メニューバーのアイコン（notificationInbox、2026-09-27、フェーズ4）

エージェントの完了・許可待ち・質問の通知は、これまでどおりペインを持っているウィンドウの renderer が1件ずつ鳴らすかを決める（`paradisNotificationTrigger.contribution.ts`）。その結果を、鳴らさなかったもの（見ていたスペース・おやすみモード）も含めて shared process の台帳へ書く。台帳は `contrib/notificationInbox/common/paradisNotificationInboxLedger.ts`（I/O なし）で、shared process の登録口から `paradisNotificationInbox` チャネルとして出している。タイトルバーのベル、Dock の件数、メニューバーのアイコンはどれもこの台帳だけを読む。

- 台帳は shared process のメモリにだけある。ウィンドウの再読み込みでは残り、アプリの終了で消える。上限 200 件
- **台帳の鍵はペイントークンではなく、その SHA-1（`paradisInboxPaneKey`）。** 台帳は全ウィンドウへ配られ、ペイントークンは MCP の認証にも使う秘密なので、他のウィンドウへ渡さない。持ち主のウィンドウは手元のトークンを同じ方法でハッシュして突き合わせる
- 件数は「確認していないペインの数」（通知の件数ではない）。未読の行があり、いまどれかのウィンドウに開いているペインだけを数える。開いているペインは各ウィンドウが接続ごとに知らせ、接続が切れたら外す。接続名（`window:<id>`）は再読み込みでも変わらないので、同じ接続名がまだ繋がっていれば外さない
- 既読になるのは、行を押したとき・「このペインの通知を既読にする」、ペインへフォーカスしたとき、ペインの状態が通知の種類から変わったとき（完了はスペースを見て確認済みになった＝`acknowledgePaneStatus` か次の作業を始めたとき、許可待ち・質問は答えたとき）。台帳はペインごとに最後の状態を覚えていて、状態の知らせより遅れて届いた記録は最初から既読で入れる
- 行を押したときの移動は台帳経由でペインを持っているウィンドウへ届け、そのウィンドウがフェーズ1の `paradisRevealNotifiedPane` で前に出てスペースを切り替える
- 音と読み上げは発言を待たずにすぐ鳴らす。OS 通知の本文と台帳の記録だけが、中継の `getAgentPaneInsights` を待つ（全体で 1.5 秒まで、取り直しは本文を載せるときだけ）。完了の発言は、そのターンの作業が始まった時刻（直前の状態の `changedAt`）より後のものだけを使い、古ければ載せない
- 通知と受信箱に出す文は伏せ字を通す（`paradisRedactSecrets`）。伏せるのは、Bearer / Basic の値、大文字の環境変数 `*_KEY` / `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_DSN` などの右辺、`api_key:` や `password=` の右辺、`--password` / `--api-key` などの引数、`mysql -p<値>`・`docker login -p`・`curl -u user:pass`・空白区切りの `aws_secret_access_key <値>`、既知の形のトークン（`sk-`・`sk_live_`・`ghp_`・`github_pat_`・`AKIA`・`xox?-`・`AIza`・`npm_`・`glpat-`・`hf_`・JWT）、URL の認証情報と Sentry の DSN のキー、Slack / Discord の webhook、PEM の秘密鍵、切り詰めの境目に残った既知の接頭辞の断片。値として伏せるのは ASCII の文字だけで、引数は行頭か空白の直後のものだけ（日本語の文や `--sort-key` のような引数を消さないため）。許可待ちは「ツール名: 伏せ字を入れた要約」。形の決まっていない秘密は拾えないので、本文そのものを切る設定（`paradis.notifications.osIncludeMessage`、既定オン）を残している。受信箱の外（フェーズ3のエージェントの様子のホバー）は伏せ字を通していない
- Dock の件数は、おやすみモードの間は出さない（受信箱とベルには残す）。OS 通知だけを切っている人の分（`silent`）は数える（要対応には違いないため）

- 【要確認】アプリの再起動で復元されたターミナルに `PARA_CODE_TERMINAL_PANE_ID` が入っていなかった（新規ターミナルには入る。2026-09-27 のフェーズ4の実機確認で見つけた、フェーズ4とは別の件）。hook がペインを特定できず、そのペインの通知が届かない可能性がある

upstream 取り込みで壊れやすいのは次の4点。

- **Dock の件数は upstream の `setApplicationBadge` に乗っている。** main の `DockBadgeManager`（`windowImpl.ts`）がウィンドウごとの数を足し合わせる前提で、各ウィンドウは自分のペインの分だけを出している（全体の数を出すとウィンドウの数だけ掛け算になる）。Agent Sessions ウィンドウの `SessionsApplicationBadge` の数も同じ合計に足されるので、両方を開いていると Dock の数字は「確認が必要なペイン＋Sessions の件数」になる。**Windows はアプリ全体の数ではなく、ウィンドウごとにタスクバーへそのウィンドウの分を重ねて出す**（upstream の `setOverlayIcon`）。`app.setBadgeCount` を直接呼ぶと `DockBadgeManager` と取り合うので呼ばない
- **メニューバーのアイコンは main で作る**（`electron-main/paradisNotificationTrayMain.ts`、既定オフ）。`app.ts` の PARA-PATCH は import 1行と登録1行。`Tray.setImage` / `setContextMenu` は AppKit のコールバックの中で呼ぶと main が固まることがある（Orca の知見）ので必ず `setImmediate` で次の周回に回す。絵は PNG を同梱せずコードで描いている（`paradisRenderTrayBell`）。Linux は作らない。依頼の宛先は Agent Sessions ウィンドウ（fork の通常ウィンドウ向け機能を読み込まない）を除いて選ぶ。ウィンドウが1つも無くなったら中身を空にし、「アイコンを隠す」は main ですぐ消して、設定の書き換えは次に中身を送ってきたウィンドウに頼む
- **受信箱のポップオーバーを内蔵ブラウザの上に出すため**、`overlayManager.ts` の `OVERLAY_DEFINITIONS` に `paradis-notification-inbox-popover` を PARA-PATCH で足した。z-index はタイトルバーのポップオーバーと同じ 2500（モーダル 2575 より下）。ベルが1つ増えたぶん、upstream がタイトルバー中央のツールバーごと隠す幅（`titlebarPart.ts` のはみ出し判定）が広がり、「エージェント一覧」「ブラウザ一覧」も早めに消える。件数が出たときに幅が変わってはみ出し判定がずれないよう、バッジの枠は常に確保している
- **音声入力中に読み上げを止める仕組みは、upstream のチャットの内部モジュールに依存している。** `workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js` の `ChatSpeechToTextState`・`state`・`isPreparingModel`・`onDidChangeState`・`onDidChangePreparingModel`（と `ISpeechService` のセッション）。チャットは upstream の変更が多いので、取り込みのたびにこれらが残っているかを確かめる。`isBusy` は使わない（停止の途中も busy のまま知らせずに消えるので、音声入力中から戻れなくなった。2026-09-27 に修正）

### 内蔵の音声入力の配布（既定では無効）

upstream のディクテーションは Foundry Local のネイティブ部品を使うが、パッケージングで `node_modules` から削られ（`getFoundryLocalExcludeFilter`）、初回に `product.json` の `dictationRuntime.urlTemplate` から取ってくる前提になっている。この値は upstream では Azure Pipelines の手順（`build/dictation-runtime/produce.ts`）が書き、Para Code のリリースでは誰も書いていない。そのため今の配布版ではマイクのボタンは出るが押すと失敗する見込み（推測。実機未確認）。

- **ライセンス: 取ってくる部品は MIT ではない。** MIT なのは JS の `foundry-local-sdk` だけで、実行時に落とす `Microsoft.AI.Foundry.Local.Core` は "MICROSOFT SOFTWARE LICENSE TERMS / FOUNDRY LOCAL CORE"（nuspec は `requireLicenseAcceptance=true`）。利用権は「自分のアプリの開発とテスト」、再配布には利用者に同等の条項へ同意させることと Microsoft への補償が要り、Microsoft へのデータ収集がある（アプリ名 `vscode-dictation` で報告）。取得元も VS Code 製品用の `main.vscode-cdn.net`。Para Code の利用者に配ってよいかは【要確認】（ユーザーの判断待ち）
- そのため `para-release.yml` のスタンプの段は、手動実行の入力 `dictation_runtime`（既定 false）を立てたときだけ走る。タグの push では走らない。立てたときは、スタンプした版が CDN に 4 ターゲットぶん（darwin-arm64・win32-x64・win32-arm64・linux-x64）あるかを `curl -fsI` で確かめる（`foundry-local-sdk` を上げると URL の版も変わるため）
- ダウンロードした `.node` / dylib はハッシュを照合せずに読み込まれ（upstream の `foundryLocalRuntime.ts`）、Plugin helper は `disable-library-validation` 付き。CDN（HTTPS）を信頼の根にしている
- **部品の取得先（`dictationRuntime`）が無いビルドでは、音声入力そのものを既定で無効にしている**（`contrib/dictation/browser/paradisDictationAvailability.contribution.ts` が `dictation.enabled` の既定値を false にする）。upstream の既定 true のままだと、dev と既定の配布版でマイクのボタン・コマンド・キーが出て、押すと約 775MB のモデルを `user-data/chatDictationModels` に落とした後、`Foundry Local transcription stream stalled for 60000ms` で失敗していた（1.139 取り込み以降の main でも同じ。2026-09-27 実機で確認）。チャット・エディタ・ターミナルの入口とモデル取り込みコマンドはどれもこの設定で閉じる。settings.json で自分で true にした人は対象外。Agent Sessions ウィンドウはこの集約ファイルを読み込まないので既定 true のまま
- upstream の音声入力は、モデルの準備中（「Preparing…」）に Esc を押しても止まらず、準備が終わるまで音声入力中のまま（読み上げの保留も続く）。upstream の挙動
- macOS の x64 は upstream が対応していない。Linux は glibc 2.34 以上。マイクが出る条件は `chatIsEnabled`（`chat.disableAIFeatures` で消える）。macOS のマイク許可ダイアログの本文は `build/darwin/sign.ts` が書く "Visual Studio Code" 表記のまま（有効化するときに直す）

音声入力の間は Para Code の読み上げを止める（`notifications/electron-browser/paradisDictationAudioHold.contribution.ts`、音声入力を配布していなくても拡張機能や開発版の音声入力で働く）。shared process の `AudioScheduler.setHeld` が、再生中の afplay 等を止め、通知音を捨て、新しい発話を溜めて終わってから読む。止めるのはどれか1つのウィンドウでも音声入力中のとき（接続ごとに持ち、接続が切れたら外す。ウィンドウは起動時に自分の状態を送り直し、音声入力中は状態が動くたびに送り直す）。上限はウィンドウごとに 10 分で、過ぎたウィンドウだけを外す（モデルの初回ダウンロード中や、upstream のセッション数が戻らなかったときに通知が鳴らなくなり続けないため）。**Agent Sessions ウィンドウの音声入力では止まらない。** この仕組みは通常ウィンドウの集約ファイルからしか読み込まれず、Sessions ウィンドウのチャット入力にマイクが出るかは【要確認】（出るなら Sessions 側からも読み込む）。**外部の aivis-mcp は止めていない。** 止める口（`aivis --mute`）がおやすみモードと共有で、解除のときにおやすみモードのミュートやユーザー自身のミュートまで解いてしまうため。

## 定期実行とスキル管理（2026-09-27、フェーズ8 担当B、O3・O6）

### 定期実行（`src/vs/paradis/contrib/scheduledRuns/`）

時刻の判定と記録は shared process（`node/paradisScheduledRunsService.ts`、登録口経由）、起動と見張りはウィンドウ（`electron-browser/paradisScheduledRunsRunner.contribution.ts`）が持つ。upstream の変更は `overlayManager.ts` の1行（下の「内蔵ブラウザの裏に隠れない」）だけ。

- 保存先は `<userData>/paradis/scheduledRuns.json`（フォルダ 0700、ファイル 0600。指示の本文が入るため）。定義の中身の指紋（鍵の無い sha256）を `scheduledRuns.digest.json` に別に書き、読み込んだときに指紋が合わない有効な定義は無効に戻す。**防げるのは定義のファイルだけを書き換えた・書き足した場合まで**で、両方を書き換える相手（指紋の作り方を知るスクリプト・エージェント）は防げない。鍵で守るにはキーチェーン等が要り、shared process からはまだ使えないため見送った。読み込んだ定義は保存と同じ検証にかけ直し、通らないものは無効にして回数を範囲に収める。無効に戻したときはログに出し、定義に理由（`disabledReason`）を付けて画面に「無効（要確認）」と注意を出す（有効にし直すか保存すると消える）。指紋のファイルを消すと、有効な定義はすべて無効に戻る。記録は状態・きっかけ・時刻の型まで確かめ、合わないものは読み込まない。30 秒ごとに判定し、記録が変わったときだけ書く。判定した時刻（`lastEvaluatedAt`）は記録と一緒にしか書かないが、時刻が来れば必ず記録（実行かスキップ）が増えるので、起動し直しても同じ時刻を2回実行しない
- 時刻は 5 項目の cron 式をローカル時刻で解釈する自前の実装（`common/paradisScheduleCron.ts`）。画面の選択肢（毎日・平日・毎週・数時間ごと）は cron へ落とす。タイムゾーンは持たない（Orca も保存するだけで計算には使っていない）
- 安全装置の判定は `common/paradisScheduledRuns.ts` の純粋な関数: 作成直後は shared process が必ず `enabled: false` で保存／同じ定義の実行が開始待ち〜要対応の間は次の時刻を「スキップ（重複）」／1 日の回数（既定 3、1〜24、ローカル時刻の 0 時区切り、スキップは数えない）／最短 15 分（式の検証と、前の回から 15 分たっていない時刻のスキップ）／起動から 30 分で打ち切り。**手動の「今すぐ実行」は重複と全体の同時数だけを止め、回数と間隔では止めない（その定義の 1 日の回数には数えるが、全体の 30 回には数えない）**。全体では同時に 3 本（開始待ちは数えず、ウィンドウが `claim` するときに空きを確かめる。空きが無ければ開始待ちのまま次の判定で配り直す。どのウィンドウも開いていないリポジトリの回がほかを止めないように）、1 日に自動で始めるのは合計 30 回まで（`globalConcurrency` / `globalDailyLimit`）。回数は予定の時刻の日付で数える（23:50 の回を 0:05 に後から実行しても前の日に数える）。最短間隔は、予定の時刻どうしが 15 分未満か、実際に記録を作った時刻どうしが 12 分（15 分から判定の遅れ 3 分を引いたもの）未満なら止める。予定どうしで比べるのは判定の遅れで `*/15` が落ちないため、作成時刻でも比べるのは後から実行する回（予定の時刻が古い）が直前の回とくっついて走らないため
- 逃した時刻: 一番新しい 1 回だけを候補にし、12 時間以内なら実行（遅れが 3 分を超えたら「後から」と記録）、それより前で 12 時間以内の分はその 1 回にまとめ、12 時間より古い分は件数ごと 1 件の「スキップ」にする。有効にした時点・時刻を変えた時点より前は見ない
- 実行の受け渡し: shared process が「開始待ち」を作ってイベントで配り、対象のリポジトリ（`URI.toString()` の一致）を開いているウィンドウが `claim` する。先に取れた 1 つだけが実行する。誰も取らなければ判定のたびに配り直し、開いたばかりのウィンドウも起動時に開始待ちを聞くので、**ウィンドウが 0 枚なら次に開いたウィンドウが拾う**。予定から 12 時間（遅れて作った開始待ちは作成から最低 1 時間）拾われなければ「スキップ」
- 見張り: ウィンドウは 1 分ごとに生存報告を送る。3 分途絶えたら shared process が「不明」にし、受け持ちのウィンドウへ停止を頼む。生存報告は受け付けなかった実行の id を返し、ウィンドウはそれを受けてターミナルを閉じる（記録の上で終わった回が動き続けて重複の安全装置が外れないように）。判定の間隔が 90 秒より空いたらスリープからの復帰とみなし（生存報告は 60 秒おきなので、最後の報告からの経過が 150 秒以下に収まり、リース 180 秒に 30 秒の余裕が残る）、その回はリース切れを数えずに生存報告の時刻を今へ寄せる。ウィンドウ側の 30 分の打ち切りは `setTimeout` に加えて生存報告のたびに壁時計でも確かめる（スリープ中は `setTimeout` が進まないため）。制限時間 + 5 分を過ぎても終わりの報告が無ければ shared process 側でも「時間切れ」にし、受け持ちへ停止を頼む。アプリを起動し直したときに残っていた実行中の記録は「不明」、開始待ちは「取りやめ（アプリを終了した）」にする（ファイルに開始待ちを書き足して、安全装置を通らずに起動させないため）。定義を消した後に「不明」「時間切れ」になった記録は次の判定で消す
- 起動はフェーズ1の起動 API をそのまま使う（`paradisLaunchAgentInWorkspace` / `paradisRunWorktreeCreateFlow` の `switchToCreated: false`）。新しいスペースでは、手で作るときと同じく setup スクリプトと自動実行プリセットも走らせる（判断: どちらも利用者が自分のリポジトリに設定したもので、作ったスペースを動く状態にするのに要る。リポジトリ側の `.paracode.json` のプリセットは承認の署名が無ければ走らない）。**指示はエージェントの起動引数で渡す**（`paradisBuildAgentCommand`）。フェーズ5の「貼り付けで入れる」プリセットは、すでに動いているエージェントへ足すためのもので、毎回新しく起動する定期実行では使っていない
- 完了の判定はペイン単位の状態（`IParadisAgentStatusStore.getInstanceStatus`）で、`review` を見たら完了（`common/paradisScheduledRunWatch.ts`）。利用者がそのスペースを見ているときは画面側が `review` をその場で既読にして状態から消すので、見張りには `review` が見えない。そのためステータスストアに「既読にして消した」印（`wasReviewAcknowledged`。`paradisAgentStatusSnapshotConsumer` が `setInstanceStates` の 3 番目の引数で渡す。次の状態が届くと消える）を持たせ、これが立っていれば完了とする。**印が無く状態が消えただけでは完了にしない**（画面側は状態の取得に続けて失敗すると全ペインの状態を消すので、作業中の回を完了にして見張りを外してしまう）。`permission` / `question` の間は「要対応」。**要対応の通知は既存のペイン単位の通知（PC のトーストとモバイル）がそのまま出す**ので、定期実行側からは通知を足していない（二重になるため）。完了してもターミナルは閉じない。hook が届かない環境では状態が来ないので、30 分で「時間切れ（状態が届かなかった）」になる
- ウィンドウを閉じる（再読み込みを含む）ときは、そのウィンドウで動いている定期実行のターミナルを閉じて「停止」と報告する。見張りの無いまま動かし続けないため。【要確認】常駐ターミナル（pty デーモン）を使っているときに本当にプロセスまで止まるか
- 最後の発言と会話 ID: ウィンドウが起動直後にペイントークンを shared process へ渡し（メモリだけに持ち、記録には書かない）、shared process が hook のバス（`onParadisAgentHookEvent`）から Stop の `last_assistant_message`（先頭 400 文字）と `session_id` を拾う。トークン数と推定コストは、画面を開いたときに ccusage の `fetchRecentSessions`（使用量ダッシュボードと同じ 90 日の指定でキャッシュを分け合う）を会話 ID で引く。**Codex の回は出ない**（ccusage のセッション一覧が Claude Code だけのため）
- 毎回新しいスペースを作る設定のスペースは、記録の `space` で覚える（ブランチ名は `scheduled-<定義 id の先頭6字>-<月日>-<時分>`）。新しい 5 件より古いものを片付け候補に出し、「削除…」は既存のワークツリー削除コマンド（確認・teardown つき）に任せる。記録の上限（1 定義 100 件）で消すときはスペースを持たない終わった記録から消し、それでも 200 件を超えたらスペースを持つ記録も古い順に消す（外で消されたスペースの記録が際限なく溜まらないように）。片付け候補は、まだあるスペースに絞ってから新しい 5 件を除く
- モーダルの重ね順は 2570（ワークベンチのモーダル 2575 の下）。削除の確認に `IDialogService` を使うため。通知のトースト（2545）は下に隠れるので、結果はモーダルの中に出す
- 担当A（操作ツール）との関係: 「エージェントを起動する」はどちらもフェーズ1の起動 API。「終わったか」の判定は**意図して別々に持つ**。agentIde の `ParadisAgentStopWatcher` は「相手の番が終わったか」を見るので許可待ち・質問中も止まったとみなし、状態が無い相手は猶予で止まったとみなす。定期実行の `paradisAdvanceRunWatch` は許可待ちを「要対応」として見張り続け、状態が無い・消えただけでは完了にしない（30 分の打ち切りで「状態が届かなかった」と記録する）
- 指示は保存のときに制御文字を落とし、起動のときに改行とタブも空白にして 1 行にする（`paradisScheduledRunLaunchPrompt`）。シェルごとの引用は起動 API 側（`paradisBuildAgentCommand`）の担当
- 内蔵ブラウザの裏に隠れない: 定期実行とスキルのモーダルの backdrop には共通の印 `paradis-modal-backdrop` を付け、`overlayManager.ts` の `OVERLAY_DEFINITIONS` にこの1つだけを登録した（PARA-PATCH）。**今後の fork の DOM モーダルは backdrop にこのクラスを併記すれば、`overlayManager.ts` を触らずに済む**
- 未対応: 事前チェックのコマンド（Orca の precheck）、実行前に前回の端末を使い回すこと、SSH の接続先だけにあるリポジトリをウィンドウを閉じた後に動かすこと（接続中のウィンドウが拾えば動く）

### スキル管理（`src/vs/paradis/contrib/skillsManager/`）

歯車メニュー「スキル」のモーダル。読み書きはすべて `IFileService` で行う（`common/paradisSkills.ts`）。手元（file）・SSH の接続先（vscode-remote）・WSL（Windows から見た UNC）を同じ手順で扱える。upstream の変更は定期実行と共通の `overlayManager.ts` の1行だけ。

- 見るフォルダ（`electron-browser/paradisSkillRoots.ts`）: この PC の `$CLAUDE_CONFIG_DIR`（無ければ `~/.claude`）`/skills`、`$CODEX_HOME`（無ければ `~/.codex`）`/skills`、`~/.agents/skills`、このウィンドウの手元のリポジトリの `.claude/skills` と `.agents/skills`。環境変数はシェルの環境（`process.shellEnv()`）から読み、絶対パスのときだけ使う。SSH は**このウィンドウが接続しているときだけ**、ホームは接続先から受け取ったものだけを使う（`paradisRemoteUserHome`）。接続先の `$CLAUDE_CONFIG_DIR` などは見ない。WSL は Windows で WSL の中のリポジトリを登録しているときだけ、そのディストロのホームを見る。Claude Code のプラグインのスキルは見ない（Q81 の範囲外）
- スキルはフォルダの直下の `<名前>/SKILL.md`。frontmatter の `name` / `description` を読む（無ければ見出しと最初の段落）。Codex の `skills/.system/` は同梱として一覧に出すが消させない
- 各フォルダは `realpath` で実体を解き、実体が同じフォルダ（`~/.claude/skills` → `~/.agents/skills` のリンク、ホームをリポジトリとして登録した場合など）は先に並んだ方にだけスキルを出す（`paradisDedupeSkillListings`）。同じスキルを2か所に出すと、片方の削除で両方が消えることが分からないため
- 削除と導入は、ボタンを押して `IDialogService` の確認に「はい」と答えたときだけ。削除は直下のフォルダだけを受け付け、表示後にリンク／フォルダが入れ替わっていたら止める。ごみ箱が使えるマシン（手元）ではごみ箱へ移す。リンクはリンクだけを消す。親がリンクで実体が別の場所にあるときは、確認に実体のパスを出す
- 導入は、スキルのフォルダ自体がリンクなら実体を写す（同じプロバイダ内のコピーはリンクをそのまま複製するため）。**フォルダの中にリンクがあるスキルは導入しない**（マシンをまたぐ写しはリンクをたどるので、`x -> ~/.ssh` の中身を接続先へ送りうる）。隣の一時フォルダ（名前に乱数を含む）へ写し、写したものと元をもう一度調べてリンクが増えていないか確かめてから、既にあるものを退避して入れ替え、成功したら退避を消す。入れ替えに失敗したら途中まで置かれたものを外して退避を戻す。戻すのにも失敗したときは退避の場所をエラーに出して残す（消さない）。調べてから写すまで・確認してから消すまでの間の変化は、写した後の再検査と削除直前の再確認で狭めているが、完全には防げない。40MB・2000 ファイルまで。`realpath` の結果は Windows ではネイティブ形式なので URI 形式へ直し、手元のパスは大文字小文字を区別せずに比べる（【要確認】Windows 実機は未確認）。確認には写す元と導入先を出し、リポジトリの中のスキルをユーザー単位へ入れるときは注意を出す
- 未対応: 接続していない SSH ホストへの導入（読み取り専用の `IParadisRemoteHostBrowser` しか無いため）、WSL の中の `$CODEX_HOME`、スキルの更新通知（Orca の同梱スキル向けの機能）

## デスクトップのチャット（agentChat、2026-09-27、フェーズ6）

エディタエリアのターミナルタブを `⌘⇧J` で同じ会話のチャット表示に切り替える（C1、Q29〜Q32 すべて案A）。upstream のファイルは1行も触っていない。コードは `src/vs/paradis/contrib/agentChat/` にまとめ、モバイル中継とは次の3か所だけでつながる。

| 部品 | 場所 | 中身 |
|---|---|---|
| 会話の型と transcript の正規化 | `agentChat/common/paradisAgentChat.ts`・`paradisAgentTranscriptParser.ts` | `paradisMobileAgentChat.ts` から切り出した（中身は変えていない）。中継は再公開しているので、既存のテストの import はそのまま |
| デスクトップ向けの読み取り口 | `ParadisMobileAgentChat` の `watchDesktopChat` / `getDesktopChat` ほか | 中継のチャネル `PARADIS_MOBILE_RELAY_CHANNEL` に `IParadisAgentChatSource` として載る。モバイルへは何も送らない |
| TUI への打鍵 | `agentChat/browser/paradisAgentTuiInput.ts`、`paradisAgentApprovalKeySequence` | モバイルの renderer 側（`paradisMobileWorkspaceProvider.ts`）から切り出した。質問のキー列・目印待ち・許可のキー列はモバイルと同じ関数を通る |

- **会話はモバイルと同じ tailer から引く**（Q29）。画面は差分（epoch + rev）で取り、中継は「見られているペインの指紋が変わった」ときだけトークンを知らせる（80ms でまとめる）。取りこぼしに備えて、表示中のチャットは 5 秒ごとに取り直す。tailer が持つのは直近 400 件だけなので、それより前は「省略しています」と出してターミナルへ案内する
- **ウィンドウは自分のペインを 10 秒ごとに `watchAgentChat` で送り直す**（中継の期限は 30 秒）。見られているペインでは、モバイルとつないでいなくても AskUserQuestion と許可要求を hook から tailer へ入れる（Claude Code は質問を回答されるまで transcript に書かないため、入れないとカードを出せない）。**モバイル向けの注入が動いていない（リレー無効かペアリング無し）ときに入れたものは、以前の振る舞いを変えない印を付ける**。質問はモバイルへの通知を出さず（`injectLiveQuestions(..., quiet)`）、承認はペインの状態（許可待ちの表示、`hasPendingApproval`）とスペース一覧の「待っている内容」に数えない（`injectApprovalRequest(..., desktopOnly)`）。tool_use_id の無い承認は合成 id になってターン終了まで解けないので、数えると作業中のペインが「許可待ち」のまま残る
- 重ねる先は共有ドットと同じ `paradisRegisterEditorTerminalOverlay`。チャットの間はコンテナに `paradis-agent-chat-active` を付けてターミナルの画面を `opacity: 0` にする（ウィンドウの透過で下の文字が透けないように）。`visibility: hidden` にすると xterm がフォーカスを受けられず、下のフォーカスの付け替えが働かない。z-index は 34（xterm と検索ウィジェットより上、共有ドットとキャッシュの残り時間の 35 より下）
- **チャットの上の mousedown / mouseup / contextmenu は親へ流さない**。`TerminalEditor` はエディタ全体の mousedown でターミナルのクリック動作（右クリックの貼り付けなど）を行うため
- `TerminalEditor` はタブを選ぶとターミナルへフォーカスを戻す。チャットの間は `instance.onDidFocus` で入力欄へ移し直す（打った文字がシェルへ流れないように）。`⌘⇧J` は `DEFAULT_COMMANDS_TO_SKIP_SHELL` へ起動時に追記している（terminalFontZoom と同じ）
- 送る前に、質問・許可の確認を待っていないことを中継から取り直して確かめる（待っている TUI に文字を流すと先頭が選択肢として食われる）。質問・許可の回答は、各キーの直前に「まだ同じものを待っているか」を中継から取り直し、変わっていたら残りを送らない。打鍵の前にはモバイルと同じ `interactionClaims` を取り（`claimAgentChatInteraction`）、1つでも打鍵したら 60 秒（質問の決着・ターン終了まで）同じものへは打ち直させない。画面側も送り終えたカードは押せないままにし、この画面から答え終えた interaction は中継が消すのを待たずに文を送れるようにする。Codex の app-server 経由の承認（`codex:`）はキーではなく `answerAgentChatApproval` で返す
- 既知の制約: Claude の許可は「許可」「拒否」だけ（「以後は確認しない」はキー列を実測していないので出していない）。チャット表示かどうかはウィンドウを再読み込みすると忘れる。SSH 接続先のペインではスラッシュコマンドの候補が出ない（手元の設定から作らないため）。P3（メッセージレール、計画、サブエージェント、タスク、Codex goal、区切り表示）は未実装
- **【要確認】実機での確認はまだ**（CSS の見え方、IME、⌘⇧J がターミナルにフォーカスがあるときに効くか、質問への回答が TUI に入るか）

## HTML プレビューの読み取り範囲（2026-08-21、未解決の課題として記録）

HTML プレビューは、ファイルの属するワークスペースフォルダーを 127.0.0.1 のローカルサーバへ載せ、
`<base href>` をそこへ向ける（`src/vs/paradis/contrib/fileViewers/node/paradisHtmlPreviewServer.ts`）。
SSH 先のファイルも、リモート側の同じサーバ＋ポート転送で同様に配る。

**このとき、プレビューしているページはワークスペース全体を読める。** ビューアは `allowScripts: true`
で、サーバは `Access-Control-Allow-Origin: *` を返すため、ページ内のスクリプトが `fetch` で任意の
ファイルを読み、外部へ送ることが原理的に可能。トークンとループバック限定で「他プロセスから」は
守られているが、**プレビューしているページ自身からは守られていない**。

重要なのは、**webview の `localResourceRoots`（従来 service worker が効かせていた範囲制限）が
この経路には一切効かない**こと。service worker を経由しなくなったので、あの制限は素通りする。

読み取りを許す相手は `vscode-webview://` からのリクエストだけに絞ってある（応答の
`Access-Control-Allow-Origin` を `*` にしない）。**ここを `*` に戻してはいけない。** トークンは
`<base href>` としてページに渡るので、ページにとって秘密ではない。`*` だと、トークンを外へ
持ち出された後に**別のブラウザのタブから** `fetch` で中身を読めてしまう（Para Code の外から
読める）。PDF / Word は1ファイルしか要らないので、フォルダーではなくファイルを載せる
（`~/x.pdf` を開いただけでホーム全体が配信対象にならないように）。

現状の判断: 「自分のワークスペースの .html を自分で開く」前提では実害が薄いため、この形で進めた。
ただし信頼していないリポジトリを開く場合は別で、Workspace Trust と連携させるか、載せる範囲を
文書のフォルダー配下に狭める（`../` 参照は諦める）かの判断が要る。**忘れると後から誰も気づけない
性質の課題なのでここに残す。**

**未解決**: 載せたフォルダーは解放されない（ペインを閉じてもアプリを再起動するまで残る）。
上の CORS 制限で「外から読まれる」経路は塞いだが、寿命をペインに合わせるのは別途必要。

## mainプロセスの静的importはパッケージ版だけ壊れる（2026-08-23、2度目の被弾で恒久ガード）

パッケージ版の Electron main は ASAR の中から ESM で読み込まれる。**Node の ESM ローダーは ASAR 内の
node_modules を解決できない**ため、main のトップレベル import グラフが素の npm 依存に届いた時点で
`ERR_MODULE_NOT_FOUND` になり、アプリが起動しない。dev ビルド（`out/` を直接読む）では ASAR を
経由しないので**まったく再現しない**。ビルドも通る。気付けるのはパッケージ版を実際に起動した時だけ。

これまで2回踏んでいる。

1. **paracode-68**: `@sentry/electron/main` を静的 import していた。`import type` + 動的 `import()` へ
   直して解決（`paradisSentryMain.ts` のコメント参照）
2. **2026-08-23**: `electron-main/paradisPtyHostStarterFactory.ts` が env 変数名の定数ひとつを
   `node/paradisPtyHostBootstrap.ts` から import しただけで、
   `paradisTerminalProcessFactory.ts` → `platform/terminal/node/terminalProcess.ts` → `node-pty`
   と辿ってしまっていた。定数を `common/paradisPtyHostPaths.ts` へ移して解消

どちらも「1行の import を足しただけ」で起きており、レビューでも見落とされた。人の目では追えないので
`src/vs/paradis/test/node/paradisMainProcessImportGraph.test.ts` が main の入口から import グラフを
辿り、**許可した依存以外へ静的に到達しないこと**を検査する（`export ... from` の再エクスポートも辿る）。
禁止リストではなく許可制なのは、次に踏むのが `node-pty` でも Sentry でもなかった場合を取り逃さない
ため。main が新たに外部パッケージを触る必要が出たら、同ファイルの `ALLOWED_PACKAGES` に足す——
そのとき「パッケージ版（ASAR 内）でも解決できる」根拠を必ず確認すること。

**実装時の指針**: `electron-main/` からは `common/` と `electron-main/` だけを見るのが安全側。`node/`
の何かが欲しくなったら、まずその値を `common/` へ動かせないか検討する。ネイティブ依存を main で使う
必要が本当にある場合は、`import type` で型だけ取り、実体は関数の中で動的 `import()` する。
なお `paradisDaemonPtyHostStarter.ts` と `paradisPtyDaemonStatusService.ts` には、常駐の台帳・認証・
制御クライアントを読むための `electron-main/` → `node/` の import が残っている（いずれもネイティブ依存を
持たない葉）。これらは上記テストの探索範囲に入っているので、その先に外部依存が生えれば検出される。

## ビルド環境（macOS / Apple Silicon）

- Node: `.nvmrc`が指定する`24.17.0`を`mise`でプロジェクト固定（`mise.toml`）。システムのNode（v26.3.0）とは別
- 依存関係: `mise exec -- npm install`（約7分、1559パッケージ、致命的エラーなし）
- 開発起動: `mise exec -- bash scripts/code.sh`（初回はElectronダウンロード+コンパイルで時間がかかる。起動確認済み: 2026-07-01）

## GitHub Actions CIの整理（2026-08-25）

upstream由来の`pr.yml`/`pr-node-modules.yml`/`copilot-setup-steps.yml`（と、それらから`workflow_call`される`pr-darwin-test.yml`/`pr-linux-cli-test.yml`/`pr-win32-test.yml`）はMicrosoft社内の自前ランナー（`1ES.Pool=...`、`vscode-large-runners`、`macos-26-xlarge`）を要求するジョブが大半を占める。このforkにはそのランナーが存在しないため、PR・push毎に自動発火してもジョブが永久に`queued`のまま残り続けていた（`pr.yml`内の`para-fork-tests`と`pr-linux-test.yml`経由のLinuxテストだけはGitHub標準ランナーで動く設計だったが、同じファイル内の他ジョブに引きずられる形になっていた）。

- 上記6ファイルと、Microsoft社員個人サービス（`hediet-screenshots.azurewebsites.net`）に依存する`component-fixtures.yml`/`css-order-scan.yml`、fork運用に無関係な`monaco-editor.yml`（npm配布しない）・`require-commit-trailer.yml`（`release/msrc/*`ブランチ運用なし。1.139.1 で upstream がファイルごと削除）・`chat-perf.yml`（手動性能比較）・`sessions-e2e.yml`（元々手動発火のみ）は、**ファイルは変更せず`gh workflow disable`でリポジトリ設定側から無効化**した
- 代わりに`.github/workflows/para-ci.yml`を新規追加。GitHub標準の`ubuntu-latest`のみで完結する軽量CI（typecheck/hygiene/eslint、node.jsユニットテスト、fork独自ワークスペース（`cloudflare/update-server`・`app/mobile`）のtypecheck/test、`extensions/copilot`のtypecheck/lint/unit test）
- `chat-lib-package.yml`・`telemetry.yml`（元からGitHub標準ランナーで完結）と`para-release.yml`・`para-reh.yml`（fork独自のリリースビルド）はそのまま維持

## GitHub API 利用状況が常に100%になっていた件（githubMetrics、2026-09-15）

`GET /rate_limit` のレスポンスボディが実際のカウンタを返さなくなっていた。`gh` CLI（v2.99.0）の仕様変更ではなく、GitHub 側の挙動。同一トークン（`gh auth login` で作られる gh CLI の OAuth トークン）・同一時刻で次のように食い違う。

| 取得元 | used | remaining | reset |
| --- | --- | --- | --- |
| `GET /rate_limit` のボディ | 0 | 5000 | 呼ぶたびに「現在時刻+3600秒」へずれる |
| `GET /user` のレスポンスヘッダ | 113 → 117 | 4887 → 4883 | 1789438679（固定） |

`gh api user` を3回連続で叩くと `X-RateLimit-Used` は 114 → 115 → 116 と正しく増えるが、その直後の `gh api rate_limit` は `{"limit":5000,"used":0,"remaining":5000}` を返す。`gh` を介さず `curl -H "Authorization: Bearer $(gh auth token)" https://api.github.com/rate_limit` を直接叩いても同じなので、CLI 側の問題ではない。`reset` が毎回ずれる点から、カウンタを引けずに新しいウィンドウを返しているように見える。

対応として `src/vs/paradis/contrib/githubMetrics/` を `X-RateLimit-*` ヘッダ方式へ切り替えた。

- `gh api --method HEAD user -i` で `core`、`gh api graphql -i -f query={viewer{login}}` で `graphql` を取得し、ヘッダを `paradisParseGhRateLimitHeaders()` で読む。`search` などその他の資源は、専用のエンドポイントを叩かないとヘッダが取れないため収集対象から外し、ダッシュボードの資源フィルタからも削除した（UI の代表値は元から `core`/`graphql` のみ）
- 既存の `gh` 呼び出し（`paradisWorktreeGitChannel.ts` の `execGh()`）へのピギーバックは不可能。実際に走るのは `gh pr view` などの高レベルサブコマンドで `-i` を付けられず、ヘッダが stdout に出ない。`GH_DEBUG=api` の stderr 解析は `gh` のバージョンで書式が変わるため採らなかった
- プローブ自体が資源ごとに枠を1消費する。ウィンドウ1つなら `STATUS_POLL_INTERVAL_MS`（2分）どおりで core/graphql それぞれ1時間あたり30消費（5000枠の0.6%）。ウィンドウを複数開いて位相がずれると shared process 側の下限 `RATE_LIMIT_MIN_REFRESH_MS`（45秒）まで縮むため、最悪で80消費/時（1.6%）になる
- ユーザーが自分の消費と区別できるよう、`gh api user (rate limit probe)` / `gh api graphql (rate limit probe)` という `callSite` と、専用の仮想スペース `PARADIS_GITHUB_MONITOR_SPACE` で呼び出し内訳に出している。`PARADIS_GITHUB_UNSCOPED_SPACE`（Agent Sessions ウィンドウ）へ混ぜると、監視自身の消費がそのウィンドウの消費として見えてしまう
- `gh api -i` は HTTP エラーでも非0終了しつつヘッダを stdout に出す（`gh: HTTP 404` は stderr）。枠を使い切ったときの 403 レスポンスにも `X-RateLimit-Remaining: 0` と `X-RateLimit-Reset` が載るため、`execGh()` は非0終了でも stdout を捨てない。捨てると「あと何分で戻るか」を最も知りたい瞬間に情報が落ちる
- 片方のプローブだけ失敗した回は、その資源の前回値を残す。ただしリセット時刻を過ぎた前回値は捨てる（窓が回った後の `remaining` は意味を持たず、残すとステータスバーの%と警告色が固まる）
- 将来 GitHub が `/rate_limit` を直したとしても、ヘッダ方式のほうが正確（プローブ分のコストだけが差分）なので戻す必要はない

## 今後の方針候補（未確定、要議論）

- 優先実装ターゲットの選定（機能1〜3のうちfork版でしか解決できない部分から着手すべきか）
- ブランディング（`product.json`のnameShort/nameLong/アイコン等、名称は「Para Code」）
- ~~配布方式（Marketplace代替のOpen VSX方針、CI/署名/配布）~~ → 実装着手済み。詳細は「配布・自動アップデート基盤」セクション参照
