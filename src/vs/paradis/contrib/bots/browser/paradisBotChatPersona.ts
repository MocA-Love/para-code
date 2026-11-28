/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の会話のチャット表示に渡す、その Bot の顔と、Para Code が送った指示の見分け。Bot のページ（起きている会話）と眠った会話の
// タブの両方が使う。

import { localize } from '../../../../nls.js';
import { IParadisAgentChatPersona } from '../../agentChat/browser/paradisAgentChatService.js';
import { IParadisBotSummary } from '../common/paradisBotsApi.js';
import { paradisBotFace } from '../common/paradisBotsBandModel.js';
import { paradisBotPromptLabel } from '../common/paradisBotTools.js';
import { renderParadisBotFace } from './paradisBotFace.js';

/** 顔の値（形・色・様子）が同じなら同じ物を返せるよう、比べる値も持たせる。 */
export interface IParadisBotChatPersona extends IParadisAgentChatPersona {
	readonly key: string;
}

/** その Bot の顔（帯と同じ部品。様子で動く）と、Para Code が送った指示の印。 */
export function paradisBotChatPersona(bot: Pick<IParadisBotSummary, 'id' | 'faceShape' | 'faceColor' | 'paused' | 'needsYou' | 'activity' | 'halt' | 'sleeping'>): IParadisBotChatPersona {
	const face = paradisBotFace(bot);
	return {
		key: `${face.shape}/${face.color}/${face.state}`,
		// 今の顔だけ様子で動かし小道具を出す。過去の発言の顔は形と色だけの静かな顔（並んだ顔が一斉に動かず、負荷も減る）
		renderFace: (parent, current) => { renderParadisBotFace(parent, current ? { ...face, props: 'all' } : { shape: face.shape, color: face.color, props: 'none', still: true }); },
		promptLabel: text => {
			const label = paradisBotPromptLabel(text);
			return label === 'greeting' ? localize('paradis.botChat.greetingPrompt', "Bot を作ったので、自己紹介を頼みました") : undefined;
		},
	};
}
