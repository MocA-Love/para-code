/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest, registerParadisMobileRequestHandler } from '../../electron-browser/paradisMobileRequestHandlers.js';

suite('ParadisMobileRequestHandlers', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHost(sent: string[]): IParadisMobileRequestHost {
		return {
			invokeFunction: fn => fn({} as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: async (root, args) => ({ code: 0, stdout: `${root.path} ${args.join(' ')}`, stderr: '' }),
			resolvePath: async (_ws, relativePath) => URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async mobileId => mobileId === 'new-app' ? ['scm.golden.v1'] : undefined,
			send: (channel, mobileId, payload) => sent.push(`${channel} ${mobileId} ${new TextDecoder().decode(payload)}`),
		};
	}

	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
	const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));

	test('登録した種類だけを受け、応答・知らせ・git・相手の capability を渡す。既存の種類と 2 進は素通しする', async () => {
		const disposables = store.add(new DisposableStore());
		disposables.add(registerParadisMobileRequestHandler('scm', 'goldenPush', {
			async handle(_accessor, request, context) {
				const git = await context.runGit(['push', '--dry-run']);
				context.push({ t: 'goldenProgress', step: 1 });
				context.reply({ t: 'goldenPush', ok: true, git: git.stdout, root: context.root?.path, supported: await context.hasMobileCapability('scm.golden.v1') });
			},
		}));
		disposables.add(registerParadisMobileRequestHandler('fs', 'goldenFail', {
			handle() {
				throw new Error('boom');
			},
		}));
		const sent: string[] = [];
		const host = createHost(sent);
		const handled = [
			paradisDispatchMobileRequest('scm', encode({ t: 'goldenPush', id: 'r1', ws: 'repo' }), 'new-app', host),
			paradisDispatchMobileRequest('scm', encode({ t: 'goldenPush', id: 'r2', ws: 'repo' }), 'old-app', host),
			paradisDispatchMobileRequest('fs', encode({ t: 'goldenFail', id: 'r3' }), 'new-app', host),
			paradisDispatchMobileRequest('scm', encode({ t: 'status', id: 'r4', ws: 'repo' }), 'new-app', host),
			paradisDispatchMobileRequest('fs', new Uint8Array([0x50, 0x43, 0x55, 0x01]), 'new-app', host),
			paradisDispatchMobileRequest('scm', encode({ t: 'goldenPush', ws: 'repo' }), 'new-app', host),
		];
		await flush();
		assert.deepStrictEqual({ handled, sent }, {
			handled: [true, true, true, false, false, false],
			sent: [
				'fs new-app {"id":"r3","error":"boom"}',
				'scm new-app {"t":"goldenProgress","step":1}',
				'scm old-app {"t":"goldenProgress","step":1}',
				'scm new-app {"id":"r1","t":"goldenPush","ok":true,"git":"/repo push --dry-run","root":"/repo","supported":true}',
				'scm old-app {"id":"r2","t":"goldenPush","ok":true,"git":"/repo push --dry-run","root":"/repo","supported":false}',
			],
		});
	});

	test('同じ種類の二重登録は例外にし、登録を外せば既存の処理へ戻る', () => {
		const handler = { handle() { } };
		const registration = registerParadisMobileRequestHandler('scm', 'goldenOnce', handler);
		assert.throws(() => registerParadisMobileRequestHandler('scm', 'goldenOnce', handler), /already registered/);
		registration.dispose();
		assert.strictEqual(paradisDispatchMobileRequest('scm', encode({ t: 'goldenOnce', id: 'r1' }), 'new-app', createHost([])), false);
	});
});
