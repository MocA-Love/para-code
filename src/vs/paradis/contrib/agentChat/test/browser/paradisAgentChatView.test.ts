/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';
import { ParadisAgentQuestionAnswer } from '../../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { IParadisAgentChatImageData, IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { ParadisAgentChatSendKey } from '../../browser/paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';
import { IParadisAgentChatViewHost, ParadisAgentChatView } from '../../browser/paradisAgentChatView.js';

class TestHost implements IParadisAgentChatViewHost {
	readonly answers: { group: string; answers: readonly ParadisAgentQuestionAnswer[] }[] = [];
	readonly approvals: { id: string; choice: string }[] = [];
	readonly sent: string[] = [];
	private readonly _onDidChangeSettings = new Emitter<void>();
	readonly onDidChangeSettings = this._onDidChangeSettings.event;

	constructor(private readonly chat: ParadisAgentChatSession) { }

	session(): ParadisAgentChatSession { return this.chat; }
	async sendMessage(_instanceId: number, _token: string, text: string): Promise<string | undefined> { this.sent.push(text); return undefined; }
	async answerQuestions(_instanceId: number, _token: string, group: string, answers: readonly ParadisAgentQuestionAnswer[]): Promise<string | undefined> { this.answers.push({ group, answers }); return undefined; }
	async answerApproval(_instanceId: number, _token: string, id: string, choice: string): Promise<string | undefined> { this.approvals.push({ id, choice }); return undefined; }
	showTerminal(): void { }
	async getFullText(): Promise<string | undefined> { return undefined; }
	async getImage(): Promise<IParadisAgentChatImageData | undefined> { return { mediaType: 'image/png', data: 'AAAA' }; }
	getToggleKeybindingLabel(): string | undefined { return '⌘⇧J'; }
	getSendKey(): ParadisAgentChatSendKey { return 'enter'; }
	getDraft(): string { return ''; }
	setDraft(): void { }
	getHistory(): readonly string[] { return []; }
	async getCommands() { return []; }
	dispose(): void { this._onDidChangeSettings.dispose(); }
}

function sourceReturning(views: IParadisAgentChatView[]): IParadisAgentChatSource {
	return {
		onDidChangeAgentChat: Event.None,
		watchAgentChat: async () => { },
		getAgentChat: async () => views.length > 1 ? views.shift() : views[0],
		getAgentChatFullText: async () => undefined,
		getAgentChatImage: async () => undefined,
		getAgentChatCommands: async () => [],
		answerAgentChatApproval: async () => false,
	};
}

suite('ParadisAgentChatView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createView(views: IParadisAgentChatView[]): Promise<{ view: ParadisAgentChatView; host: TestHost; container: HTMLElement; disposables: DisposableStore }> {
		const disposables = store.add(new DisposableStore());
		const container = mainWindow.document.createElement('div');
		container.className = 'terminal-overflow-guard terminal-editor';
		mainWindow.document.body.appendChild(container);
		disposables.add({ dispose: () => container.remove() });
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.set(IOpenerService, NullOpenerService);
		instantiationService.set(IMarkdownRendererService, instantiationService.createInstance(MarkdownRendererService));
		const session = disposables.add(new ParadisAgentChatSession('pane', sourceReturning(views), new NullLogService()));
		const host = new TestHost(session);
		disposables.add(host);
		const view = disposables.add(instantiationService.createInstance(ParadisAgentChatView, container, host));
		view.setTarget(1, 'pane');
		await session.refresh();
		// 描画は次のタスクへまとめられる。
		await new Promise(resolve => setTimeout(resolve, 0));
		return { view, host, container, disposables };
	}

	test('renders the conversation, a tool row with its diff card and the pending question, and answers through the host', async () => {
		const { host, container } = await createView([{
			token: 'pane', agent: 'claude', epoch: 'e', rev: 6, reset: true, busy: false, live: null,
			info: { model: 'claude-opus-4-5', effort: 'high' },
			messages: [
				{ rev: 0, role: 'user', kind: 'text', text: 'ログインを直して' },
				{ rev: 1, role: 'assistant', kind: 'tool_use', tool: 'Edit', toolUseId: 't1', text: JSON.stringify({ file_path: '/repo/login.ts', old_string: 'a', new_string: 'b' }) },
				{ rev: 2, role: 'tool', kind: 'tool_result', toolUseId: 't1', text: 'ok' },
				{ rev: 3, role: 'assistant', kind: 'text', text: '**直しました**' },
				{ rev: 4, role: 'assistant', kind: 'question', text: 'テストも直しますか?', toolUseId: 'live:1', questionGroup: 'g1', questionIndex: 0, questionCount: 1, options: [{ label: 'はい' }, { label: 'いいえ' }] },
			],
			interaction: { kind: 'question', id: 'g1' },
			pendingQuestions: [{ rev: 4, role: 'assistant', kind: 'question', text: 'テストも直しますか?', toolUseId: 'live:1', questionGroup: 'g1', questionIndex: 0, questionCount: 1, options: [{ label: 'はい' }, { label: 'いいえ' }] }],
		}]);
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent);
		const snapshot = {
			header: text('.paradis-agent-chat-header-agent, .paradis-agent-chat-header-model, .paradis-agent-chat-header-status'),
			user: text('.paradis-agent-chat-message.user'),
			assistantBold: text('.paradis-agent-chat-message.assistant strong'),
			toolLabel: text('.paradis-agent-chat-step.tool .paradis-agent-chat-step-label'),
			diffRows: text('.paradis-agent-chat-diff-row'),
			options: text('.paradis-agent-chat-option'),
			sendDisabled: container.querySelector<HTMLButtonElement>('.paradis-agent-chat-send')?.disabled,
			notice: text('.paradis-agent-chat-composer-notice.visible'),
		};
		container.querySelectorAll<HTMLButtonElement>('.paradis-agent-chat-option')[1].click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ snapshot, answers: host.answers }, {
			snapshot: {
				header: ['Claude Code', 'claude-opus-4-5 · high', '質問に答えるのを待っています'],
				user: ['ログインを直して'],
				assistantBold: ['直しました'],
				toolLabel: ['Edit'],
				diffRows: ['−a', '+b'],
				options: ['1. はい', '2. いいえ'],
				sendDisabled: true,
				notice: ['質問に答えてから送ってください'],
			},
			answers: [{ group: 'g1', answers: [{ kind: 'option', index: 1 }] }],
		});
	});

	test('shows the approval card with its choices and the live bubble while the agent works', async () => {
		const { host, container } = await createView([{
			token: 'pane', agent: 'claude', epoch: 'e', rev: 1, reset: true, busy: true,
			live: { phase: 'permission', source: 'hook', startedAt: Date.now(), updatedAt: Date.now(), tool: 'Bash' },
			messages: [{ rev: 0, role: 'assistant', kind: 'tool_use', tool: 'approval_request', toolUseId: 'toolu_9', text: 'Bash: npm test -- auth' }],
			interaction: { kind: 'approval', id: 'toolu_9', title: '操作の許可', detail: 'Bash: npm test -- auth', choices: [{ id: 'yes', label: '許可', tone: 'approve' }, { id: 'no', label: '拒否', tone: 'deny' }] },
		}]);
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent);
		const snapshot = {
			title: text('.paradis-agent-chat-card.approval .paradis-agent-chat-card-title'),
			detail: text('.paradis-agent-chat-card.approval .paradis-agent-chat-card-detail'),
			buttons: text('.paradis-agent-chat-card.approval button'),
			live: text('.paradis-agent-chat-live-label'),
		};
		container.querySelector<HTMLButtonElement>('.paradis-agent-chat-card.approval .paradis-agent-chat-primary')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ snapshot, approvals: host.approvals }, {
			snapshot: {
				title: ['Bash の実行を許可しますか'],
				detail: ['npm test -- auth'],
				buttons: ['許可', '拒否'],
				live: ['許可を待っています'],
			},
			approvals: [{ id: 'toolu_9', choice: 'yes' }],
		});
	});
});
