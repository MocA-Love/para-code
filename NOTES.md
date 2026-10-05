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
- 読むのは Claude Code の設定フォルダ（`$CLAUDE_CONFIG_DIR`、無ければ `~/.claude`）の `projects/*/*.jsonl`・`*/<session>/subagents/*.jsonl` と、Codex のホームの `sessions/**/rollout-*.jsonl`。Codex のホームはフェーズ2の `paradisCodexHomes()`（既定のホーム、ログイン済みの `~/.codex-<数字>`、設定 `paradis.limitsMonitor.codexHomes`）を全部読む。切り替えた2つのホームの間では会話ログをハードリンクし合うので、dev と inode が同じファイルは既定のホームに近い方の1つだけにする（inode が 0 のファイルシステムでは突き合わせない）。突き合わせるのは Codex の会話だけで、inode は `lstat` の bigint で比べる（Windows の NTFS の file ID は 2^53 を超えることがあり、number では別のファイルが同じ値に丸まる）。上限（50,000 ファイル）に届いたらログに出す（Claude を先に数えるので、後のホームの Codex が数えられない）。WSL の中を指すスペースは、「スペース別」の問い合わせで渡されたスペースの作業フォルダを `paradisResolveAgentHomes` で解決してディストロ側のホームを覚え、以後の列挙（作業実績・全文索引を含む）でも読む。覚えるのは直近の問い合わせのスペースの分だけで、同じディストロを `\\wsl$` と `\\wsl.localhost` の両方で登録していても1回だけ読む。そのスペースは Linux の表記（`/home/u/repo`）でも突き合わせる。スペース別をまだ一度も開いていない間は、WSL の会話ログは作業実績と全文索引に入らない（作業実績と索引の更新の要求にはスペースが載っていないため。載せるには画面側の変更が要るので見送った）。SSH で接続しているウィンドウでは「スペース別」は出さない（ccusage は接続先を数えるので、手元の会話ログで按分すると合わない）。REH サーバーには登録していない
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

## Claude のアカウントと使用量（limitsMonitor、2026-09-27、claude-swap を撤去）

Claude の使用量の取得・アカウントの保存・PC 全体の切り替えは、shared process の `src/vs/paradis/contrib/limitsMonitor/node/paradisClaudeAccountService.ts` が1か所で持ち、チャネル `paradisClaudeAccounts` で全ウィンドウへ配ります。登録は `ParadisSharedProcessContributions`（`paradisClaudeAccounts.contribution.ts` → `paradis.sharedProcess.contribution.ts`）です。upstream 側は `sharedProcessMain.ts` の既存の PARA-PATCH コメント1行の文言を直しただけです。SSH の接続先（REH）にも同じサービスを動かし、接続先のログインを切り替えます（下の「SSH の接続先での切り替え」）。Codex の分は従来どおり `paradisLimitsMonitorChannel.ts`（接続中は REH）で、レンダラーの `ParadisLimitsMonitorClient.getSnapshot()` が2つを合わせます。

接続先（SSH・WSL・コンテナ・トンネル。`IRemoteAgentService.getConnection()` があるウィンドウ）の Claude は、接続先の Claude Code がいまログインしているアカウントだけを出します（2026-09-29 の決定。手元のアカウントは手元のウィンドウで見る）。Claude Code は接続先で接続先のログインを使って動くので、手元のアカウントを出すと「使用中」も「このアカウントを使う」も `/login` の案内も別のマシンを指していました。実体は `node/paradisClaudeHostUsage.ts` で、REH の `paradisLimitsMonitorChannel.ts` にコマンド `getClaudeHostState` として足しました（`registerParadisLimitsMonitorForServer` が作る。shared process の同じチャネルは「無い」と答える）。`serverServices.ts` 側の変更はありません。

- 読み取り専用: 読むのは `~/.claude/.credentials.json` と `~/.claude.json` の `oauthAccount`（古い版は `~/.claude/.config.json`）だけです。読み取りは `ParadisClaudeLiveAuth` の読むメソッドをキーチェーン無しで使います（`CLAUDE_CONFIG_DIR` は `configDir` で渡し、`.claude.json` は既定の場所と同じく更新時刻と大きさが変わるまで読み直さない）。トークンの更新もファイルへの書き込みもしません。アクセストークンが期限切れなら API を呼ばずに「更新待ち」（`refreshing`）にし、接続先の Claude Code が更新して新しいトークンになったら次の問い合わせですぐ取ります。期限前の 401 も同じく「更新待ち」です。Claude Code は動いている間しか更新しないので、表示は「接続先で claude を起動すると戻る」と書きます（待てば直るとは書かない）
- トークンは接続先から出しません。使用量 API は REH のプロセスから呼び、手元へ返すのは使用率・リセット時刻・メールアドレスと組織名・設定フォルダの表示名だけです
- 間隔は手元と同じ `paradisClaudePlanAfterFetch` / `paradisClaudeFailureBackoffS`（180 秒のキャッシュ、429 の待ち）。予定の取得は持たず、ウィンドウに聞かれて予定時刻を過ぎていればその場で取ります。同じ接続先の複数のウィンドウは REH の1か所で数え、同時の問い合わせは1本にまとめます。SSH のウィンドウでは `onDidChangeClaudeState` を発火させません
- ログインしていなければ `no_credentials`、macOS の接続先で身元はあるのに `.credentials.json` が無ければ（ログインがキーチェーンにある）`unavailable` + `keychain_unavailable` で「SSH 越しには読めない」と出します。接続先では Claude を使っていない・API キーや `CLAUDE_CODE_OAUTH_TOKEN` で使っている・外へ通信できないことがよくあるので、レンダラーは `no_credentials` を `unavailable` + `host_not_logged_in`、`error` を `unavailable` + `host_fetch_failed` に落とし、赤い「!」と再ログインの案内を出しません
- スマホの `limits` の問い合わせで接続先の Claude を返すのは、新しいアプリの使用量の画面が接続先を選び、ウィンドウを名指しして（`ws` が無く `rendererGeneration` がある）`claudeHost: true` を付けたときだけです（`paradisMobileLimitsClaudeFromLocal`。任意項目を足しただけで、`limits` の形は公開ワイヤの型（`paradisMobileProtocol.ts` / `app/protocol`）に無いので同期と golden の対象外）。それ以外は、どのウィンドウに届いても Claude を手元の shared process から返します。ホームとウィジェットはウィンドウを選ばずに問い合わせ、リレーは最初に見つけた ready なウィンドウへ配るので、名指しで決めると SSH のウィンドウに当たったときに入れ替わります。古いアプリの使用量の画面はウィンドウを名指しするものの接続先のログインの表示を知らないので、`ws` の有無ではなくこの任意項目で決めます。新しいアプリはホームとウィジェットでもローカルのウィンドウを名指しします
- レンダラーは `paradisClaudeHostAccountsState` で `claude.remoteHost`（接続先の表示名）を付け、使用中・登録済み・登録できる・claude-swap の案内を落とします。パネルは `remoteHost` があると、見出しに接続先を出し、アカウントの数・追加ボタン・隠すボタン・差し込み部品（切り替え・登録）を出さず、直し方を接続先のターミナルでの `/login` に変えます。モバイルの `limits` 応答はこのスナップショットのままなので、アプリも `remoteHost` を見て同じ出し分けをします。任意項目を足しただけなので capability も golden も要りません（古いアプリは無視し、古い PC は付けないので従来の表示になる）
- 限界: `CLAUDE_CONFIG_DIR` は REH のプロセスの環境にあるとき（絶対パス）だけ使います。シェルの設定でだけ付けている場合は REH に届かないことがあり、そのときは既定の場所を見ます。macOS の接続先のキーチェーンは読みません。REH のプロセスからの HTTPS がプロキシを要る環境は試していません

**SSH の接続先での切り替え（2026-09-30）**: `node/paradisClaudeAccounts.server.ts`（`paradis.server.contribution.ts` から登録。`serverServices.ts` は触っていない）が REH に同じ `ParadisClaudeAccountService` と `paradisClaudeAccounts` チャネルを置きます。SSH のウィンドウの `ParadisLimitsMonitorClient` は接続先のこのチャネルに聞き、手元と同じ一覧・登録・追加・切り替えを出します。登録したアカウントは接続先ごとに独立で、同じ接続先を開いた全ウィンドウで共通です（2026-09-30 の決定。手元のアカウントを接続先へ写すことはしない。同じリフレッシュトークンを2台で使うと、片方の更新でもう片方が失効するため）。

- 認証情報は接続先のユーザーデータの `paradis-claude-accounts/secrets/<UUID>.json` に平文で置きます（0600 に固定、フォルダは 0700、symlink は辿らない。`ParadisPlainFileClaudeSecretStore`）。REH には safeStorage も鍵の保管サービスも無いためで、Claude Code 自身が Linux でいまのログインを `.credentials.json` に置くのと同じ保護です（2026-09-30 の決定）。認証情報は接続先から出しません
- 更新の直後は同じ接続先に古い版の REH が残り（最大 24 時間）、同じユーザーデータを読み書きします。控えのトークンを2つのプロセスが続けて更新すると使い捨てのリフレッシュトークンの片方が無効になるので、REH では書き換え（`serialize` に並ぶもの。控えの更新・取り込み・登録・削除・切り替え）を `paradis-claude-accounts/.mutation.lock` のディレクトリロックの中で行い、登録の一覧は毎回読み直します（`crossProcessLockPath`）。ロックは 30 秒で古いとみなし、持っている間は3秒ごとに更新時刻を進め、60 秒待っても取れなければその書き換えは失敗します。更新したのに保存できずに手元に持っているトークンは、相手のプロセスがそれより期限の新しいトークンを保存していたら捨てます（手元の方のリフレッシュトークンは使用済みのため）。古いロックを消して取り直す箇所（`acquireDirectoryLock` の stat → rmdir）には、持ち主が落ちた後に2つのプロセスが同時に取り直すと両方が取れる隙が残っています（既存のヘルパーのまま）
- アカウント追加は接続先で `claude auth login --claudeai` を一時フォルダに向けて動かします。ブラウザからの戻りは接続先の localhost のポートへ行くので、手元へ届くのは VS Code のポート転送が効いたときだけです【要確認: 実機未確認。届かなければコードを貼る方式に切り替える前提（2026-09-30 の決定）】。手続きは始めた接続（`paradisConnectionClientId`）だけが読み・取り消せます。追加は REH 全体で同時に1つなので、始めた接続が切れたら（REH の `onDidRemoveConnection` は再接続の猶予が尽きたときだけ届く）その手続きを止めます（リロードしたウィンドウは別の接続になり、前の手続きを取り消せないため）
- 接続先のいまのログインの使用量も REH のこのサービスが取ります。スマホが接続先のログインを見る口（`getClaudeHostState` / `ParadisClaudeHostUsage`）は `paradisSetClaudeHostStateSource` でこのサービスの結果を使い、使用中のカード1枚だけを返します（同じログインを2か所で取らない）。スマホは表示だけで、切り替えも登録したほかのアカウントも扱いません（`getSnapshot` の `claudeHostLoginOnly`）
- 切り替えに対応しない接続先（macOS。ログインがキーチェーンにある／REH の環境の `CLAUDE_CONFIG_DIR` が既定の `~/.claude` と違う）は `unsupportedOnHost` だけを返し、ウィンドウは従来どおり読み取り専用の表示に戻ります
- 【要確認】Linux の Claude Code が、動いている間に `.credentials.json` の差し替えを読み直すか（UI と changelog は「起動し直すと確実」と書いている）

| 対象 | 場所 | 誰が書くか |
|---|---|---|
| いまのログインの認証情報 | macOS: キーチェーン `Claude Code-credentials`（アカウント名は `$USER`、英数字と `._-` 以外を含むと `claude-code-user`）。それ以外: `~/.claude/.credentials.json` | Claude Code。Para Code は切り替えのときだけ書く |
| いまのログインの身元 | `~/.claude.json` の `oauthAccount`（古い版は `~/.claude/.config.json`） | 同上。「使用中」はこの値と登録済みアカウントの照合で決める |
| 登録したアカウントの一覧 | ユーザーデータの `paradis-claude-accounts/accounts.json`（秘密でない値だけ、0600） | Para Code |
| 登録したアカウントの認証情報 | credentials JSON のうち `claudeAiOauth` だけ。macOS: キーチェーン `Para Code Claude Accounts`（アカウント名は登録 UUID）。Windows / Linux: safeStorage で暗号化した `paradis-claude-accounts/secrets/<UUID>.enc`。暗号化できない環境と `--password-store=basic`（固定鍵）では保存を断る | Para Code |

実装で踏みやすい点:

- 使用量 API は `GET https://api.anthropic.com/api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`）です。Orca・claude-swap・claude 2.1.283 のバイナリで同じ URL を確認しました。上限は「身元 × User-Agent の種類」ごとに1時間約 28〜30 回（claude-swap の実測）なので、User-Agent は `ParaCode-LimitsMonitor/1.0` にして他のツールと回数を取り合わないようにしています
- 取得間隔は claude-swap の `poll_policy.py` を `common/paradisClaudePollPolicy.ts` へ移植しました（180 秒は取り直さない、通常 3〜10 分、使用中が 85% 以上で動いている間 1 分（直近 1 時間に 20 回取ったら 3 分に戻す）、429 は Retry-After（1 時間規模なら +15 分）、無ければ 5 分待ち、その後 1 時間は 6 分以上 ×1.5 で最大 30 分。この 1 時間の起点は 429 を受けたときに決めて、成功しても消さない）。10 分間どのウィンドウからも聞かれなければ止まります。変更の通知を受けたウィンドウの読み直しは「聞かれた」と数えません（数えると、通知 → 読み直し → 取得 → 通知の輪で止まらなくなる）。非表示のウィンドウは通知で読み直しません
- 使用中のアカウントのトークンは更新しません。リフレッシュトークンは使い捨てで、ここで更新すると動いている Claude Code の手元のトークンが無効になるためです。代わりに Claude Code が書き戻した新しいトークンを保存し直します（期限が保存済みより古いもの、トークン欄が空のものは取り込まない）。控えのアカウントだけ、期限の 5 分前から Para Code が更新して保存します。更新後に保存できなかったトークンは手元に持ち、次に読むときに保存し直します（使用済みのリフレッシュトークンで更新し直さない）
- 取り込み（と「Para Code に登録」、切り替えのときの控え）で別のアカウントのトークンを保存しないよう、次をすべて満たすときだけ保存します: `~/.claude.json` の身元 → 認証情報 → 身元の順に読み直して2回とも一致、トークンの持ち主を `GET https://api.anthropic.com/api/oauth/profile`（claude-swap の `fetch_oauth_profile` と同じ）で確かめて一致、ほかの登録アカウントの保存分と同じリフレッシュトークンでない、切り替えの最中と直後の1周でない。確かめられないときは保存しません（古いトークンが残るだけで、別のアカウントのトークンで上書きするよりは安全）。定期の取り込みで確かめられなかったときは、10 分は確かめ直しません。切り替えでは、控えに回るアカウントのいまのトークンが保存分と違うのに確かめられなければ、切り替え自体をやめて `unverified` を返します（切り替えると最新のリフレッシュトークンを失うため）。トークンの欄が空（Claude Code が更新を拒否された跡）なら守るものが無いので確かめずに進みます
- 控えのトークンを更新する前に、いまのログインと同じリフレッシュトークンでないかを確かめます（`~/.claude.json` を一瞬読めずに使用中を控えと取り違えても、Claude Code の手元のトークンを無効にしない）。並んでいる間に切り替えを挟んだ更新はしません
- キーチェーンへの書き方は項目によって分けています（`node/paradisClaudeKeychain.ts`）。値はどちらも Claude Code 自身と同じ `-X <16進>` で渡します（キーチェーンに入るバイト列は Orca の `-w <値>` と同じ JSON の UTF-8 で、Claude Code・Orca・Para Code はどれも `find-generic-password -w` で読むので、読み手から見た違いは無い）。`security` は PATH の差し替えを防ぐため絶対パス（`/usr/bin/security`）で呼びます。書いた後の読み戻しはしていません（失敗は終了コードと、標準入力のときはエラー出力で判断する）。`node_modules` にキーチェーンを直接扱うネイティブモジュールは無く、`osascript` 経由は項目のアクセス権が変わって許可ダイアログが出るため採らなかった
  - Claude Code の項目（`Claude Code-credentials` とハッシュ付きの項目）: Orca（`main/macos-keychain/generic-password.ts`）と同じく、長さに関係なく常に引数で渡します（`security add-generic-password -U -a <アカウント> -s <サービス> -X <16進>`、標準入力は繋がない。2026-09-28 に Orca へ揃えた）。引数で渡している一瞬は、同じユーザーのプロセス（`ps`）や EDR のプロセスログから値が見えます。Claude Code 自身は短い値を `security -i` の標準入力で、1行が 4,032 バイトを超える値だけを引数で書くので、この露出は Claude Code と同じではありません。`mcpOAuth` を含む長い値では Claude Code と同じ、短い値（`mcpOAuth` が無い）とハッシュ付きの項目では Claude Code より多く、Orca と同じです（以前ここに「露出は同じ」と書いていたのは誤り）
  - Para Code 自身の保存分（`Para Code Claude Accounts`。控えのトークンを更新するたびに書く）: 以前どおり `add-generic-password …` の1行を `security -i` の標準入力で渡し、その1行が 4,032 バイトを超えるときだけ引数で渡します（`security -i` は標準入力を 4096 バイトの行バッファで読む）。保存するのは `claudeAiOauth` だけなので、通常は標準入力に収まり、登録した全アカウントのリフレッシュトークンが更新のたびにプロセスの一覧へ載ることはありません
- 切り替えでは、Orca（`main/claude-accounts/keychain.ts` の `writeActiveClaudeKeychainCredentialsForRuntime`）と同じく、設定フォルダのハッシュ付きの項目（`Claude Code-credentials-<sha256(~/.claude の字面) の先頭8桁>`）にも書きます。Orca と同じく、項目が無くても書きます（Claude Code は `CLAUDE_CONFIG_DIR` を指定するとこちらを読む）。`mcpOAuth` などは、その項目の値（無ければハッシュ無しの項目の値）から残し、`claudeAiOauth` だけを差し替えます。失敗したときは両方の項目を書く前の値へ戻し、書く前に無かった項目は消します。いまのログインを読むとき（控えのトークンの取り込み、持ち主の確認、切り替えの前の確認）も Orca と同じくハッシュ付きの項目を先に、ハッシュ無しの項目を後に読み、同じ扱いにします。どちらが今のトークンかは中身で決めます（`claudeAiOauth.expiresAt` が新しい方。同じならハッシュ付き）。Claude Code 2.1.283 がハッシュ付きの項目を読み書きするのは `CLAUDE_CONFIG_DIR` に文字列として `<home>/.claude` を指定したときだけ（バイナリで確認。末尾の `/` や別名では一致しない）で、そのときはハッシュ無しの項目が古いまま残ります。古い方を控えると、使い捨てのリフレッシュトークンの新しい方を失うため。既定の利用者では、初回の切り替えで Claude Code が読まないハッシュ付きの項目ができ、その `mcpOAuth` の写しは初回の値のまま残ります（期限で新しい方を選ぶので、古い写しを「いまのログイン」と取り違えることはない）。Orca に合わせて常に書く指示なので、この写しは残したままにしています
- 保存も書き戻しも `claudeAiOauth` だけです。`Claude Code-credentials` には MCP サーバーの OAuth トークン（`mcpOAuth`）なども入るので、切り替えではいまの JSON の `claudeAiOauth` だけを差し替えます
- 一覧（`accounts.json`）を読めない間は、登録・削除で一覧を書きません（空の一覧に足して保存すると既存の登録が消えるため）
- 切り替えは Claude Code 自身のロック（`~/.claude/.oauth_refresh.lock` → `~/.claude.lock` → `~/.claude.json.lock` → `~/.claude/.storage-write.lock`、proper-lockfile 互換の mkdir 方式）を取った中で行い、書く前の状態を控えて失敗したら戻します。最後の `.storage-write` は安全な保存先（キーチェーン・`.credentials.json`）の書き込みロックで、Claude Code 2.1.283 は `proper-lockfile` の `lock(<設定フォルダ>/.storage-write, { realpath: false, retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 }, stale: 15000 })` で取り、その中で読み直してから書きます（`mcpOAuth` の更新もこの経路。バイナリの文字列で確認、2.1.258 も同じ）。Para Code も同じディレクトリ `<設定フォルダ>/.storage-write.lock` を 15 秒で古いとみなし、持っている間は 3 秒ごとに更新時刻を進めます。取れないとき（9 秒待っても持ち主がいる）は何も書かず、`locked`（「Claude Code がログインを更新している最中でした」）で止めます。Para Code の切り替えが見る設定フォルダは既定の `~/.claude` だけです（`CLAUDE_CONFIG_DIR` を変えた Claude Code はキーチェーンの項目名も変わるので、切り替えの対象外）。`~/.claude.json` は、置き換える直前に読んだときのままかを確かめ、変わっていたら（Claude Code はプロジェクトの設定をロックなしで書くことがある）読み直して組み立て直します（3 回まで）。失敗したときの戻しは書く前の中身で置き換えるので、その間に書かれた変更は戻しで消えます（従来どおり）。登録していないログインが使用中のときは上書きせずに止めます（そのログインのリフレッシュトークンを失うため）。`~/.claude.json` が壊れているときも書きません
- 動いている Claude Code は、キーチェーンを約 30 秒ごとに読み直すので次の発言から新しいアカウントになる、と claude-swap は説明しています（実機で要確認。UI と changelog は「起動し直すと確実」と書いています）。macOS で `~/.claude/.credentials.json` が既にあるときは、中身は書かずに更新時刻だけ変えて読み直しを促します（最新のトークンを平文のファイルへ置かないため）
- アカウント追加は一時ディレクトリを `CLAUDE_CONFIG_DIR` と `CLAUDE_SECURESTORAGE_CONFIG_DIR` にして `claude auth login --claudeai` を動かし、そのディレクトリ用のキーチェーン項目（`Claude Code-credentials-<sha256 先頭8桁>`）かそのディレクトリの `.credentials.json` と、`.claude.json` から拾います。既定の項目（いまのログイン）は見ません。ログインを待つ間に Claude Code の更新や切り替えでも変わるため、「変わった値が今回のログイン」とは言えないからです（`CLAUDE_CONFIG_DIR` でキーチェーンの項目名を分けない古い Claude Code では追加できません）。終了で消し損ねた一時ディレクトリ（`paradis-claude-login-*`、30 分より古いもの）とその項目は、次の起動で消します
- claude-swap は撤去し、アカウントはログインし直して移してもらいます。移行期間は `~/.claude-swap-backup/sequence.json`（Linux は `$XDG_DATA_HOME/claude-swap/`）を読むだけで、まだ登録していないアカウントをパネルに並べ、1回だけ通知で登録し直しと「claude-swap での切り替えをやめる」ことを案内します。claude-swap のデータには書き込みません。「Para Code に登録」でいまのログインを写したアカウントが claude-swap にもあるときは、同じトークンの系列を claude-swap も持っている可能性があるので、控えに回っても Para Code は更新しません
- 使用量パネルへプロバイダ固有の操作を足す口は `electron-browser/paradisLimitsPanelContributions.ts` です。`ParadisLimitsPanelContributions.register(クラス)` し、`renderAccountActions`（カード下端のボタン列）と `renderProviderFooter`（節の末尾）を実装します。Claude の「このアカウントを使う」「Para Code に登録」もこの口で足しています（`paradisClaudeAccountActions.ts`）。部品はそのプロバイダの contrib 側から副作用 import で読み込み、パネル側から各プロバイダを import しません
- 開発版と製品版の Para Code を同時に使うときの制約: 登録したアカウントはユーザーデータごと（別々）ですが、いまのログインは共有です。両方が同じアカウントの使用量を取りに行くので API の回数も2倍使います。片方で切り替えると、もう片方の「使用中」は次の読み直しで追従します。アカウント追加の一時ディレクトリの掃除は 30 分より古いものだけなので、もう片方のログイン中のものは消しません
- テストはすべて一時ディレクトリの HOME とメモリのキーチェーン、偽の HTTP で動き、本物の `~/.claude`・キーチェーン・API には触れません（`test/node/paradisClaudeTestUtils.ts`）

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
- **Sentry の release は CI で作る（2026-09-28）**: desktop プロジェクトは「テレメトリーからの release 自動作成」が無効（`enableAutoReleaseCreation: false`）で、この設定だと、まだ無い release を持つイベントからは `release` と `dist` が消える。1.139.1 のイベント（beta.3 と開発版）に release が無かったのはこのため。SDK は送っている（開発版を手元の受け口へ向けて確認）。`sentry-cli` 3 の `sourcemaps upload --release` は Debug ID の artifact bundle に印を付けるだけで release を作らないので、`build/sentry/upload-desktop-sourcemaps.ts` が先に `releases new` を呼ぶ。開発版の `para-code@<version>`（commit なし）は誰も作らないので、開発版のイベントには release が付かない
- **Sentry の release 名に paracode の番号を入れる（2026-09-30、Q156）**: 以前の `para-code@1.139.1+<commit>` は同じ upstream 版の中で commit しか違わず、Sentry は build（`+` の後ろ）を文字列で比べるので、新旧の並びが commit のハッシュ順になり、解決済みの issue の再発を検知できなかった。今は `v1.139.1-paracode-148` から `para-code@1.139.1.148+<commit>`、ベータ `v1.139.1-paracode-148-beta.2` から `para-code@1.139.1.148-beta.2+<commit>` を作る。タグでないビルド（ブランチの workflow_dispatch・手元のビルド）は従来どおり `para-code@<version>+<commit>`。
  - 並びの根拠: Sentry（`sentry-release-parser` の `Version::cmp` と `sentry.models.Release` の並び替えの列）は `major.minor.patch.revision` の 4 つを数値で比べ、次に prerelease の無い方を上、prerelease 同士は文字列の比較、最後に build を比べる。番号を 4 つ目（revision）に置いたので、N と N+1 は数値で並び、ベータ N は N-1 より上で N より下、旧名 `1.139.1+<commit>`（revision 0）とタグでないビルドはどの番号付きの版よりも下になる。依頼時の案だった `1.139.1-paracode.148` は、prerelease 付きが旧名より下になり、`paracode.148-beta.1` がステーブル `paracode.148` より上、`paracode.99` が `paracode.148` より上になるので使わなかった（`sentry-relay` 0.9.31 の `compare_version` で確認）。残る制限は、同じ番号のベータ同士が文字列で比べられるため `beta.10` が `beta.2` より下になること
  - 名前の規則は `build/lib/paradisReleaseChannel.ts` の `getParadisSentryRelease` の 1 か所にある。`build/gulpfile.vscode.ts`（PARA-PATCH）が product.json に `paradisSentryRelease` として刻み、アプリは main の Sentry 初期化でそれを使う（無ければ従来の形）。`build/sentry/upload-desktop-sourcemaps.ts` は同じ関数で `releases new` とソースマップのアップロードをする。どちらも GitHub が用意する `GITHUB_REF_TYPE` / `GITHUB_REF_NAME` を読むので、ワークフローは変えていない。契約テスト（`paradisReleaseContract.test.ts`）が両方の呼び出しと、ジョブがこの 2 つの環境変数を上書きしていないことを確かめる
  - モバイル（`ltd.paradis.paracode.mobile@<app.json の version>[+<ビルド番号>]`）は配信のたびに version を上げるので、この問題は無い
- **【要確認】minidump の外部プロセス判定は誤ると落とす側に倒れる（2026-09-28）**: `paradisSentryCommon.ts` の `paradisIsForeignNativeCrash` は、添付の dmp のモジュール一覧の先頭（実行ファイル）のパスだけで決める。「先頭モジュール＝実行ファイル」は macOS の実物の dmp（65 件）でしか確かめておらず、Windows と Linux は未確認。子プロセスへの例外ハンドラの継承は macOS にしか無いので、実害の出る範囲は小さい（推測）
- **既知の制限（以前からの挙動）: 外部プロセスのクラッシュが本物の dmp の枠を食う**: `@sentry/electron` の `maxMinidumpsPerSession`（10）は beforeSend より前に減る。外部プロセスのクラッシュが同じセッションで続くと、beforeSend で捨てても枠は戻らず、その後に起きた本物のクラッシュの dmp は送られずに削除される
- **自動マージが引数の意味を変えた**: `webContentsViewRendererFeature.ts` の `_refresh(true)` は、fork では `boundsArePushed`、upstream では `restartScreenshot` の意味で、どちらも第1引数だったためコンフリクトせずに混ざった。`_refresh(boundsArePushed = false, restartScreenshot = false)` の2引数に分け、upstream の呼び出しを `this._refresh(false, true)` に直した。**bool 引数を足しているパッチは自動マージ後に全呼び出し点を読むこと**
- **試験ブランチだけにあった修正は再発する**: 1.137 試験で直した phoneLayout.css の通知センター位置（`--modern-ui-notifications-block-start-inset` を渡す形）は main に入っていなかったため 1.139 でも同じ退行が出た。ブラウザ系（`setSharedWithAgent` が新しいモデルを返す、`IBrowserViewSessionOptions` の判別ユニオン化と fork の Profile スコープ、`getOrCreateLazy(data)`）も試験ブランチの fork 所有ファイルの修正を `git apply` で持ち込んだ。試験ブランチで直したものは一覧にしておき、本番マージで必ず確認する
- **Modern UI の変更で fork の見た目が崩れた**: アクティビティバーがプライマリサイドバーと一体のカードになり、同じ `activitybar` クラスを持つ fork の補助アクティビティバーの継ぎ目が崩れた。タブの既定が `connected` になり、ウィンドウ透過中にタブ帯だけ不透明になった（fork の既定設定で `workbench.experimental.modernUIEditorTabStyle: pill` に戻した）。ウォーターマークの上書きは upstream と同じ詳細度で並んでいて、読み込み順だけで勝っていた（クラスを重ねて詳細度を上げた）
- **upstream の挙動変更が fork 所有ファイルを壊した**: `terminalInstance.rename(undefined)` が 1.139 で「static title を消して OSC 購読を張り直す」動きになり、プリセット端末の手動の名前がリロードで消えた（`paradisPresetService.ts` の `_restorePresetTitle` で static title がある端末には呼ばないようにした）。型では検出できないので、fork が upstream API を呼ぶ箇所は意味的レビューで確認する
- **upstream の新しいポーリングがレート制限対策を迂回した**: `codeReviewService.ts` にレビュースレッドの `startPolling()`（GraphQL を60秒ごと）が追加された。fork の `startChangeDrivenReviewThreadsRefresh` に差し替えた。upstream が `startPolling()` を新しく呼んでいないかは毎回 grep する
- **新しいワークフロー**: 1.139 で `.github/workflows/codeql.yml`（main への push・PR・週次、ubuntu-latest）が入った。公開リポジトリなので無料で動くが、時間がかかる
- **upstream 1.139 の新しい lint ルール `code-no-bracket-notation-for-identifiers`**: fork 所有の37ファイルで536件の警告になり、hygiene（警告も失敗扱い）がコミットフックで止まるため `eslint --fix` で一括修正した（`obj['x']` → `obj.x`、実行時の意味は同じ）
- **1.139.1 の main はリリースビルドが通らなかった（2026-09-28、`v1.139.1-paracode-146-beta.1` で発覚）**: macOS 2本と REH linux-x64 が `prepareBuiltInCopilotRipgrepShim` の `Copilot SDK directory not found at .../extensions/copilot/node_modules/@github/copilot/sdk` で落ちました。upstream #336628（`6629039aded`）が Agent Host を `@github/copilot-sdk` 同梱のランタイムへ移し、`build/.moduleignore` の `@github/copilot/sdk/index.js` などの個別除外を `@github/copilot/**` の丸ごと除外に変えたためです。`packageCopilotExtensionDependenciesStream()` は Copilot 拡張自身の `node_modules` にも `.moduleignore` を当てるので、拡張の `@github/copilot` が空ディレクトリになります。upstream の CI はこの経路を通らず、Linux の Copilot ジョブが作った VSIX を `build/azure-pipelines/common/downloadCopilotVsix.ts` で `.build/extensions/copilot` に展開して `-min-ci` タスクで固めるため、upstream 側では表に出ません（upstream main の 2026-09-26 時点でも同じ状態で、upstream でも CI 以外の手元ビルドは落ちるはずです）。fork は VSIX を持たないので、`build/lib/extensions.ts` に `packageCopilotExtensionSdkStream()` を足し、`compile-copilot-extension-build` の3段目 `copy-copilot-extension-sdk-build` で拡張の `@github/copilot/package.json` と `sdk/**`（`*.d.ts` を除く）を `.moduleignore` を通さずに戻しています。拡張は Copilot CLI セッションで `@github/copilot/sdk` を実行時に `import()` するので、条件付きで飛ばす案は採りませんでした。なお 1.135 系の出荷版は、旧 `.moduleignore` の `@github/copilot/sdk/index.js` 除外により `sdk/index.js` が無いまま出荷されていました（`/Applications` に入っている 1.135.0 で確認。Copilot CLI セッションは当時から読み込みに失敗していたと推測されます）。**次回の取り込みでは `build/.moduleignore` の `@github/copilot` 周りの差分と、`build/azure-pipelines/common/downloadCopilotVsix.ts` のような「CI だけが通る経路」の変更を確認し、`npm run gulp vscode-darwin-arm64-min` を手元で最後まで回すこと**
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
| `ThirdPartyNotices.txt` | Orca（stablyai/orca、Copyright (c) 2026 Lovecast Inc.、MIT）の項目を PowerShell/EditorSyntax の前に追加。2026-09-28 に見出しへ Computer Use の補助アプリを足した | xterm の IME パッチ（`build/npm/paradisXtermImePatch.ts`）が Orca 由来のコードを製品の `lib/xterm.js` に入れるため。Computer Use の補助アプリ（`src/vs/paradis/contrib/computerUse/native/macos/`）もパスワード欄の判定語と ScreenCaptureKit の単一ウィンドウ撮影の設定を Orca の `native/computer-use-macos` にそろえている。コメント構文が無いのでここに記録する |
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
| `extensions/git/package.json` / `extensions/git/package.nls.json` | 設定 `git.paraParkedRepositoryLimit`（`number`、既定 `16`、`minimum: 0`、`scope: window`、`0` は無制限）と、その説明の nls 文字列を追加（2026-10-03） | スペースを切り替えたときに Git のリポジトリを閉じずに預けておく数の上限（`extensions/git/src/paradisRepositoryPark.ts`）。以前は固定の 4。下げたときは `model.ts` の `onDidChangeConfiguration`（PARA-PATCH）が超えた分を古い順にすぐ破棄する |
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
| `app/mobile/modules/para-aes-gcm/expo-module.config.json` | 新規追加（fork所有）。`apple.modules: ["ParaAesGcmModule"]` | PC とのセッションのフレームの AES-256-GCM を CryptoKit で開く・封緘するローカル Expo モジュールを検出・読み込みするため。JSONのためマーカー不可。同モジュールの Swift・podspec・index.ts には PARA-CODE ヘッダーあり。取り込んだら `app/mobile/ios` で `pod install` が要る |
| `app/mobile/modules/para-haptics/expo-module.config.json` | 新規追加（fork所有）。`apple.modules: ["ParaHapticsModule"]` | 触覚のトークン（`src/haptics.ts`）を UIFeedbackGenerator の強さ指定と Core Haptics で鳴らすローカル Expo モジュールを検出・読み込みするため。JSONのためマーカー不可。同モジュールの Swift・podspec・index.ts には PARA-CODE ヘッダーあり。取り込んだら `app/mobile/ios` で `pod install` が要る（入れる前のバイナリでは expo-haptics で鳴る） |
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
| `app/mobile/app.json` | `expo.experiments.onDemandFilesystem: false` を追加 | リポジトリ直下の `src/vs/paradis/contrib/fileViewers/common/` を `metro.config.js` の `watchFolders` で読ませているが、既定の On-Demand Filesystem では `@expo/cli` の `withMetroMultiPlatformAsync` が export 時（`expo export:embed` / Xcode の Release バンドル）だけ `watchFolders` を `[projectRoot]` に切り詰め、遅延読み込みは serverRoot（`app/`）の外を拒否する（`@expo/metro-file-map` の `TreeFS#isOutsideFallbackBoundary`）。そのため開発サーバーでは通るのに TestFlight 用アーカイブだけ `paradisOfficeRecovery.js` の解決に失敗していた。無効化すると export も開発サーバーと同じく `watchFolders` を走査する |

| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-clipboard@~57.0.1` を依存に追加 | エージェント詳細画面のタイムライン（`src/components/agentIoBlock.tsx`）で、ツールの入力・出力をコピーするボタンを出すため。RN本体の `Clipboard` は非推奨で、Expo SDK 57 の標準モジュールを使う。ネイティブモジュールのため追加後は iOS/Android の再ビルドが必要 |

| `app/mobile/native/ParaCodeWidgets/paracode-logo.png` | 新規追加（fork所有バイナリ）。`app/mobile/assets/pairing-logo.png` を `sips -Z 128` で縮小したコピー（gitignoreされた `ios/ParaCodeWidgets/` にも同一物を配置し、Widgetターゲットの Resources に pbxproj 手動登録済み） | Live Activity / Dynamic Island のロゴをホームタブのPCカードと同じPara Codeロゴにするため（復元手順は同ディレクトリ README 参照）。PNGのためマーカーを埋め込めない。**2026-09-27 の Live Activity 案 D でロゴを出さなくなり、いまはどのコードも読んでいない**（Resources の登録は残してある。消すなら pbxproj の `FD…A6` / `FD…B4` も一緒に外す） |

| `product.json` | Remote-SSH（リモート開発）対応で4点追加。(1) `serverDownloadUrlTemplate` を新設し、固定タグ `reh` のGitHub Releaseから `para-code-server-${os}-${arch}-${commit}.tar.gz` を取得させる。(2) `builtInExtensions` に `jeanp413.open-remote-ssh@0.3.1` を追加（sha256はOpen VSX実測値 `c6f16b22…`、metadataのUUIDは `open-vsx.org/vscode/gallery` の extensionquery から取得）。(3) `extensionEnabledApiProposals` を新設し同拡張へ `resolvers`/`tunnels`/`terminalDataWriteEvent`/`contribRemoteHelp`/`contribViewsRemote` を許可。(4) `remoteExtensionTips` を新設し `ssh-remote` エントリを登録 | MS純正の `ms-vscode-remote.remote-ssh` はライセンス上forkで使えず、リモートへ入れるVS Code Serverも `update.code.visualstudio.com/commit:<commit>` にforkのcommitが存在しないため取得不能。OSS版の open-remote-ssh + 自前REH配布で代替する。**(3)は必須**: proposed APIを許可しないと接続そのものが始まらない（`extensionsProposedApi.ts` のコメント通り、product.json側の指定が拡張のpackage.json宣言を上書きするため、拡張が宣言している2つも含めて列挙する必要がある）。`serverApplicationName`/`serverDataFolderName` は拡張の `getVSCodeServerConfig()` が product.json を直接読むので追加設定は不要。URLに `${commit}` を使うのはクライアントとサーバーの版ずれを原理的に防ぐため（`remote.SSH.serverVersion` の既定 `match` ではGitHub APIを叩かないので任意ホストで動く）。ビルドは `.github/workflows/para-reh.yml` |
| `product.json` / `resources/paradis/builtin/mobile-canvas-vscode-0.1.16.vsix` | `builtInExtensions` に `mobile-canvas-vscode@0.1.16`（Marketplace上の実体は `redth.mobile-canvas`、MIT）を追加。**リポジトリに vendoring した「ランタイム非同梱版」VSIX（123KB）を `vsix` フィールドで指す**。metadataのUUIDは Visual Studio Marketplace の extensionquery から取得 | iOSシミュレータ/Androidエミュレータをライブ表示・操作する Mobile Canvas を標準同梱するため。**ネイティブランタイムを同梱してはいけない（paracode-116 で実際にリリースが落ちた）**: プラットフォーム別VSIX（12〜14MB）は `dist/runtimes/<rid>/mobile-canvas.gz` に実行ファイルを内包しており、これをアプリに入れると **Apple の公証が gzip を展開して中の Mach-O を検査し、`The binary is not signed.` / `The signature does not include a secure timestamp.` / `The executable does not have the hardened runtime enabled.` の3点で拒否する**（拒否パスは `Para Code.app/Contents/Resources/app/extensions/mobile-canvas-vscode/dist/runtimes/osx-x64/mobile-canvas.gz/mobile-canvas` と、.gz の内側まで具体的に示される）。非同梱版は manifest だけを持ち、ランタイムは初回利用時に `~/.mobile-canvas/runtimes/` へ展開されるため、アプリの外に出て公証の対象外になる。取得は `paradisMobileCanvasHostClient.ts` の `_downloadArchive()` が manifest の `distribution`（repository/tag）と各ファイルの `asset` から GitHub Release のURLを組み立てて行い、展開後のsha256をmanifestと突き合わせる。同梱に戻したい場合は、ビルド時に自前で Developer ID 署名＋hardened runtime を付与して再gzipし、manifest の sha256/id も書き換える工程が要る。**`name` を `redth.mobile-canvas` にしてはいけない**: `name` は `.build/extensions/<name>/` のフォルダ名にしか使われず拡張IDは同梱 `package.json` の `publisher`+`name` から決まるが、`vsix` パスやアセット名と揃えておかないと版上げのときに取り違える。版を上げる際は `gh release download <tag> --repo Redth/mobile-canvas-ghcp --pattern "mobile-canvas-vscode-thin.vsix"` で取り直し、`shasum -a 256` の値を `sha256` に反映する（リリース同梱の `SHA256SUMS` はランタイム `.gz` のみでvsixを含まない） |
| `app/mobile/native/ParaCodeWidgets/ParaCodeWidgets.entitlements` | 新規追加（fork所有）。Widget Extension の entitlements（追跡用コピー。実体は gitignore された `ios/ParaCodeWidgets/`）。App Group `group.ltd.paradis.paracode.mobile` だけを持つ | ホーム画面・ロック画面のウィジェットが、アプリ・通知拡張と App Group の要約（`widget-snapshot.json` / `widget-settings.json` / `widget-outbox.json`）を受け渡すため（復元手順は同ディレクトリ README 参照）。plist のためマーカーを埋め込めない |
| `app/mobile/native/NotifyExtension/NotifyExtension.entitlements` | `com.apple.security.application-groups`（`group.ltd.paradis.paracode.mobile`）を追加 | 通知拡張がアプリの閉じている間にウィジェットの要約の要対応を書き換えるため（`WidgetShared.swift` の `WidgetStore.applyNotification`）。実体の `ios/NotifyExtension/` にも同じものを当てる。plist のためマーカーを埋め込めない |
| `app/mobile/native/NotifyExtension/Info.plist` | `NSExtension.NSExtensionAttributes.IntentsSupported` に `INSendMessageIntent` を追加（2026-10-04） | 通知の作り直し（`notify.content.v1`）の Communication Notification。通知拡張が送り主（Claude / Codex）の INSendMessageIntent で通知を作り直すため。実体の `ios/NotifyExtension/Info.plist` にも同じものを当てた。plist のためマーカーを埋め込めない |
| `app/mobile/native/NotifyExtension/agent-claude.png` / `agent-codex.png` | 新規追加（fork所有バイナリ、180px）。PC のグリフ（`src/vs/paradis/common/paradisAgentLogoPaths.ts` と同じパス）を白で、Claude・Codex とも `#1f2328` の地に描いたもの（Claude は 2026-10-04 に Q176 B でオレンジ `#D97757` から黒へ。白との混ざり具合を保って地の色だけ置き換えた）（`qlmanage` で SVG から書き出し `sips -Z 180`） | Communication Notification の送り主の丸いアイコン。実体の `ios/NotifyExtension/` に置き、NotifyExtension の Resources に pbxproj で登録（`FE…A5`/`FE…A6`、`FE…B4`/`FE…B5`）。PNG のためマーカーを埋め込めない |
| `app/mobile/native/ParaCodeNotifyContent/Info.plist` | 新規追加（fork所有）。Notification Content Extension の設定（`UNNotificationExtensionCategory` = `para.done`/`para.approval`/`para.approval.open`/`para.question`/`para.error`、既定の中身を隠す、操作を受ける、`$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)`） | 通知の長押しの画面（Markdown の全文と「開く」）。実体は gitignore された `ios/ParaCodeNotifyContent/`。復元手順は同ディレクトリの README。plist のためマーカーを埋め込めない |
| `app/mobile/ios/ParaCodeMobile/ParaCodeMobile.entitlements`（追跡なし） | `com.apple.developer.usernotifications.communication` を `true` で追加（2026-10-04） | Communication Notification（通知拡張の `INSendMessageIntent` による作り直し）に要る。`ios/` は gitignore されているのでここにだけ記録する。`ios/` を作り直したら当て直す（`app/mobile/native/ParaCodeNotifyContent/README.md`） |
| `app/mobile/ios/ParaCodeMobile/Info.plist`（追跡なし） | `NSUserActivityTypes` に `INSendMessageIntent` を追加（2026-10-04） | 同上。`ios/` を作り直したら当て直す |
| `app/mobile/ios/ParaCodeMobile.xcodeproj/project.pbxproj`（追跡なし） | `ParaCodeNotifyContent` ターゲット（ID の接頭辞 `FC…`）を追加してアプリに埋め込み、NotifyExtension の Resources に `agent-claude.png` / `agent-codex.png` を登録（2026-10-04） | 通知の長押しの画面と送り主のアイコン。手で編集した（prebuild は使わない）。手順は `app/mobile/native/ParaCodeNotifyContent/README.md` |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `lucide-react-native@^1.48.0` を依存に追加 | モバイルの画面の作り直し（Orca に合わせたアイコン）で使うアイコン集。JS だけのパッケージで、描画は既存の `react-native-svg` を使う |
| `build/paradis/computerUse/paradis-computer-use-entitlements.plist` | 新規追加（fork所有）。中身は空の `<dict/>` | Computer Use の補助アプリ（`Para Code Computer Use.app`）に渡す entitlements。アクセシビリティと画面収録は entitlements ではなく TCC で決まるので何も要らない。`build/darwin/sign.ts` の PARA-PATCH と CI の「Pre-notarize Computer Use helper」が参照する。plist のためマーカーを書かない。補助アプリの `Info.plist` は `buildHelper.ts` がビルドのたびに生成するのでリポジトリに置いていない |
| `app/package.json` / `app/pnpm-lock.yaml` | `pnpm.patchedDependencies` に `react-native@0.86.0` → `patches/react-native@0.86.0.patch` を追加（lock は peer の添え字に `patch_hash` が付くだけで版は変わらない） | ライブ入力で iOS の変換中の範囲（marked text）を JS へ渡すため（W2-24）。react-native を上げたらパッチを作り直し、キーの版も書き換える |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-network@~57.0.2` を依存に追加（W2-05） | 回線の変化で即座に繋ぎ直すため。JS からは `requireOptionalNativeModule('ExpoNetwork')` で引くので、ネイティブ部品が入る前のバイナリでも落ちない。反映には `app/mobile/ios` で `pod install` と再ビルドが要る（prebuild は使わない） |
| `app/patches/react-native@0.86.0.patch` | 新規追加（fork所有。パッチ形式なのでマーカーを書けない。当てた先の3ファイルには `Para Code:` のコメントが入る） | TextInput の変更イベントに `isComposing` を足す（Orca の `react-native@0.83.10.patch` の該当部分を 0.86.0 に合わせた）。RN はソースからビルドしている（`ios.buildReactNativeFromSource`）ので、ネイティブの再ビルドで効く |
| `app/protocol/test/golden/state.json` / `state-request.json` / `term.json` / `agent.json` | 新規追加（fork所有。JSON なのでマーカーの代わりに各ファイル先頭の `$comment` に用途を書いた）（W2-17） | PC ⇔ モバイルの公開ワイヤの固定形。PC（`paradisMobileWireGolden.test.ts`）とアプリ（`app/mobile/src/wireGolden.test.ts`）の両方が読み、形が黙って変わったら落とす。形を変えるときは同じ変更でここも直す |
| `app/protocol/test/golden/browser.json` | 新規追加（fork所有。先頭の `$comment` に用途）。`state.json` の `capabilities` に `browser.space.v1` / `browser.page.v1` / `browser.focus.v1` / `browser.bookmarks.v1` を追加 | モバイルのブラウザのタブ（案A）の固定形 |
| `app/protocol/test/golden/state.json` | `capabilities` に `usage.machine-id.v1`、`current` に `machineIdHash` と `renderers[].host.machineIdHash` を追加（2026-10-03） | 使用量を全 PC で合計するための機械の印（NOTES「使用量を全 PC で合計するための PC 側」） |
| `app/protocol/test/golden/state.json` / `agent.json` | `state.json` の `capabilities` に `agent.question.notes.v1` / `agent.question.chat.v1`、`agent.json` に preview 付きの質問と `answerVia` の delta、`notes` 付きの回答、`action/clarifyQuestion` を追加（2026-10-04） | モバイルの質問カードの preview・メモ・「質問に答えずに話す」の固定形 |
| `app/protocol/test/golden/state.json` | `capabilities` に `fs.attachment.v1` を追加（2026-10-04） | モバイルから上げた添付画像を、置き場（`<userData>/User/paraMobileUploads/`）の直下の名前でサムネイル・原寸として読む口（`paradisMobileAttachmentRequests.ts`） |
| `app/protocol/test/golden/state.json` / `agent.json` | `state.json` の `capabilities` に `agent.approval.detail.v1`、`agent.json` に承認の delta（`approval.delta`。interaction の `request`・`suggestionScope`・`answerVia`）、`message` 付きの `action/answerApproval`、`approval-options` の応答の `warning` を追加（2026-10-04） | モバイルの許可のカードに操作の中身・送り元・警告を出し、拒否に指示を添える固定形（`paradisAgentApprovalRequest.ts`） |
| `app/mobile/package.json` / `app/pnpm-lock.yaml` | `expo-media-library@~57.0.1` を依存に追加（2026-10-04） | 添付画像の全画面ビューアの「写真に保存」。JS からは `requireOptionalNativeModule('ExpoMediaLibrary')` で引く（`src/photoLibrary.ts`）ので、ネイティブ部品が入る前のバイナリでも落ちず、ボタンを出さないだけ。反映には `app/mobile/ios` で `pod install` と再ビルドが要る（prebuild は使わない） |
| `app/mobile/app.json` / `app/mobile/ios/ParaCodeMobile/Info.plist`（後者は追跡なし） | `ios.infoPlist` に `NSPhotoLibraryAddUsageDescription` を追加（2026-10-04）。実体の Info.plist には同じキーを手で当てる | 「写真に保存」の許可の文言。無いと `saveToLibraryAsync` がネイティブで例外を投げる |
| `app/mobile/app.json` | `expo.version` を `0.12.0` に | モバイルのブラウザのタブ（案A）の配信 |
| `resources/paradis/claude-mod/.claude-plugin/plugin.json` / `resources/paradis/claude-mod/hooks/hooks.json` | 新規追加（fork所有。Claude Code の mod のマニフェストと hooks module の指定。JSON なのでマーカーを書けない。同じフォルダの `hooks/register.ts`・`tests/para-code.test.ts` には PARA-CODE ヘッダーあり）（2026-10-03） | Para Code のターミナルの Claude Code に読ませる mod（NOTES「Claude Code の mod（Claude Mods）で会話・質問・承認・送信をつなぐ」）。`build/gulpfile.vscode.ts` の PARA-PATCH で macOS/Linux のパッケージへ同梱する |
| `resources/paradis/claude-mod/.claude-plugin/plugin.json` | `version` を `1.1.0` に上げた（`hooks/register.ts` の `MOD_VERSION` と揃える。拒否に添えた指示を Claude Code へ渡す版）（2026-10-04） | mod の版の表示。指示付きの拒否を受けられるかは登録の `denyMessage: true` で見分ける |
| `resources/paradis/claude-mod/.claude-plugin/plugin.json` | `version` を `1.2.0` に上げた（`hooks/register.ts` の `MOD_VERSION` と揃える。スラッシュコマンドの一覧 `commandList` と実行 `commandRun` を受ける版。`commands` の要求の `features` で PC に知らせる）（2026-10-04） | モバイルのスラッシュコマンドの一覧を `$.command.list()` で取り、`/name args` を `$.command.run` で実行する |
| `app/protocol/test/golden/state.json` / `agent.json` | `state.json` の `capabilities` に `agent.commands.v2`、`agent.json` に `command-catalog`（`format: 2`）の要求と応答、`code: 'unknown-command'` の `action-result` を追加（2026-10-04） | スラッシュコマンドの一覧の新しい形（同じ名前の重なり・出どころ plugin / mcp）と、断りの理由の固定形 |
| `app/mobile/app.json` | `expo.version` を `0.12.4` に（2026-10-04） | スラッシュコマンドの一覧と断りの表示の配信 |
| `app/protocol/test/golden/state.json` / `agent.json` | `state.json` の `capabilities` に `agent.panel.v1`、`agent.json` に圧縮の区切りと要約（`noticeSource: compaction` / `compact-summary`・`compaction`）と `panel` を持つ `delta`、`action/closePanel` の要求を追加（2026-10-04） | PC で開いている画面の帯と「閉じる」（Esc）、コンテキストの圧縮の区切り線と畳んだ要約の固定形 |
| `app/protocol/test/golden/state.json` / `state-request.json` / `term.json` | `current` の `protocolVersion`・`minCompatibleMobile`・`minCompatiblePc` を 4 に、`capabilities` に `voice.stream.v1` を追加。`term.json` の操作の `protocolVersion` を 4 に（2026-10-05） | mux の版 4（16KiB の断片・優先順）と音声通知のストリーミング。`preW217` は版 3 の相手の形として残し、テストは「つながらない（更新の案内）」側を確かめる |
| `app/protocol/test/golden/state.json` | `capabilities` に `usage.voice.v1` を追加（2026-10-05） | モバイルの読み上げ（Aivis・ElevenLabs）の使用量（fs の `voiceUsage`。キーは送らずキーの印 `keyId` だけ） |
| `app/protocol/test/golden/voice-usage.json` | 新規（2026-10-05）。fs の `voiceUsage` の応答の `data`（取れたとき・前回の値が無いまま失敗したとき） | PC の組み立てとアプリの読み取りの形の一致を、両側のテスト（`paradisMobileWireGolden.test.ts`・`voiceUsageModel.test.ts`）で確かめる |
| `app/mobile/app.json` | `expo.version` を `0.12.5` に（2026-10-05） | 読み上げの使用量の画面の配信 |

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

### vendored chrome-devtools-mcp への変更（2026-10-04）

vendored の中身は原則そのまま同梱するが、1 か所だけ直している。パッケージを更新したら、この変更を当て直すこと（`grep -rn "PARA-PATCH" src/vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build` で見つかる）。

| ファイル | 変更 | 理由 |
|---|---|---|
| `build/src/McpContext.js` の `waitForTextOnPage` | `locator.wait()` に `AbortController` の signal を渡し、勝ち負けが決まったら（成功・時間切れとも）`abort()` する | `wait_for` は全フレーム × 全テキストで `aria/` と `text/` の Locator を race させる。rxjs の race は負け側の購読を外すだけで、負け側の `waitForSelector`（`Runtime.callFunctionOn` の awaitPromise）は上流に既定 5 秒残り、直後の click がゲートウェイの入力の関所でそれを待って not interactive になっていた |

上流で `waitForTextOnPage` が signal を渡すようになったら、この変更は外してよい。ツールの入口と出口の調整（`wait_for` の `text` を文字列でも受ける、スナップショットを既定で返さない、`take_snapshot` の文字数の上限と `offset`、not interactive への拒否理由の追記、Target closed の 1 回の再試行）は vendored を触らず `node/paradisDevtoolsToolAdjustments.ts` で行っている。

### chrome-devtools-mcp のファイルのパスは手元のペインからだけ受け、roots で範囲を絞る（2026-09-29、q.html Q132 案A）

vendored chrome-devtools-mcp と CDP ゲートウェイは手元の shared process にあり、ブラウザも手元で動くので、ツール引数のパスや CDP の `file:` は常に手元のファイルを指す。paracode-110 以降は接続先（SSH・WSL・コンテナ）のエージェントも戻り経路（`ssh -R`）から同じポートへ届き、proxy は roots を名乗らず空で答えていたため vendored の `validatePath`（`McpContext.js`）は何も確かめていなかった。接続先から手元の任意のファイルを書けた（`evaluate_script` の `filePath`）し、読めた（`upload_file`、CDP の `DOM.setFileInputFiles`・`Input.dispatchDragEvent` の `data.files`、`navigate_page` / `Page.navigate` の `file://` を開いてから `take_snapshot`）。

- **「接続先から」の判定**: ペインの `remoteAuthority`（`_classifyCaller` が `tunnel` と `pane` のどちらで確かめるかを決めるのと同じ属性）に加え、接続の相手が Para Code の張った戻り経路の ssh（`ParadisRemoteAgentTunnels.processPidFor` の PID、`paradisPeerIsOneOf`）なら、手元のペインのトークンでも接続先として扱う。`remoteAuthority` はシェルの PID と別の台帳（`_paneRemoteAuthorities`）にも覚える。`_paneShells` は PID の分かるペインしか持たず、SSH のウィンドウの再読み込みでターミナルが付き直す前など PID の無い manifest では接続先のペインが台帳から消え、手元と見なされていたため。一度接続先と分かったトークンはトークンが片付くまで手元に戻さない。CDP ゲートウェイは台帳に無いトークンも接続先として扱う（MCP の層が台帳に無いペインのパスを断るのと揃える）。戻り経路の確認は、戻り経路が1本も無ければプロセス表を調べない。戻り経路があるのに相手を特定できない（lsof 等が失敗した）ときは接続先として扱う。CDP ゲートウェイでは接続ごとに、手元のファイルに触れるコマンドが初めて来たときに1回だけ調べる（その間そのコマンドと後続は待たせる）。手元のペインに `pane`（シェルの子孫）であることは求めない（tmux・WSL・採用した Codex app-server でパスが使えなくなるため）
- **MCP の層**（`paradisDevtoolsPathPolicy.ts`、`ParadisAgentBrowserService._callTool` の転送直前）: 接続先からの呼び出しは、パスの引数があれば英文のツールエラーで断る。台帳に無いペインも断る。対象は 1.5.0 の `verifyFilesSchema` と同じ（`take_screenshot` / `take_snapshot` / `evaluate_script` / `performance_start_trace` / `performance_stop_trace` / `take_heapsnapshot` / `upload_file` の `filePath`、`get_network_request` の `requestFilePath` と `responseFilePath`、`lighthouse_audit` の `outputDirPath`。一覧に出ない `get_heapsnapshot_*`・`close_heapsnapshot`・`compare_heapsnapshots`・`install_extension`・`screencast_start` の分も）。名前が `path` で終わる引数と、`navigate_page` の `file:` の `url` も断る。表は `paradisDevtoolsPathArgumentsSync.test.ts` が vendored の `build/src/tools/*.js` と突き合わせる
- **CDP ゲートウェイの層**（`paradisCdpRemotePolicy.ts`、`paradisCdpFilterProxy.ts` のページ接続とブラウザ接続のセッション）: 接続先からの接続（`IParadisCdpGatewayDelegate.isRemotePane` は毎回、`isTunnelPeer` は接続ごとに手元のファイルに触れるコマンドが初めて来たときに1回だけ判定）では、`DOM.setFileInputFiles`・`DOM.getFileInfo`・`Page.handleFileChooser`・`data.files` 付きの `Input.dispatchDragEvent`・`file:`（`view-source:file:` を含む）への `Page.navigate` / `Target.createTarget`・`perfettoConfig` 付きか `tracingBackend: 'system'` の `Tracing.start`（Perfetto の設定の出力先でブラウザの機械へ書かせうるため。puppeteer の通常のトレースは `traceConfig` だけなので MCP の `performance_*` は動く。`traceConfig` にはファイルの出力先の項目が無い）を断る。MCP の `navigate_page` / `upload_file` もこの接続を通るので二重に塞がる。手元のペインは今までどおり `file:` を開ける。**塞いでいないもの**: (1) `Page.navigateToHistoryEntry` とページの JS の `history.back()`（戻る・進むに使う。そのタブの履歴に利用者が開いた `file:` のページがあればそこへ戻れる）。(2) 共有されたタブが既に `file:` のページのとき、そのページの JS（`Runtime.evaluate`）から別の `file:` の URL へ移る・iframe で読む（Chromium が `file:` 同士を読ませる範囲に限る）。web のページから `file:` へは Chromium が遷移を断るので、ここへ来るのは利用者が `file:` のページを共有したときだけ。止めるには electron-main の内蔵ブラウザの遷移（`will-frame-navigate`）で「接続先のペインに共有中のビュー」を見分ける必要があり、共有の台帳を main へ渡す変更になるので見送った。(3) 内蔵ブラウザのダウンロード: 接続先のエージェントもページの JS（blob と `a.download`）や para-browser の `save_page_as_pdf` / `download_by_click` でダウンロードを起こせ、利用者のダウンロードフォルダ（`~/Downloads` など）にファイルを作れる。既存のファイルは上書きせず、中身を読み返すこともできない。(4) `Page.addScriptToEvaluateOnNewDocument` で仕込んだスクリプト: 接続先のエージェントが共有中のタブに仕込んでおくと、利用者が後でそのタブ（共有中のまま）で `file:` のページを開いたとき、そのページで動いて中身を読める
- **roots**: proxy は `initialize` で `roots: { listChanged: true }` を名乗り、`roots/list` に次を返す。手元のペインはスペースのフォルダ（ペインを所有するウィンドウの `paradisAgentPreview` チャネル `paneRoots`。スペースを持たないペインはウィンドウのワークスペースのフォルダ、`file:` だけ。ペインの所属がまだ決まっていなければ `undefined` を返し、揃っていない扱いで後から引き直させる）、利用者の一時フォルダ（shared process の `os.tmpdir()`、macOS では `/tmp` と `/private/tmp` も）、Para Code の一時フォルダ。接続先のペインは Para Code の一時フォルダだけ。上限 16 フォルダを超えた分はログに残す
- **roots の応答の順序と取り直し**: `roots/list` にエラーで答えたり SDK の 60 秒を超えたりすると vendored は roots を未設定のまま（＝何も確かめない）にするので、フォルダの解決に失敗・5 秒で時間切れしても一時フォルダだけの一覧で必ず答える。揃わなかったときは 2 秒から倍々で最大 5 回引き直し、揃ったら `notifications/roots/list_changed` を送る（vendored の `index.js` は roots を名乗ったクライアントのこの通知で `roots/list` を取り直す）。一度揃ったフォルダは以後のすべての応答に使うので、初期化時の遅い要求の応答が後の正しい応答を上書きすることはない
- **`preview_file`**: 接続先のペインのパスは、ウィンドウに接続先（`remoteAuthority`）も渡して `vscode-remote://<接続先>/<パス>` として開く（以前は `URI.file` で手元のファイルを開けた・有無を探れた）。手元のペインのトークンで戻り経路から来たものは断る
- **断られたときの案内**: vendored の `Access denied: path … is not within any of the configured workspace roots.` は、proxy が許された場所の一覧と「パス無しで呼べば結果が応答に載る」旨の文に置き換える
- **Para Code の一時フォルダ**（`paradisDevtoolsTemporaryDirectory.ts`）: `os.tmpdir()/para-code-devtools-XXXXXX` を mkdtemp（0700）で作り、子プロセスの `TMPDIR` / `TMP` / `TEMP` をそこへ向ける（パス無しで自動保存する 2MB 超のスクリーンショットや Lighthouse のレポートもそこに入る）。子プロセスを起こすたびに自分の 0700 のフォルダとして在るかを確かめ、無ければ作り直す（作れなかったことは覚えない。持ち主の印を書けなかったら作ったフォルダを消して諦める）。終了時に消し、起動時に前の実行の残り（持ち主の PID が死んでいるもの、印の無い 24 時間より古いもの）を消す
- **制約**: 相対パスは shared process の作業フォルダ基準で解決されるので roots の外として断られやすい。接続先のエージェントは `take_heapsnapshot` を使えず、トレースの生ファイルと Lighthouse のレポートファイルも受け取れない（要約は応答に載る。スクリーンショット以外の受け渡し口は作っていない）

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

設定ファイルの書き換えは、手元では同じディレクトリの一時ファイルへ書いてから `rename` で差し替える（`src/vs/paradis/node/paradisWriteFileAtomic.ts` の `paradisWriteFileAtomicSync`）。symlink は多段でも最後まで辿った実体の側を差し替え（リンク先がまだ無い場合も辿る）、元の mode（`~/.claude.json` の 0600 など）を引き継ぐ。次の場合は差し替えない。

- 所有者の書き込みビットが無い、または `access(W_OK)` が通らないファイル（`chmod 444` で固定している等）は、その場へ書くときと同じく失敗させて触らない。`rename` はディレクトリの権限だけで通るので、差し替えると読み取り専用の意図を黙って破る
- ハードリンク（リンク数が2以上）はその場へ書く。差し替えると片方だけが新しい中身になる
- 一時ファイルを作れない（ディレクトリに書き込めない）・`rename` が通らない（Windows で他のプロセスが開いている等）ときは、従来どおりその場へ書く

既知の制約: 一時ファイルへは所有者・ACL・拡張属性（macOS の `com.apple.*` 等）を引き継がないので、差し替え後はそれらが消える（mode だけは引き継ぐ）。書いてから `rename` までの間にプロセスが落ちると、同じディレクトリに `.<元の名前>.paradis-<uuid>.tmp` が残り、誰も片付けない（Claude Code / Codex はこの名前を読まない）。SSH 接続先のファイルは一時ファイルを経由しない。接続先は `IFileService` 越しにしか触れず、そこでの原子的な書き込み（`atomic: { postfix }`）は元の mode を引き継げず（一時ファイルが umask の既定で作られて元の名前に置き換わる）、symlink にも使えないため。代わりに、書く直前に読み直して、組み立てている間に変わっていたら読み直した中身から組み立て直す。

設定 `paradis.agentHooks.enabled`（既定オン）で自動設置を止められる。取り外すのは**オンからオフへ切り替わったその時だけ**で（shared process の `ParadisAgentHooksAutoInstall`、SSH 接続中のウィンドウは接続先の分を `paradisRemoteAgentHooks.contribution.ts` が外す）、起動時にオフでも取り外さない。hook の設定ファイルは PC 全体で共有（Claude は1つ、Codex は既定のホームとログイン済みのアカウント用ホームごとに1つ）なので、起動時に外すと同じ PC の別の Para Code（開発版など）が使っている hook まで消えるため。逆に、別の Para Code がオンのまま動いていれば、こちらで外しても向こうの整合処理（ファイル監視と60秒ごとの監査）が置き直す。notify スクリプト自体は消さない。Codex はオフにしたときに全ホームの `hooks.json` から外し、オンの間は60秒ごとの監査で後から増えたアカウント用ホームにも置く（どちらも上の原子的な書き込みを通る）。SSH の接続先は従来どおり `~/.codex` 1つだけ（Codex の切替はこの PC だけのため）。

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
- 複数ホームは、hook を置く先と同じ `paradisCodexHomes()`（既定のホーム、ログイン済みの `~/.codex-<数字>`、設定で足したホーム）を扱う。IPC 経由で任意のパスに codex を起こさないよう、チャネルの `grant`・`getStatus` が受け付けるのもこの一覧にあるホームだけ（手作りの `~/.codex-backup` やログインしていない `~/.codex-3` は断る）。`auto` の間は一覧の全ホームの hooks.json を監視し、起動 20 秒後・hooks.json の変化・ホームの増減（`onDidChangeParadisCodexHomes`）のたびに全ホームへ `autoGrant(home)` する。設定で足したホームは変化を知らせないので、自動の確認のたびに監視の対象も合わせ直す。指紋の台帳はホームごとの列が並んで書くので、台帳の読み直しと書き込みは1本の列にしている。`ask` の通知も全ホームを調べ（チャネルの `getStatusAll`）、どこか1つに未信頼の hook があれば、全ホーム分のパスと件数をまとめて確かめる。「信頼する」は全ホームへ付ける（`grantAll`）。監視を張れなかったホーム（まだ無い）や止まった監視は覚えずに、次の確認で張り直す。Para Code の外でアカウント用ホームにログインした・設定 `paradis.limitsMonitor.codexHomes` を変えたときも、ホームの一覧の走査（hook の定期監査が 60 秒ごと、選択の見直しが 30 秒ごとに呼ぶ）か設定の変更で `onDidChangeParadisCodexHomes` が届く
- `codex` は Node のスクリプトなので、shared process の PATH に `node` が無いと `env: node: No such file or directory` で起動できない。ログインシェルの環境（`ParadisCachedShellEnv`）を使っているので通常は問題ないが、失敗したときの outcome は `failed` で detail にこの文言が出る

### hook 所有者判定の既知の制限: 共有した tmux サーバー（2026-09-27）

hook の発信元の仕分けは `src/vs/paradis/contrib/agentBrowser/node/paradisAgentHookOwnership.ts` にあります。所有者のエージェントが終わると、同じペインのトークンで次に hook を送ってきたエージェントが後継の所有者になります。

tmux サーバーの環境変数は、サーバーを起こしたペインのものです。2つのペインで同じ tmux サーバーを使うと、ペイン B から作ったセッションのエージェントも、ペイン A のトークン（`PARA_CODE_TERMINAL_PANE_ID`）で hook を送ります。ペイン A の所有者が生きている間は `invalid` で捨てますが、所有者が終わるとペイン B のエージェントが後継になり、その状態がペイン A のタブに出ます（実機で再現済み）。ペイン A がまだ一度もエージェントを動かしていないときも、同じ理由でペイン B のエージェントが最初の所有者になります（推測、実機では未確認）。

後継を「hook の祖先にペインのシェルがいるとき」に絞る修正は入れて、実機確認の後に外しました。tmux の中のエージェントの祖先は tmux サーバー → launchd で、ペインのシェルを通りません。そのため絞ると、同じペインで tmux のエージェントを起動し直したときに、5つの形のうち4つで状態が出なくなりました（同じセッションの別ウィンドウ、作り直したセッション、`tmux new-session -s x2 claude` の打ち直し、直接起動の後の tmux）。こちらは tmux を使う人がエージェントを2回起動すれば必ず起きるので、共有サーバーの取り違えより影響が大きいと判断しました。両方の形は `paradisAgentHookOwnership.test.ts` に固定してあります。


この制限の続きとして、ペイン B のエージェントがペイン A の所有者になっている間は、ペイン A で `tmux new-session -s x2 claude` を起動し直しても x2 の hook がすべて `invalid` で捨てられ、タブに状態が出ない（2026-09-27 実機で確認）。ペイン B のエージェントを終えると、x2 の次のターンから状態が出る。

将来の直し方の案は、tmux のクライアントでペインとセッションを対応づけることです。tmux の中で動く hook は `$TMUX`（ソケット・サーバー pid・セッション）と `$TMUX_PANE` を持っています。notify スクリプトがこれを送り、shared process が `tmux -S <socket> list-clients -t <session> -F '#{client_pid}'` でそのセッションに付いているクライアントを調べます。クライアントの祖先にこのペインのシェル（`paradisAgentBrowserService.ts` の `_paneShells` の `shellPid`）がいれば、このペインのエージェントとして後継を認めます。ペイン B のエージェントのセッションには、ペイン B のシェルの下のクライアントしか付いていないので弾けます。notify スクリプトの版上げ（schema v4）と、hook ごとに tmux を1回起動するコストの扱いが要ります。

### Claude Code の daemon（`/fork`・`claude --bg`）の会話の hook は `background` に分ける（2026-10-04）

tmux と同じ形の問題が Claude Code 2.1.289 の daemon にもあります。`/fork` の分岐先と `claude --bg` の会話は、`claude daemon run` → `claude bg-pty-host` → `claude bg-spare` が動かします。daemon を最初に起こしたペインの `PARA_CODE_TERMINAL_PANE_ID` を持ち続けるので、hook はそのペインのトークンで届きます。そのままでは、所有者の claude が生きている間は `nested`（子エージェント）として出て、終わった後は daemon が後継の所有者になってペインの会話を奪いました。

今は hook の祖先に daemon のプロセス（argv[1] が `--bg-spare`・`--bg-pty-host`・`bg-spare`・`bg-pty-host`、または `claude daemon run`）がいれば `background` にして、ペインの状態・通知・子エージェントの一覧には出しません。transcript は「どのペインの会話でもない」と覚え、作業フォルダからの照合の候補から外します。照合は、transcript の会話の行に `sessionKind: "bg"` があるものも外します（`paradisClaudeBackgroundSessions.ts`）。分岐先を見るペイン（`claude attach <id>`）には hook が来ないので、`<id>` の前方一致で transcript を決め打ちします。

### `claude attach` の会話を所有者にし、所有者の後継をペインのシェルの子孫に絞る（2026-10-06）

`claude attach <id>` のペインでは会話が daemon の配下で動くので、上の判定では hook が `background` になり、ペインに所有者がいない状態が続いた。そこへ Claude Code の Codex plugin が detached で起動した `codex app-server`（親は PID 1、env にペインのトークンを持つ）の hook が来ると、所有者の後継になってペインの会話（モバイルも）が Codex の rollout へ張り替わった。Para Code の再起動直後や控えの流し直しで pid の無い所有者が記録された直後の普通の `claude` ペインでも同じことが起きた。

- ペインのシェル（`_paneShells` の `shellPid`、手元のペインだけ）の子孫に `claude attach <id>`（ps では `claude attach d527839f`。`<id>` は会話 id の先頭 8 桁以上）がいて、daemon の配下の hook が会話そのもの（`bg-spare` との間に別のエージェントがいない）で、`session_id`（無ければ transcript のファイル名）が `<id>` に前方一致するなら、その attach を所有者にする。以後は同じ `bg-spare` からの hook を /clear の後も所有者として通し、その配下の別エージェントは `nested`。attach が終われば所有者は死んだ扱いになり、daemon の会話は `background` に戻る
- 所有者がいない（未確定・pid 不明・死亡）とき、ペインのシェルの子孫でない発信元のうち、Claude Code の Codex plugin が起動した codex と判定できるものは後継にしない。外れたものは `invalid` で捨て、ログの理由は `origin-outside-pane`。祖先に tmux・zellij・screen・dtach・abduco がいる hook は上の既知の制限のとおり絞らない（2026-09-27 に一度入れて外した絞り込みを、端末多重化ソフトを例外にして入れ直した）
- plugin 由来の判定は 2 つ（2026-10-06 に「ペインの外はすべて捨てる」から絞った。素の `codex` の共有 daemon の hook まで捨てていたため）。1 つ目は発信元か祖先の起動行に plugin のスクリプト（`app-server-broker.mjs`・`codex-companion.mjs`）か plugin のパス（`plugins/cache/openai-codex/`・`plugins/marketplaces/openai-codex/`）があること。plugin 1.0.6 の ps では `node …/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs serve …`（親は PID 1）← `node …/bin/codex app-server` ← vendor の `codex app-server` と並ぶ。2 つ目は rollout の先頭の行（session_meta）の `originator` が `"Claude Code"` であること（先頭 16KB だけ読み、`originator` まで書かれていたら rollout ごとに覚える。手で起動した codex の `originator` は `codex-tui`・`codex_exec` で、2026-10-06 に手元の rollout で `"Claude Code"` は plugin の `source: "vscode"` とその subagent だけだった）。Windows で Win32_Process の CommandLine が取れず Name（`node.exe`）だけが見えるときは 2 つ目だけが効く
- ペインのシェルが分からない・プロセス表に無い（接続先・同期前など）ときは、どちらの判定も飛ばしてこれまでどおりに動く
- ペインのシェルの子孫には、ペインのプロセスそのものも含める（`exec claude` でシェルが置き換わったとき、ペインの最初のプロセスがエージェントやランチャーのとき）

残る制限:
- daemon が別のペインで起きた後に `claude attach` した会話は、hook が daemon を起こしたペインのトークンで届くので、attach したペインの所有者にはならない（従来どおり `background`）。【要確認】`bg-spare` が attach 側の env を引き継ぐかは実測していない
- `claude attach` の中で agent view から別の会話を選び直すと、起動行の `<id>` と合わなくなり、新しい会話は `background` のまま
- Codex の共有 daemon（ランチャーを入れない Windows、ランチャーを通らない素の `codex`）の hook は daemon のプロセスから届く。plugin 由来でなければ後継になれるが、daemon は最初に起こしたペインのトークンを持ち続けるので、別のペインの `codex` の hook もそのペインへ届きうる（tmux と同じ形の既知の制限）。【要確認】Windows の Codex が daemon をどの親の下に起こすかは実測していない
- plugin の codex でも、起動行に plugin が見えず（Windows で CommandLine が取れない等）、rollout がまだ無い最初の hook（Codex は最初のターンで rollout を作る）は判定できず、後継になりうる
- 逆に、plugin が作った会話をペインで `codex resume` し、その hook が共有 daemon（ペインの外）から届くと、rollout の `originator` が `"Claude Code"` のままなので所有者のいない間は後継になれない
- pid の無い hook（古いスクリプト・プロセス表が取れない）は daemon の会話と見分けられない。受け手が transcript の `sessionKind` で確かめるが、所有者の記録は先に届いた分岐先の transcript で決まりうる（その後のペインの hook は `invalid` で捨てられる）。pid の無いペインで分岐先を `--resume` し直したときは、最初のターンの行が書かれるまで分岐先として扱われる
- daemon の会話の状態（許可待ち・完了）は、どのペインのタブにも出ない

### worktree の「このフォルダを信頼しますか」は元のリポジトリから引き継がれる（2026-09-27 実測、実装なし）

当初の方針は「worktree に信頼が引き継がれなければ、元のリポジトリが信頼済みのときだけ、スペース作成時に worktree のパスへ信頼を書き込む」だったが、両方の CLI とも引き継ぐので実装していない。一時 HOME / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` で、`git worktree add ../repo-worktrees/wt`（Para Code の既定の置き場所と同じ、リポジトリの外の兄弟ディレクトリ）を作って TUI を起動して確かめた。

| CLI | 元のリポジトリが信頼済み | 元のリポジトリが未信頼 | 無関係なフォルダ（対照） |
|---|---|---|---|
| Claude Code 2.1.283 | worktree で確認なし。`.claude.json` の `projects` に worktree のエントリも増えない | worktree で確認が出る | 確認が出る |
| codex-cli 0.155.1 | worktree で確認なし。config.toml は変わらない | 確認が出て「Trusting will apply to the repository root: <元のリポジトリ>」と表示される | 確認が出る |

どちらも「worktree → 元のリポジトリの根」で信頼を引くため、新しい worktree に信頼を書き込む必要は無い。CLI の版上げで挙動が変わったら、この表の手順で測り直すこと（Claude は `hasCompletedOnboarding` と `customApiKeyResponses.approved` を仕込んだ一時 `.claude.json` + ダミーの API キー、Codex は一時 `auth.json` にダミーの `OPENAI_API_KEY` と `check_for_update_on_startup = false` で、ログインや更新の画面を飛ばせる。Para Code のターミナルから測るときは `env -i` で `PARA_CODE_*` / `CLAUDE_CODE_*` を落とす）。

## Claude Code の mod（Claude Mods）で会話・質問・承認・送信をつなぐ（claudeMod、2026-10-03）

手元の macOS / Linux のペインで動く Claude Code（2.1.287 以降）に、Para Code の mod を読ませる。mod は今の hook・transcript・キー注入と並んで動き、来ないペインでは今の経路だけで動く。調査と実測は `claude-mods-mobile-research.html` / `claude-mods-local-verification.html`（作業ツリー直下、未追跡）。

| 場所 | 役割 |
|---|---|
| `resources/paradis/claude-mod/` | mod 本体（`hooks/register.ts`）とテスト。Claude Code の中で動く |
| `src/vs/paradis/contrib/claudeMod/browser/paradisClaudeModEnvironment.ts` | mod を `~/.para-code/claude-mod/<内容の指紋16桁>/` へ写し、managed 設定を確かめる（renderer） |
| `src/vs/paradis/contrib/agentBrowser/browser/paradisPaneTokenService.ts` | ペインの env に `CLAUDE_CODE_PLUGIN_DIRS` を足す（hook のペイントークンと同じ場所・同じ条件） |
| `src/vs/paradis/contrib/claudeMod/node/paradisClaudeModBridge.ts` | shared process の受け口 `/claude-mod/v1/<op>`（hook と同じポート、ペイントークンで認証は `ParadisAgentBrowserService`）と、質問・承認・送信の長いポーリング |
| `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts` | 受けた出来事をモバイルのチャットへ反映し、モバイルの回答・送信を mod へ回す |

経路ごとの併走は次のとおり。どれも「mod の会話（`$.session.id()`）がペインの今の会話と同じ」ときだけ使う（同じペインで別に起動した `claude -p` は無視する）。

| 経路 | mod が来ているとき | 来ていないとき（今の経路） |
|---|---|---|
| 会話の行 | `session.append` の本会話の prompt / response を 300 ms 保留してから足す（その間にファイルへ同じ uuid が現れたら捨てる。足す前にファイルの追記を読み切るので、ツールの結果や作業中に送った発言より前へ割り込まない）。ファイルの方が後なら位置だけ覚える。ツールの結果・添付・画像入りの行はファイルから読む | transcript の tail |
| 生成中の文章 | `turn.step` の text を 150 ms ごとに受け、live（source は `hook`）に出す。流れている間は MessageDisplay hook を使わない | MessageDisplay hook |
| ターン | `turn.start` / `turn.complete` は生成中の文章の区切りと mod 側の待ちの片付けにだけ使う。承認のカード・質問・ペインの状態・通知は今までどおり hook の Stop が片付ける | hook |
| サブエージェント | 開始＝Agent の tool.call の結果の `agentId`、再開＝`classic.SubagentStart`、終了＝agentId 付きの `turn.complete`（`isAborted` で停止）。一覧にある子だけを終える | SubagentStart/Stop hook |
| 質問 | mod が tool.call で登録し、TUI のダイアログと競う。モバイルの回答は値で返し、PC が先なら mod が `settle` で待ちを打ち切る。preview のある質問のメモは `annotations[質問文].notes`（選んだ選択肢の preview も添える）、「質問に答えずに話す」は wait の `state: 'clarify'` で、メッセージがあれば `{ result: { questions, answers: {}, response } }`、無ければ PC が組んだ TUI と同じ文面の `{ deny }` を返す。mod で答えられるカードには interaction の `answerVia: 'mod'` を付ける（2026-10-04） | キー注入（メモ・取り下げ・preview のある質問の「その他」は断る。preview のある質問には TUI に「その他」の行が無い） |
| 承認 | mod は `classic.PermissionRequest` で先に設定の hook（Para Code の通知を含む）を走らせ、それから登録して待つ。`tool.check` の観測で tool_use_id を結ぶ。モバイルが接続中で、設定 `paradis.agentHooks.claudeMod.approvalWaitMinutes`（既定 10 分）が 0 でないときだけ待つ。PC が先なら tool.call か結果の行で決着する。カードとは tool_use_id か本文の完全一致でだけ結び、決まらなければ mod の内容で別にカードを出す。「以後は確認しない」は permission_suggestions がある承認だけ、足されるルールを文言に入れた選択肢 `always` で出す。設定ファイル（`localSettings` など）やモードを変えるものを含むときは「今回だけ許可」と「許可して設定に残す」に分ける。拒否に添えた指示（モバイルの「拒否して指示を書く」、`agent.approval.detail.v1`）は、登録に `denyMessage: true` を付ける mod（1.1.0 以降）が待っているときだけ渡し（カードに `answerVia: 'mod'`）、TUI の「No, and tell Claude what to do differently」と同じ書き出しの文で返す（2.1.289 で実測。モデルは指示どおりに続け、Para Code は同じ書き出しで拒否と見分ける） | キー注入（`always` と指示を添えた拒否は出さない。TUI の Tab to amend は選んでいる行に効き、「No」まで矢印で動かす数が選択肢の数で変わるため使わない） |
| 送信 | エージェントが待機中・スラッシュコマンドでないときだけ `$.prompt.submit`（mod がコマンドの長いポーリングで受け取る）。mod は `$.prompt.submit` の前に「受け取った」を返し、それ以後はキーへ戻さない（判定の直後に TUI でターンが始まると submit はそのターンの終わりまで返らないので、二重送信を防ぐ）。返事を書けなかった（ポーリングの相手が切れていた）・mod が受け取る前に断ったときはキーへ戻す。ack が 15 秒来なければ、mod の会話の行（`origin: plugin`）か transcript に発言が入っているかで確かめ、入っていなければキーへ戻す | キー注入・待ち行列 |

受け口（`ParadisAgentBrowserService._handleClaudeMod`）は、状態を動かす要求（`turn.complete`・`tool-results`・`commands`・`ack`・`permission`・`question`・`wait`・`settle` など）を、hook の許可待ちと同じ `_classifyCaller` で送り主がそのペインのプロセス（シェルの子孫）だと確かめられたときだけ受ける。確かめた結果は会話ごとに 60 秒覚え、観測だけの便（会話の行と生成中の文章）はその間だけ確かめたものとして扱う（確かめ直さない。プロセス表を引くので重い。コマンドの長いポーリングが 25 秒ごとに確かめるので、ふつうは切れない）。確かめていない送り主の行は、応答の文章と思考だけからなるものを表示にだけ使い、ツールの呼び出し・結果や発言を含む行は捨てる（質問カード・Agent・Monitor・回答待ちの解除を作れてしまうため。その行はファイルから読む）。受付は MCP・hook と別枠（`_reserveIngressRequest` の `mod`）で数える。

落とし穴:

- **`disableSideloadFlags` の下で `CLAUDE_CODE_PLUGIN_DIRS` を渡すと、Claude Code は起動そのものを止める**（2.1.288 の preAction で確認。`--plugin-dir` と同じ扱い）。managed 設定（`/Library/Application Support/ClaudeCode/managed-settings.json` と `.d/`、`/Library/Managed Preferences/com.anthropic.claudecode.plist`、`~/.claude/remote-settings.json`。Linux は `/etc/claude-code/`）に名前が現れたら渡さない。サーバーから初めて届く組織の方針は手元に控えが無いので防げない
- Claude Code は読み込んだ mod のフォルダへ型定義と `tsconfig.json` を書き足す。アプリの中（署名済みのバンドル）を直接指さないのはこのため。`claude plugin validate` / `claude plugin test` もフォルダへ書くので、リポジトリではなく写しで回す（`cp -R resources/paradis/claude-mod /tmp/x && claude plugin test /tmp/x`）
- mod の中では `$` を変数へ入れられない（`claude plugin validate` が拒む）。関数の引数として渡すのはよい。自前の Promise を待つ時間は 10 秒の予算に数えられるので、待ちはすべて `$.http.fetch`（Para Code が 25 秒で返す）か `next` にする
- ユーザーがシェルの rc や `~/.claude/settings.json` の `env` で `CLAUDE_CODE_PLUGIN_DIRS` を上書きしていると mod は読まれない（今の経路だけで動く）
- 設定 `terminal.integrated.env.osx` / `.linux` に `CLAUDE_CODE_PLUGIN_DIRS` を書いている場合、その値はペインの env の組み立て（`createTerminalEnvironment`）で Para Code の値に上書きされて消える（つなぐのは親の環境 `${env:...}` と、呼び出し側が env に入れた値だけ）。そのユーザーの mod を残したいときは、シェルの環境変数に移してもらう
- インストールした mod は 1 つの worker を共有し、原因の分からないクラッシュが 3 回続くと組み込み以外の mod が全部外れる（公式）。Para Code の mod が他の mod の巻き添えで外れることも、その逆もある。外れたペインは生存の知らせが途絶えて今の経路だけで動く
- イベント名・`$` の API・`tool.call` の AskUserQuestion の結果の形・`classic.PermissionRequest` の decision の形はリリース間で変わりうる。Claude Code を更新したら `claude plugin validate` / `claude plugin test`（写しで）と、`claude-mods-local-verification.html` の手順での実地確認（モバイルが先・PC が先の質問と承認、送信、サブエージェント）をやり直す
- 写し先 `~/.para-code/claude-mod/<指紋>/` は 30 日以上使われていない別の指紋のフォルダを起動時に消す。使った時刻は mod のフォルダの外（`~/.para-code/claude-mod/.last-used/<指紋>`）に書く（フォルダの中へ書くと、動いている Claude Code が保存を検知して mod を読み直すため）。写すファイルは許可リスト（`.claude-plugin/plugin.json` と `hooks/` の下）で、`paradisClaudeModShipsFile()` と `build/gulpfile.vscode.ts` の glob をそろえておく

SSH の接続先と Windows は今回入れていない。

- SSH: mod は claude が動く機械で読まれるので、接続先へ写す必要がある。入れるなら `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisRemoteAgentHooks.contribution.ts`（接続先に notify スクリプトとランチャーを置いているところ）で `~/.para-code/claude-mod/<指紋>/` を置き、`paradisPaneTokenService.ts` の `_getRemoteParaCodeDirectory()` で env を組む。戻り道は既存の `ssh -R`（`paradisRemoteAgentTunnel.ts`）と、接続先の PC ごとのポートファイル（`paradisRemoteHookSource.ts`）をそのまま使える。transcript の写し（2 秒）を待たずに済むので効果は大きいが、接続先の版の Claude Code と managed 設定を手元から確かめる方法を先に決める
- Windows: 区切りが `;`、`curl` の有無、`$.http.fetch` の `socketPath` が使えるかを実機で確かめていない。入れるなら同じ `paradisPaneTokenService.ts` の分岐（いまは `!isWindows`）と区切り文字を変える。WSL の中で動く claude には env が届かない（今の hook と同じ）

## Codex の複数アカウント（切替とリセットクレジット、2026-09-27）

実体は `src/vs/paradis/contrib/codexAccounts/`（fork 所有）。Claude 側（limitsMonitor の中）とは別のディレクトリにしてある。使用量パネルのカードに出す「このアカウントを使う」「使用中」とリセットの残り・「使う…」は、Claude と同じ差し込み口（`ParadisLimitsPanelContributions`）に `electron-browser/paradisCodexAccountActions.ts` を登録して出している。Claude の切替は PC 全体のログインを書き換え、Codex の切替は新しく開くターミナルにだけ効く、という違いは意図どおり（Claude は Orca / claude-swap と同じく PC 全体、Codex は `CODEX_HOME` で新しいターミナルだけ、という決定）。

`codex app-server` と stdio で話すクライアントは `src/vs/paradis/node/paradisCodexAppServerRpc.ts` の1つにまとめ、limitsMonitor（使用量の取得。shared process と REH）、この機能（リセットの読み取りと消費）、agentHookTrust、agentModelCatalog が共有している。エラーの文言は limitsMonitor の Sentry 用の分類（`classifyCodexRpcFailure`）が前提にしているので、変えるときは両方のテストを見ること。

**切替は「新しく開くターミナルへ `CODEX_HOME` を渡す」だけ**で、PC 全体の認証は書き換えない（Codex 側の決定）。選択は shared process が `userData/paradis/codexAccounts/codex-account-selection.json` に1つだけ持ち、全ウィンドウへイベントで配る（アカウントの選択は全ウィンドウ共通、という決定）。選ぶ・見直すは1本ずつ流す。renderer は `IParadisCodexLaunchHomeService`（browser 層）に反映し、`paradisPaneTokenService` が PTY 起動直前に env へ入れる。SSH の接続先を開いたウィンドウでは、同じサービスを REH でも動かし（`node/paradisCodexAccounts.server.ts`、`paradis.server.contribution.ts` から登録。`serverServices.ts` は触っていない）、選択・リセットクレジットの台帳・会話の共有の記録を接続先のユーザーデータの `paradis/codexAccounts/` に置く。選択は同じ接続先を開いた全ウィンドウで共通（2026-09-30 の決定）。renderer の `ParadisCodexAccountsClient` は接続中なら接続先のチャネルを呼び、`CODEX_HOME` はウィンドウと同じマシンで動くターミナルにだけ渡す（`paradisTerminalRunsOnWindowHost`。どこで動くかは upstream の `TerminalProcessManager` と同じく cwd の URI の authority で決める。接続先のウィンドウで手元に開いたターミナルには渡さない）。
- REH は利用者の設定（APPLICATION）を読めないので、`paradis.codexAccounts.shareConversations` はウィンドウが `getState` / `selectHome` に添えて送る。まだ1つも届いていない間（接続直後の起動時のリンク）は共有しない（オフにしている人の会話を確かめる前にリンクしない）。値は REH のプロセスで1つなので、別の PC から同じ接続先へ繋いでいると起動時のリンクは最後に問い合わせたウィンドウの値に従う（切り替えのリンクは切り替えたウィンドウの値）
- 更新の直後は同じ接続先に古い版の REH が残り（最大 24 時間）、同じ選択のファイルを書く。選択はファイルの印（inode・大きさ・更新時刻）が変わるたびに読み直し、よそが書いたものはこちらの続きの revision で配り直す（ウィンドウは古い revision を捨てるため）。リセットクレジットの台帳はプロセスごとにメモリへ持つので、古い REH と新しい REH の両方から同時に「使う」を押した場合の二重消費は防げない（`redeem_request_id` は押すたびに別）
- 接続先の `~/.codex-N` にも、`hooks.json` の hook と `config.toml` の para-browser の節を置く（`paradisRemoteAgentHooks.contribution.ts`。ホームの一覧は REH の `getState` から取り、増えたら書き足す）。接続先の hook の信頼は REH で扱っていないので、ホームごとに Codex で信頼が要る【要確認】
- 接続先の `codex login`（使用量パネルのアカウント追加）の手続きは、始めた接続だけが状態を読み・取り消せる（`src/vs/paradis/common/paradisConnectionClient.ts`）。REH の context の `clientId` は全ウィンドウで同じ定数 `'renderer'` なので使えず、context のオブジェクト（IPCServer が接続ごとに1つ持ち、再接続でも同じ参照）ごとに識別子を振る。shared process では従来どおり持ち主を分けない
- 実機未確認: 接続先の `codex login` のブラウザからの戻り（接続先の localhost:1455）が VS Code のポート転送で手元から届くか

- 既定のホーム（`$CODEX_HOME` か `~/.codex`）を選んでいるときは何も渡さない。ユーザー自身の `CODEX_HOME` を潰さないため。呼び出し側が env に `CODEX_HOME` を入れていれば（会話の再開など）そちらを優先する
- 前回の選択を保存しておいて起動直後から使うことはしない（保存した後にホームが消えていても確かめられないため）。代わりに選択の問い合わせを起動の最初期（`WorkbenchPhase.BlockStartup`）に出す。それでも返事の前に開いたターミナル（復元で開き直したもの等）は既定のホームで開くので、返事が届いた時点でその数を通知で1回知らせる
- 選んだホームが消えたり（使用量パネルからの削除）ログアウトしたりしたら、既定のホームへ戻して全ウィンドウへ知らせる。使用量パネルからの追加・削除・ログイン完了は limitsMonitor が `paradisNotifyCodexHomesChanged()` を呼んですぐ見直す。それ以外（手で消した、`codex logout`）は30秒ごとの見直しで拾う。ホームディレクトリを `fs.watch` しないのは、macOS ではホーム配下の全変更を受けうるため
- 切り替えた時点で既に動いている Codex は前のアカウントのまま。そのウィンドウに1つでもあれば通常の通知を1回だけ出す（入力を止めるチップは出さない、という決定）。「Codex が動いているか」はシェル統合の実行中コマンド（行の先頭が codex）かプロセス名（`codex`）でまず見て、それで分からないペインはシェルの pid を shared process へ渡し、プロセス表でシェルの子孫に Codex がいるかを調べる（`node/paradisCodexPaneProcesses.ts`。起動行の判定は hook の所有者の判定と同じ `paradisHookAgentKindFromCommandLine`）。再読み込みの後に再接続したペイン（実行中のコマンドが残っていない）、npm 版（前面のプロセス名は `node`）、`echo …; codex` の行から起動した Codex はこちらで分かる。tmux の中の Codex はシェルの子孫ではない（tmux サーバーの子）ので数えない
- 「前のアカウントのまま」かを決めるホームは、見つけた Codex のプロセスの `CODEX_HOME` を読めたらそれを使う（`paradisRunningCodexHome`）。読めなければそのペインを開いたときのホーム、それも無い再接続したペインは切替の直前の選択とみなす。読むのは macOS では `ps -E -ww -o uid=,command= -p <pid>`（uid が自分と同じときだけ使う。`sleep` のような OS 付属の実行ファイルは環境変数が出ないが、node・codex は出る）、Linux では `/proc/<pid>/environ`（`/proc/<pid>` の所有者が自分のときだけ）。環境変数には秘密が入りうるので、取り出すのは `CODEX_HOME` の値だけで、出力はその場で捨ててログにも出さない。Windows は読まない。`CODEX_HOME` が既定のホームと同じ場所なら既定として扱う
- `[tui] terminal_title`（タブ名）の設定は、起動時と、ログイン済みのアカウント用ホームの顔ぶれが変わったとき（codexAccounts が全ウィンドウへ配る状態で分かる）に、新しいホームへも書く
- 「AI コスト」（ccusage）は、Para Code が扱う全ホームを `CODEX_HOME` にカンマ区切りで渡して読ませる（`paradisCcusageCodexHomeEnv`）。ccusage 20.0.14 は、カンマ区切りの `CODEX_HOME` を全部読み、ホームの間で同じ会話を1回だけ数える（一時フォルダに会話ログを置いて実測。ハードリンクでも複製でも1回）。ホームが1つのとき（既定のホームだけ、SSH の接続先）は env を変えない。カンマを含むパスのホームは渡さない。ccusage はダッシュボードの JSON の形のために v20 を前提にしている（npx では 20.0.14 に固定）ので、それより古い版で読めるかは見ていない
- ペインごとに「開いたときのホーム」を覚えるのは新しく開いたペインだけ（`paradisPaneTokenService.ts`）。再接続したペインにも env は入れる（main の `2deced7dc9f`。繋げずに新しいシェルを起こすときのため）が、繋げたプロセスは前回の env のまま動いているので記録しない。記録の無いペインは、切り替えの通知で「切替の直前の選択で開いたもの」とみなす。繋げずに新しいシェルを起こした復元のペインも記録されないので、起動直後の通知（返事の前に開いた数）には入らない

**会話ログの共有**: 切り替えると、**切替元と切替先の2ホームの間だけ**で `sessions/YYYY/MM/DD/rollout-*.jsonl` をハードリンクし合う（`paradisCodexSessionLinker.ts`）。リンクするのは出どころ（その会話を Codex が最初に書いたホーム）がその2ホームのどちらかの会話だけで、A→B→C と切り替えても A の会話は C へ届かない。出どころは初めて見たときに「持っているホームが1つだけならそこ」と決め、分からないものはリンクしない。起動後60秒にも、最後の切替の2ホームの間で1回走る。全アカウントへ広げないのは、仕事用のホームの会話を別の組織のアカウントで `resume` すると、会話の内容がそのアカウントへ送られるため。設定 `paradis.codexAccounts.shareConversations`（既定オン）でやめられる（オフにしても、すでに共有した記録は消さない）。

- 既存のファイルは上書きせず、シンボリックリンクは辿らず、別ボリュームは飛ばす。新しく作るディレクトリは 0700
- これまでに各ホームで見た会話と出どころを `userData/paradis/codexAccounts/codex-session-links.json` に積み上げ（上書きせず和集合にする）、控えにあったのに今は無い会話（ユーザーが削除・アーカイブした）は何度リンクし直しても足し戻さない
- 台帳が読めない・壊れているときはリンクしない。壊れた台帳を `.unreadable-<時刻>` として退避し、今ある会話は全部「全ホームで見た・出どころ不明」として作り直す（どれを消したのか分からないので、既存の会話は以後リンクしない）
- 一時ホームで確かめた範囲では、リンクしただけの rollout を別ホームの app-server の `thread/list` と `thread/read` が拾った（codex-cli 0.155.1）
- 会話の再開一覧は全ホームから集める。会話には見つかったホーム（既定のホームを含む）を添え、再開するターミナルへ `CODEX_HOME` として渡す（選んでいるアカウントのホームには無いことがあるため）。同じ会話が複数のホームにあるときは既定のホームのものを使う

**扱う Codex ホームの一覧**は `agentBrowser/node/paradisAgentHome.ts` の `paradisCodexHomes()` だけで決める（codexAccounts もこれを使う）。既定のホームと、Para Code が作る `~/.codex-<数字>` と、設定 `paradis.limitsMonitor.codexHomes` で足したもののうち、ログイン済み（`auth.json` がある）のもの。`~/.codex-backup` のように手で作ったものには hook も設定も書かない。transcript を読んでよい範囲、Codex かどうかの判定、state DB の探索（主のホームが読めないときは従来どおり sessions/ の走査に落ちる）、会話の再開一覧、ターミナルのタブ名、hook の設置、para-browser MCP の登録（「セットアップ／修正」を押したとき。既定のホームでセットアップ済みなら、ホームが増えたときにも同じ節を入れる）、`[tui].terminal_title` の書き込みがこの一覧を見る。hook の取り外しだけは、ログアウトしたホームも含む `paradisCodexHomeCandidates()` を見る。この一覧は codexAccounts が有効にしたときだけ広がる（この PC の shared process と、SSH の接続先の REH。REH では設定で足したホームは手元のパスなので使わない）。設定で足したホームの書き方（`~`、末尾の区切り）は `paradisNormalizeCodexHomePath` でそろえ、使用量パネルと切替が同じホームを同じ id で扱う。hook は各ホームの `hooks.json` へ実ファイルで置く（シンボリックリンクにしない）ので、Codex の信頼はホームごとに1回ずつ要る。

**使用量**（limitsMonitor の `paradisLimitsMonitorChannel.ts`）は、Orca（`main/rate-limits/codex-fetcher.ts`）と同じく `codex app-server` の `account/rateLimits/read` から先に取り、トークンの更新と auth.json の書き戻しは codex 自身に任せる（2026-09-28 に Orca へ揃えた。以前は `wham/usage` から先に取り、401・403 のときだけ app-server を使っていた）。RPC が認証切れで断ったら、`wham/usage` へは落ちずに「要再ログイン」にする（Orca と同じ）。それ以外で RPC に失敗したら `wham/usage` を読み、そのホームでは 10 分間 RPC を飛ばして `wham/usage` だけにする（毎回 app-server を起こさない）。RPC で取れたときも、Orca の `supplementCodexSessionWindow` と同じく5時間の枠が無く週の枠だけなら `wham/usage` で埋める。RPC は追加の枠（`additional_rate_limits`）を返さないので、Para Code が出しているその枠も `wham/usage` から足す（ここだけ Para Code の独自。取れなければ RPC の結果だけで出す）。画面を読む方式（PTY の `/status`）は使わない。

app-server が毎回の取得の経路になったので、Orca にある起動の抑えも移しています。使用量の問い合わせは Orca の `CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS` と同じく `-c features.plugins=false` を付けて起こし、プラグインの起動（問い合わせより長く生き残るマーケットプレイスの clone など）を止めます。同じホームの app-server は、Orca の `withCodexHomeProcessLock` と同じく1つずつにします（`paradisCodexAppServerRpc.ts` がセッションを閉じるまでホームのロックを持つ。hook の信頼・モデル一覧も同じ口を通る。閉じ忘れがあっても止まり続けないよう、60 秒で待つのをやめる）。同じホームの RPC は最短 5 分おき（Orca の `MIN_REFETCH_MS`）で、その間は `wham/usage`（HTTP だけ）で読みます。RPC はホームをまたいで1つずつ、前のものが終わってから 2 秒あけて起こします（Orca の `INACTIVE_CODEX_PROBE_STAGGER_MS`）。app-server は POSIX では自分のプロセスグループで起こし、止めるときはグループごと `SIGTERM` を送ります（`paradisKillChildProcessTree` の `processGroup`。以前は `child.kill()` だけで孫が残りえた）。Windows は従来どおり `taskkill /T /F` でツリーごと止めます

- RPC が認証切れと答えたホームは、10 分たつか auth.json が変わる（ログインし直した）まで RPC を起こしません。その間の `wham/usage` の 401・403 は「要再ログイン」です
- 認証切れ以外で RPC に失敗したホームは 10 分間 RPC を飛ばします。その間の `wham/usage` の 401・403 は、codex で更新できないだけなので「要再ログイン」にせず「エラー」にします（以前の挙動に戻した）。5 分の間隔の途中で `wham/usage` が 401・403 を返したときは、アクセストークンの期限切れかもしれないので、間隔を待たずに RPC で codex に更新させます
- 認証切れの判定は Orca の `shared/codex-auth-errors.ts` の一覧（`access token could not be refreshed`、`refresh token was already used`、`not logged in`、`please sign in again` など）に、以前から拾っていた語を足したものです（`paradisIsCodexAuthError`）。`forbidden` は拾いません（Cloudflare の 403 のように再ログインでは直らない失敗も含むため。HTTP の 403 は状態で判断する）
- RPC で取れたときに足す `wham/usage` は、RPC の後に auth.json を読み直したトークンで読みます（codex が RPC の中でトークンを更新していることがあるため）
- codex CLI が無い（`binary-missing`）失敗は Sentry へ報告しません（入れていない人は毎回同じ理由で失敗し、パネルは `wham/usage` で出せるため）
- `wham/usage` とリセットクレジットの読み取り・消費の `fetch` は `redirect: 'error'` にし、トークンを `chatgpt.com` の外へ転送させません
- 見送り: Orca の「state DB の作り直し中は起動しない」（`isCodexStateDbBackfillPending`）は移していません。作り直しを見分ける手段がまだ Para Code に無く、今回の指示の範囲（プラグイン・ロック・間隔・止め方）の外のため

**リセットクレジット**の残数と期限は、使用量と同じく各ホームの `auth.json` のアクセストークンで ChatGPT のバックエンド `GET /backend-api/wham/rate-limit-reset-credits` を読む（Orca と同じ。パネルを開くたびに app-server を起こさないため。応答の形は Orca のソースから写したもので、実アカウントでは未確認【要確認】）。使うのは、Orca（`main/rate-limits/codex-reset-credit-client.ts`）と同じくバックエンドへの直接の `POST /backend-api/wham/rate-limit-reset-credits/consume`（本文 `{ "redeem_request_id": <冪等の鍵> }`、応答の `code` は `reset` / `nothing_to_reset` / `no_credit` / `already_redeemed`）。以前は app-server の `account/rateLimitResetCredit/consume` を使っていた（2026-09-28 に Orca へ揃えた）。二重消費は shared process の台帳（`userData/paradis/codexAccounts/codex-reset-credit-ledger.json`）で防ぐ。

- 消費は shared process の中で1本ずつ直列に流し、確認ダイアログで見せた提示（残数・明細・取得時刻）と違えば断る
- 範囲は ChatGPT の account_id で決める（分からないときだけホーム）。同じアカウントで2つのホームにログインしていても、片方の「結果不明」はもう片方にも効く。消費の直前に auth.json を読み直し、確認したときと account_id が違えば断る
- 送る直前に「送信済み・結果不明」を書き、結果を受けてから「確定」を書く。auth.json にアクセストークンが無いとき（送っていない）は何も残さない。HTTP のエラーの扱いは `paradisCodexResetHttpFailureOutcome` の1か所で決める。初めて出した `redeem_request_id` が 401・403 で断られたら記録を外し（認証の段階で断られ、使われていない）、ほかの 4xx（408・409・429 を除く）なら「失敗」として確定する（同じ提示への2回目は断る。読み直した新しい提示なら押せる）。429・409・408・5xx・通信の失敗・時間切れ（30 秒、Orca と同じ）・読めない応答は結果不明のまま残し、次の操作は同じ `redeem_request_id` の再送になる（バックエンドで1回にまとめられる）。**再送はどの応答でも結果不明のまま残す**。再送への応答から分かるのは再送そのものの扱いだけで、最初の要求（結果不明になったもの）が使われたかは分からないため。記録を外すと次の操作が新しい鍵になり、最初の要求が使われていた場合に2枚目が減る。429 はゲートウェイで断ったとは限らないので、初めての鍵でも残す（同じアカウントなら、ログインし直した後も同じ鍵の再送で抜けられる）
- 要求の見出しは Orca（`main/rate-limits/codex-backend-auth.ts` の `getCodexBackendAuthHeaders`）と同じ（`User-Agent: codex-cli`、`OpenAI-Beta: codex-1`、`originator: Codex Desktop`、`ChatGPT-Account-Id`）。リセットクレジットの読み取りも同じ見出しで送る
- 別件【要確認】: `find-generic-password -w` は、値に印字できないバイトがあると16進で出力するはずで、`read` はそれを文字列のまま返す（以前からの扱い）。認証情報の JSON は通常 ASCII だけなので、今のところ影響は見えていない
- 台帳が壊れていたら消費しない。**実アカウントでの消費は試していない**

モバイルへ送る使用量には、Codex の選択中アカウントに既存の任意項目 `active`（モバイルは「使用中」と出す）を、読み取り済みのリセットの残りに新しい任意項目 `resetCredits` を足した。Codex 側で既存の項目の形は変えていない（Claude 側の変化は上の Claude の節を参照）。

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

## para-browser MCP の追加のブラウザ操作は共有中のタブ1枚にだけ効かせ、ネットワークの上書きはそのペイン専用の保存領域に限る（agentBrowser、2026-09-27、フェーズ7 B7）

Orca の B7 に当たる8個のツールを para-browser MCP に足した。ツールの定義は `agentBrowser/node/paradisBrowserPageOpsTools.ts`（オフラインのシムも同じ配列を読む）、shared process 側の処理は `node/paradisBrowserPageOps.ts`、タブへ掛ける処理は electron-main の `electron-main/paradisBrowserPageOpsController.ts` で、既存の `PARADIS_CDP_TARGET_CHANNEL`（`paradisCdpTargetService.ts`）にメソッドを足して呼ぶ。検証の関数は両側で同じもの（`common/paradisBrowserPageOps.ts`）を通し、electron-main でも受け取った値を検証し直す。2回のレビュー（`phase7-b7/review-findings.md` と `phase7-b7/verify.md`）を受けて線引きを直した。

| ツール | 中身 | 決め事 |
|---|---|---|
| `mouse_action` | move / down / up / context_click / middle_click / drag / wheel、修飾キー | 既存の入力の通り道（`dispatchExactViewInput`）で送るので、利用者がそのタブにフォーカスしていれば断られ、カーソル演出も出る。uid の要素が覆われている・iframe の中・画面外なら押さない。途中で断られて押したままになったボタンは離しに行き、それも断られたら次のマウスの入力の前に送る |
| `save_page_as_pdf` | `webContents.printToPDF` | ダウンロードと同じフォルダへ `wx` で書き、同名があれば ` (1)` を足す（上書きしない）。一覧にエージェント由来として載せ、隔離の印も付ける。ファイル名は区切り文字・制御文字・双方向制御を落とし、Windows の予約名（拡張子付き・上付き数字を含む）を避けて `.pdf` にそろえる。指定が無ければ main が今のページのタイトルから決める |
| `set_extra_http_headers` | Fetch で止めた要求に、相手の origin を見て足す | 既定は掛けた時点のトップフレームの origin だけ（第三者の CDN・計測へは出さない）。`origins` で最大 10 個まで指定できる。Cookie 系・接続のヘッダ・`Proxy-*` は断る |
| `set_http_credentials` | webContents の `login` に答える | 答えるのは指定した origin（https、http は localhost だけ）の求めだけで、プロキシの求めには答えない。同じ realm へは1分に2回まで。パスワードは electron-main のメモリにだけ置く |
| `set_request_rules` | 同じセッションで `Fetch.enable`（requestStage は Request だけ） | block / set_headers / redirect / respond。redirect は 307 を返してブラウザに辿らせ、要求に Origin があれば CORS で許す（別 origin の fetch も辿れる）。respond の応答ヘッダは許可リストで、Set-Cookie・Clear-Site-Data・HSTS などは断り、`Cache-Control: no-store` を必ず付ける。`remove_headers` はネットワーク層が後で足すヘッダ（Accept-Language・Accept-Encoding・クライアントヒントなど）は消せない（ツールの説明に書いた） |
| `get_page_network_overrides` | 掛かっている上書きの要約 | ヘッダは名前と送り先の origin、認証は origin だけ、ルールは当たった回数。値とパスワードは返さない |
| `download_by_click` | クリックの前に「このタブのダウンロードを待つ」と登録し、クリックして待つ | 保存先・「開く」を出さない扱いはダウンロード一覧（`browserDownloads`）の規則のまま。クリックを送り終える前に始まったダウンロードも取りこぼさない（始まった id を受け取りに来るまで 60 秒残す）。子タブで始まったものも拾う |
| `highlight_element` | タブ専用のセッションで `Overlay.highlightRect` | ページの DOM は変えない。ページの拡大率を掛けて渡す（`Overlay.highlightRect` は拡大前の座標で受ける）。時間切れ・`clear`・次のハイライトで `Overlay.hideHighlight` を送って消す |

- 既存ツールとの分担: 左クリック・ダブルクリック（`click` / `click_at` の `dblClick`）、要素へのホバー（`hover`）、要素間の HTML のドラッグ＆ドロップ（`drag`）は chrome-devtools-mcp のものを使う。`mouse_action` はそれで出来ない右・中クリック、座標へのホバー、ボタンを押したままの移動（スライダーや canvas）、ホイールだけを持つ

### ネットワークの上書きは、呼んだペインだけが使う保存領域のタブに限る

**追加ヘッダ・HTTP 認証・リクエストのルールは、呼んだペインだけが使う保存領域のタブにだけ掛ける**。判定は保存領域の種類ではなく、誰の保存領域かで行う。

| タブ | 扱い | 判定 |
|---|---|---|
| `open_browser_tab` に `private: true` を付けて開いたタブ | 掛けられる | そのペイン専用の保存領域（Agent スコープ、affinity は `paradis-pane-` + ペインのトークンの SHA-256 の先頭 32 桁）。main は BrowserSession の id が、そのペインの affinity から upstream の `getOrCreateAgent` と同じ式で作った id と一致するかを見る。ほかのペインや利用者のタブがこの保存領域を使うことは無い。メモリだけで、ネットワークの制限も掛かる |
| そのペインが作り、ほかが使っていないプロファイル | 掛けられる | main がエージェントの印（renderer が `setAgentProfiles` で知らせる一覧）を見て、shared process が renderer の台帳（`isPaneOwnedProfile`: そのペインが作り、利用者がまだ使っておらず、開いているタブがすべてそのペインのもの）で確かめ、main がその ID と一致するときだけ受ける |
| それ以外 | 断る（`userStorage`、「`private: true` の自分専用のタブを開いて使う」よう案内） | 利用者のタブ（保存領域の種類が Ephemeral や Agent でも、利用者が開いたもの）、`private` を付けずに開いたエージェントのタブ（ワークスペースの全ペインで保存領域を共有する）、ほかのペイン・利用者も使うプロファイル |

- 理由: HTTP 認証のキャッシュと HTTP キャッシュは保存領域単位。答えた資格情報はその保存領域のほかのタブに先回りで使われ（R2、実機で確認）、`Network.setCacheDisabled` はキャッシュを読まないだけで書き込みは止めないので、書き換えた要求への応答がほかのタブ・ほかのペインへ出る（R3、実機で確認）。ワークスペースで共有するエージェントの保存領域は、同じワークスペースの全ペインのエージェントのタブが使う
- 外すときは、掛けた時点の保存領域に対して認証のキャッシュ（資格情報を置いていたとき）と HTTP キャッシュ（ヘッダかルールを置いていたとき）を消す。閉じたタブでも、掛けた時点に控えた session に対して消す。ヘッダやルールを置き換えたときも、前のもので書き換えた応答を残さないよう HTTP キャッシュを消す。消えるのはそのペイン専用の保存領域（またはそのペインだけが使うプロファイル）の中だけ
- プロファイルのタブに掛けた上書きは、同じ保存領域に別のタブが開かれたら外す（`onDidCreateBrowserView` を見る）。利用者や別のペインがプロファイルを使い始めた合図で、そのペイン自身が同じプロファイルで2枚目を開いたときも外れる（安全側）。利用者が既にあるエージェントのタブを画面で操作し始めただけでは検知できない（L5 の残り）
- 上書きはタブ（webContents）1枚に付けた専用の CDP セッションに掛ける。CDP の Network / Fetch はセッションごとなので、同じ保存領域の他のタブには届かない。1枚のタブに上書きを掛けられるのは1つのペインだけで、別のペインは `ownedByAnotherPane` で断る
- 上書きを掛けている間は、そのタブのキャッシュと Service Worker を通さない（`Network.setCacheDisabled`・`Network.setBypassServiceWorker`）。キャッシュの応答と Service Worker の応答はページのセッションの Fetch を通らず、ルールとヘッダがすり抜けるため
- エージェントのネットワークの制限: redirect はブラウザが辿り直す要求になるので、Electron の `webRequest` の制限にもう一度掛かる（実機で確認。止まる先への `respond` も `ERR_BLOCKED_BY_CLIENT`）。加えて shared process が、制限が有効なら行き先を `AgentNetworkFilterService` で確かめて先に断る

### 外すときは有効にしたものを自分で戻す

**upstream の `BrowserViewDebugger` は、セッションを dispose しても `Target.detachFromTarget` が空の session id で失敗し（`browserViewDebugger.ts` の `registerSession`、失敗は握りつぶされる）、セッションが付いたまま残る**。そのまま Fetch が有効だと、そのタブの要求は止まったままになる（R1、実機で確認）。upstream の不具合には頼らず、B7 側で有効にしたものを戻す。

- ネットワークの上書きを外すとき（`set_request_rules []`・ヘッダを空にする・資格情報だけが残る・共有の切替・タブを手放す・閉じる）: `Fetch.disable`、`Network.setExtraHTTPHeaders({})`、`Network.setCacheDisabled(false)`、`Network.setBypassServiceWorker(false)`、`Network.disable` を順に送る
- ハイライトを消すとき（`clear`・時間切れ・次のハイライト）: `Overlay.hideHighlight`。タブを手放すときは加えて `Overlay.disable`、`DOM.disable`
- 戻せなかったものは main のログ（`console.warn`）と Sentry（`page-ops-teardown`、手順の名前だけ）に出す。閉じたタブへのものは出さない
- 専用のセッションは上書きとハイライトで共用し、タブが閉じるまで使い回す。エージェントがタブを手放しても（共有の切替）、有効にしたものを戻したうえで残し、次にまた共有されたときに使う。手放すたびに付け直すと、外れないセッションが共有と解除を繰り返したタブに増え続けるため（N1）。これで残るセッションはタブ1枚につき最大1つで、タブを閉じれば消える。upstream の `browserViewDebugger.ts` は直していない（PARA-PATCH を増やさない判断）
- テスト（`test/electron-main/paradisBrowserPageOpsController.test.ts`）の偽のセッションは、dispose しても有効にしたものが残る（実物と同じ）ように作り、外した後に要求が止まらないことを経路ごとに確かめている

### エージェントの右クリックでは Para Code のメニューを出さない

- `paradisCdpTargetService.ts` が、メニューを開きうる入力（右ボタンの押下・離し、Control を押した左ボタンの押下・離し（macOS の右クリック）、ContextMenu キー（仮想キー 93）、Shift+F10）を送るたびに、その入力の印（座標、またはキーであること）を webContents に付ける（`paradisAgentContextMenu.ts`）
- upstream の `browserViewMainService.ts` の `showContextMenu` の PARA-PATCH 1 行が、`context-menu` の引数（座標と `menuSourceType`）を印と突き合わせ、一致した1つだけを消費してメニューを出さない。座標はページの CSS ピクセルと、拡大率を掛けたものの両方で比べる（誤差 3）。印は 1 秒で捨てる
- 時間の窓で一律に止めないので、エージェントの右クリックの直後でも、利用者の別の場所での右クリックでは Para Code のメニューが出る（R5）。ページの `contextmenu` イベントは届くので、ページ自前の右クリックメニューは動く
- 限界（N2）: エージェントの右クリックから 1 秒以内に、利用者が同じ点（3 px 以内）を右クリックすると、そのメニューは出ない。押下と離しの両方に印を付けるので、macOS では押下の印がエージェントのメニューで消え、離しの印が残って利用者のメニューに当たる（実機で確認）。同じ点を 1 秒以内に押すことはまれなので直していない。直すなら、メニューを開く側の型（macOS と Linux は押下、Windows は離し）にだけ印を付ける
- `eslint.config.js` の許可は、platform からこの1ファイル（Electron にもほかのモジュールにも依存しない）への import だけ（L3）

### Cookie は読み書きとも塞ぐ。ただしページの JS から読める範囲は守れない

q.html Q69 のとおり、エージェントは Cookie を読み書きできない。守れているのは次の範囲（読み取りの除去は実機で漏れが無いことを確認）。

- 新しいツールは Cookie のヘッダを送る・消す・Set-Cookie を返すのどれもできない
- 生の CDP の書き込み（`paradisCdpCookieFilter.ts` の `paradisCookieAndRewriteDeniedMessage`、ゲートウェイのページ直結・ブラウザ経由の両方）: `Network.setExtraHTTPHeaders` の Cookie、`Fetch.continueRequest` の `url` と Cookie、`Fetch.fulfillRequest` / `continueResponse` の Set-Cookie・Clear-Site-Data・`binaryResponseHeaders`、`Network.continueInterceptedRequest` / `setRequestInterception` を断る。`Page.getCookies`・`Page.deleteCookie`・`Network.setCookieControls`・`Network.loadNetworkResource`（ページの Cookie 付きで取りに行き、応答のヘッダを返す）も拒否リストに入れた
- 読み取り: ゲートウェイが Network / Fetch / Audits のイベントから、`headers` / `requestHeaders` / `responseHeaders` の Cookie・Cookie2・Set-Cookie・Set-Cookie2、`headersText` / `requestHeadersText`、`associatedCookies` / `blockedCookies` / `exemptedCookies` / `cookies`（空の配列にする）、Audits の `rawCookieLine` を落とす（`paradisSanitizeCookieBearingEvent`）。chrome-devtools-mcp の `get_network_request` はこのイベントからヘッダを組み立てるので、ここで落ちる。加えて子プロセスへ `--redactNetworkHeaders=true`（vendored の 1.5.0 が持つ）を渡す二重の備えにした
- `--redactNetworkHeaders` は許可リスト方式なので、`sec-fetch-*`・`keep-alive` なども `<redacted>` になり、エージェントは `get_network_request` で自分の追加ヘッダの値を確かめられない（L7）。Cookie はゲートウェイでも落としているが、Authorization など Cookie 以外の秘密のヘッダを出さない効果もあるので外さない。追加ヘッダが付いたかは、`get_page_network_overrides` と、相手のサーバー側（エコーするページなど）で確かめる
- コマンドの結果でヘッダを返すのは `Network.loadNetworkResource` だけと読んだ（`getResponseBody` などは本文だけ）ので、結果は選別していない
- 守れないもの: `evaluate_script` などページの JS から読める HttpOnly でない `document.cookie`、`respond` で返したページの JS が読む同じ範囲。chrome-devtools-mcp の既存のツールで元からできることで、塞ぐにはページの JS の実行そのものを止めるしかない。「全面禁止」は HttpOnly の Cookie と、ヘッダ・CDP の Cookie の API に対して成り立つ

### ダウンロードの由来と、パスワードを出さない経路

- エージェントに共有中のタブ（利用者のタブでも）から始まったダウンロードは、すべてエージェント由来にした（`paradisAgentDownloads.ts` の `paradisSetWebContentsHeldByAgent`。`will-download` の第3引数の webContents で見分ける）
- 子タブ（`target=_blank`・`window.open`・中クリック）は、`onDidCreateBrowserView` の `parentViewId` から開いた元を覚え（`paradisRecordChildWebContents`）、元を辿って判定する（最大 16 段）。そのため、共有中のタブから開かれた子タブ・孫タブで始まったものは、利用者が自分で開いたものでもエージェント由来になる。元がエージェントの手にあるときに開かれた子タブは、後で元が手放されても印を持ち続ける。`download_by_click` の待ちが残っている間（始まってから最長 60 秒、始まらなければ最長 15 秒）のそのタブと子タブのダウンロードも同じ（L6、どれも安全側）
- HTTP 認証のパスワードは、hook の `tool_input`（`paradisSanitizeAgentHookPayload`、モバイルの承認カードの元）、会話の記録からチャット表示・モバイルへ出す tool_use（`paradisAgentTranscriptParser.ts` の Claude と Codex の両方）、Codex のサブエージェントの詳細（`paradisCodexLiveClient.ts` の `readThreadMessages`）で `[hidden]` にする（`paradisRedactToolInputSecrets`）
- 消せない経路: エージェント CLI 自身の会話ログ（`~/.claude` / `~/.codex`）と、Claude Code / Codex が端末に出す許可の確認（ツールの引数をそのまま表示し、端末のスクロールバックとモバイルの端末表示にも流れる）。Para Code は端末の表示を書き換えないので、ここには出る。値ではなく参照（環境変数の名前など）を渡す形は今回は作っていない

### 見送った指摘と限界

- F11（上書きが掛かっていることが見えない）: ネットワークの上書きはそのペイン専用の保存領域のタブにしか掛からないので、利用者のタブに掛かることは無い。エージェントのタブに印を出す UI は作っていない
- L5 の残り: 利用者がエージェントのプロファイルの既存のタブを画面で使い始めただけ（新しいタブを開かない）では検知できず、上書きは残る。プロファイルの印は利用者が開く・切り替える・名前を変えると外れ、その後の上書きは断る
- 途中で共有が入れ替わったときの押したままのボタン: 共有が変わった後は元のタブへ入力を送れないので、送れなかった離しは諦める（ページに押下が残りうる。利用者が一度クリックすれば解ける）
- 上書きはトップのフレームのセッションだけに掛かり、別プロセスの iframe（cross-origin）の要求には効かない（効かない側に倒れる）。`login` は webContents 単位なので、iframe の認証の求めにも origin が一致すれば答える
- 使い回している専用のセッションは、エージェントがタブを手放した後も、何も有効にしていない状態でタブに付いたまま残る（タブ1枚につき1つ、閉じれば消える。N1）
- そのペイン専用の保存領域の id は、upstream の `BrowserSession.getOrCreateAgent` の式を写して作っている。upstream が式を変えると一致しなくなり、上書きは断られる側に倒れる（upstream 取り込み時に確かめる）
- PDF はダウンロードの自動保存を切っていても同じフォルダへ置く（保存先を聞くダイアログを出せないため）

| upstream のファイル | 行 | 内容 |
|---|---|---|
| `src/vs/platform/browserView/electron-main/browserViewMainService.ts` | import 1行 + 1行 | `showContextMenu` の先頭で `paradisConsumeAgentContextMenuSuppression(view.webContents, params)` を見て、エージェントの入力で開いたメニューだけを出さない |
| `eslint.config.js` | 1行 | `src/vs/platform/*/~` から `vs/paradis/contrib/agentBrowser/electron-main/paradisAgentContextMenu.js` の1ファイルへの逆方向 import を許す |

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

## エミュレータ操作は、ページ共有の承認と既存の台帳を使い回す（mobileCanvas、2026-09-27、フェーズ7 担当D、B13）

エージェントが端末を使うには、`mobile_request_device` で頼み、利用者が承認ダイアログで認める（Q71 の回答 A）。ダイアログはページ共有の承認と同じ `IParadisAgentBrowserTabsService.askApproval` をそのまま呼ぶので、「拒否」が既定のフォーカス、表示から 1 秒以内と ⌘D の承認は聞き直す、ダイアログは1つずつ、1ペインにつき待てる求めは1つ、という決まりも同じ実装で効く。拒否の後 3 分の自動の断りだけは、`askApproval` に足した任意の `cooldownKey` で絞った。端末の要求は `mobile-device:<端末の ID>`、インストールは `mobile-install:<端末の ID>` で数え、そのペインのその端末への求めだけを止める（別の端末の要求とページ共有は止めない）。キーの無い求め（ページ共有・プロファイル）はこれまでどおりペイン単位で、キー付きの拒否には数えられない。端末ごとに数えるだけだと、端末の数だけ続けてダイアログを出せる（14 台ある Mac なら 14 回）ので、端末の要求を拒否された直後の 10 秒は、同じペインからのほかの端末の要求もダイアログを出さずに断る（`PARADIS_MOBILE_ANY_DEVICE_DENIAL_MS`、renderer のチャネルが数える。インストールとページ共有には掛けない）。

ツールは `node/paradisMobileDeviceOpsToolProvider.ts` に置き、`paradisRegisterMcpToolProvider` から足した。台帳（`ParadisMobileCanvasService`）とホストへの接続はどちらも `registerParadisMobileCanvas` の中にしか無いので、組み立てと登録もそこで行い、登録の後始末は台帳の `own()` に預けた。para-browser 側（`paradisAgentBrowserService.ts`）と `IParadisMcpToolCallContext` は触っていない。承認は shared process → 呼び出し元ペインを所有するウィンドウ（`paradisMobileDeviceRequest` チャネルの `requestDevice` / `approveInstall`、`electron-browser/paradisMobileDeviceRequest.contribution.ts`）で取り、割り当てとインストールは shared process が行う。締め切りは renderer 50 秒・shared process 55 秒（`PARADIS_MOBILE_APPROVAL_TIMEOUT_MS`。ページ共有の定数とは別に持つ）で、割り当ては shared process が答えを受け取ってから行うので、時間切れの後に遅れて成立することは無い。

**インストールは毎回、別に承認を取る。** 入れたアプリは Para Code の権限で動き（iOS シミュレータのアプリは利用者の uid の macOS のプロセス）、エージェントのサンドボックス（作業フォルダの制限・ネットワークの遮断）の外に出られる。端末の割り当ての承認1回で、clang で作った `.app` を入れて起動すればサンドボックスを抜けられてしまうため（レビュー H1）。承認の前に、インストールするものを Para Code だけが書ける一時フォルダ（`os.tmpdir()` の下に `mkdtemp`、0700）へ写し、ダイアログには写しから読んだ中身（iOS の `.app` は `plutil` で `CFBundleIdentifier` と表示名、Android の `.apk` は SDK の build-tools の `aapt2 dump packagename`。読めなければ「読めませんでした」）と、写した元のパス（長ければ先頭を `…` にして末尾のファイル名を残す）、この点を書く。インストールするのも写しで、終わったら（断られても）消す。写す前に、今頼んだらダイアログを出さずに断られる状態か（3 分の自動の断り・同じペインの求めが答え待ち）を renderer に確かめ（`precheckInstall` → `IParadisAgentBrowserTabsService.approvalBlock`）、断られるなら写さない。同じペインのインストールは shared process で1つずつにする（断られる呼び出しを並べて、写しを同時にいくつも作らせない）。元のパスは承認の後にも中身や行き先を差し替えられる（再レビュー N1、実機で別の bundle ID のアプリが入った）ため。写すときはリンクを辿らず、中にシンボリックリンクがある成果物は断る（写しの外の、あとで書き換えられる場所を指したまま入れることになるため）。写す量は 4 GiB・20 万項目まで。`.ipa` は中身を読まない。端末の要求のダイアログと更新履歴にも一言書いた。インストールできる場所を作業フォルダの中に限る案は採らなかった（Xcode の成果物は DerivedData に出るので、普通の開発ができなくなる）。起動は入っているアプリを動かすだけなので承認しない。承認を待つ間にそのペインの割り当てが変わっていたら入れない。

| ツール | 接続元の確認 | 承認 | 実体 |
|---|---|---|---|
| `mobile_request_device` | `pane` だけ | 毎回 | 承認ダイアログ → 台帳の `attachIfFree` |
| `mobile_install_app` | `pane` だけ | 毎回 | `xcrun simctl install` / `adb -s <serial> install -r` |
| `mobile_launch_app` | `pane` だけ | なし | `xcrun simctl launch` / `adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`（`relaunch` は `--terminate-running-process` / `am force-stop`） |
| `mobile_grant_permission` | `pane` だけ | なし | `xcrun simctl privacy <udid> grant <service> <bundle>` / `adb shell pm grant <pkg> <permission>` |
| `mobile_rotate` | 掛けない | なし | ホストの `input/rotate`。0.5 秒待ってから、スクショの縦横が頼んだ向きになったかを最大3枚見る（次の1枚が全体で2秒を越えるなら見ない）。画面の大きさを返し、ならなければ「前面のアプリがその向きに回らなかった」と添える |
| `mobile_gesture` | 掛けない | なし | 向きのスワイプ `input/swipe`（`duration` は既定 0.4 秒、0.05〜10 秒）、長押し `input/tap` の `duration`（0.5〜10 秒）、ピンチ `input/touch` の `fingerId` 0 / 1 |
| 既存の `mobile_tap`・`mobile_swipe`・`mobile_type_text`・`mobile_press_button`・`mobile_ui_tap` と読み取り系 | 掛けない | なし | 変更なし |

**入力の座標に使う画面の大きさは、スクショの画素数を `/display` の `scale` で割って出す**（`mobile_tap` がホストで解釈される基準と同じ）。ホストの `/display` の大きさは端末の向きで、前面のアプリがその向きに回ったかは見ていない。縦しか無い画面（iPhone のホーム画面など）で横にすると、`/display` は `874x402` なのにスクショは `1206x2622` のままで、縦の座標への長押しが「画面の外」として断られていた（再レビュー N2、実機）。回転の結果・ジェスチャーの範囲の確認・既定の位置（画面の中央）はこの大きさで決める。スクショは1枚 0.5〜0.9 秒かかる（iOS 27、1206x2622）ので、毎回取ると回転が 0.7 秒から 9.8 秒まで遅くなった（最終確認の Low 1）。そのため大きさは端末ごとに覚え、取り直すのは回転したとき・アプリを起動したとき（前面のアプリが変わる）・覚えた値が無いときだけにした。ジェスチャーは覚えた値を使い、範囲の外と判定したときだけ断る前に一度取り直す（利用者が手で回した、ホームへ戻ったなど、覚えた後に画面が変わった場合のため）。スクショを取れないときだけ `/display` で代え、そのときの範囲の確認は縦横どちらでも入る正方形で見る。スワイプの既定の長さを 0.4 秒にしたのは、ホストの既定（72ms で返る）では iOS のホーム画面のページが送られなかったため（実機で 0.4 秒は送られた）。既存の `mobile_swipe` の既定も同じ値にした。

接続元の確認の線引き（レビュー M1）: 画面の入力と読み取りは、利用者がその端末をそのペインへ渡した後の操作なので、トークンだけで動かす。確認を掛けると、tmux・screen・zellij の中のエージェント、採用した Codex app-server、WSL・dev container（N-10 の構成）で使えなくなる。一方、端末を割り当てる・アプリを入れる・起動する・権限を付けるのは、利用者がまだ認めていない範囲へ広げる操作なので確認を掛け、`unverified` は断る。契約のコメント（`paradisMcpToolProvider.ts` の `classifyCaller`）にもこの例外を書いた。SSH の接続先のペイン（`tunnel`）は、要求・インストール・起動・権限の付与を断る。既存の方針は「利用者が共有ダイアログでそのペインへ渡した端末は、画面の入力で操作できる」だけで、それ以外は方針が無いため。インストールのパスは手元のファイルを指すので、接続先のエージェントには意味も合わない。

安全の決め事:

- 操作系のツールは端末を名指しする引数を持たず、そのペインに割り当てられた端末だけを台帳から引く。名指しするのは要求だけで、ほかのペインに割り当てられている端末は断る。ID が違っても端末の番号（UDID / シリアル）が同じなら同じ端末とみなす（`paradisDeviceHeldByAnotherPane`）。承認の後の割り当ては台帳の `attachIfFree` が、端末一覧を待ち終えてから書き込むまでの間に await を挟まずに確かめ直す（別のウィンドウの2つのペインが同時に承認されても二重に割り当てない）。承認を待つ間にペインが閉じたら、renderer が `paneUnresolved` を返して割り当てない。`mobile_list_devices` は `usedByAnotherPane` を返す
- **インストールするパスの確認はセキュリティの境界ではない**。確かめた後に、パスを別の場所へのリンクに差し替えられる。確かめるのは、利用者に分かりやすいエラーを返すためで、守りは毎回の承認と、承認の前に写した写し（写しから読んだ ID を見せ、写しを入れる）が担う。確認の中身は、絶対パスであること、UNC（`\\host\share`・`\\?\`・`//host`）でないこと（`realpath` だけで SMB へ繋ぎ認証情報を送りうるため）、`realpath` で解いた先の拡張子と種類（`.app` はフォルダで中に `Info.plist`、`.ipa` / `.apk` は普通のファイル）、端末の種類との組み合わせ。コマンドと承認ダイアログには解いた先のパスを渡す。ファイル名の文字を `[A-Za-z0-9._-]` に絞る案は見送った（`My App.app` のような空白入りの成果物名が普通にあるため。`adb install` がファイル名を端末側の `pm install` へ渡す古い経路は adb の引用に頼っている）
- 実行はすべて `execFile` に引数配列（シェルを通さない）。`xcrun` は `/usr/bin/xcrun`。`adb` は `ANDROID_HOME` → `ANDROID_SDK_ROOT` → 既定の SDK フォルダ（macOS は `~/Library/Android/sdk`）→ PATH の絶対パスの項目の順に探し、見つけた絶対パスで起動する（裸の `adb` は渡さない。Windows では今のフォルダが先に探されうるため）。見つからなければ覚えずにエラーにする（後から SDK を入れても再起動なしで使える）。環境変数は shared process のもので、ペインの環境は見ない。候補の所有者と書き込み権の確認は見送った（作業フォルダが `~` のエージェントは `~/Library/Android/sdk/platform-tools/adb` を差し替えうる。ただしそれができるエージェントは、利用者のシェルの設定ファイルも書き換えられる）
- **`adb shell` の後ろは端末側のシェルがつなぎ直して解釈する**ので、引数配列でも空白や `;` があればコマンドになる。アプリの ID（`paradisIsValidAppId`）・権限名（`paradisResolveMobilePermission`）・端末の番号（`paradisIsValidNativeDeviceId`）は形を確かめた値しか渡さない。この検査を緩めるときは必ずこの点を見直す
- 権限は1つのアプリに1つずつ付けるだけ（取り消し・`all`・全体の初期化はしない）。付けるのは利用者が入れたアプリだけで、名前ではなく端末に聞いて決める。iOS は `simctl listapps` の `ApplicationType` が `User` のもの（Xcode 27 の出力で確認した。OpenStep 形式の plist を字下げで読む）、Android は `pm list packages -3` に入っているもの。入っていなければ付けない。iOS で付けられる名前は `simctl privacy` の項目（`all` を除く。カメラと通知は無い）。Android は別名（camera など 9 つ）か `android.permission.<NAME>` で、さらに `pm list permissions -g -d` に出る dangerous（実行時の確認が出る）権限だけ。`WRITE_SECURE_SETTINGS`・`READ_LOGS` などの development 権限は断る

レビューの Low で見送ったもの: 候補の adb の所有者の確認（上記）、ファイル名の文字の制限（上記）。

【要確認】実機で確かめていないこと:

- Android エミュレータでの動き全般（`adb` の呼び出し、`/display` とスクショの向き、`pm list permissions -g -d` の出力の形は Android の版ごとに）
- `.ipa` をシミュレータへ `simctl install` できるか（通常シミュレータ向けは `.app`）
- `adb install` の出力の `Success` の判定、`pm grant` が失敗を出力にだけ書く場合の文言、`aapt2 dump packagename` の出力

実機（iOS 27 シミュレータ、2026-09-27 の再レビュー）で確かめたこと: ピンチが2本の指として効く（ホストの `input/touch` の `fingerId`）、向きの名前4つ、インストールのたびの承認、OS のアプリへの権限の拒否、ペインの外からの要求・インストール・起動・権限の拒否。指は要求を送る前に「下ろした」と記録し、失敗・取り消しでも必ず上げる（押したままだとその後の入力を受け付けなくなる）。

## Computer Use は同梱の補助アプリに TCC の許可を閉じ込める（computerUse、2026-09-28、フェーズ7 B3）

設計は研究リポジトリの `phase7-b3/design.md`。読み取りと操作の両方を入れた。設問 Q97〜Q101 はすべて案 A（2026-09-28）。許可したアプリの一覧と取り消し、OS の許可のやり直し（`tccutil reset`）はまだ無い。

| 層 | 置き場所 | 中身 |
|---|---|---|
| 補助アプリ（Swift） | `src/vs/paradis/contrib/computerUse/native/macos/` | `Para Code Computer Use.app`（bundle id `ltd.paradis.paracode.computeruse`、`LSUIElement`、macOS 14 以上、universal、約束の版 2）。読み取りの命令は `handshake`・`status`・`permissions`・`listApps`・`listWindows`・`screenshotWindow`（ScreenCaptureKit の単一ウィンドウ）・`accessibilityTree`、操作の命令は `activateApp`・`click`・`drag`・`scroll`・`typeText`・`pasteText`・`pressKey`・`hotkey` |
| ビルド | `build/paradis/computerUse/buildHelper.ts`・`embedHelper.ts` | swiftc で arm64 と x86_64 を作って `lipo`、`.app` に包んで ad-hoc 署名。`--test` で Swift のテスト、`--if-stale` で古いときだけ作る |
| shared process | `contrib/computerUse/node/` | 補助アプリの起動と接続（`paradisComputerUseHelperClient.ts`）、ペインとアプリの組ごとの許可の台帳（メモリだけ）、MCP ツール 12 件（読み取り 4 件と、`computer_activate_app`・`computer_click`（右・ダブル・トリプルも）・`computer_drag`・`computer_scroll`・`computer_type_text`・`computer_paste_text`・`computer_press_key`・`computer_hotkey`）、状態のチャネル |
| 画面 | `contrib/computerUse/electron-browser/`・`browser/` | 承認ダイアログ（ページ共有と同じ `askApproval`、`cooldownKey` は `computer:<bundle id>`）、状態を見るコマンド `paradis.computerUse.showStatus`、設定 `paradis.computerUse.enabled`（既定オフ、APPLICATION）、設定画面の「Computer Use」節 |

補助アプリは shared process から `open -n -g -j` で起動する。Para Code の子として exec すると TCC の許可が Para Code 本体で評価されうるため。手元（macOS 27、ad-hoc 署名）で `open -n` から起動した補助アプリは `responsibility_get_pid_responsible_for_pid` が自分自身を返した（Developer ID 署名と公証の後も同じかは未確認）。この関数が見つからない OS では確認を飛ばし、自分以外が返ったら `misattributed` で機能を止める。

補助アプリに命令できる者はアプリごとの承認を飛ばせるので、次を全部行う: ソケットとトークンは userData の下の 0700 のフォルダ（パスが 103 バイトを超えるときは一時フォルダの `mkdtemp`）、トークンは 256 bit の乱数で補助アプリが読んだ直後に消す、最初の要求のトークンが違えば答えずに終わる。接続相手は Para Code の shared process そのものに絞る（レビュー H1）。相手は `<main>.helper`（Plugin・Renderer・GPU の helper は断る）で `--type=utility`、環境変数の `VSCODE_ESM_ENTRYPOINT` が `vs/code/electron-utility/sharedProcess/sharedProcessMain`、`VSCODE_CRASH_REPORTER_PROCESS_TYPE` が `shared-process` であること（upstream の `utilityProcess.ts` の `createEnv` が、渡された環境の上から必ず書く。拡張機能ホストへ `--extensionEnvironment` で渡した値でも上書きできず、拡張機能ホスト・pty host と見分けられる。upstream のファイルは触っていない）。引数と環境変数は `sysctl(KERN_PROCARGS2)` で読み、同じ名前が 2 つあれば断る。相手の親は Para Code の main で、相手と main のどちらにも `--inspect*`・`--debug*`・`--remote-debugging*`・`--js-flags`・`--extensionDevelopmentPath`・`--extensionTestsPath`・`--enable-proposed-api`・`--remote-allow-origins` の引数と、`ELECTRON_RUN_AS_NODE`・`NODE_OPTIONS`・`VSCODE_NODE_OPTIONS`・`DYLD_INSERT_LIBRARIES` の環境変数が無いこと（launchctl で `NODE_OPTIONS` を全体に設定している Mac では使えなくなる）。補助アプリにチーム ID がある（リリース）ときは、さらに相手と main が同じチームの Developer ID で署名され、main の親が launchd であることを求める。ad-hoc の補助アプリ（手元のビルドだけ）は、署名の検証と main の親の確認だけを飛ばし、識別子は実行ファイルを含む .app の bundle id で見る（素の Electron `com.github.Electron` は通さない。レビュー L1）。確かめに落ちた接続はその接続だけを閉じて待ち続け（30 秒・20 本まで）、通った 1 本を受けたら listen をやめてソケットのファイルも消す（レビュー L2）。受け入れた相手と main の pid は、命令の的にさせない。

パッケージ版の Electron fuses（2026-09-28、`/Applications/Para Code.app` 1.135.0 と手元の `.build/electron` の `Electron Framework` を読んで確認）: `RunAsNode` 有効、`EnableNodeOptionsEnvironmentVariable` 有効、`EnableNodeCliInspectArguments` 有効、`EnableCookieEncryption` 無効、`EnableEmbeddedAsarIntegrityValidation` 無効、`OnlyLoadAppFromAsar` 無効。fork はビルドで fuses を切り替えていない。inspect の引数と `NODE_OPTIONS` が効くので、上のとおり補助アプリが相手と main の引数と環境変数を見て断る。`RunAsNode` は `resources/darwin/bin/code.sh` が使うので切れない。

起動時の argv と環境変数の外にある経路と、その扱い（再レビュー N2）:

| 経路 | 扱い |
|---|---|
| argv.json（`~/.para-code/argv.json`）から main が実行中に足すスイッチ | 補助アプリが接続を受けるときに、main が読んだはずの argv.json（main の環境の `VSCODE_PORTABLE`・`VSCODE_DEV` に合わせる）を読み、`remote-debugging-port`・`remote-debugging-pipe`・`js-flags`・`enable-proposed-api` と `inspect*`・`debug*` のキーがあれば断る。読めない（JSON5 としても読めない）ときも断る。ただし main が起動時に読んだ中身と、補助アプリが後で読む中身が同じとは限らない（起動の後に消されれば通る）。`js-flags` は utility process の引数にも写るので、相手の argv の確認でも拾える |
| `RunAsNode` の fuse（有効） | 塞げない（`resources/darwin/bin/code.sh` が使う）。同じユーザーのプロセスは Para Code の署名のまま任意のコードを動かせる。そのプロセスが相手や main の親子関係を満たすことは、起動時の環境変数（`ELECTRON_RUN_AS_NODE`）の確認で断るが、`KERN_PROCARGS2` はそのプロセスのメモリから読むので、すでに任意のコードが動いているプロセスについては証拠にならない |
| 後から開く inspector（`EnableNodeCliInspectArguments` が有効で、SIGUSR1・`process._debugProcess` で開ける） | 相手と main が inspector の既定のポート 9229 で待ち受けていれば、接続を受けるときと要求のたびに断る（`proc_pidinfo` の `PROC_PIDFDSOCKETINFO`）。既定のポートは `--inspect-port`（argv で断る）でしか変えられない。Node の中から `inspector.open(<別のポート>)` を呼ぶには、すでにその中でコードが動いている必要がある |
| アプリの中の JS の書き換え（`EnableEmbeddedAsarIntegrityValidation`・`OnlyLoadAppFromAsar` は無効） | リリースでは、接続を受けるときに Para Code.app を `SecStaticCodeCheckValidityWithErrors`（`kSecCSCheckNestedCode`・`kSecCSStrictValidate`）で読み直し、封印されたファイルの書き換え・追加・削除があれば断る（手元の 1.135.0 で `codesign --verify --strict` は 1.3〜2 秒）。例外は内蔵ブラウザの拡張機能の `_metadata/` の下だけ。Chromium が読み込むときに `verified_contents.json` を消すので、手元の `/Applications/Para Code.app` もこのファイルが無いために `codesign --verify --strict` が失敗していた。その分だけを許す。検査の後に書き換えられた JS は、次に補助アプリが起動するまで分からない |
| renderer の remote debugging（常に開いている CDP、再レビュー N1） | 利用者の判断待ちで、まだ直していない。CDP のポートが開いている間は、同じユーザーのプロセスが承認ダイアログのある renderer でコードを動かせるので、承認を飛ばせる。補助アプリの起動時の argv の確認では、実行中に足されたこのスイッチを見られない |

上の表で拾えない残りの穴: 同じユーザーのプロセスが、Para Code の shared process か、承認ダイアログを出す renderer の中でコードを動かせる場合（上の表の塞げない行と、再レビュー N1 の CDP）は防げない。

2 つ目の Para Code: 禁止の引数を付けずに普通に起動した 2 つ目のインスタンス（別の `--user-data-dir` など）の shared process は、相手の確認を通る。main が 2 つ以上動いているときに断ることはしていない（開発で 2 つ動かす使い方を止めないため）。その場合の承認ダイアログは、要求したペインを持つ、2 つ目のインスタンスのウィンドウに出る（MCP サーバーとペイントークンの台帳はインスタンスの shared process ごとにあり、`callOwningWindow` はその台帳でペインを持つウィンドウへだけ送る。コードを読んで確かめた。Para Code を起動しての確認はしていない）。2 つ目のインスタンスを `open -g -j` で隠して起動した場合、ダイアログが利用者に見えないまま待つことはありうる（推測）が、答えが無ければ 2 分で断るので、承認のクリックなしに許可にはならない。

常に断るアプリはパスワードマネージャーとワンタイムコードのアプリ 23 件（Orca の 8 件との和に、KeePassXC・Enpass・Keeper・Strongbox・MacPass・RoboForm・Authy などを足した。各 id は【要確認】）、キーチェーンアクセス、Para Code 自身（`ltd.paradis.paracode` とその下。素の Electron `com.github.Electron` は入れない）、システム設定と認証・同意のダイアログ（Q97 A、`PARADIS_COMPUTER_USE_SYSTEM_SURFACES`）。一覧は TS と Swift に同じものを持ち、テストで突き合わせる。ターミナル類・ターミナルを内蔵したエディタ・ランチャー・スクリプトエディタ・Finder（`PARADIS_COMPUTER_USE_COMMAND_APPS`）は断らず、承認ダイアログに「このアプリを操作すると、コマンドをあなたの権限で実行できます」を足す（Q98 A、再レビュー N12）。SSH 接続先のペインは設定で変えられない固定の拒否（Q99 A）。

承認は「拒否」「読み取りのみ許可」「操作も許可」の 3 つ。読み取りを許可済みのアプリへの操作の求めは格上げとして「拒否」「操作も許可」の 2 つにする。初回の操作の求めに「読み取りのみ」を選んだ・格上げを拒否したときは読み取りの許可を残し、そのペインのそのアプリへの操作は聞き直さずに断る（台帳の `operateRefused`）。読み取りだけのアプリには入力を一切送らない。

入力の守り（設計書 6.3、補助アプリ側）: どの操作もアクセシビリティの許可が無ければ OS に触れる前に断る。常に操作させないアプリ（`ParadisBlocklist.swift`、TS と同じ一覧をテストで突き合わせる）と Para Code の main・shared process の pid も補助アプリの側で断り、shared process の判定と二重にする（レビュー M1）。pid を取る命令は shared process が解いたときの bundle id も受け取り、今のその pid の bundle id と違えば断る（pid の使い回し対策）。送る直前と各イベントの間に、前面のアプリが目的の pid か、マウスなら的の点を覆う一番手前のウィンドウ（透明なものも含む。レビュー L8。Dock と WindowServer の層は除く）と AX の当たり判定の持ち主が目的の pid かを確かめる。キーは、さらに OS に聞いたフォーカスのあるアプリと要素の持ち主（`AXUIElementCreateSystemWide` の `kAXFocusedApplicationAttribute`・`kAXFocusedUIElementAttribute`）が目的の pid であることを求める（詳しくは下の再レビュー N3〜N5 の段落）。認証・同意・ロックの画面（SecurityAgent・coreautha・UserNotificationCenter・CoreServicesUIAgent・loginwindow・ScreenSaverEngine・universalAccessAuthWarn）が画面のどこかに出ていれば、マウスもキーも `system_dialog` で止める（レビュー M3。これらは通常のアプリとして一覧に出ないので、拒否の一覧ではなくこのフェンスが守る）。押したボタンとキーは止めるときも必ず離す（ドラッグは `defer`。レビュー L7）。送らない組み合わせは ⌘Space・⌃Space・⌘Tab・⌘`・⌘⌥Esc・⌃⌘Q・⌘⇧Q・⌘⇧3/4/5/6・⌃矢印・Fn の組み合わせ、⌃ とファンクションキー（⌃F1〜F12。メニューバー・Dock・ツールバーへのキーボード操作）、⌘F5 と ⌘⌥F5（VoiceOver とアクセシビリティのパネル）、⌘⌥D（Dock）、⌘⌥8・⌃⌥⌘8・⌘⌥=・⌘⌥-・⌃⌥⌘,・⌃⌥⌘.（ズーム・色の反転・コントラスト）、⌘V の仲間（⌘V・⌘⇧V・⌘⌥⇧V など。貼り付けは `pasteText` の中だけで送る。レビュー M4・M5）。修飾キーはイベントのフラグで付け、イベントの元は `privateState`。`typeText` は 4,000 文字まで（改行は Return、タブは Tab のキー）、`pasteText` は 20,000 文字まで。クリックとキーは HID のタップへ、スクロールだけ `postToPid`。AX の問い合わせは全体に 1 秒の上限を付け、ツリーを読むのは 20 秒で打ち切る。shared process は応答の締め切りを過ぎた補助アプリを終わらせる（レビュー L5）。番号でのクリックは、ツリーの応答の `snapshotId` を添えさせ、そのペインが最後に読んだツリーの番号だけを使わせる（ほかのペインが読み直した後の番号を使わない。レビュー L6）。

利用者の操作中（Q101 A、レビュー M2）: 補助アプリがセッションのイベントタップ（聞くだけ）で、キー・修飾キー・マウスのボタン・移動・ドラッグ・スクロールを見張る。補助アプリが送るイベントには `eventSourceUserData` に目印を入れ、目印の無いものを利用者の物理的な入力として時刻を覚える。直前 1 秒以内にあれば、長い `typeText`・`drag`・`scroll` の途中でも `user_active` で止め、どこまで送ったかをエージェントへ返す。自分の分を時刻で除く判定はやめた（連続した入力の間の利用者の入力を見逃すため）。タップを作れないときは OS のハードウェアの入力の数（`hidSystemState`）で代え、自分の合成入力で止まる側に倒れる。前面に出す（`activateApp`）も同じ判定を通す。

キーボードの見張りの判断（再レビュー N6・N7）: 聞くだけのイベントタップにキーのイベントが届くには、アクセシビリティとは別に入力監視（ListenEvent）の許可が要る場合があり、実機で確かめていない。そこで、タップにキーのイベントが一度でも届く（補助アプリ自身が送ったキーも数える）までは、キーボードの分は OS の HID の数（`CGEventSource.secondsSinceLastEventType(.hidSystemState, ...)`）で見る。HID の数は補助アプリの合成入力も含みうるので、止まる側に倒れる（タップにキーが届かない Mac では、文字入力が 1 文字目で `user_active` になりうる）。利用者のキー入力を見逃すより、止まる方を選んだ。マウスはタップを作ってから 1 秒の間だけ HID の数も合わせる（作る前の入力を見るため）。タップは補助アプリの起動時に、アクセシビリティの許可があれば作る。入力監視の許可の有無は `permissions` の `inputMonitoring` で返す（`CGPreflightListenEventAccess`、確認は出さない）。自分のイベントかは、目印に加えて送り元の pid（`eventSourceUnixProcessID`）が自分であることで見る（再レビュー N8）。

貼り付け（Q100 A、レビュー M6）: クリップボードの全部の項目と型を退避し、空にしてから文字を入れて ⌘V を送る。貼り付け先のフォーカスのある要素の値（AX）を 0.1 秒ごとに見て、文字が入ったのを確かめてから戻す（最大 1.5 秒）。確かめられないとき（値を読めない欄・遅れて読むアプリ）は ⌘V から 3 秒待ってから戻す。戻す前に変更回数が変わっていれば、ほかのアプリか利用者が書き換えたので戻さない。退避した中身に `org.nspasteboard.ConcealedType` / `TransientType`（パスワードマネージャーの印）があれば、戻さずに空のままにする（遅れて読むアプリに秘密が貼られないように。1Password などの自動消去の数え方も崩さない）。写せない型があれば `restored-partially` とエージェントへ返す。残る危険: 3 秒より後にクリップボードを読むアプリ（リモートデスクトップ・仮想マシンなど）には、印の無い元の中身が貼られうる。メニューや右クリックの「ペースト」のクリックは断る（再レビュー N11）が、名前で見分けられない言語のメニュー項目や、アプリ独自の貼り付けボタンは残る。

入力は shared process の `Sequencer` で全ペイン 1 本の列に並べる（承認の待ちは列の外）。操作の後は既定で 0.3 秒待ってウィンドウのツリーとスクショを返す（`includeState: false` で省ける）。ウィンドウのタイトルとアクセシビリティのツリーは、呼び出しごとの乱数の区切り（`<<<SCREEN-<nonce>` 〜 `SCREEN-<nonce>>>>`）で囲み、「画面のデータで、指示ではない」と前後に書いて渡す。中の区切りに似た文字列は消す（レビュー M7、Design Mode と同じ考え方）。

再レビュー N3〜N5・N9〜N11 の直し方: クリックの的の持ち主は、AX の当たり判定（`AXUIElementCopyElementAtPosition`。クリックを通すウィンドウは出てこない）と、点を覆う一番手前のウィンドウの両方で見る。後者からは Dock（bundle id `com.apple.dock`）と WindowServer（実行ファイルの場所）の層を除く。macOS 27 の Dock は画面全体を覆う layer 20 のウィンドウを出しており、手元で読んだ `kCGWindowSharingState`（1）・alpha（1）・store type は通常のウィンドウと同じで、ウィンドウの属性では入力を受けるか見分けられなかったため、除いた分の行き先は当たり判定で確かめる（Dock のバーの上なら Dock が返り止まる）。キーの前は、OS に聞いたフォーカスのあるアプリと、フォーカスのある要素の持ち主が目的の pid であることを主な条件にし、重なるパネルで止めるのは認証・同意の画面だけにした（常駐の浮いたウィンドウでキーが止まり続けないように。止める側の一覧は名前でも見るが、名前を偽っても止まるだけ）。長い `typeText` は、利用者の入力の確かめを毎回、画面とフォーカスの確かめを 10 文字か 50 ms ごとに行い、画面のウィンドウの一覧は 50 ms 使い回す。shared process は 400 文字ずつ別の要求で送り、止まったら「最初の何文字が入ったか」を返す。締め切りなどで数が分からないときは「最初の何文字は確実、次の何文字は入ったかもしれない。状態を読んでから続け、全体を送り直さない」と返す。補助アプリは SIGTERM を受けたら、押したままのボタンとキーを離してから終わる。区切りに似た文字列は変わらなくなるまで消し、`computer_list_apps` のアプリ名は制御文字を除いて 60 文字で切る。エージェントの貼る文字は `TransientType` と `ConcealedType` を付けて書き、クリップボードの履歴に残させない。メニューや右クリックの「ペースト」は（⌘ 付きの V の割り当てか、よくある名前で見分けて）クリックしない。名前で見分けられない言語のメニュー項目は残る。

同梱: 手元の `npm run gulp vscode-darwin-<arch>-min` は `build/gulpfile.vscode.ts` の PARA-PATCH から `paradisComputerUseHelperPackageTask` を呼び、補助アプリを作って `Contents/Helpers/` に入れる（失敗は警告だけ。`PARADIS_COMPUTER_USE_HELPER=0` で飛ばせる）。CI（`CI` がある）では gulp は何もせず、`para-release.yml` の 3 段（Build / Pre-notarize / Embed）に任せる。ステーブルでは 3 段とも `continue-on-error` で、失敗したら補助アプリを外して出荷する。ベータ（Q102）では失敗でビルドを止め、署名と公証の後に zip の中の補助アプリを確かめる（下の「ベータ版の配布経路」）。Embed は Pre-notarize が Apple に受け入れられたとき書く目印（`.build/paradis/computerUse/prenotarized`）があるときだけ入れる。`workflow_dispatch` の `computer_use_helper` を false にすると、ステーブルでは 3 段とも飛ばす（ベータでは効かない）。`build/darwin/sign.ts` の PARA-PATCH は補助アプリに空の entitlements を渡す 3 行だけ。本体の公証が補助アプリのせいで拒否された場合に補助アプリを外して出し直す段は無い（Pre-notarize で先に潰す前提）。

手元で試すとき: `node build/paradis/computerUse/buildHelper.ts --out <どこか> --allow-any-peer-for-testing` で接続相手の確認を外したビルドを作れる（node から直接つなぐため）。既定の出力先には書けず、`Info.plist` に `ParadisTestingBuild` が付いて `embedHelper.ts` が埋め込みを断る。ad-hoc の補助アプリはビルドのたびに TCC から別物と見なされる。ビルドのテストは `node --test build/paradis/computerUse/*.test.ts`（`build/package.json` の `test` の対象には入れていない）。

設定 `paradis.computerUse.enabled` のオン・オフは守りの境界ではない。ペインのエージェントは同じユーザーなので `settings.json` を書き換えてオンにできる（`APPLICATION` と `restricted` はワークスペースの設定を防ぐだけ）。境界はアプリごとの承認ダイアログで、オフからオンに変わったときは各ウィンドウに 1 回通知を出す（レビュー L14）。パッケージ版は開発用の `<appRoot>/.build/paradis/computerUse/` を探さない（レビュー L4）。認証の画面の日本語のラベル（パスワード・暗証番号・認証コード・確認コード・セキュリティコード・ワンタイム）も値を伏せる（レビュー L9）。システム設定は `com.apple.systempreferences` の前方一致（レビュー L10）。承認ダイアログのコマンドの警告は、ターミナルを内蔵したエディタ（VS Code・Cursor・Zed・Xcode・JetBrains）とショートカット・Raycast・Alfred にも出す（レビュー L11、各 id は【要確認】）。CI の Pre-notarize は `timeout-minutes: 25` と `notarytool --timeout 20m`、埋め込みの前に `lipo -verify_arch arm64 x86_64`（レビュー L12・L13）。

### ベータ（`v1.139.1-paracode-146-beta.2`）の実機で見つかった不具合と直し方（2026-09-28）

署名したベータを macOS 27.0（Apple Silicon）で試し、補助アプリへの接続・TCC の付き先・承認・スクショ・AX ツリー・nonce の区切り・利用者の入力で止まる判定・日本語の貼り付けとクリップボードの復元・⌘V の拒否は期待どおりだった。次の 4 件を直した。

| 不具合 | 原因（推測を含む） | 直し方 |
|---|---|---|
| `computer_type_text` で約 2 割の文字と空白が落ち、それでも `typed: 64` と返した（TextEdit に `abc…xyz ABC…XYZ 0123456789` を送り、`abdefgiklmoprsuvwyzABCDEFGHIJLMNOQRSUWXY 0134689` が入った） | 推測: 1 文字ごとに仮想キー 0 の keyDown と keyUp を間を置かずに HID のタップへ送り、イベントの元もイベントごとに作り直していた。入力ソースが日本語の IME だと、IME がキーのイベントを取り込むので落ちやすい。送った後に確かめていなかったので、落ちても成功と返した | 1. フォーカスのある欄が `AXSelectedText` の置き換えを受け付けるなら、AX で入れる（キーも IME も通らない。TextEdit はこの経路）。2. だめなら、入力ソースが IME（`kTISPropertyInputSourceType` が `TISTypeKeyboardLayout` 以外、または id に `.inputmethod.`）のときは英数字でも貼り付けに寄せる。3. それ以外はキーを送る。イベントの元を 1 つにし、押してから離すまで 12 ms、文字の間 20 ms を置く。どの経路でも入れた後に欄の値を読み戻し、入れる前の値と選択範囲から期待した値になったかを確かめる（`paradisTypingOutcome`）。そのままでなければ、どこまで入ったかを返して止める（入れ直すと二重になるので送り直さない）。読み戻せない欄は「確かめられない」と返す。改行とタブの扱い・入れ直しの条件・読み戻しの比べ方は、下の「ベータ 3 のレビュー」で直した |
| 既定のウィンドウに、画面に出ていない 53×48 のウィンドウが選ばれた（TextEdit） | 手前からの順で最初の「画面に出ている」ものを選んでいたが、CGWindowList の `kCGWindowIsOnscreen` と実際の見え方が食い違う補助のウィンドウがあった | 補助アプリが AX でウィンドウの種類（`AXStandardWindow` か）としまわれているかを返す。shared process は、画面に出ている標準のウィンドウ、画面に出ている大きなもの、しまわれた・画面の外の大きなもの、100 ポイント未満の小さなもの、の順に並べ直して番号を振り直す（`paradisRankWindows`）。`computer_list_windows` の順と `windowIndex` も同じ基準 |
| Finder のサイドバーの全部の `AXCell` に `focused` が付いた | 要素ごとの `AXFocused` を読んでいた。表の中のセルは表がフォーカスを持つと true を返すアプリがある | アプリの `AXFocusedUIElement` と同じ要素（`CFEqual`）にだけ `focused` を付ける。選ばれている行・項目は `AXSelected` から `selected` として別に出す |
| Proton Authenticator（`me.proton.authenticator`）が拒否されていなかった | 2 段階認証のアプリが一覧に無かった | パスワードマネージャーと同じ扱いの一覧を足した（`authenticator`）。Proton Authenticator・Authy・Google Authenticator・Microsoft Authenticator・Bitwarden Authenticator・Ente Auth と、bundle id に `authenticator`・`2fas`・`raivo`・`otpauth`・`steptwo` を含むもの全部（前後が `*` の一覧の書き方を足した）。各 id は【要確認】。Swift と TS の一覧はテストで突き合わせる |

補助アプリとの約束の版は 6（`typeText` がテキストそのものを受け取り、`method`・`verified`・`inserted`・`rewritten` を返す。`pasteText` の `pasteVerified` は確かめられないとき null）。

ベータ 3 のレビュー（`beta3-review.md`、High 1・Medium 3・Low 7）で直したこと:

- **AX で入れた後の入れ直し（H1）**: 次の経路（貼り付け・キー）へ落ちるのは、書き込みが起きていないと言い切れるときだけにした。欄が選択範囲の置き換えを受け付けない・値か選択範囲を読めない（書く前にやめる）・書き込みが `kAXErrorAttributeUnsupported`・`IllegalArgument`・`NotImplemented`・`InvalidUIElement`・`APIDisabled`・`ActionUnsupported` で失敗したとき。成功・締め切り（`CannotComplete`）・一般の失敗のときは、50 ms ごとに最長 1 秒読み直し、変わらなければ「確かめられない（遅れて入るかもしれない）」と返して止める。選択範囲と同じ文字列で置き換えた場合は、変わらないのが正しいので成功。判断は Core の `paradisAXWriteCertainlyDidNothing` と `paradisAXReadbackStep` に置いてテストした
- **改行とタブ（M1）**: 改行はどの経路でも改行の文字として入れ、Return は押さない（送信は `computer_press_key` の return、と利用者と合意した内容に合わせた）。キーの経路は改行を送れないので、改行を含む文字列は貼り付けに回す。タブは断る（キーでは次の欄へ移り、AX と貼り付けではタブ文字が入るので、`ユーザー名\tパスワード` でパスワードが普通の欄に文字として入りうる）。読み戻しは、入れる前にフォーカスのあった同じ要素から行う。AX と貼り付けに渡す前に `\r\n` と `\r` を `\n` にそろえる（L2）
- **読み戻しの比べ方（M2・L1）**: 選択範囲の外（前後）が残っていれば、その間を入った部分として取り出して比べる。完全に同じなら成功。スマート引用符・ダッシュ・省略記号・空白・大文字小文字・数字の区切りを畳んで同じか、入った部分が送った文字列を含む（補完で後ろが伸びた）なら成功で `rewritten`。長さが同じで中身が違う（自動修正）なら失敗で `rewritten`、それ以外で送った文字列が見つからなければ「欄が送った文字列と違う」（落ちたとは言い切らない）。前後が崩れた・選択範囲が読めないときは、送った文字列の出てくる回数が入れる前より増えたかで見る（前からあった同じ文字列では成功にしない）。値が変わらなければ確かめられない。貼り付けの確かめも同じ関数で行う
- **エージェントへの返し方（L3・L5）**: 確かめられなかったときの要約は `verified: null`（false と書くと「入らなかった」と読まれて送り直される）。止めたときに、前の塊が確かめられていなければ「送った（全部は確かめられていない）」と書き分ける。塊ごとのクリップボードの戻し方の理由は全部伝える。IME が有効なときと改行を含むときは `computer_type_text` もクリップボードを使う（Q100 の退避・印付きなら空にする・他者の書き換えを優先・貼る文字への印はそのまま効く。3 秒より後に読むアプリに元の中身が貼られうる既知の穴も、`type_text` に広がった）。ツールの説明にそう書いた
- **キャレット（L4）**: AX で入れた後、入れた文字列の直後にキャレットが無ければ `AXSelectedTextRange` で直す。直せなければ「確かめられない」にする（次の塊が前の塊の手前に入りうるため）
- **ダイアログ（M3）**: 補助アプリが、アプリの `AXFocusedWindow`（無ければ `AXMainWindow`）に `focused` を付ける。並べ直しは、前に出しているウィンドウを先頭にし、画面に出ている `AXDialog`・`AXSystemDialog`・`AXSheet` を標準のウィンドウと同じ段に入れる（手前からの順で書類より先に来る）。`windowId` の説明に、続けて使うなら `windowIndex` より `windowId` を、と書いた
- **2 段階認証（L6）**: `*twofas*`・Duo Mobile（`com.duosecurity.DuoMobile`・`*duomobile*`）・Authy の iPhone 版（`com.authy`）・Okta Verify（`com.okta.mobile`）・Yubico Authenticator の旧版（`com.yubico.yubioath`・`*yubioath*`）を足した（各 id は【要確認】）。設定画面の検索語に `authenticator two-factor 2fa otp` を足した
- **ツリーの読み取り（L7）**: 要素の属性は `AXUIElementCopyMultipleAttributeValues` でまとめて 1 回で読む

利用者向けの注意（ベータの実機で分かったこと）:

- システム設定の「アクセシビリティ」の一覧に古い「Para Code Computer Use」の項目が残っていると、スイッチがオンでも `AXIsProcessTrusted()` が false のままになる（推測: 別の署名の補助アプリ、たとえば手元の ad-hoc のビルドで付けた項目が残っているとき）。直し方は、その項目を「−」で消してから「＋」で `Para Code.app/Contents/Helpers/Para Code Computer Use.app` を足し直す
- シェルの `mv` で `/Applications` に置いたアプリは、ダウンロードの隔離の印が残ったまま App Translocation（読み取り専用の仮の場所）で動き、自動更新ができない。Finder でドラッグして置き直すか、`xattr -d com.apple.quarantine "/Applications/Para Code.app"` で印を外す

レビューの Low で見送ったもの:

| ID | 見送った理由 |
|---|---|
| L3（shared process が、つないだ先が本物の補助アプリかを確かめない） | 同じユーザーがセッションのフォルダに先にソケットを作れる場合、偽のサーバーが受け取れるのはエージェントが送る文字と承認済みのアプリの名前で、承認と TCC の迂回にはならない。Node からソケットの相手の pid を取る手段が無く（`LOCAL_PEERPID` は Node に無い）、`lsof` を毎回起動するのは重い。フォルダは毎回 `mkdtemp` の乱数の名前で、0700 の userData の下にある |
| L12 の後半（公証を片方のジョブだけで行う） | x64 と arm64 のジョブの間で成果物を受け渡す段が要り、ワークフローの形が変わる。ベータのワークフローへまとめる担当に任せる |
| H1 の直し方 4（接続中にメニューバーへ項目を出す） | 指示の範囲外。拡張機能ホスト・pty host・renderer からの接続は断る。普通に起動した 2 つ目のインスタンスの shared process は通る（上の「2 つ目の Para Code」） |
| 再レビュー N14 の候補の実在 | AuthenticationServicesAgent・AuthKitUI・PassKit・BluetoothUIServer・CoreLocationAgent の名前と bundle id を止める側の一覧に足したが、実機での確認はしていない（【要確認】） |

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

## フェーズ2との統合（2026-09-28 実施済み、フェーズ3のレビューで判明した重複と取りこぼし）

フェーズ3（hook の信頼・モデル候補）はフェーズ2（`para/phase2`）より先に main へ入ったため、重複と取りこぼしが残っていた。フェーズ2を main へ載せ直したときに次のとおり片付けた。挙動を揃えた箇所は各項目に書く。

1. **Codex app-server のクライアントは `src/vs/paradis/node/paradisCodexAppServerRpc.ts` の1つにした。** フェーズ3の `paradisCodexAppServerSession.ts` は消した（limitsMonitor の `ParadisCodexRpcSession` はフェーズ2の時点で既に寄せてあった）。足したオプションは `codexHome`（env の `CODEX_HOME` を上書き）・`cwd`・`clientTitle`（hook の信頼とモデル一覧は従来どおり `Para Code` を送る）。「メソッドが無い」は `ParadisCodexRpcMethodNotFoundError`（`ParadisCodexRpcError` の派生、`method` を持つ）で、`-32601` か文言の `method not found` / `unknown variant` で見分ける（codex 0.155.1 は知らないメソッドに `-32600` の `unknown variant` で答える）。揃えた挙動: hook の信頼とモデル一覧も `-s read-only -a never app-server` で起こし、`jsonrpc: "2.0"` を付ける。`config/batchWrite` は読み取り専用のサンドボックスのままで書ける（app-server 自身が config.toml を書くので、サンドボックスはかからない。2026-09-27 に codex 0.155.1 を一時の HOME と `CODEX_HOME` で動かし、`hooks.state` が書けることを確かめた）。時間切れと終了のエラーの文言は limitsMonitor の Sentry 用の分類に合わせたフェーズ2の形（`codex app-server request '<method>' timed out` など）になり、hook の信頼の detail から app-server の標準エラーの末尾は消えた（標準エラーは trace ログへ出る）。「メソッドが無い」の文言も app-server の文言そのままになった
2. **Codex のホームの一覧はフェーズ2の `paradisCodexHomes()` に揃えた。** hook の信頼（上の agentHookTrust の節）、会話集計と全文索引（agentActivity の節。WSL のホームも読む）。会話の再開一覧（sessionResume）とモバイルの会話はフェーズ2で既に全ホームを見ている。スキル管理は変えていない。codex 0.155.1 を一時の HOME と `CODEX_HOME` で動かして `skills/list` を見たところ、読むのは `$CODEX_HOME/skills` と `~/.agents/skills` で、`CODEX_HOME=~/.codex-2` の Codex は `~/.codex/skills` を読まない。スキル管理の「Codex · ユーザー」は既定のホームの `skills` だけを出すので、そこへ入れたスキルはアカウントを切り替えた Codex からは見えない（【要判断】アカウント用ホームの `skills` も一覧に出すか、共通の `.agents` を勧めるか。Para Code の使い方のスキルは `~/.agents/skills` に置くので影響しない）。モバイルのコマンド一覧（`mobileRelay/node/paradisAgentCommandCatalog.ts`）も既定のホームの `skills` だけを読む
3. **原子的な書き込みは `src/vs/paradis/node/paradisWriteFileAtomic.ts` にまとめた。** 同期版 `paradisWriteFileAtomicSync`（hook の設置。挙動は旧 `paradisWriteFileAtomicallySync` のまま）と、非同期版 `paradisWriteFileAtomic(path, content, options)`。非同期版のオプションは `newFileMode`（既定 0600）・`createParentMode`・`beforeReplace`（置き換える直前の確認。投げたら置き換えない）・`fallbackToInPlace`（既定 true）。MCP 設定の `writeConfigAtomic` は `beforeReplace` で「読んだときのままか」を確かめ、`fallbackToInPlace: false`。Claude のログイン情報と登録の一覧（旧 `paradisWriteFileAtomically`）は `createParentMode: 0o700`・`fallbackToInPlace: false`。揃えた挙動: 非同期版はどれも symlink を多段・リンク先が無い場合まで辿って実体を置き換え、fsync する（MCP の設定は従来どおり、読む時点で symlink なら書かない。macOS 以外の `.credentials.json` は Claude Code と同じく symlink を断り、0600 に固定する）。Windows の一時的な EPERM・EBUSY には `vs/base/node/pfs` のリトライ付き rename で 5 秒まで待つ。codexAccounts の台帳3つ（リセットクレジット・選択・会話の共有）もこの非同期版で書く（fsync あり、失敗時に一時ファイルを残さない）。旧 `paradisWriteFileAtomically` は symlink をただのファイルで置き換えていた（`~/.claude.json` を dotfiles から symlink している人のリンクが切り替えで消えていた）ので、ここは挙動が変わる
4. **CLI の実行ファイルの探し方は `paradisResolveAgentCli`（`src/vs/paradis/node/paradisAgentCli.ts`）に寄せた。** limitsMonitor・ccusage・codexAccounts（`paradisResolveCodexCommand`）・Claude のアカウント追加（`paradisClaudeLogin.ts`）が使う。候補の場所は `paradisAgentCliFallbackDirs` だけで決める。limitsMonitor と ccusage は従来どおり `<名前> --version` が通るかで PATH 上にあるかを確かめ（オプション `isOnPath`）、そのときはコマンド名のまま返す。ccusage の候補の場所と順（`.deno/bin` を含む）、Windows でのファイル名の順（`.cmd` が先）、見つからないときの `npx` は変えていない。揃えた挙動: PATH の相対パスの要素は全員が無視する（旧 `paradisResolveAgentCli` は作業ディレクトリから解決していた）。macOS / Linux では実行権のあるファイルだけを採る（旧 `paradisResolveAgentCli` はファイルの有無だけ）。Windows の Codex の候補に `~/.codex/bin` が全員に入り（旧は limitsMonitor だけ）、codexAccounts の Windows の候補に `~/.local/bin` が入った。Claude のアカウント追加では `~/.claude/local` を見る順が2番目から最後になり、Windows で拡張子の無い `claude` も候補になった
5. `paradis.sharedProcess.contribution.ts` の「登録」欄を1つのブロックにした。codexAccounts がアカウント用ホームを有効にする（`paradisEnableCodexAccountHomes`）ので、ホームの一覧を使う agentHookTrust・agentActivity より先に並べた（登録は import の順）

## フェーズ2 載せ直し後の再レビュー（2026-09-28）で見送った指摘

`/Users/example/Documents/para-code-research/phase2/rereview-findings.md`（手元の調査メモ、リポジトリ外）の Medium 4 件と、Low のうち L1〜L8・L10〜L17・L19〜L22 は直した。見送ったものと理由:

- **L9（limitsMonitor・ccusage の PATH 確認に相対パスの要素が効く）**: `<名前> --version` での確認も実行も、同じ env と作業ディレクトリで行うので、確かめた場所と動かす場所はずれない。以前からの挙動で、env を絞ると `canExecute` の使い手（ccusage の `npx` の探索）まで変わるので見送った
- **L18 / 前回 regression L2（モバイルが Claude 側の新しい状態に追いついていない）**: モバイルは別の担当なのでここでは直さない。PC がモバイルへ送る Claude のアカウントの形は次のとおり変わった。`status` に `rate_limited`（取得回数の上限に当たって待っている）が増え、モバイルでは既定の文言「上限に達したアカウントは…」で出る。`statusDetail` に英語の短い理由（`shared with claude-swap` など）が入ることがあり、モバイルはそのまま出す。メールアドレスが分からない登録では表示名が `para-claude:<uuid>` になる。モバイル側で `accountStatusMessage` と型に `rate_limited` を足し、`statusDetail` は出さないか訳す必要がある
- **前回 architecture 2（使用量パネルのホーム探しが `/^\.codex(-[\w.]+)?$/` のまま）**: 使用量パネルは SSH の接続先（REH）でも動き、そこではアカウント用ホームを有効にしていない（`paradisCodexHomes()` は既定のホームしか返さない）。寄せると接続先の `~/.codex-*` のカードが消えるので、表示は従来どおりにした。設定 `paradis.limitsMonitor.codexHomes` の説明に、使用量パネルと切り替え・hook・集計で見るホームが違うことを書いた
- **前回 correctness 15（`offerRevision` に `fetchedAt` を含む）**: 前回も許容範囲とされたもの。読み直すたびに提示が変わったとみなされるだけで、二重に使われることはない
- **L6（全文索引と再開一覧で、同じ会話の代表のパスが違うことがある）**: コメントを事実に合わせて直した。ずれた会話は索引に無いものとして従来の検索で探すので、結果は同じで遅くなるだけ
- **L13（非同期版は読み取り専用・ハードリンクを守らない）**: 使い手（userData の JSON、Claude のログイン情報、MCP 設定）は以前からこの挙動なので、JSDoc に違いを書くに留めた

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
- 2026-09-28 から、publish するのはタグからの実行だけ。ブランチ上の `workflow_dispatch` は `platforms` が空でもビルドだけで止まる（以前はブランチからでも `stable:*` を書き換えられた）。復旧で同じタグを回し直すときは `gh workflow run para-release.yml --ref <タグ>` を使う
- ステーブル（`v{upstream}-paracode-{N}`）とベータ（`...-beta.{M}`）以外の形式のタグは、ビルド前に失敗する。ベータの出し方は下記「ベータ版の配布経路」
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

### ベータ版の配布経路（2026-09-28）

ベータは「ステーブルと同じ挙動のビルドが、ベータ用の更新先だけを見る」形で、GitHub のプレリリースから手動で入れてもらう。設計の比較（`quality` を `beta` にしない理由など）は調査メモ `beta-channel/design.md`（リポジトリ外）にある。

ビルドの見分け方は `product.json` の `paradisUpdateChannel` で、`quality` は `stable` のままにする。`quality` を変えると `src/` の `quality === 'stable'` 分岐（拡張のプレリリース優先、実験設定の既定値など）までベータ寄りになり、試したい機能以外の差分が混ざるため。

| 箇所 | ベータのときの動き | ステーブル（値なし）のとき |
|---|---|---|
| `build/gulpfile.vscode.ts` | env `PARA_UPDATE_CHANNEL=beta` を `paradisUpdateChannel` に刻む | `stable` か未設定なら何も刻まない |
| `src/vs/platform/update/common/paradisUpdateChannel.ts` | `resolveParadisUpdateChannel` が `beta` を返す | `quality` を返す（従来どおり） |
| `abstractUpdateService.ts`（PARA-PATCH 1 行） | フィード `/api/update/{platform}/beta/{commit}` | `/api/update/{platform}/stable/{commit}` |
| `paradisReleaseNotes.contribution.ts` | 更新履歴 `/api/changelog/beta` | `/api/changelog/stable` |

チャネルの優先順は「設定 > 刻んだ値 > `quality`」。将来 `paradis.update.channel` を足すときは、その値を `resolveParadisUpdateChannel` の第 2 引数に渡し、設定の変更で `reconfigure()` を呼べばよい（今は設定を作っていない）。Windows の更新キャッシュ名は `productService.quality` を直接使うので、ベータでも `stable` のまま。

ワークフロー側は、最初の `classify` ジョブが `build/lib/paradisReleaseChannel.ts` でタグを分類し、以降のジョブはその出力だけを見る（`needs.classify.outputs.channel` / `is_beta` / `publish`、ビルドジョブには env `PARA_UPDATE_CHANNEL` と macOS に `PARA_RELEASE_IS_BETA`）。

| | ステーブルのタグ | ベータのタグ |
|---|---|---|
| ビルド | 5 プラットフォーム | macOS の arm64・x64 だけ |
| R2 | `stable/{platdir}/{commit}/{file}` | `beta/{platdir}/{commit}/{file}` |
| KV（フィード） | `stable:*` の 5 キー | `beta:darwin`・`beta:darwin-arm64` だけ。`stable:*` は書かない |
| KV（更新履歴） | `changelog:stable`（改名済みの md） | `changelog:beta`（`## 未リリース` を含む md をそのまま） |
| GitHub Release | 従来どおり（Latest になる） | `--prerelease --latest=false`。既にあれば `gh release edit` で付け直す |
| REH（`reh` Release） | 従来どおり `--clobber` で積む | 同じ `reh` に commit 名で積む。同名のファイルが既にあれば上書きしない（一覧を取れなければ止まる） |

ステーブルの出力で変わったのは 1 点だけで、`gh release create` に `--notes-start-tag <前のステーブルのタグ>` が付く。GitHub は `--generate-notes` の起点の選び方を文書にしておらず、main の外にあるベータのタグが起点になると、本文から PR が抜けるおそれがあるため。前のタグは `gh release list`（プレリリースと下書きを除く）の中から `paracode-N` が今より小さい最大のものを `build/lib/paradisReleaseChannel.ts previous-stable` で選ぶ。無ければ付けない。R2 のキー、KV のキーと値、アップロードするファイルは変わらない。

これらは `build/lib/test/paradisReleaseContract.test.ts` が固定している（`cd build && npm test`）。publish ジョブの 2 段と `para-reh.yml` の公開の段を bash でスタブ実行して、R2・KV・`gh` の呼び出しを 1 行ずつ比べる（Release が既にある場合の `gh release edit` の経路を含む）。あわせて、本物の分類の出力を YAML の `outputs:`・`if:`・`env:` の式に通し、各ジョブが動くか・刻まれるチャネル・`CHANNEL` を確かめる（ブランチからの実行、ビルドの失敗、出力が空のときに公開されないことを含む）。分類の出力が空なら `classify` ジョブ自体が失敗する。

ベータを出す手順:

1. このワークフローの変更が入った main の上に、ベータ用ブランチ（例: B3 の Computer Use を載せたもの）を作って push する。ワークフローはタグの commit にある `para-release.yml` で動くので、ブランチ側にも同じ変更が要る。B3 側も `para-release.yml` を変えているので衝突が見込まれる。解消の途中で `classify` の配線を落とさないこと
2. タグを打つ前に、必ず次を実行して `All checks passed` を確かめる。ベータの経路を持たない commit にベータのタグを打つと、古いワークフローが `stable:*` と `changelog:stable` を書き、ステーブルの全員に配信される

   ```bash
   git fetch origin
   node build/lib/paradisCheckBetaTag.ts <タグを打つ commit> v1.139.1-paracode-146-beta.1
   ```

   スクリプトは、タグがベータの形式で未作成か、commit がリモートのブランチに載っているか、その commit の `para-release.yml` と `para-reh.yml` に `classify` の配線があり `build/lib/paradisReleaseChannel.ts` があるか（`git grep` / `git cat-file`）を見る。最後に、その commit を一時的な sparse worktree に取り出し、その commit の契約テスト 2 本（`paradisReleaseChannel.test.ts`・`paradisReleaseContract.test.ts`）を実行する。依存はこのチェックアウトの `build/node_modules` を使うので、先に `build` で `npm ci` 済みであること
3. `## 未リリース` は改名しない。タグ `v{upstream}-paracode-{次のステーブルの N}-beta.{M}` をその commit に打って push する
4. 走り終わったら、プレリリースの本文をベータの説明に書き換える（`gh release edit <タグ> --notes-file <ファイル>`）。Release を手でタグより先に作らないこと（`gh release create` はタグが無ければ既定ブランチの先端にタグを作り、main の先端でワークフローが走る）
5. 確かめること: `beta` のフィードに旧 commit を名乗って 200、ベータの commit で 204。`stable` のフィードに最新ステーブルの commit で 204（ステーブル利用者に何も届いていない）。Releases ページの Latest が最新ステーブルのまま

テスターはベータを入れている間、ステーブルの修正を受け取らない。ベータを含むステーブルを出したら、`beta:darwin`・`beta:darwin-arm64` をそのステーブルのレコードで、`changelog:beta` を `changelog:stable` で上書きする（卒業の操作）。`changelog:beta` を残すと、テスターが更新するまで更新履歴の「利用可能な更新」に新しいステーブルが出ない。ステーブルのビルドにはチャネルが刻まれていないので、次の更新でテスターはステーブルのフィードへ戻る。更新サーバー（Worker）は `quality` を制限していないので、ベータのために変更もデプロイも要らない。

卒業の操作は今は手作業で、書き込み先が `beta:` で始まることを必ず見てから実行する（`stable:` を書き換えるとステーブルの全員に影響する）。`<NAMESPACE_ID>` は GitHub Secrets の `CF_KV_NAMESPACE_ID` と同じ値:

```bash
export CLOUDFLARE_ACCOUNT_ID=<アカウント ID>   # 無いとローカルの wrangler は非対話でエラーになる
NS=<NAMESPACE_ID>
for p in darwin darwin-arm64; do
  wrangler kv key get --namespace-id "$NS" --remote "stable:$p" > "/tmp/stable-$p.json"
  cat "/tmp/stable-$p.json"   # 中身が B3 を含むステーブルの commit であることを確かめる
  wrangler kv key put --namespace-id "$NS" --remote "beta:$p" --path "/tmp/stable-$p.json"
done
wrangler kv key get --namespace-id "$NS" --remote changelog:stable > /tmp/changelog-stable.md
wrangler kv key put --namespace-id "$NS" --remote changelog:beta --path /tmp/changelog-stable.md
```

wrangler の成否は出力全体で確かめる（パイプで握りつぶさない）。確かめ方は手順 5 と同じで、`beta` のフィードにベータの commit を名乗ると、そのステーブルの JSON が返る。

B3（Computer Use）の補助アプリの段は、ベータ用ブランチ `para/beta-computer-use` で合わせた（2026-09-28）。Q102 の 7 で「ベータでは補助アプリの失敗で止める（ステーブルは外して出荷のまま）」と決めているため、次の 2 点を入れた。

- 補助アプリを作る・単独で公証する・埋め込む段は `continue-on-error: ${{ needs.classify.outputs.is_beta != 'true' }}` で、`if` は `is_beta == 'true' || computer_use_helper != 'false'`（ベータでは入力で飛ばせない）。補助アプリが作られていない・公証の印が無いときに埋め込みを黙って飛ばす分岐は、ジョブの env `PARA_RELEASE_IS_BETA` が `true` なら失敗にする。ステーブルの動き（外して出荷）は変えていない
- ベータのときだけ、`build-darwin` の `Notarize + staple` の後・`Compute sha256` の前に、出荷する zip の中に `Contents/Helpers/Para Code Computer Use.app/Contents/MacOS/ParadisComputerUse` があるかを `unzip -l` で確かめる段を足した（`Verify the Computer Use helper is in the beta zip`）

`para-reh.yml` は、タグ（ステーブル／ベータ）からの実行だけが `reh` に公開する。ブランチからの手動起動はビルドと artifact までで止まる。

## Orca 取り込み第二弾の PC 側（W2-01/03/06/09/10/11、2026-09-28）

調査レポートは `orca-wave2.md`（W2 の表）。どれも fork 所有のファイルだけで完結し、upstream のファイルは触っていない。

### 鍵とペアリング台帳は、読めなければ上書きしない（W2-01）

`paradis-mobile-relay.json` の読み書きは `mobileRelay/node/paradisMobileRelayStateFile.ts` にまとめた。以前は読めない・復号できないときに空の台帳と新しい鍵で黙って上書きし、全スマホのペアリングが外れていた。

| 状態 | 扱い | `IParadisMobileStatus.storeProblem` |
|---|---|---|
| ファイルが無い（ENOENT） | 初回として作る | なし |
| JSON として壊れている・形が違う | `<名前>.corrupt-<ISO日時>` へ rename して空から。新しい台帳を保存できたら案内を消す | `corrupt` |
| 読めない（EACCES など） | ファイルを残して接続を止める | `unreadable` |
| 鍵を復号できない（safeStorage の拒否など） | 台帳（端末名）は見せたまま、ファイルを残して接続を止める | `undecryptable` |

止めている間は `save()` と `ensureIdentity()` が例外を投げ、ファイルには触らない。利用者は通知・メニューから「再試行」（`retryLoadState`。`unreadable` のとき）、「再起動」（`undecryptable` のとき）、「ペアリングし直す」（確認ダイアログの後 `discardUnreadableState` → `<名前>.<理由>-<日時>` へ退避 → 通常のペアリング）を選ぶ。退避に失敗したら作り直さない。保存は `paradisWriteFileAtomic`（0600 固定・symlink 拒否・その場書き込みへ落とさない）。エージェントのセッション対応表（`paradisAgentSessionStore.ts`）も原子的に書くようにした。

レビュー（2026-09-28）で直したこと:

- 読むのは一度だけ（`ensureLoaded`）。`initialize` はウィンドウごとに呼ばれるが、一度読めたら以後は読み直さない（止めている間だけ読み直す）。以前は別のウィンドウの一時的な読み取りの失敗で稼働中の接続が落ち、復号を待つ間に `this.state` を差し替えて直前のペアリングを巻き戻しえた。台帳は鍵を戻せてから採る。退避しようとしたら元のファイルがもう無かった（ENOENT）ときは「無い」と同じに扱う
- 読み書きは1本の列（`enqueueStore`）に並べ、中身は書く時点で文字列にする（通知設定の保存などが投げっぱなしで呼ばれるため）。鍵の生成も同時に呼ばれて2つ作らないよう1つにまとめた
- 退避したファイル（`.corrupt-*`・`.unreadable-*`・`.undecryptable-*`）は名前の日時で新しい3つだけ残し、書きかけで残った一時ファイルは読むときに消す
- **macOS の safeStorage は、キーチェーンから鍵を取れなかった結果をプロセスが終わるまで覚える**。Chromium の `components/os_crypt/sync/os_crypt_mac.mm` の `OSCryptImpl::DeriveKey()` は、`GetPassword()` の成否にかかわらず `try_keychain_ = false` にし、以後は鍵が無ければ即座に失敗を返す（main ブランチのソースで確認。Electron 43 の Chromium でも同じかは【要確認】。推測: 以前の版の `g_key_is_cached` も失敗を覚える作りだった）。復号は main プロセスの `encryption` チャネルで行うので、`undecryptable` は Para Code を再起動しないと読み直せない。案内とメニューは「キーチェーンへのアクセスを許可してから再起動」にした
- 通知はウィンドウ1つだけから出す（`claimStoreProblemNotice` が理由ごとに1回だけ true を返す。理由が変わるか解消したら戻す）

### スリープ復帰と再接続の間隔（W2-03 / W2-06）

- shared process は main の `nativeHost` チャネルの `onDidResumeOS`（`NativeHostService(-1, mainProcessService)`、`sharedProcessMain.ts` と同じ作り方）を `paradisMobileRelayChannel.ts` で購読し、`handleSystemResume()` を呼ぶ。pong を返すと分かっているリレーなら即 ping して 5 秒で見切り、確かめようのない接続（保活未対応のリレー・ハンドシェイク中）は close 4003 で張り直す。再接続待ちならタイマーを捨てて即接続。回数は 0 に戻す
- 復帰の ping を撃った直後に保活の定期チェックが来ても、健全な接続を閉じない（ping を撃った時刻を持ち、定期チェックは間隔の半分より古い ping だけを見切る）。復帰のプローブの見切りは、保活未対応のリレーだと学習し直すための連続タイムアウトに数えない
- 再接続の間隔は Orca `mobile-relay-retry-delays.ts` と同じ完全ジッタ（`common/paradisRelayReconnectDelay.ts`。n 回目は [0, min(30秒, 500ms×2^(n-1))) の一様乱数、下限 250ms）。認証切れの 5 分間隔にも ±25% の揺らぎ。回数は `onopen` ではなく接続が 30 秒続いてから 0 に戻す（切断レポートと認証プローブは回数の差分で見るので影響しない）
- モバイルアプリ側の同じ変更（W2-05/06 のモバイル分）は別担当

### 旧鍵フレームの 7S を Sentry へ送らない、通知の置き換え ID（2026-09-28 追加）

- 7S `mobile-e2e.frame-open-failed`: モバイルの張り替え中・直後に旧鍵で封緘したフレームが届いて開けないのは想定内（再ハンドシェイクの要求で自己回復する）。`MobileSession` は新しいセッションで1つも復号できていない間の暗号層の失敗を送らず、確立ごとに1回だけ info、以降は trace にする。復号できた後に続けて開けないもの、アプリ層の例外、確立から一度も復号できないまま 30 件に届いたもの（張り替えが回っていない）は今までどおり送る
- W2-08 の PC 側: `push-notify` に `collapseId`（エージェントのトークン。許可待ち・質問の `agent-question` には付けない。未回答の許可が後の通知に置き換わって隠れないように）と `threadId`（スペースの `ws`。無ければこの PC）を載せる。値は通知鍵から用途別に作った鍵の HMAC-SHA256 の hex 先頭 32 桁（`node/paradisMobilePushIds.ts`）。リレーと APNs からは元の値を推測できず、ペアリングごとに違う。NSE の ID（SHA-256(PC id + トークン)）と一致させる必要は無い。型と `PARADIS_PUSH_ID_PATTERN` は `app/protocol/src/relay.ts`（リレー担当のレーン）から逐語で写した。統合のときに重複を片付ける

### 落ちたエージェントが残した入力モードを戻す（W2-09）

`mobileRelay/common/paradisTerminalArmedInputModes.ts`。モバイルリレーの contribution（`paradisAgentTerminalRecovery.ts` の onCommandExecuted / onCommandFinished）から、エージェントのコマンドのあるターミナルにだけ掛ける。

- xterm の公開 API では Kitty のフラグを読めない（`Terminal.modes` にあるのはマウス・フォーカス・キーパッドなど）。そのためパーサーに見るだけのフック（`registerCsiHandler` で false を返す）を掛け、133;C の後に有効になった `?9/1000/1002/1003/1004/1005/1006/1015/1016/66` と `CSI > u` の積み数を覚える
- 133;D で残りがあれば 300ms 待ち、`write('', cb)` で受信済みの出力を読み終えてから、その間にシェルが入れ直したモード（fish のフォーカス報告や Kitty の push など）を除いて `CSI ? … l` と `CSI < n u` を xterm へ書く（PTY には送らない）。Orca は出力の流れを止めて 133;D の位置へ差し込むが、ここでは流れに手を入れない代わりに後ろへ書く
- Ctrl+Z などで止めただけ（終了コード 145〜150 = 128 + SIGTSTP / SIGSTOP / SIGTTIN / SIGTTOU。macOS と Linux の番号の両方）は戻さない（`fg` で戻ったエージェントがまだ使う）
- bracketed paste（`?2004`）と application cursor keys（`?1`）はシェルがプロンプトで入れ直すので戻さない（Orca と同じ）。代替画面（`?1049`）は後ろへ書くとシェルが代替画面に描いたプロンプトごと消えるので戻さない
- 既知の限界: 窓の再読み込みで開始（133;C）の後から見張り始めたコマンドは、それ以前に有効になったモードを知らない。pty ホスト側の headless xterm（常駐・復元用）とモバイルの端末には書いていないので、復元した画面やモバイルの表示ではモードが残りうる（【要確認】）。`CSI = flags ; mode u`（Kitty の上書き）と xterm の modifyOtherKeys（`CSI > 4 ; n m`）は追っていない（Claude Code 2.1.283 は `CSI > 1 u` / `CSI > 5 u` / `CSI < u`、codex-cli 0.155.1 は push と `CSI < 1 u` を使う）

### 起動直後の信頼の確認と準備完了を画面から読む（W2-10）

`agentIde/common/paradisAgentStartupScreen.ts` の固定の表（`PARADIS_AGENT_STARTUP_SCREEN_RULES`）。文言はインストール済みの Claude Code 2.1.283 と codex-cli 0.155.1 のバイナリの文字列から拾った（読み取りのみ）。画面の末尾 30 行を見る。信頼の確認は、見出しの文言（空白と罫線を落として照合）に加えて、選択肢の2行が隣り合い（順番と番号の有無は問わない）どちらかの行頭に選択のカーソル（`❯` / `›` / `>`）があるときだけ当てる。Claude Code 2.1.283 の確認は選択肢に番号が無く、断る側が先でそこにカーソルがある。さらに、hook の状態をまだ一度も受け取っていないペイン（shared process は `hasAgentHookHistory`、ウィンドウは `isAgentInstance`）か、エージェントのツールで起動してから 90 秒以内のペインでだけ判定する（動いているエージェントが画面に同じ文言を出しても止めない）。テストの画面は、ソースを表示した画面で当たらないよう選択肢の文言を単語から組み立てる

- 信頼の確認: 前面がエージェントで hook が作業中でなければ、状態を `waiting_for_permission` にする（ウィンドウ側の `_status` と shared process の `_statusOf` の両方）。`send_terminal_input`（Enter 無しの貼り付けも）・`send_terminal_key` は専用の文言で断る（数字は選択肢を選び、Esc は終了を選ぶため）。待機は `needs_input` + `blocked_by: "trust_dialog"` で返す
- 準備完了: `launch_agent` / `create_space` でプロンプト無しで起動したペインだけ（`_launchedIdle`）、「? for shortcuts」「Ask Codex to do anything」が出たら `reason: "ready"` を返す。プロンプト付きの起動は、準備完了の後に作業を始めるので今までどおり待つ
- Claude Code 2.1.283 は権限モードが既定以外（auto mode など）だと、入力欄の下が「? for shortcuts」ではなく `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` のようなモードの表示になる（実機確認の NG）。モードの名前（`accept edits on` / `plan mode on` / `auto mode on`。以前の版の `bypass permissions on`）の表示と、中身の無い入力欄（横罫線のすぐ下の `❯` だけの行。入力例の案内 `Try "…"` は可）がそろったときも準備完了とする。モードの表示は作業中にも出るので、入力欄の条件は外さない。どの準備完了の規則も、信頼の確認の見出しが画面にある間は当てない
- 準備完了を返すときの案内: hook がまだ届いていないペインには `press_enter=true` を促さない（Enter は hook が一度でも届いたペインにしか送らない規則のままで、画面が準備完了に見えることを理由に外さない。hook の届かない相手では許可ダイアログかどうかを確かめられないため）。代わりに Enter 無しで入れて利用者に送ってもらうか、`launch_agent` の `prompt` で起動し直すよう案内する
- CLI を更新して文言が変わったら表を足し直す（外れても hook の状態の判断が残るだけで、送ってしまう方向には倒れない）

### 利用者の設定を書き換える前の控え（W2-11）

書き換える前に、今の中身を隣の `<名前>.paradis.bak` へ1つだけ写す（Orca `rolling-file-backup.ts` と同じく一時ファイルから rename、控えの場所が symlink なら拒否、権限は copy で引き継ぐ）。SSH の接続先の設定が symlink なら `IFileService.realpath` で実体を写す（`copy` はリンクをリンクのまま写すため）。控えは保険なので、写せなくても書き換えは止めない。

| 書き手 | 対象 |
|---|---|
| `agentBrowser/node/paradisAgentHooksSetup.ts`（同期） | `~/.claude/settings.json`・`~/.codex/hooks.json`（設置と取り外し） |
| `agentBrowser/node/paradisMcpSetup.ts` | `~/.claude.json`・`~/.codex/config.toml` |
| `limitsMonitor/node/paradisClaudeLiveAuth.ts` | `~/.claude.json`（アカウント切替の `oauthAccount`） |
| `agentHookTrust/node/paradisCodexHookTrust.ts` | `config.toml`（Codex に `config/batchWrite` させる前。取り消しの書き込みでは取り直さない） |
| `agentBrowser/electron-browser/paradisRemoteAgentHooks.contribution.ts`・`paradisRemoteMcpSetup.ts` | SSH の接続先の同じファイル（`IFileService.copy`） |
| `codexTerminalTitle/electron-browser/paradisCodexTerminalTitle.contribution.ts` | 各 Codex ホームの `config.toml` |

ログイン情報（`.credentials.json`・Codex の `auth.json`）は、秘密をもう1か所に置くことになるので控えを作らない。ただし `~/.claude.json` と `config.toml` の MCP の設定には、利用者が書いた API キーやトークン（`env`・`headers`）が入っていることがあり、その控えにも同じものが入る（控えは元と同じ権限）。ヘルパーは `src/vs/paradis/node/paradisRollingFileBackup.ts`（Node）と `src/vs/paradis/common/paradisRollingFileBackupUri.ts`（`IFileService`）。

## Orca 取り込み第二弾の PC 側 L1（W2-26 / W2-32 / W2-33 / W2-20、2026-09-29）

新しい PARA-PATCH は無い。触ったのは fork 所有のファイルだけ（W2-33 は上の Sentry の節）。

### 終了処理の計測（W2-26）

fork の後始末を `sentry/common/paradisTeardownTiming.ts` で名前付きで測る。期限は足さず、各ステップが元から持っていた上限だけを使い、打ち切られたかも記録する。1 秒以上・失敗・打ち切りは warn ログ（`[paradisTeardown] <名前>: ...`）と Sentry（`quit-teardown` / `slow:<名前>`、warning）へ出す。ユーザーの返事を待つもの（常駐へ残すかのダイアログ、`terminal-shutdown.prepare.*`）はログだけにする。名前は `health-beacon.shutdown-snapshot`・`workspace-switch.finish-switch`・`pty-daemon.save-terminal-screens`・`pty-daemon.status`・`pty-daemon.ask-keep`・`terminal-shutdown.prepare.<役>`・`terminal-shutdown.keep-detaches`。main の beacon は ILogService を持たないので標準エラーへ書き、遅かったときだけ報告を送るためにもう一度 0.5 秒 flush する。全体に期限を付けるかは、この計測で原因が分かってから決める（Q119）。

### ターミナルを閉じたら裏のプロセスを止める（W2-32）

- 差し込み口は `ptyDaemon/node/paradisTerminalProcessFactory.ts` の `TerminalProcess` の代わりの `ParadisCleaningTerminalProcess`（`shutdown` の上書き）と、薄い常駐の `ParadisPtyDaemonHost.kill`。スペースの退避・別ウィンドウへの移動・切り離しは `shutdown` を通らない
- **アプリの中の pty ホストではシェルへの終了を遅らせない**（レビュー H2）。`ps` を起こしてから、待たずに本来の終了を呼ぶ（`ParadisShutdownOrder.CaptureAlongside`）。遅らせている間にアプリごと落ちると、閉じたはずのシェルが残るため。通常の閉じ方は出力を流し切る 0.25 秒の後に終わらせるので表は間に合う。すぐ終わらせる閉じ方では間に合わないことがあり、Linux ではシェルのセッション（sid）の一員として拾い直す。macOS は親子関係しか無いので取りこぼしうる
- 薄い常駐では、アプリ側（`ParadisDaemonTerminalProcess.shutdown`）は終了の依頼を今までどおりすぐ送り、`kill` の第 3 引数 `stopDescendants` で後始末を頼む。常駐（`paradisPtyHostDaemonMain.ts`）が表を撮ってからシェルを終わらせ（`CaptureFirst`、常駐はアプリより長く生きる）、残りを止める。`release` はそれが終わるまで待つ。古い常駐は第 3 引数を無視する（シェルだけを終わらせる）
- 設定（`paradis.terminal.stopBackgroundProcessesOnClose`、既定オン）は pty ホストから読めないので、ウィンドウがターミナルを作るときに env の印 `PARA_CODE_TERMINAL_KEEP_BACKGROUND_ON_CLOSE=1`（オフのときだけ）を入れ、pty ホストが読んでからシェルへ渡す前に外す。常駐（薄い方）では印を台帳の env に残し、引き取るときに読み戻す。印を入れるのは `paradisPrepareTerminalPaneEnv`（既存の PARA-PATCH の呼び出し先）の中
- 止め方: シェルの終了から 2 秒後に撮り直し、pid・プロセスグループ・開始時刻（`lstart`、1 秒単位）が撮ったときと同じものだけに SIGTERM、さらに 8 秒後にまだ同じものへ SIGKILL。撮った秒以降に生まれたものは最初から外す。SIGHUP を無視しているもの（`nohup`）とその下の木は残す。無視しているかが読めないものも残す
- **シェルと別の端末を持つものを含む部分木には触らない**（レビュー H1）。GNU screen の SCREEN はシェルの子孫のまま残り、SIGHUP も無視しない（実測）。`ps` の `tty` を読み、シェルと別の端末を持つもの（screen の中のシェル）から、シェルの端末を持つ祖先の手前まで（SCREEN）を根として、その下の木ごと外す。シェルの端末を持つ祖先（screen を起動したエージェント）とその他の子は外さない。端末を持たないもの（`detached` で起動した裏タスク）は止める。保険として screen / dtach / abduco / tmux の名前の部分木も外す。dtach が screen と同じ形かは推測（実測は screen だけ）
- 止まるもの: `disown`・zsh の `&!`・`setopt NO_HUP` で残したもの（SIGHUP を無視していない）
- 働くのはタブやウィンドウでターミナルを閉じたとき（`shutdown` が呼ばれる）だけ。Para Code の終了（アプリの中の pty ホストごと落ちる）と、シェルで `exit` したとき（`shutdown` を通らない）は働かない
- `ps` は `/bin/ps` を使う。macOS の調べ役（`osascript`）は、0.1 秒以内に来た問い合わせを 1 回にまとめる。印を書くときは shell launch の env を写してから書く（プロファイルなどと共有している物を書き換えない）
- SIGHUP を無視しているかの読み方: Linux は `/proc/<pid>/status` の `SigIgn`。**macOS の `ps` には無視しているシグナルの列が無い**（`ignored` / `sigignore` とも `keyword not found`）ので、`osascript -l JavaScript` から `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID)` を呼び、`struct kinfo_proc`（648 バイト）の `kp_proc.p_sigignore`（オフセット 232）を読む。`p_pid`（40）が一致したときだけ採り、`kp_eproc.e_pgid`（564）も表と照合する。オフセットは SDK の `sys/sysctl.h` から `offsetof` で求めた（arm64 で実行して確認、x86_64 も同じ LP64 の並び）
- **Node は起動時にシグナルの扱いを既定へ戻す**ので、`nohup node server.js` の node は SIGHUP を無視していない（2026-09-29 実測: `nohup node` は `kill -HUP` で終わる）。今でもシェルが閉じるときの SIGHUP で終わるので、止めても振る舞いは変わらない
- Windows は対象外。アプリの終了で pty ホストごと落ちるときは、止める処理（2 秒後）まで届かない

### Para Code が止まっている間の hook の控え（W2-20）

- notify.sh / notify.ps1 はスキーマ v5（v4 は最初の控えでファイルが無いとき `wc -c <"$SPOOL_FILE" 2>/dev/null` が標準エラーへ `No such file or directory` を出していた。sh はリダイレクトを左から処理するので、`{ wc -c <file; } 2>/dev/null` と括る）。手元の版だけが、受け口に届かなかった hook（ポートファイル無し・接続できない）と、受け口が 503（ペインがまだ同期されていない）と答えた hook を `<userData>/agent-hook-spool/pane-<ペイントークンの SHA-256>.jsonl` に 1 行 `{"v":1,"id","event","t":<秒>,"payload"}` で書く。404（知らない・終わったペイン）は控えない。受け口は、起動とウィンドウの接続から 60 秒の間だけ、知らないトークンに 503 と答える（レビュー M3）
- payload に残すのは `hook_event_name`・`session_id`・`transcript_path`・`cwd`・`tool_name` と、Notification が許可要求かどうか（`"message":"permission"`）だけ。依頼の文面やツールの入力は書かない（レビュー M4）。sh は `grep -oE` で JSON の文字列値を（エスケープごと）抜き出し、1 行を変数で組み立てて 1 回で追記する（一時ファイルを使わない）
- フォルダ 0700・ファイル 0600、1 ファイル 5MB・1024 ファイルまで。Pre/PostToolUse・PostToolUseFailure・MessageDisplay は書かない。SSH の接続先の版は控えない（流し直す口が無い）
- hook ごとに ID（`hid`）を振る。受け口は最近の ID を覚え、流し直しで同じ ID を捨てる。shared process は `agent-hook-spool/alive` に生きている時刻を 15 秒ごとに書き、次の起動はそれより後で、しかも 1 時間以内の控えだけを流す（受け口の返事が遅れて控えてしまった重複を除くため、レビュー M5）。閉じるときにも書こうとするが、**shared process の終了では dispose が呼ばれず書かれない**（実機で 3 回とも直前の刻みのままだった、2026-09-29）。終了の経路に依頼を足すより単純で安全なので、刻みを 1 分から 15 秒に縮めて境目のずれを抑えた
- 読むのは shared process（`agentBrowser/node/paradisAgentHookSpoolStore.ts`）。起動時に 7 日より古いものを消し、ウィンドウがペインを同期した（`syncBindingAuthority`）後に、そのペインの控えを 1 度だけ名前を変えてから読んで消す。この起動で本物の hook が届いたペイン・既に状態があるペインは状態を触らない。所有者の判定は pid 無しの hook と同じ（transcript だけで見る fail-closed）
- 状態は最後の 1 件で決める。作業中（working）は流し直さない。完了は `quiet` 付きの review（`IParadisAgentPaneStatus.quiet`）にして、デスクトップの通知（`paradisAgentStatusNotificationTracker.ts`）とモバイルのプッシュ（`paradisMobileWorkspaceProvider.ts` の `detectAndNotify`、`paradisQuietReplayedPanes.ts` を見る）が鳴らさない。許可要求と質問は 10 分以内の最後の 1 件だけを `replayedPrompts` としてスナップショットに載せ、ウィンドウ（`paradisAgentHookReplay.contribution.ts`）が画面の下端にその種類の確認が出ていると確かめて `confirmReplayedPrompt` を呼んだときに初めて状態を付け、hook のバスへ流す（承認カードと通知はライブと同じ経路）
- 【要確認】別のスペースへ退避したターミナルは xterm の画面が読めないことがあり、その間は確かめられずに 10 分で捨てる（推測）
- 【要確認】常駐を使っていて閉じるときに「終了する」を選んだ後の再起動で、エディタ領域のタブが空の新しいシェルとして戻る（W2-20 とは関係の無い既存の挙動と推測）
- 【要確認】`pty-daemon.save-terminal-screens` は「終了する」の返事より前に画面を保存するので、常駐が先に終わっていると次の起動でその保存物から戻りうる（この順序は W2-26 の前からのもの）
- 【要確認】流し直しは MCP の待ち受けを始める約 1.5 秒前に済むことがあり、その間に控えられた hook は控えに残ったまま、その起動では流されない可能性がある（未検証）

## Orca 取り込み第二弾の L3 エージェントの会話（W2-21 / W2-30 / W2-29、2026-09-29）

新しい PARA-PATCH は無い。capability は `agent.approval.options.v1`・`agent.history.page.v1`・`agent.resume.v1`（PC とアプリの両方の一覧に足し、ゴールデンの state / state-request / agent も直した）。どれも足しただけで、版は 3 のまま。

### 承認の番号付きの選択肢（W2-21、Q117 案 A）

- 選択肢は PC の画面から読む（`mobileRelay/common/paradisAgentApprovalOptions.ts`）。画面の下端 30 行で、1 から連番で並ぶいちばん下の並びを採り、深く字下げされた続きの行は折り返しとしてつなぐ。10 個以上・連番が切れる・2 つ未満は「読めない」。Codex は全部の行に行末の近道（`(y)` / `(p)` / `(esc)`）が無ければ出さない（数字で確定するかを確かめていないため）
- 流れ: アプリが agent の `approval-options` を求める → shared process（agentChat）が今の承認かを確かめて所有ウィンドウへ `action/approvalOptions` を回す → ウィンドウが許可の画面（`paradisScreenShowsPermissionPrompt`）を最大 3 秒待って読み、agent チャネルでアプリへ直接返す。登録表（scm / fs）は agent チャネルを通らないので、agentChat と provider に種類を 1 つずつ足した
- 選択肢は、端末の自動折り返しでつながった行を 1 行にまとめた画面（`paradisVisibleTerminalLogicalText`、`isWrapped`）で読む（長い選択肢の続きが 0 桁目から始まると、後ろの選択肢が読めず拒否ボタンが出なかった。シミュレータ確認）。字下げの浅い行も、空行より前に次の番号の選択肢が続くなら続きとみなす。アプリは拒否（`no` = Esc）を常に出し、番号の回答が断られたら選択肢を取り直す
- 選択肢は許可の確認の見出し（`paradisPermissionPromptParts`、`agentChat/browser/paradisAgentTuiInput.ts`）より後の行からだけ読む。返事には見出しとその上のコマンドの行（枠の上端の横線か空行 2 つまで、最大 8 行）の指紋 `promptHash`（空白を除いた SHA-1）を付け、アプリは回答で返す
- 回答は `choice: 'opt:<n>'` と、押したときの文言 `optionLabel`（無ければ `invalid-answer`）と `promptHash`。ウィンドウは**送る直前**（最後の `beforeEachKey`）に画面を読み直し、許可の確認が出ていて、見出しまでの指紋が同じで、その番号が同じ文言（空白と大文字小文字は見ない）のときだけ、Claude は数字 1 文字（Enter 無し）、Codex は行末の近道を送る。違えば `options-changed` で断る。番号の回答は 1 打鍵でなければ断る
- アプリは行末が `(esc)` の選択肢（「No, and tell Claude what to do differently」）を今までの `no`（Esc）で送る（数字で選んだときの動きを確かめていないので、実機で確かめた経路に寄せた）。読めないとき・古い PC・Codex の app-server 経由の承認は今までどおり
- hook の `permission_suggestions` は、承認の interaction の `suggestions`（例 `Bash(npm test:*)`）としてカードの補足に出すだけ。【要確認】Claude Code の hook 入力の実物でこの形（`addRules` / `setMode` / `addDirectories`）を確かめていない
- 【要確認】Claude Code の許可の画面の選択肢の並び（折り返しの字下げ、下の操作説明との間の空行）は 2.1 系の表示からの推測で、実機の画面では確かめていない。外れると選択肢が出ない（「許可 / 拒否」のまま）方へ倒れる

### 会話をさかのぼって読む（W2-30、Q122 案 A）

- agent の `history { beforeRev, cursor?, limit? }`。`cursor` が無ければ PC のメモリのリング（400 件）から `beforeRev` より前を返し、読み切ったら記録ファイルの位置を `cursor`（`f:<バイト位置>:<keep>`）で添える。`cursor` があれば記録ファイルを後ろから読む（`node/paradisAgentChatHistory.ts`、1 回 2MB・1 ペインで同時に 1 本・4MB を超える行は飛ばす）
- tailer はリングの発言ごとに、元の行の頭のバイト位置と、その行を解釈して出た発言の中での順番（パーサーの単位。読み取りが同じ行を解釈し直して先頭から `keep` 件を採るのと揃える）を持つ（モバイルへは送らない）。開いたときに末尾 4MB だけ読んだ記録（8MB 超）でも、最初まで読める
- アプリは差分で 500 件まで持ち、PC のリングは 400 件なので、アプリのいちばん古い発言はリングから押し出されていることがある。押し出した発言の位置を 2000 件まで残し、`beforeRev` がリングに無ければそこからすぐに記録ファイルを読む（保持件数を揃える案は、PC 側の新しい発言が届く前の一瞬で必ずずれるので採らなかった）。アプリは 500 件で切ったら `truncated` を立てる。さかのぼって古い発言を持っているときは、切った発言を古い発言の末尾へ繰り入れる（`absorbTrimmedIntoHistory`。2500 件まで、超えたら古い方を捨てて「PC で見てください」）。繰り入れないと古い発言と新しい発言の間が空いて全部捨てることになり、表示位置も飛んだ（シミュレータ確認の NG-1）。並びは変わらないので一覧の行と位置は保たれる
- ファイルから読んだ発言の rev は負の数（-1 から古い方へ）。1 ペインで 2000 件まで（`capped`）。全文・画像の取り寄せは rev で引く仕組みなので、古い発言には付けない（切り詰めた本文は「…」のまま）
- アプリは古い発言を会話の状態とは別に持つ（`src/agentHistory.ts`、epoch が変わったら捨てる。PC のメモリから読んだ分と新しい発言の間が空いたら捨てる）。一覧は上端 60pt で読み込み、`maintainVisibleContentPosition`（先頭の案内の行があるので 1 から）で位置を保つ
- 【要確認】`maintainVisibleContentPosition` で先頭に足したときに位置が保たれるかを、iPhone / iPad の実機で確かめていない

### 終わった会話を開き直す（W2-29、Q121 案 A）

- PC は登録表で scm の `agentSessions` / `agentSessionPreview` / `agentSessionResume` を受ける（`electron-browser/paradisMobileAgentSessions.ts`、登録は `paradisMobileRequestHandlerRegistrations.ts`）。一覧はセッション履歴（`ParadisSessionResumeClient`）そのままで、30 件ずつ。今ターミナルで動いている会話（状態のスナップショットの `paneSessions`）には `terminalKey` を付ける（二重に再開しない）
- スマホへ渡すのは会話の指紋 `key`（SHA-1、`common/paradisMobileAgentResume.ts`）だけで、セッション ID・パス・`catalogId` は渡さない。開いている会話の agent の `info.resumeKey` にも同じ指紋を載せる（ターミナルが閉じた後の「再開して送る」の宛先）
- 再開は `paradisResumeAgentInWorkspace` に `preserveFocus: true`（足した任意項目。裏のタブで開き、今のスペースでもフォーカスを移さない）と `dangerouslyBypassPermissions: false` を渡す。画面が準備完了（`paradisAgentStartupScreenState`、最大 60 秒）になったら依頼を貼り付けて Enter。信頼の確認が出ていれば渡さずに `needs-trust`。PC に「スマホから再開しました」の通知（「表示」でそのスペースへ移る）
- 同じ会話・同じ依頼の再開が重ならないよう、指紋と `requestId` を最初の await より前にメモリの「再開中」に入れ、台帳（ウィンドウの `IStorageService`（APPLICATION）、最近 500 件・3 日）の `started` も同期で書く。同じ ID の送り直しは `duplicate`（ターミナルを開く前に失敗したものだけはやり直せる）。再開した直後の指紋 → ターミナルを 5 分覚え、hook が届く前でも「開いている」とみなす
- 「PC で開いている会話」は、hook が報告した会話（`paneSessions`）、各ターミナルのシェル統合の実行中のコマンド（`claude --resume <id>` / `codex resume <id>`、`paradisResumedSessionOfCommand`）、再開した直後の記録の 3 つで見る。【要確認】タブの復元の案内（前回の会話を「このタブで再開」）の情報とは照らし合わせていない。シェル統合が無いターミナルで、hook も届いていない会話は見分けられない
- 再開した会話へ依頼を渡すのは W2-28 の差分メモの送信と同じ規則: 改行以外の制御文字を落とし、シェル統合で前面が Claude Code / Codex と確かめられ、複数行なら貼り付けの囲みが有効で、確認や質問の画面が出ていないときだけ。PC の通知は準備を待った後に出す
- アプリの預かり（`src/agentSendQueue.ts`）は PC ごとのファイル `agent-send-outbox.v1.<pcId>`（`platform.ts`。中身はターミナル操作のアウトボックスと同じ鍵で封をする）。24 時間で期限切れ（本文を消し、印も 1 日後に消す）。つながったら、開いているエージェントのターミナル宛てで、預けてから 15 分以内で、そのターミナルの会話の指紋（`info.resumeKey`）が預けたときと同じものだけを送る。それ以外は「このターミナルへ送る」か「再開して送る」を押すまで送らない
- 開いているターミナル宛ての判断は、受け取り直しを頼んだ後に PC から届いた会話の状態（`AgentChatState.syncedAt`、snapshot / delta / none で更新）でしか行わない（`agentSendLiveDecision`）。つながり直す前の状態で比べると、切れている間に PC で `/clear` されたときに古い指紋で送って `stale-session` で断られた（シミュレータ確認の NG-2）。既に開いている会話は 2 秒待っても届かなければ取り直しを頼む
- 預かりから送るときは `action/sendMessage` に預かりの id（`sendId`）を付け、PC（agentChat）は同じ id をウィンドウへ一度しか渡さない（最近 500 件・24 時間、メモリだけ。ウィンドウが受け取らなかったものは忘れる）。送っている途中でアプリが落ちたものは、ターミナル宛ては同じ id で送り直し、再開は確かめ直しに戻す。【要確認】PC も同時に再起動していると、この重複の記録は残っていない預かりの宛先のスペースは PC の `sourceId` で持ち、送るときにアプリの画面の id を引き直す（PC を再起動すると画面の id は変わる）
- 【要確認】別のスペースへ退避した（park された）ターミナルでも xterm の画面を読めるかを確かめていない。読めないと準備完了を待ちきれず、依頼は渡さずに「会話の画面から送ってください」と返し、アプリは依頼を開いた会話の入力欄へ移す
- 【要確認】Codex の `codex resume <id>` が再開の後に「? for shortcuts」相当の準備完了の表示を出すかを、0.155 系の実機で確かめていない

## モバイルリレー: Cloudflare Workers/DOデプロイ（2026-07-05）

「Para Code Mobile」（iPhone遠隔操作機能、`src/vs/paradis/contrib/mobileRelay/`）がPCとモバイルの間を中継するリレーサーバー（`app/relay/`、Cloudflare Workers + Durable Objects）を、開発時のプレースホルダーURLのまま放置していたのを本番デプロイした。設計・実装の詳細は設計書（`app/design/mobile-design.md`）参照。ここには配置場所と再開に必要な情報のみ記す。

- **デプロイ先**: 上記の更新配信基盤と同じCloudflareアカウント。ユーザーが明示的に指定して選定
- **デプロイ済みURL**: `wss://para-mobile-relay.cloudflare8234.workers.dev`（`app/relay/`の既定`workers.dev`サブドメイン。カスタムドメインは未設定）。PC側の既定値`PARADIS_MOBILE_DEFAULT_RELAY_URL`（`src/vs/paradis/contrib/mobileRelay/common/paradisMobileRelay.ts`）をこの実URLに更新済み。**それ以前は`wss://para-mobile-relay.paradis.workers.dev`という、実際には一度もデプロイされたことのないプレースホルダーURLのままだった**（セルフホスト設定`paradis.mobile.relayUrl`で上書きしない限り、初回起動時のペアリングが到達不能で必ず失敗する状態だった）
- **account_id固定**: `app/relay/wrangler.jsonc`に`"account_id": "979dbe0328e903a34bb6291b06cca0da"`を追記（PARA-CODEコメント付き）。複数Cloudflareアカウントを持つユーザーの環境では、これが無いと`wrangler deploy`が「More than one account available」で失敗する
- デプロイVersion IDはCloudflare側で確認し、公開文書へ固定値を記録しない
- デプロイ確認: `curl -X POST https://para-mobile-relay.cloudflare8234.workers.dev/device/new/provision`が200 `{"ok":true,"deviceId":"..."}`を返すことを確認済み
- DeviceDO（SQLite-backed、`app/relay/wrangler.jsonc`の`migrations`で`new_sqlite_classes`指定）は初回デプロイ時に自動でマイグレーションされる。以降の再デプロイでスキーマ変更が必要な場合は`migrations`に新しい`tag`エントリを追加すること

### リレーとモバイルの接続・通知の取り込み（Orca W2、2026-09-28）

デプロイは**リレー → PC → アプリ**の順。どの組み合わせでも従来より悪くならないように、取り決めは足すだけにしてある。

| 組み合わせ | 取り消された端末 | APNs の再送・トークン破棄 | 通知の置き換え・まとめ |
|---|---|---|---|
| 旧アプリ × 新リレー | リレーは 4404 / 4401 で閉じる。旧アプリは未知の close として従来どおり再接続を続ける（HTTP 401 のときと同じ。Sentry の分類が `socket-error` から `unexpected-close-4401/4404` に変わるだけ） | 効く（リレーだけの変更） | 効かない（通知拡張の更新が要る） |
| 新アプリ × 旧リレー | 旧リレーは HTTP 401 のまま＝1006 にしか見えないので、「再ペアリングが必要」は出ず従来の再接続（間隔はジッタ付きになる） | 効かない | 効く（端末の中だけで決める） |
| 新アプリ × 新リレー | 「再ペアリングが必要」を出し、1〜15分おきの確認に落とす | 効く | 効く |

- **リレー**: 資格を認めないモバイルは受理してから close（4404 = 登録が無い、4401 = トークン不一致。`PARADIS_RELAY_CLOSE_CODE`）。PC とペアリング用のソケットは HTTP 401 のまま（PC は `pc/check` で判別している）。APNs は 429 / 5xx / `ExpiredProviderToken` を SQL の待ち行列（`push_queue`、DO あたり50行）と alarm で最大3回送り直す。応答の無い通信失敗は APNs が受理済みかもしれないので、送り直しは必ず同じ `apns-collapse-id` で行う（先の1通も届いていた場合、通知センターでは1件に置き換わる。届くたびにバナーと音は出うる）。PC が `collapseId` を付けない通知（許可・質問）には、リレーが通知ごとの乱数（16バイト）を付けて待ち行列の行に保存する（通知どうしの紐付けにはならず、別の通知を置き換えもしない）（1秒→2秒→4秒を半分揺らす、Retry-After はそれより早くしない・上限10分、`apns-expiration` は最初の送信から延ばさない）。400 `BadDeviceToken` / `DeviceTokenNotForTopic` と 410 でトークンを消す（送った後に登録し直されたトークンは消さない）。alarm はペアリングの掃除と共用で、早い方に張る
- **push-notify の `collapseId` / `threadId`**: 任意項目。リレーは `PARADIS_PUSH_ID_PATTERN` に合うときだけ `apns-collapse-id` / `aps.thread-id` に載せる。PC は完了通知にだけ `collapseId`（通知鍵の HMAC）を付け、許可・質問には付けない方針（送る場所の `paradisMobileRelayService.ts` は別の担当）。エージェントトークンは PC の MCP 接続に使う値なので、そのままでも素のハッシュでも外へ出さない。`threadId` は `aps.thread-id` として平文で出るので、同じスペースの通知どうしの紐付けはリレーと Apple に見える
- **置き換えとまとめ（W2-08）は端末の中で決める**: 通知拡張とアプリが同じ規則で鍵を作る（`para.notify.collapse\n<pcId>\na:<agentToken>`（トークンが無ければ `t:<terminalKey>`）の SHA-256 の16進先頭32桁。値は `notificationTray.test.ts` で固定、Swift の CryptoKit で同じ値になることを確認済み）。通知拡張は同じ鍵の前の通知を消してから出し、`threadIdentifier` は PC × スペース。**許可・質問（`agent-question`）には鍵を付けない**（前の通知を消さず、あとの通知に消されもしない。未回答の許可を隠さないため）。通知拡張は `contentHandler` を鍵付きの印で一度だけ呼び、期限切れで出すときも復号した識別子を書き終えていなければ生ペイロードの識別子を剥がす。アプリのローカル通知は expo が `threadIdentifier` を渡せないので、まとまるのはプッシュだけ
- **通知センターの後始末（W2-02）**: PC からの `dismissed` / `dismissed-token` を受けたら通知センターからも消す。前面復帰・再接続のあとは、頼んだ後に届いた State で PC が確認済みにした**完了通知だけ**を消す（エージェントトークンで一致したものだけ、頼んだ時刻の5秒前までに届いたものだけ）。許可・質問の通知は状態からは消さない（hook が来ないと状態が `working` のまま残り、未回答でも消してしまう）。iOS のリモート通知は `content.data` が空で、userInfo は `trigger.payload` にある（expo の `serializedNotificationData` は userInfo["body"] しか `content.data` に入れない）。**通知タップの遷移も同じ理由で、プッシュからは一度も効いていなかった**（2026-09-28 に `readNotificationDeepLink` で両方を読むよう修正）。通知拡張は復号できなかったときも、生ペイロードに載った識別子を捨てる（リレーが差し込めるため）
- **回線の変化（W2-05）**: `expo-network` の `onNetworkStateChanged` で、オフライン → オンラインと Wi-Fi ⇄ セルラーのとき（750ms の間の変化は1回にまとめる）に、手動で切断していなければ繋いでいる全PCの `ensureConnected()` を呼ぶ（前面かどうかは見ない。音声通知でバックグラウンドでもソケットを開けているときにも効かせる。畳んだ接続は suspend 中なので何もしない）（切れていれば即張り直してバックオフを打ち切る、繋がっていれば死んだソケットかを5秒で確かめる）。資格を拒まれているPCは決めた時刻まで待つ。25秒おきの心拍からの張り直しは再試行の回数を戻さない
- **ライブ入力の見えない入力欄は1行ぶんだけ**: Enter で送ったら新しい世代の入力欄を `autoFocus` で足し、フォーカスが移ったら古い方を外す（入力欄から入力欄へフォーカスを渡すのでキーボードは閉じない）。`clear()` は RN 0.86 の iOS で捨てられることがあり、前の行を入力欄に残す方式はキャレットが前の行へ動くと過去の行（パスワードを含む）を送り直しうるので、どちらもやめた。送り終えた入力欄は引退させ（前の行を持ったままなので）、フォーカスが移る前・移れなかったときに届いた打鍵は捨てて今の入力欄へフォーカスし直す。キャレットは変換中を除き常に末尾へ戻し、iPad の外付けキーボードの矢印（修飾なし）はライブ入力にフォーカスがあり変換中でない間だけ `sendArrowKey` で PC へ送る。ライブ入力中の ⌘↩ は見えない入力欄の Return と同じに扱う
- **「再ペアリングが必要」の表示**: 判定と文言は `app/mobile/src/pcStatus.ts`（`isPairingRejected` / `PAIRING_REJECTED_LABEL` / `PAIRING_REJECTED_HINT`）に一本化。表示する場所はホームの PC カードと ⋮ メニュー（「ペアリングし直す」）・PC の画面（iPad の左列を含む `PcOfflineState`。ヘッダーの「再接続」は出さず、再確認の間も点は赤）・セッションの見出し・設定の PC 一覧（最終接続時刻は付けない）。`ConnectionGate` / ドロワー（`PcSwitcher` を含む）/ 島の下の行（`useOfflineNotice`）は 2026-09-28 時点でどの画面からも使われていないが、同じ定数で扱うようにして残した
- **クリップボード**: ExpoClipboard のネイティブ関数は options の引数を省けない（`getStringAsync(options)` / `setStringAsync(text, options)`）。JS の expo-clipboard は既定値を埋めるが、ネイティブ部品を optional に直接引く `app/mobile/src/nativeClipboard.ts` では `{}` を渡す（省いていてターミナルの貼付が常に空振りしていた）
- **通知の送り主（PC）**: エージェントの状態のポーラーはスコープの内訳とペイン単位の状態を `batchUpdates` の中で入れ、変化通知を1回にまとめる（間で通知が出ると、ペイン単位の状態を1回古いまま読む）。`detectAndNotify` はペインごとの前回の状態を覚え、今回 permission / review へ変わったペインを送り主にする
- **ネイティブの反映（3つとも prebuild 不要）**: (1) `app/` で `pnpm install`（RN パッチが node_modules に当たり、`expo-network` が入る）。(2) `app/mobile/native/NotifyExtension/NotificationService.swift` を `app/mobile/ios/NotifyExtension/` へ写す。(3) `app/mobile/ios` で `pod install`（`expo-network` の pod を足すため。RN パッチだけなら不要）→ Xcode で再ビルド。RN はソースからビルドしている（`ios.buildReactNativeFromSource`）ので、パッチは再ビルドで効く

### PC とアプリの互換の窓（Orca W2-17、2026-09-29）

版は 3 のまま、State（PC → アプリ）に `minCompatibleMobile` と `capabilities`、State の要求（アプリ → PC）に `minCompatiblePc` と `capabilities` を任意項目として足した。判定は `src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.ts`（`paradisEvaluateMobileCompat`）の 1 か所で、アプリはこのファイルを相対パスで直接 import する（依存ゼロに保つこと。`metro.config.js` の `watchFolders` に `mobileRelay/common` を足した）。PC とアプリが同じ関数で判定するので、「PC は通すがアプリは拒む」のずれが起きない。

版の上げ方の規則は次の 4 つ。

1. 任意項目・新しいメッセージの種類・無視できるイベントを足すだけなら版を上げない。capability（`<領域>.<機能>.v<N>`、例 `scm.push.v1`）を 1 つ足し、相手が広告しているときだけ使う
2. メッセージや必須項目の削除、既存項目の意味（単位・null の可否）の変更、フレーミング・暗号・認証の変更をしたときだけ `PARADIS_MOBILE_PROTOCOL_VERSION` を上げる
3. 上げても古い相手と話し続けられるなら `PARADIS_MOBILE_MIN_COMPATIBLE_MOBILE` / `_PC` は据え置く。古い相手を切るときだけ上げる
4. 送る内容を変えるだけでも旧版は壊れうる。既存の種類の意味は変えず、新しい種類か新しい capability の版で足す

**PC から送る側は、今は版を下げて話せない。** 判定の `wireVersion`（窓の中で古い方の版）を使っているのはアプリ → PC の個々の操作だけで、PC → アプリの State・term・agent は常に PC 自身の版の形で送っている。そのため PC の版を上げても `minCompatibleMobile` を据え置く（旧アプリを切らない）なら、旧アプリへは v3 の形で送り続ける必要がある。版で送る形を分けるときは、セッションごとの版を `IParadisMobileRelayService.getMobileWireVersion(mobileId)`（shared process では `MobileSession.wireVersion`、登録表の処理では `context.mobileWireVersion()`）で引いて分岐する。State は全台へ同じバイト列を配っているので、分けるなら宛先ごとに組み立て直す必要がある

`minCompatible*` を送らない相手（W2-17 より前）は、これまでどおり版の完全一致しか受け付けないものとして判定する。版が読めない相手は版 0 とみなす。

| 組み合わせ | 結果 |
|---|---|
| 旧アプリ × 新PC（どちらも版 3） | 通る。PC はアプリの capability を「持っていない」扱いにする |
| 新アプリ × 旧PC（どちらも版 3） | 通る。アプリは PC の capability を「持っていない」扱いにし、W2-17 より後の機能のボタンを出さない |
| 将来のアプリ v4（`minCompatiblePc: 3`）× 新PC v3 | 通る。個々の操作は古い方の版 3 で話す（判定の `wireVersion`） |
| 将来のアプリ v4 × 旧PC v3 | アプリに「PC の更新が必要」。旧PC は完全一致しか受けないため |
| 将来のPC v4（`minCompatibleMobile: 3`）× 旧アプリ v3 | 旧アプリは版の不一致で従来の案内を出す。PC は「アプリが古い」と判定する |
| 将来のPC v4（`minCompatibleMobile: 4`）× 新アプリ v3 | アプリに「アプリの更新が必要」 |

- **アプリの表示**: 版が合わないと `StoreState.updateRequired`（`app` / `pc`）が立ち、`PcSummary.updateRequired` を通して PC の画面（`PcUpdateRequiredState`）・ホームの PC カード・設定の PC 一覧に「アプリの更新が必要」「PC の更新が必要」を出す。以前の「両方を最新版へ」は使っていない。`ConnectionGate` はどの画面からも使われていないので、`protocolError` の文だけでは画面に出なかった（接続中のまま止まって見えていた）
- **PC の診断**: 版が合わないと Sentry の `mobile-e2e/protocol-mismatch` に `safe_reason`（`mobile-too-old` / `pc-too-old`）を付けて送る（アプリは State を何度も求めるので、同じセッションで 1 回だけ）。PC の画面にはまだ出していない
- **capability を見る場所**: アプリは `usePcCapability(name)`（いま見ている PC）/ `pcHasCapabilityFor(pcId, name)`。PC は `IParadisMobileRelayService.getMobileCapabilities(mobileId)`、登録表の処理なら `context.hasMobileCapability(name)`。広告の一覧は `PARADIS_MOBILE_PC_CAPABILITIES` / `PARADIS_MOBILE_APP_CAPABILITIES`（同じファイル）
- **新しい種類を足す手順（後続の担当向け）**: PC は新しいファイルで `registerParadisMobileRequestHandler('scm' | 'fs', kind, handler)` を呼び、`electron-browser/paradisMobileRequestHandlerRegistrations.ts` に副作用 import を 1 行足す（provider の分岐は触らない）。provider は既存の分岐で処理しなかった要求だけを登録表へ回す（scm はスペースの検査より前、fs はパス解決より前）。既存の種類は `common/paradisMobileRequestKinds.ts` に予約してあり、登録すると例外になる（provider に種類を足したらそこにも足す。`paradisMobileRequestKinds.test.ts` が provider のソースと突き合わせる）。応答の `id` は本文より後に置くので、処理が本文に `id` を入れても宛先は変わらない。アプリは `sendPcRequest(pcId, 'scm', { t: kind, ws, ... })`（`appState.ts`）か `MobileController.requestPc` で送る。`ws` を付けなければスペースを選ばず、いま前面のウィンドウ宛て（`rendererGeneration`）で送り、PC 側の `root` は undefined になる（shared process は予約に無い種類だけ ws 無しで通す）。id の無い知らせは `onPcMessage` で受ける（`pcId` を省くといま見ている PC に付いて行き、PC の切り替えやコントローラの作り直しで付け替わる）。どちらも capability を 1 つ足して、広告の無い PC にはボタンを出さない。agent チャネルの新しい種類は shared process の agentChat が受けるので、この登録表の対象外
- **固定形（ゴールデン）**: `app/protocol/test/golden/` の state / state-request / term / agent。PC の組み立てる State がゴールデンと同じ形か、アプリが送る形を PC が受けるか、PC が送る形をアプリが受けるかを両側のテストが確かめる。版・`minCompatible*`・`capabilities`・`fsUploadEncoding`・`voiceClips` は値まで比べるので、capability を足したらゴールデンの `state.json` / `state-request.json` も同じ変更で直す
- **版を上げるときに一緒に直す場所**: 2 進アップロードの枠（`app/protocol/src/fileUpload.ts` と PC の `paradisMobileFileUpload.ts`）は `protocolVersion` を固定で検査している（版 4 で 4 に直した）。`IParadisMobileDesktopStateV3` の名前は版 3 のまま（型の `protocolVersion` は定数を見る）
- **版 4（2026-10-05）で古い相手を切った。** PC・アプリとも `MIN_COMPATIBLE_*` を 4 にしたので、版 3 のアプリ・PC とはつながらない。詳細は「モバイルの音声通知のストリーミングと mux の版 4」

### 使用量を全 PC で合計するための PC 側（`usage.machine-id.v1`、2026-10-03）

モバイルの使用量を「全 PC の合計」にするため、PC が束ねる鍵と鮮度を返す。調査は `mobile-usage-multipc-mock.html`（リポジトリ外）。

| 項目 | 置き場所 | 中身 |
|---|---|---|
| 機械の印 | desktop state の `machineIdHash`、`renderers[].host.machineIdHash` | `sha256('para-code-machine-v1:' + id + ':' + OS のユーザー名)` の hex。id は OS の機械 ID（macOS は IOPlatformUUID、Linux は `/etc/machine-id` か `/var/lib/dbus/machine-id`、Windows は MachineGuid）を trim・小文字化したもの。ユーザー名を混ぜるので、同じ機械の別ユーザーへの SSH は別の相手になる。全部 0 の仮の値は使わない。Linux のコンテナの中（環境変数 `KUBERNETES_SERVICE_HOST`、`/.dockerenv`・`/run/.containerenv`・`/run/secrets/kubernetes.io`、`/proc/1/cgroup` に docker・containerd・kubepods・libpod・podman・lxc、`/proc/1/mountinfo` で `/` が overlay）では出さない。実体は `src/vs/paradis/node/paradisMachineId.ts`。手元のウィンドウの host は shared process が足し、SSH のウィンドウの host は renderer が接続先の `paradisHostResources` チャネルの `getMachineIdHash` で聞いて載せる（古い REH は Method not found なので載らない） |
| GitHub のアカウント | `github` の `account.login` | 枠を読む GraphQL のプローブ（`{viewer{login}}`）の本文から読む。追加の通信はしない |
| Codex のアカウント | `limits` の `codex.accounts[].accountId` | auth.json の account_id の `sha256('para-code-codex-account-v1:' + account_id)` の hex（束ねる鍵にしか使わないので生の値は送らない）。Claude の `organizationName`・アカウントごとの `fetchedAt` は以前から送っている |
| 鮮度 | `usage`・`limits`・`github` の `fetchedAt`・`stale` | `rtk` は `fetchedAt`（組み立てた時刻）だけで、`stale` は送らない（待って取る） |
| 打ち切り | `usage`・`rtk`・`limits`・`github` | 50 秒（`PARADIS_MOBILE_USAGE_DEADLINE_MS`）で `{ error, code: 'no-response' }`。裏の実行は止めない |

- **ccusage の stale-while-revalidate**: TTL を過ぎても 7 日以内の前回の値があれば `stale: true` ですぐ返し、裏で 1 本だけ取り直す。取り直しが失敗し続けたら 5 分から 60 分まで間隔を伸ばす。値が無いときと手動更新（bypassCache）だけ完了を待つ。取得時刻と古さは新しいコマンド `fetchReport` で返し、持たない古い REH には従来のコマンドで聞く
- **ccusage のキャッシュの鍵**: `--since` を除いた実行引数（`until`・`timezone` は残す）と実行ファイル。どの `--since` で取った値かは値の側に持ち、`--since` が違えば古い値として返して取り直す。同時実行の束ねと warm の対象は従来どおり `--since` を含む鍵
- **上限の使い分け**: ccusage の実行そのものは常に max(設定値, 15 分) まで走らせる。設定 `paradis.ccusage.execTimeoutSeconds`（既定 180 秒）は待っている側だけを外す上限で、外しても実行は止めない（走査をやり直さない）。終われば値が入るので、1 本 400 秒かかる PC でも既定のままで値が埋まる。走っている実行に相乗りした前景も、同じ上限で待つ側だけ外れる
- **失敗の短期キャッシュ**: 値が無いまま前景が失敗したら、`--since` を除いた鍵で 2 分間その失敗を返す。裏の長い実行が走っていれば、失敗を返さずにそれに相乗りする
- **孫プロセス**: POSIX では ccusage を `detached` で自分のプロセスグループに起こし、時間切れ・dispose ではグループごと、子が終わった瞬間にもグループの残りを止める（npx の先の node が孤児で残っていた）。グループへの SIGTERM の 3 秒後、子（グループの先頭）がまだ生きていれば SIGKILL も送る（生きている間だけ番号が自分のものと言えるため）。子が先に終わったら、子の exit で残りへ送る信号を、停止を頼んだ後なら SIGKILL にする（`paradisKillChildProcess.ts`。codex app-server も同じ）。REH ではプロセスの終了時にも止める。Windows は従来どおりツリーごと止める。rtk は npx を挟まず子を起こさないので変えていない
- **ステータスバー**: 取得が続けて失敗したら 10 → 20 → 40 → 80 分と間隔を伸ばし、成功で 10 分に戻す。昨日以前に取った古い値では今日のコストを出さない（`$0.00` と見せない）
- **limits**: Codex のスナップショットも TTL（150 秒）を過ぎたら、6 時間以内の前回の値を `stale: true` で返して裏で取り直す。取り直しが続けて失敗したら 1 分から 10 分まで間隔を伸ばす。全ホームが一時的な失敗（status `error`）だけのときは失敗として扱い、前回の値を残す（再ログインが要る `relogin_required`・`no_credentials` は今の状態として出す）
- **打ち切りの文言**: 50 秒の打ち切りの文は `paradisMobileUsageNoResponseMessage()`（localize 済み、4 種で共通）

### スマホのブラウザ画面からの文字とキーの入力（`browser.keys.v1`、2026-10-01）

ブラウザ画面のツールバーの右端（キーボードのボタン）で、ツールバーの代わりに入力の段が出る（`app/mobile/src/components/browserKeyInput.tsx`）。文字は従来からある browser の `input` の `kind: 'text'`（PC は `Input.insertText`）で、確定した文字だけを送る。日本語の変換中の Return は OS が確定に使うので送信にならない。特殊キーは新しい `kind: 'key'`（`key` と任意の `shift: true`）で、PC は `common/paradisMobileBrowserKeys.ts` の許可リスト（Enter・Backspace・Delete・Tab・Escape・矢印・Home・End・PageUp・PageDown）にある名前だけを `Input.dispatchKeyEvent` の押す・離すにして送る。

- **macOS の `commands`**: CDP で合成したキーは、macOS の Chromium では削除・カーソル移動の編集の操作にならない。PC が macOS のときだけ `commands`（`deleteBackward`・`moveLeft` など。Playwright と同じ対応表）を押す側に添える。`insert*`（Enter の `insertNewline`、Tab の `insertTab`）は文字やフォーカス移動と二重になるので渡さない
- **互換**: アプリは PC の `browser.keys.v1` を見て、無ければキー行の代わりに「PC を更新すると送れます」と出し、空の Return・空の ⌫ も送らない（文字の送信は古い PC でも効く）。古い PC に `kind: 'key'` が届いても `dispatchInput` のどの分岐にも当たらず、何も起きない
- **入力欄の動き**: 文字があれば Return で文字だけ送る（Enter は付けない）。空の Return は Enter、空の ⌫ はページ側の 1 文字削除。入力の段を開いている間は映像のタップでキーボードを閉じない（`keyboardShouldPersistTaps="handled"`）ので、ページの入力欄をタップしてから続けて打てる
- **iPad の外付けキーボードの矢印は見送った**: 入力欄に打った文字・Return・⌫ はそのまま上の経路で届くが、矢印は RN の `onKeyPress` に来ないので `src/ipad/shortcuts.ts` の UIKeyCommand が要る。矢印（修飾なし）は既にターミナルのライブ入力（`terminal.up` など）に割り当て済みで、`shortcuts.test.ts` の「同じキーの組み合わせを2つに割り当てない」に反する。足すなら `terminalArrows` の受け口を「入力欄の矢印を相手へ回す」汎用の受け口に直し、⌘ 長押しの一覧の名前も両方に合うものへ変える

### モバイルのコンポーザーの Monitor のピル（`agent.monitors.v1`、2026-10-02）

Claude Code の Monitor（出力を 1 行ずつ会話へ通知するバックグラウンドのシェル）を、モバイルの入力欄のモデルピルの右に出す。調査とモックは `monitor-composer-mock.html` の案A。PC は transcript から Monitor を読み（`agentChat/common/paradisAgentMonitors.ts`。パーサーは `paradisAgentTranscriptParser.ts` が手がかりを `signals.monitorSignals` に集めるだけ）、tailer が epoch ごとに一覧を持って agent の snapshot / delta の任意項目 `monitors` で丸ごと送る。古いアプリは読まずに無視し、古い PC からは来ないのでアプリはピルを出さない。

- **読み方**: 起動は tool_use `Monitor` の input と、tool_result の `Monitor started (task …)` の行の `toolUseResult`。出力は `<task-notification>` の `<summary>Monitor event: "…"</summary>` と `<event>`（`<status>` 無し。時間切れも `<event>` が `[Monitor timed out …]`）。終了は `<status>` 付きの通知。バックグラウンドの Bash も同じ b 始まりの ID・同じ形で終わるので、知らない ID の終了は要約が `Monitor "` で始まるときだけ拾う。停止は TaskStop の結果の `toolUseResult.task_id`
- **推定**: 常駐でないものは `timeout_ms`（上限後に出力が届いたら最後の出力）に 30 秒足した時刻を過ぎたら「時間切れ（推定）」、SessionEnd の hook で動いているものを「停止（推定）」にする（TUI から止めた・プロセスが終わったときは transcript に印が残らないため）。ペインが止まっている（SessionEnd の後・ペインが生きていない）間は、送るたびに動いているものを「停止（推定）」へ直す（推定は tailer のメモリにしか無く、作り直すと再生で running に戻るため）。同じ出力の通知が `queued_command` と user 行に重ねて書かれたら（taskId, 時刻, 本文）で 1 件にする。8 MB を超える transcript の末尾だけ読んで起動行が無いものは、通知の要約の説明で代わりにし、出力が 1 時間途絶えたら時間切れ（推定）にする。終わったものは 30 分で一覧から外す。上限は 20 件・出力は末尾 5 行（1 行 300 文字）
- **時計**: 送る時刻は PC の時計に直す。SSH の写しは transcript の時刻が接続先の時計なので、ライブ追記の行の時刻と読んだ時刻の差の最小値を「ずれ」として推定の判定と送る時刻に使う。一緒に送信時刻 `monitorsAt` を載せ、アプリは受け取った時刻との差を全時刻へ足して手元の時計へ直す（「終了から 1 分」をスマホの時計で判定するため）。起動行が読めなかったものは `startUnknown` を付け、アプリは経過時間に「以上」を付ける
- **アプリ**: `app/mobile/src/agentMonitors.ts`（純関数）と `features/session/monitorDrawer.tsx`。ピルは実行中か終了から 1 分以内のものがあるときだけ出し、出さないときも木に残して `display: 'none'` にする。停止の操作は置かない（見るだけ）。幅が足りないときはモデルピルが縮む
- **既知の制約**: TUI から止めた常駐の Monitor、SessionEnd を出さずに落ちたプロセス、hook が届かない構成（WSL）では、transcript に終わりの印が残らないので「実行中」のまま残る。時計のずれは最小値を保持し続けるので、SSH の接続先の時計が途中で戻されると推定の時間切れが早まる。最初のライブの行を読むまでずれは 0 として扱う

### モバイルのブラウザのタブを案A に作り直した（`browser.space.v1` ほか、2026-10-02）

見た目と動きの正解は `mobile-browser-ux-mock.html` の案A（リポジトリ外のモック）。上の段に戻る・進む・再読み込み（読み込み中は停止）・アドレス・ページ数・全画面を置き、その下に PC と同じブックマークバー、残りを映像にした。上へ・下へのボタン・下のツールバー・ページのチップの列・映像の外周の余白は無くした（上の節の「ツールバーの右端のキーボードのボタン」は、映像の右下の丸いボタンに移った）。

| capability | 中身 | 置き場所 |
|---|---|---|
| `browser.space.v1` | browser の `targets` の `windowId` と `ws`（スペースの `sourceId`）で、そのスペースのページだけを返す（応答に `scoped: true`）。fs の `openUrl` の `ws` で、そのスペースに開く | Renderer `electron-browser/paradisMobileBrowserScopeSync.ts` → `IParadisMobileRelayService.syncBrowserScopes` → shared process の `resolveBrowserSpaceTargetIds`。判定は `common/paradisMobileBrowserScope.ts` |
| `browser.page.v1` | 通知 `page`（url・title・loading・progress・canGoBack・canGoForward）。入力 `stop` と `open`（アドレス欄の生の文字） | `node/paradisMobileBrowserMirror.ts`。純関数は `common/paradisMobileBrowserPageState.ts`・`common/paradisMobileBrowserAddress.ts` |
| `browser.focus.v1` | 通知 `focus`（欄の番号 `fieldId`・種類・`type`・中身・`fromTap`・`seq`）。入力 `replace`（`fieldId` の欄の中身を全部置き換える）と、断った知らせ `inputRejected`。**アプリもこの capability を広告し、PC は広告したアプリにだけ `focus` を送る**（欄の中身を含むため） | 同上（注入スクリプト `PARADIS_MOBILE_FOCUS_SCRIPT`） |
| `browser.bookmarks.v1` | fs の要求 `bookmarks` と、変わったときの通知 `bookmarksChanged`（fs、`id` なし） | `electron-browser/paradisMobileBookmarkRequests.ts`。変換は `common/paradisMobileBookmarks.ts` |

形と読み方はアプリと PC で 1 つのファイル（`common/paradisMobileBrowserProtocol.ts`。import を持たないのでアプリが相対パスで読む）に置き、固定形は `app/protocol/test/golden/browser.json`。

- **スペースの台帳**: モバイル機能を無効にしている間は作らない（設定の切り替えで作る・捨てる）。Renderer が `{ managed, views: { viewId, stateKey? }[] }` を作り、`syncBrowserScopes` で shared process へ送る。スペースの切り替え中は送らず、直前の台帳を保つ（`resolveScope` が `pending` を返すため。PC の一覧 `paradisBrowserLiveModel.ts` と同じ考え方）。変化が無ければ送らない。受理されなければ 5 秒後、shared process の作り直しに備えて 60 秒ごとにも送り直す。初回は terminal state の同期の後（lease を登録表が知るのがその時点のため）。shared process は windowId ごとに持ち、`targets` に `windowId`・`ws` が付いているときだけ `resolveTargetId(viewId)`（electron-main の `ParadisCdpTargetService`。`IParadisCdpFrameSubscription` に宣言を足しただけで、ProxyChannel の公開は既存）で引いた targetId で `/json/list` を絞る。台帳が無い・lease が古い・古いアプリの要求なら全件を返し `scoped` を付けない（アプリはそのとき見出しを「ブラウザのページ」にする）。`windowId` / `ws` が片方だけ・形が違う・`ws` が上限（4096 文字。worktree の stateKey はパスを含み、日本語のパスは 1 文字が 9 文字になるので長い。台帳の stateKey も同じ上限）を超えるときは、黙って全件に戻さず `invalid-scope` で断る。所属の決まっていないビューは、スペースのウィンドウではどの一覧にも出ない。`start` も、targetId の形式（英数字と `-_.`、128 文字まで）・`/json/list` の http(s) のページであること・スペースが付いていて台帳があるならそのスペースのページであることを確かめ、違えば断る。アプリは前回の選択をスペースごとに持ち（`scopeKey`）、映していたページが一覧から外れたら PC のミラーも止める
- **ページの状態**: ミラーのソケットで CDP のイベントを読む（それまでは id 付きの応答しか見ずに捨てていた）。進み具合は開始 0.1・DOMContentLoaded 0.6・load と停止で 1 の 3 段階。url・title・戻る/進むの可否は `Page.getNavigationHistory` から取り、題名の変化に追うため約 1 秒ごとにも読み直す。署名が変わったときだけ送る。古いアプリは `page` / `focus` を読み捨てる（id が無く `frame` でもないので store の分岐に当たらない）ので、アプリの capability は足していない
- **アドレス欄**: アプリは打った文字をそのまま `open` で送り、PC がアドレスバーと同じ `resolveAddressBarInputType` と設定 `workbench.browser.searchEngine`（shared process の設定から読む。未設定・知らない値は Google）で URL か検索かを決める。スキームの無い URL は、手元のホスト（localhost・IP・`.local`・ドットの無い名前）なら http、それ以外は https。http(s) 以外は開かない。`browser.page.v1` の無い古い PC には、アプリが手元で URL にして（検索は Google）従来の `navigate` で送る（`app/mobile/src/browserAddress.ts`）
- **入力欄のフォーカス**: 分離ワールド（`Page.addScriptToEvaluateOnNewDocument` の `worldName` と `Runtime.addBinding` の `executionContextName`）に注入するので、ページ本体からバインディングは見えない。ワールドは 1 ページに 1 つ: `Runtime.enable` が今ある文脈を知らせてくるので、前のミラーが作った同じ名前のワールド（メインフレームのもの）があれば使い回し、無いときだけ `Page.createIsolatedWorld` で作る。注入スクリプトは入れた回数を数え、ミラーを止めるときの `__paraMobileFocusDispose()` は 1 つ減らし、最後の 1 つのときだけリスナーを外す（張り直しでリスナーを溜めず、同じページを映すもう 1 台のスマホの置き換えも止めない）。バインディングは呼ぶたびに引くので、使い回したワールドでも新しい CDP の接続へ届く。`Runtime.bindingCalled` は自分のワールドの文脈 ID（`executionContextId`）のものだけ受ける（iframe の中にできた同名のワールドや、ほかの文脈からの報告は捨てる）。focusin/focusout と input（300ms 間引き）で `document.activeElement`（shadowRoot をたどる）を知らせ、タップの 150ms 後にも今のフォーカスを報告させて `fromTap` を付ける（同じ欄をもう一度押したときのため）。欄には `WeakMap` で番号（`fieldId`）を振る。番号の起点はスクリプトを入れるたびに乱数（2^40 までの整数）にする（文書が替わると入れ直すので、1 から振ると前の文書の欄の番号が新しい文書の欄と一致する）。メインフレームの文書が替わったら（`Page.frameNavigated` の `parentId` の無いもの・`Runtime.executionContextsCleared`）、捨てられた文書からは知らせが来ないので、ミラーが `focused: false` を送って重複排除の控えも消す。アプリはそれで欄と番号を捨てる。パスワードの欄は中身を送らず、4000 文字を超える中身は先頭だけで `truncated`。contenteditable は中身を送らない（書式・リンク・画像を持つので、文字だけで置き換えると消える）
- **置き換え（`replace`）**: アプリは `fieldId` を付けて送り、PC は分離ワールドで「今のフォーカスがその番号の input / textarea のとき」だけ全選択して `Input.insertText`（空なら Backspace）。違えば置き換えずに `inputRejected`（`field-changed`）を返し、今のフォーカスを知らせ直させる（この知らせ直しは前と同じ中身でも重複排除を通さずに送る）。`replace` / `text` / `open` の文字が 8192 文字を超えたら `too-long`。アプリ側の決まり（`app/mobile/src/browserKeyboard.ts`）: `fromTap` のフォーカスでだけ自動で開き、自動で開いたものはフォーカスが外れたら閉じる（直しかけの文字があれば閉じない）。欄が替わったら（別の欄をタップした・ページがフォーカスを動かした）直しかけの文字は捨てて新しい欄に合わせる。Return は「中身が欄と同じなら Enter、違えば `replace`」。断られたら基準を送る前に戻し、入力欄の見出しに理由を出す。中身が分からない（手動で開いた・古い PC・`truncated`・contenteditable）ときは従来どおり `text` で足す。textarea と contenteditable は複数行で直し（Return は改行、送るのは送るボタン）、入力欄に 8192 文字の上限を付ける
- **ブックマーク**: PC のブックマークはアプリ全体で 1 つの保存先なので、要求を受けたウィンドウが答える。favicon は 1 枚 24KB・合計 768KB まで（超えた分は地球のアイコン）。答えたモバイルを 10 分間の購読として覚え、変わったら `bookmarksChanged` を送る。アプリは前面でブラウザのタブを見ている間だけ読み、知らせと 5 分ごとに読み直す（`features/browser/useBrowserBookmarks.ts`）。最初は見て開くだけ（今のページで `navigate`）
- **openUrl**: スマホのターミナルで押した URL は、そのターミナルのスペースに開く（そうしないとスペースで絞った一覧に出ない）。今の PC のスペースならそのまま、補助ウィンドウにピン留めされたスペースならそのグループへ開き、どこにも見えていなければ開かずに `space-not-visible` を返す（アプリは「PC でこのスペースに切り替えてから」と案内する）。PC のスペースは勝手に切り替えない
- **接続経路の印**: アプリだけで決める（`app/mobile/src/browserRoute.ts`）。WebRTC の `getStats()` の transport が指す選ばれた候補の組（無い実装では nominated かつ succeeded の組）の `candidateType` で、両方 host なら同じネットワーク、どちらかが relay なら TURN、それ以外はインターネット越しに直接。JPEG を写しているときはリレーサーバー経由。つながった直後と 5 秒おきに調べる
- **全画面**: iPhone の全画面から開くシート（RN の Modal）は既定で縦向き限定なので、`BottomDrawer` の `allowLandscape` で横を許す。印はアプリに 1 つ（`features/browser/browserFullscreenStore.ts`。決まりは `browserFullscreen.ts`）。セッションの画面は見出しとタブの列を高さ 0 で隠す（木の形は変えない）。iPhone はボタンか、端末を横に倒して入る。倒して入ったときは縦に戻すと抜け、ボタンで入ったときは抜けない。画面を離れたら抜ける。iPad は端末の向きでは出し入れせず、左の列も畳む（抜けたら戻す。全画面による畳みは保存しないので、全画面中に強制終了しても次は元のまま）。隠した見出しは VoiceOver からも外す

#### 全画面の間だけ iPhone の横向きを許す（`ios/` への手当て）

アプリは縦に固定（`app.json` の `orientation`、`ios/ParaCodeMobile/Info.plist` の `UISupportedInterfaceOrientations` は縦だけ）のまま、既存のローカルの Expo モジュール `modules/para-ipad-input` に `ParaOrientationGate` と JS の `setLandscapeAllowed` / `observeDeviceOrientation` を足した。**新しいネイティブの依存は無く、`pod install` も要らない**（既存のモジュールの Swift に足しただけ）。端末の向きは `UIDevice.orientationDidChangeNotification` で、画面が縦に固定されている間も届く。

`ios/` は git の管理外なので、`ios/ParaCodeMobile/AppDelegate.swift` に次を手で当てた（別の Mac でビルドするときも同じ変更が要る。Info.plist は変えていない）:

```swift
internal import ParaIpadInput   // 先頭の import に足す（ExpoModulesProvider と同じく internal。付けないと「ambiguous implicit access level」で止まる）

  // class AppDelegate: ExpoAppDelegate の中
  public override func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    return ParaOrientationGate.shared.supportedOrientations(
      base: super.application(application, supportedInterfaceOrientationsFor: window))
  }
```

`supportedOrientations(base:)` は iPad と許していない間は `base`（Info.plist のまま）を返し、許している間だけ横を足す。許したときに端末がもう横なら `requestGeometryUpdate` で横へ回し、許さなくしたら縦へ戻す。これを当てていないバイナリでは、JS の `setLandscapeAllowed` を呼んでも横に回らない（全画面は縦のまま効く）。モジュールの無い古いバイナリでは、横に倒して入るのもやめる（`supportsLandscapeGate()`）。

#### 確かめ方と既知の制約

- ペアリングの無いシミュレータでは `__paraDev.demo()` の後に `__paraDev.browserDemo()`（`{ loading: true }` で読み込み中）。ストアのブラウザの操作を差し替え、見本の画像（`src/dev/demoBrowserFrame.ts` の base64。`fetch` で資産を読むと、このビルドでは Blob を作れず落ちたため。`__DEV__` の中の require でだけ読むので本番の bundle には入らない）・3 枚のページ・ブックマークを出す。`__paraDev.browserFocus()` で検索欄をタップしたことにする（`src/dev/browserDemo.ts`）
- iframe の中の欄はフォーカスを拾わない。注入スクリプトはメインフレームの文書の `activeElement` を見るので、iframe の中の欄にフォーカスがあると `focused: false`（iframe の要素は欄ではない）になる。同一オリジンの iframe には `addScriptToEvaluateOnNewDocument` で同名のワールドができてスクリプトも動くが、その報告は文脈 ID が違うので捨てる
- モックにある「キーボードが開いたら欄の位置へ寄せて拡大する」は入れていない（欄の位置を送っていない）
- 同じページを複数のスマホが同時に映すと、ワールドとリスナーを共有する（数を数えるので、片方が止めてももう片方は動き続ける）。どちらにもフォーカスの通知が届くが、`fromTap` はそれぞれのミラーが最後に送ったタップの時刻で決める。ミラーの CDP の接続が後片付けを経ずに切れたときは数が減らないので、そのページではリスナーが残る（同じページで次にミラーを張ったときに数が合わないだけで、置き換えは止まらない）
- CDP の動きは偽の CDP を使った単体テストだけで確かめている。実機の PC とスマホをつないだ確認はまだ

### スペースのメモの版と差分レビューの記録（Orca W2-16 / W2-14 / W2-28、2026-09-29）

モバイルからの書き込みで PC 側の変更を黙って消さないことが共通の主題。どれも任意項目・新しい種類の追加だけで、版は上げていない。

| capability | 中身 | 置き場所 |
|---|---|---|
| `note.cas.v1` | `noteGet` / `noteSet` の応答に `updatedAt`（メモの版）。`noteSet` の任意の `base`（読んだときの版。違えば書かずに `conflict: true` と最新を返す）と `op`（`toggle { line, lineText }` / `append { entry }` を PC の最新に当てる） | `common/paradisMobileSpaceNoteSet.ts`、provider の noteGet/noteSet の分岐 |
| `review.store.v1` | `reviewGet` / `reviewSet`（確認済みの印を1件ずつ付け外し）。status の応答に任意の `oldPath` と両側の行数（`added` / `removed` / `stagedAdded` / `stagedRemoved`、バイナリは -1）、未追跡のファイルの `size` / `mtime`（先頭 100 件まで。ルートの realpath を1回にまとめて調べる `paradisStatMobileWorkspaceFiles`）。応答に記録の版 `revision`（保存のたびに増える。アプリは手元より古い版の応答を捨てる） | `electron-browser/paradisMobileDiffReviewRequests.ts`（登録表） |
| `review.notes.v1` | `reviewNoteAdd` / `reviewNoteEdit`（メモの id は `noteId`。`id` は応答の宛先）/ `reviewNoteDelete` / `reviewNotesClear` / `reviewNotesSend` | 同上 |
| `review.stage.v1` | `reviewStage { entries: [{ path, identity }] }` | 同上 |

- **メモの版**: `IParadisSpaceNotesService.readEntry` の `updatedAt`。書くたびに `max(Date.now(), 前の版 + 1)` にして、同じミリ秒の2回の書き込みでも版が変わるようにした。比べて書くまでは await を挟まない（レンダラーは1本のスレッドなので、それで一続きになる）。古い PC は `base` / `op` を無視して `text` で上書きするので、アプリは `text` にも操作を当てた後の全文を入れて送る
- **PC のメモ欄**: 編集を始めたときの本文と版を控え、終えるときに版が変わっていれば行単位で合わせる（`paradisMergeSpaceNoteEdits`。重ならなければ両方、重なれば保存せずに通知で「自分の編集で上書き」「自分の編集をコピー」）。storage の定期の書き出し（`onWillSaveState` の SHUTDOWN 以外）では、他で変わっていれば書かない。ウィンドウを閉じるときは知らせる先が無いので、重なれば今までどおり編集欄の中身で書く
- **差分の識別**: `common/paradisMobileDiffReview.ts`（依存ゼロ。アプリが相対パスで直接 import する）の `paradisMobileDiffIdentity`。状態・パス・元のパス・両側の行数・未追跡のファイルの大きさと時刻の FNV-1a（種を変えて2回、16桁）。**追跡中のファイルで行数が同じ書き換えは見分けられない**（Orca と同じ弱点）。未追跡のフォルダ（`dir/`）は大きさも時刻も持たない。ステージすると状態と行数の側が変わるので、`reviewStage` は `git add` の後、足した中身がスマホの見たものと同じだと確かめられたもの（`paradisStagedConsistently`: 作業ツリー側だけの変更はステージ後の行数が同じ、未追跡は `A ` で、足した後に調べ直した大きさと時刻が同じ（追跡中になると status に大きさが載らないため、`reviewStage` が別に調べて渡す）。`MM` は確かめられないので付け替えない）の印だけをステージ後の識別へ付け替える。PC の画面で手でステージした場合は付け替えないので「確認後に変更あり」になる
- **保存**: ウィンドウの WORKSPACE ストレージの `paradis.mobileRelay.diffReview.v1`（スペースのメモと同じ置き場）。スペース 32 件・印 500 件・メモ 100 件（本文 2,000 字、控える行は 500 字）・全体 2,000,000 字まで。全体の上限を超えたら、スペースを丸ごと捨てる前に、最も長く触っていないスペースの古い記録（送信済みのメモ → 印 → 送っていないメモの順）から半分ずつ削る。`reviewGet` は status に無いパスの印を外す。印は1件ずつ変えるので、iPhone と iPad が同時に別のファイルへ付けても消し合わない
- **行への追従**: メモは書いたときの新しい側の行番号と行の中身（`lineText`）を持ち、同じ番号の中身が違えば前後 50 行から同じ中身の行を探す（`paradisLocateReviewNoteLine`。アプリは差分の行から、PC は作業ツリーのファイルから引く）。アプリは差分の中だけを見るので、行が差分の外に出たメモも「古いメモ」に出る。PC の `reviewNotesClear` はファイルで判定するので、差分の外でもファイルにあれば消さない。ただし変更の一覧（`status -uall`。未追跡のフォルダの中も1件ずつ）に無いファイル（コミット・破棄された）のメモは、行が残っていても消す
- **送信**: 依頼文は PC が保存済みのメモから組み立てる（`paradisBuildReviewNotesPrompt`。スマホから届いた文章は打ち込まない）。依頼文は改行以外の制御文字を落としてから送る（`paradisStripTerminalControlCharacters`。メモの本文と控えた行の中身はリポジトリ由来になりうり、`ESC [201~` で貼り付けの囲みを抜けられるため）。既にあるターミナルへは `paradisSendAgentMessageToTui`（貼り付け → Enter の前に確かめ直す）で送り、送ってよいのは「そのスペースのエージェントのペイン」かつ「park 中でない」かつ「作業中・許可・質問でない」かつ `paradisCanPasteMultiline`（貼り付けの囲みが有効で、シェル統合の実行中のコマンドが claude / codex）のときだけ（`paradisReviewNotesTargetVerdict`。Enter の前の確かめ直しも同じ判定）。**エージェントを抜けた後のシェル・ssh・python などに依頼文が渡ると、行やコマンド置換が実行されるため**。確かめられないターミナル（シェル統合の無い WSL・SSH の一部など）には送らず、新しいエージェントの起動を案内する。新しく起動するときは `paradisLaunchAgentInWorkspace` の `prompt`（`preserveFocus: true`。起動を待つのは 45 秒までで、超えたら未送信のまま返して送信中の印を外す。起動後に登録表の `context.pushState()` で状態をすぐ送る。シェルの種類が分からず `\` を含むと起動できないので、その旨を返す）。依頼文は 16,000 字まで。同じスペースへの送信は1本ずつ（送信中なら断る）。送れたメモは `sentAt` を付けて残す（Q120 A）が、送る間に書き直されたメモ（読んだときの `updatedAt` と違うもの）は送信済みにしない
- **ステージ**: 許可リストの既存の `add` を使い、`git add -- :(literal)<path> …` を1回だけ実行する（許可リストは変えていない。`:(literal)` でパスの記法を読ませない）。PC が status と行数を読み直して、識別がスマホの見たものと同じで、しかも **PC に保存した確認済みの印が今の識別と一致する**ファイルだけを足す（スマホが送ってきた識別だけは信じない）。競合・インデックス側だけの変更・引用付きのパス・未追跡のフォルダ（`dir/`。確認後に中に足されたファイルまで入る）・大きさの無い未追跡のファイル（調べる上限より後ろ・読めなかった。足した中身を確かめられない）は足さない
- **登録表の `context.pushState()`**: 登録表の処理から State をすぐ送り直す口（W2-28 で追加。provider の `pushState` につながる。無い host では何もしない）。ターミナルの増減は変化の知らせでもいずれ送られる
- **アプリのメモの保存の順番**: `useSpaceNote` は保存を1本ずつ送り、前の保存の応答で版が進んでから次の全文の保存に版を付ける（切り替え・追加の直後の編集が、自分の保存と食い違って書かれない事故を防ぐ）。PC のメモ欄の「自分の編集で上書き」は、知らせを出したときの版から変わっていれば上書きせずにもう一度知らせる
- **シートの中の失敗はシートの中に出す**: `BottomDrawer` / `RightDrawer` は RN の `Modal` で出るので、アプリの上端のトースト（`app/_layout.tsx` の `<ToastHost />`）はその裏に隠れて見えない。差分レビューのメモのシート（書く・一覧・送る・片付け）は `useReviewNotes` の `error` をシートの中の `InlineError` に出し、送れたお知らせはシートを閉じ切った後（`onAfterClose`）にトーストで出す。【要確認】ほかの画面でも、シートを開いたまま `useParaToast` で失敗を知らせている所は同じく見えていない可能性がある（この担当では差分レビューの範囲だけ直した。共通の仕組みにするなら、Modal の中に ToastHost をもう1つ置くか、シートに失敗の行を持たせる）
- **PC のメモの画面は未実装**（Q120 A）。保存先は共有しているので、PC に画面を足すときは `paradisReadMobileReviewStore` を読めばよい

### スマホのターミナルの表示（Orca W2 の L4: W2-23 / W2-18 / W2-31 / W2-19、2026-09-29）

- **WebView への書き込み（W2-23）**: `termView.tsx` は出力を `termWriteCoalescer.ts` で 48ms ずつまとめて inject する（暇なときの最初の 1 件は即、512K 文字を超えたら即）。取りこぼし検出の inject 連番は**まとめた単位**で振る。snapshot と旧 PC 経路の reset の前、アプリが裏に回る直前は先に流し、WebView を読み直すとき（準備完了・プロセス死）は捨てる。準備完了は `termReadyWatchdog.ts` が 15 秒見張り、1 回だけ自動で読み直してから、エラーと［再試行］を重ねる（裏にいる間は判定しない）。失敗の表示は WebView の上に重ねるだけで、木の形は変えない。**読み直しは WebView の `key` を変えて作り直す**（`source={{ html }}` の WebView は `reload()` で HTML を読み直さず `about:blank` のまま戻らない。シミュレータで確認済み）。コンテンツプロセスが落ちたときも同じ経路。まとめ役は、次の 1 件が来た時点で窓を過ぎていればタイマーを待たずに流す（JS が詰まってタイマーが遅れると、出力が何秒も溜まったまま止まっていた）
- **大量出力の間に JS が止まる件（W2-23 の確認で判明）**: `store.ts` は同期ストリームの 1 フレームごとに `terminalOutput` を書き換えて `emit({ term: true })` し、それを購読していた `TerminalPane` が毎フレーム丸ごと再描画していた（シミュレータで JS が約 9 秒止まった主因）。`terminalOutput` は旧 PC の経路でしか使わないので、`TerminalPane` は snapshot を一度受けたら購読の結果を空文字に固定し、再描画しないようにした。【要確認】毎フレームの `emit` 自体（200K 文字までの連結、Map の複製、全購読者のセレクタの実行）は残っている。まだ重ければ、同期ストリームのフレームでは `terminalOutput` を書き換えず emit もしない形にする（`store.test.ts` と `wireGolden.test.ts` の `terminalOutput` を見る検査を、ストリームの購読で見る形に直す必要がある）
- **キーボード表示中だけターミナルが黒いまま、の調査（W2-23 と同時、未解決）**: 原因は確定していない。xterm 6 は描く面が IntersectionObserver で「画面と重なっていない」と知らされると描画を止め（`RenderService._handleIntersectionChange`）、重なったと知らされるまで溜める。「データは届いているのに、キーボードを閉じると出る」という症状と合うので第一候補（推測）。キーボードの開閉では WebView の高さは変えず枠だけを縮めている（`terminalPane.tsx` の `onOutputLayout`）ので、WebView 自身の寸法は変わらない。WebKit はアプリ自身のキーボード（`UIKeyboardIsLocalUserInfoKey`）では WKWebView の inset を調整しない。開発ビルドでは、xterm が描画を止めたときに `[termView] xterm paused rendering` を Metro のログに出す。次に再現したらこのログの有無で切り分ける。出ていれば `window.IntersectionObserver` を常に「重なっている」と返す物に差し替えれば直る
- **snapshot をまたぐ制御文字（W2-18）**: provider は attach 中のターミナルの出力の末尾で閉じていない ESC / CSI / OSC / DCS を `paradisTerminalEscapeTail.ts` で追い、snapshot を送った購読の保留の先頭に置く（次のチャンクと一緒に届く）。7 ビットの ESC だけ、4096 文字で諦める。途中の C0 制御文字と DEL は、VT の解析と同じく続きとして扱う。出力を購読し始める前に PC の xterm が読んだ分は分からないので、そのターミナルの最初の attach の snapshot だけは従来どおり欠けうる
- **リンクのタップと選択（W2-31）**: WebView は押した位置の論理行（`isWrapped` でつないだ行、上下 40 行まで）と文字の位置だけを RN へ送り、判定は `app/mobile/src/terminalLinks.ts`（チャットと共有の `localFileTarget.ts`）がする。URL は `terminalUrlDestination` で `localhost`・ループバック・プライベート・リンクローカル・`.local`・ドットの無いホスト名を PC、それ以外を Safari に振る（確認なし、Q123 A。ホストの読み取りでは `\` をユーザー情報にもホストにも含めない。ブラウザは `/` と同じに扱うため）。ただし OSC 8 のリンクで、見えている文字が行き先と違い、行き先が PC のときだけは、行き先のホストを出して確かめる（`terminalLinkNeedsConfirmation`）。PC は fs の `openUrl`（`paradisMobileOpenUrl.ts`、`BrowserViewCommandId.Open`）で内蔵ブラウザに開き（ユーザー名・パスワード付きの URL は拒む）、アプリはページ一覧の前後の差で、同じオリジンの新しいページを探してブラウザのタブで映す（別オリジンの新しいページは選ばない）。パスは `resolveLink` に、PC が `fs.resolve-link.terminal.v1` を広告しているときだけ `terminalKey` を付け、PC がそのターミナルの cwd を基準に解く（ワークスペースの外・無いファイルは何もしない、Q31-2）。iPad のポインタは xterm の `registerLinkProvider` と OSC 8 の `linkHandler` に任せ、ホバーの下線とクリックは xterm が出す。指のタップの直後 1 秒は、iOS が合成するマウスのクリックでリンクを開かない。OSC 8 の行き先は xterm の内部（`_core._oscLinkService`）から読む（xterm を更新したら確かめ直す）。**既知の制限: snapshot で届いた OSC 8 のリンクは押せない**（PC の serialize addon がリンク先を書き出さないため、attach・リサイズ・追いつきの snapshot より前に出たリンクは文字だけになる。シミュレータで確認済み）。直すなら、PC が snapshot を撮るときに PC の xterm の `_oscLinkService` からリンク付きのセルを拾い、snapshot の後に `ESC ]8;;URI ESC \` 付きでその行を書き直す（またはリンクの一覧を snapshot に同梱し、スマホの xterm の該当セルに付け直す）。長押し 500ms で単語を選び、つまみとメニュー（コピー・すべて選択）は DOM で重ねる。iPad のポインタで xterm 自身が選んだ範囲にも同じメニューを出す（つまみは出さない）。選択中は TUI へのスワイプを送らず、最下部への自動スクロールもしない
- **PC の［PC の幅に戻す］（W2-19、Q115 A）**: provider が縮めた寸法をウィンドウ内の台帳（`common/paradisMobileTerminalViewportStatus.ts`）に載せ、`paradisMobileViewportBanner.contribution.ts` がエディタ領域（`paradisRegisterEditorTerminalOverlay`）とパネル（terminal contribution）の右下に案内を出す。押すと購読に「PC で戻された」印を付けてすぐ戻し、`term.viewport.takeback.v1` を広告しているスマホへだけ `viewport-revoked` を送る。印のある購読の申告（旧アプリの更新・再 attach を含む）は使わず、detach（開き直し）か `viewport` の `reclaim: true`（［再び合わせる］。アプリは寸法を申告していなくても reclaim だけは送る）で外す。印は購読が消えたとき（detach・exit・`detachAll`）だけ外し、スマホが 1 台減ったときの `clearAllTerminalViewports()` では外さない（寸法の台帳だけ消す）。そのため detach を送らずに落ちたスマホ（旧アプリの 2 台目など）の印は、全台が切れるかターミナルが終わるまで残る。害は無い（その購読は出力を受けるだけで、戻ってきても開き直すまで縮めないのは意図どおり）。猶予のうちに寸法なしの attach（戻ってきたスマホが測り直す前）が来たら、寸法を保ったまま猶予を数え直し、測り直した `viewport` を待つ（戻して縮め直すのを避ける。シミュレータで確認した不具合）。旧アプリ 0.2.0〜0.9.0 は term の知らない `t` を黙って捨てることを確認済み（分岐に else が無い）。スマホが離れた（detach・申告の取り下げ）後は 4 秒寸法を保つ（`TERM_VIEWPORT_RELEASE_GRACE_MS`）。リースの満了・ターミナルの終了・切断では猶予なしで戻す。「スマホの幅に合わせる」の既定はオフのまま
- **capability**: `browser.open-url.v1`（PC）、`fs.resolve-link.terminal.v1`（PC）、`term.viewport.takeback.v1`（PC とアプリ）。名前は小文字しか通らない（`CAPABILITY_PATTERN`）ので、設計書の `fs.resolveLink.terminal.v1` は `fs.resolve-link.terminal.v1` にした

### スマホからの git の同期・コミットの立て直し・PR の画面（Orca W2-15 / W2-36、2026-09-29）

どれも登録表の新しい種類と任意項目の追加だけで、版は上げていない。決めごとは Q114 A（強制 push はさせない・失敗したらステージを戻す・動いているエージェントか既定のエージェントへ頼む）と Q128 A（CI が失敗・実行中ならスマホからマージさせない・失敗したジョブのログを 3 件 200 行まで添える）。

| capability | 種類 | 置き場所 |
|---|---|---|
| `scm.sync.v1` | status の応答に任意の `upstream` / `ahead` / `behind`（`status --porcelain=v2 --branch --untracked-files=no` の見出し）。`push` / `fetch` / `pull`（応答にも同じ3つ） | provider の status の分岐に1行、`electron-browser/paradisMobileScmSyncRequests.ts` |
| `scm.commit-recover.v1` | `commitSafe { message, all }`（失敗は `{ ok: false, failure: { id, kind, summary, output, restored } }`）、`commitFix { failureId, target: 'auto' \| 'new' }` | 同上 |
| `scm.stage-file.v1` | `stage` / `unstage { paths }`（100 件まで、`:(literal)`。外すときは名前を変えたファイルの元の側も外す） | 同上 |
| `pr.view.v1` | `prView`（PR と CI のチェック、出せないときは `unavailable`: `no-gh` / `no-auth` / `no-pr` / `detached` / `error`）、`prFixChecks { number, target }` | `electron-browser/paradisMobilePullRequestRequests.ts` |
| `pr.merge.v1` | `prMerge { number, headSha }` | 同上 |

- **git の許可リスト**: `paradisWorktreeGitChannel.ts` の `runGit` に `push` / `fetch` / `pull` を足した。この3つだけは「危険なオプションを拒否する」ではなく**許すオプションを列挙する**検査（`common/paradisGitRestrictedArgs.ts`）に掛ける。push は `--porcelain` `--set-upstream` `-u` `--quiet` `-q` だけで、`--force` 系・`-f` を含む束ね（`-fu`）・`+refspec`・`:branch`（リモートのブランチの削除）・`--mirror` などは spawn する前に弾く。pull は `--ff-only` が必須。`::` と `://` を含む引数（URL や `ext::` の転送）は拒む
- **待つ時間と止め方**: push / fetch / pull と commit（フックが動く）は 120 秒、他は従来の 30 秒。時間切れは execFile の timeout（子の git だけを SIGKILL する）に任せず、`runGit` は git を自前で spawn して出力（合わせて 4 MB まで）を集め、POSIX では `detached: true` で新しいプロセスグループの先頭にし、グループごと SIGTERM → 5 秒後に SIGKILL する。**execFile に `detached` を渡しても spawn へは渡らず、グループが作られない**（シミュレータ確認で、post-commit の `sleep 30` が応答を 30.5 秒止めていた）。時間切れの後は孫プロセスが出力のパイプを握っていても `exit` で返し、SIGKILL の後さらに猶予が過ぎれば返す（応答は上限＋猶予の 2 倍まで。本物の git の post-commit フックで固定した）（git が `index.lock` を片付けられ、フックの孫プロセスも残らない）。**既知の制限**: Windows は子（git か wsl.exe）を止めるだけで、`taskkill /T` のようなプロセスツリーの停止はしていない。WSL へ振り分けた実行では wsl.exe を止めても、ディストロの中の git とフックが残ることがある。時間切れは stderr に `ParadisWorktreeGit: timed out after 120s` を、`index.lock` が残っていれば `ParadisWorktreeGit: index.lock remains` を足して返し、失敗の文に「ロックが残っています」を出す。`GCM_INTERACTIVE=never` を足し、Git Credential Manager が誰もいない PC に認証のウィンドウを出して待ち続けないようにした（端末の問い合わせは従来どおり `GIT_TERMINAL_PROMPT=0`）
- **push の宛先**: `git branch --format=%(HEAD)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)%00%(push:remoteref)%00%(push)%00%(refname)` で上流と git の push 先（`@{push}`。`branch.<name>.pushRemote`・`remote.pushDefault`・`push.default` に従う）を読み、`paradisMobilePushPlan` で決める。**`%(push:remoteref)` は `remote.<name>.push` の refspec が無いと空になる**（git 2.54 で実測。同名の上流・既定の simple でも空）ので、上流があるときの規則は次のとおり。remote が `.`（上流・push 先が手元）なら断る。`%(push:remoteref)` が空でなければ `refs/heads/<ブランチ>` と同じときだけ送る。空なら `%(push)` が `refs/remotes/<pushRemote>/<ブランチ>` と同じで、pushRemote が `git remote` の一覧にあるときだけ送る。これで simple で上流が別名（`git switch -c feat origin/main`。`%(push)` が空）・upstream で上流が別名・nothing は断られ（「上流が別名です。PC で push してください」など）、current・matching・同名の上流の simple・current の三角のワークフローは通る。simple の三角のワークフロー（pushRemote だけ別）は git が上流と比べて push 先を決められない（`%(push)` が空）ので断る側に倒れる。一時リポジトリで本物の git を使うテスト（`test/node/paradisMobilePushPlanGit.test.ts`）で固定した。`%(push:…)` を知らない古い git では「git 2.22 以降が要ります」を返す。送るときは `push --porcelain <remote> HEAD:refs/heads/<ブランチ>` と名指しする（`push.default=matching` で他のブランチまで送らない）。上流が無ければ push する remote（無ければ origin、それも無ければ唯一の remote）へ同じ名前で `--set-upstream` して公開する。宛先の名前は `%(refname)` から `refs/heads/` を外して作る
- **失敗の文**: `common/paradisMobileScmSync.ts` の `paradisClassifyMobileSyncFailure`（rejected / diverged / auth / network / local-changes / hook / protected / timeout / no-upstream）。どの文も強制 push を案内しない。履歴が分かれているときのスマホの主ボタンは押せず「PC で解決してください」
- **コミットの立て直し**: `all` のときは `git add -A` の前に**インデックスのファイルそのもの**を git channel の `backupIndex` で控え（`rev-parse --git-path index` の相対パスをリポジトリのパスに繋いだ場所の隣に `index.paradis-mobile-<uuid>`。`--path-format=absolute` は git 2.31 以降なので使わない。WSL はディストロの中のパスに繋いでから UNC へ書き戻す）、コミットが失敗したら `restoreIndex` で戻す。戻すときは git と同じく `index.lock` を排他で作ってから差し替え、ほかの git がロックを持っていれば 100 ms ごとに 1.5 秒までやり直し、取れなければ戻さない（アプリに「ステージを戻せませんでした。PC で確かめてください」）。戻したファイルの時刻は控えたときの元の時刻にする。**割り切り**: 控えてから戻すまでの間（`git add -A` とコミットのフックが動く間）に PC でステージを変えると、戻したときにその変更は消える（ロックを持ち続けると git 自身が動けないため、その間は守らない）。ツリー（`write-tree` / `read-tree`）で戻す方式をやめたのは、sparse-checkout の skip-worktree・intent-to-add・split index などの印がツリーには載らず、`read-tree` の後に sparse の外のファイルが全部「削除」に見える事故が起きるため（レビューの M6。index の mtime を比べる案は、lint-staged など多くのフックがインデックスを書き換えるので、ほとんど戻せなくなる）。控えは成功したら消し、10 分より古いもの（落ちたプロセスが残したディスク上のものも）は次の控えのときに捨てる。控える口を持たない古い REH では、`all` のコミットを断る（ステージ済みだけのコミットはできる）。コミットの前に `rev-parse --verify --quiet HEAD` を控える。終了コード 1 で何も出さなければまだコミットが無いとみなし、それ以外の失敗・時間切れならコミットを始めない。失敗として返っても HEAD が動いていて、`log -1 --format=%B` が送ったメッセージ（`--cleanup=whitespace` と同じ整形で比べる）と同じなら、戻さずに成功として `warning` を付けて返す（post-commit フックの途中の時間切れなど）。HEAD が動いたのに自分のコミットと確かめられなければ（同じ時に PC でもコミットした、HEAD を読めない）、戻さずに失敗として返し「ステージを戻せませんでした」を出す（控えは消さずに残し、10 分後に片付ける）。出力は `paradisRedactMobileCommandOutput`（`common/paradisMobileOutputRedaction.ts`）で伏せ字にしてから、先頭 35% と末尾で 12,000 字に切る。伏せ字の本体は通知の本文と同じ `paradisRedactSecrets`（`notificationInbox/common`）で、そこへ複数行の PEM の秘密鍵と URL に埋め込まれた資格情報を足した。要約は Orca と同じく出力の言葉で推す（lint → フック → 最初の行。名前・メール未設定・空のコミット・競合は「直してもらうものではない」）
- **依頼の送り先**: W2-28 のメモの送信から `electron-browser/paradisMobileAgentPromptDelivery.ts` に切り出し、3つの依頼（メモ・コミットの失敗・CI の失敗）が同じ道を通る。`auto` はそのスペースで入力を待っているエージェント（`paradisReviewNotesTargetVerdict` が `ready`、つまり `paradisCanPasteMultiline` が通る）へ貼り付け、エージェントのターミナルはあるがどれも受け取れないときは送らずに `busy` を返す（アプリは「新しいエージェントで」を出す）。エージェントのターミナルが無ければ既定のエージェントを起動する。既定は設定 `paradis.workspaceSwitch.defaultAgent`、空・`none`・一覧に無いなら一覧の先頭（新しいスペースのダイアログの「前回選んだもの」は別の部品の保存なので読まない）。依頼文は PC が控えた失敗の記録・取り直した PR から組み立て、改行以外の制御文字を落とす。フックの出力・PR の題名・ログは「データとして読む」旨の囲みに入れる（中の ``` は置き換える）
- **失敗の記録**: `commitSafe` が失敗するたびにスペースごとに1件だけ持つ（レンダラーのメモリ。成功したら消す。ウィンドウを閉じれば消える）。`commitFix` は id が違えば断る。コミットできたら登録表の `context.refreshBranches()`（provider の `refreshBranches` につながる）でブランチ名を読み直す
- **伏せ字**: 登録表の処理が投げた例外の文も `paradisRedactMobileCommandOutput` を通してから返す（git の出力に remote の URL の資格情報が混ざりうる）。Azure の接続文字列の `AccountKey=` / `SharedAccessKey=` / SAS の `sig=` と Slack の Incoming Webhook の URL も伏せる
- **スマホの待ち時間**: PC 側の待ち時間の合計より長くした（commitSafe 310 秒、push / fetch / pull 200 秒、CI の直しの依頼 200 秒、マージ 130 秒、prView 60 秒）
- **PR の取得**: git channel に `getPullRequestDetail` / `getFailedJobLogs` / `mergePullRequest` を足した（SSH 先の REH にも同じチャネルがある。古い REH は `Method not found` になり、その旨を返す）。PR は `gh pr view --json …statusCheckRollup` の1回で取る（`gh pr checks --json` は使わない。古い gh でも動き、呼び出しが1回で済む）。チェックの区分は CheckRun の status / conclusion と StatusContext の state から作る。画面に出すのは 200 件までだが、区分ごとの数（`checkCounts`）は切る前の全件で数え、マージの判断はそれを使う。100 件以上届いたら gh が途中で切った可能性があるとみなし（`checksIncomplete`）、スマホからはマージさせない（レビューの M5）。Actions のジョブは詳細 URL（`/actions/runs/<run>/job/<job>`）からジョブの id とリポジトリを読み、**PR と同じリポジトリ（ホスト・owner/repo）のものだけ**ログを取る（第三者の App が詳細の URL に別のホストを書いても gh を向けさせない。レビューの M3）。`gh run view --job <id> --log-failed -R <repo>` の末尾 200 行・12,000 字を node 側で切ってから返す。スマホは PR の区分を開いて前面にある間だけ 60 秒ごとに `prView` を送る（PC の 5 分ごとの `getPrStatus` とは別）
- **CI の直しの依頼文**: 並べるチェックは 20 件まで（残りは「ほか n 件」）、全体は 40,000 字まで（ログの末尾を均等に詰める）。チェックの名前と URL も「データとして読む」囲みに入れる（`common/paradisMobileAgentPrompts.ts`。レビューの M4）
- **マージ**: PC が PR を取り直し、番号とスマホが見た head が同じで、`paradisPullRequestMergeBlock`（アプリと同じ関数）が止めないときだけ `gh pr merge <n> -R <repo> --<方式> --match-head-commit <sha>`。方式は `gh repo view --json viewerDefaultMergeMethod,…Allowed` の既定、読めなければ squash → merge → rebase の許されているもの。`--admin` と `--delete-branch` は使わない。止める理由は 下書き・開いていない・競合・CI の失敗と取り消し・実行中・全件か分からない・変更の要求・レビュー待ち・`BLOCKED`
- **アプリ**: ソース管理（`src/features/code/sourceControlPanel.tsx`）の区分に「プルリクエスト」（`pr.view.v1` のときだけ）を足した。iPad の詳細の列とセッションの右のドックは同じ部品なので、幅の分岐は持たない。主ボタンの判定は `scmSync.ts` の `scmPrimaryAction`（変更あり → コミット、無し → 取り込み・プッシュ・公開、分かれていれば押せない）。ファイルごとにステージできる PC では、ステージ済みがあればそれだけをコミットする（`commitScope`）。一部だけステージしたファイル（`MM`）もステージ済みに数えるので、それしか無いときもインデックスの分だけをコミットし、`git add -A` で残りまで入れない。post-commit の失敗・時間切れの警告はトーストの1行ではなく、コミットバーの上に全文を出す。PR のマージの確認シートは、対象を `ConfirmTarget` に持つ（`ConfirmDrawer` は `onClose` の後に `onConfirm` を呼ぶので、対象を閉じるときに消すと要求が届かない。シミュレータ確認で見つかった）。差分レビューの見出しの＋は、確認済みで変わっていないファイルなら `reviewStage`（印をステージ後へ付け替える）を使い、そうでなければ `stage` を使う。**アプリが直接 import する `paradisMobileScmSync.ts` と `paradisMobilePullRequest.ts` は import を持たない**（Metro の `.js` → `.ts` の読み替えは `metro.config.js` の `isOwnCode` の範囲からの import にしか効かないので、共通のファイルから別のファイルを import するとアプリで解決できない。PC だけが使う依頼文は `paradisMobileAgentPrompts.ts` に分けた）
- **同時の操作**: 同じスペースの git の操作（push / fetch / pull / commitSafe / stage / unstage）は1本ずつ、エージェントへの依頼も1本ずつ、PR のマージと直しの依頼も1本ずつ（`ParadisMobileSendGate`）。重なった側は `busy` で断る
- 【要確認】SSH 鍵にパスフレーズがあり ssh-agent に載っていない、2FA のプロンプトが要る、などの構成では push / fetch が認証の失敗として返る（PC のターミナルで一度通してもらう想定）。実機では確かめていない
- 【要確認】gh の `statusCheckRollup` が何件で切るかは確かめていない（GraphQL の `contexts(first: 100)` 相当と推測）。100 件以上のチェックがある PR はスマホからマージできない
- 【要確認】`gh pr merge` がマージキューや自動マージの設定のあるリポジトリでどう振る舞うかは確かめていない（キューに入るだけでも「マージしました」と出る可能性がある）
- 【要確認】差分レビューで確認済みにしたファイルを `unstage` すると識別が変わり「確認後に変更あり」になる（印の付け替えは `reviewStage` だけが行う）

## Codexペインapp-serverのWindows対応（loopback ws方式、2026-07-21）

macOS/Linuxの「ペインごとのCodex app-server」（`resources/paradis/bin/codex`のshランチャー + `unix://`ソケット）はWindowsでは使えないため、Windowsだけ別トランスポートで同等機能を実装した。判断根拠はすべてWindows 10.0.26100 / codex-cli 0.144.6 実機での事前調査に基づく。

- **`unix://`を使わない理由**: codex（Rust）自体はWindowsのAF_UNIXで待ち受けできるが、接続側のPara Code shared process（Node/libuv）がWindowsのAF_UNIX接続を未サポートのため、モバイル連携が成立しない。よってWindowsは `--listen ws://127.0.0.1:0`（動的ポート）一本
- **認証**: loopbackでも `--ws-auth capability-token` は有効（実測）。capability tokenには**ペイントークン（`PARA_CODE_TERMINAL_PANE_ID`）をそのまま流用**し、app-serverには `--ws-token-sha256 <hex>` でダイジェストだけを渡す（平文トークンはディスクへ書かない。ポートを記載するendpointファイルに秘密は含まれない）。接続は `Authorization: Bearer <ペイントークン>`。トークン無しはWebSocket upgrade時に401
- **構成**: ランチャーは `codex.cmd`（cmd用）/`codex.ps1`（PowerShell用）の薄い入口 + `paradisCodexPaneLauncher.cjs`（本体）。JSの実行体は**PATH上の`node.exe`を最優先**し、無い場合のみ `PARA_CODE_CODEX_LAUNCHER_NODE`（Para Code自身のexe）+`ELECTRON_RUN_AS_NODE=1` へフォールバックする。**Para Code exeを常用してはならない（2026-07-22実機で発覚）**: WindowsのElectronはGUIサブシステムのため、シェルが待たずに即復帰し、コンソールが継承されず対話TUIが `stdin is not a terminal` で死ぬ。npmでcodexを入れた環境にはnode.exeが必ずあるので、実運用ではフォールバックにほぼ落ちない。`.cmd`は`call`を使わずexeを直接呼ぶ（`call ... %*`は埋め込み引用符・`&`で引数が壊れることを実測済み）。実ポートは `userData\pcx\<token>.endpoint.json` に書き、shared process（`paradisCodexLiveClient`）がそれを読んで `ws://127.0.0.1:<port>` へBearer付きで直接続する
- **実Codexの解決**: PATHからランチャー自身のディレクトリを除外した上で、`codex.exe`直接 → npmインストールのvendored `codex.exe`を探索 → `node_modules/@openai/codex/bin/codex.js`を自Nodeで実行 → 拡張子なし`codex`（非Windowsのdev/test用）の順。**vendored exeをcodex.jsより優先するのは必須**: codex.jsは`process.arch`でネイティブパッケージを選ぶため、自Node（Para Code exe）とnpmのNodeのアーキが異なる環境（例: Windows ARM上でarm64 Para Code + x64 Node）では「Missing optional dependency @openai/codex-win32-arm64」で即死する（2026-07-21実機で発生）。x64のvendored exeはARM64 Windowsのエミュレーションでそのまま動く
- **黒窓の罠（2026-07-22実機で発覚）**: app-serverを`detached`/`windowsHide`でコンソール無し起動すると、app-serverがspawnする各MCPサーバー（コンソールアプリ）が自前のコンソールを確保して黒いウィンドウが乱立する。app-serverはターミナルのコンソールを共有して起動すること（タブを閉じたときの自動道連れという利点もある。TUIがraw modeの間はCtrl+CがコンソールイベントにならないためCtrl+C巻き添えは実用上問題にならない）
- **後始末**: TUI終了時にランチャーが所有するapp-serverをkill（Windowsは`taskkill /T /F`）。Windows Terminalのタブ閉じはNodeがSIGHUP（CTRL_CLOSE_EVENT）として受けるためそこでも掃除する。それでも残った孤児は「pidが死んでいるendpointファイルの起動時sweep」と「同一ペインの次回起動時のowner死亡検出→採用(adopt)→終了時掃除」で回収する
- **梱包**: `build/gulpfile.vscode.ts` で win32 のみ `.cmd`/`.ps1`/`.js` の3点を、非win32はshランチャーのみを同梱（PARA-PATCH済）

## Codex の共有バックグラウンドサーバーに相乗りさせない（`--no-daemon`、2026-09-30）

素の `codex` の対話起動は、同じ `CODEX_HOME` で共有のバックグラウンドサーバー（daemon、`CODEX_HOME/app-server-control/app-server-control.sock`）が動いていればそこへ相乗りする。0.157 からは無ければ起動もする（`features.daemon_auto_start` が stable・既定 true）。相乗りすると hook と MCP は daemon の中で動き、daemon を起動したターミナルの env（`PARA_CODE_TERMINAL_PANE_ID` など）で para-browser と通知が全ペイン同じ値になる。daemon は起動元が閉じても PID 1 の下に残り、古い値を持ち続ける（Codex の `app-server-daemon/README.md` も「per-client environment isolation is not provided」と書いている）。hook の親は daemon になるので、祖先チェーンによる所有者判定（`paradisAgentHookOwnership.ts`）も効かない。

- 2026-09-30 の実測（一時 `CODEX_HOME`、偽の MCP と hook で届いた値を記録）: 0.155.1・0.156.1・0.159.2 のいずれも、既に動いている daemon へ既定のまま相乗りした。`-c features.daemon_auto_start=false` は新しく起動しないだけで、0.156 以降は許可された `-c` なので動いている daemon へ相乗りする（#165 の対処はここが漏れていた）。`--no-daemon`（0.156.0 から）は動いている daemon があっても使わない。0.155 以前は `--no-daemon` を知らず起動しないが、`-c` を 1 つでも付けると相乗りしない。`codex exec` は daemon を使わない
- ランチャー（`resources/paradis/bin/codex`、Windows は `paradisCodexPaneLauncher.cjs`）は、`--remote` を付けない対話起動（引数なし・プロンプト・`resume`・`fork`、ペイン app-server が起動できず素の Codex へ落ちる場合も含む）に `--no-daemon` を付ける。付けられるかは `codex --no-daemon --version` の終了コードで Codex に聞き（0 なら可。ネイティブで約 10ms、npm の Node ラッパー越しで約 40ms）、不可なら `-c features.daemon_auto_start=false` を付ける。`--no-daemon` と `--remote` の併用・2 回指定は Codex が拒むので、ユーザーが `--no-daemon` を書いたときはそのまま渡す。`codex agents`（共有サーバーの一覧。`--no-daemon` を拒む）は委譲一覧に入れた
- ペイン app-server が off のときも、ランチャーだけを PATH に入れる（ソケット・endpoint は入れない）。SSH の接続先には同じ `codex` を `~/.para-code/bin` へ置く（`paradisRemoteAgentHooks.contribution.ts` の `installCodexLauncher`、中身が変われば置き換える）
- Windows は、ペイン app-server が off（既定）のときランチャーを PATH に入れない（#165 までと同じ）。#167 で一度入れたが、リリース前のレビュー（2026-09-30）で、既定の設定の全員が `.ps1` / `.cmd` / `.cjs` の経路を通ることになり、以前は動いた `codex` が起動しなくなる経路が見つかったため戻した: 実行ポリシーが `Restricted` の PowerShell 5.1 では `codex` がランチャーの `codex.ps1` に解決されて読めずに止まる（`codex.cmd` へは落ちない）、`node.exe` があっても `resolveRealCodex` は `codex.exe` と npm 版しか探さず pnpm や自作の `codex.cmd` だと 127 になる、`node.exe` が無い経路では `for /f` / `$x = & exe` が UTF-8 の出力を OEM コードページで読み日本語を含むパスが化ける（推測）、パスに `)` や `&` があると `for /f` の行が壊れる（推測）。`node.exe` が無い経路はそもそも daemon を避けられない。そのため Windows のペイン app-server off では、Codex 0.157 以降の相乗りの問題が残る
- `.cjs` / `.cmd` / `.ps1` の `--no-daemon` 対応と resolve モードはペイン app-server on のときだけ通る（`PARA_CODE_CODEX_LAUNCHER_NODE` が渡るのはその場合だけ）
- 【要確認：Windows 実機】上の失敗経路（実行ポリシー、pnpm などの入れ方、日本語・`)` を含むパス）を確かめ、手当てしてから Windows のペイン app-server off でもランチャーを入れる
- `codex queue`（0.158 で追加、`--no-daemon` を拒む）・`migrate-rollouts`・`tcp-tunnel` は委譲一覧に入れた（3 か所、一致はテストが検査する）。ペイン app-server off の経路はサブコマンドを Codex に問い合わせずに `--no-daemon` を付けるので、今後 daemon 必須のサブコマンドが増えたら一覧に足す

### 接続と通知（Orca W2 の L5: W2-25 / W2-22 / W2-34 / W2-27 / W2-35、2026-09-29）

デプロイは**リレー → PC → アプリ**の順。リレーのデプロイが要るのは W2-35 だけで、W2-25 と W2-22 はアプリだけ、W2-34 と W2-27 は PC とアプリ（リレーは変えていない）。どれも足すだけの変更で、版（3）は上げていない。

| 組み合わせ | W2-34（裏で30秒保つ） | W2-27（次のプッシュで消す） | W2-35（取り消しの送り直し・失効） |
|---|---|---|---|
| 旧アプリ × 新PC | 旧アプリは `visibility` を送らないので今までどおり即座に閉じる | 旧 NSE は `dismiss` を読まない（何も消えない） | PC の送り直しは効く。失効を有効にした後は、旧アプリ（W2-04 より前）は理由の分からない再接続を続ける |
| 新アプリ × 旧PC | PC が `conn.background-grace.v1` を広告しないので送らず、即座に閉じる | PC が `dismiss` を載せないので何も消えない | 旧PCは一度きりの取り消しのまま |
| 新アプリ × 新PC × 旧リレー | 効く（リレーは素通し） | 効く（暗号文の中なのでリレーに関係ない） | PC の送り直しは効く（旧リレーも `mobile/revoke` は同じ）。`lastSeenAt` と失効は無い |
| 新アプリ × 新PC × 新リレー | 効く | 効く | 効く。失効は `MOBILE_CREDENTIAL_TTL_DAYS` を入れるまで無効 |

- **W2-25 前回の一覧**: `app/mobile/src/lastKnownPcs.ts`（純関数）と `lastKnownPcStore.ts`（ファイル）。State を受けたとき、完全な State（`complete`・`sessionProtocolReady`・版が合う）だけからスペース名と件数・状態を作り、outbox と同じ通知鍵（`deriveNotifyKey`）でから HKDF で導いた用途別の鍵（info `para.last-known-pc.v1`）で封緘して `documentDirectory/last-known-pc.v1.<pcId>` へ書く（1.5秒まとめ、同じ中身は1分に1回まで）。封緘の中に `purpose` と `pcId` を入れ、別の PC・別の用途のファイルは開けない扱いにする。題名は残さない（Q118 A）。`PcSummary.lastKnown` は表示専用で、件数・`totalAttention`・起動の ＋ の判定には使わない。ホームの PC のカードと PC の画面（`features/pc/lastKnownPcList.tsx`、押せない一覧）に出し、画面は AuthGate の内側にしか無いので Face ID の前には描かれない（読み込み自体は `init` で行う）。解除した PC のファイルは消す
- **W2-22 接続の記録**: `RelayClient` の `onConnectionEvent` → `MobileController.onConnectionEvent` → `connectionLog`（`connectionLog.ts` / `connectionLogStore.ts`）。PC ごとに 200 件、`documentDirectory/connection-log.v1.<pcId>`、500ms まとめて書き、裏に回るときに書き出す。OS のエラー文は URL・スキームの無いホスト名・20文字以上の英数字（22文字の mobileId を含む）・16進・IP・メールを伏せる。診断の問い合わせ先から `user:pass@` は外す。回線の変化（W2-05）と W2-34 の保持の出来事も残す。診断（`connectionDiagnostics.ts`）は PC の数・インターネット（`expo-network` の `isInternetReachable`。外部サイトへは問い合わせない）・リレー（ルートへの GET。**リレーに `/health` は無く 404 が返る**ので、HTTP の応答があれば「届いた」、5xx は注意）・PC がオンラインか・版。報告はクリップボードへのコピーだけで、PC の名前・リレーの URL・識別子を入れない。画面は `/settings/connection-log`（設定の「PC」の下）
- **W2-34 裏で30秒保つ**: アプリは裏に回ったとき、PC が `conn.background-grace.v1` を広告していれば notify チャネルに `{ t: 'visibility', state: 'background', id }` を送り、`{ t: 'visibility-ack' }` を 2 秒待つ（`backgroundGrace.ts`）。確認が来た PC だけ `RelayClient.holdInBackground()` で保ち、それ以外は今までどおり `suspend`。**保っている間は張り直さない**: 切れた・張り直そうとした（PC の再起動、生存確認、回線の変化）ときは suspend と同じ状態に落とす（新しい接続は PC から前面のアプリに見え、裏の通知がプッシュにならないため）。PC は `MobileSession.backgrounded` を立て、`paradisResolveNotifyDelivery` の `appBackgrounded` で受信が新しくても信用しない（プッシュ＋フレームは `quiet: 'pushed'`）。アプリは裏ではバナーを出さない（`notificationPolicy.ts` のまま）。前面に戻ったら `{ t: 'visibility', state: 'foreground' }` を送り、PC は取り置きを鳴らさない形で流し直す。期限は時刻で持ち、裏でタイマーが止まって過ぎていたら閉じてから張り直す。**iOS は裏のアプリを数秒で止めるので、アプリの30秒のタイマーは当てにしない**: PC は `background` を受けた時点でブラウザミラーを止め（アプリは前面に戻ったら `useAppInFront` で張り直す）、40秒のうちに `foreground` が来なければ presence offline と同じ後始末（`dropMobileSession`: セッション・ブラウザミラー・チャットの購読・WebRTC・音声）をする（`common/paradisMobileBackgroundGrace.ts`）。裏に回る直前の約1往復の間に、信用してプッシュしなかった通知（直前3秒）は、`background` を受けたときにそのスマホへプッシュし直す（アプリの一覧は ID で重複を弾く。前面の最後の瞬間にバナーを出していた場合はバナーが2回出うる）。音声通知で接続を保っている間はこの仕組みを通さない。コーデックは `app/protocol/src/notify.ts` と PC の `common/paradisMobileVisibility.ts`（逐語、`app/protocol/test/visibilitySync.test.ts` が突き合わせる）
- **W2-27 次のプッシュで消す**: PC は出した通知と片付いた通知を `common/paradisNotifyDismissLedger.ts` に覚える（200 件）。片付いたとみなすのは次の3つ。**許可・質問（`agent-question`）は、ID を指定した操作でだけ消す**。
  - スマホがその通知を1件指定して開いた・消した（新しいアプリの `dismiss` は `opened: true` を付ける）: 許可・質問も含む
  - スマホが一覧を「すべて消去」した（`opened` なし）: 完了などだけ。アプリは「すべて消去」で許可・質問の `dismiss` を PC へ送らない（ほかの端末では未回答のまま残す）。旧アプリの `dismiss` は `opened` が無いので、許可・質問は消えない側に倒れる
  - PC がそのエージェントのペインを確認済みにした・ターミナルが終わった（`onDidAcknowledgePane`）: 確認より前に出した、許可・質問以外の通知だけ
- **W2-27 の続き**: 次のプッシュの暗号文に `dismiss`（片付いてから24時間以内、新しい順に10件）を載せる。値は通知 ID を通知鍵から用途別に作った鍵で HMAC にした16進32桁（`paradisMobileDismissTags`。鍵が全バイト 1 のとき `n1` → `f6bbbd12fc1fd39b8cddf0d5c0f1f5df`、Swift の CryptoKit でも同じ値になることを確認済み）。載せると上限（3800B）を超えるときは載せない（本文を削ってまで載せない）。NSE は復号に使えた鍵で通知センターの `notifyId`（プッシュは userInfo の最上位、ローカル通知は `userInfo["body"]`）から同じ値を作って消す。サイレントプッシュ・`expo-task-manager` は使っていない（Q119 A）
- **W2-35 取り消しの送り直しと失効**: PC は「デバイスの管理」で外したスマホの取り消しを、台帳から外すのと同じ書き込みで `pendingRelayRevokes`（`common/paradisRelayRevokeOutbox.ts`、最大64件）に積み、リレーへつながったときと、30秒〜10分の揺らぎ付きの間隔で送り直す。済んだとみなすのは 2xx と、リレー自身の 404（本文 `not found`）だけ（**以前は 401 や 5xx も成功扱いだった**。途中のプロキシの 404 は送り直す）。400 などの 4xx は捨て、登録し直した（deviceId が変わった）後の古い分も捨てる。リレーは `mobiles.lastSeenAt` を記録する（列を足したときに既存の行へ今の時刻を入れる。モバイルの接続・つながっている間のメッセージ・TURN の発行で、メモリで間引いて1時間に1回まで書く）。失効は環境変数 `MOBILE_CREDENTIAL_TTL_DAYS`（下限7日）を入れたときだけ、モバイルが1台以上ある DO で alarm により1日1回行い（無効なら PC の接続時にも alarm を張らない。張れなくても PC の接続は止めない）、行を消して 4404 で閉じ、PC がつながっていれば `mobile-revoked`、いなければ `pc_notices` に積んで次に PC がつながったときに送る。**既定は無効**。W2-04 を載せたアプリが行き渡ってから 90 を入れる。資格の定期的な入れ替えは入れていない（Q127 A）
- **ネイティブの反映**: `app/mobile/native/NotifyExtension/NotificationService.swift` を `app/mobile/ios/NotifyExtension/` へ写して再ビルドする（W2-27）。新しいネイティブ依存・pod は無い。prebuild は不要
- **リレーのデプロイ（未実施）**: W2-35 の分はデプロイが要る。`app/relay` で `CLOUDFLARE_ACCOUNT_ID=<アカウントID> npx wrangler deploy`（`wrangler.jsonc` は account_id を持たない）。DO のスキーマは列とテーブルを足すだけで、`migrations` の追加は要らない
- **残した課題**: スマホ側で解除したときのリレーへの取り消しの送り直し（設計の手順2）と、PC がリレーの一覧と突き合わせる `GET /device/:id/mobiles`（手順4）は入れていない。失効を有効にした後に PC がつながっていなかった分は `pc_notices` で補うが、PC は `mobile-revoked` に確認を返さないので、**送った時点で消している**（届く前に PC のソケットが切れると取りこぼし、PC の台帳に失効済みのスマホが残る。残っても接続・プッシュは失敗するだけ）。PC が確認を返す仕組みは次の段

### 通知の作り直し（`notify.content.v1`、2026-10-04）

設計とモックは `mobile-notification-mock.html`。通知の本文に中身を入れ、長押しで全文と操作を出し、失敗を完了と分けた。**リレーは変えていない**（中身は暗号文の中）ので、デプロイの順序の縛りは無い。版（3）も上げていない。

- **中身を決めるのは PC の通知の出口 1 か所**（`node/paradisMobileRelayService.ts` の `dispatchNotifyNow` → `composeNotifyVariants`）。完了と承認待ちは renderer の状態遷移から、質問は shared process の transcript から来るが、どちらもここを通る。中身の出どころは `node/paradisNotifyContentSource.ts`: hook（Stop の `last_assistant_message`、StopFailure の `error` / `error_details`、PermissionRequest の `tool_input`）を第一に、無ければ tailer（`ParadisMobileAgentChat.notifyPaneContent`。最後の発言・Codex の `task_complete` の失敗と `codex_error_info`・待っている承認や質問）。hook は renderer を往復する状態遷移より先に shared process に届く前提【要確認: 実機で順序】
- **文言は `common/paradisNotifyCompose.ts` だけ**（利用者の回答で変わりうるため）。本文は「完了: 」「承認待ち: 」「質問: 」「エラー: エージェントがエラーで止まりました（コード）」＋中身（Markdown を外し、`paradisRedactMobileCommandOutput` で伏せ、装飾を外した平文でもう一度伏せる）。`detail` に Markdown の原文（伏せ字済み、6000 字まで。`**`・バッククォート・表に包まれて伏せ字の形に当たらない秘密は、その行を装飾を外した伏せ字の形に置き換える）。「通知に内容を含める」（アプリの設定、notify の `prefs` の `includeContent`。既定オンは新しいアプリの設定の既定値で、アプリが `true` を同期する）がオフのスマホと、この項目を同期してこない旧アプリ（Q175 A）には、従来の定型文で `detail` なし、副題からタブ名も外す（Q177 A）。エラーの理由のコードはオフでも出す
- **失敗は `agent-error`**。ペインの状態は従来どおり review（`paradisAgentBrowser.ts` の StopFailure の扱いは変えていない）で、通知だけが出口で種類を変える。PC フォーカス中の抑制と種類のスイッチは効かない（`paradisNotifyDelivery.ts` の既存の扱い）
- **副題は受け手が組み立てる**。PC は `agent` と `tab`（エージェントの印を外したタブ名）を別に送り、受け手は PC 2 台以上なら「エージェント · タブ名 · PC 名」、1 台ならタブ名だけ（#11 は「省く」）。旧い受け手のために `subtitle` に「エージェント · タブ名」も入れる。同じ規則がアプリ（`app/mobile/src/notifyPresentation.ts` の `notifyPayloadSubtitle`）と通知拡張（`NotificationService.swift` の `composeSubtitle`）にある
- **プッシュの 3800B**: `paradisFitNotifyBytesForPush`。片付けの印（W2-27 の `dismiss`）は捨てず、本文と `detail` を削る。長押しの画面を描けるアプリ（`prefs` に `includeContent` が入っている＝この版以降。プッシュの時点ではセッションが無く capability を引けないため、こう見分ける）には本文を 160 字まで削ってから `detail` を削り、`detail` が 200 字を切るなら捨てて本文を戻す。古いアプリには `detail` を載せず本文だけを削る
- **ボタン**: カテゴリ `para.done`（返信・開く）/ `para.error`（返信・開く）/ `para.approval`（許可・拒否・開く）/ `para.question`（開く）。アプリが起動時に登録する（`app/mobile/src/notificationActions.ts`）。許可・拒否・返信は `opensAppToForeground` と `isAuthenticationRequired`。押されたらアプリは遷移と同じ先を開き、`notificationActionRunner.ts` が送る。送るのは、預けた後にアプリのロック（AuthGate）の解除があってから（再認証の猶予の間なら Face ID をやり直させる。`appLockState.ts` の `requestAppReauthentication`）、その PC が見えて会話を受け取り直したとき。預けてから 60 秒、届いてから 30 分（Q179 A）を過ぎたら送らない。どの承認かの ID が無い承認はボタンの無い `para.approval.open` にする。承認は通知の `interactionId` と今の承認が同じときだけ答え、違う・分からないときは送らずに知らせる。返信が送れなかったら会話の入力欄に残す

#### 通知拡張と長押しの画面

- **送り主のアイコン**: Q176 B で Claude / Codex のマークを使う。Claude のマークも Codex と同じ黒い地（`#1f2328`）に白
- **通知拡張**: `category` から `categoryIdentifier` を付け、`category`・`agent`・`detail`・`interactionId` を userInfo の最上位に書く（復号できなければ剥がし、カテゴリも空にする）。送り主のエージェントを `INSendMessageIntent`（スペース名を会話名、`[me, sender]` の宛先、送り主のアイコンは同梱の PNG）にして `content.updating(from:)` で出す。【要確認】群の会話としての見え方（タイトルにスペース名が残るか、副題が残るか）と、審査
- **長押しの画面**（Notification Content Extension、ターゲット `ParaCodeNotifyContent`、Bundle ID `ltd.paradis.paracode.mobile.ParaCodeNotifyContent`）: `detail` を Markdown で描き、下に「開く」（`performNotificationDefaultAction`）。プッシュは最上位、ローカル通知は `userInfo["body"]` から読む（プッシュの `body` はリレーが書けるので読まない）。App Group・Keychain は使わない。ソースと復元手順は `app/mobile/native/ParaCodeNotifyContent/`
- **ネイティブの反映**: `ios/` は手で編集済み（このメモの「コメントを書けないファイルへの変更一覧」の 2026-10-04 の行）。新しい pod は無いので `pod install` は不要の見込み。Xcode で Signing を開き、Communication Notifications の capability がアプリの App ID に付くこと、`ParaCodeNotifyContent` が自動署名で作られることを確かめる
- **残る制約**: アプリが出すローカル通知（前面・裏で繋がっている間）は通知拡張を通らないので、送り主のアイコンと `threadIdentifier` が付かない（expo が渡せない）。質問の選択肢は通知ごとに違うので通知からは答えない（開くだけ）。Codex の usage limit などの失敗は hook が無く、tailer が rollout を読めているとき（スマホがペアリング済みなら常時）だけ理由が付く

## モバイルアプリの配信手順（2026-08-06整備、アーカイブ前に必ず読む）

`app/mobile/ios/` は `app/.gitignore` で**まるごと無視されている**（Expo prebuild の成果物という扱いのため）。したがって **`app.json` の `version` を上げても、実際にアーカイブされるバイナリのバージョンは変わらない**。`npx expo prebuild` は禁止（手動追加の `NotifyExtension` と `ParaCodeWidgets` が消える）なので、`ios/` 側は手で合わせる。

アーカイブ前に上げる箇所（この5つが揃っていないと、拡張と本体の版が食い違って App Store Connect に弾かれる）:

1. `app/mobile/app.json` の `expo.version`
2. `app/mobile/src/changelog.ts` の `MOBILE_CHANGELOG` 先頭に同じ版の節を作る（`src/changelog.test.ts` が1と2の一致を検査する）
3. `app/mobile/ios/ParaCodeMobile.xcodeproj/project.pbxproj` の `MARKETING_VERSION`（8箇所）と `CURRENT_PROJECT_VERSION`（8箇所）。本体・NotifyExtension・ParaCodeWidgets・ParaCodeNotifyContent（2026-10-04 追加）の Debug / Release
4. `app/mobile/ios/ParaCodeMobile/Info.plist` の `CFBundleShortVersionString` と `CFBundleVersion`（**値がハードコードされている**）
5. `app/mobile/ios/NotifyExtension/Info.plist` の同2つ（同じくハードコード）

`ios/ParaCodeWidgets/Info.plist` と `ios/ParaCodeNotifyContent/Info.plist` は `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` を参照しているので3を直せば追従する。**4と5だけ取り残しやすい**（2026-08-06 の 0.5.0 で実際に踏みかけた）。

アーカイブと検証:

```sh
cd app/mobile/ios
xcodebuild archive -workspace ParaCodeMobile.xcworkspace -scheme ParaCodeMobile \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/paracode-archive/ParaCodeMobile.xcarchive -allowProvisioningUpdates
```

生成後、本体と3つの拡張（NotifyExtension・ParaCodeWidgets・ParaCodeNotifyContent）の版が揃っているか必ず確認する（揃っていないまま提出すると弾かれる）:

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
- **`RNSVG-RNSVGFilters` の deployment target**: react-native-svg のリソースバンドル target が 12.4 のままで、Xcode 27（下限 15.0）ではエラーになる。`ios/Podfile` の `post_install` で、16.4 より古い Pods の target を 16.4 に揃えている（`ios/` は gitignore 対象なので、別の Mac では同じ追記が要る）。これが無いと Xcode の画面からのビルド・アーカイブが通らない（コマンドラインなら `xcodebuild ... IPHONEOS_DEPLOYMENT_TARGET=16.4` でも回避できる）
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
for f in native/ParaCodeWidgets/* native/NotifyExtension/* native/ParaCodeNotifyContent/*; do b=$(basename "$f"); [ "$b" = README.md ] && continue
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

### AES-GCM の復号・封緘をネイティブ（CryptoKit）へ移した（`modules/para-aes-gcm`、2026-10-02）

PC とのセッションのフレーム（`nonce(12) || 暗号文 || タグ(16)`）を、純 JS の `@noble/ciphers` ではなく CryptoKit で開く・封緘する。21MB の HTML の受信で、noble の開封に 2,575ms かかっていた（`mobile-file-load-analysis.html` の実測）。

| 場所 | 役割 |
|---|---|
| `app/protocol/src/crypto.ts` | `AesGcmBackend`（`open(key, sealed)` / `seal(key, nonce, plaintext)`）と `setAesGcmBackend` / `getAesGcmBackend` / `nobleAesGcm`。既定は noble。nonce の照合とカウンタは `DirectionalCipher` が持ち、復号・封緘が成功してから進める（差し替えても同じ）。noble 以外の実装の例外は常に素の `Error`（`aes/gcm (<名前>): <元の message>`）に包み直し、元の例外は `cause` に残す（Expo の同期 Function の例外は `Error.prototype` の `Error` に `code` を足した形で届くので、型では見分けない）。noble の例外は従来どおりそのまま |
| `app/mobile/modules/para-aes-gcm/` | 同期の `Function("open")` / `Function("seal")`（`AES.GCM.SealedBox(combined:)`）。引数の `Uint8Array` は JS のメモリをコピーせずに読み、戻り値は CryptoKit の `Data` をコピーせずに ArrayBuffer として返す。鍵は 32 バイト以外を弾く。iOS だけ（Android は `app/mobile/android/` が無いので未実装。JS は noble に落ちる） |
| `app/mobile/src/nativeAesGcm.ts`・`src/installNativeAesGcm.ts` | `index.ts` から起動時に 1 回だけ登録する。登録の前に固定の値で noble と突き合わせ（byteOffset が 0 でない view の封緘・開封を含む）、食い違えば noble に残して Sentry へ送る（`relay` / `nativeAesGcmSelfCheck`）。モジュールの無い古いバイナリでは noble のまま |
| `app/mobile/src/dev/aesGcmSelfTest.ts` | 開発ビルドの `globalThis.__paraDev.aesGcmSelfTest()`。GCM の試験値（Test Case 14）・長さ別（空の平文を含む）の noble との一致と byteOffset が 0 でない view での一致・改ざんの拒否と、21MB を 700KiB ずつ開く所要時間（`nativeOpenMs` / `nobleOpenMs`）を JSON で返す。`{ skipNoble: true }` で noble の計測を省く |

ファイルビューアの計測（`para.mobileFileViewer.fetch`）には `safe_aes_backend`（`native` / `noble`）を足した。`safe_open_ms` を実装ごとに比べられる。

**`pod install` が要る**: 新しいローカルの Expo モジュールなので、このブランチを取り込んだら各自の Mac で `cd app/mobile/ios && pod install` を 1 回実行する。`Podfile.lock` に `ParaAesGcm (1.0.0)`（依存は `ExpoModulesCore`、`:path: "../modules/para-aes-gcm/ios"`）が足される。`Podfile`・`Info.plist`・entitlements・`project.pbxproj` の手作業は無く、`native/` へ写すものも無い。CryptoKit は iOS 13 からの標準のフレームワークなので、リンクの設定も要らない。確認は次の 2 つ。

```sh
cd app/mobile/ios
grep -n "ParaAesGcm" Podfile.lock     # 4 行出る
RCT_METRO_PORT=8082 SENTRY_DISABLE_AUTO_UPLOAD=true xcodebuild -workspace ParaCodeMobile.xcworkspace -scheme ParaCodeMobile \
  -configuration Debug -destination 'generic/platform=iOS Simulator' IPHONEOS_DEPLOYMENT_TARGET=16.4 build
```

開発ビルドを起動したら、Metro の CDP から `__paraDev.aesGcmSelfTest()` を呼び、`ok: true` と `activeBackend: "native"` を確かめる。

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

**バージョンは全ターゲットで一致必須**（ずれるとApp Store Connectの検証で弾かれる）。今回0.3.0へ上げた際、本体だけ直すと NotifyExtension が 0.1.0 のまま残っていた。揃える箇所は `project.pbxproj` の `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 各8箇所（本体・NotifyExtension・ParaCodeWidgets・ParaCodeNotifyContent × Debug/Release。2026-10-04 に ParaCodeNotifyContent を足して 6→8）と、`ParaCodeMobile/Info.plist` ・ `NotifyExtension/Info.plist` の `CFBundleShortVersionString` / `CFBundleVersion`（`ParaCodeWidgets/Info.plist` と `ParaCodeNotifyContent/Info.plist` は `$(MARKETING_VERSION)` 参照なので自動追従）。

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
- **モバイル連携が無効でも動く**。中継サービスは shared process で常に生成され、セッションが確定したペインの status 用 tailer はモバイル接続と無関係に常駐している（`stopTailerIfUnsubscribed` 参照）。ただしモバイル向けの質問・承認の注入（`injectLiveQuestions` / `injectApprovalRequest`）はペアリング済みのモバイルがあるときしか動かない（フェーズ6 からはデスクトップのチャット表示のためにも入るが、`quiet` / `desktopOnly` の印付きで、ここの「待っている内容」には数えない。「デスクトップのチャット」の節を参照）ので、デスクトップの「待っている内容」はそれに頼らず hook（`PreToolUse` の AskUserQuestion と `PermissionRequest`）から別に覚えている（`recordDesktopInteraction`）
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

- **ツールの足し方**: `agentBrowser/common/paradisMcpToolProvider.ts` の `paradisRegisterMcpToolProvider(provider)` を shared process の登録（`ParadisSharedProcessContributions`）から呼ぶ。`callTool` の5番目の引数 `context` で、ウィンドウへの IPC（`callOwningWindow`、`timeoutMs` で延長可）、hook の状態（`getPaneAgentStatus` / `hasAgentHookHistory`）、接続元の確認（`classifyCaller`）を借りられる。`instructions()` は `initialize` の `instructions` に足される（ブラウザ共有の説明はサーバーが先頭に固定で置く）。mobileCanvas の既存のツールはまだ `registerToolProvider`（`sharedProcessMain.ts` 経由）のまま（B13 で足した端末の操作は登録口から足した）。移すには mobileCanvas の登録に要る引数を `sharedProcessMain.ts` から外す必要があり、今回は見送った
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

### 内蔵の音声入力の配布（配布しないと決定、2026-09-28、Q92）

upstream のディクテーションは Foundry Local のネイティブ部品（`Microsoft.AI.Foundry.Local.Core`。MIT ではなく Microsoft の FOUNDRY LOCAL CORE の条項）を、初回に `product.json` の `dictationRuntime.urlTemplate` から取ってくる前提になっている。Para Code はこの部品を組み込まず、URL も書かないと決めた（Q92）。`para-release.yml` にあった手動実行の入力 `dictation_runtime`、各ジョブの「Stamp dictation runtime URL」「Check dictation runtime on the CDN」の段、`DICTATION_RUNTIME_RESULTS_FILE` の env は取り除いた。upstream の `build/dictation-runtime/*` と `build/azure-pipelines/*` は触っていない（env が無ければ gulp は何もスタンプしない）。

残しているものは 2 つで、どちらも内蔵の部品が無くても役に立つ。

- `contrib/dictation/browser/paradisDictationAvailability.contribution.ts` は `dictation.enabled` の既定を false にする。upstream の既定 true のままだと、マイクのボタン・コマンド・キーが出て、押すと約 775MB のモデルを `user-data/chatDictationModels` に落とした後に `Foundry Local transcription stream stalled for 60000ms` で失敗する（2026-09-27 実機で確認）。settings.json で自分で true にした人は対象外。Agent Sessions ウィンドウはこの集約ファイルを読み込まないので既定 true のまま
- `notifications/electron-browser/paradisDictationAudioHold.contribution.ts` は音声入力の間の読み上げを止める。拡張機能や開発版の音声入力でも働く（下の段落）

音声入力の間は Para Code の読み上げを止める（`notifications/electron-browser/paradisDictationAudioHold.contribution.ts`、音声入力を配布していなくても拡張機能や開発版の音声入力で働く）。shared process の `AudioScheduler.setHeld` が、再生中の afplay 等を止め、通知音を捨て、新しい発話を溜めて終わってから読む。止めるのはどれか1つのウィンドウでも音声入力中のとき（接続ごとに持ち、接続が切れたら外す。ウィンドウは起動時に自分の状態を送り直し、音声入力中は状態が動くたびに送り直す）。上限はウィンドウごとに 10 分で、過ぎたウィンドウだけを外す（モデルの初回ダウンロード中や、upstream のセッション数が戻らなかったときに通知が鳴らなくなり続けないため）。**Agent Sessions ウィンドウの音声入力では止まらない。** この仕組みは通常ウィンドウの集約ファイルからしか読み込まれず、Sessions ウィンドウのチャット入力にマイクが出るかは【要確認】（出るなら Sessions 側からも読み込む）。**外部の aivis-mcp は止めていない。** 止める口（`aivis --mute`）がおやすみモードと共有で、解除のときにおやすみモードのミュートやユーザー自身のミュートまで解いてしまうため。

## タイトルバーの fork 部品は、タイトルバー自身の幅で段階的に畳む（titlebarFit、2026-09-28）

upstream の `.has-center > .titlebar-left` は `width: 20%` で内容より狭くなれる。fork はここへ CPU/RAM・リミット・サービス状態・ポートを足しているので、1400px 未満で中央のコマンドセンターの上に重なっていた（同じ z-index 2500）。`src/vs/paradis/contrib/titlebarFit/browser/` の小さな制御と CSS で直した（Electron の API は使わないので browser 層に置き、`test/browser/paradisTitlebarFit.test.ts` で段の凍結・メニューバーの判定・後始末を検査している）。呼び出しは `electron-browser/parts/titlebar/titlebarPart.ts` の既存の PARA-PATCH 点（`createContentArea`）に1行で、逆方向 import の許可は `eslint.config.js` にある。

- 左側は、fork の部品があってカスタムメニューバーが見えていないときだけ `min-width: min-content` にし、部品は縮めない（`flex-shrink: 0`）。重なりは起きず、中央が縮む
- 段はタイトルバー自身の幅（`rootContainer.clientWidth`）を `ResizeObserver` で測り、`paradis-fit-1400/1200/1000` をタイトルバーに付ける。1400px 以下で「エージェント一覧」「ブラウザ一覧」をアイコンだけに、1200px 以下で CPU/RAM の数値を隠し、1000px 以下で正常・不明のサービス状態を隠す。ポート一覧は他に入口が無いので畳まない
- ウィンドウのメディアクエリを使わない理由: ズームアウト（倍率 < 1）ではタイトルバーが `counter-zoom` で等倍に戻して描かれ、ウィンドウの CSS px とずれる。実機で確かめた値（zoom -2、ウィンドウ 900 DIP）: `innerWidth` 1296、タイトルバーの `clientWidth` と `getBoundingClientRect().width` はどちらも 900（タイトルバー自身の座標）。ズームイン（倍率 > 1）ではタイトルバーも拡大されるので CSS px のまま一致する
- `container-type` による container query は使わない。タイトルバーにレイアウトの封じ込めが付き、メニューバーのドロップダウン（`position: fixed`）の基準と重なり順が変わるため
- メニューバーの判定は要素の有無ではなく実際の表示（`offsetWidth > 0`）で見る。`.menubar` は `window.menuBarVisibility` が `hidden` / `toggle` でも `.titlebar-left` に残る。付け替えは `MutationObserver` で追う
- 左側のパネル・ポップオーバーが開いている（部品に `active` が付いている）あいだは段を変えない。パネルは開いた時点のボタンの位置に置かれるので、段を変えるとボタンが隠れたり隣が畳まれてずれたりしてパネルだけが取り残される

**upstream 取り込み時に確認すること**: タイトルバーの before/after を 900 / 1100 / 1300 / 1500px で撮って見比べる（Dark Modern と Light Modern、ズーム 0 / -2 / +1）。重なりが無いこと、段ごとに畳まれる部品が上の通りであることを見る。upstream が `.has-center > .titlebar-left/right` の幅・`min-width`、`counter-zoom` の付け方、`titlebar-left` 直下の構成（`.menubar` の置き場所）を変えていたら、`paradisTitlebarFit.css` のセレクタと `paradisTitlebarFit.ts` の測り方を見直す。

【要確認】Windows / Linux のカスタムタイトルバーでメニューバーが見えているときは、左側を内容の幅に固定しないので、fork の部品は今までどおり左の枠からはみ出しうる（幅での畳みだけが効く）。Windows 実機が無く、この状態の見た目は確かめていない。`menuBarVisibility` が `hidden` / `toggle`（Alt で出す前）/ `compact` のときは macOS と同じ扱いになるはず（推測。CDP で偽の `.menubar` を足して、表示中はクラスが付き、`display: none` で外れることだけ確かめた）。

別件: `Sign In` が `Customize Layout` に 8px 重なるのは upstream の `titlebarpart.css`（macOS の `.action-toolbar-container { position: relative; right: 8px }`）が原因で、fork の CSS ではない。右の枠が内容ぎりぎりまで縮んだときだけ出る。

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

エディタエリアのターミナルタブを `⌘⇧J`（Windows / Linux は `Ctrl+Shift+J`）で同じ会話のチャット表示に切り替える（C1、Q29〜Q32 すべて案A）。upstream のファイルは1行も触っていない。コードは `src/vs/paradis/contrib/agentChat/` にまとめ、モバイル中継とは次の表のところでつながる。

| 部品 | 場所 | 中身 |
|---|---|---|
| 会話の型と transcript の正規化 | `agentChat/common/paradisAgentChat.ts`・`paradisAgentTranscriptParser.ts`・`paradisAgentQuestionMarker.ts` | `paradisMobileAgentChat.ts` から切り出した（中身は変えていない）。中継は再公開しているので、既存のテストの import はそのまま |
| デスクトップ向けの読み取り口 | `ParadisMobileAgentChat` の `watchDesktopChat` / `getDesktopChat` / `claimDesktopInteraction` ほか | 中継のチャネル `PARADIS_MOBILE_RELAY_CHANNEL` に `IParadisAgentChatSource` として載る。モバイルへは何も送らない |
| TUI への打鍵（いつ・どう流すか） | `agentChat/browser/paradisAgentTuiInput.ts` | モバイルの renderer 側（`paradisMobileWorkspaceProvider.ts`）から切り出した。モバイルは `strict: false`（目印が無くても流す）、デスクトップは `strict: true` |
| キー列（何を流すか） | `mobileRelay/common/paradisAgentQuestionKeys.ts`（`paradisAgentApprovalKeySequence` を含む） | 持ち主は mobileRelay のまま。モバイルアプリの写しとの突き合わせテスト（`app/mobile/src/agentQuestionKeysParity.test.ts`）がこのパスを直接 import しているので動かしていない |
| 送る前の判断 | `agentChat/browser/paradisAgentChatInput.ts` | デスクトップの送信・回答の本体。ITerminalInstance を細い形（`IParadisAgentChatTerminal`）で受け、テストで差し替える |

- **会話はモバイルと同じ tailer から引く**（Q29）。画面は差分（epoch + rev）で取り、中継は「チャット表示中のペインの指紋が変わった」ときだけトークンを知らせる（80ms でまとめる）。取りこぼしに備えて、表示中のチャットは 5 秒ごとに取り直す。tailer が持つのは直近 400 件だけなので、それより前は「省略しています」と出してターミナルへ案内する
- **ウィンドウは自分の全ペイン（チャットを開いていないものも含む）を 10 秒ごとに `watchAgentChat` で送り直す**（中継の期限は 30 秒）。開く前に出た質問もカードにできるよう、全ペインで AskUserQuestion と許可要求を hook から tailer へ入れる（Claude Code は質問を回答されるまで transcript に書かないため、入れないとカードを出せない）。**モバイル向けの注入が動いていない（リレー無効かペアリング無し）ときに入れたものは、以前の振る舞いを変えない印を付ける**。質問はモバイルへの通知を出さず（`injectLiveQuestions(..., quiet)`）、質問も承認もペインの状態（質問中・許可待ちの表示）とスペース一覧の「待っている内容」に数えない（`desktopOnlyQuestionIds` / `desktopOnlyApprovalId`）。モバイルが購読を始めるか注入が有効になったら印を外す（`promoteDesktopOnly`）
- **「待っている内容」は agentInsights（hook から覚えた `desktopInteractions`）とチャット（tailer の `pendingQuestions` / `pendingApproval`）の2か所にある**。agentInsights は1行の要約だけを要し、モバイル未接続でも以前から hook だけで動いていた。チャットは選択肢と回答の突き合わせに tailer の状態が要る。1つにまとめるのは P3 の前に行う（出どころを tailer に寄せ、hook からの記憶は補助にする）。それまでは上の印で、片方にしか無いものがもう片方の表示を変えないようにしている
- **Claude Code の `PermissionRequest` hook には tool_use_id が無い**（公式の hook リファレンスの「PermissionRequest input」に "like PreToolUse hooks, but without `tool_use_id`" とある。2026-09-27 に確認）。中継は `PreToolUse`（tool_use_id・tool_name・tool_input を持つ）を覚えておき、ツール名と入力（キー順に依らない JSON）が同じ未完了の呼び出しが1つだけなら、その id を承認に付ける（`trackToolUse`）。付いた承認は、その呼び出しの `PostToolUse` で解ける（以前からある tool_use_id での解除）。決まらない（同じ入力の呼び出しが2つ以上）ときは合成 id（`approval:`）のまま、その時点で未完了だった同名の呼び出しと、その後に始まった同名の呼び出しが全部終わったときだけ解く。1つも覚えていなければ解かず、以前どおりターン終了で消える
  - **モバイルで変わること**: 承認の id が合成 id から実際の tool_use_id になることがある（形式は同じ文字列）。承認が消えるのは「その承認のツールが終わった後」か「以前どおりターン終了」のどちらかで、画面に確認が出ている間に消えることはない（並列の同名ツールが先に終わっても消えない）
- **同じ内容の許可要求は、同じ内容の未完了の呼び出しの数まで別の承認として積む**（再確認 N-1）。同じファイルへの Read を2つ並列に呼ぶと、tool_use_id の無い同じ本文の `PermissionRequest` が回答の前に2回届く。以前は2回目を再送として捨て、2つ目がカードに出なかった。捨てるのは、同じ内容の要求がその数を超えたとき（同じ hook の再送）だけ
- **回答待ちの承認は列で持つ**（`approvalQueue`、実機確認 NG-3）。入力の違う許可が並ぶと、TUI は後から来たものを先に出し、答えると前のものを出す。以前は1枠で、後の許可が先の許可を上書きし、後の許可が解けると先の許可が中継から消えていた。表に出す（`currentInteraction`・モバイルへ送る `interaction`）のは列の最後の1件（答え終えたものは除く、下の N-1）で、それが解けたら次のものを出す。モバイルへ送る形式は変えていない（表の1件が選び直されるだけ）。ターン終了ではすべて外す
- **transcript に書かれた tool_result でも承認を解く**（実機確認 NG-5）。Claude Code 2.1.283 は許可をターミナルで拒否したとき、`PostToolUse`・`PostToolUseFailure`・`PermissionDenied`・`Stop` のどれも出さず、transcript に `is_error` の tool_result を書くだけ。結果が書かれた時点でそのツールの承認は決着しているので、実 id の承認はそこで外し、合成 id の承認の待ち合わせもそこで進める。モバイルでも、ターミナルで拒否した承認のバーがターン終了を待たずに消える。承認が1件も残らなくなったら生成中の様子も直す（再確認 N-2）: 結果が Claude Code の拒否の定型文（`The user doesn't want to proceed with this tool use…STOP what you are doing and wait for the user…`）ならエージェントは次の指示を待っているので、生成中の様子を消し、ペインの状態を状態なし（idle）へ移す（「作業中」「許可を待っています」、ステータスバーの「スリープ防止中（エージェント）」、タブの鈴、エージェント一覧の件数が消える。実機確認3 N-2）。確認待ち（review）には移さない（review は完了とみなされて完了の通知が鳴る）。合図は hook バスの `fireParadisAgentAwaitingUser` で、`ParadisAgentBrowserService` は許可待ちか作業中のペインだけを idle にする。モバイルが繋がっていない構成（デスクトップ専用の承認はペインの状態に数えない）でも、この合図だけで解ける。それ以外なら、許可を待つ前の様子へ戻す
- **Codex の承認を拒否した後も idle へ移す**（実機確認3 N-2）。codex-cli 0.155.1 は拒否（Esc）でターンを中断し、rollout に `turn_aborted` を書く。承認が列に残ったまま（カードから答えた承認は「回答済み」で残っている）の中断は完了ではないので、承認を外してペインを idle へ移し、完了の合図（`fireParadisAgentTurnEnded`）は出さない。実機の rollout は `turn_aborted` の直前に、拒否したツールの結果（`function_call_output` の `aborted by user`）を書き、その結果で承認はもう列から外れている（実機確認4）。そこで Codex の `aborted by user` も Claude の定型文と同じく拒否として扱い、承認があるときの拒否をそのターンの間だけ覚えて（`stoppedOnApproval`）、続く `turn_aborted` を idle にする。結果と `turn_aborted` が別々の読み取りに分かれても同じ。承認の無い中断・完了・失敗は以前どおり完了の合図を出す
- **拒否で idle にしたペインは、タブの「作業が終わりました」（緑の点）を付けない**（実機確認4 記録1）。タブの印は `permission`・`working` からの状態の消滅を完了に数える（見ているスペースの完了はすぐ既読になって review を経ずに消えるため）。shared process は拒否で idle にした token をスナップショットの `awaitingUserTokens` で次に状態が付くまで知らせ、ストアの `wasStoppedForUser` を見て、その消滅だけを完了に数えない。承認して作業が進んでから終わる完了、既読による消滅は今までどおり点を付ける
- **答え終えた承認は「回答済み」として表に出さない**（実機確認3 N-1）。デスクトップのカードから送り終えたとき（`releaseAgentChatInteraction` の sent）と、モバイルから送り終えたとき（`finalizeAgentInteraction` の accepted）に印を付け、表に出すのは答えていないもののうち最後に積んだ1件にする。同じ内容の許可が2つ続いたとき、1つ目を許可すると2つ目がカードに出る（以前は答え済みの1件目が表に残り、2つ目が列の奥に隠れた）。回答済みの承認を列から外すのは、以前どおりツールの完了（`PostToolUse` か transcript の tool_result）かターン終了
  - **モバイルで変わること**: モバイルから承認に答えて打鍵が済むと、その承認は `interaction` から外れ、次の承認か null が送られる（以前はツールの完了まで同じ承認が残った）。ペインの状態も、答えた時点で許可待ちから作業中へ戻る。送る形式は変えていない
- Codex の承認の「拒否」のキーは版で違う（codex-cli 0.155.1 の実画面は `3. No, and tell Codex what to do differently (esc)` で Esc、それより前の版は `d`）。デスクトップは画面の選択肢の行の末尾の `(…)` から選ぶ（`paradisCodexApprovalDenyKey`）。モバイルは中継が `d` を送ってくるので、renderer（`paradisMobileWorkspaceProvider.ts`）が注入の直前に画面を見て差し替える（`d` の版はそのまま）。Claude の許可の「はい」は、デスクトップは `1` だけを送る（2.1.283 は `1` で確定し、後から送った Enter が次に出た同じ内容の許可を確定した、実機確認 NG-2）。モバイルは以前どおり `1` + Enter のまま（モバイルは画面を見ずに送るので、変えるならモバイル側の実測と合わせて行う）
- Codex の `<turn_aborted>`（中断の知らせ）は、ユーザーの発言として出さない（transcript の正規化で落とす。モバイルの表示からも消える）
- 重ねる先は共有ドットと同じ `paradisRegisterEditorTerminalOverlay`。チャットの間はコンテナに `paradis-agent-chat-active` を付けてターミナルの画面を `opacity: 0` にする（ウィンドウの透過で下の文字が透けないように）。`visibility: hidden` にすると xterm がフォーカスを受けられず、下のフォーカスの付け替えが働かない。z-index は 34（xterm と検索ウィジェットより上、共有ドットとキャッシュの残り時間の 35 より下）
- **チャットの上の mousedown / mouseup / contextmenu と、ファイルのドラッグは親へ流さない**。`TerminalEditor` はエディタ全体の mousedown でターミナルのクリック動作（右クリックの貼り付けなど）を行い、ターミナルはドロップされたファイルのパスを TUI へ入れるため。右クリックは自前のメニュー（入力欄の切り取り・コピー・貼り付け、選んだ本文のコピー）、ファイルのドロップはチャットの入力欄へパスを入れる。エディタのタブ・グループ（`LocalSelectionTransfer`）とターミナルのタブ（`Terminals`）のドラッグは止めない（エディタの分割・移動をそのまま使えるように）
- `TerminalEditor` はタブを選ぶとターミナルへフォーカスを戻す。チャットの間は `instance.onDidFocus` で入力欄へ移し直す（打った文字がシェルへ流れないように）。`⌘⇧J` は `DEFAULT_COMMANDS_TO_SKIP_SHELL` へ起動時に追記している（terminalFontZoom と同じ）。Windows / Linux ではエージェントのタブで `Ctrl+Shift+J` がシェルへ送られなくなる
- **送る前に確かめること**（`ParadisAgentChatInput`）: エージェントが前面にいる（前面のプロセス名がシェル（`zsh`・`bash`・`fish`・`pwsh` など）なら送らない。別名やラッパー（`cc`・`npx`・`env FOO=1 claude`）で起動していても通る。Codex には終了の hook が無いので、Codex の終了後に送らないのはこの判定だけが頼り。プロセス名が分からないときはシェル統合の入力待ちを見る。Claude は `SessionEnd` を受けていても送らない）、回答待ちでない、画面の下端に回答待ちの画面（`paradisScreenShowsAgentPrompt`）が出ていない、改行を含むなら貼り付けモードである。回答待ちの画面の判定は、見えている範囲の下から14行に限り、確認の文言（Claude Code の許可・ExitPlanMode の "Would you like to proceed?"・計画が空のときの "Exit plan mode?"、Codex の承認）の後ろに `1.` の選択肢の行が続き、その後ろに入力欄（横線の下の `❯ ` の行）が無いときだけ、または質問の画面（Claude の "Enter to select"、Codex の request_user_input の `Question 1/1` と `enter to submit answer`）が見えるときとする（エージェントの返答の本文に同じ文言や番号の例があるだけでは止めない）。文言は 2026-09-27 の実機確認（Claude Code 2.1.283・codex-cli 0.155.1）の実画面から取った。Codex の request_user_input は中継に回答待ちとして持たない（hook も app-server の回答口も無い）ので、会話に結果の無い `request_user_input` の呼び出しがあるときも送らない（`paradisPendingCodexQuestion`）。ここからは答えられないので、ターミナルで答えるよう案内する。文の制御文字はフェーズ5のプリセットと同じ `paradisBuildPresetInsertText` で落とす。モバイルの `action/sendMessage` には同じ確認を入れていない（モバイルの振る舞いを変えないため。入れるならモバイル側の確認と合わせて行う）
- **回答は、画面に目印が出たのを確かめてから打鍵する**。質問は、選択肢のラベル・質問文の一片・質問の操作説明が見えていて、許可の確認が出ていないこと（`Yes` のような短いラベルが許可の `1. Yes` に一致しないように）。作れない質問には答えない。承認は、許可の確認が出ていて、しかもその承認の中身（コマンドの一片、ファイル操作ならファイル名）が画面の下端に見えていること（別の承認を確定しないように）。5 秒待っても出なければ送らずに「ターミナルで答えてください」と返す。各キーの直前にも画面を見直し、承認は確認が閉じていたら残り（`1` の後の Enter）を送らずに終える（`1` が即確定でも、Enter が次の画面を確定しない）。質問は許可の確認が出てきたら止める。さらに「まだ同じものを待っているか」を中継から取り直し、変わっていたら残りを送らない。打鍵の前にはモバイルと同じ `interactionClaims` を取り（`claimAgentChatInteraction`）、1つでも打鍵したら 60 秒（質問の決着・ターン終了まで）同じものへは打ち直させない。承認を送り終えたら中継の承認に回答済みの印を付け（表に出さない）、同じ本文の再発火を新しい承認として受け付ける。この画面から答え終えた承認は、画面から確認の文言が消えていれば、中継が消すのを待たずに文を送れる（質問は対象にしない）。カードの状態はペインごとにコントローラが持つので、表示やタブを切り替えても消えない。Codex の app-server 経由の承認（`codex:`）はキーではなく `answerAgentChatApproval` で返す
- 会話の Markdown は外部の画像を読み込まない（`remoteImageIsAllowed: () => false`、画像の書き方は `paradisAgentChatImagesToLinks` でリンクに書き換える）。プロンプトインジェクションで `![](https://.../?d=<秘密>)` を出力させると、チャットを開いただけで送られるため
- 既知の制約: Claude の許可は「許可」「拒否」だけ（「以後は確認しない」はキー列を実測していないので出していない）。許可の「はい」は Claude Code 2.1.283 で `1` だけで確定すると実機で確かめた（デスクトップは `1` だけを送る。モバイルは以前どおり `1`+Enter）。ターミナルで答えた合成 id の承認は、そのツールが終わるまでカードが残り、入力欄も塞がる（押しても画面に確認が無ければ送らない）。チャット表示かどうかはウィンドウを再読み込みすると忘れる。SSH 接続先のペインではスラッシュコマンドの候補が出ない（手元の設定から作らないため）。P3（メッセージレール、計画、サブエージェント、タスク、Codex goal、区切り表示）は未実装
- 表示: 読み取りが始め直されたら（同じタブで別の会話が始まった等）前の会話の行を使い回さない（行の鍵は rev なので、epoch をまたぐと取り違えて2つの会話が混ざる）。分割やタブの切り替えで高さが変わっても、読んでいた位置に留まる。送れなかった理由は、会話の状態が変わったら消す。`⌘⇧J` のコンテキストキーはグループのスコープに加えてウィンドウ全体にも置く（カードのボタンが押せなくなってフォーカスが body に落ちても効くように）。同じ内容の質問のカードが2枚並んだら、回答も回答待ちも無い抜け殻の方を外す
- **Codex の rollout の先頭行（`session_meta`）は改行まで読む**（上限 1MB、超えたら諦める）。codex-cli 0.155.1 の先頭行は base_instructions を含んで 22,116 バイトあり、以前の 16KB では解析できず素性が `unknown` になって、同じタブで Claude の後に起動した Codex の会話へペインが乗り換えられなかった（モバイルにも効く）
- **transcript の許可 root は、字面と realpath 後の両方の綴りで比べる**。`CLAUDE_CONFIG_DIR` が symlink を含む（macOS の `/tmp` → `/private/tmp`）と、正しい transcript が「root の外」として拒まれていた。root の外へ抜ける symlink は、実体がどちらの綴りの root にも入らないので引き続き拒む（接続先の写し置き場の root と同じ方針）
- 読んでいた位置はペインごとに覚え、同じグループでタブを切り替えて戻ったら同じ位置から見せる（再確認 N-3）
- **連続するツールの呼び出し・考えた内容・答え終えた許可の確認は、1行の見出しに畳む**（2026-09-28、モバイルの `buildChatRows` に合わせた）。区切るのは本文（ユーザー・エージェント・別のエージェント）、質問のカード、回答待ちの許可のカード、答えを待っている Codex の `request_user_input`（`paradisPendingCodexQuestion`。`busy` は付け替えや再起動で false に戻るので、作業中の印には頼らない）、Web 検索（モバイルと同じく独立した行）。まとめ方は `paradisGroupAgentChatItems`（純関数）で、2件以上続いたときだけまとめる（1件なら今までどおりの行）。見出しはモバイルと同じ「件数× 名前の一覧」に、成功した変更で書き換えたファイルの名前（3件まで。それより多ければ2件と残りの件数、ホバーで全パス）と失敗の件数を足した。既定は閉じる。畳んでいても見出しの下に出すのは、作業中（`busy`）の今のターン（最後のユーザーの発言より後ろ）の結果の無いツールと、利用者が開いている行（読んでいる途中に次のツールが届いて行がまとまりに入っても消さない）。開いた状態はペインごとのカードの状態（`openGroups`、`<epoch>:g:<先頭の単位の鍵>`）に持つので、後ろにツールが足されても、タブを切り替えても開いたまま。答え終えた許可で前後のまとまりがつながったときは、どちらかを開いていれば開いたままにする。会話が始め直されたら前の epoch の鍵は捨てる
  - 差分: Edit / Write はまとまりの外に出さない（外へ出すと `Read → Edit → Read → Edit` がまとまらず、畳む意味が無くなる。モバイルも中に入れている）。まとまりの中の差分はまとまりを開いたときだけ見え、見出しに変えたファイルの名前を出す。差分を最初から見せる設定は、実機で使ってから決める
  - 見送り: 見出しは中身が増えるたびに作り直す（中の文字だけの書き換えにはしていない）。一覧の読み上げは見出しに `aria-live="off"` を付けて止めたので、作り直しても読み直されない。フォーカスは作り直した行へ移し直す
- 見送り: モバイルの `action/sendMessage` に画面の判定を入れるのは見送った（承認を列で持つようになり、並んだ許可がモバイルの `interaction` から消えなくなったため。入れるならモバイルの送信の流れの確認と合わせて行う）。同じタブで Claude を `/exit` した後に `codex` を起動すると、チャットが古い Claude の会話のままだった件は、上の rollout の先頭行の読み切りで直した（再確認で原因を特定）
- 2026-09-27 に本物の Claude Code 2.1.283 と codex-cli 0.155.1 をモックの API につないで実機確認した（`para-code-research/phase6-verify/report.md`）。そこで見つかった NG-1〜NG-12 を直した。実機での再確認はまだ

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

## 開発ビルドは Sentry へ送らない（2026-10-01、Q157）

ソースから起動した開発ビルド（`VSCODE_DEV`）とモバイルの開発ビルド（`__DEV__`）は、Sentry を初期化しません。手元の検証が `local` の雑音として積み上がり、2026-10-01 に 105 件を手で ignore したためです。

- PC: 判定は `sentry/common/paradisSentryConfiguration.ts` の `isParadisSentryDevelopmentBuild`（upstream の `isBuilt` と同じ `!!env['VSCODE_DEV']`）の 1 か所です。main（`paradisSentryMain.ts`）・renderer（`paradisSentryRenderer.ts`）・shared process（`paradisSentryUtility.ts`）がそれぞれ同じ判定で init を飛ばします。Sentry を初期化しているのはこの 3 か所だけで、pty host・拡張ホスト・ほかの utility process は持っていません。`reportParadisDiagnosticError`・`runInParadisSpan`・ヘルスビーコンは SDK が繋がっていなければ何もしません。main は init を飛ばすときに `onUnavailable` を呼び、Sentry が無かった頃の upstream のクラッシュレポーター（`--crash-reporter-directory` などの指定時だけ手元に保存、開発ビルドは送信しない）に戻します。
- CI（`CI` / `GITHUB_ACTIONS`）で `VSCODE_DEV` 無しのパッケージ版を動かすスモークテストは、今までどおり `local` で送ります（`paradisSentryEnvironment`）。
- モバイル: `app/mobile/src/sentryRuntime.ts` が `__DEV__` のとき `enabled: false`（JS のイベントとトランザクション）と `enableNative: false`（sentry-cocoa を起動しない。ネイティブのクラッシュと App Hang はこちら）を返します。ネイティブ側は JS の init からしか起動しない（`ios/` に `RNSentrySDK.start` は無い）ので、これで両方止まります。
- 開発ビルドで Sentry への送信を確かめたいときは、一時的に判定を外して起動します（コミットしない）。

## Sentry の既製の固まり検知（eventLoopBlockIntegration）は配布版で動かない（W2-33、2026-09-29）

main の固まりの検知は、`@sentry/electron/native` の `eventLoopBlockIntegration` を使う案（Q125 A）で始めたが、配布版では動かないことが分かり、fork 所有の自作の見張りに切り替えた（`healthBeacon/node/paradisMainHangWatchdog.ts`）。インストール済みの配布版（Electron 43.6.0、Node 24.20、`process.versions.modules` 148）を `ELECTRON_RUN_AS_NODE=1` で動かして確かめた理由は 2 つ。

1. **`@sentry/node-native-stacktrace` の Electron 用のビルドが無い。** Electron の上では `lib/index.js` が `../build/Release/stack-trace.node`（`@electron/rebuild` で作るもの）しか読まない。インストールスクリプト（`scripts/check-build.mjs`）は Node 用の同梱バイナリ（ABI 108〜147）が読めた時点でビルドを飛ばすので、`build/Release` は `node_modules` にも配布版（`node_modules.asar.unpacked`）にも無い。`import('@sentry/electron/native')` は main で例外になる
2. **見張りの worker が `@sentry/core` を解決できない。** `@sentry/node-native` は `new Worker(new URL('./event-loop-block-watchdog.js', import.meta.url))` で worker を起こす。そのファイルは `node_modules.asar` の中にあり、中で `@sentry/core` と `@sentry/node` を素の名前で import する。`bootstrap-esm.ts` の `registerHooks` による asar の解決は worker へ引き継がれない（main に同じフックを登録して worker を起こしても `ERR_MODULE_NOT_FOUND '@sentry/core'`）

使うには、Electron 向けに stacktrace をビルドして同梱し、見張りの worker を 1 ファイルに束ねる（`build/next/index.ts` への PARA-PATCH）必要がある。なお `@sentry/electron/native` の包みは `powerMonitor` の suspend / lock-screen で見張りを止める作りで、worker から送る事象には main の `beforeSend`（`paradisPrepareSentryEvent`）が効かない。

自作の見張りは worker を文字列から起こす（`eval: true`、Node の組み込みだけを使う）ので、上の 2 つを踏まない。main が 2 秒ごとに共有メモリへ時刻とヒープの大きさを書き、worker が 10 秒途切れたら `<userData>/paradis-main-hang.json` に印を書き、戻れば `main-hang` / `blocked` で報告して消す。戻らずに終了されたら次の起動の 60 秒後に `blocked-until-exit` で報告する。スタックは取れない。配布版だけで動かす（開発版はデバッガの停止を誤検知する）。スリープは `powerMonitor` の suspend / resume と、worker 自身の見回りの間隔（15 秒）の両方で除く。resume が来ないまま 1 分心拍が続いたら、取りこぼしとみなして数え直す。

## 2 画面のファイル転送は IFileService だけで流し、権限だけを専用のチャネルで読む（fileTransfer、2026-10-02、段階 1）

エディタのタブ 1 枚（`ParadisFileTransferEditor` / `ParadisFileTransferInput`、シリアライザーで左右の場所ごと復元）で、左にこのマシン（`file://`）、右にこのウィンドウの接続先（`vscode-remote://`）を並べる。見た目は案C（`dual-pane-transfer-mock.html`）で、表・選択・キーボード・ドラッグは `WorkbenchTable` に任せ、見出し・2 段の名前（名前の下に権限）・足元の件数・下の待ち行列だけを `src/vs/paradis/contrib/fileTransfer/` で描く。片側の画面は、表（`paradisFileTransferPaneTable.ts`）・操作（`paradisFileTransferPaneOperations.ts`）・ドラッグ＆ドロップ（`paradisFileTransferPaneDnd.ts`）に分けてある。狭い（760px 未満）と左右を上下に積み、待ち行列は見出しの 1 行に縮める。

### 転送は一時名に書いてプロバイダーの rename 1 回で置き換え、取り消しは実行が終わるまで待つ

`IFileService.copy` は進み具合も取り消しも受け取らないので、`common/paradisFileTransferQueue.ts` の `ParadisTransferQueue` が 1 ファイルずつ `browser/paradisFileTransferFileSystem.ts` の `copyFile` を呼ぶ。データを守るための約束は次のとおり（2026-10-02 の 2 回のレビューで決めた）。

- 書き込みは送り先と同じフォルダーの一時名 `.paratransfer-<実行の印>` に `writeFile` し、書き終えてから**プロバイダーの `rename(temp, target, { overwrite })` を 1 回だけ**呼んで置き換える。`IFileService.move` は「存在確認 → 送り先を `del` → `mkdirp` → `rename`」を別々の往復で行い原子的でないので使わない（disk のプロバイダーはファイル同士なら `fs.rename` 1 回で、接続先でも POSIX の rename）。一時名に元の名前は含めない（長い名前で 255 バイトの上限を超えないように）
- 一時ファイルへの書き込みで失敗・取り消しになったら、一時ファイルだけを消す。**rename に入った後の失敗では一時ファイルを消さない**（元が消えていても書き終えた方は残る）。待ち行列の行に一時ファイルの場所を出し、自動の片付けの控えからも外す
- 送り先がフォルダーかリンクなら置き換えない。種類の違う同名（ファイル ⇔ フォルダー、送り先がリンク）は「以後すべてに適用」の対象から外し、毎回「フォルダー（リンク）ごと置き換える」と分かる文言で確かめ、`removeForReplace`（手元はゴミ箱へ）で取り除いてから写す
- 置き換えると、送り先の権限・所有者・グループ・ACL・ハードリンクが新しいファイルのものに替わる。そこで:
  - 権限のチャネル（版 2 以上の `statFile`）で送り先の mode・所有者・リンク数を読み、rename の前に一時ファイルを同じ mode に `chmod` する（新しく作るときは送り元の mode に合わせる）。`chmod` できなければ置き換えない
  - その場で書くのは、次のどちらかが**確かなときだけ**: `statFile` が「所有者が違う」か「リンク数 2 以上」を実際に返した／権限のチャネルの版が 2 未満だと確かに分かった（`version` の呼び出しが `name: 'Unknown channel'` で返った。**権限のチャネルが無い・版 1 の古い REH**）。その場で書くのは upstream の `copy` と同じで原子的ではなく、途中で失敗すると送り先は書きかけになるので、待ち行列の行に「送り先を直接書き換えます（途中で失敗すると元に戻りません）」と出す。0600 の `.env` や `id_rsa` が 0644 になるのを避けるため、古い REH では置き換えを選ばない
  - 接続の詰まり・時間切れ・切断など一時的な失敗で送り先を読めないときは、その場で書かず、項目の失敗（再試行できる）にする。`version` の一時的な失敗は「版 0」として覚えない（`paradisIsUnknownChannelError` は名前で見分ける。メッセージの「timed out」だけでは見分けない）
  - 上書きの置き換えは、版 3 以上なら権限のチャネルの `rename`（相手のマシンの素の `fs.rename`。送り先がフォルダーなら `EISDIR` で失敗し、消す処理を挟まない）で行う。版 2 以下では provider の `rename`。上書きしない置き換えは、送り先の有無を確かめる provider の `rename`
  - `statFile` の `identity`（`dev:ino:size:mtime`）が送り元と送り先で一致したら、同じファイル（同じマシンへの SSH など）として転送を拒否する。古い REH では見分けられない
  - 一時ファイルを作れない場所（ファイルには書けるがフォルダーには書けない）も、その場で書く
  - ACL と拡張属性は読んでいないので、一時ファイル経由で置き換えると引き継がれない（mode と所有者が同じ場合だけ一時ファイルを使う）
- 書いている一時ファイルは APPLICATION の保存領域に控える（`paradis.fileTransfer.tempJournal`、`browser/paradisFileTransferTempJournal.ts`）。書いているウィンドウは 1 分ごとに時刻を更新し、5 分更新の無いもの・閉じるときに片付けきれなかった印（時刻 0）のものを、起動の 10 秒後と再接続のときに別のウィンドウが片付ける。スリープ明けは書いている側の心拍が遅れているだけのことがあるので、候補を選んだ後に心拍の間隔より長く（75 秒）待ってから控えを読み直し、その間に時刻が変わったものは消さない。一覧では `.paratransfer-*` を隠しファイルの設定に関わらず「書きかけ」の印付きで出し、「書きかけのファイルを削除」で消せる
- 取り消しは表示をすぐ「取り消し」にするが、実行（`IEntry.run`）が本当に終わるまで同時に流れる数（既定 2 本）に数える。再試行は前の実行が終わるのを待ってから始める。置き換えの途中で取り消しても、置き換えが済んでいれば「完了」と出す
- `overwrite: false` の項目は実行の直前にも送り先を確かめる。利用者の操作から流したもの（積んだとき・再試行のボタン）は聞き直し、その間は同時に流れる数に数えない。接続が戻ったときの自動の流し直しは、聞く相手がいないので衝突として失敗にする。「名前を変える」で選ぶ名前は、送り先にある名前と待ち行列の他の項目が作る予定の名前を避ける
- フォルダーの中のフォルダーを指すリンク・ソケット・FIFO・壊れたリンクと、読めないファイル・フォルダーは飛ばし、件数を行に出す（FIFO は読む前に除く）
- 積む前の確認は送り先のフォルダーを 1 回だけ読む。フォルダーの展開も 1 階層ごとに 1 回の一覧で大きさまで取る。確認と下調べの間は見出しに「準備中…」を出す
- 進み具合は、書く側が受け取った塊を次の塊を受け取ったとき（＝前の塊を書き終えたとき）に数える。待ち行列の表示は行を id ごとに使い回す
- 転送中にウィンドウを閉じる・再読み込みするときは `ILifecycleService.onBeforeShutdown` で確かめ、閉じるなら取り消して片付けを最大 3 秒待つ（衝突のダイアログを待っている項目は待たない）。時間切れなら控えに印を付け、次に開いたときに片付ける

接続先が同じマシン（`ssh localhost` など）でも、一時名に書いてから置き換えるので、同じファイルを送り元と送り先にしても中身は壊れない（同じ内容で置き換わるだけ）。その場で書く経路（所有者が違うなど）で送り元と送り先が同じファイルだと、書き込みで送り元を切り詰めてしまうので、`statFile` の `identity` が一致したら拒否する。権限のチャネルが無い・版 2 以下の古い REH では見分けられない。

### 権限は shared process と REH の `paradisFileModes` チャネル

`IStat.permissions` は 3 ビットしか無いので、`node/paradisFileModesService.ts` を手元の shared process（`paradis.sharedProcess.contribution.ts` から）と接続先の REH（`paradis.server.contribution.ts` から）の両方に登録する。どちらも既存の登録口（`ParadisSharedProcessContributions` / `ParadisServerContributions`）に乗るので、`sharedProcessMain.ts` と `serverServices.ts` には手を入れていない。

- `list` は 1 往復で名前・種類・サイズ・更新日時・`st_mode & 0o7777` を返す（lstat を 64 並列）。ソケット・FIFO は `kind: 'other'`
- `statFile`（版 2 から）は 1 ファイルの mode・所有者が自分か・リンク数・リンクかを返す。版 3 から同じファイルかを見分ける `identity` も返す。転送で送り先の権限を保つのに使う
- `rename`（版 3 から）は素の `fs.rename`。送り先がフォルダーなら `EISDIR` で失敗させる
- `chmod` はリンクには当てない（chmod はリンク先を変えるが、一覧はリンク自身の権限を出すため）。画面でもリンクの行では「権限の変更…」を選べない。「中身にも適用」は、フォルダーには選んだ値を当て、ファイルは元から実行権があったときだけ実行権を残し、setuid / setgid / sticky は付けない
- このチャネルが無い古い REH は `Unknown channel`（1 秒待つ）で分かるので覚えておき、権限の行とメニューを隠す。繋がり直したら（更新された REH かもしれないので）聞き直す

### 入口と upstream への PARA-PATCH

主の入口はアクティビティバーの左下（アカウントと設定の間）のボタン（`electron-browser/paradisFileTransferActivity.ts`、`CompositeBarActionViewItem` の派生）。upstream の `globalCompositeBar.ts` はこの欄を 2 つ決め打ちにしているので、機能に依存しない差し込み口 `src/vs/paradis/browser/paradisGlobalActivitySlot.ts`（base と platform だけを import）を置き、PARA-PATCH は次に限った。

| 場所 | 変更 |
|---|---|
| `src/vs/workbench/browser/parts/globalCompositeBar.ts` の import | 差し込み口の import 1 行 |
| 同 `actionViewItemProvider` の先頭 | 差し込み口が作った表示部品を返す（fork のボタンでなければ upstream の分岐へ進む） |
| 同 コンストラクタ（アカウントの後・歯車の前） | `paradisGlobalActivityActions(this._store)` を積む |
| 同 `toggleAccountsActivity` | 「ボタンの数が 2 か」を `hasAction(this.accountAction)` に置き換え（fork のボタンで数が変わるため） |
| `eslint.config.js` の `src/vs/workbench/~` | `vs/paradis/browser/paradisGlobalActivitySlot.js` の 1 ファイルだけ逆方向 import を許可 |

ボタンの登録はモジュールの読み込み時に行う（アクティビティバーが作られる前に `paradis.electron-browser.contribution.ts` が読まれる）。Web と Agent Sessions ウィンドウは登録しないので upstream のまま。補助の入口は、タイトルバーのボタン（`workbench.activityBar.location` が `default` 以外のときだけ。上・下・非表示では左下の欄ごと描かれない）、エクスプローラーのフォルダーの右クリック（手元のフォルダーは左、接続先のフォルダーは右に出す）、コマンドパレットの「ファイル転送を開く」。条件は `common/paradisFileTransferEntryPoints.ts` に置き、テストで評価している。⌥⌘T は macOS の「グループ内の他のエディターを閉じる」と重なるので、キーの割り当ては付けていない（代わりのキーは利用者の回答待ち）。

マーク（案3）は codicon の `files` に `arrow-swap` を重ねた形で、フォントの 1 文字では作れないため、`registerIcon('paradis-file-transfer', Codicon.files)` を既定にして、`media/paradisFileTransfer.css` の `::after` で `arrow-swap`（`\ebcb`）を背景色の縁取り付きで重ねる。重ねるのはアクティビティバー・タイトルバー・タブのラベルだけ（メニューなどでは `files` のまま）。

手元のウィンドウの右側は「接続していません」と `~/.ssh/config` のホストを出す（`paradisRemoteHostBrowser()` を借りる）。「接続して開く」は APPLICATION の保存領域に `paradis.fileTransfer.pendingOpen`（宛先と時刻）を書いてから `ssh-remote+<別名>` の新しいウィンドウを開き、繋がった側が起動後に読んで消し、3 分以内なら転送画面を開く。接続していないホストへの直接の読み書きは段階 2。

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

## 他のブラウザからのログイン取り込み（browserProfiles/loginImport、2026-09-27、フェーズ7 B4）

Chrome / Edge / Brave / Arc など Chromium 系ブラウザの Cookie を、選んだドメインだけ内蔵ブラウザの名前付きプロファイルへ取り込む（q.html Q65・Q66 の回答 A）。実装は既存の `src/vs/paradis/contrib/browserProfiles/` へ足した。新しい contrib ディレクトリも app.ts への追加 import も作らず、channel は既存の `paradisRegisterBrowserProfiles` から一緒に立てている。

### 層の役割

- `common/paradisBrowserLoginImport.ts` — renderer ⇔ main の契約と、プラットフォーム非依存の純粋関数（samesite の写し、`expires_utc` の変換、`__Host-`/`__Secure-` 接頭辞の規則、Google サインインホストの判定、`cookies.set` の url 生成）。鍵も復号値も通さない。
- `node/paradisChromiumCookies.ts` — 復号アルゴリズムと DB 読み取り。macOS の v10（PBKDF2 `saltysalt`・1003 回・SHA1 で AES-128 鍵を導出、AES-128-CBC、IV は空白 16、PKCS#7）。復号後の先頭 32 バイトのドメインハッシュは、DB の `meta.version` が 24 以上のときだけ `SHA-256(host_key)` 一致で剥がす。ブラウザのカタログ（パス・キーチェーン項目）、プロファイル列挙、DB の一時コピー（`mkdtemp` + 0600）もここ。テストはこの層を合成 DB＋既知鍵で叩く。
- `electron-main/paradisBrowserLoginImportMain.ts` — 鍵の取得（`/usr/bin/security find-generic-password -w`）と、取り込み先の Electron セッション（`session.fromPartition().cookies.set()`）への書き込み。鍵の取得口は `IParadisSafeStoragePasswordProvider` で差し替えられる。
- `electron-browser/paradisBrowserLoginImportDialog.ts` — ダイアログ（案A）。プロファイルのドロップダウン下部の「他のブラウザから取り込む…」から開く（`paradisBrowserProfileDropdown.ts` の footer に3行目を追加、`paradisBrowserProfilePill.ts` で配線）。取り込み先は利用者の名前付きプロファイルだけを出す（`createdByAgent` は除外）。

### 安全の決め事

- 鍵を読むのは取り込み実行のときだけ。ブラウザ・プロファイル・ドメインの列挙では読まない（キーチェーンの確認ダイアログを不用意に出さない）。
- キーチェーンへは書き込まない（読み取りのみ）。
- 鍵は `security` の stdout を Buffer で受け、導出鍵は取り込みの最後に、鍵の元にした（連結後の）パスワード Buffer は導出直後に `fill(0)` で潰す。ただし `execFile` が内部で保持する連結前の stdout チャンクは触れないので消せない。復号後の Cookie 値は JS 文字列になり GC まで残る（プロセス内・main のみ・外へは件数しか出さない）。復号値はログ・例外・モバイル・Sentry・エージェントへ一切出さない（失敗時もドメイン名と件数だけ）。
- 表示するドメインは、取り込める候補が 0 件のもの（Partitioned だけ・SameSite=None 非Secure だけ等）は一覧から外す。Cookie 名（`SID` 等）では除外しない（無関係なサイトの `SID` を落とさない）。件数には鍵が無くても分かる範囲（`v10` でない暗号化行を除外）を反映し、版 24 でハッシュ不一致の行だけは件数から外せず取り込み時の `skipped` に入る。取り込み先の照合はキーチェーンの応答を待った後、書き込みの直前にもう一度行う。
- 他ブラウザの Cookie DB はロック中でも読めるよう、`mkdtemp` で作った `userData/paracode-cookie-import-*/` の下へ `COPYFILE_EXCL` + 0600 でコピーして読み、終わったらディレクトリごと消す（WAL/journal は一緒に写すが、稼働中の共有メモリ索引 `-shm` は写さない）。コピーは自分専用なので `OPEN_READWRITE` で開き、hot journal を SQLite に復旧させる。途中失敗・クラッシュ対策として、コピー関数内で失敗時に自分で消し、登録時（起動時）に残骸 `paracode-cookie-import-*` を掃除する。
- Cookie の属性（secure/httpOnly/sameSite/期限/`__Host-`・`__Secure-` 接頭辞規則/`source_scheme` による https 判定）を正しく写し、期限切れ・SameSite=None かつ非 Secure・Partitioned（CHIPS、`top_frame_site_key` 非空。Electron の `cookies.set` でパーティション指定不可のため）は取り込まない。取り込み後に `cookies.flushStore()` で流す。
- ドメインハッシュ（平文先頭 32 バイト）を剥がすかは **DB の `meta.version`**（24 以上）で決める。推測（HMAC ヒューリスティック）は非 ASCII 値を壊すのでやめた。版 24 以上でハッシュが `SHA-256(host_key)` と一致しない値は Chromium 同様に捨てる。
- Google のログインは eTLD+1 単位（`google.<tld>`・`google.co.<cc>`・`google.com.<cc>`・`youtube.com`・`googlemail.com`・`blogger.com`・`youtubekids.com`・`googlesource.com`・`googleusercontent.com`・`gmail.com` とそのサブドメイン、`.google` TLD）で、ドメインごと除外する。Cookie 名（`SID` など）による判定はしない（Google のドメインはドメイン判定で全件除外済みなので名前の網は冗長で、無関係なサイトの `SID` を誤って落とすため）。UI ではドメインをグレーアウトして選べなくする。
- 取り込み先は名前付きプロファイルだけ。`profileId → partition` が唯一の経路なので global/workspace/ephemeral は原理的に選べない。さらに **main 側でも台帳（`paradis.browser.profiles`、APPLICATION スコープ）と照合**し、実在すること・`createdByAgent` でないことを確かめてから書く（renderer を信用しない）。`sourceDirectory` も列挙で返したディレクトリ名だけを受け、区切り文字・`..` を拒否する（パストラバーサル対策）。
- 起動はユーザー操作（プロファイルメニュー）だけ。MCP の面（`paradisBrowserProfileMcp`）には取り込みメソッドを一切足していない。Cookie の読み書きをエージェントへ許さない既存方針（Q69）は変えていない。

### macOS キーチェーンの「常に許可」の危険（M1、要対応候補）

鍵は `/usr/bin/security find-generic-password -w -s "<Browser> Safe Storage"` で読む。macOS の確認ダイアログは「security が機密情報を使おうとしています」と表示し、ログインパスワードを求める。ここで**「常に許可」を押すと、ACL に入るのは Para Code ではなく `/usr/bin/security`** になる。以後はターミナルで動くエージェントを含む任意のプロセスが、確認なしにそのブラウザの全 Cookie を復号できてしまう。読み方自体はネイティブ補助を作るのが大きすぎるため今回は変えず、ダイアログの案内で「表示は `security`／ログインパスワードを求められる／必ず『許可』（今回だけ）を押す／『常に許可』は他プログラム（エージェント含む）に鍵を開放する」ことを明記して回避する。恒久策の候補は、Para Code 本体のコード署名で `SecItemCopyMatching` を呼ぶネイティブ経路に替えること（そうすれば「常に許可」でも ACL に入るのは Para Code だけになる）。

### プラットフォームの対応範囲（判断）

- macOS を実装。Chrome / Edge / Brave / Arc / Vivaldi / Chromium を対象にした（`~/Library/Application Support/<rel>`、Safe Storage はキーチェーン）。
- Windows は今回は取り込まない。Chrome / Edge 140+ は app-bound encryption（v20）で writing browser 以外は復号できず（`Local State` の `os_crypt.app_bound_encrypted_key` で検知して理由を表示）、それ未満の DPAPI + v10 も DPAPI 復号にネイティブアドオンが要るため見送った。ダイアログは理由を表示する。
- Linux も今回は取り込まない（gnome-keyring / kwallet 依存のため後回し）。

### コメントを書けないファイルへの変更

無し（追加した依存は既に許可済みの `@vscode/sqlite3`・`electron`・Node 標準のみ。`eslint.config.js` の変更も不要だった）。

## 繋ぎ直せなかったターミナルの開始フォルダとパネルの空シェル（2026-09-28、lane terms）

調査は research の `triage-2026-09-28/space-terminal.md` と `panel-terminals.md`。

### PARA-PATCH 点（この回で増えた upstream の変更）

| ファイル | 変更 | 理由 |
|---|---|---|
| `src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts` | import 1 行と、attach 失敗の分岐（リモート・ローカルの2か所）に `paradisPrepareRestartedTerminalLaunch(...)` を1行ずつ | upstream は attach に失敗すると「その瞬間ウィンドウが開いているフォルダ」で新しいシェルを起こす。切り替え中は切り替え元のフォルダになり、その cwd が所属の証拠として nonce 台帳へ焼き付いていた |
| `src/vs/workbench/browser/parts/editor/editorPanes.ts` | `openEditor` の catch で、`EditorPanes` が破棄済みなら警告を1行ログに残して `{ error, cancelled: true }` を返す |
| `src/vs/workbench/browser/parts/editor/editorGroupView.ts` | 既存の PARA-PATCH（`doOpenEditor` 冒頭のフェンス判定）の条件に `|| this._store.isDisposed` を足しただけ（行は増やしていない） | Sentry 7T の別経路。`editorService.openEditor` は開く先のグループを決めた後にエディタの解決を await するので、その間に working set の適用がグループを破棄すると、破棄済みのグループの `openEditor` が呼ばれてタブ作成（`ResourceLabels.create`）で落ちる。破棄はこの await の内側で起きるので、端末エディタを開く fork 側の呼び出し元（upstream の `createTerminal` も含めて多数）からは見えず、グループの入口で止めるしかない | Sentry 7T。working set の適用でグループが破棄された後に、開きかけのエディタの失敗から ErrorPlaceholderEditor を破棄済みの InstantiationService で作ろうとしていた。`editorGroupView.ts` の既存フェンスは開き始めしか止めない |

### 設計の要点

- 口は `common/paradisTerminalLaunchPreparers.ts`（upstream のターミナルから import してよい fork の場所）。開始フォルダを決める関数は `browser/paradisTerminalSpaceCwd.contribution.ts`（BlockRestore）が登録し、所属は `ParadisTerminalWorkspaceScope` が自分で登録する問い合わせ口（`paradisRegisterRestartedShellScopeLookup`）から引く。**BlockRestore の contribution から所属サービスを DI で掴まないこと**。起動時の復元より前にインスタンス化させると、復元の索引（`paradisRegisterTerminalReviveIndexSource`）まで早まって挙動が変わる
- 所属を引く順: 復元コンテキスト → 出てきた working set → park 台帳 → nonce 台帳 → 今セッションの確定値（推測・借り物を除く）→ 固定した補助ウィンドウ。推測（今のスペース）は使わない。分からなければ upstream の既定
- **pid 台帳は引かない**。attach に失敗したばかりの ID は何世代も前の番号であり得て、前回たまたま同じ番号だった別のスペースの端末の所属を拾う。復元直後に pid 台帳から付いた今セッションの所属が、出てきた working set と食い違うときは working set の方へ直す（nonce 台帳だけ書き、pid 台帳は新しいシェルの ID が決まったときに書かれる）
- 食い違い確認のコマンドは表示中のターミナルだけを扱う。待避中の所属を書き換えても park 台帳と working set は元のスペースのままで実際には移らず、そのスペースを削除したときに別のスペースで表示中の端末を PTY ごと破棄しうる。扱うなら台帳キーの付け替えと working set から外す口が先に要る
- 再開前の `cd` は、終了 → 次のプロンプトの入力開始 → 250ms 待つ、の後で「途中に打たれた文字が無く入力欄が空」を確かめてから再開コマンドを送る（`paradisChangeDirectoryBeforeResume`）。終了だけ見て送ると、`cd` の最中に打った文字（tty バッファにあり、まだ入力欄に出ていない）とつながって Enter 無しで実行された（実機 2/2）
- 起動時に繋ぎ直しに失敗したタブに再開バナーが出なかった件は修正済み（2026-09-29）。原因は contribution の順番ではなく、attach に失敗すると upstream が新しいシェルを起こす時点で `attachPersistentProcess` を消すこと（`terminalProcessManager.ts` の attach 失敗の分岐）。AfterRestored で起動時からあるタブを見るバナー側は、消えた後の値を見て対象外にしていた。起こし直した記録（`paradisWasTerminalShellRestarted`）でも拾うようにした
- 【要確認】共通ターミナルへの移行の知らせの件数が、実際の本数より多く出る（`paradisTerminalScope.contribution.ts` の `rememberFormerSharedPanelScope` が同じ端末を複数回数えている可能性。既存の挙動、今回は未対応）
- 自動の `cd` は `paradisChangeDirectoryCommand` で作る。upstream の `preparePathForShell` は `C#`・`R&D` の文字を落とし、`'` で継続入力に入り、WSL で引用しないので使わない。シェルの種類が分からないときは送らない
- 起動直後（所属サービスが立ち上がる前）の attach 失敗は従来どおり。メインウィンドウのフォルダは起動時のスペースなので合っているが、別のスペースに固定した補助ウィンドウのタブは【要確認】のまま
- `terminal.integrated.cwd` を決めている人には手を出さない（相対パスも含む）
- 起こし直したシェルの所属は、cwd より「出てきた working set」「固定した補助ウィンドウ」を先に採る（`paradisWasTerminalShellRestarted`）。繋ぎ直せたシェルの cwd は従来どおり証拠になる
- 再開バナーの「このタブで再開」は、会話のフォルダと今のフォルダが違えば `cd` を送り、終了とフォルダの変化を確かめてから再開する。確かめられなければ再開しない（新しいタブで再開する案は、元のタブが空のシェルで残るので採らなかった）
- パネルの開閉（`restorePanelVisibilityFor`）は、通常の切り替え・ロールバック・中断した切り替えの復旧のどれでも、完了参加者（`applyScope`）の後に戻す。閉じる側は順番に関係なく何も作らない

## モバイルの添付画像のプレビュー（2026-10-04）

吹き出しと入力欄の札（案 C2・P2）、全画面ビューアの共有と「写真に保存」、PC の置き場を読む口（`fs.attachment.v1`、`paradisMobileAttachmentRequests.ts`）。

### ネイティブの反映（同じ作業の中で、この順に行う）

「写真に保存」は `expo-media-library` の pod と Info.plist の `NSPhotoLibraryAddUsageDescription` の両方が揃って初めて動く。pod だけ入れて Info.plist を忘れると、ボタンは出るのに押すとネイティブが例外を投げる（`saveToLibraryAsync` がキーの有無を確かめる）。片方だけを入れたバイナリを作らないよう、次を 1 回の作業で続けて行う。

1. `app/` で `pnpm install`（`expo-media-library` が入る）
2. `app/mobile/ios/ParaCodeMobile/Info.plist` に `NSPhotoLibraryAddUsageDescription` を足す（文言は `app.json` の `ios.infoPlist` と同じ「エージェントに送った画像を写真に保存するために使用します。」）
3. `cd app/mobile/ios && pod install`（`ExpoMediaLibrary` が `Podfile.lock` に足される）
4. Xcode で再ビルド（`npx expo prebuild` は使わない）

### 配信前の確認

- `grep NSPhotoLibraryAddUsageDescription ios/ParaCodeMobile/Info.plist`（`app/mobile` で実行。1 行出ること）
- `grep ExpoMediaLibrary ios/Podfile.lock`（pod が入っていること）

### 置き場所の判断

- 端末の控え（原寸）と、PC から取り寄せたサムネイルは、どちらも caches（`cacheDirectory`）に置く。サムネイルは「掃除しない・無期限に持つ」が決定だが、iCloud のバックアップに載せたくない。Library/Application Support に「バックアップの対象外」の属性を付けるのが本来の置き場所だが、expo-file-system（SDK 57）にも既存のネイティブモジュール（`modules/para-*`）にも属性を付ける口が無いため、caches にした。アプリは消さず、OS が消したら PC から取り直す（PC は置き場を掃除しない）
- Application Support へ移すなら、既存のモジュール（例 `para-ipad-input`）の Swift に `URLResourceValues.isExcludedFromBackup = true` を付ける関数を足す（ネイティブの再ビルドが要る）

## 読み上げを aivis-mcp の `--ingest` へ流す（2026-10-05、voice streaming PR 2）

通知の読み上げと SSH 先の声は、手元に aivis-mcp 2.5.0 以上があれば `aivis-mcp --ingest`（shared process の常駐の子、`src/vs/paradis/contrib/notifications/node/paradisAivisIngestClient.ts`）経由で worker の 1 列へ渡し、`queued` で手放す。取り決めの正は aivis-mcp の `docs/ingest-protocol.md`。設計は `voice-streaming-design.html`。

4 者レビューの 2 回目（2026-10-05、round2）で決めたこと:

- **`queued` が届く前に子が落ちた件は「積まれたかもしれない」**: `open` を子の標準入力へ渡した件は、次の子に withdraw を頼み、`removed: true` のときだけ Para Code が鳴らす。外せなかった・30 秒返事が無い件は worker が鳴らすとみなして鳴らさない（二重より鳴らし損ねを選ぶ）。`open` を書けないまま落ちた件だけ、すぐ Para Code が鳴らす。子の終わりは `close`（標準出力を読み切った後）で扱う（`paradisOnIngestChildDone`）
- **落ちた子・入れ替えた子の件は adopt で引き継ぐ**: 書き終えた件・鳴り始めた件は、新しい子へ `adopt` を送り、`adopted: true` なら追跡（`playing`・終わり）を続ける。`adopted: false`（`unknown: true` を含む）でも鳴らさず、続けて withdraw を送り、下の 4 種の答えで決める（痕跡の読み取りと worker の取り出しが行き違うことがあるため。2026-10-05 round2 の残り N-3）。書きかけの件（音声の続きは新しい子へ送れない）は withdraw で確かめる。新しい子が 2.5.0 なら adopt を送らず、鳴り始めた件・`queued` の件は追跡をやめて worker に任せる
- **withdraw の返事の 4 種**: `removed: true` と `notQueued: true` は Para Code が鳴らす。`taken: true` と理由の無い `removed: false`（確かめられなかった）は鳴らさない。終わりの知らせを受けた件には withdraw を送らない
- **版の入れ替えの間**（新しい子が名乗るまで）は新しい流れを開かず、`whenReady` で待たせる（待っている間は `mayPlayDirectly()` も false）。古い子は、書きかけの流れ（`end`・`abort` を渡していない）を書き終え、書き込みの列が空になってから標準入力を閉じる（上限 60 秒）。閉じた標準入力への書き込みは成功として扱わない
- **渡し直しの順番**: スケジューラは列に入れた順の番号を持ち、渡し直し・再試行・復旧待ちの件はその番号の位置へ戻す（high が先）。復旧を待っている件があれば後ろの件を渡さない。復旧待ちが一度 2 分の時間切れになったら、次に worker へ渡せるまで（または子が名乗るまで）待たずに Para Code が鳴らす。スケジューラが worker へ渡す件とみなす（`isHandoffAvailable`）のは、使える・起こしている・版を確かめている・新しい子へ入れ替えている（`isReplacing()`）間で、このとき着信音も声の前置きに回す（N-1）
- **Para Code が自分で鳴らす前に worker の再生 lock（`aivis-mcp:play-lock`）を読み**、持たれていれば空くまで待つ（上限 30 秒）。待つのはスケジューラの `runOne` で、再生の安全網（30 秒）の外（安全網は鳴らし始めてから数える。N-2）。Para Code が自分で鳴らす着信音は、lock が持たれていれば待たずに捨てる
- **worker が生きているかもしれない間は afplay に回さない**: `IParadisAivisIngest.mayPlayDirectly()` が false（`--ingest` を起こし直している・版を確かめている・新しい子へ入れ替えている）の間、ハンドオフは `defer` を返し、スケジューラは 1 秒ごとに渡し直す（最大 2 分。過ぎたら Para Code が鳴らす）。`--ingest` が落ちて取り下げられた件・最初の音を待ちきれなかった件・SSH 先の声の受け皿（`playFallback`）は、合成済みの音声を **worker へ渡し直す**（1 回まで）。afplay で鳴らすのは渡せないときだけ
- **最初の音を待ちきれなかった件（`first-audio-timeout`）は書いた量に関係なく鳴らし直す**（worker は声を鳴らしていない）。上の渡し直しの経路なので、worker の次の件とは重ならない
- **控えと転送の上限**: 鳴らし直し用の控えは `ParadisVoiceRetentionBudget`（合計 32MiB・16 本、`common/paradisVoiceRetention.ts`）の中でだけ持ち、声が鳴り始めたら捨てる（着信音を付けた件は終わりまで）。スケジューラは手放した後も合成を流している件を「転送中」として 4 本までにする（手放しの枠 3 本とは別）
- **標準入力が 20 秒進まない子は見限る**（`PARADIS_INGEST_WRITE_STALL_MS`）。落ちたものとして扱って SIGTERM、2 秒で SIGKILL。本文を読み終えた後の手元への書き込みも 30 秒で諦める（通知のハンドオフ・SSH 先の声の取込口の両方）
- **手放した後に合成が最初の音の前に切れた件**は、スケジューラへ `settled.retry` で知らせて再試行する
- **着信音**: 一時停止中・列があふれたときの着信音は、`--ingest` が使えれば `kind: 'sound'` で worker の列へ入れる（`aivis --mute` と hold が効く）。10MiB を超える着信音（aivis-mcp の前置きの上限）と、`accepted.preludeRejected` を返された着信音は Para Code が鳴らす。着信音だけのジョブが取り下げられたら、5 秒以内なら渡し直す
- **`aivis --mute` の間は Para Code が自分で鳴らす声と着信音も鳴らさない**（Redis の `aivis-mcp:muted` を 1 秒の控えで読む。設定画面の試し聞きは除く）。モバイルへは届ける（Q209 B）
- **引き受けた声の枠**: SSH 先の声の受け皿と鳴らし直しは、列の上限（20）の外の 8 本の枠に入れる（high の割り込みでも追い出さない）
- **hold の持ち主**は `para-code-voice-input-<shared process ごとの UUID>`
- **SSH 先の声の取込口**: `accepted` は MP3 らしさを確かめてから返す。Content-Length の旧方式は全部受け取り、長さと ticket の現行性を確かめてから手元へ渡す（受け取りの途中では鳴らさない）。締め切りまでに `queued` が来なければ中断ではなく withdraw を頼み、外せたときだけ「積めなかった」と返す。ticket の持ち主がいなくなったら受け取りを打ち切り、鳴らし直しもしない。音声取込の同時本数は 8（埋まっていたら 3 秒待つ）、ticket は 1 ペイン 32 枚
- **HTTP の 30 秒の守り**: 本文を読み終えないまま返す応答には `Connection: close` を付け、返し終えたら残りを 1 秒だけ読み捨ててから接続を閉じる。音声取込は実際に受理した時点で守りを外す。旧方式の手元への書き込みは、接続先の締め切りまでしか待たない
- **Para Code の終了中（`_serverDisposed`）に届いた音声取込（`/paradis-mcp/mobile-voice`）は 503**（`paradisSendVoiceIngressUnavailable`）。aivis-mcp 2.5.1 は手元で鳴らす ticket の 404 を ticket が通らなかったとみなして鳴らさないので、接続先で鳴らしてもらう。ほかの経路は 404 のまま
- **ticket が通らない音声取込は 401**（知らない・期限切れ・使用済み・今の instance のものでない・持ち主がいない、受け取りの途中で持ち主がいなくなった。`paradisSendVoiceTicketRejected`。ほかの経路の 404 は変えていない）。aivis-mcp 2.5.1 は 401・403 のとき手元で鳴らす前提の発話を接続先で鳴らさない（`ticket-unavailable`）。ほかの 4xx・5xx（容量の 429 など）は接続先で鳴らす
- **aivis-mcp 2.5.1 の取り決めに合わせた点**: `queued` の前に終わった件を Para Code が鳴らすのは `withdrawn: true` のときだけ（2.5.0 の子には今までどおり、`queued` の前の失敗＝積めていないとして鳴らす）。`withdrawn` の付かない `queued` 前の `failed` は、鳴らさずに withdraw で確かめ、`removed: true` のときだけ鳴らす。ticket の応答に `muteAware: true` を載せ、`X-Para-Muted: 1` の付いた声は引き受けて（`accepted`・本文 `localPlayback: true`）手元では鳴らさず、モバイルへだけ届ける。`queued` は遅れて届くことがあるので、ハンドオフは 15 秒待っても来なければ withdraw を頼み、`removed: true` のときだけ鳴らす（`PARADIS_HANDOFF_QUEUED_WAIT_MS`）。SSH 先の声の取込口は、引き受けないときに `X-Para-Local-Playback: rejected` を返し、`X-Para-Tagged: 1` を `--ingest` の `tagged` へ渡す。引き受けた後に鳴らせなくなったら本文で `localPlayback: false` を返す（2.5.1 の接続先は自分で鳴らす）。`accepted` は MP3 らしさを確かめてから返す（2.5.0 の接続先は本文を読まないため）

既知の挙動（直していない）:

- Aivis の `/v1/tts/synthesize` が全部まとめて返す（最初の 1 バイトが 10 秒より遅い）と、`first-audio-timeout` が続く。worker の `failed` が 3 回続くと 5 分間は全部 afplay で鳴らす（`PARADIS_INGEST_MAX_FAILED_STREAK`・`DEGRADED_RETRY_MS`）。遅い Aivis だけでこの状態に入りうる
- afplay の音量は 1.0 を上限にしている（頭打ちが無いので上げない）。上げる方向の補正は worker 経由のときだけ効く
- 標準入力への書き込みが止まって見限った子（`PARADIS_INGEST_WRITE_STALL_MS`）に渡した `open` は、子へ届いていなくても「積まれたかもしれない」件として次の子の withdraw・adopt の答えで決める。答えが来ない・確かめられない（理由の無い `removed: false`）ときは鳴らさないので、実際には積まれていなかった件が鳴らし損ねになる（round2 L-5。二重より鳴らし損ねを選ぶ方針のまま）
- モバイルアプリ: 音声通知が ON の間は、アプリを前面に戻すとほかのアプリの音楽が止まることがある（`ParaVoiceSessionModule.swift` が前面に戻ったときに `.playback`・`mixWithOthers` 無しで音声セッションを起こし直すため）。変更履歴には書かない

## モバイルの音声通知のストリーミングと mux の版 4（2026-10-05、voice streaming PR 3）

設計は `voice-streaming-design.html` の 3.5・3.6 N7（Q203 C・Q204 A・Q205 B）。PR 2（`--ingest`）の上に積んでいる。

- **mux の版 4**: 16KiB を超えるフレームは断片に切り、flags の bit2 と ws の後ろの `[送信ID:u32][何番目か:u32]` を付ける（bit3 が最後）。16KiB 以下は断片の見出しを付けず、版 3 と同じバイト列になる。受け手（`app/protocol/src/mux.ts` の `FrameAssembler`、PC の `ParadisMobileFrameAssembler`）は送信 ID ごとに組み立て直し、組み立て中の合計 32MiB・同時 32 本を上限にする。版 3 の `more`（チャネルごとの 700KiB の分割）は古い PC の State を読むために受け取りだけ残した
- **送信の列**（PC、`common/paradisMobileSendQueue.ts`）: 全端末で 1 本。断片ごとに優先度（音声 → 操作・状態 → 画面 JPEG）で選び、送る直前に 1 断片ずつ封緘する（nonce の順＝送る順）。同じ端末・同じ優先度の中は積んだ順で交互にしない（同じチャネルの順序を保つため）。端末の間は 1 断片ずつ回す。リレーへのソケットの `bufferedAmount` が 32KiB を超えている間は 5ms ごとに確かめて待つ。リレーへのソケットは shared process のグローバルの `WebSocket`（Node の undici 実装）で、Electron 43（Node 24.20.0）で 64KiB×200 を送って 5ms 後に 0 へ減ることを確かめた（2026-10-05）。それでも、閾値を超えたまま 2 秒値が変わらなければ値を信用せず 256KiB/秒 の時間ベースで送る（値が変われば信用し直す）。まだ 1 断片も封緘していない画面の JPEG は同じ端末の新しい JPEG で捨てる。**封緘中（nonce を採った後）の送信は差し替えない**（捨てると nonce が 1 つ飛んでセッションが壊れる）。封緘し終えた断片を捨ててよいのは `cancelOwner`（鍵ごと捨てる）だけ。画面の JPEG は、操作・状態が流れ続けても先頭で 500ms 待ったら、その 1 枚を最後の断片まで操作・状態より先に送る（差し替えた JPEG は古い方の待ち時間を引き継ぐ）。時間ベースで送っている間に積むのは 2MiB まで（超えたら値が変わるまで待つ。本当に止まった TCP で送信バッファを膨らませない）。優先度は browser チャネルのペイロードの先頭（`PVS\x01`・`{"t":"voice-`・`PJF\x01`・`{"t":"frame"`）で決めるので、送る側の呼び出しは変えていない。セッションを張り替える・捨てるときは `MobileSession.close()` / `resetSessionState()` が mux の列を取り下げる（古い鍵の断片を新しいセッションへ送ると、アプリが開けずに張り直すため）
- **古い相手への案内**: 版が合わないアプリには、State の代わりに `{protocolVersion, minCompatibleMobile}` だけの小さな JSON を送る（断片に切らないので版 3 のアプリも読め、今の「アプリの更新が必要」が出る）。新しいアプリは古い PC の State（700KiB の分割を含む）を読めるので「PC の更新が必要」が出る。アプリはアプリから PC へ送るものを断片に切るが、続けて送る（交互にしない）
- **`voice.stream.v1`**（`common/paradisMobileVoiceStream.ts` は import を持たず、アプリが相対パスで読む）: 流れは `voice-stream-start {sid, streamId, mime, gainDb, epoch}` → 2 進の断片（`PVS\x01` ＋ streamId 16 ＋ seq 4 ＋ MP3）→ `voice-stream-end {streamId, seq, bytes, aborted}`。`seq` は送った断片の数。配る側は `common/paradisVoiceSubscriptions.ts` の `ParadisMobileVoiceDelivery`。流すかは最初の音で端末ごとに決め（その端末が広告していて、`bufferedAmount`＋音声の列の未送信分が 256KiB 以下。画面の JPEG・ファイルの応答は音声より後に送るので数えない）、そうでない端末には終わってから `voice-clip`（`gainDb` 付き）で送る。断片は最初の音だけすぐ送り、その後は 8KiB か 100ms ごとにまとめる（設計は全部まとめる。鳴り始めを 100ms 遅らせないため最初だけ変えた）。始めたときの `MobileSession.epoch` と違えば黙って外し、購読をやめた端末には `aborted: true` の end を送る。端末ごとに同時 1 本の制限は外した。救済の `voice-clip` は音声の列に置き（同じ端末の音声は積んだ順なので、先に始まった流れを追い越さない。round2 L4）、操作・状態と 1 断片ずつ交互に送る（数 MB の clip で遅い回線の操作を止めない）。`voice-stream-end` の `seq`・`bytes` は記録用でアプリは読まない。最後の書き込みから 150 秒何も来ない流れは aborted で切って枠を空ける。1 本まるごとの宛先にも 8MiB の上限を効かせる。`epoch` はアプリでは使わない（張り直した後の古い流れの続きは 8 秒で終える。許容）
- **音声の出どころ**: 通知の読み上げは合成の応答を `paradisTeeBody`（`paradisStreamingBody.ts`）でモバイルへも流す。SSH 先の声と手元のエージェントの声（どちらも `/paradis-mcp/mobile-voice`）は、MP3 らしさを確かめた時点から `beginMobileVoiceStream` へ書く。通知の読み上げは合成の再試行をまたいでもモバイルへの流れを 1 本にする（`ParadisMobileVoiceTaskGate`。音を流し始めた試行が切れたら、そのタスクのモバイル配信はやめる）。通知のハンドオフ（`paradisVoiceHandoff.ts`）と ingress は、モバイルへの流れを手元の `--ingest` への書き込み（子の drain）から切り離す（ハンドオフは `ParadisBoundedLocalWriter`。worker が鳴らし始めた件は、手元への書き込みが途中で失敗しても Para Code が頭から鳴らし直さない。ingress は打ち切り（stop）のとき固まった書き込みを待たない）（手元用は 1MiB までの列に積み、書き込みに失敗してもモバイルへは abort を出さない。手元は鳴らし直しへ回る）。どの道でも最後にモバイルへの流れを閉じる（try/finally）。どちらも通知サービスの `onDidCreateMobileVoiceClip`（型は `ParadisMobileVoiceEvent`。名前は `sharedProcessMain.ts` を触らないために据え置き）に流れのイベントを出す。`gainDb` は `paradisResolveVoiceGainDb(gainKey, --ingest の表)`（利用者の上乗せは入れない）。ticket が古くなったら流れを切る
- **アプリの再生**（`modules/para-voice-session/ios/ParaVoiceSessionModule.swift`、`pod install` を避けるため 1 ファイルのまま）: AudioFileStream → AudioConverter（44.1kHz・モノラル・float）→ AVAudioEngine の AVAudioPlayerNode。`gainDb` を PCM に掛け、-1dBFS（0.891）で頭打ちにする（瞬時に下げて約 100ms で戻す）。流れは 500ms 溜めてから鳴らし、足りなくなったら同じだけ溜まるまで待つ。足りなくなった発話の後は閾値を 250ms 上げ（最大 1500ms）、5 回続けて足りたら 250ms 下げる（最小 500ms）。発話は始まった順に鳴らし、上限（発話 8・流れ 5・まだデコーダへ渡していない MP3 の合計 12MiB）を超えたらまだ鳴り始めていない一番新しい発話を捨てる（捨てたらログに出す）。最後の断片から 8 秒 end が来なければ届いた分で終える。鳴り始める前の `aborted` は鳴らさず、鳴り始めた後の `aborted` は届いた分を鳴らし切る。AVAudioEngineConfigurationChange でエンジンを作り直して鳴り終わっていない PCM を付け直し（作り直した後に古いエンジンの知らせが届いても二重に作り直さない）、割り込みの終わり・出力先の変更ではエンジンが止まっていたら作り直す。割り込み中（電話・Siri）にエンジンを起こせなければ、先頭の発話を捨てずに PCM を手元に戻して待ち、割り込みの終わり・出力先の変更で鳴らし直す（割り込みの終わりが 60 秒来なければ割り込み中とみなさない。ただしエンジンの起動が `cannotInterruptOthers`・`insufficientPriority` で失敗している間と、ほかのアプリが音声を鳴らしている間は、60 秒を過ぎても捨てずに 5 秒ごとに起こし直す。アプリが前面に戻ったときも起こし直す）。JS からネイティブへは同期の関数で渡す（届いた順を保つため）。1 本まるごとも流れと同じ閾値まで先にデコードしてから鳴らし、デコーダへは 64KiB ずつ、未再生の PCM が 10 秒ぶんを超えない範囲で渡す。割り込みでもないのにエンジンが 5 秒止まったまま・起こせないままなら作り直し、駄目ならその発話を諦める。`deactivate` は再生の列で止め終えてから（`queue.sync`）セッションを手放す。`playbackStats` は列を待たず、最後に控えた数を返す。開発ビルドは `__paraDev.voiceStream(base64Mp3, options)` と `__paraDev.voiceStats()` で確かめる（`src/dev/voiceStreamHarness.ts`）
- **組み立ての誤り**（断片の抜け・上限超え）は、PC・アプリとも `onAssemblyError` で暗号層の失敗と分けて数える（PC は張り直しの判定に数えず、アプリは切断しない）
- **設計書との差**: 2 進の断片の先頭は型 1 バイトではなく 4 バイトの印 `PVS\x01`（N7）。end が来ないときの 8 秒は、流れの始まりではなく最後の断片から数える（N7）
- **リレー**（`app/relay`）は中継だけなので変えていない（16KiB の断片はメッセージの上限より小さい）

## 今後の方針候補（未確定、要議論）

- 優先実装ターゲットの選定（機能1〜3のうちfork版でしか解決できない部分から着手すべきか）
- ブランディング（`product.json`のnameShort/nameLong/アイコン等、名称は「Para Code」）
- ~~配布方式（Marketplace代替のOpen VSX方針、CI/署名/配布）~~ → 実装着手済み。詳細は「配布・自動アップデート基盤」セクション参照
