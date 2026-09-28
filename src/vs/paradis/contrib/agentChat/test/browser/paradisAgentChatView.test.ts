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
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';
import { ParadisAgentQuestionAnswer } from '../../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { IParadisAgentChatImageData, IParadisAgentChatSource, IParadisAgentChatView } from '../../common/paradisAgentChat.js';
import { ParadisAgentChatSendKey } from '../../browser/paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from '../../browser/paradisAgentChatSession.js';
import { IParadisAgentChatCardStates, IParadisAgentChatViewHost, ParadisAgentChatView } from '../../browser/paradisAgentChatView.js';

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
	private readonly states = new Map<string, IParadisAgentChatCardStates>();
	cardStates(token: string): IParadisAgentChatCardStates {
		let states = this.states.get(token);
		if (states === undefined) {
			states = { questions: new Map(), approvals: new Map(), composer: { sending: false }, openGroups: new Set() };
			this.states.set(token, states);
		}
		return states;
	}
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
		claimAgentChatInteraction: async () => true,
		releaseAgentChatInteraction: async () => { },
	};
}

suite('ParadisAgentChatView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createView(views: IParadisAgentChatView[]): Promise<{ view: ParadisAgentChatView; host: TestHost; container: HTMLElement; disposables: DisposableStore; session: ParadisAgentChatSession }> {
		const disposables = store.add(new DisposableStore());
		const container = mainWindow.document.createElement('div');
		container.className = 'terminal-overflow-guard terminal-editor';
		mainWindow.document.body.appendChild(container);
		disposables.add({ dispose: () => container.remove() });
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.set(IOpenerService, NullOpenerService);
		instantiationService.set(IHoverService, NullHoverService);
		instantiationService.set(IMarkdownRendererService, instantiationService.createInstance(MarkdownRendererService));
		const session = disposables.add(new ParadisAgentChatSession('pane', sourceReturning(views), new NullLogService()));
		const host = new TestHost(session);
		disposables.add(host);
		const view = disposables.add(instantiationService.createInstance(ParadisAgentChatView, container, host));
		view.setTarget(1, 'pane');
		await session.refresh();
		// 描画は次のタスクへまとめられる。
		await new Promise(resolve => setTimeout(resolve, 0));
		return { view, host, container, disposables, session };
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

	test('folds consecutive tool calls into a closed group, keeps a running tool visible, and remembers the open group across panes', async () => {
		const tool = (rev: number, id: string, command: string) => ({ rev, role: 'assistant' as const, kind: 'tool_use' as const, tool: 'Bash', toolUseId: id, text: JSON.stringify({ command }) });
		const result = (rev: number, id: string) => ({ rev, role: 'tool' as const, kind: 'tool_result' as const, toolUseId: id, text: 'ok' });
		const { view, container } = await createView([{
			token: 'pane', agent: 'claude', epoch: 'e', rev: 7, reset: true, busy: true, live: null,
			messages: [
				{ rev: 0, role: 'user', kind: 'text', text: 'テストして' },
				{ rev: 1, role: 'assistant', kind: 'thinking', text: '考える' },
				tool(2, 't1', 'npm ci'), result(3, 't1'),
				tool(4, 't2', 'npm test'),
				{ rev: 5, role: 'assistant', kind: 'text', text: '実行しています' },
			],
			interaction: null,
		}]);
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent);
		const snapshot = () => ({
			group: text('.paradis-agent-chat-group-row'),
			expanded: container.querySelector('.paradis-agent-chat-group-row')?.getAttribute('aria-expanded'),
			steps: text('.paradis-agent-chat-grouped .paradis-agent-chat-step-arg'),
		});
		const closed = snapshot();
		container.querySelector<HTMLButtonElement>('.paradis-agent-chat-group-row')!.focus();
		container.querySelector<HTMLButtonElement>('.paradis-agent-chat-group-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		const opened = { ...snapshot(), focused: mainWindow.document.activeElement?.classList.contains('paradis-agent-chat-group-row') };
		// 別のペインへ切り替えて戻っても、開いたまとまりは開いたまま。
		view.setTarget(1, 'other');
		view.setTarget(1, 'pane');
		const restored = snapshot();
		assert.deepStrictEqual({ closed, opened, restored }, {
			closed: { group: ['3×考えた内容, Bash'], expanded: 'false', steps: ['npm test'] },
			opened: { group: ['3×考えた内容, Bash'], expanded: 'true', steps: ['考える', 'npm ci', 'npm test'], focused: true },
			restored: { group: ['3×考えた内容, Bash'], expanded: 'true', steps: ['考える', 'npm ci', 'npm test'] },
		});
	});

	test('keeps a row the user opened visible when the next tool folds it into a group', async () => {
		const tool = (rev: number, id: string, command: string) => ({ rev, role: 'assistant' as const, kind: 'tool_use' as const, tool: 'Bash', toolUseId: id, text: JSON.stringify({ command }) });
		const result = (rev: number, id: string, text: string) => ({ rev, role: 'tool' as const, kind: 'tool_result' as const, toolUseId: id, text });
		const first = [{ rev: 0, role: 'user' as const, kind: 'text' as const, text: 'ビルドして' }, tool(1, 't1', 'npm run build'), result(2, 't1', 'error TS2304: Cannot find name')];
		const before: IParadisAgentChatView = { token: 'pane', agent: 'claude', epoch: 'e', rev: 3, reset: true, busy: true, live: null, messages: first, interaction: null };
		// 表示の切り替え（setTarget）と createView がそれぞれ1回ずつ取り直すので、最初の状態を2回返す。
		const { container, session } = await createView([
			before,
			before,
			{ token: 'pane', agent: 'claude', epoch: 'e', rev: 4, reset: true, busy: true, live: null, messages: [...first, tool(3, 't2', 'npm run lint')], interaction: null },
		]);
		container.querySelector<HTMLButtonElement>('.paradis-agent-chat-step.tool .paradis-agent-chat-step-row')!.click();
		await session.refresh();
		await new Promise(resolve => setTimeout(resolve, 0));
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent);
		assert.deepStrictEqual({
			group: text('.paradis-agent-chat-group-row'),
			visibleArgs: text('.paradis-agent-chat-grouped .paradis-agent-chat-step-arg'),
			openedOutput: text('.paradis-agent-chat-grouped .paradis-agent-chat-step-detail'),
		}, {
			group: ['2×Bash失敗 1 件'],
			visibleArgs: ['npm run build', 'npm run lint'],
			openedOutput: ['{"command":"npm run build"}', 'error TS2304: Cannot find name'],
		});
	});

	test('draws a pending approval between tools as a card outside the groups', async () => {
		const tool = (rev: number, id: string, command: string) => ({ rev, role: 'assistant' as const, kind: 'tool_use' as const, tool: 'Bash', toolUseId: id, text: JSON.stringify({ command }) });
		const result = (rev: number, id: string) => ({ rev, role: 'tool' as const, kind: 'tool_result' as const, toolUseId: id, text: 'ok' });
		const { container } = await createView([{
			token: 'pane', agent: 'claude', epoch: 'e', rev: 9, reset: true, busy: true, live: null,
			messages: [
				tool(0, 't1', 'ls'), result(1, 't1'),
				tool(2, 't2', 'pwd'), result(3, 't2'),
				{ rev: 4, role: 'assistant', kind: 'tool_use', tool: 'approval_request', toolUseId: 'toolu_9', text: 'Bash: rm -rf dist' },
				tool(5, 't3', 'cat a'), result(6, 't3'),
				tool(7, 't4', 'cat b'), result(8, 't4'),
			],
			interaction: { kind: 'approval', id: 'toolu_9', choices: [{ id: 'yes', label: '許可', tone: 'approve' }, { id: 'no', label: '拒否', tone: 'deny' }] },
		}]);
		const list = container.querySelector<HTMLElement>('.paradis-agent-chat-list')!;
		assert.deepStrictEqual([...list.children].filter(child => !child.classList.contains('paradis-agent-chat-notice')).map(child => child.classList.contains('paradis-agent-chat-group')
			? `group:${child.textContent}`
			: `card:${[...child.querySelectorAll('button')].map(button => button.textContent).join('/')}`), [
			'group:2×Bash',
			'card:許可/拒否',
			'group:2×Bash',
		]);
	});
});
