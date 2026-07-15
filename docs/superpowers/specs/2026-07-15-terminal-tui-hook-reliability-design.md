# Terminal TUI and Agent Hook Reliability Design

## 目的

通常のシェルプロンプトではPara Code独自のDownArrow補完を維持しつつ、Codex、Claude Codeなどの対話型コマンド実行中はキー入力をTUIへ渡す。また、Para Code外でもグローバル登録されたagent hookが大きなstdinを安全に消費し、送信側へBroken pipeを発生させない。

## 現状と原因

### TUI中のDownArrow

`ParadisTerminalPromptTrackerContribution`は`onDidFinishInput`で補完対象を一度falseにするが、`PromptInputModel`は実行状態へ遷移した直後に、実行済みコマンド文字列を含む`onDidChangeInput`も発火する。イベント値には`PromptInputState`がないため、現在の実装は非空文字列だけを見て補完対象をtrueへ戻す。その結果、通常バッファを使うTUIでDownArrowが明示的なterminal suggestとして処理され、候補ゼロの表示が出る。

### Agent hookのBroken pipe

生成済みnotify scriptは、pane token、port file環境変数、port fileのいずれかがないとstdinを読む前に終了する。hook設定はClaude Code/Codexのグローバル設定へ登録されるため、Para Code外でも実行される。小さなJSONはpipe bufferへ収まるが、大きなJSONではwriterが読み取り側の終了後も書き込み、EPIPE/SIGPIPEになる。

## 採用方式

### TUI補完の適格性

- 補完対象判定を副作用のない共通関数へ分離する。
- `promptInputModel.state === PromptInputState.Input`を必須にする。
- `commandDetection.executingCommand === undefined`を追加の防御条件にする。
- 入力イベントのsnapshotではなく、イベント受信時点のlive modelとcommand detectionを評価する。
- ghost textを除いた実入力が非空の場合だけ有効にする。
- コマンド名によるCodex/Claude固有判定は行わない。すべてのforeground command/TUIへ同じ規則を適用する。
- 既存のalt buffer、shell integration、terminal suggest設定のwhen条件は維持する。

### Hook stdinのライフサイクル

- notify script schemaを1から2へ上げ、`notify-v2.sh`と`notify-v2.ps1`へ安全に移行する。
- argvでJSONを受け取っていないstdin方式では、すべての早期終了経路でstdinをEOFまで破棄読みする。
- POSIXの有効経路では`umask 077`で作成した一時ファイルへ最大4 MiB + 1 byteだけ保存し、残りは破棄読みする。shell変数やdiskへ巨大JSON全体を保持しない。
- 一時ファイルへの書き込みが失敗した場合も、残りのstdinを`/dev/null`へ読み切ってから終了する。
- 一時ファイルは終了・シグナル時に削除する。
- 受信上限4 MiB以下はraw JSONをPOSTする。上限超過時は本文なしGETへフォールバックし、sessionやtool detailは省略するが基本イベント状態は維持する。
- PowerShell版も無効経路でstdinをbuffer単位に読み切る。有効経路では最大4 MiB + 1 byteだけをmemoryへ保持し、上限超過時は本文なしGETへフォールバックする。
- 4 MiBの値はhook共通定数とHTTP受信側で共有し、生成scriptとserverの不一致を防ぐ。

## エラー処理と安全性

- hookは通知補助であり、port不正、temp file失敗、HTTP失敗でAgent CLI本体を失敗させない。
- stdinを途中で閉じるエラー処理は作らない。
- 一時ファイル名へpane tokenなどの識別子を含めず、権限は作成前の`umask 077`で制限する。
- 4 MiB超過本文をserverで解析せず、既存のbody上限を緩和しない。
- schema 2設定を見た旧Para Codeは既存のfuture-schema保護によりhook定義を巻き戻さない。

## 検証

- Input状態、実コマンド非空、ghost textのみ、Execute状態、executing command有無を共通判定の単体テストで固定する。
- Execute遷移後に非空のchange eventが続いても補完対象がfalseのままであることを確認する。
- 8 MiBのstdinをPara Code環境変数なしでnotify scriptへ送り、pipefail下でも終了コード0になることを確認する。
- 有効な小容量JSONがPOSTされ、本文が一致することを確認する。
- 4 MiB超過JSONが最後まで消費され、bodyless GETへフォールバックすることを確認する。
- schema 1の管理hookがschema 2へ移行し、ユーザーhookを保持することを確認する。
- PowerShell生成scriptに無効経路のdrainと容量フォールバックが含まれることを確認する。

## レビュー境界

TUI補完とagent hookは独立してレビュー・コミットする。既存の未コミットファイル、terminal suggestの他キーバインド、agent event正規化、HTTP body上限値そのものは変更対象に含めない。
