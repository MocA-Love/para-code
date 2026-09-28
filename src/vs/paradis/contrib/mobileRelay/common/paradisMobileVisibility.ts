/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アプリが裏に回った・前面に戻った知らせ（W2-34。notify チャネル M→PC）と、その確認（PC→M）。
// `app/protocol/src/notify.ts` の同名の定義を逐語で写したもの。片方を変えたら、もう片方と
// `app/protocol/test/visibilitySync.test.ts` も直すこと。
//
// アプリは裏に回ったとき、この PC が確認を返したときだけソケットを最大30秒保つ。受けた PC は、
// そのスマホを「前面ではない」とみなしてプッシュを送る（paradisNotifyDelivery.ts の `appBackgrounded`）。

export type NotifyVisibilityState = 'background' | 'foreground';

export type NotifyVisibilityMessage =
	| { readonly t: 'visibility'; readonly state: NotifyVisibilityState; readonly id?: string }
	| { readonly t: 'visibility-ack'; readonly state: NotifyVisibilityState; readonly id?: string };

const VISIBILITY_ID_MAX_LENGTH = 64;

export function encodeNotifyVisibility(state: NotifyVisibilityState, id?: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'visibility', state, ...(id !== undefined ? { id } : {}) }));
}

export function encodeNotifyVisibilityAck(state: NotifyVisibilityState, id?: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'visibility-ack', state, ...(id !== undefined ? { id } : {}) }));
}

/** notify チャネルの受信バイト列を W2-34 の知らせとして読む。違えば undefined。 */
export function decodeNotifyVisibility(bytes: Uint8Array): NotifyVisibilityMessage | undefined {
	try {
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as { t?: unknown; state?: unknown; id?: unknown };
		if ((raw.t !== 'visibility' && raw.t !== 'visibility-ack') || (raw.state !== 'background' && raw.state !== 'foreground')) {
			return undefined;
		}
		const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= VISIBILITY_ID_MAX_LENGTH ? raw.id : undefined;
		return { t: raw.t, state: raw.state, ...(id !== undefined ? { id } : {}) };
	} catch {
		return undefined;
	}
}
