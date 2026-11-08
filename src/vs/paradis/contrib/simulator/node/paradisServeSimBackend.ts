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

import { execFile } from 'child_process';
import type { IncomingMessage } from 'http';
import type * as WsTypes from 'ws';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, paradisIsSimulatorUdid, ParadisSimulatorFold } from '../common/paradisSimulator.js';
import { paradisDeviceHubActive, paradisParseSimctlDevices, paradisParseSimulatorHostMessage, paradisParseSimulatorScreenConfig, paradisSimulatorFoldFrame, ParadisMjpegSplitter } from '../common/paradisSimulatorFrames.js';
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

const FOLD_ACK_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 15_000;
const BOOT_TIMEOUT_MS = 180_000;

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

	constructor(
		private readonly _host: IParadisSimulatorHostProvider,
		private readonly _logService: ILogService,
		private readonly _simctl: ParadisSimctlRunner = realSimctl,
	) {
		super();
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

	/** Device Hub が入力を奪っているか。 */
	async deviceHubActive(udid: string): Promise<boolean> {
		requireUdid(udid);
		return paradisDeviceHubActive(await this._simctl(['spawn', udid, 'notifyutil', '-g', 'com.apple.coredevice.dtuhidd.active'], 10_000));
	}

	// --- ホスト（HTTP） ---

	private async _get(path: string): Promise<IncomingMessage> {
		const connection = await this._host.ensure();
		const { request } = await import('http');
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: connection.socketPath, path, method: 'GET', headers: { Authorization: `Bearer ${connection.token}` } }, resolve);
			req.once('error', reject);
			req.end();
		});
	}

	/** 映している画面の大きさと向き。 */
	async getScreenConfig(udid: string): Promise<IParadisSimulatorScreenConfig> {
		const res = await this._get(`/helper/${requireUdid(udid)}/config`);
		const chunks: Buffer[] = [];
		for await (const chunk of res) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks).toString('utf8');
		if (res.statusCode !== 200) {
			throw new Error(`The simulator host answered ${res.statusCode} for the screen config: ${body.slice(0, 200)}`);
		}
		const config = paradisParseSimulatorScreenConfig(JSON.parse(body));
		if (!config) {
			throw new Error('The simulator host returned an unexpected screen config');
		}
		return config;
	}

	/**
	 * 映像を購読する。届いた JPEG を 1 枚ずつ `onFrame` へ渡す。止めるには返り値を dispose する。
	 * 流れが切れたら `onEnd` を呼ぶ（呼び出し側が購読し直すか決める）。
	 */
	subscribeFrames(udid: string, onFrame: (jpeg: Uint8Array) => void, onEnd: (error?: Error) => void): IDisposable {
		requireUdid(udid);
		let disposed = false;
		let response: IncomingMessage | undefined;
		const end = (error?: Error) => {
			if (!disposed) {
				disposed = true;
				onEnd(error);
			}
		};
		this._get(`/helper/${udid}/stream.mjpeg`).then(res => {
			response = res;
			if (disposed) {
				res.destroy();
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				end(new Error(`The simulator host answered ${res.statusCode} for the video stream`));
				return;
			}
			const splitter = new ParadisMjpegSplitter();
			res.on('data', (chunk: Buffer) => {
				if (disposed) {
					return;
				}
				for (const jpeg of splitter.push(chunk)) {
					onFrame(jpeg);
				}
			});
			res.once('end', () => end());
			res.once('error', error => end(error));
		}, error => end(error));
		return toDisposable(() => {
			disposed = true;
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
		const connection = await this._host.ensure();
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
