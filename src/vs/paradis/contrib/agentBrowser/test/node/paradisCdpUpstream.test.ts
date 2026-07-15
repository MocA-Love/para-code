/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCdpUpstream } from '../../node/paradisCdpUpstream.js';

suite('ParadisCdpUpstream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('invalidates a stale cached port and retries once', async () => {
		const reads = ['41001\n', '41002\n'];
		const urls: string[] = [];
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => reads.shift()!),
			fetch: async (url: string) => {
				urls.push(url);
				if (url.includes(':41001/')) {
					throw new Error('ECONNREFUSED');
				}
				return jsonResponse({ Browser: 'ok' });
			},
			fetchTimeoutMs: 5_000,
		});

		assert.deepStrictEqual(await upstream.fetchJson('/json/version'), { Browser: 'ok' });
		assert.deepStrictEqual(urls, [
			'http://127.0.0.1:41001/json/version',
			'http://127.0.0.1:41002/json/version',
		]);
	});

	test('returns the port used by the successful refreshed fetch as one result', async () => {
		const reads = ['41001\n', '41002\n'];
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => reads.shift()!),
			fetch: async (url: string) => {
				if (url.includes(':41001/')) {
					throw new Error('stale port');
				}
				return jsonResponse({ webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' });
			},
		});

		assert.deepStrictEqual(await upstream.fetchJsonWithPort('/json/version'), {
			value: { webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' },
			port: 41002,
		});
	});

	test('does not retry more than once', async () => {
		let attempts = 0;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => `${41001 + attempts}\n`),
			fetch: async () => {
				attempts++;
				throw new Error('offline');
			},
			fetchTimeoutMs: 5_000,
		});

		await assert.rejects(() => upstream.fetchJson('/json/list'), /Upstream CDP fetch failed after port refresh/);
		assert.strictEqual(attempts, 2);
	});

	test('rejects oversized and malformed upstream JSON without using Response.json', async () => {
		for (const bytes of [
			new Uint8Array(8 * 1024 * 1024 + 1),
			new TextEncoder().encode('{"unterminated":'),
		]) {
			let attempts = 0;
			const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
				openFile: openPortFile(() => '41001\n'),
				fetch: async () => {
					attempts++;
					return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
				},
			});
			await assert.rejects(() => upstream.fetchJson('/json/list'), /Upstream CDP fetch failed after port refresh/);
			assert.strictEqual(attempts, 2);
		}
	});

	test('accepts only a small strict decimal DevToolsActivePort', async () => {
		for (const invalid of ['41001junk\n', ' 41001\n', '65536\n', `${'1'.repeat(129)}\n`]) {
			let fetchCalls = 0;
			const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
				openFile: openPortFile(() => invalid),
				fetch: async () => { fetchCalls++; return jsonResponse({}); },
			});
			assert.strictEqual(await upstream.resolvePort(0), undefined);
			assert.strictEqual(fetchCalls, 0);
		}
	});

	test('never asks an injected port-file handle to read more than the strict prefix bound', async () => {
		let maximumReadLength = 0;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => `41001\n${'private'.repeat(10_000)}`, length => {
				maximumReadLength = Math.max(maximumReadLength, length);
			}),
		});
		assert.strictEqual(await upstream.resolvePort(0), undefined);
		assert.ok(maximumReadLength <= 129);
	});
});

function jsonResponse(value: unknown): Pick<Response, 'ok' | 'status' | 'arrayBuffer'> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
}

function openPortFile(contents: () => string, onRead?: (length: number) => void): typeof fs.open {
	return (async () => {
		const source = Buffer.from(contents(), 'utf8');
		return {
			read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				onRead?.(length);
				const bytesRead = Math.min(length, Math.max(0, source.byteLength - position));
				source.copy(buffer, offset, position, position + bytesRead);
				return { bytesRead, buffer };
			},
			close: async () => undefined,
		};
	}) as unknown as typeof fs.open;
}
