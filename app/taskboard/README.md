<!-- PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md. -->

# タスクボード（開発用サーバーと画面）

工程の流れ（フロー）どおりにエージェントを回し、どこで人の出番かを 1 画面で見るためのボードです。今はブラウザで動く開発版で、後で Para Code の専用ウィンドウに載せます（エンジンと画面はそのまま使い、受け渡しの口だけを IPC に替えます）。

## 起動

```sh
cd app/taskboard
pnpm install --ignore-workspace

# 見本の台帳で動かす（GitHub につながない）
pnpm dev --demo

# リポジトリの Issue を取り込む（担当が自分の、開いている Issue）
pnpm dev --repo ~/projects/para-code

# クローンの使い回しで使うディレクトリを指定する（個人の設定として覚える）
pnpm dev --repo ~/projects/para-code --clones ~/projects/para-code-1,~/projects/para-code-2

# 本物の Claude Code / Codex を Para Code で動かす
# （Para Code を先に起動し、設定 `paradis.taskBoard.bridge.enabled` をオンにしておく。既定はオフ）
pnpm dev --repo ~/projects/para-code --clones ~/projects/para-code-1,~/projects/para-code-2 --agents para-code
```

起動するとターミナルに `http://127.0.0.1:4870/?token=…` が出るので、それを開きます。

| オプション | 意味 |
| --- | --- |
| `--repo <path>` | 対象のリポジトリ。省くと今のディレクトリ |
| `--demo` | 見本の台帳で動かす（GitHub につながない） |
| `--no-github` | GitHub につながない |
| `--clones a,b,c` | クローンの使い回しに使うディレクトリ |
| `--real-workspaces` | 作業場所の git 操作（fetch・ブランチ作成・ワークツリー作成）を実際に行う。未コミットの変更がある作業場所には触らない |
| `--agents para-code` | エージェントを Para Code で本当に起動する。作業場所の git 操作と自動の工程（コマンド・ドラフト PR の作成）も本物になる。`--repo` が要る |
| `--bridge <file>` | Para Code の接続情報ファイル（既定は `<userData>/paradis-taskboard-bridge.json` を探す） |
| `--port <n>` | 待ち受けるポート（既定 4870。0 で空いている番号） |
| `--speed <n>` | シミュレーションの速さ |
| `--data <dir>` | 台帳の保存先（既定 `~/.para-code/taskboard/<repo の hash>/`） |
| `--prod` | `pnpm build` した画面を配る（Vite を使わない） |

## 今できること

- フローの工程を列にしたボード、あなたの番、一覧、フロー編集
- タスクの詳細: Issue（本文・経過・コメント）、PR（会話・チェック・変更ファイルの差分・コミット）、進捗、計画、モック、成果物、ターミナル
- GitHub からの取り込み（Issue か Projects）と、Issue を閉じる PR の状態の追跡（読むだけ。GitHub へは書き込まない）
- 既定ではエージェント・コマンド・作業場所はシミュレーション（画面に「シミュレーション」と出る）。`--agents para-code` で本物になる
- ダーク・ライト・OS に合わせる、デスクトップ・タブレット・電話の幅

## 本物のエージェント（`--agents para-code`、フェーズ 3）

Para Code の shared process が `127.0.0.1` に接続口を立て、`<userData>/paradis-taskboard-bridge.json`（0600）にポートとトークンを書きます。ボードサーバーはそれを読んで次のことをします。

| ボードの動き | Para Code 側 |
| --- | --- |
| エージェント工程を始める | 作業場所のスペースで Claude Code / Codex を起動（フォーカスは奪わない）。同じタスクの次のエージェント工程は同じターミナルで続け、ターンの途中なら終わるまで指示を預かる |
| 進捗・質問・許可待ち | hook と画面の状態を `GET /v1/events`（SSE）で受け取る |
| エージェントの報告 | para-browser の MCP ツール `board_complete_step` / `board_ask_human` |
| 回答・入力・キー | `/v1/answer`・`/v1/send`・`/v1/key`。回答の口はボードのトークンを持つ側だけが使え、エージェントからは呼べない |
| 自動の工程 | ボードサーバーが作業場所で直接実行（`sh -c`、`git push`。ドラフト PR は GitHub の API で作る） |

やり直しの直後に届いた、止める前のターンの `board_complete_step` は断ります（新しい指示を送るまで）。成果物の `path` は作業場所の中のファイルだけ読みます。

接続口の鍵（`paradis-taskboard-bridge.json`）は同じ PC のプログラムなら読めるので、オンの間は、ペインの中のエージェントが鍵を読んで回答の口を叩くことを防げません（確認を全部飛ばす権限での起動は断ります）。このため設定は既定でオフにし、タスクボードを使うときだけオンにします。ボードを Para Code の中に載せる段階（フェーズ 4）で、ファイルの鍵をやめてこの穴を塞ぎます。

## 作り

| 部品 | 場所 | 中身 |
| --- | --- | --- |
| エンジン | `src/vs/paradis/contrib/taskBoard/common/` | 型と RPC の約束、フロー定義の検証、台帳と工程の進め方。VS Code の仕組みに依存しない |
| サーバー | `app/taskboard/server/` | HTTP と WebSocket、GitHub 連携、フロー定義ファイル、台帳の保存、シミュレーション |
| 画面 | `app/taskboard/src/` | React。スナップショットを丸ごと受け取り、操作は RPC で送る |

フロー定義の置き場所: チーム共通は `<repo>/.para-code/paracode.json`、個人は `<repo>/.para-code/<GitHub のユーザー名>/workflows.json`。旧 `<repo>/.paracode.json` は新しいファイルが無いときだけ読み、保存は新しい場所へ行います。

## 守り

- `127.0.0.1` だけで待ち受け、起動ごとの乱数トークンを要求します（URL の `?token=` で一度渡すと HttpOnly の Cookie に移る）
- `Host` と `Origin` を確かめ、別のサイトや DNS の付け替えから叩かれないようにします
- GitHub のトークンは `gh auth token --hostname github.com` で受け取り、メモリにだけ持ちます（5 分ごとと 401 のときに受け取り直す。ログ・エラー・画面には伏せ字で出す）
- GitHub の呼び出しは `server/github.ts` の 1 か所から HTTP（REST・GraphQL）で行います。同じ読み取りが重なったら 1 回にまとめ、REST は ETag で変化の無い応答（304）を残量から引かせません。上限は本体の `githubRateLimitCoordinator` と同じ考え方で、secondary limit はアカウントごと、primary limit は枠ごとに、`retry-after` かリセット（手がかりが無ければ 60 秒）まで止めます。取り込みは 5 分ごと、外部待ちの工程にいる PR の見張りは 60 秒ごとです
- モックの HTML は `sandbox` の iframe と `Content-Security-Policy: sandbox` で表示し、スクリプトも親の画面へのアクセスも許しません

## 確認

```sh
pnpm test        # エンジンとサーバーの単体テスト
pnpm typecheck
pnpm test:e2e    # 見本の台帳でサーバーを起動し、ヘッドレスの Chrome で主な操作を一通り行う（スクショは test/e2e/out）
```
