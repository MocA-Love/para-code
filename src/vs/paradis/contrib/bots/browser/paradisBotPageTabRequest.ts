/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの、次に見せるタブの頼み（帯の受け箱の印を押したら、そのページを「会話」で開く）。ページ（paradisBotPage.ts）は
// 開くとき・頼みが来たときにこれを読む。帯からページの部品を読み込まずに済むよう、頼みだけをここに置く。

import { Emitter, Event } from '../../../../base/common/event.js';
import { ParadisBotPageTab } from '../common/paradisBotPageModel.js';

const requested = new Map<string, ParadisBotPageTab>();
const onDidRequest = new Emitter<string>();

/** 頼みが来た Bot の id。 */
export const onDidRequestParadisBotPageTab: Event<string> = onDidRequest.event;

/** その Bot のページを、次はこのタブで見せてほしい。 */
export function paradisRequestBotPageTab(botId: string, tab: ParadisBotPageTab): void {
	requested.set(botId, tab);
	onDidRequest.fire(botId);
}

/** 頼まれたタブを取り出す（取り出したら消える）。 */
export function paradisTakeRequestedBotPageTab(botId: string): ParadisBotPageTab | undefined {
	const tab = requested.get(botId);
	requested.delete(botId);
	return tab;
}
