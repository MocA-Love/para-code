/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホから届く書き込みの要求の、opId ごとの返事を覚える台帳。1 回目が断られた（busy・not_found など）のに返事が
// 届かず送り直されたとき、「当てた」と返さないよう、端末と opId の組ごとに 1 回目の返事を覚えて再送にも同じ返事を返す。
// 再送で返すのが成功の返事なら `duplicate: true` を足す（アプリは、それを受けたら読み直して確かめる）。
// 人の質問への回答（`ParadisMobileHumanAskOpResults`）と同じ約束で、返事の形を選ばない版。

/** opId ごとの返事を覚える件数（全モバイル合わせて。古いものから忘れる）。 */
export const PARADIS_MOBILE_OP_RESULT_LIMIT = 256;
/** opId ごとの返事を覚える期間。アプリの送り直しと中継の再送より十分長く。 */
export const PARADIS_MOBILE_OP_RESULT_TTL_MS = 10 * 60 * 1000;

/** 返事が断り（`{ error, code }`）か。 */
function isRefusal(reply: object): boolean {
	return Object.prototype.hasOwnProperty.call(reply, 'error');
}

/**
 * 端末と opId の組ごとの 1 回目の返事。覚えるのは返事の Promise で、1 回目が処理している最中の再送も同じ返事を待つ。
 * 1 回目が例外で終わったら忘れる（再送でやり直せる）。
 */
export class ParadisMobileOpResults {
	private readonly results = new Map<string, { readonly reply: Promise<object>; readonly at: number }>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly limit = PARADIS_MOBILE_OP_RESULT_LIMIT,
		private readonly ttlMs = PARADIS_MOBILE_OP_RESULT_TTL_MS,
	) { }

	/** 初めての opId なら `work` の返事を覚えて返し、覚えている opId なら 1 回目の返事を返す（`work` は呼ばない）。 */
	async run(mobileId: string, opId: string, work: () => Promise<object>): Promise<object> {
		const at = this.now();
		this.forgetExpired(at);
		const key = `${mobileId}\u0000${opId}`;
		const known = this.results.get(key);
		if (known !== undefined) {
			const reply = await known.reply;
			return isRefusal(reply) ? reply : { ...reply, duplicate: true };
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
