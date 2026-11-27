/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 受信箱（やスマホ以外の場所）で答えたペインの質問・許可を、そのペインを持っているウィンドウで届ける。
//
// 新しい入力の仕組みは作らない。PC のチャット表示とタスクボードが使っている ParadisAgentChatInput をそのまま呼ぶ
// （中継から今の待ちを取り直して同じものか確かめ、スマホと同じ claim を取り、画面に確認・選択肢が出ているのを
// 確かめてから打鍵する。確かめられなければ打たずに断る）。結果は shared process の持ち主へ返す。

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentChatTerminal, ParadisAgentChatInput, paradisIsShellProcessName } from '../../agentChat/browser/paradisAgentChatInput.js';
import { ParadisAgentChatSession } from '../../agentChat/browser/paradisAgentChatSession.js';
import { paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { IParadisAgentChatSource } from '../../agentChat/common/paradisAgentChat.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paradisInboxPaneKey } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { PARADIS_ASK_HUMAN_CHANNEL } from '../common/paradisAskHumanTool.js';
import { IParadisHumanAskPaneAnswerRequest, PARADIS_HUMAN_ASK_PANES_CHANNEL } from '../common/paradisHumanAskPane.js';

/** ITerminalInstance を、チャットの入力が使う形へ写す（agentChat・タスクボードの写しと同じ規則）。 */
function createChatTerminal(instance: ITerminalInstance): IParadisAgentChatTerminal {
	return {
		sendText: (text, shouldExecute, bracketedPasteMode) => instance.sendText(text, shouldExecute, bracketedPasteMode),
		readScreen: () => paradisVisibleTerminalText(instance),
		foreground: () => {
			const processName = instance.processName.trim();
			return processName.length === 0 ? 'unknown' : paradisIsShellProcessName(processName) ? 'shell' : 'agent';
		},
		bracketedPasteMode: () => instance.xterm?.raw.modes.bracketedPasteMode === true,
	};
}

class ParadisHumanAskPaneAnswer extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisHumanAskPaneAnswer';

	private readonly input: ParadisAgentChatInput;
	private readonly sessions = this._register(new DisposableMap<string, ParadisAgentChatSession>());
	/** 同じターミナルには同じ窓口を返す（ParadisAgentChatInput は送り先が同じものかを `!==` で比べる）。 */
	private readonly terminals = new WeakMap<ITerminalInstance, IParadisAgentChatTerminal>();

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@INativeHostService nativeHostService: INativeHostService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const source = ProxyChannel.toService<IParadisAgentChatSource>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this.input = new ParadisAgentChatInput({
			source,
			terminal: (instanceId, token) => this.terminal(instanceId, token),
			session: token => {
				let session = this.sessions.get(token);
				if (!session) {
					session = new ParadisAgentChatSession(token, source, this.logService);
					this.sessions.set(token, session);
				}
				return session;
			},
		});
		this._register(this.paneTokenService.onDidChange(() => {
			const live = new Set(this.paneTokenService.listPaneTokens().map(entry => entry.token));
			for (const token of [...this.sessions.keys()]) {
				if (!live.has(token)) {
					this.sessions.deleteAndDispose(token);
					this.input.forget(token);
				}
			}
		}));

		// ペインの質問・許可（paradisHumanAskPaneOwner.ts）と、ask_human の答え（paradisAskHumanToolProvider.ts）
		for (const channelName of [PARADIS_HUMAN_ASK_PANES_CHANNEL, PARADIS_ASK_HUMAN_CHANNEL]) {
			const channel = sharedProcessService.getChannel(channelName);
			this._register(channel.listen<IParadisHumanAskPaneAnswerRequest>('onDidRequestPaneAnswer', nativeHostService.windowId)(async request => {
				let delivered = false;
				try {
					delivered = await this.deliver(request);
				} catch (error) {
					this.logService.warn('[paradisHumanAsk] could not deliver the answer to the pane', error);
				}
				channel.call('settle', [request.claim, request.key, delivered]).catch(error => this.logService.trace('[paradisHumanAsk] settle failed', String(error)));
			}));
		}
	}

	private terminal(instanceId: number, token: string): IParadisAgentChatTerminal | undefined {
		const instance = this.paneTokenService.getInstanceForToken(token) === instanceId ? this.terminalService.getInstanceFromId(instanceId) : undefined;
		if (instance === undefined) {
			return undefined;
		}
		let terminal = this.terminals.get(instance);
		if (terminal === undefined) {
			terminal = createChatTerminal(instance);
			this.terminals.set(instance, terminal);
		}
		return terminal;
	}

	private async deliver(request: IParadisHumanAskPaneAnswerRequest): Promise<boolean> {
		const token = this.paneTokenService.listPaneTokens().find(entry => paradisInboxPaneKey(entry.token) === request.paneKey)?.token;
		const instanceId = token !== undefined ? this.paneTokenService.getInstanceForToken(token) : undefined;
		if (token === undefined || instanceId === undefined) {
			return false;
		}
		const delivery = request.delivery;
		const error = delivery.kind === 'question'
			? await this.input.answerQuestions(instanceId, token, request.interactionId, delivery.answers)
			: delivery.kind === 'approval'
				? await this.input.answerApproval(instanceId, token, request.interactionId, delivery.choiceId)
				: await this.input.sendMessage(instanceId, token, delivery.text);
		if (error !== undefined) {
			this.logService.info(`[paradisHumanAsk] the answer was not delivered: ${error}`);
		}
		return error === undefined;
	}
}

registerWorkbenchContribution2(ParadisHumanAskPaneAnswer.ID, ParadisHumanAskPaneAnswer, WorkbenchPhase.AfterRestored);
