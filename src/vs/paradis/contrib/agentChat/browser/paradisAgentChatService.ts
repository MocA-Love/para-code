/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisAgentChatDraftInsert } from '../common/paradisAgentChatComposerLogic.js';
import { IParadisAgentChatHeaderState } from '../common/paradisAgentChatHeader.js';
import { IParadisAgentChatGuide } from '../common/paradisAgentChat.js';

/**
 * チャット表示に出す、ペインの持ち主（Bot など）の顔と、Para Code が送った指示の見分け（{@link IParadisAgentChatService.setChatPersona}）。
 * agentChat は Bot を知らないので、Bot の側がこの形で渡す。
 */
export interface IParadisAgentChatPersona {
	/**
	 * エージェントの発言の左の顔を描く（エージェントの種類のロゴの代わり）。様子が変わったら、持ち主が新しいものを渡し直す。
	 * `current` は今の様子を表す顔（いちばん新しい発言・生成中の返答）か。過去の発言の顔は動かさない静かな顔にする。
	 */
	renderFace(parent: HTMLElement, current: boolean): void;
	/** Para Code が送った指示なら、利用者の発言の吹き出しの代わりに出す短い印の文。利用者が打った文なら undefined。 */
	promptLabel(text: string): string | undefined;
}

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
	 * そのターミナルを、いつもチャット表示にするペインとして控え、チャット表示にする（Bot の会話のペイン）。会話が見つかる前でも
	 * 切り替え、見つかるまでは {@link setChatGuide} の案内を出す。利用者がターミナルを開いた後も控えは残り、もう一度呼ぶと
	 * チャット表示へ戻る。フォーカスは `moveFocus` で、そのタブが前に出ているときだけ入力欄へ移す。チャット表示の設定（`paradis.agentChat.enabled`）を
	 * オフにしていても控える（その設定は Bot でないペインにだけ効く）。`show` を false にすると、控えるだけで表示は切り替えない
	 * （利用者がその Bot でターミナルを選んでいたとき。既定は true）。
	 */
	pinChatMode(instanceId: number, moveFocus: boolean, show?: boolean): void;
	/** {@link pinChatMode} で控えたペインか（チャット表示の設定に関わらない）。 */
	isChatPinned(instanceId: number): boolean;
	/**
	 * そのペインをチャット表示に切り替えているか（会話の有無に関わらない。{@link isChatActive} は会話が無いと false）。利用者が
	 * 選んだ表示を覚えるときに使う。変化は {@link onDidChangeChatActive} で知らせる。
	 */
	isChatMode(instanceId: number): boolean;
	/** そのペインで会話が見つかるまで出す案内を差し替える（undefined で消す）。ペインが閉じたら忘れる。 */
	setChatGuide(instanceId: number, guide: IParadisAgentChatGuide | undefined): void;
	/** そのペインのチャット表示に出す顔と指示の見分けを差し替える（undefined で戻す）。ペインが閉じたら忘れる。 */
	setChatPersona(instanceId: number, persona: IParadisAgentChatPersona | undefined): void;
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
	/**
	 * そのターミナルが今チャット表示で見えているか（チャット表示に切り替えていて、エージェントの会話がある）。エディタの
	 * ターミナルの入れ物に `paradis-agent-chat-active` を付けるのと同じ判定。変化は {@link onDidChangeChatActive} で知らせる。
	 */
	isChatActive(instanceId: number): boolean;
	/** {@link isChatActive} が変わったペイン（ターミナルのインスタンスの ID）。 */
	readonly onDidChangeChatActive: Event<number>;
	/** そのターミナルを「ターミナルに戻る」と同じくターミナル表示へ戻し、ターミナルへフォーカスする。 */
	showTerminal(instanceId: number): void;
	/**
	 * そのターミナルのチャット表示の見出しを畳む（既定は畳まない）。返り値を dispose すると戻る（ほかに畳んでいる側が
	 * いなければ）。ペインが閉じた・チャット表示が閉じた・別の会話に替わったときは、dispose を待たずに戻る（その後の
	 * dispose は何もしない。また畳みたければ呼び直す）。畳んだ側は、見出しが出していた知らせ（許可待ちなど）を
	 * {@link headerState} から自分で出す。ターミナルへ戻る口も見出しと一緒に消えるので、{@link showTerminal} を呼べる所を置く。
	 */
	setHeaderHidden(instanceId: number): IDisposable;
	/**
	 * そのターミナルのエージェントへ発言を送る（チャット表示の入力欄から送るのと同じ確認を通る: 許可・質問の画面が出ている間・
	 * エージェントが前面にいない・空白だけの文は送らない。作業中なら TUI の待ち行列に入る）。送れたら undefined、送れなければ
	 * 理由の文。チャット表示を開いていなくても送れる。送った文はそのペインの入力欄の履歴に残る。
	 */
	sendMessageToPane(instanceId: number, text: string): Promise<string | undefined>;
	/** チャット表示とターミナル表示を切り替えるキーの表記（ホバーに出す）。割り当てが無ければ undefined。 */
	getToggleKeybindingLabel(): string | undefined;
}
