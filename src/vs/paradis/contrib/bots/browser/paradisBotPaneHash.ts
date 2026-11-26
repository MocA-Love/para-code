/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウの側で、Bot のペインをトークンのハッシュで探す。shared process はトークンの値をウィンドウへ渡さず、
// ハッシュ（SHA-256）だけを渡すので、ここで自分の生きたペインのトークンをハッシュにして照らす。

import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import type { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';

/** ペイントークンの SHA-256（16 進）。shared process の `paradisBotPaneTokenHash` と同じ値。 */
export async function paradisBotPaneTokenHashInWindow(paneToken: string): Promise<string> {
	return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paneToken)))));
}

/** このウィンドウの生きたペインのうち、ハッシュが合うもの。 */
export async function paradisBotInstancesInWindow(paneTokenService: Pick<IParadisPaneTokenService, 'listPaneTokens'>, hashes: readonly string[]): Promise<number[]> {
	if (hashes.length === 0) {
		return [];
	}
	const wanted = new Set(hashes);
	const matched: number[] = [];
	for (const { instanceId, token } of paneTokenService.listPaneTokens()) {
		if (wanted.has(await paradisBotPaneTokenHashInWindow(token))) {
			matched.push(instanceId);
		}
	}
	return matched;
}
