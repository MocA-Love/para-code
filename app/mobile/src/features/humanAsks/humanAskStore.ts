// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 要対応の台帳の 1 件の一覧（PC ごと）と、答える口。
 *
 * 一覧は PC の State の印（`humanAsks.signature`）が変わったときだけ fs の `humanAsks` で取り直す（{@link useHumanAskSync}）。
 * 答えは {@link answerHumanAsk} を通す。Bot のページ（PR 16）も同じ関数を、台帳の鍵（`bot:<uid>.<eventId>`）で呼ぶ。
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { sendPcRequest, type PcSummary } from '../../appState.js';
import {
	humanAskAnswerRequest,
	humanAskDuplicateOutcome,
	humanAsksRequest,
	newHumanAskOpId,
	parseHumanAskAnswerReply,
	parseHumanAsksReply,
	type HumanAsk,
	type HumanAskAnswer,
	type HumanAskAnswerOutcome,
} from './humanAsks.js';

const LIST_TIMEOUT_MS = 10_000;
const ANSWER_TIMEOUT_MS = 15_000;

interface HumanAskList {
	readonly signature: string;
	readonly asks: readonly HumanAsk[];
}

interface HumanAskState {
	/** PC ごとの最後に取れた一覧。 */
	readonly byPc: Readonly<Record<string, HumanAskList>>;
}

export const useHumanAsks = create<HumanAskState>(() => ({ byPc: {} }));

/** 取り直し中の印（同じ印を二重に取りに行かない）。 */
const fetching = new Map<string, string>();

function setList(pcId: string, list: HumanAskList | undefined): void {
	useHumanAsks.setState(state => {
		if (list === undefined) {
			if (!(pcId in state.byPc)) {
				return state;
			}
			const { [pcId]: _removed, ...rest } = state.byPc;
			return { byPc: rest };
		}
		return { byPc: { ...state.byPc, [pcId]: list } };
	});
}

/** その PC の一覧を印を見ずに取り直して入れる。取れなければ undefined（前の一覧のまま）。 */
async function fetchHumanAsks(pcId: string): Promise<HumanAskList | undefined> {
	try {
		const reply = parseHumanAsksReply(await sendPcRequest(pcId, 'fs', humanAsksRequest(), { timeoutMs: LIST_TIMEOUT_MS }));
		if (reply !== undefined) {
			setList(pcId, reply);
		}
		return reply;
	} catch {
		return undefined;
	}
}

/** その PC の一覧を取り直す（印が今のものと同じなら何もしない）。 */
export async function refreshHumanAsks(pcId: string, signature: string): Promise<void> {
	if (useHumanAsks.getState().byPc[pcId]?.signature === signature || fetching.get(pcId) === signature) {
		return;
	}
	fetching.set(pcId, signature);
	try {
		// 取れなければ前の一覧のまま（次の印の変化か、画面を開き直したときにまた取る）
		await fetchHumanAsks(pcId);
	} finally {
		if (fetching.get(pcId) === signature) {
			fetching.delete(pcId);
		}
	}
}

/**
 * 答える。`opId` は押し直しで同じ答えを 2 回届けないための id で、同じ答えを送り直すときは同じ値を渡す。
 * 届かなければ `reason: 'unavailable'`。
 *
 * PC が `duplicate`（同じ opId の 2 回目）と返したら、それだけで「答えた」にはせず、一覧を取り直して確かめる
 * （{@link humanAskDuplicateOutcome}）。まだ待っていれば `reason: 'unconfirmed'`。
 */
export async function answerHumanAsk(pcId: string, key: string, answer: HumanAskAnswer, opId: string = newHumanAskOpId()): Promise<HumanAskAnswerOutcome> {
	let outcome: HumanAskAnswerOutcome;
	try {
		outcome = parseHumanAskAnswerReply(await sendPcRequest(pcId, 'fs', humanAskAnswerRequest(opId, key, answer), { timeoutMs: ANSWER_TIMEOUT_MS }));
	} catch {
		return { ok: false, reason: 'unavailable' };
	}
	if (outcome.ok && outcome.duplicate === true) {
		return humanAskDuplicateOutcome((await fetchHumanAsks(pcId))?.asks, key);
	}
	return outcome;
}

/** 印の変化に合わせて、つながっている PC の一覧を取り直す。0 件・未対応になった PC の一覧は捨てる。 */
export function useHumanAskSync(pcs: readonly PcSummary[]): void {
	const keys = pcs.map(pc => `${pc.id}\u0000${pc.connection}\u0000${pc.humanAskSupported === true ? pc.humanAsks?.signature ?? '' : '-'}`).join('\u0001');
	useEffect(() => {
		for (const pc of pcs) {
			if (pc.humanAskSupported !== true || pc.humanAsks === undefined) {
				setList(pc.id, undefined);
				continue;
			}
			if (pc.connection === 'online') {
				void refreshHumanAsks(pc.id, pc.humanAsks.signature);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keys]);
}
