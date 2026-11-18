/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook から分かるペインのエージェントの状態を、ツールの呼び出しの外から読む口（shared process 内限定）。
// ツールの中では IParadisMcpToolCallContext の同じ 3 つ（getPaneAgentStatus・getUnconfirmedRelease・hasAgentHookHistory）
// を使う。資料のコメントは、ユーザーが書いた時や hook の時に届けるのでツールの呼び出しの外で状態が要る。
// ParadisAgentBrowserService から別の contrib を import しないよう、preview_file の口（paradisPreviewFileObservers.ts）と
// 同じ形の登録口にしている。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisMcpPaneAgentStatus } from '../common/paradisMcpToolProvider.js';

/** ペインのエージェントの状態を読む口（IParadisMcpToolCallContext の同じ名前のものと同じ意味）。 */
export interface IParadisPaneAgentStatusSource {
	getPaneAgentStatus(paneToken: string): IParadisMcpPaneAgentStatus | undefined;
	getUnconfirmedRelease(paneToken: string): 'pending' | 'unverifiable' | undefined;
	hasAgentHookHistory(paneToken: string): boolean;
}

let source: IParadisPaneAgentStatusSource | undefined;

/** 状態を持つ側（ParadisAgentBrowserService）が起動時に 1 回入れる。 */
export function paradisSetPaneAgentStatusSource(value: IParadisPaneAgentStatusSource): IDisposable {
	source = value;
	return toDisposable(() => {
		if (source === value) {
			source = undefined;
		}
	});
}

/** いまの口。まだ入っていなければ undefined（状態が分からないものとして扱う）。 */
export function paradisPaneAgentStatusSource(): IParadisPaneAgentStatusSource | undefined {
	return source;
}
