/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの「要対応」に「人が答えるもの」の台帳の 1 件を出す取り決め（human-ask.v1。設計 6 章の PR 6）。
//
// - PC → アプリ: Desktop State の任意項目 `humanAsks`（{@link IParadisMobileHumanAskSummary}。件数と、一覧が変わったかを
//   見分ける印だけ。中身は載せない）。スマホに見える一覧が変わったときだけ変わる
// - アプリ → PC: fs の `humanAsks`（今の一覧。{@link IParadisMobileHumanAsksReply}）と `humanAskAnswer`（答える。opId 付き）。
//   中身は要求した新しいアプリにだけ返るので、台帳の 1 件を知らない古いアプリには何も届かない
//
// スマホに出すのは、スマホの既存のカードに無いものだけ:
//  - 許可（ツールの承認）は出さない。スマホの既存の許可カード（ペインの画面から読んだもの）のまま
//  - ペインの質問（持ち主 `panes`）は出さない。スマホの既存の質問カードのまま
//  - ボード・Bot の 1 件がペインの待ちの寄せ先なら出さない（同じ待ちをスマホは既にペインの要対応として出している）
// 残るのは、ボードの質問・承認・止まった、Bot の質問、`ask_human` の質問。

import { StringSHA1 } from '../../../../base/common/hash.js';
import { IParadisHumanAskAction, IParadisHumanAskEntry, IParadisHumanAskFrom, IParadisHumanAskQuestion, IParadisHumanAskSnapshot, ParadisHumanAskKind, ParadisHumanAskSource, paradisHumanAskCounted } from '../../humanAsk/common/paradisHumanAsk.js';

export const PARADIS_MOBILE_HUMAN_ASKS_KIND = 'humanAsks';
export const PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND = 'humanAskAnswer';

/** ペインの質問・許可の持ち主（paradisHumanAskPane.ts の PARADIS_HUMAN_ASK_PANE_OWNER。スマホは既存のカードで出す）。 */
const PANE_OWNER = 'panes';
/** 1 回の一覧に載せる件数の上限。 */
export const PARADIS_MOBILE_HUMAN_ASKS_LIMIT = 100;
const OP_ID_LIMIT = 100;
const KEY_LIMIT = 450;

/** Desktop State の `humanAsks`。 */
export interface IParadisMobileHumanAskSummary {
	/** スマホに出す件数（要対応の数に足す）。 */
	readonly count: number;
	/** 一覧の印。変わったら fs の `humanAsks` で取り直す。 */
	readonly signature: string;
}

/** スマホに出す 1 件。ペインの鍵・窓・持ち主の名前は載せない。 */
export interface IParadisMobileHumanAsk {
	/** 台帳の鍵（`board:…`・`bot:<uid>.<eventId>`・`pane:ask:…`）。答えるときにそのまま返す。 */
	readonly key: string;
	readonly source: ParadisHumanAskSource;
	readonly kind: ParadisHumanAskKind;
	readonly from: IParadisHumanAskFrom;
	readonly preface?: string;
	readonly questions: readonly IParadisHumanAskQuestion[];
	/** ボタン。`confirm` があれば、押す前にその文で確かめる（ボードの画面・受信箱と同じ確認）。`allowText` なら文を添えられる。 */
	readonly actions: readonly IParadisHumanAskAction[];
	readonly canSkip: boolean;
	readonly askedAt: number;
	/** ほかの場所で答えて、届けている最中。 */
	readonly busy: boolean;
	/** 直前の答えが届かなかった。 */
	readonly failed: boolean;
}

export interface IParadisMobileHumanAsksReply {
	readonly t: typeof PARADIS_MOBILE_HUMAN_ASKS_KIND;
	readonly signature: string;
	readonly asks: readonly IParadisMobileHumanAsk[];
}

export interface IParadisMobileHumanAskAnswerRequest {
	readonly opId: string;
	readonly key: string;
	readonly answer: unknown;
}

export interface IParadisMobileHumanAskAnswerReply {
	readonly t: typeof PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND;
	readonly ok: boolean;
	/** 断った理由。`gone` はもう待っていない（ほかで答えた・取り下げ）、`busy` はほかの場所が届けている最中。 */
	readonly reason?: 'gone' | 'busy' | 'invalid' | 'unavailable';
	/** 同じ opId の 2 回目で、1 回目が答えを受けていた（2 回目は何もしていない）。断った 1 回目の再送は 1 回目と同じ返事のまま。 */
	readonly duplicate?: true;
}

/** スマホに出す 1 件か（件数・印・一覧のすべてがこれを通す）。 */
function visibleEntries(snapshot: IParadisHumanAskSnapshot): IParadisHumanAskEntry[] {
	const foldTargets = new Set<string>();
	for (const entry of snapshot.entries) {
		if (entry.foldedInto !== undefined) {
			foldTargets.add(entry.foldedInto);
		}
	}
	return snapshot.entries
		.filter(entry => paradisHumanAskCounted(entry) && entry.kind !== 'permission' && entry.owner !== PANE_OWNER && !foldTargets.has(entry.key))
		.slice(0, PARADIS_MOBILE_HUMAN_ASKS_LIMIT);
}

function toMobile(entry: IParadisHumanAskEntry): IParadisMobileHumanAsk {
	return {
		key: entry.key,
		source: entry.source,
		kind: entry.kind,
		from: entry.from,
		...(entry.preface !== undefined ? { preface: entry.preface } : {}),
		questions: entry.questions,
		actions: entry.actions,
		canSkip: entry.canSkip,
		askedAt: entry.askedAt,
		busy: entry.pending !== undefined,
		failed: entry.failedAt !== undefined,
	};
}

/** スマホに出す今の一覧。 */
export function paradisMobileHumanAsks(snapshot: IParadisHumanAskSnapshot): IParadisMobileHumanAsk[] {
	return visibleEntries(snapshot).map(toMobile);
}

/**
 * Desktop State に載せる件数と印。中身（問いの文など）は印に入れない。
 *
 * 届けられずに待ちへ戻った 1 件は、その時刻（`failedAt`）も印に混ぜる。一覧の 1 件は `failed` の真偽しか持たないため、
 * 前にも失敗した 1 件へ答え直してまた失敗すると一覧が答える前と同じに戻り、印が変わらずスマホが取り直さない
 * （カードが「答えた」のまま固まる）。一覧の 1 件の形は変えず、失敗の無いときの印は今までと同じ。
 */
export function paradisMobileHumanAskSummary(snapshot: IParadisHumanAskSnapshot): IParadisMobileHumanAskSummary {
	const entries = visibleEntries(snapshot);
	const asks = entries.map(toMobile);
	const sha = new StringSHA1();
	sha.update(JSON.stringify(asks));
	for (const entry of entries) {
		if (entry.failedAt !== undefined) {
			sha.update(`\u0000${entry.key}\u0000${entry.failedAt}`);
		}
	}
	return { count: asks.length, signature: sha.digest().slice(0, 16) };
}

export function paradisSameMobileHumanAskSummary(a: IParadisMobileHumanAskSummary | undefined, b: IParadisMobileHumanAskSummary | undefined): boolean {
	return a?.count === b?.count && a?.signature === b?.signature;
}

/** State の `humanAsks` を検める（renderer・shared process のどちらから来ても）。 */
export function paradisParseMobileHumanAskSummary(value: unknown): IParadisMobileHumanAskSummary | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const summary = value as { readonly count?: unknown; readonly signature?: unknown };
	return typeof summary.count === 'number' && Number.isSafeInteger(summary.count) && summary.count >= 0 && typeof summary.signature === 'string' && summary.signature.length > 0 && summary.signature.length <= 64
		? { count: summary.count, signature: summary.signature }
		: undefined;
}

/** fs の `humanAskAnswer` を検める。形が合わなければ undefined（答えの中身は台帳が問い・ボタンと突き合わせて検める）。 */
export function paradisParseMobileHumanAskAnswerRequest(value: unknown): IParadisMobileHumanAskAnswerRequest | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const request = value as { readonly opId?: unknown; readonly key?: unknown; readonly answer?: unknown };
	return typeof request.opId === 'string' && request.opId.length > 0 && request.opId.length <= OP_ID_LIMIT
		&& typeof request.key === 'string' && request.key.length > 0 && request.key.length <= KEY_LIMIT
		&& request.answer !== null && typeof request.answer === 'object' && !Array.isArray(request.answer)
		? { opId: request.opId, key: request.key, answer: request.answer }
		: undefined;
}

/** opId ごとの結果を覚える件数（全モバイル合わせて。古いものから忘れる）。 */
export const PARADIS_MOBILE_HUMAN_ASK_OP_RESULT_LIMIT = 256;
/** opId ごとの結果を覚える期間。アプリの送り直し（応答待ち 15 秒）と中継の再送より十分長く。 */
export const PARADIS_MOBILE_HUMAN_ASK_OP_RESULT_TTL_MS = 10 * 60 * 1000;

/**
 * `humanAskAnswer` の opId ごとの結果（同じモバイルの同じ opId）。
 *
 * 1 回目が断られた（busy・gone など）のに返事が届かず送り直された場合に「答えた」と返さないよう、1 回目の返事を覚えて
 * 再送にも同じ返事を返す（受けた 1 回目の再送だけ `duplicate: true` を足す）。覚えるのは返事の Promise で、1 回目が
 * 届けている最中の再送も同じ返事を待つ。1 回目が例外で終わったら忘れる（再送でやり直せる。二重に届けないのは台帳の claim）。
 */
export class ParadisMobileHumanAskOpResults {
	private readonly results = new Map<string, { readonly reply: Promise<IParadisMobileHumanAskAnswerReply>; readonly at: number }>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly limit = PARADIS_MOBILE_HUMAN_ASK_OP_RESULT_LIMIT,
		private readonly ttlMs = PARADIS_MOBILE_HUMAN_ASK_OP_RESULT_TTL_MS,
	) { }

	/** 初めての opId なら `work` の返事を覚えて返し、覚えている opId なら 1 回目の返事を返す（`work` は呼ばない）。 */
	async run(mobileId: string, opId: string, work: () => Promise<IParadisMobileHumanAskAnswerReply>): Promise<IParadisMobileHumanAskAnswerReply> {
		const at = this.now();
		this.forgetExpired(at);
		const key = `${mobileId}\u0000${opId}`;
		const known = this.results.get(key);
		if (known !== undefined) {
			const reply = await known.reply;
			return reply.ok ? { ...reply, duplicate: true } : reply;
		}
		const reply = work();
		const record = { reply, at };
		this.results.set(key, record);
		while (this.results.size > this.limit) {
			const oldest = this.results.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.results.delete(oldest);
		}
		try {
			return await reply;
		} catch (error) {
			if (this.results.get(key) === record) {
				this.results.delete(key);
			}
			throw error;
		}
	}

	private forgetExpired(now: number): void {
		// 入れた順 = 時刻の順なので、先頭から期限切れを捨てる
		for (const [key, record] of this.results) {
			if (now - record.at < this.ttlMs) {
				break;
			}
			this.results.delete(key);
		}
	}
}
