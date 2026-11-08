/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process から、シミュレータのホストの子プロセスを起こし、見張り、止める。
//
//  - 起こし方は pty host と同じ: `process.execPath` + `ELECTRON_RUN_AS_NODE` で `bootstrap-fork` を動かし、
//    `VSCODE_ESM_ENTRYPOINT` でホストの入口を読ませる。`VSCODE_PARENT_PID` を渡すので、shared process が
//    死ねばホストも終わる（アップデートをまたいで残す pty の常駐とは逆の選択）。
//  - token は起こすたびに 32 バイトの乱数。環境変数ではなく stdin の 1 行目で渡す。
//  - ソケットは `$TMPDIR` の下の 0700 のフォルダに `pcsim-<8桁>.sock`（macOS の sun_path は 104 バイトまで）。
//  - ホストの TMPDIR・TMP・TEMP は userData の下の専用フォルダ。serve-sim はそこに状態のファイルを書き、
//    「起動していない端末の helper」の pid を止めるので、利用者の serve-sim や Orca と共有しない。
//  - 落ちたら次の要求で起こし直す。60 秒の間に 3 回落ちたら、その間は起こさずに理由を返す。
//  - 前回のホストの止め残しは、pid の記録を見て、argv に印と専用フォルダがあるものだけを止める。

import { ChildProcess, execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorHostHandshake, PARADIS_SIMULATOR_HOST_ENTRY, PARADIS_SIMULATOR_HOST_MARKER, PARADIS_SIMULATOR_HOST_READY } from '../common/paradisSimulator.js';
import { PARADIS_SERVE_SIM_DIR, PARADIS_SERVE_SIM_MIDDLEWARE } from './paradisServeSimDist.js';

/** ホストへつなぐのに要るもの。 */
export interface IParadisSimulatorHostConnection {
	readonly socketPath: string;
	readonly token: string;
}

export interface IParadisSimulatorHostProvider {
	/** 動いているホストを返す。動いていなければ起こす。 */
	ensure(): Promise<IParadisSimulatorHostConnection>;
	readonly isRunning: boolean;
	readonly lastError: string | undefined;
}

export type ParadisSimulatorSpawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;

export interface IParadisSimulatorHostProcessOptions {
	/** userData。ホストの専用の TMPDIR と pid の記録を置く。 */
	readonly userDataPath: string;
	readonly logService: ILogService;
	/** ソケットのフォルダを置く場所。既定は shared process の `os.tmpdir()`。 */
	readonly socketParentDir?: string;
	readonly spawnChild?: ParadisSimulatorSpawn;
	readonly execPath?: string;
	/** `bootstrap-fork` のパス。 */
	readonly bootstrapPath?: string;
	/** 準備できた印を待つ時間。 */
	readonly readyTimeoutMs?: number;
	/** 同梱した serve-sim のフォルダ（テスト用。既定は `out/` の中の同梱の場所）。 */
	readonly serveSimDir?: string;
}

/** macOS の `sockaddr_un.sun_path` の大きさ（終端の NUL を含む）。 */
const SUN_PATH_MAX = 104;
const READY_TIMEOUT_MS = 20_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
const STOP_GRACE_MS = 3_000;
/** 起動に失敗したときの理由に添える、ホストの stderr の行の数。 */
const STDERR_TAIL_LINES = 20;

/**
 * 自分だけが触れるフォルダを用意する。在れば、シンボリックリンクでないこと・持ち主が自分であることを
 * 確かめ、権限を 0700 に絞る。満たさなければ投げる（他人が先に作ったフォルダにソケットを置かない）。
 */
export async function paradisEnsurePrivateDir(path: string): Promise<string> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${path} is not a directory`);
	}
	if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
		throw new Error(`${path} is owned by another user`);
	}
	if ((stat.mode & 0o077) !== 0) {
		await fs.chmod(path, 0o700);
	}
	return path;
}

const SOCKET_NAME = /^pcsim-[0-9a-f]{8}\.sock$/;

/** そのソケットで誰かが待ち受けているか（つながれば生きている）。 */
async function socketIsLive(path: string): Promise<boolean> {
	const { connect } = await import('net');
	return new Promise(resolve => {
		const socket = connect(path);
		const done = (live: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(live);
		};
		const timer = setTimeout(() => done(true), 1000);
		socket.once('connect', () => done(true));
		socket.once('error', (error: NodeJS.ErrnoException) => done(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
	});
}

/**
 * ソケットのフォルダ（{@link paradisEnsurePrivateDir} で用意した 0700 のもの）から、前のホストが残した
 * `pcsim-*.sock` を消す。消すのは、名前が合い、ソケットで、持ち主が自分で、誰も待ち受けていないものだけ
 * （同じ利用者の別の Para Code（開発版と配布版など）が同じフォルダを使っていても、生きているソケットには触れない）。
 * 消した数を返す。
 */
export async function paradisRemoveStaleSimulatorSockets(socketDir: string): Promise<number> {
	let removed = 0;
	for (const name of await fs.readdir(socketDir)) {
		if (!SOCKET_NAME.test(name)) {
			continue;
		}
		const path = join(socketDir, name);
		try {
			const stat = await fs.lstat(path);
			if (!stat.isSocket() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
				continue;
			}
			if (await socketIsLive(path)) {
				continue;
			}
			await fs.unlink(path);
			removed++;
		} catch {
			// 調べている間に消えた・消せない。次の起動でまた試す
		}
	}
	return removed;
}

/** ホストの argv に付ける印（専用フォルダごと）。 */
export function paradisSimulatorHostMarker(stateDir: string): string {
	return `${PARADIS_SIMULATOR_HOST_MARKER}=${stateDir}`;
}

interface IHostRecord {
	readonly pid: number;
	readonly marker: string;
}

interface IRunningHost {
	readonly child: ChildProcess;
	readonly connection: IParadisSimulatorHostConnection;
}

export class ParadisSimulatorHostProcess extends Disposable implements IParadisSimulatorHostProvider {

	private readonly _stateDir: string;
	private readonly _recordPath: string;
	private _running: IRunningHost | undefined;
	private _starting: Promise<IParadisSimulatorHostConnection> | undefined;
	private _crashes: number[] = [];
	private _lastError: string | undefined;
	private _staleChecked = false;
	private _disposed = false;

	constructor(private readonly _options: IParadisSimulatorHostProcessOptions) {
		super();
		const root = join(_options.userDataPath, 'paradis-simulator');
		this._stateDir = join(root, 'host-tmp');
		this._recordPath = join(root, 'host.json');
		this._register({ dispose: () => { this._disposed = true; void this.stop(); } });
	}

	get isRunning(): boolean {
		return !!this._running;
	}

	/** 動いているホストの pid（診断・テスト用）。 */
	get pid(): number | undefined {
		return this._running?.child.pid;
	}

	get lastError(): string | undefined {
		return this._lastError;
	}

	/** ホストの専用の TMPDIR（テスト・診断用）。 */
	get stateDir(): string {
		return this._stateDir;
	}

	async ensure(): Promise<IParadisSimulatorHostConnection> {
		if (this._disposed) {
			throw new Error('The simulator host is shutting down');
		}
		if (this._running) {
			return this._running.connection;
		}
		if (!this._starting) {
			this._starting = this._start().finally(() => this._starting = undefined);
		}
		return this._starting;
	}

	/** ホストを止める（stdin を閉じ、終わらなければ SIGTERM、まだなら SIGKILL）。 */
	async stop(): Promise<void> {
		const running = this._running;
		this._running = undefined;
		if (!running) {
			return;
		}
		await this._stopChild(running.child);
	}

	private async _stopChild(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
		child.stdin?.end();
		const timeout = (ms: number) => new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
		if (await Promise.race([exited, timeout(STOP_GRACE_MS)]) === 'timeout') {
			child.kill('SIGTERM');
			if (await Promise.race([exited, timeout(STOP_GRACE_MS)]) === 'timeout') {
				child.kill('SIGKILL');
			}
		}
	}

	private _recentCrashes(now: number): number {
		this._crashes = this._crashes.filter(at => now - at < CRASH_WINDOW_MS);
		return this._crashes.length;
	}

	private async _start(): Promise<IParadisSimulatorHostConnection> {
		// 配布のときに公証が通らなかった版は serve-sim のフォルダごと外してある（para-release.yml）。
		// 落ちる子を起こして「落ち続ける」に数えず、ここで理由をはっきり返す
		const serveSimDir = this._options.serveSimDir ?? FileAccess.asFileUri(PARADIS_SERVE_SIM_DIR).fsPath;
		try {
			await fs.access(join(serveSimDir, PARADIS_SERVE_SIM_MIDDLEWARE));
		} catch {
			this._lastError = 'serve-sim is not included in this build of Para Code';
			throw new Error(this._lastError);
		}
		if (this._recentCrashes(Date.now()) >= MAX_CRASHES_IN_WINDOW) {
			throw new Error(`The simulator host stopped ${MAX_CRASHES_IN_WINDOW} times within a minute; not restarting it for now (${this._lastError ?? 'no reason recorded'})`);
		}
		await paradisEnsurePrivateDir(join(this._options.userDataPath, 'paradis-simulator'));
		await paradisEnsurePrivateDir(this._stateDir);
		if (!this._staleChecked) {
			this._staleChecked = true;
			await this._stopStaleHost();
		}

		const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
		const socketDir = await paradisEnsurePrivateDir(join(this._options.socketParentDir ?? tmpdir(), `pcsim-${uid}`));
		const removed = await paradisRemoveStaleSimulatorSockets(socketDir);
		if (removed) {
			this._options.logService.info(`[paradis-simulator] removed ${removed} socket(s) left over by earlier hosts`);
		}
		const socketPath = join(socketDir, `pcsim-${randomBytes(4).toString('hex')}.sock`);
		if (Buffer.byteLength(socketPath) >= SUN_PATH_MAX) {
			throw new Error(`The simulator host socket path is too long (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`);
		}
		const handshake: IParadisSimulatorHostHandshake = { token: randomBytes(32).toString('base64url'), socketPath };
		const marker = paradisSimulatorHostMarker(this._stateDir);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			VSCODE_ESM_ENTRYPOINT: PARADIS_SIMULATOR_HOST_ENTRY,
			VSCODE_PARENT_PID: String(process.pid),
			TMPDIR: this._stateDir,
			TMP: this._stateDir,
			TEMP: this._stateDir,
		};
		// ELECTRON_RUN_AS_NODE は Electron の上でだけ付ける。素の Node（CI の node 単体テストの mocha）で付けると、
		// bootstrap-esm が Electron だと思って `fs` を Electron にしか無い `original-fs` へ向け、ホストが読み込みで落ちる
		if (process.versions.electron) {
			env.ELECTRON_RUN_AS_NODE = '1';
		} else {
			delete env.ELECTRON_RUN_AS_NODE;
		}
		// serve-sim はこれを token の既定にする。渡した token だけを使わせる
		delete env.SERVE_SIM_AUTH_TOKEN;
		delete env.SERVE_SIM_DEVICE_SET;
		// shared process から受け継いだ、bootstrap-fork の振る舞いを変える値は持ち込まない
		// （ログを IPC へ流す・未処理の例外の扱い。このホストは IPC を持たず、stderr へ出す）
		delete env.VSCODE_PIPE_LOGGING;
		delete env.VSCODE_VERBOSE_LOGGING;
		delete env.VSCODE_HANDLES_UNCAUGHT_ERRORS;
		delete env.VSCODE_CRASH_REPORTER_PROCESS_TYPE;

		const spawnChild: ParadisSimulatorSpawn = this._options.spawnChild ?? ((command, args, options) => spawn(command, args, options));
		const bootstrapPath = this._options.bootstrapPath ?? FileAccess.asFileUri('bootstrap-fork').fsPath;
		const child = spawnChild(this._options.execPath ?? process.execPath, [bootstrapPath, marker], { env, stdio: ['pipe', 'pipe', 'pipe'] });
		void this._writeRecord({ pid: child.pid ?? 0, marker });

		// 準備できる前に落ちた・待ちきれなかったときに理由へ添えるため、stderr の終わりの数行を取っておく
		const stderrTail: string[] = [];
		child.stderr?.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split('\n')) {
				if (line.trim()) {
					this._options.logService.info(`[paradis-simulator] host: ${line.trim()}`);
					stderrTail.push(line.trim());
					if (stderrTail.length > STDERR_TAIL_LINES) {
						stderrTail.shift();
					}
				}
			}
		});
		child.stdin?.on('error', () => { /* 落ちた子への書き込み。exit で扱う */ });

		try {
			await this._waitForReady(child, handshake);
		} catch (error) {
			await this._stopChild(child);
			const reason = error instanceof Error ? error.message : String(error);
			this._lastError = stderrTail.length ? `${reason}; host stderr: ${stderrTail.join(' | ')}` : reason;
			this._crashes.push(Date.now());
			throw new Error(this._lastError);
		}

		const running: IRunningHost = { child, connection: handshake };
		this._running = running;
		this._lastError = undefined;
		child.once('exit', (code, signal) => {
			if (this._running === running) {
				this._running = undefined;
				this._crashes.push(Date.now());
				this._lastError = `The simulator host exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`;
				this._options.logService.warn(`[paradis-simulator] ${this._lastError}; it restarts on the next request`);
			}
		});
		this._options.logService.info(`[paradis-simulator] host started (pid ${child.pid})`);
		return handshake;
	}

	private _waitForReady(child: ChildProcess, handshake: IParadisSimulatorHostHandshake): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let stdout = '';
			const timer = setTimeout(() => finish(new Error('The simulator host did not become ready in time')), this._options.readyTimeoutMs ?? READY_TIMEOUT_MS);
			const onData = (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
				if (stdout.split('\n').some(line => line.trim() === PARADIS_SIMULATOR_HOST_READY)) {
					finish(undefined);
				} else if (stdout.length > 64 * 1024) {
					stdout = stdout.slice(-1024);
				}
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`The simulator host exited before it was ready (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
			const onError = (error: Error) => finish(error);
			const finish = (error: Error | undefined) => {
				clearTimeout(timer);
				child.stdout?.off('data', onData);
				child.off('exit', onExit);
				child.off('error', onError);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			child.stdout?.on('data', onData);
			child.once('exit', onExit);
			child.once('error', onError);
			child.stdin?.write(`${JSON.stringify(handshake)}\n`);
		});
	}

	private async _writeRecord(record: IHostRecord): Promise<void> {
		try {
			await fs.writeFile(this._recordPath, JSON.stringify(record), { mode: 0o600 });
		} catch (error) {
			this._options.logService.warn('[paradis-simulator] could not write the host record', error);
		}
	}

	/** 前回のホストが残っていれば止める。argv に印（専用フォルダ込み）が無いプロセスには触れない。 */
	private async _stopStaleHost(): Promise<void> {
		let record: IHostRecord;
		try {
			record = JSON.parse(await fs.readFile(this._recordPath, 'utf8')) as IHostRecord;
		} catch {
			return;
		}
		if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid === process.pid || record.marker !== paradisSimulatorHostMarker(this._stateDir)) {
			return;
		}
		const args = await new Promise<string | undefined>(resolve => execFile('ps', ['-ww', '-o', 'args=', '-p', String(record.pid)], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout)));
		// macOS の ps は `-ww` が無いと行を切り、末尾の印が落ちる。
		// 専用フォルダのパスは空白を含みうる（`Application Support`）ので、語に分けずに含むかで見る
		if (!args || !args.includes(record.marker)) {
			return;
		}
		try {
			process.kill(record.pid, 'SIGTERM');
			this._options.logService.info(`[paradis-simulator] stopped a simulator host left over from the previous session (pid ${record.pid})`);
		} catch {
			// もう居ない
		}
	}
}
