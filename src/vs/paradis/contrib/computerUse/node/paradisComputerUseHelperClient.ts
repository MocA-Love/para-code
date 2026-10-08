/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process から Computer Use の補助アプリを起動し、Unix ソケットで話す（設計書 3.1、5.3、6.1）。
//
//  - 起動は `open -n -g`（LaunchServices）。Para Code の子として exec すると TCC の許可が Para Code で評価されうるため
//  - ソケットとトークンは userData の下の 0700 のフォルダに置く。トークンは 256 bit の乱数で、補助アプリが読んだ直後に消す
//  - 1 行 1 JSON。要求ごとに 60 秒で打ち切り、打ち切ったら接続を切る（補助アプリは切断で終わる）
//  - 状態（設計書 5.3）を持ち、`ok` 以外ではツールを出さない。途中で落ちたら次の呼び出しで 1 回だけ起動し直し、
//    続けて落ちたら `launch-failed` にする
//
// 補助アプリとの約束の中身は native/macos/Sources/ParadisComputerUseCore/ParadisProtocol.swift を見ること。

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import { createConnection, Socket } from 'net';
import { release, tmpdir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisComputerUsePermissions,
	PARADIS_COMPUTER_USE_APP_NAME,
	PARADIS_COMPUTER_USE_EXECUTABLE,
	PARADIS_COMPUTER_USE_MIN_DARWIN_MAJOR,
	PARADIS_COMPUTER_USE_PROTOCOL_VERSION,
	ParadisComputerUseAvailability,
} from '../common/paradisComputerUse.js';

/** 1 回の要求の上限。 */
export const PARADIS_COMPUTER_USE_REQUEST_TIMEOUT_MS = 60_000;
/** 起動してからソケットが開くまで待つ上限。 */
export const PARADIS_COMPUTER_USE_LAUNCH_TIMEOUT_MS = 10_000;
/**
 * 接続してから handshake の応答までの上限。補助アプリはこの間に相手を確かめる（リリースではアプリの封印を
 * 読み直すので、手元の計測で 1〜2 秒かかる。レビュー N2）。
 */
export const PARADIS_COMPUTER_USE_HANDSHAKE_TIMEOUT_MS = 30_000;
/** 応答 1 行の上限（スクショの base64 を含む）。 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Unix ソケットのパスの上限（`sockaddr_un.sun_path` は 104 バイトで、末尾の NUL を含む）。 */
const MAX_SOCKET_PATH_BYTES = 103;
/** 要求の途中で続けて落ちたら起動の失敗とみなす回数。 */
const MAX_CONSECUTIVE_CRASHES = 2;

/** 補助アプリが返した失敗、または接続の失敗。`code` はエージェントへの説明の出し分けに使う。 */
export class ParadisComputerUseHelperError extends Error {
	/** 長い入力を途中で止めたとき、送り終えた数（補助アプリが返す）。 */
	progress?: number;

	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'ParadisComputerUseHelperError';
	}
}

/** handshake と status の応答。 */
export interface IParadisComputerUseHelperStatus {
	readonly protocolVersion: number;
	readonly helperVersion: string;
	readonly pid: number;
	readonly osVersion?: string;
	readonly permissions: IParadisComputerUsePermissions;
	readonly responsibility: 'self' | 'other' | 'unknown';
	readonly responsiblePid?: number;
}

/** 補助アプリとのやりとりのうち、ツールが使う部分（テストで差し替える）。 */
export interface IParadisComputerUseHelper {
	readonly availability: ParadisComputerUseAvailability;
	readonly detail: string | undefined;
	readonly lastStatus: IParadisComputerUseHelperStatus | undefined;
	request(method: string, params?: object, signal?: AbortSignal): Promise<unknown>;
}

/** OS とファイルへの触れ方（テストで差し替える）。 */
export interface IParadisComputerUseHelperHost {
	readonly platform: NodeJS.Platform;
	/** `os.release()`（Darwin の版）。 */
	readonly osRelease: string;
	/** 補助アプリの .app を探す場所（先に見つかったものを使う）。 */
	readonly helperCandidates: readonly string[];
	/** ソケット・トークン・pid のファイルを置くフォルダ（0700 にする）。 */
	readonly runtimeDirectory: string;
	exists(path: string): boolean;
	/** 補助アプリを `open -n -g` で起動する。`open` が失敗したら reject。 */
	launch(appPath: string, args: readonly string[], stderrFile: string): Promise<void>;
	connect(socketPath: string): Socket;
	/** 前回の補助アプリが残っていれば終わらせる。 */
	terminateStaleHelper(pid: number): Promise<void>;
	randomToken(): string;
}

export function createParadisComputerUseHelperHost(appRoot: string, userDataPath: string, isBuilt: boolean): IParadisComputerUseHelperHost {
	return {
		platform: process.platform,
		osRelease: release(),
		helperCandidates: [
			// パッケージ版: <Para Code.app>/Contents/Resources/app → <Para Code.app>/Contents/Helpers
			join(appRoot, '..', '..', 'Helpers', PARADIS_COMPUTER_USE_APP_NAME),
			// 開発時だけ: node build/paradis/computerUse/buildHelper.ts の出力（パッケージ版はアプリの中を探さない。レビュー L4）
			...(isBuilt ? [] : [join(appRoot, '.build', 'paradis', 'computerUse', PARADIS_COMPUTER_USE_APP_NAME)]),
		],
		runtimeDirectory: join(userDataPath, 'paradis-computer-use'),
		exists: path => existsSync(path),
		launch: (appPath, args, stderrFile) => new Promise<void>((resolve, reject) => {
			// -n: 毎回新しいインスタンス / -g: 前面に出さない / -j: 隠して起動
			execFile('/usr/bin/open', ['-n', '-g', '-j', '--stderr', stderrFile, appPath, '--args', ...args], { timeout: PARADIS_COMPUTER_USE_LAUNCH_TIMEOUT_MS }, error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		}),
		connect: socketPath => createConnection(socketPath),
		terminateStaleHelper: pid => new Promise<void>(resolve => {
			// pid は使い回されるので、その pid が今も補助アプリの実行ファイルであるときだけ終わらせる
			execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], (error, stdout) => {
				if (!error && stdout.trim().endsWith(`/${PARADIS_COMPUTER_USE_EXECUTABLE}`)) {
					try {
						process.kill(pid, 'SIGTERM');
					} catch {
						// もう無い
					}
				}
				resolve();
			});
		}),
		randomToken: () => randomBytes(32).toString('hex'),
	};
}

/** Darwin の版から、対応する macOS か。 */
export function paradisIsSupportedDarwin(platform: NodeJS.Platform, osRelease: string): boolean {
	if (platform !== 'darwin') {
		return false;
	}
	const major = Number.parseInt(osRelease.split('.')[0], 10);
	return Number.isFinite(major) && major >= PARADIS_COMPUTER_USE_MIN_DARWIN_MAJOR;
}

/** handshake の応答を読む。形が違えば undefined。 */
export function paradisParseHelperStatus(value: unknown): IParadisComputerUseHelperStatus | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const permissions = record.permissions && typeof record.permissions === 'object' ? record.permissions as Record<string, unknown> : undefined;
	const responsibility = record.responsibility && typeof record.responsibility === 'object' ? record.responsibility as Record<string, unknown> : undefined;
	if (typeof record.protocolVersion !== 'number' || typeof record.helperVersion !== 'string' || typeof record.pid !== 'number' || !permissions) {
		return undefined;
	}
	const status = responsibility?.status === 'self' || responsibility?.status === 'other' ? responsibility.status : 'unknown';
	return {
		protocolVersion: record.protocolVersion,
		helperVersion: record.helperVersion,
		pid: record.pid,
		...(typeof record.osVersion === 'string' ? { osVersion: record.osVersion } : {}),
		permissions: paradisParseHelperPermissions(permissions),
		responsibility: status,
		...(typeof responsibility?.pid === 'number' ? { responsiblePid: responsibility.pid } : {}),
	};
}

/** `{ accessibility: 'granted' | 'not-granted', screenRecording: ... }` を真偽値にする。分からないものは未許可。 */
export function paradisParseHelperPermissions(value: unknown): IParadisComputerUsePermissions {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return { accessibility: record.accessibility === 'granted', screenRecording: record.screenRecording === 'granted' };
}

// --- 1 本の接続 -----------------------------------------------------------------------------

interface IPendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly dispose: () => void;
}

/** 補助アプリへの 1 本の接続。1 行 1 JSON の要求と応答を突き合わせる。 */
class ParadisHelperConnection {
	private _nextId = 1;
	private readonly _pending = new Map<number, IPendingRequest>();
	private _buffer = '';
	private _closed = false;
	/** 要求の途中で切れたか（落ちた）。何も待っていないときの切断は正常な終わり（10 分の待ち切れなど）。 */
	private _closedWhileBusy = false;

	constructor(private readonly _socket: Socket, private readonly _onClose: (closedWhileBusy: boolean) => void, private readonly _onTimeout: () => void = () => { }) {
		_socket.setEncoding('utf8');
		_socket.on('data', (chunk: string) => this._onData(chunk));
		_socket.on('error', () => this._close());
		_socket.on('close', () => this._close());
	}

	get closed(): boolean {
		return this._closed;
	}

	send(method: string, params: object, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this._closed) {
			return Promise.reject(new ParadisComputerUseHelperError('helper_disconnected', 'The Computer Use helper is not connected.'));
		}
		if (signal?.aborted) {
			return Promise.reject(new ParadisComputerUseHelperError('cancelled', 'The request was cancelled.'));
		}
		const id = this._nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				// 応答しない補助アプリは作り直す（切れば補助アプリは自分で終わる）
				this._pending.delete(id);
				cleanup();
				reject(new ParadisComputerUseHelperError('timeout', `The Computer Use helper did not answer ${method} in time.`));
				this.destroy();
				this._onTimeout();
			}, timeoutMs);
			const onAbort = () => {
				this._pending.delete(id);
				cleanup();
				reject(new ParadisComputerUseHelperError('cancelled', 'The request was cancelled.'));
				// 背面入力の途中でも補助アプリが切断を検出し、送信を止めてフォーカスを戻せるようにする。
				this.destroy();
			};
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this._pending.set(id, { resolve, reject, dispose: cleanup });
			this._socket.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	destroy(): void {
		this._socket.destroy();
		this._close();
	}

	private _onData(chunk: string): void {
		this._buffer += chunk;
		if (this._buffer.length > MAX_RESPONSE_BYTES) {
			this.destroy();
			return;
		}
		let newline = this._buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this._buffer.slice(0, newline);
			this._buffer = this._buffer.slice(newline + 1);
			if (line.length > 0) {
				this._onLine(line);
			}
			newline = this._buffer.indexOf('\n');
		}
	}

	private _onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.destroy();
			return;
		}
		const record = message && typeof message === 'object' ? message as Record<string, unknown> : {};
		const pending = typeof record.id === 'number' ? this._pending.get(record.id) : undefined;
		if (!pending) {
			return;
		}
		this._pending.delete(record.id as number);
		pending.dispose();
		if (record.ok === true) {
			pending.resolve(record.result);
			return;
		}
		const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
		const failure = new ParadisComputerUseHelperError(
			typeof error.code === 'string' ? error.code : 'helper_error',
			typeof error.message === 'string' ? error.message : 'The Computer Use helper returned an error.',
		);
		if (typeof error.progress === 'number' && Number.isInteger(error.progress) && error.progress >= 0) {
			failure.progress = error.progress;
		}
		pending.reject(failure);
	}

	private _close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._closedWhileBusy = this._pending.size > 0;
		for (const pending of this._pending.values()) {
			pending.dispose();
			pending.reject(new ParadisComputerUseHelperError('helper_disconnected', 'The Computer Use helper stopped while answering.'));
		}
		this._pending.clear();
		this._onClose(this._closedWhileBusy);
	}
}

// --- クライアント ---------------------------------------------------------------------------

/** 待つ上限（テストで短くする）。 */
export interface IParadisComputerUseHelperTimeouts {
	readonly requestTimeoutMs?: number;
	readonly launchTimeoutMs?: number;
}

/**
 * 補助アプリの起動・接続・状態。
 *
 * `availability` は `listTools()`（同期）から読まれるので、確かめるのは {@link check} と {@link request} の中で
 * 非同期に行い、結果を覚えておく。
 */
export class ParadisComputerUseHelperClient extends Disposable implements IParadisComputerUseHelper {

	private _availability: ParadisComputerUseAvailability = 'unchecked';
	private _detail: string | undefined;
	private _status: IParadisComputerUseHelperStatus | undefined;
	private _connection: ParadisHelperConnection | undefined;
	private _connecting: Promise<ParadisHelperConnection> | undefined;
	private _consecutiveCrashes = 0;
	private _staleHelperChecked = false;
	/** {@link stop} のたびに進める。止めた後に終わった起動の結果を捨てるため。 */
	private _generation = 0;

	private readonly _requestTimeoutMs: number;
	private readonly _launchTimeoutMs: number;

	constructor(
		private readonly _host: IParadisComputerUseHelperHost,
		private readonly _logService: ILogService | undefined,
		timeouts: IParadisComputerUseHelperTimeouts = {},
	) {
		super();
		this._requestTimeoutMs = timeouts.requestTimeoutMs ?? PARADIS_COMPUTER_USE_REQUEST_TIMEOUT_MS;
		this._launchTimeoutMs = timeouts.launchTimeoutMs ?? PARADIS_COMPUTER_USE_LAUNCH_TIMEOUT_MS;
	}

	get availability(): ParadisComputerUseAvailability {
		return this._availability;
	}

	get detail(): string | undefined {
		return this._detail;
	}

	get lastStatus(): IParadisComputerUseHelperStatus | undefined {
		return this._status;
	}

	/**
	 * 補助アプリを起動せずに分かる前提（OS と部品の有無）。足りなければその状態、そろっていれば undefined。
	 */
	staticAvailability(): ParadisComputerUseAvailability | undefined {
		if (!paradisIsSupportedDarwin(this._host.platform, this._host.osRelease)) {
			return 'unsupported-os';
		}
		return this._findHelper() ? undefined : 'missing';
	}

	/** 機能がオフの間の状態（起動はしない）。 */
	markDisabled(): void {
		this.stop();
		this._availability = this.staticAvailability() ?? 'unchecked';
		this._detail = undefined;
	}

	/** 起動して handshake まで確かめ、状態を返す。既につながっていれば status を取り直す。 */
	async check(): Promise<ParadisComputerUseAvailability> {
		this._consecutiveCrashes = 0;
		try {
			const connection = await this._ensureConnection();
			const status = paradisParseHelperStatus(await connection.send('status', {}, this._requestTimeoutMs));
			if (status) {
				this._status = status;
			}
		} catch (error) {
			this._logService?.warn(`[ParadisComputerUse] helper check failed: ${toMessage(error)}`);
		}
		return this._availability;
	}

	async request(method: string, params: object = {}, signal?: AbortSignal): Promise<unknown> {
		if (this._availability !== 'ok' && this._availability !== 'unchecked') {
			throw new ParadisComputerUseHelperError('unavailable', `The Computer Use helper is not available (${this._availability}).`);
		}
		const connection = await this._ensureConnection();
		const result = await connection.send(method, params, this._requestTimeoutMs, signal);
		this._consecutiveCrashes = 0;
		return result;
	}

	/** 接続を切る（補助アプリは切断で終わる）。 */
	stop(): void {
		this._generation++;
		this._connecting = undefined;
		this._connection?.destroy();
		this._connection = undefined;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}

	private _ensureConnection(): Promise<ParadisHelperConnection> {
		if (this._connection && !this._connection.closed) {
			return Promise.resolve(this._connection);
		}
		if (!this._connecting) {
			const generation = this._generation;
			const connecting = this._launchAndConnect(generation).finally(() => {
				if (this._connecting === connecting) {
					this._connecting = undefined;
				}
			});
			this._connecting = connecting;
		}
		return this._connecting;
	}

	private async _launchAndConnect(generation: number): Promise<ParadisHelperConnection> {
		const fail = (availability: ParadisComputerUseAvailability, detail: string): never => {
			if (generation === this._generation) {
				this._availability = availability;
				this._detail = detail;
			}
			throw new ParadisComputerUseHelperError('unavailable', detail);
		};
		const staticAvailability = this.staticAvailability();
		if (staticAvailability) {
			fail(staticAvailability, staticAvailability === 'missing' ? 'The Computer Use helper is not included in this build.' : 'Computer Use needs macOS 14 or later.');
		}
		const appPath = this._findHelper()!;
		const runtimeDirectory = await this._prepareRuntimeDirectory();
		await this._terminateStaleHelper(runtimeDirectory);

		const session = await this._createSessionDirectory(runtimeDirectory);
		const socketPath = join(session, 'h.sock');
		const tokenPath = join(session, 'token');
		const token = this._host.randomToken();
		let connection: ParadisHelperConnection | undefined;
		try {
			await fs.writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
			try {
				// `--state-dir`: 補助アプリがクラッシュしても次の起動で戻せるよう、AXManualAccessibility を立てたアプリの記録を置く
				await this._host.launch(appPath, ['--agent', '--socket', socketPath, '--token-file', tokenPath, '--state-dir', runtimeDirectory], join(runtimeDirectory, 'helper.log'));
			} catch (error) {
				fail('launch-failed', `open failed: ${toMessage(error)}`);
			}
			const socket = await this._waitAndConnect(socketPath);
			if (!socket) {
				fail('launch-failed', `the helper did not open its socket within ${this._launchTimeoutMs / 1000}s${await this._helperLogTail(runtimeDirectory)}`);
			}
			// 応答しない補助アプリは、切断に気づくのを待たずに終わらせる（AX の呼び出しの中で止まっていても残さない。レビュー L5）
			connection = new ParadisHelperConnection(socket!, closedWhileBusy => this._onConnectionClosed(connection!, closedWhileBusy), () => {
				const pid = this._status?.pid;
				if (pid !== undefined) {
					void this._host.terminateStaleHelper(pid);
				}
			});
			let hello: unknown;
			try {
				hello = await connection.send('handshake', { token, protocolVersion: PARADIS_COMPUTER_USE_PROTOCOL_VERSION }, Math.max(this._launchTimeoutMs, PARADIS_COMPUTER_USE_HANDSHAKE_TIMEOUT_MS));
			} catch (error) {
				fail('launch-failed', `handshake failed: ${toMessage(error)}${await this._helperLogTail(runtimeDirectory)}`);
			}
			const status = paradisParseHelperStatus(hello);
			if (!status || status.protocolVersion !== PARADIS_COMPUTER_USE_PROTOCOL_VERSION) {
				fail('incompatible', `helper protocol ${status?.protocolVersion ?? 'unknown'} does not match ${PARADIS_COMPUTER_USE_PROTOCOL_VERSION}`);
			}
			// 許可が補助アプリ以外（Para Code 本体など）で評価されるなら、許可をアプリごとの承認に閉じ込められない。止める
			if (status!.responsibility === 'other') {
				fail('misattributed', `TCC responsibility belongs to pid ${status!.responsiblePid ?? 'unknown'}, not the helper`);
			}
			if (generation !== this._generation) {
				throw new ParadisComputerUseHelperError('cancelled', 'Computer Use was turned off while the helper was starting.');
			}
			await fs.writeFile(join(runtimeDirectory, 'helper.pid'), String(status!.pid), { mode: 0o600 }).catch(() => undefined);
			this._status = status;
			this._availability = 'ok';
			this._detail = undefined;
			this._connection = connection;
			this._logService?.info(`[ParadisComputerUse] helper ${status!.helperVersion} started (responsibility: ${status!.responsibility})`);
			return connection;
		} catch (error) {
			connection?.destroy();
			throw error;
		} finally {
			// 補助アプリが消しているはずだが、起動に失敗したときに残らないよう、こちらでも消す
			await fs.rm(session, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private _onConnectionClosed(connection: ParadisHelperConnection, closedWhileBusy: boolean): void {
		if (this._connection === connection) {
			this._connection = undefined;
		}
		if (!closedWhileBusy || this._availability !== 'ok') {
			return;
		}
		// 答えている途中で落ちた。次の呼び出しで 1 回だけ起動し直し、続けて落ちたら止める
		this._consecutiveCrashes++;
		if (this._consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
			this._availability = 'launch-failed';
			this._detail = 'the helper stopped repeatedly while answering';
			this._logService?.warn('[ParadisComputerUse] helper stopped repeatedly; Computer Use is disabled until it is turned on again');
		}
	}

	private _findHelper(): string | undefined {
		return this._host.helperCandidates.find(candidate => this._host.exists(join(candidate, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE)));
	}

	private async _prepareRuntimeDirectory(): Promise<string> {
		const directory = this._host.runtimeDirectory;
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		// 前からあったフォルダは作り直さないので、権限だけ締め直す
		await fs.chmod(directory, 0o700);
		return directory;
	}

	/** ソケットとトークンを置く、その起動だけのフォルダ（0700）。パスが長すぎれば一時フォルダへ逃がす。 */
	private async _createSessionDirectory(runtimeDirectory: string): Promise<string> {
		const session = await fs.mkdtemp(join(runtimeDirectory, 's-'));
		if (Buffer.byteLength(join(session, 'h.sock')) <= MAX_SOCKET_PATH_BYTES) {
			return session;
		}
		await fs.rm(session, { recursive: true, force: true });
		// macOS の一時フォルダ（/var/folders/...）はユーザーごとで、mkdtemp は 0700 で作る
		return fs.mkdtemp(join(tmpdir(), 'pcu-'));
	}

	private async _terminateStaleHelper(runtimeDirectory: string): Promise<void> {
		if (this._staleHelperChecked) {
			return;
		}
		this._staleHelperChecked = true;
		const pidFile = join(runtimeDirectory, 'helper.pid');
		const pid = Number.parseInt(await fs.readFile(pidFile, 'utf8').catch(() => ''), 10);
		if (Number.isInteger(pid) && pid > 1) {
			await this._host.terminateStaleHelper(pid);
		}
		await fs.rm(pidFile, { force: true }).catch(() => undefined);
	}

	/**
	 * ソケットができるのを待ってつなぐ。ファイルができてから listen までの間につなぐと断られるので、
	 * 断られたら締め切りまでつなぎ直す（補助アプリが受けるのは最初に成立した 1 本だけ）。
	 */
	private async _waitAndConnect(socketPath: string): Promise<Socket | undefined> {
		const deadline = Date.now() + this._launchTimeoutMs;
		while (Date.now() < deadline) {
			if (this._host.exists(socketPath)) {
				const socket = await this._connect(socketPath).catch(() => undefined);
				if (socket) {
					return socket;
				}
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return undefined;
	}

	private _connect(socketPath: string): Promise<Socket> {
		return new Promise<Socket>((resolve, reject) => {
			const socket = this._host.connect(socketPath);
			const onError = (error: Error) => {
				socket.destroy();
				reject(error);
			};
			socket.once('error', onError);
			socket.once('connect', () => {
				socket.off('error', onError);
				resolve(socket);
			});
		});
	}

	/** 補助アプリの標準エラーの末尾（起動の失敗の理由。秘密は書かない作り）。 */
	private async _helperLogTail(runtimeDirectory: string): Promise<string> {
		const text = await fs.readFile(join(runtimeDirectory, 'helper.log'), 'utf8').catch(() => '');
		const tail = text.trim().split('\n').slice(-3).join(' | ').slice(-300);
		return tail ? ` (helper: ${tail})` : '';
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
