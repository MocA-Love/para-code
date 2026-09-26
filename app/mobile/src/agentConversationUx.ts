// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { agentStatusKind } from './agentStatus.js';
import { isAttentionAgent } from './attentionCount.js';
import { sortWaiting } from './components/attentionStackBehavior.js';
import type { AgentInteraction } from './store.js';

/**
 * エージェント会話画面（app/agent.tsx）の導線の判定。画面から切り離してテストするための純関数群。
 */

/** 作業を終えたエージェントへの短い返信。押すと入力欄へ入る（送信はしない）。 */
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
