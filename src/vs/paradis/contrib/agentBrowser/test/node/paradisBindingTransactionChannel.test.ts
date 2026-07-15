/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserChannel } from '../../node/paradisAgentBrowserChannel.js';
import type { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

interface IRecordedCall {
	readonly command: string;
	readonly connection: object;
	readonly value: unknown;
}

function createChannel(): { readonly channel: ParadisAgentBrowserChannel; readonly connection: object; readonly calls: IRecordedCall[] } {
	const connection = {};
	const calls: IRecordedCall[] = [];
	const service = {
		isCurrentRendererConnection: (ctx: string, candidate: object) => ctx === 'window:1' && candidate === connection,
		prepareBind: async (candidate: object, value: unknown) => {
			calls.push({ command: 'prepareBind', connection: candidate, value });
			return { ticketId: 'ticket', expiresAt: 10_000, revision: 1, scope: { kind: 'managed', stateKey: 'repo' } };
		},
		commitBind: async (candidate: object, value: unknown) => {
			calls.push({ command: 'commitBind', connection: candidate, value });
			return { committed: true, binding: { token: 'token', pageId: 'view', pageInfo: { url: 'https://example.test', title: 'Example' }, generation: 1, boundAt: 1, scope: { kind: 'managed', stateKey: 'repo' } } };
		},
		abortBind: async (candidate: object, value: unknown) => {
			calls.push({ command: 'abortBind', connection: candidate, value });
			return { aborted: true };
		},
	} as unknown as ParadisAgentBrowserService;
	return { channel: new ParadisAgentBrowserChannel(service, connection), connection, calls };
}

suite('Paradis binding transaction channel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('copy-owns one exact bounded prepare request before forwarding it', async () => {
		const { channel, connection, calls } = createChannel();
		const source = {
			revision: 1,
			token: 'token',
			viewId: 'view',
			pageInfo: { url: 'https://example.test', title: 'Example' },
		};

		await channel.call('window:1', 'prepareBind', [source]);
		source.pageInfo.url = 'https://mutated.test';

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].command, 'prepareBind');
		assert.strictEqual(calls[0].connection, connection);
		assert.deepStrictEqual(calls[0].value, {
			revision: 1,
			token: 'token',
			viewId: 'view',
			pageInfo: { url: 'https://example.test', title: 'Example' },
		});
		assert.strictEqual(Object.isFrozen(calls[0].value), true);
		assert.strictEqual(Object.isFrozen((calls[0].value as { pageInfo: object }).pageInfo), true);
	});

	test('forwards only exact commit and abort ticket records', async () => {
		const { channel, calls } = createChannel();

		await channel.call('window:1', 'commitBind', [{ ticketId: 'ticket' }]);
		await channel.call('window:1', 'abortBind', [{ ticketId: 'ticket' }]);

		assert.deepStrictEqual(calls.map(call => [call.command, call.value]), [
			['commitBind', { ticketId: 'ticket' }],
			['abortBind', { ticketId: 'ticket' }],
		]);
		assert.strictEqual(Object.isFrozen(calls[0].value), true);
		assert.strictEqual(Object.isFrozen(calls[1].value), true);
	});

	test('rejects malformed and accessor-backed transaction payloads without forwarding', () => {
		const { channel, calls } = createChannel();
		const valid = {
			revision: 1,
			token: 'token',
			viewId: 'view',
			pageInfo: { url: 'https://example.test', title: 'Example' },
		};
		const accessor = { ...valid };
		Object.defineProperty(accessor, 'token', { enumerable: true, get: () => 'token' });
		const pageInfoAccessor = { ...valid, pageInfo: {} };
		Object.defineProperty(pageInfoAccessor.pageInfo, 'url', { enumerable: true, get: () => 'https://example.test' });
		Object.defineProperty(pageInfoAccessor.pageInfo, 'title', { enumerable: true, value: 'Example' });
		const hidden = { ...valid } as typeof valid & { hidden?: boolean };
		Object.defineProperty(hidden, 'hidden', { value: true });
		const symbol = { ...valid } as Record<PropertyKey, unknown>;
		symbol[Symbol('hidden')] = true;

		for (const invalid of [
			null, [], { ...valid, revision: -1 }, { ...valid, revision: 1.5 }, { ...valid, revision: '1' },
			{ ...valid, token: '' }, { ...valid, token: 't'.repeat(201) },
			{ ...valid, viewId: '' }, { ...valid, viewId: 'v'.repeat(513) },
			{ ...valid, pageInfo: null }, { ...valid, pageInfo: { url: 1, title: 'Example' } },
			{ ...valid, pageInfo: { url: 'u'.repeat(16 * 1024 + 1), title: 'Example' } },
			{ ...valid, pageInfo: { url: 'https://example.test', title: 't'.repeat(4 * 1024 + 1) } },
			{ ...valid, pageInfo: { url: 'https://example.test', title: 'Example', extra: true } },
			{ ...valid, extra: true }, accessor, pageInfoAccessor, hidden, symbol,
		]) {
			assert.throws(() => channel.call('window:1', 'prepareBind', [invalid]), /protocol/i);
		}

		for (const command of ['commitBind', 'abortBind']) {
			for (const invalid of [null, [], {}, { ticketId: '' }, { ticketId: 1 }, { ticketId: 't'.repeat(201) }, { ticketId: 'ticket', extra: true }]) {
				assert.throws(() => channel.call('window:1', command, [invalid]), /protocol/i);
			}
		}
		assert.deepStrictEqual(calls, []);
	});

	test('rejects stale connections before touching hostile transaction arguments and keeps legacy bind closed', () => {
		const { channel, calls } = createChannel();
		let accesses = 0;
		const hostile = new Proxy({}, {
			ownKeys: () => { accesses++; throw new Error('private ownKeys'); },
			getOwnPropertyDescriptor: () => { accesses++; throw new Error('private descriptor'); },
			get: () => { accesses++; throw new Error('private get'); },
		});

		assert.throws(() => channel.call('window:2', 'prepareBind', [hostile]), /protocol/i);
		assert.strictEqual(accesses, 0);
		assert.throws(() => channel.call('window:1', 'bind', ['token', 'view', { url: '', title: '' }]), /protocol/i);
		assert.deepStrictEqual(calls, []);
	});
});
