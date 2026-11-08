/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の端末 1 台ぶんの scrcpy の通話（q.html Q585 の ⑥b）。shared process で、同梱した scrcpy-server を
// 端末へ送り、adb reverse で端末から fork の待ち受けへつながらせ、映像と操作の 2 本のソケットを受ける。
//
//  - つなぎ方は reverse（scrcpy の既定）: 手元に開くのは fork の待ち受け（127.0.0.1 の空いた番号）だけで、
//    決まった本数（映像・操作の 2 本）を受けたら待ち受けを閉じ、reverse も外す。forward だと端末側の口が手元の
//    TCP に開き、fork より先にほかのプロセスがつなげば映像と操作を取られるため（設計書 5 節）
//  - 最初に受けたソケットは、端末の名前と H.264 の印を確かめてから映像として使う（違えば通話をやめる）
//  - 映像は H.264 の Annex B の包みのまま購読者へ渡す（renderer の WebCodecs が描く）
//  - 止めるときは server を動かしている `adb shell` を止め、ソケットを閉じ、reverse を外す（server は cleanup=true）

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import type { AddressInfo, Server, Socket } from 'net';
import { PARADIS_SCRCPY_DEVICE_PATH, ParadisScrcpyVideoEvent, ParadisScrcpyVideoParser, paradisScrcpyResetVideo, paradisScrcpyScid, paradisScrcpyServerArgs } from '../../common/paradisScrcpy.js';

/** adb を呼ぶ口（終わりを待つもの）。 */
export type ParadisScrcpyAdb = (args: readonly string[], timeoutMs: number) => Promise<string>;
/** server を動かし続ける `adb shell` を起こす口。 */
export type ParadisScrcpySpawn = (adbPath: string, args: readonly string[]) => ChildProcess;

const realSpawn: ParadisScrcpySpawn = (adbPath, args) => spawn(adbPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

export interface IParadisScrcpySessionOptions {
	readonly serial: string;
	readonly adbPath: string;
	/** 同梱した scrcpy-server の jar の場所（手元）。 */
	readonly serverJar: string;
	readonly adb: ParadisScrcpyAdb;
	readonly spawnServer?: ParadisScrcpySpawn;
	/** 映像の長い辺の上限（画素）。 */
	readonly maxSize?: number;
	readonly maxFps?: number;
	/** 2 本のソケットが来るまで待つ時間。 */
	readonly connectTimeoutMs?: number;
	/** 待ち受けを作る口（テストで差し替える）。 */
	readonly createServer?: () => Promise<Server>;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** 今の映像の大きさ（タッチの座標の基準）。 */
export interface IParadisScrcpyVideoSize {
	readonly width: number;
	readonly height: number;
}

export class ParadisScrcpySession extends Disposable {

	private readonly _onVideo = this._register(new Emitter<ParadisScrcpyVideoEvent>());
	/** 映像の包み（config・frame）と大きさの変化。 */
	readonly onVideo: Event<ParadisScrcpyVideoEvent> = this._onVideo.event;

	private readonly _onDidEnd = this._register(new Emitter<Error | undefined>());
	readonly onDidEnd = this._onDidEnd.event;

	private _server: ChildProcess | undefined;
	private _video: Socket | undefined;
	private _control: Socket | undefined;
	private _scid: string | undefined;
	private _size: IParadisScrcpyVideoSize | undefined;
	private _deviceName: string | undefined;
	/** 最後の config の包み（後から購読した renderer にも先に渡す。SPS・PPS が無いと復号できない）。 */
	private _config: Uint8Array | undefined;
	private _ended = false;

	constructor(private readonly _options: IParadisScrcpySessionOptions, private readonly _logService: ILogService) {
		super();
		this._register({ dispose: () => this._stop(undefined) });
	}

	get size(): IParadisScrcpyVideoSize | undefined {
		return this._size;
	}

	get deviceName(): string | undefined {
		return this._deviceName;
	}

	get config(): Uint8Array | undefined {
		return this._config;
	}

	get ended(): boolean {
		return this._ended;
	}

	/** server を送り、起こし、2 本のソケットを受けるまで待つ。 */
	async start(): Promise<void> {
		try {
			await this._start();
		} catch (error) {
			// 途中で失敗したら、起こした server を残さない
			this._stop(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private async _start(): Promise<void> {
		const { serial, adb } = this._options;
		await adb(['-s', serial, 'push', this._options.serverJar, PARADIS_SCRCPY_DEVICE_PATH], 60_000);
		const listener = await (this._options.createServer ?? createLoopbackServer)();
		const port = (listener.address() as AddressInfo).port;
		this._scid = paradisScrcpyScid(randomBytes(4).readUInt32BE(0) / 0xffffffff);
		const socketName = `localabstract:scrcpy_${this._scid}`;
		try {
			await adb(['-s', serial, 'reverse', socketName, `tcp:${port}`], 15_000);
			const sockets = this._acceptTwo(listener);
			const shell = (this._options.spawnServer ?? realSpawn)(this._options.adbPath, ['-s', serial, 'shell', ...paradisScrcpyServerArgs(this._scid, { maxSize: this._options.maxSize ?? 1600, maxFps: this._options.maxFps ?? 30 })]);
			this._server = shell;
			shell.stderr?.on('data', (chunk: Buffer) => this._logService.trace(`[paradis-simulator] scrcpy: ${chunk.toString('utf8').trim()}`));
			shell.once('exit', code => this._stop(new Error(`scrcpy-server exited (code ${code ?? 'none'})`)));
			const [video, control] = await sockets;
			this._video = video;
			this._control = control;
		} finally {
			listener.close();
			void adb(['-s', serial, 'reverse', '--remove', socketName], 15_000).catch(() => undefined);
		}
		this._readVideo(this._video);
		this._control.on('data', () => { /* 端末からの知らせ（クリップボードなど）は使わない */ });
		this._control.once('close', () => this._stop(new Error('The scrcpy control socket closed')));
		this._control.on('error', error => this._logService.trace('[paradis-simulator] scrcpy control socket error', error));
	}

	/** 決まった 2 本（映像・操作の順）を受ける。それ以上は受けない。時間内に来なければ投げる。 */
	private _acceptTwo(listener: Server): Promise<[Socket, Socket]> {
		return new Promise((resolve, reject) => {
			const accepted: Socket[] = [];
			const timer = setTimeout(() => finish(new Error('The Android device did not connect to Para Code in time (scrcpy-server did not start)')), this._options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
			const onConnection = (socket: Socket) => {
				if (accepted.length >= 2) {
					socket.destroy();
					return;
				}
				socket.setNoDelay(true);
				accepted.push(socket);
				if (accepted.length === 2) {
					finish(undefined);
				}
			};
			const finish = (error: Error | undefined) => {
				clearTimeout(timer);
				listener.off('connection', onConnection);
				if (error) {
					accepted.forEach(socket => socket.destroy());
					reject(error);
				} else {
					resolve([accepted[0], accepted[1]]);
				}
			};
			listener.on('connection', onConnection);
		});
	}

	private _readVideo(video: Socket): void {
		const parser = new ParadisScrcpyVideoParser(true);
		let checked = false;
		video.on('data', (chunk: Buffer) => {
			let events: ParadisScrcpyVideoEvent[];
			try {
				events = parser.push(new Uint8Array(chunk));
			} catch (error) {
				this._stop(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const event of events) {
				if (event.kind === 'device') {
					this._deviceName = event.name;
					checked = true;
					continue;
				}
				if (!checked) {
					this._stop(new Error('The first scrcpy socket did not start with the device name'));
					return;
				}
				if (event.kind === 'session') {
					this._size = { width: event.width, height: event.height };
				} else if (event.kind === 'config') {
					this._config = event.data;
				}
				this._onVideo.fire(event);
			}
		});
		video.once('close', () => this._stop(new Error('The scrcpy video socket closed')));
		video.on('error', error => this._logService.trace('[paradis-simulator] scrcpy video socket error', error));
	}

	/** 操作のメッセージを送る（paradisScrcpy.ts で組み立てたもの）。 */
	send(message: Uint8Array): Promise<void> {
		const control = this._control;
		if (!control || this._ended) {
			return Promise.reject(new Error('The Android device is not connected'));
		}
		return new Promise((resolve, reject) => control.write(message, error => error ? reject(error) : resolve()));
	}

	/** 次の key frame を求める。 */
	resetVideo(): Promise<void> {
		return this.send(paradisScrcpyResetVideo());
	}

	private _stop(error: Error | undefined): void {
		if (this._ended) {
			return;
		}
		this._ended = true;
		this._video?.destroy();
		this._control?.destroy();
		if (this._server && this._server.exitCode === null) {
			this._server.kill();
		}
		if (error) {
			this._logService.info(`[paradis-simulator] scrcpy session ended: ${error.message}`);
		}
		this._onDidEnd.fire(error);
	}
}

async function createLoopbackServer(): Promise<Server> {
	const { createServer } = await import('net');
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	return server;
}
