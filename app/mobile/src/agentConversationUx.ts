// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { agentStatusKind } from './agentStatus.js';
import { isAttentionAgent } from './attentionCount.js';
import { sortWaiting } from './components/attentionStackBehavior.js';
import type { AgentInteraction } from './store.js';

/**
 * エージェント会話画面（app/agent.tsx）の導線の判定。画面から切り離してテストするための純関数群。
 */

/** 作業を終えたエージェントへの短い返信の既定。押したときの扱いは `quickReplyTapAction`。 */
export const QUICK_REPLIES: readonly string[] = ['続けて', 'テストも実行して', '変更点を要約して'];

/**
 * クイック返信を出すか。エージェントが手を空けている（未確認・待機）ときだけ出す。
 * 動いている最中・承認や質問を待っている最中に出すと、答えるべきものより先に目に入る。
 */
export function shouldShowQuickReplies(state: {
	readonly agentStatus: string | undefined;
	/** 実行中の表示が出ているか（live の途中経過が届いている間も含む）。 */
	readonly working: boolean;
	/** コンポーザー上に承認・質問のカードが出ているか。 */
	readonly hasPinnedCard: boolean;
	/** 会話を表示できているか（セッション未特定・読み込み中は出さない）。 */
	readonly chatReady: boolean;
	/** 入力欄が質問への回答入力に切り替わっているか。 */
	readonly answering: boolean;
}): boolean {
	const kind = agentStatusKind(state.agentStatus);
	return (kind === 'review' || kind === 'idle') && !state.working && !state.hasPinnedCard && state.chatReady && !state.answering;
}

/** クイック返信を入力欄へ入れた結果。書きかけがあれば後ろへ足す（消さない）。 */
export function appendQuickReply(current: string, reply: string): string {
	if (current.trim().length === 0) {
		return reply;
	}
	return /\s$/.test(current) ? current + reply : `${current} ${reply}`;
}

/** 引用する本文の上限（字）。長い発言を丸ごと入れて入力欄を埋めないように、越えた分は「…」にする。 */
export const QUOTE_REPLY_LIMIT = 1_200;

/**
 * 「引用して返信」で入力欄に入れる文。発言の各行の頭に `> ` を付け、書きかけがあればその後ろに空行を挟んで足す
 * （書きかけは消さない）。引用の後には空行を置き、続けて返信を書けるようにする。本文が空なら書きかけをそのまま返す。
 */
export function quoteReplyText(current: string, quoted: string): string {
	const body = quoted.replace(/\r\n?/g, '\n').trim();
	if (body.length === 0) {
		return current;
	}
	const chars = Array.from(body);
	const clipped = chars.length > QUOTE_REPLY_LIMIT ? `${chars.slice(0, QUOTE_REPLY_LIMIT).join('').trimEnd()}…` : body;
	const quote = clipped.split('\n').map(line => line.length > 0 ? `> ${line}` : '>').join('\n');
	const head = current.trimEnd();
	return `${head.length > 0 ? `${head}\n\n` : ''}${quote}\n\n`;
}

/**
 * クイック返信を押したときにすること。`send` は入力欄に入れてそのまま送る、`insert` は入力欄に足すだけ。
 *
 * 設定の「押したらすぐ送る」がオンでも、書きかけ（文字・添付）があるときは足すだけにする（未完成の文を送らない）。
 * 送信ボタンを押せない状態（送信中・PC の画面が開いている・回答の入力中）でも足すだけにして、送るかは利用者に任せる。
 */
export function quickReplyTapAction(state: {
	/** 設定の「押したらすぐ送る」。 */
	readonly sendOnTap: boolean;
	/** いまの入力欄の文字。 */
	readonly draft: string;
	/** 入力欄に付けている添付の数（アップロード中・失敗も含む）。 */
	readonly attachmentCount: number;
	/** 送信ボタンが押せない（送信中・PC の画面が開いている・回答の入力中など）。 */
	readonly sendBlocked: boolean;
}): 'send' | 'insert' {
	if (!state.sendOnTap || state.sendBlocked || state.draft.trim().length > 0 || state.attachmentCount > 0) {
		return 'insert';
	}
	return 'send';
}

/** 会話の1行のうち、質問カードにあたるものの最小限の形。 */
export interface QuestionRowLike {
	/** 回答の送り先ID（questionGroup ?? toolUseId）。 */
	readonly interactionId: string | undefined;
	readonly answered: boolean;
}

/**
 * コンポーザーの上に固定する質問カードが会話のどの行か。無ければ -1。
 *
 * 正本は PC 側の現在の要求（`interaction`）。その ID の未回答の行を選ぶ。interaction が
 * 届いていない（旧PC・attach直後）のに状態が「質問」のときだけ、最後の未回答の質問で代用する
 * （ホームの要対応カードと同じ代用規則）。質問以外の行は `undefined` で渡す。
 */
export function pinnedQuestionIndex(
	rows: readonly (QuestionRowLike | undefined)[],
	interaction: Pick<AgentInteraction, 'kind' | 'id'> | undefined,
	agentStatus: string | undefined,
): number {
	if (interaction?.kind === 'question') {
		return rows.findIndex(row => row !== undefined && !row.answered && row.interactionId === interaction.id);
	}
	if (interaction === undefined && agentStatus === 'question') {
		for (let index = rows.length - 1; index >= 0; index--) {
			const row = rows[index];
			if (row !== undefined && !row.answered) {
				return index;
			}
		}
	}
	return -1;
}

/** 要対応の判定と移動に要るターミナルの形。 */
export interface AttentionTerminalLike {
	readonly terminalKey: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

/**
 * いま開いているエージェント以外の要対応と、次に開く1件。
 *
 * 並びはホームの要対応と同じ（許可待ち→質問、同種はPCのターミナル順）。いま開いている
 * エージェントがその並びにいればその次から数え、末尾まで行ったら先頭へ戻る。
 * 件数と次の1件は同じ並びから出すので、「あと N 件」を押し続ければ全件を一巡できる。
 */
export function nextAttentionAgent<T extends AttentionTerminalLike>(terminals: readonly T[] | undefined, currentKey: string | undefined): { readonly count: number; readonly next: T | undefined } {
	const ordered = sortWaiting((terminals ?? []).filter(isAttentionAgent));
	const others = ordered.filter(terminal => terminal.terminalKey !== currentKey);
	if (others.length === 0) {
		return { count: 0, next: undefined };
	}
	const currentIndex = ordered.findIndex(terminal => terminal.terminalKey === currentKey);
	if (currentIndex < 0) {
		return { count: others.length, next: others[0] };
	}
	const next = ordered[(currentIndex + 1) % ordered.length];
	return { count: others.length, next };
}
