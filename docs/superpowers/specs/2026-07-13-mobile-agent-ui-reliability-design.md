# モバイル Agent UI 信頼性改善 設計仕様

**対象:** 現行 Para Code、Codex CLI 0.144.1、Claude Code 2.1.207。旧版互換は対象外。

## 目的

モバイルの Agent 詳細画面で、送信・実行中表示・確定履歴・SubAgent/Task 詳細が途切れず、同じ事象がライブ経路と transcript 経路のどちらから届いても同じ UI へ収束するようにする。ターミナル入力は改行と実行を明確に分離し、対話型 Agent CLI は起動検知直後からホームへ表示する。

## 調査結果

| パターン | 現在の経路 | 不具合 | 正とする挙動 |
|---|---|---|---|
| Agentメッセージ送信 | bracketed paste と `\r` を同一PTY書込み | TUIが貼付けだけを保持し、次回入力と結合する場合がある | 貼付け完了後に対象セッションを再検証し、短い間隔を置いて Enter を別送する |
| ターミナル入力 | `monospace` が単一行・Enter送信も兼ねる | 改行したい Enter がコマンド実行になる | 等幅表示と送信操作を分離し、Enterは改行、実行は送信ボタンだけにする |
| Agent CLI起動 | shell integrationの `onCommandExecuted` 後、最短2秒のsession探索成功待ち | 起動直後は非表示。同一cwdに候補が複数あると表示されない | 対話型CLIコマンド検知時に「起動中」として即時表示し、session確定後に通常Agentへ昇格。コマンド終了時は除去する |
| Codex SubAgentライブ | app-server `subAgentActivity` / `collabAgentToolCall` | app-server購読前・切断時は欠落する | app-serverを優先し、rollout `event_msg.sub_agent_activity` を補完経路にする |
| Codex SubAgent履歴 | app-serverのitem通知のみ | 再接続・再読込後にカードが再構成されない | rolloutからSubAgent活動を復元し、同じIDで重複排除・状態収束する |
| Codex SubAgent詳細 | `thread/read(includeTurns:true)` のみ | daemon未接続時に詳細を開けない | app-server読取を優先し、子threadのstate DB/rolloutを安全なフォールバックとして読む |
| Codex Web検索ライブ | app-server `webSearch` | 実行中カードは出る | そのまま維持する |
| Codex Web検索履歴 | rollout `web_search_call` | 安定IDが無い行で開始・完了が対応せず、完了後カードが消えて汎用文字列になる | rollout内で決定的な合成IDを付け、開始・完了を1枚の検索カードへ対応付ける |
| Claude SubAgent | hook `SubagentStart/Stop` | Startに説明がなく、Stopのtranscript情報を使っていない | `agent_id`/`agent_type`を正とし、Stopのtranscriptと最終メッセージで詳細を補完する |
| Claude Task | hook `TaskCreated/Completed` | 現行フィールド `task_description` を読まず詳細が欠落 | `task_subject`、`task_description`、`teammate_name`を表示する |
| ターン終了 | tracker `endTurn` | completed時にrunning項目を終了させず残留し得る | 終了イベント時点で未完了の活動も終了理由へ収束させる |
| Effortスライダー | PanResponderをモデル選択シート内のScrollViewで使用 | ドラッグが途中で奪われると元の値へ戻る | 捕捉したドラッグは終了まで保持し、外部値の同期はドラッグ中に行わない |
| 日本語IME | AgentComposer全体をmemo化 | モデル/Effort等のprops更新ではmemoを通過し、TextInputへvalueが再適用される | TextInput自体をmemo境界にして、入力値以外の更新から変換中のネイティブ状態を隔離する |

## 現行プロトコルの正本

- Codexはローカルの `codex app-server generate-ts --experimental` で生成した0.144.1スキーマを正本とする。`item/started` は初期item、`item/completed` は最終itemとして扱う。対象itemは `webSearch`、`subAgentActivity`、`collabAgentToolCall`、`contextCompaction`。
- Claude Codeは2.1.207のhook契約を正本とする。`SubagentStart` は `agent_id` / `agent_type`、`SubagentStop` は `agent_transcript_path` / `last_assistant_message`、Task系は `task_id` / `task_subject` / `task_description` / `teammate_name` を使う。
- 同一事象が daemon、hook、transcript の複数経路から届くことを正常系とし、provider IDまたは決定的な合成IDで冪等に統合する。

## 設計

### 1. 入力送信

Agent送信は「action claim → 事前検証 → bracketed paste → 約250ms待機 → terminal/token/epoch/windowの再検証 → Enter別送 → accepted応答」とする。待機中に対象が変わった場合はEnterを送らず、貼付け済みを示す`consumed`付きrejectでモバイル下書きだけを消して次回送信との重複を防ぎ、「未送信・ターミナル入力を確認」と明示する。貼付け前に対象が変わった場合は通常rejectとして下書きを復元し、理由を表示する。送信待ち中の追加入力は別の下書きとして保持する。現行版で`agentActions`が未確定の間は危険な生PTY送信へフォールバックせず、セッション準備中として再送を促す。

`GlassComposer`には入力表示（等幅）と送信ポリシーを別propsで与える。Agent詳細もターミナルも複数行入力とし、キーボードEnterでは送信しない。送信ボタンだけが`onSubmit`を呼ぶ。

### 2. CLI起動の即時表示

shell integrationの `onCommandExecuted` は開始イベントとして維持する。コマンド行を純関数で分類し、対話型の `codex` / `codex resume` / `codex fork` と `claude` / `claude --resume` 等だけを検知する。`--help`、`--version`、Codexの非対話サブコマンド、Claudeの`--print`/`--background`は除外する。

検知したpane tokenを「provisional Agent」としてrendererのホーム状態へ即時反映する。既存の鮮度検証済みsession探索は会話・設定操作の確定に使い、成功時はconfirmedへ昇格する。`onCommandFinished`、terminal dispose、pane同期からの消滅時にprovisionalを除去する。provisionalはAgent詳細へ誤ったsessionを割り当てない。

### 3. 活動状態の収束

`ParadisAgentActivityTracker`を唯一の活動状態集約器とする。

- Codex daemon itemをprovider IDで適用する。
- rollout `sub_agent_activity` は `agent_thread_id` をIDとして同じtrackerへ適用する。
- Claude hookは現行フィールドだけを適用する。
- terminal状態を一度確定した項目は、遅れて届いたrunningイベントで巻き戻さない。
- completed/failed/interruptedのターン終了で、その終了時刻以前から残っているrunning/idle項目だけを対応するterminal状態へ閉じる。遅延した古いturn終了で新しい活動を巻き戻さない。

完了した活動は消さず、会話上部の完了サマリーと活動一覧に残す。実行中だけ固定ストリップへ出す。

### 4. Web検索の永続カード

Codex rolloutの `web_search_call` にprovider IDが無い場合は、セッションepochと検索行の安定した位置から合成IDを付与する。同一の完了行がtool use/resultを同時に表す場合も両方へ同じIDを付ける。UIは開始行を完了時に隠すのではなく、結果行位置に開始+完了を1枚で表示する現在の時系列規則を維持する。

### 5. SubAgent詳細

Codexは `thread/read(includeTurns:true)` を第一経路とする。失敗時はstate DBで子thread IDに一致する許可済みrollout pathを引き、既存Codex parserで上限付き読取を行う。Claudeはhookのtranscript pathをtrackerに保持し、従来の規定ディレクトリ探索に加えてその許可済みpathを使う。パスは既存のallowed-root検証を必須とし、任意ファイルは読まない。

### 6. 操作中UIの隔離

EffortスライダーはPanResponderを一度捕捉したら親ScrollViewからのtermination要求を拒否し、releaseまでpreviewを保持する。ドラッグ中は外部の選択値変更でpreviewを上書きしない。IME入力は`TextInput`そのものをmemo化し、モデルカタログ、Effort、ツール列、チャット本文の更新で同じvalueを再適用しない。

## テスト方針

- 純関数: CLI分類、Codex rolloutの検索ID/SubAgentイベント、Claude現行hookフィールド、turn終端収束。
- renderer/provider: provisional→confirmed→終了、pane消滅、送信中session切替、pasteとEnterの順序。
- モバイル: GlassComposerのEnter非送信、Effortドラッグのgesture保持、検索カードの開始/完了ペア、活動完了後もサマリーが残ること。
- 既存mobile relay/node test、mobile typecheck/lint、関連VS Code testを実行する。

## 非対象

- 旧Codex/Claude Code形式の互換分岐。
- リリース作業。コミットとpushまでを本作業に含め、リリースはユーザーが行う。

## 参照

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Claude Code hooks: https://code.claude.com/docs/en/hooks
