/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpToolCallContext } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisTaskBoardWindowDescription, ParadisTaskBoardWindowMethod, paradisTaskBoardTerminalId } from '../../common/paradisTaskBoardBridge.js';
import { IParadisTaskBoardWindowRouter, ParadisTaskBoardBridgeService } from '../../node/paradisTaskBoardBridgeService.js';

const PANE_TOKEN = 'pane-token-1';
const TERMINAL = paradisTaskBoardTerminalId(PANE_TOKEN);

class FakeRouter implements IParadisTaskBoardWindowRouter {
	readonly calls: { ctx: string; method: string; arg: unknown }[] = [];
	connected = ['window:1', 'window:2'];
	descriptions: Record<string, IParadisTaskBoardWindowDescription> = {
		'window:1': { focused: true, repositories: [], spaces: [] },
		'window:2': { focused: false, repositories: [{ path: '/repo', name: 'repo' }], spaces: [{ path: '/repo', name: 'repo' }] },
	};
	answers: Partial<Record<ParadisTaskBoardWindowMethod, unknown>> = {
		launch: { ok: true, value: { terminal: TERMINAL } },
		send: { ok: false, code: 'busy', message: 'working' },
		close: { ok: true, value: true },
	};

	windows(): readonly string[] {
		return this.connected;
	}

	async call<T>(ctx: string, method: ParadisTaskBoardWindowMethod, arg: unknown): Promise<T> {
		this.calls.push({ ctx, method, arg });
		if (method === 'describe') {
			return this.descriptions[ctx] as T;
		}
		return this.answers[method] as T;
	}
}

function context(): IParadisMcpToolCallContext {
	return {
		callOwningWindow: async () => ({ ok: false, error: 'unused' }),
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => true,
		classifyCaller: async () => 'pane',
	};
}

function parseEvents(chunks: readonly string[]): unknown[] {
	return chunks.filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice('data: '.length)));
}

suite('ParadisTaskBoardBridgeService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(router: FakeRouter): ParadisTaskBoardBridgeService {
		return disposables.add(new ParadisTaskBoardBridgeService(router, {
			directoryExists: async path => path === '/repo' || path === '/other',
			ignorePathCase: false,
			newId: () => 'reply-1',
			replyTimeoutMs: 50,
			disconnectGraceMs: 10,
		}, undefined));
	}

	async function launch(service: ParadisTaskBoardBridgeService, repoPath = '/repo') {
		return service.handle('POST', '/v1/launch', new URLSearchParams(), { launchId: 'L1', repoPath, agent: 'claude', prompt: 'work' });
	}

	test('launch picks the window that has the repository, is idempotent per launchId, and lists the terminal', async () => {
		const router = new FakeRouter();
		const service = create(router);
		const first = await launch(service);
		const second = await launch(service);
		const terminals = await service.handle('GET', '/v1/terminals', new URLSearchParams(), undefined);
		assert.deepStrictEqual({
			first,
			second,
			launchedIn: router.calls.filter(call => call.method === 'launch').map(call => call.ctx),
			terminals,
			windowTerminals: [service.listWindowTerminals('window:2'), service.listWindowTerminals('window:1')],
		}, {
			first: { status: 200, body: { terminal: TERMINAL } },
			second: { status: 200, body: { terminal: TERMINAL } },
			launchedIn: ['window:2'],
			terminals: { status: 200, body: { terminals: [{ terminal: TERMINAL, launchId: 'L1', tag: 'L1', repoPath: '/repo', agent: 'claude', status: 'working' }] } },
			windowTerminals: [[TERMINAL], []],
		});
	});

	test('launch falls back to the focused window and rejects a missing folder', async () => {
		const router = new FakeRouter();
		const service = create(router);
		const missing = await launch(service, '/missing');
		await launch(service, '/other');
		assert.deepStrictEqual({ missing: missing.status, launchedIn: router.calls.filter(call => call.method === 'launch').map(call => call.ctx) }, { missing: 400, launchedIn: ['window:1'] });
	});

	test('a send with a tag replaces the terminal tag only when the window accepted it', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const refused = await service.handle('POST', '/v1/send', new URLSearchParams(), { terminal: TERMINAL, text: 'next', tag: 'T:2' });
		router.answers.send = { ok: true, value: true };
		const accepted = await service.handle('POST', '/v1/send', new URLSearchParams(), { terminal: TERMINAL, text: 'next', tag: 'T:3' });
		const terminals = await service.handle('GET', '/v1/terminals', new URLSearchParams(), undefined) as { body: { terminals: { tag: string }[] } };
		const forwarded = router.calls.filter(call => call.method === 'send').map(call => call.arg);
		assert.deepStrictEqual({ refused: refused.status, accepted: accepted.status, tag: terminals.body.terminals[0].tag, forwarded }, {
			refused: 409,
			accepted: 200,
			tag: 'T:3',
			forwarded: [{ terminal: TERMINAL, text: 'next', submit: true }, { terminal: TERMINAL, text: 'next', submit: true }],
		});
	});

	test('launch prefers a window that can add repositories over a focused empty window', async () => {
		const router = new FakeRouter();
		router.descriptions['window:1'] = { focused: true, canAddRepository: false, repositories: [], spaces: [] };
		router.descriptions['window:2'] = { focused: false, canAddRepository: true, repositories: [], spaces: [] };
		const service = create(router);
		await launch(service, '/other');
		assert.deepStrictEqual(router.calls.filter(call => call.method === 'launch').map(call => call.ctx), ['window:2']);
	});

	test('launch never picks a remote (SSH) window, and refuses when only remote windows are open', async () => {
		const router = new FakeRouter();
		router.descriptions['window:1'] = { focused: true, canAddRepository: true, remote: true, repositories: [], spaces: [{ path: '/other', name: 'other' }] };
		router.descriptions['window:2'] = { focused: false, canAddRepository: true, repositories: [], spaces: [] };
		const service = create(router);
		await launch(service, '/other');
		router.descriptions['window:2'] = { ...router.descriptions['window:2'], remote: true };
		const refused = await service.handle('POST', '/v1/launch', new URLSearchParams(), { launchId: 'L2', repoPath: '/other', agent: 'claude', prompt: 'work' }) as { status: number };
		assert.deepStrictEqual({ launched: router.calls.filter(call => call.method === 'launch').map(call => call.ctx), refused: refused.status }, { launched: ['window:2'], refused: 503 });
	});

	test('status events carry the launchId, only the owning window may report, and the window errors map to HTTP', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const chunks: string[] = [];
		const client = service.addEventClient(chunk => chunks.push(chunk))!;
		const fromOther = service.reportStatus('window:1', { terminal: TERMINAL, status: 'idle' });
		const fromOwner = service.reportStatus('window:2', { terminal: TERMINAL, status: 'question', question: { text: 'Pick', options: [{ label: 'A' }], allowText: false } });
		service.reportStatus('window:2', { terminal: TERMINAL, status: 'question', question: { text: 'Pick', options: [{ label: 'A' }], allowText: false } });
		const send = await service.handle('POST', '/v1/send', new URLSearchParams(), { terminal: TERMINAL, text: 'hi' });
		const unknown = await service.handle('POST', '/v1/send', new URLSearchParams(), { terminal: 't_ffffffffffff', text: 'hi' });
		const close = await service.handle('POST', '/v1/close', new URLSearchParams(), { terminal: TERMINAL });
		client.dispose();
		assert.deepStrictEqual({ fromOther, fromOwner, events: parseEvents(chunks), send, unknown, close }, {
			fromOther: false,
			fromOwner: true,
			events: [
				{ type: 'status', terminal: TERMINAL, launchId: 'L1', status: 'working' },
				{ type: 'status', terminal: TERMINAL, launchId: 'L1', status: 'question', question: { text: 'Pick', options: [{ label: 'A' }], allowText: false } },
				{ type: 'status', terminal: TERMINAL, launchId: 'L1', status: 'exited' },
			],
			send: { status: 409, body: { error: 'busy', message: 'working' } },
			unknown: { status: 404, body: { error: 'not-found', message: 'There is no terminal with that id started by the task board.' } },
			close: { status: 200, body: { ok: true } },
		});
	});

	test('board_complete_step reports to the board and returns its reply; other panes are refused', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const chunks: string[] = [];
		const client = service.addEventClient(chunk => {
			chunks.push(chunk);
			if (chunk.includes('"type":"report"')) {
				queueMicrotask(() => service.handle('POST', '/v1/reply', new URLSearchParams(), { replyId: 'reply-1', ok: true, message: 'Next: open a PR' }));
			}
		})!;
		const result = await service.callTool(PANE_TOKEN, 'board_complete_step', { summary: 'Planned' }, undefined, context());
		const refused = await service.callTool('other-pane', 'board_complete_step', { summary: 'Planned' }, undefined, context());
		const notMine = await service.callTool(PANE_TOKEN, 'take_screenshot', {}, undefined, context());
		client.dispose();
		assert.deepStrictEqual({ result, refused, notMine, report: parseEvents(chunks).filter(event => (event as { type: string }).type === 'report') }, {
			result: { content: [{ type: 'text', text: 'Next: open a PR' }] },
			refused: { content: [{ type: 'text', text: 'このペインはタスクボードのタスクではありません' }], isError: true },
			notMine: undefined,
			report: [{ type: 'report', terminal: TERMINAL, replyId: 'reply-1', tool: 'complete_step', args: { summary: 'Planned' } }],
		});
	});

	test('reports wait for an event client and time out with the default message', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const asked = await service.callTool(PANE_TOKEN, 'board_ask_human', { question: 'A or B?' }, undefined, context());
		const chunks: string[] = [];
		const client = service.addEventClient(chunk => chunks.push(chunk))!;
		client.dispose();
		assert.deepStrictEqual({ asked, queued: parseEvents(chunks).map(event => (event as { type: string }).type) }, {
			asked: { content: [{ type: 'text', text: '質問をボードに出しました。回答はユーザーから次のメッセージで届きます。ここでターンを終えて待ってください' }] },
			queued: ['status', 'report'],
		});
	});

	test('hook tool events are forwarded only for board terminals', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const chunks: string[] = [];
		const client = service.addEventClient(chunk => chunks.push(chunk))!;
		service.onHookEvent({ token: PANE_TOKEN, event: 'PreToolUse', sessionId: 's', transcriptPath: undefined, cwd: undefined, toolName: 'Bash', toolInput: { command: 'npm test' }, at: 0 });
		service.onHookEvent({ token: 'other', event: 'PreToolUse', sessionId: 's', transcriptPath: undefined, cwd: undefined, toolName: 'Bash', toolInput: { command: 'ls' }, at: 0 });
		service.onHookEvent({ token: PANE_TOKEN, event: 'Stop', sessionId: 's', transcriptPath: undefined, cwd: undefined, at: 0 });
		client.dispose();
		assert.deepStrictEqual(parseEvents(chunks).slice(1), [{ type: 'tool', terminal: TERMINAL, name: 'Bash', detail: 'npm test' }]);
	});

	test('a window that does not come back marks its terminals exited', async () => {
		const router = new FakeRouter();
		const service = create(router);
		await launch(service);
		const chunks: string[] = [];
		const client = service.addEventClient(chunk => chunks.push(chunk))!;
		router.connected = ['window:1'];
		service.onWindowDisconnected('window:2');
		await new Promise(resolve => setTimeout(resolve, 30));
		client.dispose();
		assert.deepStrictEqual({ last: parseEvents(chunks).at(-1), left: service.listWindowTerminals('window:2') }, {
			last: { type: 'status', terminal: TERMINAL, launchId: 'L1', status: 'exited' },
			left: [],
		});
	});
});
