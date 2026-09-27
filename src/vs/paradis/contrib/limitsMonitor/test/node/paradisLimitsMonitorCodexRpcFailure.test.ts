/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyCodexRpcFailure } from '../../node/paradisLimitsMonitorChannel.js';

suite('ParadisLimitsMonitor codex RPC failure classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps every session error shape to a kind that carries no message content', () => {
		const cases: Array<[unknown, string]> = [
			[new Error('codex not found (install it or set the executable path in settings)'), 'binary-missing'],
			[new Error('failed to launch codex app-server: spawn codex ENOENT'), 'spawn-failed'],
			[new Error('codex app-server exited (code=2, signal=null)'), 'exited'],
			[new Error(`codex app-server request 'initialize' timed out`), 'init-timeout'],
			[new Error(`codex app-server request 'account/rateLimits/read' timed out`), 'request-timeout'],
			[new Error('failed to fetch codex rate limits: GET https://example.invalid failed: 500 Internal Server Error'), 'rpc-error'],
			[new Error('failed to fetch codex rate limits: GET https://example.invalid failed: 401 Unauthorized'), 'auth'],
			[Object.assign(new Error('forbidden'), { httpStatus: 403 }), 'auth'],
			[new Error('codex account authentication required to read rate limits'), 'auth'],
			[new Error('chatgpt authentication required to read rate limits'), 'auth'],
			// Orca の一覧から足した文言
			[new Error('Your access token could not be refreshed because your refresh token was already used.'), 'auth'],
			[new Error('Not logged in. Please sign in again.'), 'auth'],
			[new Error('token data is not available'), 'auth'],
			// forbidden だけでは再ログインとみなさない（Cloudflare の 403 など）。HTTP の 403 は状態で判断する
			[new Error('upstream responded forbidden by policy'), 'unknown'],
			[new Error('something else entirely'), 'unknown'],
			['not an error', 'unknown'],
			[undefined, 'unknown'],
		];
		assert.deepStrictEqual(cases.map(([error]) => classifyCodexRpcFailure(error)), cases.map(([, kind]) => kind));
	});
});
