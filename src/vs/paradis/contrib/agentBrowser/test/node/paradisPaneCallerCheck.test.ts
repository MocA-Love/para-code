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
import { paradisIsOtherPaneCaller, paradisOtherPaneShellPids, paradisToolNeedsPaneCaller } from '../../node/paradisPaneCallerCheck.js';

suite('paradisPaneCallerCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ブラウザの道具・内蔵 chrome-devtools-mcp の道具は接続元を調べ、プロバイダの道具とタブに触れない道具は調べない', () => {
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

	test('照合するのは名乗ったペイン以外の手元のペインのシェルだけ（接続先のペイン・シェルの分からないペイン・名乗ったペインと同じシェルは外す）', () => {
		const panes = [
			{ token: 'bot', shellPid: 50 },
			{ token: 'user', shellPid: 90 },
			{ token: 'remote', shellPid: 70, remoteAuthority: 'ssh-remote+host' },
			{ token: 'starting', shellPid: undefined },
			{ token: 'board', shellPid: 60 },
			{ token: 'user-again', shellPid: 90 },
		];
		assert.deepStrictEqual({
			user: paradisOtherPaneShellPids('user', panes),
			bot: paradisOtherPaneShellPids('bot', panes),
			remote: paradisOtherPaneShellPids('remote', panes),
			unknown: paradisOtherPaneShellPids('nobody', [{ token: 'user', shellPid: 90 }]),
			refused: (['descendant', 'unknown', 'tunnel'] as const).map(kind => paradisIsOtherPaneCaller(kind)),
		}, {
			user: [50, 60],
			bot: [60, 90],
			remote: [50, 60, 90],
			unknown: [90],
			refused: [true, false, false],
		});
	});

	// 実際のプロセス表で確かめる。このテストのプロセスを Bot のペインのシェルに見立て、その子（Playwright や curl の
	// 代わり）から loopback で繋ぐ。利用者のペインのシェルは関係の無い別のプロセス
	(isWindows ? test.skip : test)('Bot のペインの中のプロセスが利用者のペインのトークンを名乗ると断り、自分のトークン・どのペインの外のプロセスは通す', async function () {
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
			const otherPane = async (claimed: string, panes: { token: string; shellPid: number }[]) => paradisIsOtherPaneCaller(
				await paradisClassifyPeer(remotePort, serverPort, process.pid, { ancestorPids: paradisOtherPaneShellPids(claimed, panes) }, undefined, { budgetMs: 20_000 }));
			const panes = [{ token: 'bot', shellPid: process.pid }, { token: 'user', shellPid: unrelated.pid! }];
			assert.deepStrictEqual({
				// Bot のペインの中から、利用者のペインのトークンを名乗った
				stolen: await otherPane('user', panes),
				// Bot のペインの中から、自分のトークンで呼んだ
				own: await otherPane('bot', panes),
				// どのペインの中でもない（tmux などで切り離した）プロセスが名乗った。見分けられないので通す
				detached: await otherPane('user', [{ token: 'user', shellPid: unrelated.pid! }, { token: 'bot', shellPid: client.pid! + 100_000 }]),
			}, {
				stolen: true,
				own: false,
				detached: false,
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
