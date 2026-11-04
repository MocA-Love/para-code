/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import '../../electron-browser/paradisMobileAbsolutePathRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

/** 1 つのスペース（`root`）を持つウィンドウ。`remoteOs` を渡すと接続先の環境を返す（`null` は確かめられない接続先）。 */
async function ask(root: URI, requests: readonly { readonly id: string; readonly ws?: string; readonly path?: unknown }[], remoteOs?: OperatingSystem | null): Promise<unknown[]> {
	const services = new Map<unknown, unknown>([
		[IRemoteAgentService, { getEnvironment: async () => remoteOs === undefined || remoteOs === null ? null : { os: remoteOs } }],
	]);
	const sent: Uint8Array[] = [];
	const allSent = new DeferredPromise<void>();
	const host: IParadisMobileRequestHost = {
		invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
		resolveRoot: ws => ws === 'space' ? root : undefined,
		runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
		// スペースの外（`outside` で始まるパス）は、リンクの検査で断られたのと同じく undefined
		resolvePath: async (ws, relativePath) => ws === 'space' && !relativePath.startsWith('outside') ? URI.joinPath(root, relativePath) : undefined,
		getMobileCapabilities: async () => undefined,
		getMobileWireVersion: async () => undefined,
		send: (_channel, _mobileId, payload) => {
			sent.push(payload);
			if (sent.length === requests.length) {
				allSent.complete();
			}
		},
	};
	for (const request of requests) {
		paradisDispatchMobileRequest('fs', { t: 'absolutePath', ...request }, 'phone', host);
	}
	await allSent.p;
	return sent.map(payload => JSON.parse(new TextDecoder().decode(payload)) as { id: string }).sort((a, b) => a.id.localeCompare(b.id));
}

suite('ParadisMobileAbsolutePathRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('answers a local space with the file path and refuses malformed, unknown and outside paths', async () => {
		const root = URI.file('/work/para-code');
		assert.deepStrictEqual(await ask(root, [
			{ id: 'a', ws: 'space', path: 'app/mobile/src/store.ts' },
			{ id: 'b', ws: 'space', path: '../secret' },
			{ id: 'c', ws: 'space', path: 42 },
			{ id: 'd', ws: 'other', path: 'x.ts' },
			{ id: 'e', ws: 'space', path: 'outside-link/x.ts' },
		]), [
			{ t: 'absolutePath', path: URI.joinPath(root, 'app/mobile/src/store.ts').fsPath, remote: false, windows: process.platform === 'win32', id: 'a' },
			{ error: 'invalid absolute path request', code: 'invalid', id: 'b' },
			{ error: 'invalid absolute path request', code: 'invalid', id: 'c' },
			{ error: 'unknown workspace: other', id: 'd' },
			{ error: 'file not found in the space', code: 'missing', id: 'e' },
		]);
	});

	test('answers an SSH space with the path of the remote OS, and refuses when the remote cannot be checked', async () => {
		const linux = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+example', path: '/home/example/para-code' });
		const windows = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+example', path: '/c:/Users/example/para-code' });
		assert.deepStrictEqual({
			linux: await ask(linux, [{ id: 'a', ws: 'space', path: 'src/app.ts' }], OperatingSystem.Linux),
			windows: await ask(windows, [{ id: 'a', ws: 'space', path: 'src/app.ts' }], OperatingSystem.Windows),
			unreachable: await ask(linux, [{ id: 'a', ws: 'space', path: 'src/app.ts' }], null),
		}, {
			linux: [{ t: 'absolutePath', path: '/home/example/para-code/src/app.ts', remote: true, windows: false, id: 'a' }],
			windows: [{ t: 'absolutePath', path: 'c:\\Users\\example\\para-code\\src\\app.ts', remote: true, windows: true, id: 'a' }],
			unreachable: [{ error: 'the remote host is not reachable', code: 'remote', id: 'a' }],
		});
	});
});
