/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createConnection, type Socket } from 'net';
import { WebSocket, type RawData } from 'ws';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';

const RETRY_INTERVAL_MS = 10_000;
const LOADED_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SETTINGS_CONFIRM_TIMEOUT_MS = 8_000;
const DAEMON_START_RETRY_MS = 60_000;
const DIRECT_APP_SERVER_START_TIMEOUT_MS = 10_000;
const CATALOG_CACHE_MS = 60_000;
const MAX_LIVE_TEXT_LENGTH = 6_000;
const MAX_RPC_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_PAGES = 10;
const MAX_MODELS = 128;

interface IJsonRpcMessage {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

interface IPendingRequest {
	readonly method: string;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ISettingsWaiter {
	readonly model: string;
	readonly effort: string;
	readonly resolve: (settings: IParadisCodexThreadSettings) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** app-server daemonから受けたthread単位の通知。 */
export interface IParadisCodexDaemonEvent {
	readonly threadId: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** model/listが広告するreasoning effort 1件。 */
export interface IParadisCodexReasoningEffort {
	readonly value: string;
	readonly description: string;
}

/** model/listから上限つきで正規化したCodexモデル候補。 */
export interface IParadisCodexModelOption {
	readonly id: string;
	/** thread/settings/updateへ渡すモデル名。 */
	readonly model: string;
	readonly displayName: string;
	readonly description: string;
	readonly efforts: readonly IParadisCodexReasoningEffort[];
	readonly defaultEffort: string;
	readonly isDefault: boolean;
}

/** daemonが確認したthreadの次ターン用モデル設定。 */
export interface IParadisCodexThreadSettings {
	readonly model: string;
	readonly effort?: string;
}

/** モバイルへ安全なcode/messageとして返せるCodex制御エラー。 */
export class ParadisCodexControlError extends Error {
	constructor(readonly code: 'disabled' | 'unsupported' | 'unavailable' | 'not-loaded' | 'busy' | 'invalid-selection' | 'timeout' | 'rpc-error', message: string) {
		super(message);
		this.name = 'ParadisCodexControlError';
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown, maxLength: number = 500): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function rawDataToString(data: RawData): string {
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.from(data).toString('utf8');
}

function runManagedCodexDaemonStart(env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('codex', ['app-server', 'daemon', 'start'], { timeout: 10_000, windowsHide: true, env }, error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

function canConnectUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};
		const timeout = setTimeout(() => finish(false), 500);
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

function createUnixWebSocketConnection(socketPath: string): typeof createConnection {
	// @types/wsはnet.createConnection型を公開しているが、実行時のws/httpはNode Agentの
	// (error, socket) callbackを渡す。接続完了通知が無いとUnix socket handshakeが切断
	// されるため、実行時契約へ明示的に合わせる。
	return ((_options: unknown, callback: (error: Error | null, socket: Socket) => void): Socket => {
		const connection = createConnection(socketPath);
		connection.once('connect', () => callback(null, connection));
		return connection;
	}) as unknown as typeof createConnection;
}

/**
 * 公式インストーラ管理外のCodexでも、公開されているUnix socket transportを使って
 * 同じ共有app-serverを起動する。プロセスはCodex TUIからも利用されるためdetachし、
 * Para Code終了時には停止しない。
 */
function startDirectCodexAppServer(socketPath: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('codex', ['app-server', '--listen', 'unix://'], {
			detached: true,
			env,
			stdio: 'ignore',
			windowsHide: true,
		});
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			clearInterval(poll);
			child.removeListener('error', onError);
			child.removeListener('exit', onExit);
			if (error !== undefined) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null) => {
			void canConnectUnixSocket(socketPath).then(connected => finish(connected
				? undefined
				: new Error(`Codex app-server exited before its socket was ready (code ${code ?? 'unknown'})`)));
		};
		const poll = setInterval(() => {
			void canConnectUnixSocket(socketPath).then(connected => {
				if (connected) {
					finish();
				}
			});
		}, 100);
		const timeout = setTimeout(() => finish(new Error('Codex app-server did not create its socket in time')), DIRECT_APP_SERVER_START_TIMEOUT_MS);
		child.once('error', onError);
		child.once('exit', onExit);
		child.unref();
	});
}

async function ensureCodexDaemonStarted(socketPath: string, env: NodeJS.ProcessEnv): Promise<void> {
	try {
		await runManagedCodexDaemonStart(env);
		return;
	} catch (managedError) {
		// managed commandは既存daemonがあればインストール方式を問わず成功する。ここへ
		// 来た時点でsocketができていれば、別プロセスとの起動競合が解決済みなので再利用する。
		if (await canConnectUnixSocket(socketPath)) {
			return;
		}
		try {
			await startDirectCodexAppServer(socketPath, env);
		} catch (directError) {
			throw new Error(`Codex daemon start failed: ${String(managedError)}; direct app-server fallback failed: ${String(directError)}`);
		}
	}
}

/**
 * Codex app-server daemonの共有JSON-RPC接続。
 * - 明示設定時だけdaemonをensure-startし、停止はしない（実行中TUIが利用し得るため）
 * - thread/loaded/listでdaemon所有を確認できたthreadだけresume/購読する
 * - model/listをカタログの正本とし、thread/settings/updateを確認通知つきで適用する
 * - server requestには応答せず、承認処理をTUIクライアントから奪わない
 */
export class ParadisCodexLiveClient extends Disposable {
	private enabled = false;
	private socket: WebSocket | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private loadedPollTimer: ReturnType<typeof setTimeout> | undefined;
	private initialized = false;
	private connectionGeneration = 0;
	private nextRequestId = 1;
	private lastDaemonStartAttempt = 0;
	private daemonStartInFlight: Promise<void> | undefined;
	private daemonEnsured = false;
	private loadedRefreshInFlight = false;
	private readonly pendingRequests = new Map<number, IPendingRequest>();
	private readonly wantedThreads = new Set<string>();
	private readonly loadedThreads = new Set<string>();
	private readonly pendingThreads = new Set<string>();
	private readonly subscribedThreads = new Set<string>();
	private readonly threadSettings = new Map<string, IParadisCodexThreadSettings>();
	private readonly settingsWaiters = new Map<string, ISettingsWaiter>();
	private catalogCache: { readonly at: number; readonly models: readonly IParadisCodexModelOption[] } | undefined;

	constructor(
		private readonly onEvent: (event: IParadisCodexDaemonEvent) => void,
		private readonly logService: ILogService,
		/** GUI起動時もログインシェル由来のPATHでcodexを解決する。 */
		private readonly shellEnvResolver: () => Promise<NodeJS.ProcessEnv> = () => Promise.resolve({ ...process.env }),
	) {
		super();
	}

	/** 明示的な実験設定に合わせてdaemon連携を開始・停止する。 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			void this.ensureDaemonAndConnect();
		} else {
			this.daemonEnsured = false;
			this.stop();
		}
	}

	/** hookで確定できたCodex thread集合だけを購読候補として同期する。 */
	setThreads(threadIds: readonly string[]): void {
		const next = new Set(threadIds.filter(threadId => threadId.length > 0));
		for (const threadId of this.wantedThreads) {
			if (!next.has(threadId)) {
				this.wantedThreads.delete(threadId);
				this.pendingThreads.delete(threadId);
				this.threadSettings.delete(threadId);
				this.rejectSettingsWaiter(threadId, new ParadisCodexControlError('unavailable', 'Codexセッションが終了しました'));
				if (this.subscribedThreads.has(threadId)) {
					void this.unsubscribeThread(threadId);
				}
			}
		}
		for (const threadId of next) {
			this.wantedThreads.add(threadId);
		}
		if (this.wantedThreads.size === 0) {
			this.stop();
			if (this.enabled) {
				void this.ensureDaemonAndConnect();
			}
			return;
		}
		if (this.enabled) {
			void this.ensureDaemonAndConnect();
			void this.refreshLoadedThreads();
		}
	}

	/** 指定threadが同一daemonにロード済みかつ購読済みかを返す。 */
	isThreadReady(threadId: string): boolean {
		return this.enabled && this.initialized && this.loadedThreads.has(threadId) && this.subscribedThreads.has(threadId);
	}

	/** daemon上で稼働中のthreadに対して、現在の動的モデル一覧を返す。 */
	async listModels(threadId: string): Promise<readonly IParadisCodexModelOption[]> {
		await this.awaitThreadReady(threadId);
		if (this.catalogCache !== undefined && Date.now() - this.catalogCache.at < CATALOG_CACHE_MS) {
			return this.catalogCache.models;
		}

		const models: IParadisCodexModelOption[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
			const result = record(await this.request('model/list', cursor === undefined ? { includeHidden: false } : { includeHidden: false, cursor }));
			const data = result?.['data'];
			if (!Array.isArray(data)) {
				throw new ParadisCodexControlError('rpc-error', 'Codexのモデル一覧レスポンスが不正です');
			}
			for (const raw of data) {
				const parsed = this.parseModel(raw);
				if (parsed !== undefined && !models.some(model => model.id === parsed.id || model.model === parsed.model)) {
					models.push(parsed);
					if (models.length >= MAX_MODELS) {
						break;
					}
				}
			}
			cursor = stringValue(result?.['nextCursor']);
			if (cursor === undefined || models.length >= MAX_MODELS) {
				break;
			}
		}
		if (models.length === 0) {
			throw new ParadisCodexControlError('unavailable', '利用可能なCodexモデルがありません');
		}
		this.catalogCache = { at: Date.now(), models };
		return models;
	}

	/** モデルとEffortを原子的にキューへ入れ、実効設定の確認通知を待つ。 */
	async updateThreadSettings(threadId: string, model: string, effort: string): Promise<IParadisCodexThreadSettings> {
		await this.awaitThreadReady(threadId);
		if (this.settingsWaiters.has(threadId)) {
			throw new ParadisCodexControlError('busy', 'このCodexセッションでは設定変更を処理中です');
		}
		const catalog = await this.listModels(threadId);
		const selected = catalog.find(option => option.model === model);
		if (selected === undefined || !selected.efforts.some(option => option.value === effort)) {
			throw new ParadisCodexControlError('invalid-selection', '現在のCodexで利用できないモデルまたはEffortです');
		}
		const current = this.threadSettings.get(threadId);
		if (current?.model === model && current.effort === effort) {
			return current;
		}

		const confirmation = new Promise<IParadisCodexThreadSettings>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.settingsWaiters.delete(threadId);
				reject(new ParadisCodexControlError('timeout', 'Codexから設定変更の確認通知が届きませんでした'));
			}, SETTINGS_CONFIRM_TIMEOUT_MS);
			this.settingsWaiters.set(threadId, { model, effort, resolve, reject, timer });
		});
		try {
			await this.request('thread/settings/update', { threadId, model, effort });
			return await confirmation;
		} catch (error) {
			this.rejectSettingsWaiter(threadId, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	override dispose(): void {
		this.enabled = false;
		this.stop();
		super.dispose();
	}

	private async ensureDaemonAndConnect(): Promise<void> {
		if (!this.enabled || this.socket !== undefined || process.platform === 'win32') {
			return;
		}
		const socketPath = join(paradisCodexHome(), 'app-server-control', 'app-server-control.sock');
		if (!this.daemonEnsured) {
			const now = Date.now();
			if (this.daemonStartInFlight === undefined) {
				if (now - this.lastDaemonStartAttempt < DAEMON_START_RETRY_MS) {
					this.scheduleRetry();
					return;
				}
				this.lastDaemonStartAttempt = now;
				this.daemonStartInFlight = this.shellEnvResolver()
					.then(env => ensureCodexDaemonStarted(socketPath, env))
					.finally(() => this.daemonStartInFlight = undefined);
			}
			try {
				await this.daemonStartInFlight;
				this.daemonEnsured = true;
			} catch (error) {
				this.logService.trace('[paradisCodexLive] could not start app-server daemon', String(error));
				// 起動競合で別プロセスが先にreadyになった場合だけ再利用する。単なるstaleな
				// socketファイルをreadyと誤認すると、永遠に再起動できなくなる。
				this.daemonEnsured = await canConnectUnixSocket(socketPath);
				if (!this.daemonEnsured) {
					this.scheduleRetry();
					return;
				}
			}
		}
		if (!(await this.pathExists(socketPath)) || !this.enabled || this.socket !== undefined) {
			this.scheduleRetry();
			return;
		}
		// 設定を有効にした時点でdaemonだけは先に起動しておく。Codex TUIがdaemonを
		// 利用するには起動前からsocketが存在する必要がある一方、購読対象のthreadが
		// 無い段階でPara Code自身が常時WebSocketを保持する必要はない。
		if (this.wantedThreads.size === 0) {
			return;
		}
		try {
			const generation = ++this.connectionGeneration;
			const socket = new WebSocket('ws://localhost/rpc', {
				createConnection: createUnixWebSocketConnection(socketPath),
				handshakeTimeout: 3_000,
				maxPayload: MAX_RPC_PAYLOAD_BYTES,
				// tokio-tungsteniteのUnix socket acceptorはpermessage-deflateを交渉しない。
				perMessageDeflate: false,
			});
			this.socket = socket;
			socket.on('open', () => void this.initialize(generation));
			socket.on('message', data => this.handleMessage(data));
			socket.on('error', error => this.logService.trace('[paradisCodexLive] daemon socket error', String(error)));
			socket.on('close', () => {
				if (this.socket === socket) {
					this.daemonEnsured = false;
					this.resetConnection(new ParadisCodexControlError('unavailable', 'Codex app-serverとの接続が切れました'));
					this.scheduleRetry();
				}
			});
		} catch (error) {
			this.logService.trace('[paradisCodexLive] daemon connection failed', String(error));
			this.daemonEnsured = false;
			this.resetConnection(new Error(String(error)));
			this.scheduleRetry();
		}
	}

	private async initialize(generation: number): Promise<void> {
		try {
			await this.request('initialize', {
				clientInfo: { name: 'para-code-mobile', title: 'Para Code Mobile', version: '1' },
				capabilities: { experimentalApi: true, requestAttestation: false },
			}, true);
			if (generation !== this.connectionGeneration || this.socket?.readyState !== WebSocket.OPEN) {
				return;
			}
			this.initialized = true;
			this.sendNotification('initialized');
			await this.refreshLoadedThreads();
		} catch (error) {
			this.logService.warn(`[paradisCodexLive] initialize failed: ${error instanceof Error ? error.message : String(error)}`);
			this.socket?.close();
		}
	}

	private handleMessage(data: RawData): void {
		let message: IJsonRpcMessage;
		try {
			const parsed = JSON.parse(rawDataToString(data));
			if (record(parsed) === undefined) {
				return;
			}
			message = parsed as IJsonRpcMessage;
		} catch {
			return;
		}
		if (typeof message.method === 'string' && message.id !== undefined) {
			// 双方向JSON-RPCのserver request。承認や時刻要求は操作中のTUIクライアントが
			// 処理する。監視・設定クライアントは先に応答して所有権を奪わない。
			return;
		}
		if (typeof message.id === 'number') {
			this.handleResponse(message.id, message.result, message.error);
			return;
		}
		if (typeof message.method !== 'string') {
			return;
		}
		const params = record(message.params);
		const threadId = stringValue(params?.['threadId']);
		if (threadId === undefined || params === undefined) {
			return;
		}
		if (message.method === 'thread/settings/updated') {
			this.handleSettingsUpdated(threadId, params);
		} else if (message.method === 'thread/closed') {
			this.loadedThreads.delete(threadId);
			this.subscribedThreads.delete(threadId);
			this.threadSettings.delete(threadId);
			this.scheduleLoadedPoll();
		}
		if (this.wantedThreads.has(threadId)) {
			this.onEvent({ threadId, method: message.method, params });
		}
	}

	private handleResponse(id: number, result: unknown, error: unknown): void {
		const pending = this.pendingRequests.get(id);
		if (pending === undefined) {
			return;
		}
		this.pendingRequests.delete(id);
		clearTimeout(pending.timer);
		if (error !== undefined && error !== null) {
			const rpcError = record(error);
			const detail = stringValue(rpcError?.['message']) ?? (typeof rpcError?.['code'] === 'number' ? String(rpcError['code']) : 'unknown error');
			pending.reject(new ParadisCodexControlError('rpc-error', `${pending.method}: ${detail}`));
		} else {
			pending.resolve(result);
		}
	}

	private async refreshLoadedThreads(): Promise<void> {
		if (!this.enabled || !this.initialized || this.loadedRefreshInFlight || this.socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		this.loadedRefreshInFlight = true;
		try {
			const result = record(await this.request('thread/loaded/list', {}));
			const data = result?.['data'];
			if (!Array.isArray(data)) {
				throw new Error('thread/loaded/list returned invalid data');
			}
			this.loadedThreads.clear();
			for (const value of data) {
				const threadId = stringValue(value);
				if (threadId !== undefined) {
					this.loadedThreads.add(threadId);
				}
			}
			for (const threadId of this.wantedThreads) {
				if (this.loadedThreads.has(threadId)) {
					void this.resumeLoadedThread(threadId);
				}
			}
		} catch (error) {
			this.logService.trace('[paradisCodexLive] thread/loaded/list failed', String(error));
		} finally {
			this.loadedRefreshInFlight = false;
			if ([...this.wantedThreads].some(threadId => !this.subscribedThreads.has(threadId))) {
				this.scheduleLoadedPoll();
			}
		}
	}

	private async resumeLoadedThread(threadId: string): Promise<void> {
		if (!this.wantedThreads.has(threadId) || !this.loadedThreads.has(threadId) || this.subscribedThreads.has(threadId) || this.pendingThreads.has(threadId)) {
			return;
		}
		this.pendingThreads.add(threadId);
		try {
			const result = record(await this.request('thread/resume', { threadId, excludeTurns: true }));
			if (!this.wantedThreads.has(threadId) || !this.loadedThreads.has(threadId)) {
				await this.unsubscribeThread(threadId);
				return;
			}
			this.subscribedThreads.add(threadId);
			const model = stringValue(result?.['model']);
			const effort = stringValue(result?.['reasoningEffort']);
			if (model !== undefined) {
				this.threadSettings.set(threadId, { model, ...(effort !== undefined ? { effort } : {}) });
			}
		} catch (error) {
			this.logService.trace(`[paradisCodexLive] thread/resume failed for ${threadId}`, String(error));
		} finally {
			this.pendingThreads.delete(threadId);
		}
	}

	private async unsubscribeThread(threadId: string): Promise<void> {
		if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) {
			this.subscribedThreads.delete(threadId);
			return;
		}
		try {
			await this.request('thread/unsubscribe', { threadId });
		} catch {
			// 接続終了時にも同じ掃除を行うため、unsubscribe失敗はベストエフォート。
		} finally {
			this.subscribedThreads.delete(threadId);
			if (this.wantedThreads.has(threadId)) {
				this.scheduleLoadedPoll();
			}
		}
	}

	private handleSettingsUpdated(threadId: string, params: Record<string, unknown>): void {
		const settings = record(params['threadSettings']);
		const model = stringValue(settings?.['model']);
		const effort = stringValue(settings?.['effort']);
		if (model === undefined) {
			return;
		}
		const effective = { model, ...(effort !== undefined ? { effort } : {}) };
		this.threadSettings.set(threadId, effective);
		const waiter = this.settingsWaiters.get(threadId);
		if (waiter !== undefined && waiter.model === model && waiter.effort === effort) {
			this.settingsWaiters.delete(threadId);
			clearTimeout(waiter.timer);
			waiter.resolve(effective);
		}
	}

	private parseModel(value: unknown): IParadisCodexModelOption | undefined {
		const raw = record(value);
		const id = stringValue(raw?.['id']);
		const model = stringValue(raw?.['model']);
		const displayName = stringValue(raw?.['displayName'], 200);
		const description = typeof raw?.['description'] === 'string' ? raw['description'].slice(0, 1_000) : '';
		const defaultEffort = stringValue(raw?.['defaultReasoningEffort'], 100);
		const rawEfforts = raw?.['supportedReasoningEfforts'];
		if (id === undefined || model === undefined || displayName === undefined || defaultEffort === undefined || !Array.isArray(rawEfforts)) {
			return undefined;
		}
		const efforts: IParadisCodexReasoningEffort[] = [];
		for (const value of rawEfforts.slice(0, 16)) {
			const effort = record(value);
			const effortValue = stringValue(effort?.['reasoningEffort'], 100);
			if (effortValue !== undefined && !efforts.some(option => option.value === effortValue)) {
				efforts.push({
					value: effortValue,
					description: typeof effort?.['description'] === 'string' ? effort['description'].slice(0, 500) : '',
				});
			}
		}
		return efforts.length > 0 ? {
			id, model, displayName, description, efforts, defaultEffort, isDefault: raw?.['isDefault'] === true,
		} : undefined;
	}

	private async awaitThreadReady(threadId: string): Promise<void> {
		if (!this.enabled) {
			throw new ParadisCodexControlError('disabled', 'Codex app-server連携が無効です');
		}
		if (process.platform === 'win32') {
			throw new ParadisCodexControlError('unsupported', 'Codex app-server連携は現在macOS/Linuxのみ対応しています');
		}
		if (!this.wantedThreads.has(threadId)) {
			throw new ParadisCodexControlError('not-loaded', 'このCodexセッションを確認できません');
		}
		void this.ensureDaemonAndConnect();
		void this.refreshLoadedThreads();
		const deadline = Date.now() + REQUEST_TIMEOUT_MS;
		while (!this.isThreadReady(threadId) && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		if (!this.isThreadReady(threadId)) {
			throw new ParadisCodexControlError('not-loaded', 'このセッションはCodex daemon上で動作していません。連携を有効にしてCodexを起動し直してください');
		}
	}

	private request(method: string, params?: Record<string, unknown>, allowBeforeInitialized: boolean = false): Promise<unknown> {
		if (this.socket?.readyState !== WebSocket.OPEN || (!allowBeforeInitialized && !this.initialized)) {
			return Promise.reject(new ParadisCodexControlError('unavailable', 'Codex app-serverへ接続していません'));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new ParadisCodexControlError('timeout', `${method}がタイムアウトしました`));
			}, REQUEST_TIMEOUT_MS);
			this.pendingRequests.set(id, { method, resolve, reject, timer });
			this.socket?.send(JSON.stringify({ method, id, ...(params !== undefined ? { params } : {}) }));
		});
	}

	private sendNotification(method: string): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ method }));
		}
	}

	private rejectSettingsWaiter(threadId: string, error: Error): void {
		const waiter = this.settingsWaiters.get(threadId);
		if (waiter !== undefined) {
			this.settingsWaiters.delete(threadId);
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	private scheduleLoadedPoll(): void {
		if (!this.enabled || this.loadedPollTimer !== undefined) {
			return;
		}
		this.loadedPollTimer = setTimeout(() => {
			this.loadedPollTimer = undefined;
			void this.refreshLoadedThreads();
		}, LOADED_POLL_INTERVAL_MS);
	}

	private scheduleRetry(): void {
		if (!this.enabled || this.retryTimer !== undefined || process.platform === 'win32') {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.ensureDaemonAndConnect();
		}, RETRY_INTERVAL_MS);
	}

	private resetConnection(error: Error): void {
		this.connectionGeneration++;
		this.socket = undefined;
		this.initialized = false;
		this.loadedRefreshInFlight = false;
		this.catalogCache = undefined;
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
		for (const threadId of [...this.settingsWaiters.keys()]) {
			this.rejectSettingsWaiter(threadId, error);
		}
		this.loadedThreads.clear();
		this.pendingThreads.clear();
		this.subscribedThreads.clear();
		this.threadSettings.clear();
	}

	private stop(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.loadedPollTimer !== undefined) {
			clearTimeout(this.loadedPollTimer);
			this.loadedPollTimer = undefined;
		}
		const socket = this.socket;
		this.resetConnection(new ParadisCodexControlError('disabled', 'Codex app-server連携が停止しました'));
		if (socket !== undefined) {
			socket.removeAllListeners();
			try {
				socket.close();
			} catch {
				socket.terminate();
			}
		}
	}

	private async pathExists(path: string): Promise<boolean> {
		return pathExists(path);
	}
}

/** daemon deltaの内部バッファ上限を共有する。 */
export function truncateCodexLiveText(text: string): string {
	return text.length > MAX_LIVE_TEXT_LENGTH ? `…${text.slice(-(MAX_LIVE_TEXT_LENGTH - 1))}` : text;
}
