/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { createServer, Server, Socket } from 'net';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClassifyPeer } from '../../node/paradisCdpPeerResolver.js';
import { paradisGatewayPeerAllowed, paradisGatewayPeerExpectation, paradisToolNeedsPaneCaller } from '../../node/paradisPaneCallerCheck.js';

suite('paradisPaneCallerCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ブラウザの道具・内蔵 chrome-devtools-mcp の道具は接続元を確かめ、プロバイダの道具とタブに触れない道具は確かめない', () => {
		assert.deepStrictEqual({
			takeSnapshot: paradisToolNeedsPaneCaller('take_snapshot', { local: false, provider: false }),
			evaluateScript: paradisToolNeedsPaneCaller('evaluate_script', { local: false, provider: false }),
			getSharedPage: paradisToolNeedsPaneCaller('get_shared_page', { local: true, provider: false }),
			getCdpEndpoint: paradisToolNeedsPaneCaller('get_cdp_endpoint', { local: true, provider: false }),
			setCursorLabel: paradisToolNeedsPaneCaller('set_cursor_label', { local: true, provider: false }),
			listViewports: paradisToolNeedsPaneCaller('list_viewports', { local: true, provider: false }),
			previewFile: paradisToolNeedsPaneCaller('preview_file', { local: true, provider: false }),
			providerTool: paradisToolNeedsPaneCaller('mobile_tap', { local: false, provider: true }),
			empty: paradisToolNeedsPaneCaller('', { local: false, provider: false }),
		}, {
			takeSnapshot: true,
			evaluateScript: true,
			getSharedPage: true,
			getCdpEndpoint: true,
			setCursorLabel: true,
			listViewports: false,
			previewFile: false,
			providerTool: false,
			empty: false,
		});
	});

	test('CDP ゲートウェイは手元のペインのシェルの子孫・そのペインの chrome-devtools-mcp の子・接続先のペインの戻り経路だけを通す', () => {
		const local = { shellPid: 90 };
		const remote = { shellPid: 70, remoteAuthority: 'ssh-remote+host' };
		assert.deepStrictEqual({
			local: paradisGatewayPeerExpectation(local, [300], [500]),
			remote: paradisGatewayPeerExpectation(remote, [301], [500, 501]),
			unknownPane: paradisGatewayPeerExpectation(undefined, [], []),
			unknownPaneWithChild: paradisGatewayPeerExpectation(undefined, [302], []),
			localWithoutShell: paradisGatewayPeerExpectation({ shellPid: undefined }, [], [500]),
			allowed: [
				paradisGatewayPeerAllowed('descendant', local),
				paradisGatewayPeerAllowed('tunnel', local),
				paradisGatewayPeerAllowed('tunnel', remote),
				paradisGatewayPeerAllowed('unknown', local),
				paradisGatewayPeerAllowed('unknown', remote),
			],
		}, {
			local: { ancestorPids: [90, 300], tunnelPids: [] },
			remote: { ancestorPids: [301], tunnelPids: [500, 501] },
			unknownPane: undefined,
			unknownPaneWithChild: { ancestorPids: [302], tunnelPids: [] },
			localWithoutShell: undefined,
			allowed: [true, false, true, false, false],
		});
	});

	// 実際のプロセス表で確かめる（Playwright のような外部の道具が、ペインのシェルの子孫として通るか）。
	// このテストのプロセスをペインのシェルに見立て、子プロセスから loopback で繋ぐ
	(isWindows ? test.skip : test)('子プロセスの接続は、親を祖先に持つので通り、関係の無いプロセスを祖先にすると通らない', async function () {
		this.timeout(60_000);
		const accepted: Socket[] = [];
		const server: Server = createServer(socket => { accepted.push(socket); });
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const serverPort = (server.address() as { port: number }).port;
		const children: ChildProcess[] = [];
		const run = (script: string) => {
			const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
			children.push(child);
			return child;
		};
		try {
			const unrelated = run('setTimeout(() => {}, 60000)');
			const client = run(`const s = require('net').connect(${serverPort}, '127.0.0.1'); setTimeout(() => s.destroy(), 60000);`);
			const socket = await new Promise<Socket>((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error('the child did not connect')), 20_000);
				const poll = setInterval(() => {
					if (accepted.length > 0) {
						clearInterval(poll);
						clearTimeout(deadline);
						resolve(accepted[0]);
					}
				}, 50);
			});
			const remotePort = socket.remotePort!;
			const classify = (ancestorPids: number[]) => paradisClassifyPeer(remotePort, serverPort, process.pid, { ancestorPids }, undefined, { budgetMs: 20_000 });
			assert.deepStrictEqual({
				parent: await classify([process.pid]),
				devtoolsChild: await classify([client.pid!]),
				unrelated: await classify([unrelated.pid!]),
			}, {
				parent: 'descendant',
				devtoolsChild: 'descendant',
				unrelated: 'unknown',
			});
		} finally {
			for (const child of children) {
				child.kill();
			}
			for (const socket of accepted) {
				socket.destroy();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
