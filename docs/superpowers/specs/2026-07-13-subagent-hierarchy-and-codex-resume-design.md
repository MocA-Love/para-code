# SubAgent階層チャットとCodex再開認識 設計仕様

## 目的

モバイル版のSubAgent表示を、履歴カードの羅列から親子関係が分かるチャットへ変更する。同時に、Codexの新規起動・`codex resume`・起動後の`/resume`を安定してホームとAgent画面へ反映する。

## 対象

- 現行Claude Code（ネストSubAgent、最大5階層）
- 現行Codex（子threadの親ID、depth、agent path）
- 現行PC版Para Codeと現行モバイル版の組み合わせのみ
- リリース作業は対象外

## SubAgentデータモデル

- Agentは一意な`id`、任意の`parentId`、正規化済み`depth`を持つ。
- `parentId`がないAgentはメインAgent直下として扱う。
- 親が未観測・循環・深さ不正の場合は安全にメインAgent直下へフォールバックする。
- 実行中数と履歴総数を分離する。単純な`agents.length`を実行中数として表示しない。
- Codexはstate DBの`source`またはrolloutの`session_meta`から親IDと深さを取得する。
- Claudeはhookに親IDが含まれる場合は採用し、含まれない場合は既知の親へ誤帰属させず直下として表示する。後続のtranscript相関で親が判明した場合は更新可能な構造にする。

## UI

- 一覧は階層順にインデントし、各Agentの状態を表示する。
- 詳細は選択中Agentを左、直接の親からの依頼を右に置くチャット形式にする。
- `user` roleは「USER」ではなく直接の親Agent名として表示する。
- Assistant本文は親Agent画面と同じMarkdown rendererを使う。
- tool call/resultは本文カードと分離し、折り返し・選択可能な専用表示にする。
- 選択中Agentが生成した直接の子Agentを会話中の遷移カードとして表示し、タップで同じ詳細画面内をドリルダウンする。
- ヘッダーにパンくずを表示し、メインAgentまで戻れるようにする。
- メタ情報は「実行中」「直接の子」「配下全体」「完了」を別々に表示する。

## Codex起動・再開認識

CLI分類結果をAgent種別だけでなく次のモードとして扱う。

- `new`: `codex`、`claude`など通常起動。新規セッションの作成日時を鮮度ガードに使う。
- `resume`: `codex resume ...`、`claude --resume ...`。既存セッションの更新日時を使い、古い作成日時では拒否しない。
- `fork`: `codex fork ...`。新規セッションとして扱う。

state DB探索ではSubAgent由来のthreadをメインAgent候補から除外する。CommandDetection capabilityが後から追加された場合、その時点の`executingCommand`も直ちに評価する。

起動後の`/resume`はhookによるtranscript切替を第一経路とする。Codex hookが使えない場合に備え、対話型CLIの実行中は一定期間、同一cwdのroot thread更新を再探索する。既存paneのthreadとは異なり、他paneにclaimされておらず、更新開始時刻以降に一意に更新された候補だけへ切り替える。SubAgent threadは候補にしない。

## 安全条件

- 同じcwdで候補が複数ある場合は推測で割り当てない。
- 別paneがclaim中のtranscriptへ切り替えない。
- session epochを変え、旧詳細リクエストや送信操作を新セッションへ混入させない。
- 不正な親ID・循環参照・過大文字列をrelay境界で正規化する。

## 検証パターン

| 分類 | パターン | 期待結果 |
|---|---|---|
| Codex起動 | `codex` | 新規root threadのみ認識 |
| Codex再開 | `codex resume --last` / ID指定 | 作成日時が古くても更新されたroot threadを認識 |
| Codex内再開 | 起動後`/resume` | hookまたは一意なroot更新でsession切替 |
| 起動競合 | 同一cwdで複数候補 | 誤割当せず保留 |
| capability競合 | 起動後にCommandDetection追加 | 実行中コマンドを即時認識 |
| Codex階層 | 子が孫を生成 | parentId/depthを維持して表示 |
| Claude階層 | 親IDあり/なし | 既知なら階層化、不明なら安全に直下表示 |
| 詳細会話 | user/assistant/tool/Markdown | 親右・子左・tool専用表示 |
| 件数 | 完了履歴を含む | 実行中数と履歴総数を混同しない |
