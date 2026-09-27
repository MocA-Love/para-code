/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェント（Claude Code / Codex）の会話を「チャット」として見せるための共通の形。
//
// 会話ログ（transcript）の読み取りと正規化は shared process のモバイル中継
// （mobileRelay/node/paradisMobileAgentChat.ts）が行い、同じ結果をモバイルとデスクトップの両方へ渡す。
// ここに置くのは、その両方が同じ意味で読む型と、デスクトップが中継から会話を引くための口だけ。
// **モバイルへ送るメッセージの形はここを変えると変わる**ので、フィールドを足すときはモバイル側
// （app/mobile/src/store.ts の AgentChatMessage 等）が知らない値を無視できるかを確かめること。

import { Event } from '../../../../base/common/event.js';

/** デスクトップのチャット表示（エディタエリアのターミナルタブを ⌘⇧J でチャットに切り替える）を使うか。 */
export const PARADIS_AGENT_CHAT_ENABLED_SETTING = 'paradis.agentChat.enabled';
/** チャット表示の送信キー（Q32）。'enter' = Enter で送信・Shift+Enter で改行、'modEnter' = ⌘Enter で送信・Enter で改行。 */
export const PARADIS_AGENT_CHAT_SEND_KEY_SETTING = 'paradis.agentChat.sendKey';

/** 承認要求の選択肢1件（Codex app-server の構造化された承認と、hook 由来の許可/拒否の共通形）。 */
export interface IParadisAgentApprovalChoice {
	readonly id: string;
	readonly label: string;
	readonly tone: 'approve' | 'neutral' | 'deny';
}

/** エージェントCLIの種別 (transcriptパスから判定)。 */
export type ParadisAgentKind = 'claude' | 'codex';

/** kind==='question' の選択肢1件。 */
export interface IParadisAgentQuestionOption {
	readonly label: string;
	readonly description?: string;
}

/**
 * tool_result に含まれていた画像1枚のメタ情報。実体（base64）はここには載せず、
 * モバイルがステップを開いたときの 'tool-image' 要求で初めて転送する。
 */
export interface IParadisAgentChatImage {
	/** 同一メッセージ内での並び順。'tool-image' 要求のキー（rev と組で1枚を指す）。 */
	readonly index: number;
	/** 'image/png' 等。モバイルは data URI の組み立てに使う。 */
	readonly mediaType: string;
	/** デコード後のおおよそのバイト数（モバイルの容量表示用）。 */
	readonly bytes: number;
	/**
	 * 大きすぎて実体を保持していない。モバイルは取り寄せを試みず、その旨を表示する
	 * （保持期限切れと区別するためのフラグ）。
	 */
	readonly oversize?: true;
}

/** モバイルへ送る正規化済みチャットメッセージ1件。 */
export interface IParadisAgentChatMessage {
	/** epoch内で単調増加する連番 (差分同期用)。 */
	readonly rev: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	/** kind==='tool_use' のときのツール名。 */
	readonly tool?: string;
	/** 元イベントの時刻 (epoch ms、取れた場合のみ)。 */
	readonly ts?: number;
	/** kind==='question' のとき: タブ見出し（AskUserQuestion の header）。 */
	readonly header?: string;
	/** kind==='question' のとき: 選択肢（TUIの表示順 = 番号キーの割り当て順）。 */
	readonly options?: readonly IParadisAgentQuestionOption[];
	/** kind==='question' のとき: 複数選択可能な質問か（TUIではトグル選択 + Enter確定）。 */
	readonly multiSelect?: boolean;
	/** kind==='question' | 'tool_result' のとき: 対応付け用の tool_use ID。
	 *  同じIDの tool_result が後続に現れたら質問は回答済み（モバイルはUIを非活性化する）。 */
	readonly toolUseId?: string;
	/** kind==='question' のとき: 同一 AskUserQuestion 呼び出しのグループキー。
	 *  複数質問はモバイル側でこのキーごとに1枚のステップ式カードへ集約され、
	 *  全問回答が揃ってから一括でTUIへ注入される（1問ごとのEnterはフォーム全体を
	 *  Submitしてしまうため）。 */
	readonly questionGroup?: string;
	/** kind==='question' のとき: グループ内の位置（0起点）。 */
	readonly questionIndex?: number;
	/** kind==='question' のとき: グループの総質問数。 */
	readonly questionCount?: number;
	/** kind==='peer_message': Claude Code Agent Teamsの送信元と要約。 */
	readonly peerName?: string;
	readonly peerSummary?: string;
	/** kind==='tool_result' のとき: ツールがエラーを返したか（transcriptの is_error）。 */
	readonly isError?: boolean;
	/**
	 * text が TOOL_TEXT_LIMIT / TEXT_LIMIT で切り詰められている。モバイルは 'tool-full'
	 * リクエストで全文を取り寄せられる（展開時のオンデマンド取得）。
	 */
	readonly truncated?: boolean;
	/**
	 * 画像のメタ情報。ツール結果に含まれていた画像（Readで読んだ画像、MCPのスクリーンショット、
	 * Codex の view_image）と、ユーザーが発言に貼った画像の両方で付く。
	 * 実体は 'tool-image' で別途取り寄せる。
	 */
	readonly images?: readonly IParadisAgentChatImage[];
}

/** transcript確定前に表示する一時的な実行状況。履歴revには含めず、常に最新値で置換する。 */
export interface IParadisAgentLiveState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: 'hook' | 'transcript' | 'codex-daemon' | 'pty';
	/** 現在の処理が始まった時刻（経過時間表示用）。 */
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly tool?: string;
	readonly detail?: string;
	/** MessageDisplay / daemon deltaで先出しする生成中テキスト。 */
	readonly text?: string;
	readonly final?: boolean;
	/** transcript/PTYが明示的に報告した経過秒。無ければstartedAtから算出する。 */
	readonly elapsedSeconds?: number;
	/** PTY等が表示した概算生成トークン数。 */
	readonly tokenCount?: number;
}

/** セッションのメタ情報（モバイルのエージェントタブに表示する）。 */
export interface IParadisAgentSessionInfo {
	/** モデル名（Claude: assistant行の message.model、Codex: turn_context.model）。 */
	readonly model?: string;
	/** reasoning effort（Codex: turn_context.effort、Claude: settings.json の既定値 + /effort の実行記録）。 */
	readonly effort?: string;
}

export type IParadisAgentInteraction =
	| { readonly kind: 'question'; readonly id: string }
	| {
		readonly kind: 'approval'; readonly id: string; readonly title?: string; readonly detail?: string;
		readonly choices?: readonly IParadisAgentApprovalChoice[];
	};

export function paradisIsCodexDaemonApprovalInteraction(interactionId: string): boolean {
	return interactionId.startsWith('codex:') || interactionId.startsWith('codex-status:');
}

/**
 * 現在モバイルへ提示すべき interaction を決める。未回答の質問を承認より優先する。
 *
 * 承認と質問はエージェント側で同時に成立しないが、tool_use_id を伴わない PermissionRequest から
 * 作られた pendingApproval は合成IDになり PostToolUse と一致しないためターン終了まで解除されない。
 * 承認を先に返していた頃は、それが後続の質問を覆い隠してモバイルからの回答が全て
 * stale-interaction で弾かれていた（「質問なのに許可/拒否しか出ず、押しても効かない」の実体）。
 *
 * 逆向きの固着（質問が承認を永久に覆う）を防ぐため、pendingQuestions 側にも
 * ターン終了での解除経路（ParadisAgentChatTailer.clearPendingQuestions）を用意してある。
 */
export function paradisPickCurrentInteraction(
	messages: readonly IParadisAgentChatMessage[],
	pendingQuestions: ReadonlySet<string>,
	pendingApproval: Extract<IParadisAgentInteraction, { readonly kind: 'approval' }> | undefined,
): IParadisAgentInteraction | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.kind === 'question' && message.toolUseId !== undefined && pendingQuestions.has(message.toolUseId)) {
			return { kind: 'question', id: message.questionGroup ?? message.toolUseId };
		}
	}
	return pendingApproval ?? null;
}



// ---- デスクトップのチャット表示が中継から会話を引く口 ---------------------------------------------
//
// モバイル中継のチャネル（PARADIS_MOBILE_RELAY_CHANNEL）にそのまま載る。読むだけで、モバイルへは
// 何も送らない。モバイル連携を無効にしていても中継は shared process で動いているので同じ値が引ける。

/** 差分取得の起点。前回受け取った {@link IParadisAgentChatView} の epoch と rev をそのまま渡す。 */
export interface IParadisAgentChatCursor {
	readonly epoch: string;
	readonly rev: number;
}

/** デスクトップのチャット表示が引く、1ペイン分の会話の写し。 */
export interface IParadisAgentChatView {
	readonly token: string;
	readonly agent: ParadisAgentKind;
	/** 会話の読み取りを始め直すたびに変わる識別子。変わったら手元の履歴は捨てる。 */
	readonly epoch: string;
	/** 次に振られる rev。次回の差分取得の起点になる。 */
	readonly rev: number;
	/** true なら messages は保持している全量（手元を置き換える）。false なら起点より後の差分だけ。 */
	readonly reset: boolean;
	readonly messages: readonly IParadisAgentChatMessage[];
	/** reset のとき、保持の上限でこれより前の会話が落ちている。 */
	readonly truncated?: boolean;
	readonly info?: IParadisAgentSessionInfo;
	/** 会話ログに書かれる前の、生成中・実行中の様子。 */
	readonly live: IParadisAgentLiveState | null;
	/** 利用者の回答を待っている質問・承認。 */
	readonly interaction: IParadisAgentInteraction | null;
	/** interaction が質問のとき、その質問群（TUI の質問順）。 */
	readonly pendingQuestions?: readonly IParadisAgentChatMessage[];
	/** エージェントがターンを処理している（入力待ちではない）。 */
	readonly busy: boolean;
}

/**
 * スラッシュコマンドの候補1件。モバイルへ送っているコマンド一覧（mobileRelay の
 * paradisBuildAgentCommandCatalog）と同じ形。
 */
export interface IParadisAgentChatCommand {
	readonly name: string;
	/** 入力欄へ入れる文字列（先頭の `/` を含む）。 */
	readonly insertText: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly kind: 'command' | 'skill' | 'prompt';
	readonly source: 'built-in' | 'user' | 'project';
}

/** 取り寄せた画像の実体。 */
export interface IParadisAgentChatImageData {
	readonly mediaType: string;
	/** base64。 */
	readonly data: string;
}

/**
 * shared process のモバイル中継サービスが追加で公開する、デスクトップのチャット表示向けの口（IPC 契約）。
 */
export interface IParadisAgentChatSource {
	/** 見ているペインの会話が変わった。受け取った側は該当するペインだけを取り直す。 */
	readonly onDidChangeAgentChat: Event<readonly string[]>;
	/**
	 * このウィンドウがチャット表示で見ているペインを知らせる。一定時間ごとに送り直す（送られなく
	 * なったウィンドウの分は期限で外れる）。見ている間は、モバイルとつないでいなくても質問・承認の
	 * 中身を hook から拾う。
	 */
	watchAgentChat(watcherId: string, tokens: readonly string[]): Promise<void>;
	/** 起点より後の差分（起点が合わなければ全量）。セッションが確定していないペインは undefined。 */
	getAgentChat(token: string, cursor: IParadisAgentChatCursor | undefined): Promise<IParadisAgentChatView | undefined>;
	/** 切り詰めて渡したメッセージの全文。保持期限を過ぎていれば undefined。 */
	getAgentChatFullText(token: string, epoch: string, rev: number): Promise<string | undefined>;
	/** メッセージに付いていた画像の実体。保持期限を過ぎていれば undefined。 */
	getAgentChatImage(token: string, epoch: string, rev: number, index: number): Promise<IParadisAgentChatImageData | undefined>;
	/** そのペインのエージェントで使えるスラッシュコマンド。 */
	getAgentChatCommands(token: string): Promise<readonly IParadisAgentChatCommand[]>;
	/**
	 * Codex の app-server 経由の承認（id が `codex:` で始まるもの）に答える。キーを打つ承認は
	 * 画面側が TUI へ打鍵するので、ここは通らない。答えられたら true。
	 */
	answerAgentChatApproval(token: string, interactionId: string, choiceId: string): Promise<boolean>;
	/**
	 * 質問・承認へ打鍵で答える前に、モバイルと同じ claim を取る（同じ interaction へ2か所から同時に
	 * 打鍵しないため）。取れなければ false。
	 */
	claimAgentChatInteraction(token: string, kind: 'question' | 'approval', id: string): Promise<boolean>;
	/** claim を返す。sent なら TUI が消費するまで（最長 60 秒）同じ interaction への回答を受け付けない。 */
	releaseAgentChatInteraction(token: string, kind: 'question' | 'approval', id: string, sent: boolean): Promise<void>;
}
