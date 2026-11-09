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
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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
import { ParadisServeSimBackend, ParadisSimulatorCaptureNotStartedError } from '../../node/paradisServeSimBackend.js';
import { IParadisSimulatorMiddleware, paradisStartSimulatorHostServer } from '../../node/paradisSimulatorHostServer.js';
import { PARADIS_SIMULATOR_HOST_READY } from '../../common/paradisSimulator.js';
import { PARADIS_SERVE_SIM_DIR, PARADIS_SERVE_SIM_MIDDLEWARE } from '../../node/paradisServeSimDist.js';
import { paradisEnsurePrivateDir, paradisRemoveStaleSimulatorSockets, ParadisSimulatorHostProcess, ParadisSimulatorSpawn } from '../../node/paradisSimulatorHostProcess.js';

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

/** info と warn を覚えるログ（段ごとの記録を確かめる）。 */
class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	override info(message: string): void {
		this.lines.push(message);
	}
	override warn(message: string): void {
		this.lines.push(message);
	}
}

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

	// 落ち続けるホストを起こし直し続けない: 60 秒の間に 3 回落ちたら、4 回目は起こさずに理由を返す
	test('stops restarting a host that keeps exiting', async () => {
		let spawned = 0;
		const spawnChild: ParadisSimulatorSpawn = () => {
			spawned++;
			const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: null; kill(): boolean };
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.pid = 100000 + spawned;
			child.exitCode = null;
			child.signalCode = null;
			child.kill = () => true;
			// 準備できた印を出した直後に落ちる
			child.stdin.once('data', () => {
				child.stdout.write(`${PARADIS_SIMULATOR_HOST_READY}\n`);
				setTimeout(() => {
					child.exitCode = 1;
					child.emit('exit', 1, null);
				}, 5);
			});
			return child as unknown as ChildProcess;
		};
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('crashing'), logService: new NullLogService(), socketParentDir: await scratchDir('crashingSockets'), spawnChild, bootstrapPath: 'bootstrap-fork' }));
		const exited = () => new Promise<void>(resolve => setTimeout(resolve, 30));
		for (let i = 0; i < 3; i++) {
			await host.ensure();
			await exited();
		}
		const refused = await host.ensure().then(() => 'started', error => error instanceof Error && error.message.includes('3 times within a minute') ? 'refused' : String(error));
		assert.deepStrictEqual({ spawned, refused, running: host.isRunning }, { spawned: 3, refused: 'refused', running: false });
	});

	// 準備できる前に落ちたホストの stderr を理由に添える（ログを捨てる環境でも、なぜ起きなかったかが分かる）
	test('says what the host printed to stderr when it exits before it is ready', async () => {
		const spawnChild: ParadisSimulatorSpawn = () => {
			const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: null; kill(): boolean };
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.pid = 100100;
			child.exitCode = null;
			child.signalCode = null;
			child.kill = () => true;
			child.stdin.once('data', () => {
				child.stderr.write('first line\n\nError: cannot load the entry\n');
				setTimeout(() => {
					child.exitCode = 1;
					child.emit('exit', 1, null);
				}, 5);
			});
			return child as unknown as ChildProcess;
		};
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('noisy'), logService: new NullLogService(), socketParentDir: await scratchDir('noisySockets'), spawnChild, bootstrapPath: 'bootstrap-fork' }));
		const reason = await host.ensure().then(() => 'started', error => error instanceof Error ? error.message : String(error));
		assert.deepStrictEqual({ reason, lastError: host.lastError }, {
			reason: 'The simulator host exited before it was ready (code 1, signal none); host stderr: first line | Error: cannot load the entry',
			lastError: 'The simulator host exited before it was ready (code 1, signal none); host stderr: first line | Error: cannot load the entry',
		});
	});

	// 前のホストが残したソケット（誰も待ち受けていないもの）だけを消し、生きているソケットと名前の違うファイルには触れない
	test('removes only the dead sockets left by earlier hosts', async () => {
		const dir = await scratchDir('staleSockets');
		const dead = join(dir, 'pcsim-0000dead.sock');
		const live = join(dir, 'pcsim-0000beef.sock');
		const other = join(dir, 'notes.txt');
		// 待ち受けたまま終わるプロセスは、ソケットのファイルを残す（kill -9 されたホストと同じ）
		const { spawn } = await import('child_process');
		const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(dead)}, () => process.exit(0))`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
		await new Promise(resolve => child.once('exit', resolve));
		const { createServer } = await import('net');
		const server = createServer();
		await new Promise<void>(resolve => server.listen(live, resolve));
		await fs.writeFile(other, 'keep');
		try {
			const removed = await paradisRemoveStaleSimulatorSockets(dir);
			assert.deepStrictEqual({ removed, left: (await fs.readdir(dir)).sort() }, { removed: 1, left: ['notes.txt', 'pcsim-0000beef.sock'] });
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	// 配布のときに serve-sim を外した版: 子を起こさず、その理由を返す
	test('reports a build without serve-sim instead of starting a host', async () => {
		let spawned = 0;
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('noServeSim'), logService: new NullLogService(), socketParentDir: await scratchDir('noServeSimSockets'), serveSimDir: join(SCRATCH_ROOT, 'missing-serve-sim'), spawnChild: () => { spawned++; throw new Error('must not spawn'); } }));
		const refused = await host.ensure().then(() => 'started', error => error instanceof Error ? error.message : String(error));
		assert.deepStrictEqual({ spawned, refused, lastError: host.lastError }, { spawned: 0, refused: 'serve-sim is not included in this build of Para Code', lastError: 'serve-sim is not included in this build of Para Code' });
	});

	// 準備できた後のホストの stdout（serve-sim のネイティブの `[capture] …` と console.log）もログへ流す。
	// paracode-183 では捨てていたため、取り込みが始まらなかったときに何も残らなかった
	test('logs what the host prints to stdout after it is ready', async () => {
		const spawnChild: ParadisSimulatorSpawn = () => {
			const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: null; kill(): boolean };
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.pid = 100200;
			child.exitCode = null;
			child.signalCode = null;
			child.kill = () => true;
			child.stdin.once('data', () => {
				child.stdout.write(`${PARADIS_SIMULATOR_HOST_READY}\n`);
				setTimeout(() => child.stdout.write('[capture] Frame callbacks registered (event-driven) + 5fps idle floor\n\n[capture] Framebuffer: 1206x2622'), 5);
				setTimeout(() => child.stdout.write(' (direct IOSurface, zero-copy)\n'), 10);
			});
			return child as unknown as ChildProcess;
		};
		const log = new RecordingLogService();
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('stdout'), logService: log, socketParentDir: await scratchDir('stdoutSockets'), spawnChild, bootstrapPath: 'bootstrap-fork' }));
		await host.ensure();
		await new Promise(resolve => setTimeout(resolve, 30));
		host.stop().catch(() => undefined);
		assert.deepStrictEqual(log.lines.filter(line => line.includes('host stdout')), [
			'[paradis-simulator] host stdout: [capture] Frame callbacks registered (event-driven) + 5fps idle floor',
			'[paradis-simulator] host stdout: [capture] Framebuffer: 1206x2622 (direct IOSurface, zero-copy)',
		]);
	});

	// 映像の要求に応答の頭が返らない（端末の取り込みが始まらない）とき: 受け口は段を記録し、shared process は期限で
	// 要求を捨てて「取り込みが始まらない」で終える（paracode-183 では黒いまま何も残らなかった）
	test('records the stages of a video request and gives up when the capture never starts', async () => {
		const token = randomBytes(32).toString('base64url');
		const socketPath = join(await scratchDir('silent'), `pcsim-${randomBytes(4).toString('hex')}.sock`);
		const hostLog: string[] = [];
		let closedByClient = false;
		// 映像の要求には何も返さない serve-sim の代わり（端末のセッションの開始が戻ってこない状態）
		const middleware = (async (req, res) => {
			if (req.url?.endsWith('/stream.mjpeg')) {
				res.once('close', () => closedByClient = true);
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{}');
		}) as IParadisSimulatorMiddleware;
		middleware.handleUpgrade = () => { };
		const server = await paradisStartSimulatorHostServer({ socketPath, token, middleware, onLog: message => hostLog.push(message), slowHeadersMs: 50 });
		try {
			const log = new RecordingLogService();
			const hostProvider = { ensure: async () => ({ socketPath, token }), isRunning: true, lastError: undefined };
			const backend = store.add(new ParadisServeSimBackend(hostProvider, log, async () => '', 200));
			const ended = await new Promise<Error | undefined>(resolve => {
				const subscription = backend.subscribeFrames(UDID, () => { }, error => {
					subscription.dispose();
					resolve(error);
				});
			});
			await new Promise(resolve => setTimeout(resolve, 30));
			assert.deepStrictEqual({
				notStarted: ended instanceof ParadisSimulatorCaptureNotStartedError,
				reason: ended?.message,
				closedByClient,
				hostLog: hostLog.map(line => line.replace(/\d+ ms/g, 'N ms')),
				sharedProcessLog: log.lines.map(line => line.replace(/\d+ ms/g, 'N ms')),
			}, {
				notStarted: true,
				reason: `The simulator host did not start capturing ${UDID} within 1 s`,
				closedByClient: true,
				hostLog: [
					`stream.mjpeg ${UDID}: received`,
					`stream.mjpeg ${UDID}: no answer after N ms (the device session has not started capturing)`,
					`stream.mjpeg ${UDID}: closed after N ms (status none)`,
				],
				sharedProcessLog: [
					`[paradis-simulator] video ${UDID}: requested`,
					`[paradis-simulator] video ${UDID}: host ready after N ms, request sent`,
					`[paradis-simulator] video ${UDID}: The simulator host did not start capturing ${UDID} within 1 s`,
					`[paradis-simulator] video ${UDID}: ended after N ms, 0 frame(s): The simulator host did not start capturing ${UDID} within 1 s`,
				],
			});
		} finally {
			await server.close();
		}
	});
});
