/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Desktop State へ載せる Bot の一覧（`bots.page.v1`）の受け口。shared process の中だけで使う。
// Bot の台帳（bots/node/paradisBotsMobileFeed.ts）が値を置き、中継（paradisMobileRelayService.ts）が読んで State に載せる。
// どちらが先に作られても困らないよう、値は置いた側がいなくなるまでここに残す。

import { Emitter, Event } from '../../../../base/common/event.js';
import type { IParadisMobileBot } from '../common/paradisMobileRelay.js';

export interface IParadisMobileBotsFeed {
	readonly bots: readonly IParadisMobileBot[];
	/** そのペインのトークンの Bot（Bot のペインでなければ undefined）。 */
	botOfToken(paneToken: string): string | undefined;
	/** ペインと Bot の結び付きが変わったかを見分ける印（同じなら同じ文字列）。 */
	readonly panesKey: string;
}

let current: IParadisMobileBotsFeed | undefined;
const onDidChange = new Emitter<void>();

/** Bot の一覧が変わった。 */
export const onDidChangeParadisMobileBots: Event<void> = onDidChange.event;

/** 今の Bot の一覧（設定がオフ・台帳がまだ無いなら undefined）。 */
export function paradisMobileBotsFeed(): IParadisMobileBotsFeed | undefined {
	return current;
}

/** Bot の一覧を置き換える（undefined で State から外す）。 */
export function paradisPublishMobileBots(feed: IParadisMobileBotsFeed | undefined): void {
	current = feed;
	onDidChange.fire();
}
