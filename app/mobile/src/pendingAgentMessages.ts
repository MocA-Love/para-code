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
 * 上限を越えた控えを掃除する間隔。照合は会話が更新されたときにしか走らないため、エージェントが
 * 黙ったままだと上限を越えた控えが残り続ける。控えがある間だけこの間隔で掃除する。
 */
export const PENDING_AGENT_MESSAGE_SWEEP_MS = 60 * 1000;

/** PC がユーザーの発言の本文を切り詰める長さ（PC の transcript parser の `TEXT_LIMIT`）。 */
const AGENT_TEXT_LIMIT = 6000;

/** PC が切り詰めた本文の末尾に付ける印。 */
// allow-any-unicode-next-line
const TRUNCATION_MARK = '…';

/**
 * Claude Code 2.1.278 以降が貼り付けた本文を包む形。PC の `src/vs/paradis/common/paradisPastedContent.ts` と
 * 同じ正規表現（変えるときは両方そろえる）。開きタグの前の改行 2 つと id を必須にし、閉じタグの id は後方参照で対にする。
 */
const PASTED_CONTENT_PATTERN = /\n\n<pasted_content id="(?<id>[^"]*)">\n(?<body>[\s\S]*?)\n<\/pasted_content id="\k<id>">\n?/g;

/**
 * 照合用に本文をそろえる。改行コード（CRLF）、行末の空白、前後の空白の違いを消す。
 * 古い PC は貼り付けの包み（`<pasted_content id="…">`）をそのまま送ってくるので、ここでも中身に展開する
 * （新しい PC は展開済みで送る）。包みの前後の区切りは PC と同じく改行 1 つにそろえるが、送った本文には
 * その区切りが無いので、照合そのものは `comparableText` で空白を無視して比べる。
 */
export function normalizeAgentMessageText(text: string): string {
	const unified = text.replace(/\r\n?/g, '\n');
	return unified
		.replace(PASTED_CONTENT_PATTERN, (match: string, _id: string, body: string, offset: number) =>
			`${offset > 0 ? '\n' : ''}${body}${offset + match.length < unified.length ? '\n' : ''}`)
		.replace(/[ \t]+$/gm, '')
		.trim();
}

/**
 * 照合に使う形。PC は貼り付けの包みの前後に区切りの改行を入れて返すが、送った本文にはそれが無いので、
 * 空白（改行を含む）をすべて除いて比べる。空白だけが違う別の発言を同じとみなすことになるが、
 * 控えを外すかどうかの判定にしか使わないので害は小さい。
 */
function comparableText(text: string): string {
	return normalizeAgentMessageText(text).replace(/\s+/g, '');
}

/**
 * 会話に現れた発言の本文が、送った本文と同じかどうか。PC は長い本文を `AGENT_TEXT_LIMIT` 文字で
 * 切って末尾に `…` を付けるので、その形のときは先頭が一致すれば同じとみなす。
 */
function matchesSentText(received: string, sent: string): boolean {
	const normalizedSent = comparableText(sent);
	if (comparableText(received) === normalizedSent) {
		return true;
	}
	if (received.length > AGENT_TEXT_LIMIT && received.endsWith(TRUNCATION_MARK)) {
		const prefix = comparableText(received.slice(0, -TRUNCATION_MARK.length));
		return prefix.length > 0 && normalizedSent.startsWith(prefix);
	}
	return false;
}

/** 上限を越えた控えを除いたものを返す（越えたものが無ければ同じ配列を返す）。 */
export function dropExpiredPendingMessages(pending: readonly PendingAgentMessage[], now: number): readonly PendingAgentMessage[] {
	const kept = pending.filter(entry => now - entry.sentAt <= PENDING_AGENT_MESSAGE_TTL_MS);
	return kept.length === pending.length ? pending : kept;
}

/**
 * 会話に現れた発言と突き合わせ、まだ読まれていない控えだけを返す。
 *
 * 照合は「送信より後に現れた」「本文が一致する」発言を1件ずつ消し込む形にする。本文は
 * `normalizeAgentMessageText` でそろえてから比べる。
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
			!consumed.has(message.rev) && message.rev > entry.afterRev && matchesSentText(message.text, entry.text));
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
	/** 上限を越えた控えを全ターミナルから外す（会話が更新されなくても定期的に呼ばれる）。 */
	sweepExpired(now: number): void;
}

/** 控えが無いターミナルで毎回新しい配列を返さないための共有の空配列。 */
export const NO_PENDING_MESSAGES: readonly PendingAgentMessage[] = [];

let sequence = 0;

/** 控えがある間だけ動かす掃除のタイマー。 */
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function updateSweepTimer(byTerminal: PendingAgentMessageStore['byTerminal']): void {
	const hasPending = Object.keys(byTerminal).length > 0;
	if (hasPending && sweepTimer === undefined) {
		sweepTimer = setInterval(() => usePendingAgentMessages.getState().sweepExpired(Date.now()), PENDING_AGENT_MESSAGE_SWEEP_MS);
	} else if (!hasPending && sweepTimer !== undefined) {
		clearInterval(sweepTimer);
		sweepTimer = undefined;
	}
}

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
	sweepExpired(now) {
		const current = get().byTerminal;
		let changed = false;
		const byTerminal: Record<string, readonly PendingAgentMessage[]> = {};
		for (const [terminalKey, entries] of Object.entries(current)) {
			const kept = dropExpiredPendingMessages(entries, now);
			changed ||= kept !== entries;
			if (kept.length > 0) {
				byTerminal[terminalKey] = kept;
			}
		}
		if (changed) {
			set({ byTerminal });
		}
	},
}));

// 控えが増えたらタイマーを動かし、空になったら止める（add / reconcile / sweepExpired のどれで変わっても）。
usePendingAgentMessages.subscribe(state => updateSweepTimer(state.byTerminal));
