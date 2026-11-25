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
import type { IncomingMessage, ServerResponse } from 'http';
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
import { IParadisSimulatorHostConnection, paradisEnsurePrivateDir, paradisRemoveStaleSimulatorSockets, ParadisSimulatorHostProcess, ParadisSimulatorSpawn } from '../../node/paradisSimulatorHostProcess.js';

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

const OTHER_UDID = 'B1B2C3D4-0000-1111-2222-333344445555';
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

function mjpegPart(jpeg: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')]);
}

/**
 * serve-sim の代わり。端末ごとのセッションを持ち続け、`stale` に入っている端末の映像の要求には頭だけ返して
 * 1 枚も送らない（端末が起動し直された後に残ったセッション）。{@link IFakeSessionHost.provider} の `recycle` は
 * 本物のホストの起こし直しと同じく、開いている応答を切り、セッションを捨て、新しい接続を返すようにする。
 */
interface IFakeSessionHost {
	readonly provider: { ensure(): Promise<IParadisSimulatorHostConnection>; recycle(reason: string): Promise<void>; readonly isRunning: boolean; readonly lastError: undefined };
	readonly stale: Set<string>;
	readonly recycled: string[];
	/** 映像の要求が来た端末（来た順）。 */
	readonly streamRequests: string[];
	close(): Promise<void>;
}

async function startFakeSessionHost(name: string): Promise<IFakeSessionHost> {
	const token = randomBytes(32).toString('base64url');
	const socketPath = join(await scratchDir(name), `pcsim-${randomBytes(4).toString('hex')}.sock`);
	const stale = new Set<string>();
	const recycled: string[] = [];
	const streamRequests: string[] = [];
	const open = new Set<ServerResponse>();
	const middleware = (async (req, res) => {
		const [, , udid, endpoint] = (req.url ?? '').split('/');
		if (endpoint !== 'stream.mjpeg') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ width: 100, height: 200, orientation: 'portrait' }));
			return;
		}
		streamRequests.push(udid);
		open.add(res);
		res.once('close', () => open.delete(res));
		res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
		if (!stale.has(udid)) {
			res.write(mjpegPart(JPEG));
		}
	}) as IParadisSimulatorMiddleware;
	middleware.handleUpgrade = () => { };
	const server = await paradisStartSimulatorHostServer({ socketPath, token, middleware });
	let connection: IParadisSimulatorHostConnection = { socketPath, token };
	return {
		provider: {
			ensure: async () => connection,
			recycle: async reason => {
				recycled.push(reason);
				stale.clear();
				connection = { socketPath, token };
				for (const res of [...open]) {
					res.destroy();
				}
			},
			isRunning: true,
			lastError: undefined,
		},
		stale, recycled, streamRequests,
		close: () => server.close(),
	};
}

/** 様子が変わるたびに {@link changed} を呼んでもらい、条件が満たされたら解ける待ち（時計で見回らない）。 */
class Watch {
	private _waiters: { readonly check: () => boolean; readonly resolve: () => void }[] = [];

	changed(): void {
		const met = this._waiters.filter(waiter => waiter.check());
		this._waiters = this._waiters.filter(waiter => !met.includes(waiter));
		met.forEach(waiter => waiter.resolve());
	}

	when(check: () => boolean): Promise<void> {
		return check() ? Promise.resolve() : new Promise(resolve => this._waiters.push({ check, resolve }));
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

	// 端末が起動し直された後に残ったセッション: 頭は返るが 1 枚も来ない。ホストを起こし直して 1 回だけ頼み直し、
	// 利用者には映像が届く（paracode-194 では「端末の取り込みが始まりません」のまま、Para Code を開き直すまで直らなかった）
	test('restarts the host and asks again when a device session answers but sends no frame', async () => {
		const host = await startFakeSessionHost('staleSession');
		try {
			host.stale.add(UDID);
			const log = new RecordingLogService();
			const backend = store.add(new ParadisServeSimBackend(host.provider, log, async () => '', 2000, { readBootId: async () => undefined, firstFrameTimeoutMs: 60 }));
			const watch = new Watch();
			let frames = 0;
			let ended: Error | 'ended' | undefined;
			const subscription = backend.subscribeFrames(UDID, () => {
				frames++;
				watch.changed();
			}, error => {
				ended = error ?? 'ended';
				watch.changed();
			});
			await watch.when(() => frames > 0 || ended !== undefined);
			subscription.dispose();
			assert.deepStrictEqual({
				frames, ended, recycled: host.recycled, streamRequests: host.streamRequests,
				warnings: log.lines.filter(line => line.includes('no frame')).map(line => line.replace(/\d+ ms/g, 'N ms')),
			}, {
				frames: 1, ended: undefined, recycled: [`no frame from ${UDID}`], streamRequests: [UDID, UDID],
				warnings: [
					`[paradis-simulator] video ${UDID}: the host answered but sent no frame within N ms`,
					`[paradis-simulator] no frame from ${UDID}; restarting the simulator host to drop its device sessions`,
				],
			});
		} finally {
			await host.close();
		}
	});

	// 起こし直しても 1 枚も来ない: 2 回目は起こし直さずに「取り込みが始まらない」で終える（起こし直しを繰り返さない）
	test('gives up after one restart when the device still sends no frame', async () => {
		const host = await startFakeSessionHost('deadDevice');
		try {
			host.stale.add(UDID);
			const watch = new Watch();
			const recycle = host.provider.recycle;
			// 起こし直しても死んだまま
			host.provider.recycle = async reason => {
				await recycle(reason);
				host.stale.add(UDID);
				watch.changed();
			};
			const backend = store.add(new ParadisServeSimBackend(host.provider, new NullLogService(), async () => '', 2000, { readBootId: async () => undefined, firstFrameTimeoutMs: 40 }));
			const ended = await new Promise<Error | undefined>(resolve => {
				const subscription = backend.subscribeFrames(UDID, () => { }, error => {
					subscription.dispose();
					resolve(error);
				});
			});
			await watch.when(() => host.recycled.length === 2);
			assert.deepStrictEqual({
				notStarted: ended instanceof ParadisSimulatorCaptureNotStartedError, reason: ended?.message, streamRequests: host.streamRequests,
				// 2 回目は「再試行」が新しいホストから始まるように、終えた後で捨てておく分
				recycled: host.recycled,
			}, {
				notStarted: true, reason: `The simulator host started capturing ${UDID} but sent no frame within 1 s`, streamRequests: [UDID, UDID],
				recycled: [`no frame from ${UDID}`, `no video from ${UDID}`],
			});
		} finally {
			await host.close();
		}
	});

	// 端末の起動の識別が、ホストがセッションを開いたときと変わった: 次の要求の前にホストを起こし直す。
	// 起こし直しで切れた映像（その端末のものも、別の端末のものも）は、終わりにせず頼み直す
	test('restarts the host before a request when the device was booted again, and keeps every video stream', async () => {
		const host = await startFakeSessionHost('rebooted');
		try {
			const bootIds = new Map([[UDID, '100'], [OTHER_UDID, '200']]);
			const backend = store.add(new ParadisServeSimBackend(host.provider, new NullLogService(), async () => '', 2000, { readBootId: async udid => bootIds.get(udid), firstFrameTimeoutMs: 2000 }));
			const watch = new Watch();
			const frames: Record<string, number> = { [UDID]: 0, [OTHER_UDID]: 0 };
			const ended: string[] = [];
			const subscriptions = [UDID, OTHER_UDID].map(udid => backend.subscribeFrames(udid, () => {
				frames[udid]++;
				watch.changed();
			}, () => ended.push(udid)));
			await watch.when(() => frames[UDID] === 1 && frames[OTHER_UDID] === 1);
			const before = { recycled: [...host.recycled], config: await backend.getScreenConfig(UDID) };
			// 端末が止まって起動し直された。残ったセッションは 1 枚も送らない
			bootIds.set(UDID, '101');
			host.stale.add(UDID);
			await backend.getScreenConfig(UDID);
			await watch.when(() => frames[UDID] === 2 && frames[OTHER_UDID] === 2);
			// 同じ起動のままなら、もう起こし直さない
			await backend.getScreenConfig(UDID);
			await backend.getScreenConfig(OTHER_UDID);
			subscriptions.forEach(subscription => subscription.dispose());
			assert.deepStrictEqual({ before, frames, ended, recycled: host.recycled }, {
				before: { recycled: [], config: { width: 100, height: 200, orientation: 'portrait' } },
				frames: { [UDID]: 2, [OTHER_UDID]: 2 },
				ended: [],
				recycled: [`${UDID} was shut down or booted again after the host opened its session`],
			});
		} finally {
			await host.close();
		}
	});

	// 起動の識別を読めないまま開いたセッションは、どの起動のものか分からない。後で読めた識別を「開いたときのもの」と
	// みなさず、読めた時点で 1 回だけ起こし直す（読めないままなら起こし直さない）
	test('restarts the host once when the boot of an already opened session becomes readable', async () => {
		const host = await startFakeSessionHost('unknownBoot');
		try {
			let bootId: string | undefined = undefined;
			const backend = store.add(new ParadisServeSimBackend(host.provider, new NullLogService(), async () => '', 2000, { readBootId: async () => bootId, firstFrameTimeoutMs: 2000 }));
			await backend.getScreenConfig(UDID);
			await backend.getScreenConfig(UDID);
			const whileUnreadable = [...host.recycled];
			bootId = '100';
			await backend.getScreenConfig(UDID);
			await backend.getScreenConfig(UDID);
			assert.deepStrictEqual({ whileUnreadable, recycled: host.recycled }, {
				whileUnreadable: [],
				recycled: [`the host opened its session of ${UDID} before Para Code could tell which boot it belongs to`],
			});
		} finally {
			await host.close();
		}
	});

	// わざと起こし直すのは「落ちた」に数えない（60 秒に 3 回落ちると起こさなくなる決まりに掛からない）
	test('does not count restarting the host on purpose as a crash', async () => {
		let spawned = 0;
		const spawnChild: ParadisSimulatorSpawn = () => {
			spawned++;
			const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: null; kill(): boolean };
			child.stdin = new PassThrough();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.pid = 200000 + spawned;
			child.exitCode = null;
			child.signalCode = null;
			child.kill = () => true;
			child.stdin.once('data', () => child.stdout.write(`${PARADIS_SIMULATOR_HOST_READY}\n`));
			// stdin が閉じたら終わる（本物のホストと同じ）
			child.stdin.once('end', () => {
				child.exitCode = 0;
				child.emit('exit', 0, null);
			});
			return child as unknown as ChildProcess;
		};
		const host = store.add(new ParadisSimulatorHostProcess({ userDataPath: await scratchDir('recycling'), logService: new NullLogService(), socketParentDir: await scratchDir('recyclingSockets'), spawnChild, bootstrapPath: 'bootstrap-fork', serveSimDir: FileAccess.asFileUri(PARADIS_SERVE_SIM_DIR).fsPath }));
		const connections = new Set<IParadisSimulatorHostConnection>();
		for (let i = 0; i < 5; i++) {
			connections.add(await host.ensure());
			await host.recycle('test');
		}
		connections.add(await host.ensure());
		assert.deepStrictEqual({ spawned, connections: connections.size, running: host.isRunning }, { spawned: 6, connections: 6, running: true });
		await host.stop();
	});
});
