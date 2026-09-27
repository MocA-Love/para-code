/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップのチャット表示から、ターミナルの TUI へ文・回答を入れる。
//
// モバイルと違い、利用者はその場でターミナルを見られる。そのため「確かめられないなら送らない」に倒す:
//  - 文は、エージェントが前面で動いていて、回答待ちの画面が出ていないと確かめてから送る
//  - 質問・許可の回答は、画面に目印（選択肢のラベル・許可の確認の文言）が出たのを確かめてから打鍵する

import { localize } from '../../../../nls.js';
import { paradisAgentApprovalKeySequence, paradisAgentQuestionKeySequence, ParadisAgentQuestionAnswer } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { paradisSendAgentMessageToTui } from '../../mobileRelay/common/paradisAgentMessageSender.js';
import { paradisBuildPresetInsertText } from '../../terminalPresets/common/paradisTerminalPresets.js';
import { IParadisAgentChatSource, IParadisAgentInteraction, paradisIsCodexDaemonApprovalInteraction } from '../common/paradisAgentChat.js';
import { paradisQuestionReadyMarker } from '../common/paradisAgentQuestionMarker.js';
import { ParadisAgentChatSession } from './paradisAgentChatSession.js';
import { paradisScreenShowsAgentPrompt, paradisSendAgentInteractionKeys } from './paradisAgentTuiInput.js';

/** 入力先のターミナル（ITerminalInstance から要るところだけ。テストで差し替える）。 */
export interface IParadisAgentChatTerminal {
	sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void>;
	/** 見えている範囲の画面の文字。 */
	readScreen(): string;
	/**
	 * 前面で動いているもの。'shell' = シェルのプロンプトが入力を待っている（エージェントは終わった）、
	 * 'agent' = シェル統合で前面のコマンドが Claude Code / Codex だと分かる、'other' = 別のコマンド、
	 * 'unknown' = シェル統合が無い等で分からない。
	 */
	foreground(): 'agent' | 'shell' | 'other' | 'unknown';
	/** TUI が貼り付けモード（bracketed paste）を有効にしている。 */
	bracketedPasteMode(): boolean;
}

export interface IParadisAgentChatInputDependencies {
	readonly source: IParadisAgentChatSource;
	/** タブが閉じた・ペインが別の会話に替わったなら undefined。呼ぶたびに今のものを返す。 */
	terminal(instanceId: number, token: string): IParadisAgentChatTerminal | undefined;
	session(token: string): ParadisAgentChatSession;
}

/** 質問・承認の打鍵の間隔（モバイルと同じ）。 */
const DEFAULT_KEY_DELAY = 300;

export class ParadisAgentChatInput {

	/** この画面から答え終えた承認（`token\0id`）。中継が消すまでの間も文を送れるようにする（画面の確認つき）。 */
	private readonly answeredApprovals = new Set<string>();

	constructor(
		private readonly dependencies: IParadisAgentChatInputDependencies,
		private readonly keyDelay = DEFAULT_KEY_DELAY,
	) { }

	/** ペインが閉じたときに、そのペインの記録を捨てる。 */
	forget(token: string): void {
		for (const key of [...this.answeredApprovals]) {
			if (key.startsWith(`${token}\0`)) {
				this.answeredApprovals.delete(key);
			}
		}
	}

	/**
	 * 今この interaction を無視して文を送ってよいか。質問は PostToolUse ですぐ消えるので対象にしない
	 * （先頭の打鍵が取りこぼされて質問が残っているときに、送った文の Enter が選択肢を確定するため）。
	 */
	private interactionAllowsMessage(token: string, interaction: IParadisAgentInteraction | null): boolean {
		return interaction === null || (interaction.kind === 'approval' && this.answeredApprovals.has(`${token}\0${interaction.id}`));
	}

	/** 送る前の確認。送れないならその理由を返す。 */
	private async messageBlockReason(instanceId: number, token: string, terminal: IParadisAgentChatTerminal, text: string): Promise<string | undefined> {
		if (this.dependencies.terminal(instanceId, token) !== terminal) {
			return localize('paradisAgentChat.errorTerminalChanged', "送り先のターミナルが変わりました");
		}
		const session = this.dependencies.session(token);
		await session.refresh();
		const state = session.state;
		if (state === undefined) {
			return localize('paradisAgentChat.errorNoSession', "エージェントの会話が見つかりません");
		}
		// 終わったエージェントへ送ると、文がシェルでコマンドとして実行される。
		const foreground = terminal.foreground();
		if (state.agentExited || foreground === 'shell' || foreground === 'other') {
			return localize('paradisAgentChat.errorNotRunning', "エージェントが前面で動いていません。ターミナルで確かめてください");
		}
		if (!this.interactionAllowsMessage(token, state.interaction)) {
			return localize('paradisAgentChat.errorInteraction', "エージェントが回答を待っています。先に質問・許可の確認に答えてください");
		}
		// hook が届かない構成・中継が見落とした確認画面にも Enter を送らない。
		if (paradisScreenShowsAgentPrompt(terminal.readScreen())) {
			return localize('paradisAgentChat.errorPromptOnScreen', "ターミナルに確認の画面が出ています。ターミナルで答えてから送ってください");
		}
		if (text.includes('\n') && !terminal.bracketedPasteMode()) {
			// 貼り付けモードでないと、改行ごとに Enter として届き1行ずつ送信される。
			return localize('paradisAgentChat.errorMultiline', "いまは複数行の文を送れません。1行にして送ってください");
		}
		return undefined;
	}

	async sendMessage(instanceId: number, token: string, rawText: string): Promise<string | undefined> {
		const terminal = this.dependencies.terminal(instanceId, token);
		if (terminal === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		// 制御文字を落とす（ESC が残ると貼り付けの終わりを偽造でき、残りが打鍵として解釈される）。
		// 改行は貼り付けモードで送るので残す（上の確認で、貼り付けモードでなければ送らない）。
		const text = paradisBuildPresetInsertText(rawText, true);
		if (text === undefined) {
			return localize('paradisAgentChat.errorEmpty', "送る文がありません");
		}
		const reason = await this.messageBlockReason(instanceId, token, terminal, text);
		if (reason !== undefined) {
			return reason;
		}
		let lateReason: string | undefined;
		try {
			const outcome = await paradisSendAgentMessageToTui(
				text,
				(value, execute, bracketedPasteMode) => terminal.sendText(value, execute ?? false, bracketedPasteMode),
				async () => {
					lateReason = await this.messageBlockReason(instanceId, token, terminal, text);
					return lateReason === undefined;
				},
			);
			if (!outcome.executed) {
				return outcome.consumed
					? localize('paradisAgentChat.errorPastedNotSent', "貼り付けた後に状態が変わったため、Enter を送りませんでした（{0}）", lateReason ?? '')
					: lateReason ?? localize('paradisAgentChat.errorChanged', "送る前にターミナルの状態が変わりました");
			}
		} catch {
			return localize('paradisAgentChat.errorSend', "ターミナルへ送れませんでした");
		}
		return undefined;
	}

	/** 待っている interaction がまだ同じか（中継から取り直して確かめる）。 */
	private async interactionStillPending(token: string, kind: 'question' | 'approval', id: string): Promise<boolean> {
		const session = this.dependencies.session(token);
		await session.refresh();
		const interaction = session.state?.interaction;
		return interaction?.kind === kind && interaction.id === id;
	}

	async answerQuestions(instanceId: number, token: string, group: string, answers: readonly ParadisAgentQuestionAnswer[]): Promise<string | undefined> {
		const terminal = this.dependencies.terminal(instanceId, token);
		if (terminal === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		if (!(await this.interactionStillPending(token, 'question', group))) {
			return localize('paradisAgentChat.errorQuestionGone', "この質問はもう回答を待っていません");
		}
		const questions = this.dependencies.session(token).state?.pendingQuestions ?? [];
		// 選択肢の数が変わっていないか（中継がモバイルの回答に対して行う確認と同じ）。
		const matches = questions.length === answers.length && answers.every((answer, index) => {
			const question = questions[index];
			const optionCount = question?.options?.length ?? 0;
			if (answer.kind === 'option') {
				return question?.multiSelect !== true && answer.index < optionCount;
			}
			if (answer.kind === 'multi') {
				return question?.multiSelect === true && answer.indices.every(value => value < optionCount);
			}
			return answer.optionCount === optionCount;
		});
		if (!matches) {
			return localize('paradisAgentChat.errorQuestionChanged', "質問の選択肢が変わりました。もう一度選んでください");
		}
		// 選択肢が画面に出ていると確かめられない質問（選択肢が欠けて届いた・偽の hook 等）には打鍵しない。
		const marker = paradisQuestionReadyMarker(questions[0]);
		if (marker === undefined) {
			return localize('paradisAgentChat.errorNoMarker', "この質問はここからは答えられません。ターミナルで答えてください");
		}
		const parts = paradisAgentQuestionKeySequence(questions.map(question => ({ optionCount: question.options?.length ?? 0, multiSelect: question.multiSelect === true })), answers);
		return this.sendInteractionKeys(instanceId, token, terminal, 'question', group, parts, marker);
	}

	async answerApproval(instanceId: number, token: string, interactionId: string, choiceId: string): Promise<string | undefined> {
		const terminal = this.dependencies.terminal(instanceId, token);
		if (terminal === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		if (!(await this.interactionStillPending(token, 'approval', interactionId))) {
			return localize('paradisAgentChat.errorApprovalGone', "この確認はもう回答を待っていません");
		}
		if (paradisIsCodexDaemonApprovalInteraction(interactionId)) {
			// Codex の app-server 経由の承認は、キーではなく構造化された回答で返す（モバイルと同じ経路）。
			const answered = await this.dependencies.source.answerAgentChatApproval(token, interactionId, choiceId).catch(() => false);
			void this.dependencies.session(token).refresh();
			return answered ? undefined : localize('paradisAgentChat.errorApprovalSend', "Codex へ回答を送れませんでした。ターミナルで答えてください");
		}
		if (choiceId !== 'yes' && choiceId !== 'no') {
			return localize('paradisAgentChat.errorApprovalChoice', "この選択肢はここからは選べません。ターミナルで答えてください");
		}
		const agent = this.dependencies.session(token).state?.agent ?? 'claude';
		// 許可の確認の画面が出ていると確かめてから打鍵する（出ていなければ `1`+Enter が入力欄へ流れ、
		// エージェントへの発言として送られる）。
		const error = await this.sendInteractionKeys(instanceId, token, terminal, 'approval', interactionId, paradisAgentApprovalKeySequence(agent, choiceId), paradisScreenShowsAgentPrompt);
		if (error === undefined) {
			this.answeredApprovals.add(`${token}\0${interactionId}`);
		}
		return error;
	}

	private async sendInteractionKeys(instanceId: number, token: string, terminal: IParadisAgentChatTerminal, kind: 'question' | 'approval', id: string, parts: readonly string[], ready: string | ((screen: string) => boolean)): Promise<string | undefined> {
		if (parts.length === 0) {
			return localize('paradisAgentChat.errorNoKeys', "送る内容がありません");
		}
		const source = this.dependencies.source;
		// モバイルと同じ claim を取る。取れなければ、別の場所（スマホ・この画面）から送った回答が反映待ち。
		if (!(await source.claimAgentChatInteraction(token, kind, id).catch(() => false))) {
			return localize('paradisAgentChat.errorLocked', "送った回答がターミナルに反映されるのを待っています。変わらない場合はターミナルで確かめてください");
		}
		let stopReason: string | undefined;
		let keysSent = 0;
		try {
			const outcome = await paradisSendAgentInteractionKeys(terminal, parts, this.keyDelay, {
				readScreen: () => terminal.readScreen(),
				ready,
				strict: true,
				source: 'desktop',
			}, async () => {
				if (this.dependencies.terminal(instanceId, token) !== terminal) {
					stopReason = localize('paradisAgentChat.errorTerminalChanged', "送り先のターミナルが変わりました");
					return false;
				}
				if (!(await this.interactionStillPending(token, kind, id))) {
					// ターミナル側で先に答えた・別の質問に変わった。消えた質問の跡地へ打鍵しない。
					stopReason = localize('paradisAgentChat.errorInteractionChanged', "途中で回答待ちが終わったため、残りのキーを送りませんでした");
					return false;
				}
				keysSent++;
				return true;
			});
			if (outcome === 'not-ready') {
				return localize('paradisAgentChat.errorNotReady', "ターミナルの画面で回答の選択肢を確かめられませんでした。ターミナルで答えてください");
			}
			return outcome === 'sent' ? undefined : stopReason;
		} catch {
			return localize('paradisAgentChat.errorSend', "ターミナルへ送れませんでした");
		} finally {
			// 1つでも打鍵したら、TUI が消費するまで同じ interaction へ打ち直させない（二重の打鍵が入力欄へ流れるため）。
			void source.releaseAgentChatInteraction(token, kind, id, keysSent > 0).catch(() => undefined);
			void this.dependencies.session(token).refresh();
		}
	}
}
