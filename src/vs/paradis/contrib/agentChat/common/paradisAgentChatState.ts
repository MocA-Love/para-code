/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップのチャット表示が手元に持つ会話の写しと、中継から届いた差分の当て方。

import { IParadisAgentChatCursor, IParadisAgentChatMessage, IParadisAgentChatView } from './paradisAgentChat.js';

/** 手元に持つ会話の写し。中継の {@link IParadisAgentChatView} から messages 以外を写したもの＋全履歴。 */
export interface IParadisAgentChatState extends Omit<IParadisAgentChatView, 'messages' | 'reset'> {
	readonly messages: readonly IParadisAgentChatMessage[];
}

/** 手元に持つメッセージの上限。長い会話でも画面の要素が増え続けないよう、古いものから捨てる。 */
export const PARADIS_AGENT_CHAT_MAX_MESSAGES = 1000;

/** 次に差分を取りに行く起点。 */
export function paradisAgentChatCursor(state: IParadisAgentChatState | undefined): IParadisAgentChatCursor | undefined {
	return state === undefined ? undefined : { epoch: state.epoch, rev: state.rev };
}

/**
 * 届いた差分を手元の写しへ当てる。全量（reset）なら置き換え、差分なら後ろへ足す。
 * 差分が手元と噛み合わない（別の epoch）ときは undefined を返すので、
 * 呼び出し側は起点なしで全量を取り直す。rev の連続は中継が保証する（起点の続きが欠けていれば全量で返す）。
 */
export function paradisApplyAgentChatView(state: IParadisAgentChatState | undefined, view: IParadisAgentChatView): IParadisAgentChatState | undefined {
	const { messages: incoming, reset, ...rest } = view;
	if (reset || state === undefined) {
		return reset ? { ...rest, messages: [...incoming] } : undefined;
	}
	if (state.epoch !== view.epoch) {
		return undefined;
	}
	// 念のため、既に持っている rev は捨てる（同じ差分を2回受け取っても二重にしない）。
	const fresh = incoming.filter(message => message.rev >= state.rev);
	const messages = fresh.length > 0 ? [...state.messages, ...fresh].slice(-PARADIS_AGENT_CHAT_MAX_MESSAGES) : state.messages;
	return { ...rest, messages, ...(messages.length < state.messages.length + fresh.length ? { truncated: true } : state.truncated ? { truncated: true } : {}) };
}
