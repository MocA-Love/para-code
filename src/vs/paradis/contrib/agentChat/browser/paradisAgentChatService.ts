/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { ParadisAgentChatDraftInsert } from '../common/paradisAgentChatComposerLogic.js';
import { IParadisAgentChatHeaderState } from '../common/paradisAgentChatHeader.js';

export const IParadisAgentChatService = createDecorator<IParadisAgentChatService>('paradisAgentChatService');

/** デスクトップのチャット表示（実体は electron-browser の ParadisAgentChatController）。 */
export interface IParadisAgentChatService {
	readonly _serviceBrand: undefined;
	/**
	 * チャット表示とターミナル表示を切り替える。context はタブ列のボタンから渡される
	 * `{ groupId }`（無ければアクティブなグループのタブが対象）。
	 */
	toggleFromCommand(context: unknown): void;
	/**
	 * そのターミナルを、エージェントの会話が見つかり次第チャット表示へ切り替える（タブの「＋」の
	 * ランチャーの「チャットで起動」）。会話は最初のやりとりで見つかるので、`timeoutMs` の間に
	 * 見つからなければターミナル表示のまま false を返す。チャット表示を切っているときも false。
	 */
	openChatWhenReady(instanceId: number, timeoutMs: number): Promise<boolean>;
	/**
	 * そのターミナルのチャット表示の入力欄へ、送らずに下書きを入れる（Bot のホームの提案の「始める」など）。書きかけの文は
	 * 消さず、空行を挟んで後ろへ足す（`appended`）。見えていれば入力欄へフォーカスする。チャット表示でない・切っている・
	 * エージェントの会話が無いペインと、空白だけの文は何もせず false（呼ぶ側がターミナルへの貼り付けに落とす。空白だけの文を
	 * 貼っても害は無い）。
	 */
	insertDraft(instanceId: number, text: string): ParadisAgentChatDraftInsert | false;
	/**
	 * そのターミナルのチャット表示の見出しに出すもの（エージェント名・会話の記録から取ったモデルと強さ・状態の文・対応が要るか・
	 * 作業中か）。エージェントの会話が無いペインは undefined。変化は {@link onDidChangeHeader} で知らせる（会話の写しを
	 * 読んでいるペイン、つまりチャット表示を一度開いたペインだけ。チャット表示中のペインは会話が変わるたびに読み直す）。
	 */
	headerState(instanceId: number): IParadisAgentChatHeaderState | undefined;
	/** 見出しに出すものが変わったペイン（ターミナルのインスタンスの ID）。 */
	readonly onDidChangeHeader: Event<number>;
	/** そのターミナルを「ターミナルに戻る」と同じくターミナル表示へ戻し、ターミナルへフォーカスする。 */
	showTerminal(instanceId: number): void;
	/**
	 * そのターミナルのチャット表示の見出しを畳む（既定は畳まない）。畳んだ側は、見出しが出していた知らせ（許可待ちなど）を
	 * {@link headerState} から自分で出す。ターミナルへ戻る口も見出しと一緒に消えるので、{@link showTerminal} を呼べる所を置く。
	 */
	setHeaderHidden(instanceId: number, hidden: boolean): void;
}
