/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function equalBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
	if (left === undefined || left.byteLength !== right.byteLength) {
		return false;
	}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

/** Tracks the last successfully delivered Desktop State for one mobile session. */
export class ParadisMobileStateDelivery {
	private lastDelivered: Uint8Array | undefined;
	private generation = 0;

	/**
	 * payloadを配送する。`force`がfalseで直近の成功payloadと完全一致する場合だけ省略する。
	 * 送信成功後にのみコピーを記録し、実際に送信した場合はtrue、省略時はfalseを返す。
	 */
	async deliver(payload: Uint8Array, force: boolean, send: (payload: Uint8Array) => Promise<void>): Promise<boolean> {
		if (!force && equalBytes(this.lastDelivered, payload)) {
			return false;
		}

		const generation = this.generation;
		const snapshot = payload.slice();
		await send(snapshot);
		if (this.generation === generation) {
			this.lastDelivered = snapshot;
		}
		return true;
	}

	/**
	 * 暗号セッション境界で比較対象を破棄する。
	 * reset前に開始した送信が後から完了しても、新しい世代の比較対象には採用しない。
	 */
	reset(): void {
		this.generation++;
		this.lastDelivered = undefined;
	}
}
