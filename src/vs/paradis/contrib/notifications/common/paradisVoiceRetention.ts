/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// worker へ渡した声の「控え」（worker が鳴らせなかったときに Para Code が鳴らし直すための音声）の、全体の上限。
// 通知の読み上げ（paradisVoiceHandoff）と SSH 先の声（paradisRemoteVoiceIngress）が 1 つの枠を分け合う。
// 枠を押さえられなかった声は控えずに手放す（鳴らし直しはできないが、手元のメモリは増えない）。

import { IParadisVoiceRetention } from './paradisVoiceIngest.js';

/** 控えの合計の上限。 */
export const PARADIS_VOICE_RETENTION_MAX_BYTES = 32 * 1024 * 1024;
/** 同時に控える本数の上限。 */
export const PARADIS_VOICE_RETENTION_MAX_COUNT = 16;

/** 控えの枠の全体。 */
export class ParadisVoiceRetentionBudget {
	private bytes = 0;
	private count = 0;

	constructor(
		private readonly maxBytes = PARADIS_VOICE_RETENTION_MAX_BYTES,
		private readonly maxCount = PARADIS_VOICE_RETENTION_MAX_COUNT,
	) { }

	/** 押さえているバイト数と本数（テスト用）。 */
	get usage(): { readonly bytes: number; readonly count: number } {
		return { bytes: this.bytes, count: this.count };
	}

	/** 1 本ぶんの枠を開く。本数の上限に当たっていれば undefined。 */
	open(): IParadisVoiceRetention | undefined {
		if (this.count >= this.maxCount) {
			return undefined;
		}
		this.count++;
		let held = 0;
		let released = false;
		return {
			grow: more => {
				if (released) {
					return false;
				}
				if (this.bytes + more > this.maxBytes) {
					return false;
				}
				this.bytes += more;
				held += more;
				return true;
			},
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.bytes -= held;
				held = 0;
				this.count--;
			},
		};
	}
}
