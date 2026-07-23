/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisSentryRateLimiter,
	paradisClassifySentryEvent,
	paradisSanitizeSentryEvent,
	paradisSanitizeSentryText,
	paradisSentryFingerprint,
} from '../../common/paradisSentryCommon.js';

suite('ParadisSentryCommon', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts credentials, environment values, user paths, and URL parameters', () => {
		const input = [
			'Authorization: Bearer secret-token',
			'OPENAI_API_KEY=sk-sensitive',
			'/Users/alice/projects/private/file.ts',
			'C:\\Users\\Alice\\workspace\\private\\file.ts',
			'https://example.test/path?token=secret#fragment',
		].join('\n');

		const sanitized = paradisSanitizeSentryText(input);

		assert.ok(!sanitized.includes('secret-token'));
		assert.ok(!sanitized.includes('sk-sensitive'));
		assert.ok(!sanitized.includes('alice'));
		assert.ok(!sanitized.includes('Alice'));
		assert.ok(!sanitized.includes('?token='));
		assert.ok(!sanitized.includes('#fragment'));
		assert.ok(sanitized.includes('Authorization: Bearer [Filtered]'));
		assert.ok(sanitized.includes('OPENAI_API_KEY=[Filtered]'));
		assert.ok(sanitized.includes('~/projects/private/file.ts'));
	});

	test('keeps diagnostic tags and stack shape while removing private event payloads', () => {
		const event = paradisSanitizeSentryEvent({
			message: 'failed at /home/alice/work/private.ts with token=secret',
			logentry: { message: 'failed at /Users/alice/private.ts', params: ['secret'] },
			user: { id: 'alice', email: 'alice@example.test' },
			request: { url: 'https://example.test/private?token=secret', headers: { authorization: 'Bearer secret' } },
			tags: { 'para.scope': 'owned', 'para.feature': 'terminal', unsafe: 'Bearer secret' },
			extra: { command: 'cat private.txt', safe_count: 4 },
			exception: {
				values: [{
					type: 'Error',
					value: 'failed for /Users/alice/private.txt',
					stacktrace: {
						frames: [{
							filename: '/Applications/Para Code.app/Contents/Resources/app/out/main.js',
							abs_path: '/Applications/Para Code.app/Contents/Resources/app/out/main.js',
							function: 'startTerminal',
						}],
					},
				}],
			},
			threads: {
				values: [{
					stacktrace: {
						frames: [{ filename: '/Users/alice/private.ts', abs_path: '/Users/alice/private.ts' }],
					},
				}],
			},
		});

		assert.strictEqual(event.user, undefined);
		assert.strictEqual(event.request, undefined);
		assert.deepStrictEqual(event.extra, { safe_count: 4 });
		assert.strictEqual(event.tags?.['para.scope'], 'owned');
		// The sanitizer intentionally keeps the credential label and filters only the
		// secret itself (same shape as `OPENAI_API_KEY=[Filtered]` asserted above).
		assert.strictEqual(event.tags?.unsafe, 'Bearer [Filtered]');
		assert.strictEqual(event.exception?.values?.[0].stacktrace?.frames?.[0].abs_path, 'app:///out/main.js');
		assert.ok(!String(event.message).includes('alice'));
		assert.ok(!String(event.logentry?.message).includes('alice'));
		assert.strictEqual(event.logentry?.params, undefined);
		assert.ok(!String(event.threads?.values[0].stacktrace?.frames?.[0].filename).includes('alice'));
	});

	test('limits one fingerprint to three events per ten-minute window and reports suppression', () => {
		let now = 1_000;
		const limiter = new ParadisSentryRateLimiter(() => now);

		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: false, suppressed: 1 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: false, suppressed: 2 });

		now += 10 * 60 * 1_000;
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 2 });
	});

	test('builds a stable fingerprint from scope, feature, operation, exception type, and top frame', () => {
		const first = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'codex-app-server', 'para.operation': 'connect' },
			exception: {
				values: [{
					type: 'TimeoutError',
					value: 'first message',
					stacktrace: { frames: [{ filename: 'app:///out/unrelated.js' }, { filename: 'app:///out/connection.js', function: 'connect' }] },
				}],
			},
		});
		const second = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'codex-app-server', 'para.operation': 'connect' },
			exception: {
				values: [{
					type: 'TimeoutError',
					value: 'different message',
					stacktrace: { frames: [{ filename: 'app:///out/unrelated.js' }, { filename: 'app:///out/connection.js', function: 'connect' }] },
				}],
			},
		});

		assert.strictEqual(first, second);
		assert.ok(first.includes('codex-app-server'));
		assert.ok(first.includes('connection.js'));
	});

	test('classifies automatic errors only when their stack enters Para Code-owned source', () => {
		assert.strictEqual(paradisClassifySentryEvent({
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/paradis/contrib/mobileRelay/node/client.js' }],
					},
				}],
			},
		}), 'owned');
		assert.strictEqual(paradisClassifySentryEvent({
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/workbench/browser/workbench.js' }],
					},
				}],
			},
		}), undefined);
		assert.strictEqual(paradisClassifySentryEvent({
			tags: { 'para.scope': 'patched' },
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/workbench/browser/workbench.js' }],
					},
				}],
			},
		}), 'patched');
		assert.strictEqual(paradisClassifySentryEvent({
			debug_meta: { images: [{ code_file: 'Para Code Framework' }] },
		}), 'unknown');
	});
});
