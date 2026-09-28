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
			getMobileWireVersion: async mobileId => mobileId === 'new-app' ? 3 : undefined,
			send: (channel, mobileId, payload) => sent.push(`${channel} ${mobileId} ${new TextDecoder().decode(payload)}`),
		};
	}

	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

	test('登録した種類だけを受け、応答・知らせ・git・相手の capability と版を渡す。id は本文で上書きさせない', async () => {
		const disposables = store.add(new DisposableStore());
		disposables.add(registerParadisMobileRequestHandler('scm', 'goldenPush', {
			async handle(_accessor, request, context) {
				const git = await context.runGit(['push', '--dry-run']);
				context.push({ t: 'goldenProgress', step: 1 });
				context.reply({ id: 'spoofed', t: 'goldenPush', ok: true, git: git.stdout, root: context.root?.path, supported: await context.hasMobileCapability('scm.golden.v1'), wire: await context.mobileWireVersion() ?? null });
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
			paradisDispatchMobileRequest('scm', { t: 'goldenPush', id: 'r1', ws: 'repo' }, 'new-app', host),
			paradisDispatchMobileRequest('scm', { t: 'goldenPush', id: 'r2', ws: 'repo' }, 'old-app', host),
			paradisDispatchMobileRequest('fs', { t: 'goldenFail', id: 'r3' }, 'new-app', host),
			paradisDispatchMobileRequest('scm', { t: 'status', id: 'r4', ws: 'repo' }, 'new-app', host),
			paradisDispatchMobileRequest('fs', 'not an object', 'new-app', host),
			paradisDispatchMobileRequest('scm', { t: 'goldenPush', ws: 'repo' }, 'new-app', host),
		];
		await flush();
		assert.deepStrictEqual({ handled, sent }, {
			handled: [true, true, true, false, false, false],
			sent: [
				'fs new-app {"error":"boom","id":"r3"}',
				'scm new-app {"t":"goldenProgress","step":1}',
				'scm old-app {"t":"goldenProgress","step":1}',
				'scm new-app {"id":"r1","t":"goldenPush","ok":true,"git":"/repo push --dry-run","root":"/repo","supported":true,"wire":3}',
				'scm old-app {"id":"r2","t":"goldenPush","ok":true,"git":"/repo push --dry-run","root":"/repo","supported":false,"wire":null}',
			],
		});
	});

	test('既存の種類と同じ種類の二重登録は例外にし、登録を外せば既存の処理へ戻る', () => {
		const handler = { handle() { } };
		assert.throws(() => registerParadisMobileRequestHandler('scm', 'status', handler), /handled by the provider/);
		assert.throws(() => registerParadisMobileRequestHandler('fs', 'read', handler), /handled by the provider/);
		const registration = registerParadisMobileRequestHandler('scm', 'goldenOnce', handler);
		assert.throws(() => registerParadisMobileRequestHandler('scm', 'goldenOnce', handler), /already registered/);
		registration.dispose();
		assert.strictEqual(paradisDispatchMobileRequest('scm', { t: 'goldenOnce', id: 'r1' }, 'new-app', createHost([])), false);
	});
});
