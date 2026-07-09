/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { createConnection } from 'net';
import { WebSocket, type RawData } from 'ws';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';

const RETRY_INTERVAL_MS = 10_000;
const MAX_LIVE_TEXT_LENGTH = 6_000;

interface IJsonRpcMessage {
	readonly id?: number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: number; readonly message?: string };
}

type PendingRequest =
	| { readonly kind: 'initialize' }
	| { readonly kind: 'resume'; readonly threadId: string }
	| { readonly kind: 'unsubscribe'; readonly threadId: string };

export interface IParadisCodexDaemonEvent {
	readonly threadId: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

/**
 * 稼働中のCodex app-server daemonへ、明示的に有効化された場合だけ読み取り購読する。
 * daemonの起動・停止は行わず、既定Unix socketが既に存在するときだけ接続する。
 * 通知はライブ表示にのみ使い、transcriptを真実の源とする既存経路は変更しない。
 */
export class ParadisCodexLiveClient extends Disposable {
	private enabled = false;
	private socket: WebSocket | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private initialized = false;
	private nextRequestId = 1;
	private readonly pendingRequests = new Map<number, PendingRequest>();
	private readonly wantedThreads = new Set<string>();
	private readonly pendingThreads = new Set<string>();
	private readonly subscribedThreads = new Set<string>();

	constructor(
		private readonly onEvent: (event: IParadisCodexDaemonEvent) => void,
		private readonly logService: ILogService,
	) {
		super();
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			void this.connectIfAvailable();
		} else {
			this.stop();
		}
	}

	setThreads(threadIds: readonly string[]): void {
		const next = new Set(threadIds.filter(threadId => threadId.length > 0));
		for (const threadId of this.wantedThreads) {
			if (!next.has(threadId)) {
				this.wantedThreads.delete(threadId);
				this.pendingThreads.delete(threadId);
				if (this.subscribedThreads.has(threadId)) {
					this.unsubscribeThread(threadId);
				}
			}
		}
		for (const threadId of next) {
			this.wantedThreads.add(threadId);
		}
		if (this.wantedThreads.size === 0) {
			this.stop();
			return;
		}
		if (this.enabled) {
			void this.connectIfAvailable();
			this.resumeWantedThreads();
		}
	}

	override dispose(): void {
		this.enabled = false;
		this.stop();
		super.dispose();
	}

	private async connectIfAvailable(): Promise<void> {
		if (!this.enabled || this.wantedThreads.size === 0 || this.socket !== undefined || process.platform === 'win32') {
			return;
		}
		const socketPath = join(paradisCodexHome(), 'app-server-control', 'app-server-control.sock');
		try {
			await fs.access(socketPath);
		} catch {
			this.scheduleRetry();
			return;
		}
		try {
			const socket = new WebSocket('ws://localhost/rpc', {
				createConnection: () => createConnection(socketPath),
			});
			this.socket = socket;
			socket.on('open', () => this.initialize());
			socket.on('message', data => this.handleMessage(data));
			socket.on('error', error => this.logService.trace('[paradisCodexLive] daemon socket error', String(error)));
			socket.on('close', () => {
				if (this.socket === socket) {
					this.resetConnection();
					this.scheduleRetry();
				}
			});
		} catch (error) {
			this.logService.trace('[paradisCodexLive] daemon connection failed', String(error));
			this.resetConnection();
			this.scheduleRetry();
		}
	}

	private initialize(): void {
		const id = this.nextRequestId++;
		this.pendingRequests.set(id, { kind: 'initialize' });
		this.send({
			method: 'initialize', id,
			params: {
				clientInfo: { name: 'para-code-mobile', title: 'Para Code Mobile', version: '1' },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		});
	}

	private handleMessage(data: RawData): void {
		let message: IJsonRpcMessage;
		try {
			message = JSON.parse(rawDataToString(data)) as IJsonRpcMessage;
		} catch {
			return;
		}
		if (typeof message.method === 'string' && message.id !== undefined) {
			// app-serverからのrequestは意図的に応答しない。承認要求は同じthreadを操作している
			// TUIクライアントが処理し、監視クライアントが先に拒否してはならない。
			// 双方向JSON-RPCではserver/clientのIDが衝突し得るため、methodをresponseより先に見る。
			return;
		}
		if (typeof message.id === 'number') {
			this.handleResponse(message.id, message.error);
			return;
		}
		if (typeof message.method !== 'string') {
			return;
		}
		const params = record(message.params);
		const threadId = typeof params?.['threadId'] === 'string' ? params['threadId'] : undefined;
		if (threadId !== undefined && this.wantedThreads.has(threadId) && params !== undefined) {
			this.onEvent({ threadId, method: message.method, params });
		}
	}

	private handleResponse(id: number, error: IJsonRpcMessage['error']): void {
		const pending = this.pendingRequests.get(id);
		if (pending === undefined) {
			return;
		}
		this.pendingRequests.delete(id);
		if (pending.kind === 'initialize') {
			if (error !== undefined) {
				this.logService.warn(`[paradisCodexLive] initialize failed: ${error.message ?? error.code ?? 'unknown error'}`);
				this.socket?.close();
				return;
			}
			this.initialized = true;
			this.send({ method: 'initialized' });
			this.resumeWantedThreads();
			return;
		}
		if (pending.kind === 'unsubscribe') {
			this.subscribedThreads.delete(pending.threadId);
			// pane同期の一時的な揺れで、unsubscribe応答前に同じthreadが再度必要になることがある。
			// 応答後の実状態を基準に再評価しないと、次の再接続まで通知が途切れる。
			this.resumeWantedThreads();
			return;
		}
		this.pendingThreads.delete(pending.threadId);
		if (error === undefined) {
			this.subscribedThreads.add(pending.threadId);
			if (!this.wantedThreads.has(pending.threadId)) {
				this.unsubscribeThread(pending.threadId);
			}
		} else {
			this.logService.trace(`[paradisCodexLive] thread/resume failed for ${pending.threadId}`, error.message ?? String(error.code));
		}
	}

	private unsubscribeThread(threadId: string): void {
		if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) {
			this.subscribedThreads.delete(threadId);
			return;
		}
		const id = this.nextRequestId++;
		this.pendingRequests.set(id, { kind: 'unsubscribe', threadId });
		this.send({ method: 'thread/unsubscribe', id, params: { threadId } });
	}

	private resumeWantedThreads(): void {
		if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		for (const threadId of this.wantedThreads) {
			if (this.subscribedThreads.has(threadId) || this.pendingThreads.has(threadId)) {
				continue;
			}
			const id = this.nextRequestId++;
			this.pendingThreads.add(threadId);
			this.pendingRequests.set(id, { kind: 'resume', threadId });
			// 設定・権限・cwdのoverrideは渡さない。excludeTurnsは履歴再送を避ける表示専用指定。
			this.send({ method: 'thread/resume', id, params: { threadId, excludeTurns: true } });
		}
	}

	private send(message: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	private scheduleRetry(): void {
		if (!this.enabled || this.retryTimer !== undefined || process.platform === 'win32') {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.connectIfAvailable();
		}, RETRY_INTERVAL_MS);
	}

	private resetConnection(): void {
		this.socket = undefined;
		this.initialized = false;
		this.pendingRequests.clear();
		this.pendingThreads.clear();
		this.subscribedThreads.clear();
	}

	private stop(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		const socket = this.socket;
		this.resetConnection();
		if (socket !== undefined) {
			socket.removeAllListeners();
			try {
				socket.close();
			} catch {
				socket.terminate();
			}
		}
	}
}

/** daemon deltaの内部バッファ上限を共有する。 */
export function truncateCodexLiveText(text: string): string {
	return text.length > MAX_LIVE_TEXT_LENGTH ? `…${text.slice(-(MAX_LIVE_TEXT_LENGTH - 1))}` : text;
}
