/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type { Server } from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOpenCodeBridge } from '../../node/paradisOpenCodeBridge.js';

suite('ParadisOpenCodeBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let bridge: ParadisOpenCodeBridge;
	let server: Server;
	let base: string;
	setup(async () => {
		bridge = new ParadisOpenCodeBridge();
		const { createServer } = await import('http');
		server = createServer((req, res) => {
			void bridge.handleHttp(req, res, String(req.headers['x-test-owner'] ?? 'pane-a'));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert(address && typeof address !== 'string');
		base = `http://127.0.0.1:${address.port}`;
		bridge.register('pane-a', { sessionId: 'ses_a', cwd: '/project', dbPath: '/data/opencode.db', cli: 'example-cli', pid: 100 });
	});
	teardown(async () => {
		bridge.unregister('pane-a');
		bridge.unregister('pane-b');
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});
	async function post(path: string, body: unknown, token = 'pane-a') {
		return fetch(base + path, {
			method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-owner': token }, body: JSON.stringify(body)
		});
	}

	test('only the matching pane and session receive and settle a request', async () => {
		bridge.register('pane-b', { sessionId: 'ses_b', cwd: '/project', dbPath: '/data/opencode.db', cli: 'opencode', pid: 101 });
		const sent = bridge.sendMessage('pane-a', 'ses_a', 'Continue reviewing');
		const other = await post('/opencode-bridge/poll', { session_id: 'ses_b' }, 'pane-b');
		assert.deepStrictEqual(await other.json(), { requests: [] });
		const poll = await post('/opencode-bridge/poll', { session_id: 'ses_a' });
		const { requests } = await poll.json();
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].operation, 'sendMessage');
		assert.deepStrictEqual(requests[0].input, { text: 'Continue reviewing' });
		const stale = await post('/opencode-bridge/result', { id: requests[0].id, sessionId: 'ses_b', ok: true, value: true });
		assert.strictEqual(stale.status, 409);
		const result = await post('/opencode-bridge/result', { id: requests[0].id, sessionId: 'ses_a', ok: true, value: true });
		assert.strictEqual(result.status, 200);
		assert.strictEqual(await sent, 'accepted');
		assert.strictEqual((await post('/opencode-bridge/result', { id: requests[0].id, sessionId: 'ses_a', ok: true, value: true })).status, 409);
	});

	test('replacing a session cancels old actions and keeps database identity session-bound', async () => {
		const pending = bridge.answerPermission('pane-a', 'ses_a', 'permission-old', 'once');
		bridge.register('pane-a', { sessionId: 'ses_new', cwd: '/project', dbPath: '/data/opencode.db', cli: 'example-cli', pid: 100 });
		assert.strictEqual(await pending, 'rejected');
		assert.strictEqual(bridge.hasSession('pane-a', 'ses_a'), false);
		assert.strictEqual(bridge.databasePath('pane-a', 'ses_a'), undefined);
		assert.strictEqual(bridge.databasePath('pane-a', 'ses_new'), '/data/opencode.db');
		assert.strictEqual(await bridge.answerQuestion('pane-a', 'ses_a', 'question-old', [['Yes']]), 'rejected');
	});

	test('a request the frontend took but never answered is unknown, one it never took is rejected', async () => {
		const sent = bridge.sendMessage('pane-a', 'ses_a', 'taken by the frontend');
		const taken = bridge.interrupt('pane-a', 'ses_a');
		const { requests } = await (await post('/opencode-bridge/poll', { session_id: 'ses_a' })).json();
		const late = bridge.sendMessage('pane-a', 'ses_a', 'after the poll');
		bridge.unregister('pane-a');
		assert.deepStrictEqual({ polled: requests.length, outcomes: await Promise.all([sent, taken, late]) }, { polled: 2, outcomes: ['unknown', 'unknown', 'rejected'] });
	});

	test('keeps only known, well-formed fields from history rows and commands and refuses conflicting session ids', async () => {
		const history = bridge.readMessages('pane-a', 'ses_a');
		const commands = bridge.listCommands('pane-a', 'ses_a');
		const { requests } = await (await post('/opencode-bridge/poll', { session_id: 'ses_a' })).json();
		const conflicting = await post('/opencode-bridge/result', { id: requests[0].id, session_id: 'ses_a', sessionId: 'ses_b', ok: true, value: [] });
		await post('/opencode-bridge/result', { id: requests[0].id, session_id: 'ses_a', ok: true, value: [
			{ id: 'm1', role: 'user', kind: 'message', text: 'Hello', ts: 1, extra: 'dropped' },
			{ id: 'm2', role: 'system', kind: 'message', text: 'bad role' },
			{ id: 't1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'read', input: '{"path":"a"}', output: 'ok', status: 'completed', secret: 'dropped' } },
			{ id: 't2', role: 'assistant', kind: 'tool', text: '', tool: { input: 'no name' } },
			'not a row',
		] });
		await post('/opencode-bridge/result', { id: requests[1].id, sessionId: 'ses_a', ok: true, value: [
			{ name: 'review', description: 'Review', source: 'built-in', run: 'dropped' },
			{ name: 'bad name with spaces', description: '', source: 'user' },
			{ name: 'x', description: '', source: 'unknown' },
		] });
		assert.deepStrictEqual({ conflicting: conflicting.status, history: await history, commands: await commands }, {
			conflicting: 409,
			history: [
				{ id: 'm1', role: 'user', kind: 'message', text: 'Hello', ts: 1 },
				{ id: 't1', role: 'assistant', kind: 'tool', text: '', tool: { name: 'read', input: '{"path":"a"}', output: 'ok', status: 'completed' } },
			],
			commands: [{ name: 'review', description: 'Review', source: 'built-in' }],
		});
	});

	test('history failure is distinct from a successful empty transcript', async () => {
		const history = bridge.readMessages('pane-a', 'ses_a');
		const { requests } = await (await post('/opencode-bridge/poll', { session_id: 'ses_a' })).json();
		await post('/opencode-bridge/result', { id: requests[0].id, sessionId: 'ses_a', ok: true, value: [] });
		assert.deepStrictEqual(await history, []);
		const missing = bridge.readMessages('pane-a', 'ses_a');
		const rejected = assert.rejects(missing, /unavailable/);
		bridge.unregister('pane-a');
		await rejected;
	});
});
