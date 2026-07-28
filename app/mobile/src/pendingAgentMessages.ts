// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';

/**
 * 「送ったが、エージェントがまだ読んでいない」メッセージの控え。
 *
 * 送信した本文はPC側でエージェントの入力欄へ貼り付けてEnterまで打つが、エージェントが
 * 作業中の場合は自分の順番待ちに積み、いまの作業を終えてから読む。モバイルの会話は
 * エージェントの記録を写しているだけなので、**読まれるまで会話には現れない**。
 * 控えが無いと送信した瞬間に本文がどこにも無くなり、送れたのかも分からなくなるため、
 * ここで預かって「送信予定」として見せる。
 *
 * 記録に同じ本文の発言が現れたら（＝読まれたら）控えを外す。エージェントへ渡した後なので
 * 取り消しはできない。あくまで見えなくなる時間を埋めるための控え。
 */

/** 送信済みだが、まだ会話に現れていない1件。 */
export interface PendingAgentMessage {
	readonly id: string;
	readonly text: string;
	readonly sentAt: number;
	/** 送信時点の最後の rev。これより後に現れた発言だけを照合の対象にする。 */
	readonly afterRev: number;
	/** 送信時のセッション。セッションが変わると順番待ちごと消えるため、控えも捨てる。 */
	readonly epoch: string;
}

/** 照合に使う会話側の発言。 */
export interface AgentUserMessage {
	readonly rev: number;
	readonly text: string;
}

/**
 * 控えを持ち続ける上限。読まれずに消えた場合（セッションの異常終了など）に
 * 「送信予定」が永久に居座らないための安全弁で、通常はここに達する前に外れる。
 */
export const PENDING_AGENT_MESSAGE_TTL_MS = 60 * 60 * 1000;

/**
 * 会話に現れた発言と突き合わせ、まだ読まれていない控えだけを返す。
 *
 * 照合は「送信より後に現れた」「本文が一致する」発言を1件ずつ消し込む形にする。
 * 同じ本文を2回送った場合に1件だけ外れるようにするため、消し込んだ発言は使い回さない。
 */
export function reconcilePendingMessages(
	pending: readonly PendingAgentMessage[],
	epoch: string | undefined,
	userMessages: readonly AgentUserMessage[],
	now: number,
): PendingAgentMessage[] {
	const consumed = new Set<number>();
	const kept: PendingAgentMessage[] = [];
	for (const entry of pending) {
		if (epoch === undefined || entry.epoch !== epoch || now - entry.sentAt > PENDING_AGENT_MESSAGE_TTL_MS) {
			continue;
		}
		const match = userMessages.find(message =>
			!consumed.has(message.rev) && message.rev > entry.afterRev && message.text.trim() === entry.text.trim());
		if (match !== undefined) {
			consumed.add(match.rev);
			continue;
		}
		kept.push(entry);
	}
	return kept;
}

interface PendingAgentMessageStore {
	readonly byTerminal: Readonly<Record<string, readonly PendingAgentMessage[]>>;
	add(terminalKey: string, text: string, afterRev: number, epoch: string): void;
	/** 会話の更新のたびに呼ぶ。読まれた控えを外す。 */
	reconcile(terminalKey: string, epoch: string | undefined, userMessages: readonly AgentUserMessage[]): void;
}

/** 控えが無いターミナルで毎回新しい配列を返さないための共有の空配列。 */
export const NO_PENDING_MESSAGES: readonly PendingAgentMessage[] = [];

let sequence = 0;

export const usePendingAgentMessages = create<PendingAgentMessageStore>()((set, get) => ({
	byTerminal: {},
	add(terminalKey, text, afterRev, epoch) {
		const entry: PendingAgentMessage = { id: `pending-${++sequence}`, text, sentAt: Date.now(), afterRev, epoch };
		// 直前の値は更新関数の中で読む（同じtickに2件送られても取りこぼさない）。
		set(state => ({ byTerminal: { ...state.byTerminal, [terminalKey]: [...(state.byTerminal[terminalKey] ?? NO_PENDING_MESSAGES), entry] } }));
	},
	reconcile(terminalKey, epoch, userMessages) {
		const current = get().byTerminal[terminalKey];
		if (current === undefined || current.length === 0) {
			return;
		}
		const kept = reconcilePendingMessages(current, epoch, userMessages, Date.now());
		if (kept.length === current.length) {
			return; // 参照を保って再描画を起こさない
		}
		set(state => {
			const byTerminal = { ...state.byTerminal };
			// 空になったターミナルは消す（閉じたターミナルのぶんが残り続けないように）。
			if (kept.length === 0) {
				delete byTerminal[terminalKey];
			} else {
				byTerminal[terminalKey] = kept;
			}
			return { byTerminal };
		});
	},
}));
