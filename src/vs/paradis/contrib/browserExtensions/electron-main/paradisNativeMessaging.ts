/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-native-host-process.ts, src/main/browser/extensions/browser-extension-native-host-write-admission.ts, src/main/browser/extensions/browser-extension-native-ports.ts, src/main/browser/extensions/api/native-messaging.ts

// chrome.runtime.connectNative・sendNativeMessage の main 側（P6）。ホストは外のプログラムなので:
//  - 起動する前に、ホストの manifest の allowed_origins に呼び出し元の拡張機能があるかを確かめる（paradisNativeMessagingHosts.ts）
//  - シェルを通さず、実行ファイルを直接起動する（引数は Chrome と同じく拡張機能の origin だけ。Windows は親のウィンドウも）。
//    Windows は Chrome と同じく cmd.exe を通す（.bat・.cmd のホストがあるため）ので、パスに " と % と改行を含むものは起動しない
//  - 環境変数から Electron・Node の起動の指定と、Para Code の中だけの値を外す
//  - 標準入力を閉じたら 2 秒待ち、終わらなければ終わらせる（Chrome の EnsureProcessTerminated）。プロセスのまとまりごと終わらせる
//  - ポートは開いた文脈（worker か、そのページ）のもの。その文脈だけが使え、文脈が終わる・拡張機能を外すとホストを終わらせる。
//    ポートが開いている間は worker を生かしておく（Chrome と同じ）
//  - ホストから拡張機能へは 1 MB まで。拡張機能からホストへは、私用スキームの本文の上限（2 MiB）まで。書き込み待ちには上限を付ける
//
// ホストは main のプロセスから起動する（設計書 7 章。1Password のデスクトップアプリが、接続してきたブラウザのコード署名を確かめる
// 場合に通るかは Mac で確かめる）。

import { spawn, type ChildProcess } from 'child_process';
// electron は名前空間で読む（app は main のプロセスにしか無く、名前で読むと renderer で動くテストの読み込みが止まる）
import * as electron from 'electron';
import { randomUUID } from 'crypto';
import { posix, win32 } from '../../../../base/common/path.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { IParadisNativeHostLookup, PARADIS_NATIVE_HOST_ERRORS, paradisCreateNativeMessageReader, paradisEncodeNativeMessage, paradisResolveNativeHost } from './paradisNativeMessagingHosts.js';

/** main だけが使う名前空間（詰め物の connectNative・sendNativeMessage が呼ぶ。chrome には出さない）。 */
export const PARADIS_NATIVE_MESSAGING_NAMESPACE = 'paradisNativeMessaging';
/** ポートのイベント（[ポートの id, 'message' | 'disconnect', JSON の文字か、切れた理由]）。 */
export const PARADIS_NATIVE_PORT_EVENT = 'onPortEvent';

/** 標準入力を閉じてから終わらせるまでの猶予（Chrome と同じ）。 */
const CLOSE_GRACE_MS = 2_000;
/** 1 つのホストへの書き込み待ちの上限（これを超えたら、止まっているホストとして切る）。 */
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
/** 1 つの文脈が同時に開けるポートの数。 */
const MAX_PORTS_PER_CONTEXT = 32;
const STDERR_LOG_BUDGET_BYTES = 4 * 1024;

/** 起動するホスト（テストでは偽物の spawn を渡す）。 */
export type ParadisNativeHostSpawner = (program: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly detached: boolean; readonly windowsVerbatimArguments?: boolean }) => ChildProcess;

/** ホストに渡す環境変数（Electron・Node の起動の指定と、Para Code の中だけの値を外す）。 */
export function paradisNativeHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		const upper = key.toUpperCase();
		if (upper.startsWith('ELECTRON_') || upper === 'NODE_OPTIONS' || upper.startsWith('VSCODE_') || upper.startsWith('PARA_CODE_') || upper === 'CHROME_CRASHPAD_PIPE_NAME') {
			continue;
		}
		result[key] = value;
	}
	return result;
}

/**
 * 起動の仕方（プログラム・引数）。posix はホストを直接起動する。Windows は Chrome と同じく `cmd.exe /d /s /c` を通す
 * （.bat・.cmd のホストのため）。cmd.exe は " と % を特別に扱うので、それらと改行を含むパスは起動しない。
 */
export function paradisNativeHostCommand(platform: NodeJS.Platform, program: string, args: readonly string[], comspec: string | undefined): { readonly file: string; readonly args: readonly string[]; readonly verbatim: boolean } | undefined {
	if (platform !== 'win32') {
		return { file: program, args, verbatim: false };
	}
	const unsafe = /["%\r\n\0]/;
	if (unsafe.test(program) || args.some(arg => unsafe.test(arg) || /\s/.test(arg))) {
		return undefined;
	}
	return { file: comspec && win32.isAbsolute(comspec) ? comspec : 'cmd.exe', args: ['/d', '/s', '/c', `""${program}" ${args.join(' ')}"`], verbatim: true };
}

/** 動いているホスト 1 つ。 */
interface IHostConnection {
	send(json: string): void;
	close(): void;
}

/** ホストを起動する。動き出したら答え、起動できなければ Chrome の文で断る。 */
function startHost(name: string, program: string, args: readonly string[], spawner: ParadisNativeHostSpawner, platform: NodeJS.Platform, logService: { warn(message: string, ...args: unknown[]): void }, handlers: { onMessage(json: string): void; onClose(error: string): void }, live: Set<ChildProcess>): Promise<IHostConnection> {
	return new Promise((resolve, reject) => {
		const command = paradisNativeHostCommand(platform, program, args, process.env.ComSpec);
		if (!command) {
			logService.warn(`[paradis] refused to start native host ${name}: its path has characters cmd.exe would interpret`);
			reject(new ParadisExtensionApiError(PARADIS_NATIVE_HOST_ERRORS.failedToStart));
			return;
		}
		const path = platform === 'win32' ? win32 : posix;
		let child: ChildProcess;
		try {
			child = spawner(command.file, command.args, { cwd: path.dirname(program), env: paradisNativeHostEnvironment(process.env), detached: platform !== 'win32', ...(command.verbatim ? { windowsVerbatimArguments: true } : {}) });
		} catch (error) {
			logService.warn(`[paradis] could not start native host ${name}`, error);
			reject(new ParadisExtensionApiError(PARADIS_NATIVE_HOST_ERRORS.failedToStart));
			return;
		}
		let ready = false;
		let closed = false;
		let exited = false;
		let pendingWriteBytes = 0;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			clearTimeout(killTimer);
			live.delete(child);
			if (exited) {
				return;
			}
			try {
				if (platform === 'win32') {
					// プロセスのまとまりごと（cmd.exe とその子のホスト）
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
				} else if (child.pid !== undefined) {
					process.kill(-child.pid, 'SIGKILL');
				}
			} catch {
				try {
					child.kill('SIGKILL');
				} catch {
					// 既に終わっている
				}
			}
		};
		const release = () => {
			try {
				child.stdin?.end();
			} catch {
				// 閉じている
			}
			child.stdout?.destroy();
			if (exited) {
				live.delete(child);
				return;
			}
			killTimer = setTimeout(kill, CLOSE_GRACE_MS);
			(killTimer as { unref?(): void }).unref?.();
		};
		const closeChannel = (error: string) => {
			if (closed) {
				return;
			}
			closed = true;
			release();
			if (ready) {
				handlers.onClose(error);
			} else {
				reject(new ParadisExtensionApiError(PARADIS_NATIVE_HOST_ERRORS.failedToStart));
			}
		};
		const reader = paradisCreateNativeMessageReader(json => {
			if (!closed) {
				handlers.onMessage(json);
			}
		}, reason => {
			logService.warn(`[paradis] native host ${name} sent a bad ${reason}`);
			closeChannel(PARADIS_NATIVE_HOST_ERRORS.io);
		});
		const connection: IHostConnection = {
			send: json => {
				if (closed) {
					return;
				}
				const frame = paradisEncodeNativeMessage(json);
				if (pendingWriteBytes + frame.length > MAX_PENDING_WRITE_BYTES) {
					// 読まないホスト: 書き込み待ちを溜め続けない
					closeChannel(PARADIS_NATIVE_HOST_ERRORS.io);
					return;
				}
				pendingWriteBytes += frame.length;
				try {
					child.stdin?.write(frame, error => {
						pendingWriteBytes -= frame.length;
						if (error) {
							closeChannel(PARADIS_NATIVE_HOST_ERRORS.io);
						}
					});
				} catch {
					closeChannel(PARADIS_NATIVE_HOST_ERRORS.io);
				}
			},
			close: () => {
				if (!closed) {
					closed = true;
					release();
				}
			},
		};
		child.once('spawn', () => {
			live.add(child);
			ready = true;
			resolve(connection);
		});
		child.once('error', error => {
			if (!ready) {
				logService.warn(`[paradis] could not start native host ${name}`, error);
			}
			closeChannel(ready ? PARADIS_NATIVE_HOST_ERRORS.io : PARADIS_NATIVE_HOST_ERRORS.failedToStart);
		});
		child.once('exit', () => {
			exited = true;
			clearTimeout(killTimer);
			live.delete(child);
		});
		child.stdout?.on('data', (chunk: Buffer) => {
			if (!closed) {
				reader.push(chunk);
			}
		});
		// exit ではなく標準出力の終わりで閉じる（終わる直前に書いた返事を読み終えるまで待つ）
		child.stdout?.on('end', () => closeChannel(PARADIS_NATIVE_HOST_ERRORS.exited));
		child.stdout?.on('error', () => closeChannel(PARADIS_NATIVE_HOST_ERRORS.io));
		child.stdin?.on('error', () => closeChannel(PARADIS_NATIVE_HOST_ERRORS.io));
		let budget = STDERR_LOG_BUDGET_BYTES;
		child.stderr?.on('data', (chunk: Buffer) => {
			if (budget > 0) {
				budget -= chunk.length;
				logService.warn(`[paradis] native host ${name}: ${chunk.toString('utf8', 0, Math.min(chunk.length, STDERR_LOG_BUDGET_BYTES)).trimEnd()}`);
			}
		});
		child.stderr?.on('error', () => { });
	});
}

/** 開いているポート 1 つ。 */
interface INativePort {
	readonly key: string;
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly connection: string;
	host: IHostConnection | undefined;
	closed: boolean;
	task: { end(): void } | undefined;
	readonly onEvent: (kind: 'message' | 'disconnect', data: string) => void;
}

export class ParadisNativeMessaging implements IDisposable {

	private readonly _ports = new Map<string, INativePort>();
	private readonly _live = new Set<ChildProcess>();
	private readonly _disposable: IDisposable;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _lookup: () => IParadisNativeHostLookup,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		private readonly _spawner: ParadisNativeHostSpawner = (program, args, options) => spawn(program, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }),
		private readonly _platform: NodeJS.Platform = process.platform,
	) {
		// 文脈が終わった（ページが閉じた・worker が止まった・拡張機能を外した）: そのポートのホストを終わらせる
		this._disposable = _host.onDidCloseContext((session, extensionId, connection) => this._closeWhere(port => port.session === session && port.extensionId === extensionId && (connection === undefined || port.connection === connection)));
		this._registerNamespace();
		// Para Code を終えるとき、動いているホストを残さない（猶予の時計は終わった後には動かない）
		electron.app?.once?.('will-quit', () => this.dispose());
	}

	/** 終わるとき: 動いているホストをすべて今すぐ終わらせる。 */
	dispose(): void {
		this._disposable.dispose();
		this._closeWhere(() => true);
		for (const child of [...this._live]) {
			try {
				if (this._platform !== 'win32' && child.pid !== undefined) {
					process.kill(-child.pid, 'SIGKILL');
				} else {
					child.kill('SIGKILL');
				}
			} catch {
				// 既に終わっている
			}
		}
		this._live.clear();
	}

	private _closeWhere(matches: (port: INativePort) => boolean): void {
		for (const port of [...this._ports.values()]) {
			if (matches(port)) {
				this._finish(port);
			}
		}
	}

	private _finish(port: INativePort): void {
		if (port.closed) {
			return;
		}
		port.closed = true;
		this._ports.delete(port.key);
		// ホストを先に閉じる（worker の作業の終わりの知らせが失敗しても、ホストを残さない）
		port.host?.close();
		port.task?.end();
	}

	private _key(caller: IParadisExtensionApiCaller, portId: string): string {
		return `${caller.extension.id}|${caller.connection}|${portId}`;
	}

	/** ホストを起動してポートを開く。動き出したら答え、起動できなければ Chrome の文で断る。 */
	private async _open(caller: IParadisExtensionApiCaller, portId: string, application: unknown, onEvent: INativePort['onEvent']): Promise<INativePort> {
		const key = this._key(caller, portId);
		if (this._find(caller, portId)) {
			throw new ParadisExtensionApiError('This port is already open');
		}
		if ([...this._ports.values()].filter(port => port.session === caller.session && port.extensionId === caller.extension.id && port.connection === caller.connection).length >= MAX_PORTS_PER_CONTEXT) {
			throw new ParadisExtensionApiError('Too many native messaging ports');
		}
		const port: INativePort = { key: `${key}|${randomUUID()}`, session: caller.session, extensionId: caller.extension.id, connection: caller.connection, host: undefined, closed: false, task: caller.fromWorker ? this._host.keepWorkerAlive(caller.session, caller.extension.id) : undefined, onEvent };
		this._ports.set(port.key, port);
		try {
			const resolved = await paradisResolveNativeHost(application, caller.extension.id, this._lookup(), message => this._logService.warn(`[paradis] ${message}`));
			if (!resolved.ok) {
				throw new ParadisExtensionApiError(resolved.error);
			}
			// 探している間に文脈が終わった: 起動しない
			if (port.closed) {
				throw new ParadisExtensionApiError('The port owner went away');
			}
			// 引数は Chrome と同じ: 呼び出し元の拡張機能の origin（Windows は親のウィンドウの番号も。Para Code は 0）
			const args = [`chrome-extension://${caller.extension.id}/`, ...(this._platform === 'win32' ? ['--parent-window=0'] : [])];
			const host = await startHost(application as string, resolved.program, args, this._spawner, this._platform, this._logService, {
				onMessage: json => {
					if (!port.closed) {
						onEvent('message', json);
					}
				},
				onClose: error => {
					if (!port.closed) {
						this._finish(port);
						onEvent('disconnect', error);
					}
				},
			}, this._live);
			port.host = host;
			if (port.closed) {
				host.close();
			}
			return port;
		} catch (error) {
			this._finish(port);
			throw error instanceof ParadisExtensionApiError ? error : new ParadisExtensionApiError(error instanceof Error ? error.message : String(error));
		}
	}

	private _find(caller: IParadisExtensionApiCaller, portId: string): INativePort | undefined {
		const key = this._key(caller, portId);
		return [...this._ports.values()].find(port => port.key.startsWith(`${key}|`) && port.session === caller.session);
	}

	private _registerNamespace(): void {
		// 台帳の鍵は `|` でつなぐので、id に `|` を許さない（ほかのポートの鍵の頭に当たらないように）
		const portId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && !value.includes('|');
		const jsonText = (value: unknown): value is string => {
			if (typeof value !== 'string') {
				return false;
			}
			try {
				JSON.parse(value);
				return true;
			} catch {
				return false;
			}
		};
		this._host.registerNamespace(PARADIS_NATIVE_MESSAGING_NAMESPACE, {
			permission: 'nativeMessaging',
			methods: {
				connect: paradisDefineExtensionMethod(args => args.length === 2 && portId(args[0]) ? [args[0], args[1]] as [string, unknown] : undefined, async (caller, id, application) => {
					await this._open(caller, id, application, (kind, data) => this._host.emitToConnection(caller.session, caller.extension.id, caller.connection, PARADIS_NATIVE_MESSAGING_NAMESPACE, PARADIS_NATIVE_PORT_EVENT, [id, kind, data]));
				}),
				postMessage: paradisDefineExtensionMethod(args => args.length === 2 && portId(args[0]) && jsonText(args[1]) ? [args[0], args[1]] as [string, string] : undefined, (caller, id, json) => {
					this._find(caller, id)?.host?.send(json);
				}),
				disconnect: paradisDefineExtensionMethod(args => args.length === 1 && portId(args[0]) ? [args[0]] as [string] : undefined, (caller, id) => {
					const port = this._find(caller, id);
					if (port) {
						this._finish(port);
					}
				}),
				// 1 回送って 1 回の返事を待つ。返事が来たらホストを閉じる（Chrome の猶予の後に終わらせる）
				sendNativeMessage: paradisDefineExtensionMethod(args => args.length === 2 && jsonText(args[1]) ? [args[0], args[1]] as [unknown, string] : undefined, async (caller, application, json) => {
					let settle: (kind: 'message' | 'disconnect', data: string) => void = () => { };
					const reply = new Promise<string>((resolve, reject) => {
						settle = (kind, data) => kind === 'message' ? resolve(data) : reject(new ParadisExtensionApiError(data));
					});
					reply.catch(() => { });
					const port = await this._open(caller, `one-shot:${randomUUID()}`, application, (kind, data) => settle(kind, data));
					port.host?.send(json);
					try {
						return await reply;
					} finally {
						this._finish(port);
					}
				}),
			},
			events: [PARADIS_NATIVE_PORT_EVENT],
		});
	}

	/** テスト用: 開いているポートの数。 */
	get openPortCount(): number {
		return this._ports.size;
	}
}

