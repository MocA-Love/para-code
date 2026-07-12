# ParaCode Mobile Agent Control Foundation Design

## 目的

Claude Code / Codex のモバイル操作を、ターミナルIDだけに対する時限PTY入力から、対象セッションと対話状態を検証するAgent Actionへ移行する。同時に、同じAgentを複数のペアリング済みモバイル端末から購読できるようにする。

本設計はSubAgent詳細画面とWeb検索faviconの前提基盤であり、この段階ではそれらのUIを追加しない。

## 現状と根本原因

通常メッセージ、質問回答、承認、Claudeのモデル・Effort変更は、モバイルが複数回のPTY入力を一定時間差で送る。各入力はターミナルIDにしか紐づかず、送信途中のセッション終了、再起動、質問解消、接続断を検出できない。

Codexモデル制御には既に`requestId`、セッション確認、タイムアウト、確認応答がある。このパターンを通常のAgent操作へ一般化する。

Agentチャット購読は`paneToken -> mobileId`の1対1で保持されるため、後からattachしたモバイルが以前の購読者を上書きする。

## スコープ

### 含む

- Agent Actionの要求・応答プロトコル
- セッション、pane token、対話モードの検証
- 通常メッセージのbracketed-paste対応
- 質問・承認の重複送信防止
- 時限キー列のPC側集約とキャンセル
- モバイル側の送信中・失敗表示と下書き保持
- 複数モバイル購読
- 既存Codexモデル制御との共通化可能な要求管理

### 含まない

- SubAgentツリーと専用詳細画面
- Web Activityとfavicon
- Codex Windows transport対応
- Claude Agent SDKへの移行
- Claude/Codex自体のTUIを置き換えること

## プロトコル

モバイルからPCへ、agentチャネルで次を送る。

```ts
type AgentActionRequest = {
	t: 'action';
	id: number;
	token: string;
	requestId: string;
	epoch: string;
	action:
		| { type: 'sendMessage'; text: string }
		| { type: 'steerMessage'; text: string }
		| { type: 'answerQuestion'; interactionId: string; answers: AgentQuestionAnswer[] }
		| { type: 'answerApproval'; interactionId: string; decision: 'approve' | 'deny' }
		| { type: 'claudeModelCommand'; command: string };
};
```

PCからモバイルへ、必ず最終応答を返す。

```ts
type AgentActionResponse = {
	t: 'action-result';
	id: number;
	requestId: string;
	status: 'accepted' | 'rejected' | 'failed';
	code?: 'stale-session' | 'stale-interaction' | 'wrong-mode' | 'disconnected' | 'unsupported' | 'timeout';
	message?: string;
};
```

`requestId`は同じ操作の再送を識別する。PC側は短時間の完了済みrequest IDを保持し、重複要求に同じ結果を返す。

## 対話状態

PC側がAgentスナップショットとdeltaに次を付加する。

```ts
type AgentInteraction =
	| { mode: 'prompt' }
	| { mode: 'working' }
	| { mode: 'question'; interactionId: string }
	| { mode: 'approval'; interactionId: string }
	| { mode: 'unknown' };
```

- `sendMessage`は`prompt`でのみ受理する。
- `steerMessage`は`working`でのみ受理し、TUIが実行中入力を受け付けることを確認できる場合に使う。
- `answerQuestion`は同じ`interactionId`の`question`でのみ受理する。
- `answerApproval`は同じ`interactionId`の`approval`でのみ受理する。
- Claudeモデルコマンドは`prompt`でのみ受理する。
- Codexモデル設定は既存app-server制御を維持する。

`interactionId`は可能ならtool use IDを使い、無い場合はセッションepoch、イベント種別、単調増加番号から生成する。

## PC側の操作

通常メッセージとsteerは`ITerminalInstance.sendText(text, true, true)`を使い、bracketed pasteを有効にする。steer非対応のTUI状態では`unsupported`を返し、通常メッセージとして後から誤送信しない。

質問・承認でTUIキー操作が必要な場合は、全キー列をPC側の1トランザクションとして扱う。操作開始時と各待機後に、pane token、セッションepoch、interaction IDが同じか確認する。不一致なら残りを送らず`stale-interaction`を返す。

任意時間の固定待機は既存TUI互換のため当面残すが、タイマーは要求単位で管理し、ターミナル終了、セッション変更、disposeで必ずキャンセルする。

Claudeモデル確認ダイアログの出力文言監視は、このAgent Action経路から開始した操作に限定する。将来TUIが構造化操作を提供した時点で置換する。

## モバイル側の動作

- 通常メッセージは`accepted`後に下書きを消す。
- 送信中は同じ操作を再送できない。
- `rejected`または`failed`では入力内容を保持し、理由を表示する。
- 質問と承認カードは送信開始時に操作不能にし、失敗時だけ再操作可能に戻す。
- Agentの対話モードと一致しないコンポーザー、質問、承認操作を無効化する。
- 画面離脱だけでは、PCへ受理済みの操作をキャンセルしない。

## 複数モバイル購読

購読状態を次へ変更する。

```ts
Map<paneToken, Set<mobileId>>
```

- attachは集合へ追加する。
- detachと切断は該当mobile IDだけを削除する。
- snapshot、delta、live、activity、infoは全購読者へ送る。
- モデル制御とAgent Actionの応答は要求元mobile IDだけへ返す。
- 集合が空になった時だけ、不要ならtailerを停止する。

## 互換性

- 旧モバイルのtermチャネル入力は削除しない。ターミナル画面の操作に必要なため維持する。
- Agent画面だけを新しいaction経路へ移す。
- 新しいPCと旧モバイル、旧PCと新しいモバイルの組み合わせでは、Agent Action capabilityの有無をスナップショットで判定する。
- capabilityが無い旧PCでは、通常メッセージのみ既存`sendTextInput`へフォールバックする。質問・承認は誤操作防止のためターミナル画面へ誘導する。

## エラー処理

- Agentセッション変更: `stale-session`
- 質問・承認の解消または置換: `stale-interaction`
- 入力可能でない状態: `wrong-mode`
- リレー切断: モバイル側で送信せず`disconnected`
- TUI非対応: `unsupported`
- PC側操作時間超過: `timeout`として残りのキー送信を中止

## 次段階への提供インターフェース

SubAgent詳細画面は、同じ`AgentInteraction`とAgent Action応答形式を再利用する。ただし初期版のSubAgent詳細は閲覧専用とし、子Agent操作は別途プロバイダーごとに設計する。

Web ActivityはAgentチャットdeltaへ追加するが、本基盤の操作トランザクションには依存しない。

## 完了条件

- Agent画面の通常送信が生の`send()`＋遅延Enterを使わない。
- staleな質問・承認にキー入力を送らない。
- 操作結果がモバイルへ返り、失敗時に下書きが残る。
- 同じAgentの更新を複数モバイルが同時に受信できる。
- ターミナル画面の既存PTY操作は維持される。
