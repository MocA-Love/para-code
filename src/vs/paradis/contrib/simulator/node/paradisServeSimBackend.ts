/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// iOS のシミュレータの backend（shared process）。端末の一覧と起動は simctl、映像と入力はホストの
// Unix ソケット越しに serve-sim と話す。すべての要求に `Authorization: Bearer <token>` を付ける。
//
// 映像は `stream.mjpeg` を読み、JPEG の 1 枚ずつに切って渡す。入力は端末ごとに 1 本の WebSocket
// （`/helper/<udid>/ws`）を開いたままにして送る。ホストが起こし直されたら（token とソケットが変わる）
// 次の要求で開き直す。
//
// serve-sim は端末ごとのセッション（ネイティブの取り込みと HID）をホストの中に持ち続け、端末が止まっても
// 閉じない（閉じる処理は、許可のルートの外の画面と grid の API からしか呼ばれない）。端末が起動し直されると、
// 残ったセッションは前の起動の画面を見たままで、映像の要求は頭だけ返して 1 枚も送らず、入力も届かない
// （paracode-194。「端末の取り込みが始まりません」が出て、Para Code を開き直すまで直らなかった）。
// そこで、端末ごとに「セッションを開いたときの起動の識別」（CoreSimulator が起動と停止のたびに 1 回ずつ書き直す
// `device.plist` の更新時刻）を覚え、要求の前に見比べて、変わっていればホストを起こし直す。見比べをすり抜けた分は、頭の後に最初の 1 枚が来ないことで気づき、
// 起こし直して 1 回だけ頼み直す。起こし直しで切れたほかの端末の映像は、黙って頼み直す。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import type { IncomingMessage } from 'http';
import { homedir } from 'os';
import type * as WsTypes from 'ws';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, PARADIS_SIMULATOR_CAPTURE_START_TIMEOUT_MS, PARADIS_SIMULATOR_FIRST_FRAME_TIMEOUT_MS, paradisIsSimulatorUdid, ParadisSimulatorFold } from '../common/paradisSimulator.js';
import { paradisDeviceHubActive, paradisParseSimctlDevices, paradisParseSimulatorHostMessage, paradisParseSimulatorKeyboardFallback, paradisParseSimulatorScreenConfig, paradisSimulatorFoldFrame, ParadisMjpegSplitter } from '../common/paradisSimulatorFrames.js';
import { IParadisSimulatorHostConnection, IParadisSimulatorHostProvider } from './paradisSimulatorHostProcess.js';

/** `xcrun` を呼ぶ口（テストで差し替える）。 */
export type ParadisSimctlRunner = (args: readonly string[], timeoutMs: number) => Promise<string>;

const realSimctl: ParadisSimctlRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
	execFile('xcrun', ['simctl', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
		if (error) {
			reject(new Error(`xcrun simctl ${args[0]} failed: ${String(stderr).trim() || error.message}`));
		} else {
			resolve(String(stdout));
		}
	});
});

/**
 * 端末の起動の識別を読む口（テストで差し替える）。端末が起動するたび・止まるたびに変わる値を返す。
 * 読めなければ undefined（見比べを飛ばす。そのときは「最初の 1 枚が来ない」で気づく）。
 */
export type ParadisSimulatorBootIdReader = (udid: string) => Promise<string | undefined>;

/**
 * CoreSimulator は端末の様子を `<端末の置き場>/<udid>/device.plist` に持ち、起動と停止のたびに 1 回ずつ書き直す
 * （動いている間は書かない。Xcode 27.2 で確かめた）。その更新時刻を識別にする。`simctl list devices -j` には
 * 起動のたびに変わる値が無く、プロセスの一覧（`ps`）は端末の起動直後に 10 秒以上返らないことがあった。
 */
const realBootId: ParadisSimulatorBootIdReader = async udid => {
	try {
		const stat = await fs.stat(join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid.toUpperCase(), 'device.plist'), { bigint: true });
		return String(stat.mtimeNs);
	} catch {
		return undefined;
	}
};

export interface IParadisServeSimBackendOptions {
	readonly readBootId?: ParadisSimulatorBootIdReader;
	/** 頭の後、最初の 1 枚を待つ時間。 */
	readonly firstFrameTimeoutMs?: number;
}

/** 起動の識別を読めないまま開いたセッションの印。 */
const UNKNOWN_BOOT_ID = '';
const FOLD_ACK_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 15_000;
const BOOT_TIMEOUT_MS = 180_000;

/**
 * 映像の要求に、ホストが {@link PARADIS_SIMULATOR_CAPTURE_START_TIMEOUT_MS} の間、応答の頭を返さなかった。
 * serve-sim は端末の取り込みを始めてから頭を返すので、取り込みが始まっていない。
 */
export class ParadisSimulatorCaptureNotStartedError extends Error {
	constructor(udid: string, waitedMs: number, stage: 'start' | 'frame' = 'start') {
		super(stage === 'start'
			? `The simulator host did not start capturing ${udid} within ${Math.ceil(waitedMs / 1000)} s`
			: `The simulator host started capturing ${udid} but sent no frame within ${Math.ceil(waitedMs / 1000)} s`);
		this.name = 'ParadisSimulatorCaptureNotStartedError';
	}
}

function requireUdid(udid: string): string {
	if (!paradisIsSimulatorUdid(udid)) {
		throw new Error(`Not a simulator UDID: ${udid}`);
	}
	return udid;
}

interface IInputSocket {
	readonly connection: IParadisSimulatorHostConnection;
	readonly socket: WsTypes.WebSocket;
	readonly opened: Promise<void>;
	config: IParadisSimulatorScreenConfig | undefined;
	readonly foldWaiters: ((ok: boolean) => void)[];
}

export class ParadisServeSimBackend extends Disposable {

	private readonly _inputs = new Map<string, IInputSocket>();
	/** いまのホストがセッションを開いた端末 → そのときの起動の識別。 */
	private readonly _sessions = new Map<string, string>();
	/** いまのホストが「キーを旧来の HID で送った」と出した端末（UDID の頭 8 桁、大文字）。 */
	private readonly _keyboardFallbacks = new Set<string>();
	private _sessionsOf: IParadisSimulatorHostConnection | undefined;
	/** 見比べと起こし直しを 1 つずつ進めるための列。 */
	private _gate: Promise<unknown> = Promise.resolve();
	/** ホストをわざと起こし直した回数。映像の流れは、これが変わっていれば「切れた」ではなく頼み直す。 */
	private _generation = 0;
	private readonly _readBootId: ParadisSimulatorBootIdReader;
	private readonly _firstFrameTimeoutMs: number;

	constructor(
		private readonly _host: IParadisSimulatorHostProvider,
		private readonly _logService: ILogService,
		private readonly _simctl: ParadisSimctlRunner = realSimctl,
		private readonly _captureStartTimeoutMs = PARADIS_SIMULATOR_CAPTURE_START_TIMEOUT_MS,
		options: IParadisServeSimBackendOptions = {},
	) {
		super();
		this._readBootId = options.readBootId ?? realBootId;
		this._firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? PARADIS_SIMULATOR_FIRST_FRAME_TIMEOUT_MS;
		this._register(toDisposable(() => {
			for (const input of this._inputs.values()) {
				input.socket.terminate();
			}
			this._inputs.clear();
		}));
	}

	// --- simctl ---

	async listDevices(): Promise<IParadisSimulatorDevice[]> {
		return paradisParseSimctlDevices(await this._simctl(['list', 'devices', '-j'], 30_000));
	}

	/** 起動していなければ起動し、起動しきるまで待つ。 */
	async boot(udid: string): Promise<void> {
		requireUdid(udid);
		// 起動済みなら simctl boot は失敗するので、結果は bootstatus で確かめる
		await this._simctl(['boot', udid], 60_000).catch(() => undefined);
		await this._simctl(['bootstatus', udid], BOOT_TIMEOUT_MS);
	}

	/** 止める。もう止まっていれば何もしない。 */
	async shutdown(udid: string): Promise<void> {
		requireUdid(udid);
		const devices = await this.listDevices();
		if (devices.find(device => device.udid === udid)?.state === 'Shutdown') {
			return;
		}
		await this._simctl(['shutdown', udid], 60_000);
	}

	/** ホストの stdout の 1 行を受ける（キーを旧来の HID で送った、の行を覚える）。 */
	noteHostOutput(line: string): void {
		const udid = paradisParseSimulatorKeyboardFallback(line);
		if (udid) {
			this._keyboardFallbacks.add(udid);
		}
	}

	/**
	 * この端末へのキーが、Device Hub の経路を使えず旧来の HID で送られたか（届いていないことがある）。
	 * ホストはセッションごとに 1 回しか出さないので、ホストを起こし直すまで true のまま。
	 */
	keyboardFallback(udid: string): boolean {
		return this._keyboardFallbacks.has(requireUdid(udid).slice(0, 8).toUpperCase());
	}

	/** Device Hub が入力を奪っているか。 */
	async deviceHubActive(udid: string): Promise<boolean> {
		requireUdid(udid);
		return paradisDeviceHubActive(await this._simctl(['spawn', udid, 'notifyutil', '-g', 'com.apple.coredevice.dtuhidd.active'], 10_000));
	}

	// --- ホスト（端末のセッションの鮮度） ---

	private _queue<T>(task: () => Promise<T>): Promise<T> {
		const run = this._gate.then(task);
		this._gate = run.catch(() => undefined);
		return run;
	}

	/** ホストを起こし直す（起こし直せるホストのときだけ）。 */
	private async _recycle(reason: string): Promise<void> {
		if (!this._host.recycle) {
			return;
		}
		this._generation++;
		this._sessions.clear();
		this._keyboardFallbacks.clear();
		this._sessionsOf = undefined;
		this._logService.warn(`[paradis-simulator] ${reason}; restarting the simulator host to drop its device sessions`);
		await this._host.recycle(reason);
	}

	/** `generation` の後にまだ誰も起こし直していなければ、起こし直す（同じ死んだセッションで 2 回起こし直さない）。 */
	private _recycleFrom(generation: number, reason: string): Promise<void> {
		return this._queue(async () => {
			if (this._generation === generation) {
				await this._recycle(reason);
			}
		});
	}

	/**
	 * その端末へ要求を送る前に呼ぶ。動いているホストを返す。ホストがその端末のセッションを開いた後に端末が
	 * 止まった・起動し直されたなら、先にホストを起こし直す（残ったセッションは映像も入力も通さない）。
	 */
	private _connect(udid: string): Promise<IParadisSimulatorHostConnection> {
		return this._queue(async () => {
			let connection = await this._host.ensure();
			if (connection !== this._sessionsOf) {
				// ホストが替わった（落ちて起き直した）: 前のホストのセッションはもう無い
				this._sessions.clear();
				this._keyboardFallbacks.clear();
				this._sessionsOf = connection;
			}
			const bootId = await this._readBootId(udid).catch(() => undefined);
			const opened = this._sessions.get(udid);
			if (bootId === undefined) {
				// 読めなかった間に開いたセッションは、どの起動のものか分からない。後で読めた識別を「開いたときのもの」と
				// みなさないよう、分からない印を付けておく
				if (opened === undefined) {
					this._sessions.set(udid, UNKNOWN_BOOT_ID);
				}
				return connection;
			}
			if (opened !== undefined && opened !== bootId && this._host.recycle) {
				await this._recycle(opened === UNKNOWN_BOOT_ID
					? `the host opened its session of ${udid} before Para Code could tell which boot it belongs to`
					: `${udid} was shut down or booted again after the host opened its session`);
				connection = await this._host.ensure();
				this._sessionsOf = connection;
			}
			this._sessions.set(udid, bootId);
			return connection;
		});
	}

	// --- ホスト（HTTP） ---

	private async _get(udid: string, path: string, signal?: AbortSignal): Promise<IncomingMessage> {
		return this._request(await this._connect(udid), path, signal);
	}

	private async _request(connection: IParadisSimulatorHostConnection, path: string, signal?: AbortSignal): Promise<IncomingMessage> {
		const { request } = await import('http');
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: connection.socketPath, path, method: 'GET', headers: { Authorization: `Bearer ${connection.token}` }, signal }, resolve);
			req.once('error', reject);
			req.end();
		});
	}

	private async _getJson(udid: string, path: string, what: string): Promise<unknown> {
		const res = await this._get(udid, path);
		const chunks: Buffer[] = [];
		for await (const chunk of res) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks).toString('utf8');
		if (res.statusCode !== 200) {
			const retry = res.statusCode === 503 ? ' It may still be starting; try again in a moment.' : '';
			throw new Error(`The simulator host answered ${res.statusCode} for the ${what}: ${body.slice(0, 200)}.${retry}`);
		}
		return JSON.parse(body);
	}

	/** アクセシビリティの木（serve-sim の `axDescribe` の生の形）。 */
	getAccessibilityTree(udid: string): Promise<unknown> {
		return this._getJson(udid, `/helper/${requireUdid(udid)}/ax`, 'accessibility tree');
	}

	/** 映している画面の大きさと向き。 */
	async getScreenConfig(udid: string): Promise<IParadisSimulatorScreenConfig> {
		const config = paradisParseSimulatorScreenConfig(await this._getJson(udid, `/helper/${requireUdid(udid)}/config`, 'screen config'));
		if (!config) {
			throw new Error('The simulator host returned an unexpected screen config');
		}
		return config;
	}

	/**
	 * 映像を購読する。届いた JPEG を 1 枚ずつ `onFrame` へ渡す。止めるには返り値を dispose する。
	 * 流れが切れたら `onEnd` を呼ぶ（呼び出し側が購読し直すか決める）。
	 *
	 * ホストが応答の頭を返すまでの時間に期限を置く（serve-sim は端末の取り込みを始めてから頭を返すので、取り込みが
	 * 戻ってこないと要求は黙ったまま残り、ペインは黒いまま理由も出なかった。paracode-183）。期限が切れたら要求を捨て、
	 * {@link ParadisSimulatorCaptureNotStartedError} で終える。段ごと（送った・頭が来た・最初の 1 枚・終わり）に
	 * ログを残し、再発したときにどこで止まったか分かるようにする。
	 *
	 * 頭が来た後、最初の 1 枚が {@link PARADIS_SIMULATOR_FIRST_FRAME_TIMEOUT_MS} の間に来なければ、ホストの握っている
	 * セッションが死んでいる。ホストを起こし直して 1 回だけ頼み直す。それでも来なければ同じ誤りで終える。
	 * どちらの終わり方でも、ホストは起こし直しておく（「再試行」が新しいホストから始まる）。
	 * 流れている途中でホストがわざと起こし直されたら（別の端末のセッションを捨てるため）、終わりにせず頼み直す。
	 */
	subscribeFrames(udid: string, onFrame: (jpeg: Uint8Array) => void, onEnd: (error?: Error) => void): IDisposable {
		requireUdid(udid);
		let disposed = false;
		let response: IncomingMessage | undefined;
		let abort = new AbortController();
		const started = Date.now();
		let frames = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let restartedForFrames = false;
		const end = (error?: Error) => {
			clearTimeout(timer);
			if (!disposed) {
				disposed = true;
				this._logService.info(`[paradis-simulator] video ${udid}: ended after ${Date.now() - started} ms, ${frames} frame(s)${error ? `: ${error.message}` : ''}`);
				onEnd(error);
			}
		};
		const giveUp = (error: ParadisSimulatorCaptureNotStartedError, generation: number) => {
			this._logService.warn(`[paradis-simulator] video ${udid}: ${error.message}`);
			end(error);
			abort.abort();
			response?.destroy();
			this._recycleFrom(generation, `no video from ${udid}`).catch(() => undefined);
		};
		this._logService.info(`[paradis-simulator] video ${udid}: requested`);
		const attempt = () => {
			abort = new AbortController();
			response = undefined;
			const signal = abort.signal;
			let generation = this._generation;
			// このやり方の応答を捨てた（頼み直した）。後から届く data・end・error を無視する
			let superseded = false;
			// 期限が来たとき、待っている間にホストが（別の端末のために）起こし直されていたら、期限切れにせず新しいホストへ
			// 頼み直す。頼み直しの 1 回も使わない（前のホストの止まるのが遅いと、切れる前に期限が来る）
			const askAgainAfterRestart = () => {
				if (this._generation === generation) {
					return false;
				}
				superseded = true;
				this._logService.info(`[paradis-simulator] video ${udid}: the host was restarted while waiting; asking again`);
				abort.abort();
				response?.destroy();
				attempt();
				return true;
			};
			// 期限はホストが準備できて要求を送った時点から数える（ホストの初回の起動は最長 20 秒かかり、それを
			// 「取り込みが始まらない」と取り違えないため）
			this._connect(udid).then(connection => {
				if (disposed) {
					return undefined;
				}
				generation = this._generation;
				this._logService.info(`[paradis-simulator] video ${udid}: host ready after ${Date.now() - started} ms, request sent`);
				timer = setTimeout(() => {
					if (askAgainAfterRestart()) {
						return;
					}
					giveUp(new ParadisSimulatorCaptureNotStartedError(udid, this._captureStartTimeoutMs), generation);
				}, this._captureStartTimeoutMs);
				return this._request(connection, `/helper/${udid}/stream.mjpeg`, signal);
			}).then(res => {
				if (!res) {
					return;
				}
				clearTimeout(timer);
				response = res;
				if (disposed) {
					res.destroy();
					return;
				}
				this._logService.info(`[paradis-simulator] video ${udid}: host answered ${res.statusCode} after ${Date.now() - started} ms`);
				if (res.statusCode !== 200) {
					res.resume();
					end(new Error(`The simulator host answered ${res.statusCode} for the video stream`));
					return;
				}
				let attemptFrames = 0;
				timer = setTimeout(() => {
					if (askAgainAfterRestart()) {
						return;
					}
					if (restartedForFrames || !this._host.recycle) {
						giveUp(new ParadisSimulatorCaptureNotStartedError(udid, this._firstFrameTimeoutMs, 'frame'), generation);
						return;
					}
					restartedForFrames = true;
					superseded = true;
					this._logService.warn(`[paradis-simulator] video ${udid}: the host answered but sent no frame within ${this._firstFrameTimeoutMs} ms`);
					abort.abort();
					res.destroy();
					this._recycleFrom(generation, `no frame from ${udid}`).then(() => {
						if (!disposed) {
							attempt();
						}
					}, error => end(error));
				}, this._firstFrameTimeoutMs);
				const splitter = new ParadisMjpegSplitter();
				res.on('data', (chunk: Buffer) => {
					if (disposed || superseded) {
						return;
					}
					for (const jpeg of splitter.push(chunk)) {
						if (attemptFrames++ === 0) {
							clearTimeout(timer);
						}
						if (frames++ === 0) {
							this._logService.info(`[paradis-simulator] video ${udid}: first frame after ${Date.now() - started} ms`);
						}
						onFrame(jpeg);
					}
				});
				const closed = (error?: Error) => {
					if (disposed || superseded) {
						return;
					}
					if (this._generation !== generation) {
						superseded = true;
						clearTimeout(timer);
						this._logService.info(`[paradis-simulator] video ${udid}: the host was restarted; asking again`);
						attempt();
						return;
					}
					end(error);
				};
				res.once('end', () => closed());
				res.once('error', error => closed(error));
			}, error => {
				if (disposed || superseded) {
					return;
				}
				if (this._generation !== generation) {
					// 頭を待つ間にホストが起こし直された
					clearTimeout(timer);
					attempt();
					return;
				}
				end(error);
			});
		};
		attempt();
		return toDisposable(() => {
			clearTimeout(timer);
			disposed = true;
			abort.abort();
			response?.destroy();
		});
	}

	/** 1 枚だけ取る。 */
	captureFrame(udid: string, timeoutMs = FRAME_TIMEOUT_MS): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			let subscription: IDisposable | undefined = undefined;
			let settled = false;
			const settle = (result: Uint8Array | Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				subscription?.dispose();
				if (result instanceof Error) {
					reject(result);
				} else {
					resolve(result);
				}
			};
			const timer = setTimeout(() => settle(new Error('No frame arrived from the simulator in time')), timeoutMs);
			subscription = this.subscribeFrames(udid, jpeg => settle(jpeg), error => settle(error ?? new Error('The video stream ended before a frame arrived')));
			if (settled) {
				subscription.dispose();
			}
		});
	}

	// --- ホスト（入力の WebSocket） ---

	private async _input(udid: string): Promise<IInputSocket> {
		requireUdid(udid);
		const connection = await this._connect(udid);
		const existing = this._inputs.get(udid);
		if (existing && existing.connection === connection && existing.socket.readyState <= 1) {
			await existing.opened;
			return existing;
		}
		existing?.socket.terminate();
		const { WebSocket } = await import('ws');
		const socket = new WebSocket(`ws+unix://${connection.socketPath}:/helper/${udid}/ws`, { headers: { Authorization: `Bearer ${connection.token}` } });
		const input: IInputSocket = {
			connection,
			socket,
			opened: new Promise<void>((resolve, reject) => {
				socket.once('open', () => resolve());
				socket.once('error', reject);
				socket.once('unexpected-response', (_req, res) => reject(new Error(`The simulator host refused the input socket (${res.statusCode})`)));
			}),
			config: undefined,
			foldWaiters: [],
		};
		input.opened.catch(() => undefined);
		socket.on('message', (data: Buffer) => {
			const message = paradisParseSimulatorHostMessage(new Uint8Array(data));
			if (message?.kind === 'config') {
				input.config = message.config;
			} else if (message?.kind === 'foldAck') {
				input.foldWaiters.shift()?.(message.ok);
			}
		});
		socket.on('error', error => this._logService.warn(`[paradis-simulator] input socket error: ${error.message}`));
		socket.on('close', () => {
			for (const waiter of input.foldWaiters.splice(0)) {
				waiter(false);
			}
			if (this._inputs.get(udid) === input) {
				this._inputs.delete(udid);
			}
		});
		this._inputs.set(udid, input);
		await input.opened;
		return input;
	}

	/** 入力のフレームを送る（`paradisSimulatorFrames.ts` で組み立てたもの）。 */
	async send(udid: string, frame: Uint8Array): Promise<void> {
		const input = await this._input(udid);
		await new Promise<void>((resolve, reject) => input.socket.send(frame, error => error ? reject(error) : resolve()));
	}

	/** 開閉し、serve-sim の受け取りの返事（最大 10 秒）を待つ。受け付けられなければ false。 */
	async fold(udid: string, fold: ParadisSimulatorFold): Promise<boolean> {
		const frame = paradisSimulatorFoldFrame(fold);
		const input = await this._input(udid);
		const ack = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => {
				const index = input.foldWaiters.indexOf(done);
				if (index >= 0) {
					input.foldWaiters.splice(index, 1);
				}
				resolve(false);
			}, FOLD_ACK_TIMEOUT_MS);
			const done = (ok: boolean) => {
				clearTimeout(timer);
				resolve(ok);
			};
			input.foldWaiters.push(done);
		});
		await new Promise<void>((resolve, reject) => input.socket.send(frame, error => error ? reject(error) : resolve()));
		return ack;
	}

	/** 入力の WebSocket で最後に届いた画面の大きさ（まだ無ければ undefined）。 */
	lastScreenConfig(udid: string): IParadisSimulatorScreenConfig | undefined {
		return this._inputs.get(udid)?.config;
	}
}
