/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ホストの受け口を、同梱した本物の serve-sim のミドルウェアで確かめる（Linux・macOS）。
// シミュレータが無くても、token の検査・許可のルート・Unix ソケットだけで待ち受けることは確かめられる
// （端末のセッションは作れないので、通った要求は serve-sim の「No serve-sim device」の 404 になる）。

import assert from 'assert';
import { randomBytes } from 'crypto';
import { promises as fs, readdirSync, readFileSync, readlinkSync } from 'fs';
import type { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { isLinux, isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_SERVE_SIM_DIR, PARADIS_SERVE_SIM_MIDDLEWARE } from '../../node/paradisServeSimDist.js';
import { paradisEnsurePrivateDir, ParadisSimulatorHostProcess } from '../../node/paradisSimulatorHostProcess.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

interface IAnswer { readonly status: number | undefined; readonly body: string }

async function get(socketPath: string, path: string, token: string | undefined, method = 'GET'): Promise<IAnswer> {
	const { request } = await import('http');
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, path, method, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res: IncomingMessage) => {
			let body = '';
			res.on('data', chunk => body += chunk);
			res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 60) }));
		});
		req.once('error', reject);
		req.end();
	});
}

/** 入力の upgrade を試し、返ってきた状態の番号（101 なら通った）を返す。 */
async function upgrade(socketPath: string, path: string, token: string | undefined): Promise<number | undefined> {
	const { request } = await import('http');
	return new Promise((resolve, reject) => {
		const req = request({
			socketPath, path, headers: {
				Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		});
		req.once('upgrade', (res, socket) => {
			socket.destroy();
			resolve(res.statusCode);
		});
		req.once('response', res => {
			res.resume();
			resolve(res.statusCode);
		});
		req.once('error', reject);
		req.end();
	});
}

/** Linux で、そのプロセスが TCP で LISTEN しているソケットの数（/proc で数える）。 */
function linuxTcpListenCount(pid: number): number {
	const listening = new Set<string>();
	for (const table of ['tcp', 'tcp6']) {
		let text = '';
		try {
			text = readFileSync(`/proc/${pid}/net/${table}`, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n').slice(1)) {
			const columns = line.trim().split(/\s+/);
			if (columns[3] === '0A') {
				listening.add(columns[9]);
			}
		}
	}
	let count = 0;
	for (const fd of readdirSync(`/proc/${pid}/fd`)) {
		try {
			const inode = /^socket:\[(?<inode>\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.groups?.inode;
			if (inode && listening.has(inode)) {
				count++;
			}
		} catch {
			// 数えている間に閉じた fd
		}
	}
	return count;
}

const SCRATCH_ROOT = join(tmpdir(), `paradis-simulator-test-${process.pid}`);

async function scratchDir(name: string): Promise<string> {
	await paradisEnsurePrivateDir(SCRATCH_ROOT);
	return paradisEnsurePrivateDir(join(SCRATCH_ROOT, name));
}

(isWindows ? suite.skip : suite)('Paradis simulator: the host only listens on a Unix socket and checks the token', function () {
	this.timeout(60_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suiteTeardown(() => fs.rm(SCRATCH_ROOT, { recursive: true, force: true }));

	// 本物の起こし方（bootstrap-fork + VSCODE_ESM_ENTRYPOINT、token は stdin）で起こし、許可のルートと token の検査、
	// TCP を開いていないこと、止まることを確かめる
	test('starts the real host process, which checks the token, refuses routes outside the allow list, opens no TCP port, and stops', async () => {
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('userData'), logService: new NullLogService(), socketParentDir: await scratchDir('sockets') }));
		const { socketPath, token } = await host.ensure();
		const pid = host.pid ?? 0;
		const answers = {
			running: host.isRunning,
			socketMode: ((await fs.stat(socketPath)).mode & 0o777).toString(8),
			noToken: await get(socketPath, `/helper/${UDID}/config`, undefined),
			wrongToken: await get(socketPath, `/helper/${UDID}/config`, 'x'.repeat(43)),
			// 通った要求は serve-sim まで届く（シミュレータが無いので端末が無いという 404）
			withToken: await get(socketPath, `/helper/${UDID}/config`, token),
			exec: await get(socketPath, '/exec', token, 'POST'),
			devtools: await get(socketPath, '/devtools', token),
			diagnostics: await get(socketPath, '/api/diagnostics', token),
			gridStart: await get(socketPath, '/grid/api/start', token, 'POST'),
			page: await get(socketPath, '/', token),
			inputNoToken: await upgrade(socketPath, `/helper/${UDID}/ws`, undefined),
			execWs: await upgrade(socketPath, '/exec-ws', token),
			tcpListen: isLinux ? linuxTcpListenCount(pid) : 0,
		};
		await host.stop();
		assert.deepStrictEqual({ ...answers, runningAfterStop: host.isRunning }, {
			running: true,
			socketMode: '600',
			noToken: { status: 401, body: 'Unauthorized' },
			wrongToken: { status: 401, body: 'Unauthorized' },
			withToken: { status: 404, body: 'No serve-sim device' },
			exec: { status: 404, body: 'Not Found' },
			devtools: { status: 404, body: 'Not Found' },
			diagnostics: { status: 404, body: 'Not Found' },
			gridStart: { status: 404, body: 'Not Found' },
			page: { status: 404, body: 'Not Found' },
			inputNoToken: 401,
			execWs: 404,
			tcpListen: 0,
			runningAfterStop: false,
		});
	});

	// ホストの受け口を外しても、serve-sim 自身が Unix ソケットの相手を「ループバック」とみなさず token を求めること。
	// ミドルウェアは renderer では読めない（素の名前の `ws` を解決できない）ので、Electron を node として起こした子で動かす
	test('serve-sim itself treats a Unix socket peer as remote and asks for the token', async () => {
		const token = randomBytes(32).toString('base64url');
		const socketPath = join(await scratchDir('raw'), `pcsim-${randomBytes(4).toString('hex')}.sock`);
		const middlewareUrl = pathToFileURL(join(FileAccess.asFileUri(PARADIS_SERVE_SIM_DIR).fsPath, PARADIS_SERVE_SIM_MIDDLEWARE)).href;
		const script = [
			`const { simMiddleware } = await import(${JSON.stringify(middlewareUrl)});`,
			`const middleware = simMiddleware({ basePath: '', authToken: ${JSON.stringify(token)}, allowExec: false, serveSimBin: '/nonexistent' });`,
			`const { createServer } = await import('http');`,
			`const server = createServer((req, res) => { void middleware(req, res, async () => { res.writeHead(404); res.end(); }); });`,
			`server.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'));`,
			`process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`,
		].join('\n');
		const { spawn } = await import('child_process');
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve());
				child.once('exit', code => reject(new Error(`exited with ${code}`)));
			});
			assert.deepStrictEqual(
				[(await get(socketPath, `/helper/${UDID}/config`, undefined)).status, (await get(socketPath, `/helper/${UDID}/config`, token)).status],
				[401, 404],
			);
		} finally {
			child.stdin.end();
		}
	});
});
