# Agent Session Controller Design

## 目的

Claude Code / Codexの実行状態を、モバイル接続や個別hookの成否に依存せずペイン単位で正しく収束させる。また、Claude Code Agent Teamsのメッセージをユーザー発言と区別して表示する。

## 現状の問題

- Codexの`task_complete`、`error`、`turn_aborted`検出がモバイルチャット用transcript tailerに依存し、モバイル未接続時は状態が収束しない。
- terminal破棄時にpane tokenの対応表やexit listenerが先に破棄され、shared processへ終了通知できない場合がある。
- pane tokenのretire処理がagent hook実績を削除せず、Browser bindingが残る場合はretire自体も抑止される。
- 通常の`working`にはPTY生存確認がなく、終了イベントを一度失うと緑状態が永続する。
- rendererのstatus poll失敗時に以前の状態を保持し続ける。
- Claude Codeのteammate通信はtranscript上で`type: user`として記録されるため、モバイルでユーザー発言として表示される。

## アーキテクチャ

PC shared processにpane token単位のAgent Session Controllerを置き、以下を同じ状態機械へ入力する。

- Claude Code / Codex hook
- Claude transcript / Codex rolloutのturn終了イベント
- terminal processのexit
- terminal instanceの明示的な削除
- Browser bindingの追加・削除
- background taskの開始・終了
- renderer IPCの切断・再接続

Controllerの正規化済み状態だけをWorkspace一覧とモバイルへ配信する。モバイル側はprovider固有イベントを解釈しない。

## 状態モデル

Controllerは各pane tokenについて以下を保持する。

- agent種別
- terminal instance / processの生存状態
- `idle | working | review | permission | question`
- 現在のturnと開始時刻
- background task一覧
- transcript / rollout監視情報
- Browser binding
- 最終入力イベントと更新時刻

状態遷移の優先順位は次のとおり。

1. terminal exitまたは明示的なterminal削除は、他の状態に関係なくpaneをretireする。
2. permission / questionは、人間の応答が必要な間だけ維持する。
3. hookまたはtranscriptのturn開始でworkingへ移る。
4. Stop、task_complete、error、turn_aborted、usage limitでturnを終了しreviewへ移る。
5. background taskが残る場合はturn終了後もworkingを維持し、完了時にreviewへ移る。
6. 不整合時の時間判定は安全弁とし、PTY生存・turn・transcript更新を確認してから収束させる。

## terminalライフサイクル

- terminal監視登録時にpane tokenをクロージャへ保存し、後からtoken mapを引き直さない。
- process `onExit`とinstance `onDisposed`の両方から同じ終了処理を呼ぶ。
- 終了処理はtoken単位で冪等にし、先着した一方だけが副作用を持つ。
- renderer reloadによる一時detachと、terminalの明示削除・PTY終了を区別する。
- terminal終了時はBrowser bindingの有無にかかわらずpaneをretireする。

`retirePane(token)`は次を一括削除する。

- pane status
- agent hook実績
- transcript / rollout監視
- background task / question activity
- pane shell PID
- Browser bindingとCDP connection
- seen token / DevTools proxy cache

削除後はWorkspaceとモバイルへ状態消滅を通知する。

## transcript / rollout監視

- status収束に必要な軽量監視をモバイルチャット購読から分離する。
- agent sessionが確定している間は、モバイル未接続でも常時監視する。
- Codexでは`task_complete`、`error`、`turn_aborted`をturn終了へ正規化する。
- ClaudeではStop/SessionEndが欠落する中断ケースをtranscriptから補完する。
- transcript表示用の履歴処理とstatus状態機械は同じパーサー結果を利用しても、ライフサイクルを共有しない。

## IPC障害とstale判定

- 一度のpoll失敗では表示を変更しない。
- 連続失敗またはshared process再起動を検出した場合は、古いworkingを永続表示せず一旦解除する。
- 再接続後はshared processのsnapshotで全置換する。
- 時間だけで長時間処理を終了扱いしない。
- background taskのlive判定とstatus fallbackの時間基準を統一する。

## Agent Teamsメッセージ

PC側のClaude transcript正規化で、以下を通常ユーザー発言より先に判定する。

- `<teammate-message teammate_id="...">`
- `<agent-message from="...">`
- `<cross-session-message>`
- `Another Claude session sent a message`で始まる互換形式

分類規則:

- `idle_notification`など表示価値のない制御フレームは会話へ追加しない。
- 実内容のあるteammate報告は`peer_message`へ変換する。
- `peer_message`には送信元、summary、本文、時刻を保持する。
- `peer_message`は`signals.userText`を更新せず、ユーザー入力由来のstatus遷移を発生させない。
- 通常のユーザー発言は従来どおり`user/text`として扱う。

モバイルでは`peer_message`を左寄せの中立カードで表示し、`Claude teammate · {name}`、summary、本文を示す。ユーザー用の色・吹き出し・アバターは使用しない。

## エラー処理

- 未知のteammate制御フレームはユーザー発言へフォールバックせず、中立的なpeer messageまたは非表示とする。
- transcriptが一時的に読めない場合は状態を即座に終了せず、PTY生存と再試行結果を確認する。
- 終了通知の重複は正常系として扱う。
- tokenを解決できない新規イベントは既存paneへcwdだけで誤結合しない。

## テスト

### 状態機械

- Claude / Codexの正常完了
- Codexのtask_complete、error、turn_aborted、usage limit
- ClaudeのStopなし中断
- hook POST失敗
- background task開始・完了・完了通知欠落
- 同一paneでagentを再起動

### terminalライフサイクル

- onExit→onDisposed、onDisposed→onExitの両順序
- terminalゴミ箱削除、shell exit、CLI crash
- Browser共有中のterminal削除
- window reloadではpersistent terminalを維持
- window closeではtoken関連状態を全削除

### 表示と通信

- モバイル未接続でもCodex状態が収束
- poll一時失敗と再接続snapshot
- teammate通常報告、summary付き報告、idle通知
- 通常のユーザー発言、system-reminder、tool_resultの非回帰

## 完了条件

- terminal削除後、次回snapshotで該当paneのstatusとagent印が消える。
- モバイル未接続でもCodexの異常終了・中断がreviewへ収束する。
- hookを一度失ってもPTY/transcript経路で永久workingにならない。
- Agent Teams通信がユーザー発言として表示されない。
- 既存のClaude/Codex正常完了、permission、question、background task表示に回帰がない。
