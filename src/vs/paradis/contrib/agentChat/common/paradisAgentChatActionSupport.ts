/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import type { IParadisProgramStatus } from '../../agentBrowser/common/paradisProgramStatus.js';
import { PARADIS_AGENT_DESCRIPTORS, type IParadisAgentDescriptor, type ParadisAgentKind } from './paradisAgentDescriptor.js';

/**
 * チャット欄（モバイル・PC）から、エージェントへどの操作を渡せるか。TUI へのキーで渡すエージェントは、
 * 実機でキーの働きを確かめたものだけ true にする（分からないキーは送らず、PC の端末で答えてもらう）。
 */
export interface IParadisAgentChatActionSupport {
	/** 発言を送る（入力欄へ貼り付けて Enter）。 */
	readonly sendMessage: boolean;
	/** 質問のカードに答える（選択肢を選ぶキー）。 */
	readonly answerQuestion: boolean;
	/** 許可の確認に答える（許可・拒否・番号の選択肢のキー）。 */
	readonly answerApproval: boolean;
	/** モデル・effort の切り替え（`action/claudeSetting`）。 */
	readonly settings: boolean;
}

const ALL: IParadisAgentChatActionSupport = { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true };

/**
 * エージェントごとの対応の表（種類ごとの記述 {@link PARADIS_AGENT_DESCRIPTORS} から導く）。
 * - Claude Code・Codex: キーの列を実機で確かめてある（paradisAgentQuestionKeys.ts・paradisAgentApprovalOptions.ts）
 * - OpenCode: キーではなく連携の API で渡す
 * - Antigravity CLI（agy 1.5.9）: 発言だけ。許可の画面と ask_question の画面で番号・矢印・Enter・Esc が何を選ぶかを
 *   まだ測っていないので、回答は送らない。発言も、入力を待っていると確かめられるときだけ送る
 *   （{@link paradisAntigravitySendBlock}）
 */
const SUPPORT: Readonly<Record<ParadisAgentKind, IParadisAgentChatActionSupport>> = {
	claude: supportOf(PARADIS_AGENT_DESCRIPTORS.claude),
	codex: supportOf(PARADIS_AGENT_DESCRIPTORS.codex),
	opencode: supportOf(PARADIS_AGENT_DESCRIPTORS.opencode),
	antigravity: supportOf(PARADIS_AGENT_DESCRIPTORS.antigravity),
};

/** 記述の経路から、いつでも渡せる操作を導く。`hook` は待っている間だけの経路なので数えない（入口が別に確かめる）。 */
function supportOf(descriptor: IParadisAgentDescriptor): IParadisAgentChatActionSupport {
	return {
		sendMessage: descriptor.send.length > 0,
		answerQuestion: descriptor.answerQuestion.length > 0,
		answerApproval: descriptor.answerApproval.some(route => route !== 'hook'),
		settings: descriptor.modelControl === 'mod-or-keys',
	};
}

/** そのエージェントにチャット欄から渡せる操作。種類が分からないときは Claude Code と同じ（今までの扱い）。 */
export function paradisAgentChatActionSupport(agent: ParadisAgentKind | undefined): IParadisAgentChatActionSupport {
	return agent === undefined ? ALL : SUPPORT[agent];
}

/** モデル・effort を変えられないエージェントの設定を変えようとしたときの断りの文（モバイル向け）。 */
export const PARADIS_AGENT_SETTINGS_ON_PC_MESSAGE = 'このエージェントのモデルと effort は、アプリからは変えられません。PC のターミナルで変えてください';

/** 回答を送れないエージェントの質問・確認に答えようとしたときの断りの文（モバイル向け。PC は nls の文を使う）。 */
export const PARADIS_ANTIGRAVITY_ANSWER_ON_PC_MESSAGE = 'Antigravity CLI の質問・確認には、まだアプリから答えられません。PC の端末で答えてください';

/**
 * Antigravity CLI の許可の確認は、許可の hook が答えを待っているとき（paradisAntigravityApprovalHold.ts）だけアプリと PC の
 * カードから答えられる（表の `answerApproval` は false のまま。待っていないときの断りの文）。
 */
export const PARADIS_ANTIGRAVITY_APPROVAL_ON_PC_MESSAGE = 'この確認にはアプリから答えられません。PC の端末で答えてください';

/** Antigravity CLI へ発言を送れない理由。 */
export type ParadisAntigravitySendBlock = 'not-running' | 'working' | 'permission' | 'question' | 'multiline';

/** {@link paradisAntigravitySendBlock} が見る、ペインの今の様子。 */
export interface IParadisAntigravitySendState {
	/** 前面で agy が対話の画面を開いているか。分からない（シェル統合が無い等）は false として渡す。 */
	readonly agyInForeground: boolean;
	/** ペインの状態（OSC 7501 と hook から決めたもの）。 */
	readonly status: ParadisAgentStatus | undefined;
	/** 会話の写しで、質問（ask_question）の回答を待っている。 */
	readonly pendingInteraction: boolean;
	/** 送る文が改行を含む。 */
	readonly multiline: boolean;
	/** TUI が貼り付けの囲み（bracketed paste）を有効にしている。 */
	readonly bracketedPaste: boolean;
}

/**
 * Antigravity CLI へ発言（貼り付け + Enter）を送ってよいか。送れなければ理由を返す。
 *
 * agy の TUI がどのキーで何をするかは実機で測っていないので、入力欄で待っていると確かめられるときだけ送る:
 * - 前面が agy でない（終わってシェルに戻った）と、文がシェルのコマンドとして実行される
 * - 許可待ち（OSC 7501 の `blocked:kind=permission`）・質問中は、Enter が画面の選択肢を確定しうる。agy には許可待ちの
 *   hook が無いので、会話の写しの承認ではなくペインの状態で見る
 * - 作業中に打った文を agy が後に回すのか、中断として扱うのかは分からない
 * - 貼り付けの囲みが無いと、改行ごとに Enter として届く
 */
export function paradisAntigravitySendBlock(state: IParadisAntigravitySendState): ParadisAntigravitySendBlock | undefined {
	if (!state.agyInForeground) {
		return 'not-running';
	}
	if (state.status === 'permission') {
		return 'permission';
	}
	if (state.status === 'question' || state.pendingInteraction) {
		return 'question';
	}
	if (state.status === 'working') {
		return 'working';
	}
	if (state.multiline && !state.bracketedPaste) {
		return 'multiline';
	}
	return undefined;
}

/**
 * 文を打つ直前に見る Antigravity CLI のペインの状態。状態の帳簿（`stored`。shared process から 2 秒ごとに取り直す）は、
 * 許可の画面が出た直後はまだ古いので、この端末が最後に受け付けた OSC 7501 の状態（`latest`）が許可待ち・質問中・
 * 作業中ならそちらを使う。それ以外（入力待ち・完了・知らせが無い）は帳簿のまま。
 */
export function paradisAntigravityPaneStatus(stored: ParadisAgentStatus | undefined, latest: IParadisProgramStatus | undefined): ParadisAgentStatus | undefined {
	if (latest?.app !== 'antigravity') {
		return stored;
	}
	if (latest.state === 'blocked') {
		return latest.kind === 'question' ? 'question' : 'permission';
	}
	return latest.state === 'working' ? 'working' : stored;
}

/**
 * ペインの前面の Antigravity CLI が、アプリが見ている会話を開いていると確かめられなかったときの断りの文（モバイル向け）。
 * 同じターミナルで agy を始め直した後は、新しい会話の hook が最初の発言まで来ない（paradisAntigravityPaneHoldsConversation）。
 */
export const PARADIS_ANTIGRAVITY_OTHER_CONVERSATION_MESSAGE = 'PC の端末の Antigravity CLI がこの会話を開いていると確かめられなかったため、送りませんでした。PC の端末かターミナル表示で 1 回発言すると、また送れます';

/** {@link paradisAntigravitySendBlock} の理由ごとの断りの文（モバイル向け。PC は nls の文を使う）。 */
export const PARADIS_ANTIGRAVITY_SEND_BLOCK_MESSAGES: Readonly<Record<ParadisAntigravitySendBlock, string>> = {
	'not-running': 'PC の端末で Antigravity CLI が動いていることを確かめられなかったため、送りませんでした',
	'working': 'Antigravity CLI が作業中です。終わってから送ってください',
	'permission': 'Antigravity CLI が PC の端末で許可の確認を待っています。PC の端末で答えてから送ってください',
	'question': 'Antigravity CLI が PC の端末で質問の回答を待っています。PC の端末で答えてから送ってください',
	'multiline': 'いまは Antigravity CLI へ複数行の文を送れません。1 行にして送ってください',
};
