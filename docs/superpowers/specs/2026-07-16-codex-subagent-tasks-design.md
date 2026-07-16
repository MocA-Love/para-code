# Codex SubAgent Tasks Design

## Goal

CodexがSubAgentへ委譲した処理を、Claude CodeのTaskと同じモバイルActivityのTask一覧へ表示する。実行中だけでなく完了後もセッション内履歴として保持する。

## Event source and compatibility

Taskの正本はCodex app-serverのcollaboration itemとする。リポジトリに生成済みの`collabAgentToolCall`形式と、現行公式ドキュメントの`collabToolCall`形式をRelay内で正規化する。モバイルの公開Taskモデルには後方互換な任意`agentId`だけを追加する。

- 旧形式: `receiverThreadIds`、`agentsStates`
- 現行ドキュメント形式: `receiverThreadId`、`newThreadId`、`agentStatus`
- Taskを作成するのは`spawnAgent`／`spawn_agent`だけとする。
- `sendInput`、`resumeAgent`、`wait`、`closeAgent`は既存Taskの状態更新だけに使う。
- CodexのPlanとGoalはTaskへ変換しない。

## Task identity and presentation

1つの子Threadを1つの委譲Taskとして扱い、Task IDは`codex:<childThreadId>`とする。同じ子Threadへの追加入力やresumeでTaskを重複作成しない。

- `label`: 委譲promptの先頭の非空行。表示上限は200文字。
- `detail`: 委譲prompt全文。既存の入力上限を適用する。
- `assignee`: `agentPath`の末尾名。判明するまでは`SubAgent`。
- `agentId`: 子Thread ID。表示名とは分離し、SubAgent詳細画面との確実な関連付けに使う。
- `startedAt`: 最初にspawnを観測した時刻。
- `updatedAt`: 対象Taskの状態または担当情報を最後に観測した時刻。

## Lifecycle

子Agentの明示状態をTask状態の正本とする。collaboration item自体の`item/completed`はツール呼び出しの終了であり、子Agentの完了とは限らないため、子状態がないspawn完了は`running`を維持する。

- `pendingInit`、`running`は`running`
- `completed`、`shutdown`は`completed`
- `errored`、`notFound`は`failed`
- `interrupted`は`interrupted`
- spawn item自体が`failed`の場合は`failed`
- 未知の明示状態は`unknown`

遅延した古いイベントで新しい状態を巻き戻さない。新しいinteractionやresumeは、同じ子Threadの完了Taskを`running`へ戻せる。親Turn終了ではTaskを終了せず、セッション終了・15分stale・100件上限は既存Activity Trackerの共通処理を使う。

## Scope and safety

- Relayは`paradisAgentActivity.ts`とその単体テストを変更する。
- モバイルはTaskの`agentId`受信とSubAgent詳細の関連付けだけを変更し、一覧の表示構造は変えない。
- 入力は既存の`record`／`text`境界で検証・切り詰めする。
- 生成済みCodex protocolは変更しない。
- ユーザー所有の未追跡ファイルをコミットしない。
- プッシュは行わない。
