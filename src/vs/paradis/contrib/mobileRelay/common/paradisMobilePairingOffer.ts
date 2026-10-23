/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** スマホがペアリングで名乗った長期公開鍵と名前。 */
export interface IParadisPairingOffer {
	readonly pubKey: Uint8Array;
	readonly name?: string;
}

/** 確認の番号（SAS）を出した要求。承認されたら、この鍵と名前で端末を登録する。 */
export interface IParadisPairingShownOffer extends IParadisPairingOffer {
	readonly sasCode: string;
}

/**
 * 1 回のペアリング（1 つの QR）で、確認の番号を出す要求を 1 つだけに決める。
 *
 * 確認の番号の計算は非同期なので、計算を待つ間に 2 件目の要求が来ても、最初の要求の鍵・名前・番号は
 * その要求のものとして持ち続ける（共有の欄を書き換えると、番号で確かめた端末とは別の鍵が登録される）。
 * 最初の要求が番号の計算に失敗したときだけ、次の要求を受け付ける。
 */
export class ParadisPairingOfferSlot {
	private claimed = false;
	private shownOffer: IParadisPairingShownOffer | undefined;

	/** 確認の番号を出した要求（まだ無ければ undefined）。 */
	get shown(): IParadisPairingShownOffer | undefined {
		return this.shownOffer;
	}

	/**
	 * 要求を受ける。最初の要求なら確認の番号を計算して返し、既に別の要求を受けていれば undefined を返す
	 * （その要求の鍵は使わない）。
	 */
	async offer(offer: IParadisPairingOffer, deriveSasCode: (pubKey: Uint8Array) => Promise<string>): Promise<IParadisPairingShownOffer | undefined> {
		if (this.claimed) {
			return undefined;
		}
		// await の前に取る。番号の計算を待つ間に来た要求はここで断られる
		this.claimed = true;
		let sasCode: string;
		try {
			sasCode = await deriveSasCode(offer.pubKey);
		} catch (err) {
			this.claimed = false;
			throw err;
		}
		this.shownOffer = { pubKey: offer.pubKey, ...(offer.name !== undefined ? { name: offer.name } : {}), sasCode };
		return this.shownOffer;
	}
}
