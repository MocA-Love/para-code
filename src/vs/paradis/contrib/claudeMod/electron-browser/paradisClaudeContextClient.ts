/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process のコンテキストの内訳の保存（paradisClaudeContext.sharedProcess.ts）を呼ぶ薄いクライアント。
// 内訳は SSH 先のペインの mod からも手元の shared process へ届くので、SSH のウィンドウでも手元へ聞く。

import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisClaudeContextBreakdown, PARADIS_CLAUDE_CONTEXT_CHANNEL } from '../common/paradisClaudeContextBreakdown.js';

export class ParadisClaudeContextClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) { }

	private get channel(): IChannel {
		return this.sharedProcessService.getChannel(PARADIS_CLAUDE_CONTEXT_CHANNEL);
	}

	/** 動いている会話か、保存した内訳が変わった。 */
	get onDidChange(): Event<void> {
		return this.channel.listen<void>('onDidChange');
	}

	/** 動いている会話の内訳（新しい順）。 */
	live(): Promise<IParadisClaudeContextBreakdown[]> {
		return this.channel.call('live');
	}

	/** 会話の最後の内訳（保存したもの）。無ければ undefined。 */
	session(sessionId: string): Promise<IParadisClaudeContextBreakdown | undefined> {
		return this.channel.call('session', [sessionId]);
	}
}
