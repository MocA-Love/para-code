/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test expectations)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAivisClient } from '../../node/paradisAivisClient.js';

/** signal が abort されたら AbortError で落ちる、応答しない fetch。 */
function hangingFetch(_input: URL, init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
	});
}

/** ヘッダーは返すが本文が止まる fetch（本文の読み取りは abort されるまで終わらない）。 */
function stalledBodyFetch(_input: URL, init: RequestInit): Promise<Response> {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			init.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		},
	});
	return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
}

suite('ParadisAivisClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const failure = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: Error) => error.message);

	test('gives the dictionary export and import the longer limit', async () => {
		const slow = (_input: URL, init: RequestInit) => new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => resolve(new Response('{}', { status: 200 })), 100);
			init.signal?.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
			});
		});
		const client = new ParadisAivisClient(slow, 30, 1_000);
		assert.deepStrictEqual({
			me: await failure(client.getMe('key')),
			exported: await client.exportDictionary('key', 'uuid'),
			imported: await failure(client.importDictionary('key', 'uuid', {}, false)),
		}, {
			me: 'Aivis API のリクエストがタイムアウトしました',
			exported: {},
			imported: 'resolved',
		});
	});

	test('gives up when the API does not answer or stops in the middle of the body, and keeps the HTTP error and the missing model as before', async () => {
		const notFound = new ParadisAivisClient(async () => new Response('missing', { status: 404 }), 50);
		const serverError = new ParadisAivisClient(async () => new Response('boom', { status: 500 }), 50);
		assert.deepStrictEqual({
			hanging: await failure(new ParadisAivisClient(hangingFetch, 50).getMe('key')),
			stalledBody: await failure(new ParadisAivisClient(stalledBodyFetch, 50).getUsageDaily('key', '2026-11-01', '2026-11-03')),
			missingModel: await notFound.getModel('key', 'uuid'),
			httpError: await failure(serverError.listDictionaries('key')),
		}, {
			hanging: 'Aivis API のリクエストがタイムアウトしました',
			stalledBody: 'Aivis API のリクエストがタイムアウトしました',
			missingModel: null,
			httpError: 'Aivis API エラー (HTTP 500): boom',
		});
	});
});
