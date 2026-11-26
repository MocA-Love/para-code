/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisAgentChatDraftInsert } from '../common/paradisAgentChatComposerLogic.js';

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
	 * そのターミナルのエージェントへ発言を送る（チャット表示の入力欄から送るのと同じ確認を通る: 許可・質問の画面が出ている間・
	 * エージェントが前面にいない・空白だけの文は送らない。作業中なら TUI の待ち行列に入る）。送れたら undefined、送れなければ
	 * 理由の文。チャット表示を開いていなくても送れる。送った文はそのペインの入力欄の履歴に残る。
	 */
	sendMessageToPane(instanceId: number, text: string): Promise<string | undefined>;
}
