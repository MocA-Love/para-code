/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口の HTTP の受け口（shared process）。
//
//  - 127.0.0.1 のポート 0（OS が選ぶ）だけで待つ
//  - 立ち上げたら `<userData>/paradis-taskboard-bridge.json` に `{ version, port, token, pid }` を 0600 で書き、
//    止めるときに消す（中身が自分のものなら）。ボードサーバーはこれを読んでつなぐ
//  - すべての要求で `Authorization: Bearer <token>`（乱数 32 バイト）と Host（127.0.0.1 / localhost と自分のポート）を
//    確かめる。違えば 401 / 403。CORS のヘッダーは出さない（ブラウザのページからは読めない）
//  - 加えて、すべての要求でボードの鍵（`x-para-board-key`）と接続元の pid を確かめる（paradisTaskBoardBoardAuth.ts）。
//    発見ファイルの Bearer だけでは通さない。違えば 403
//  - `/v1/relay` は SSH の中継（paradisTaskBoardRelayRouter.ts）
//  - 本文は JSON で 1MB まで
//
// 中身（振り分け・台帳・イベント）は ParadisTaskBoardBridgeService が持つ。

import { randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs, readFileSync, unlinkSync } from 'fs';
import type * as http from 'http';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import {
	PARADIS_TASK_BOARD_BRIDGE_VERSION,
	PARADIS_TASK_BOARD_MAX_BODY_BYTES,
	PARADIS_TASK_BOARD_PING_INTERVAL_MS,
	paradisTaskBoardBearerToken,
	paradisTaskBoardIsAllowedHost,
} from '../common/paradisTaskBoardBridge.js';
import { PARADIS_TASK_BOARD_BOARD_KEY_HEADER } from '../common/paradisTaskBoardRelay.js';
import { ParadisTaskBoardBoardAuth } from './paradisTaskBoardBoardAuth.js';
import { IParadisTaskBoardHttpResponse, ParadisTaskBoardBridgeService } from './paradisTaskBoardBridgeService.js';
import { ParadisTaskBoardRelayRouter } from './paradisTaskBoardRelayRouter.js';

class BodyTooLargeError extends Error { }

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function sameToken(expected: Buffer, actual: string | undefined): boolean {
	if (actual === undefined) {
		return false;
	}
	const given = Buffer.from(actual);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export class ParadisTaskBoardBridgeServer extends Disposable {

	private server: http.Server | undefined;
	private starting: Promise<void> | undefined;
	private token: string | undefined;
	private port: number | undefined;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private readonly openResponses = new Set<http.ServerResponse>();
	private readonly onProcessExit = () => this.removeDiscoveryFileSync();
	/** 同じ理由で断り続けるとき（起動直後のつなぎ直しなど）に、ログを 1 回だけ出すため。 */
	private lastDeniedReason: string | undefined;

	constructor(
		private readonly service: ParadisTaskBoardBridgeService,
		private readonly discoveryPath: string,
		private readonly logService: ILogService,
		private readonly auth: ParadisTaskBoardBoardAuth,
		private readonly relay: ParadisTaskBoardRelayRouter,
	) {
		super();
	}

	/** 立ち上げる（既に動いていれば何もしない）。 */
	start(): Promise<void> {
		if (this.server || this.starting) {
			return this.starting ?? Promise.resolve();
		}
		const starting = this.doStart().catch(err => {
			this.logService.error('[ParadisTaskBoardBridge] could not start the bridge', err);
			this.closeServer();
		}).finally(() => {
			if (this.starting === starting) {
				this.starting = undefined;
			}
		});
		this.starting = starting;
		return starting;
	}

	/** 止める（接続をすべて切り、発見用のファイルを消す）。 */
	async stop(): Promise<void> {
		await this.starting;
		this.closeServer();
		await this.removeDiscoveryFile();
	}

	private async doStart(): Promise<void> {
		const { createServer } = await import('http');
		const token = randomBytes(32).toString('base64url');
		const server = createServer((request, response) => {
			this.onRequest(request, response).catch(err => {
				this.logService.warn('[ParadisTaskBoardBridge] request failed', String(err));
				this.respond(response, { status: 500, body: { error: 'failed' } });
			});
		});
		const port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ host: '127.0.0.1', port: 0 }, () => {
				server.off('error', reject);
				const address = server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('Could not determine the task board bridge port'));
					return;
				}
				resolve(address.port);
			});
		});
		server.on('error', err => this.logService.warn('[ParadisTaskBoardBridge] server error', String(err)));
		if (this._store.isDisposed) {
			server.close();
			return;
		}
		this.server = server;
		this.token = token;
		this.port = port;
		this.pingTimer = setInterval(() => this.service.ping(), PARADIS_TASK_BOARD_PING_INTERVAL_MS);
		await paradisWriteFileAtomic(this.discoveryPath, JSON.stringify({ version: PARADIS_TASK_BOARD_BRIDGE_VERSION, port, token, pid: process.pid }), { newFileMode: 0o600, forceMode: 0o600, fallbackToInPlace: false });
		process.once('exit', this.onProcessExit);
		this.logService.info(`[ParadisTaskBoardBridge] listening on 127.0.0.1:${port}`);
	}

	private closeServer(): void {
		if (this.pingTimer !== undefined) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
		for (const response of this.openResponses) {
			response.end();
		}
		this.openResponses.clear();
		this.server?.close();
		this.server?.closeAllConnections();
		this.server = undefined;
		this.port = undefined;
	}

	/** 発見用のファイルが自分の書いたもの（同じ token）か。 */
	private ownsDiscoveryFile(raw: string): boolean {
		try {
			const parsed: unknown = JSON.parse(raw);
			return this.token !== undefined && typeof parsed === 'object' && parsed !== null && (parsed as { token?: unknown }).token === this.token;
		} catch {
			return false;
		}
	}

	private async removeDiscoveryFile(): Promise<void> {
		process.off('exit', this.onProcessExit);
		try {
			if (this.ownsDiscoveryFile(await fs.readFile(this.discoveryPath, 'utf8'))) {
				await fs.unlink(this.discoveryPath);
			}
		} catch {
			// 無ければよい
		}
		this.token = undefined;
	}

	private removeDiscoveryFileSync(): void {
		try {
			// eslint-disable-next-line local/code-no-sync-fs -- This cleanup runs from the process exit/disposal path; Node exit handlers cannot await I/O, so the discovery file must be checked before returning.
			if (this.ownsDiscoveryFile(readFileSync(this.discoveryPath, 'utf8'))) {
				// eslint-disable-next-line local/code-no-sync-fs -- This cleanup runs from the process exit/disposal path; Node exit handlers cannot await I/O, so the discovery file must be removed before returning.
				unlinkSync(this.discoveryPath);
			}
		} catch {
			// 無ければよい
		}
	}

	private respond(response: http.ServerResponse, result: IParadisTaskBoardHttpResponse): void {
		if (response.headersSent) {
			response.end();
			return;
		}
		const body = JSON.stringify(result.body);
		response.writeHead(result.status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		response.end(body);
	}

	private async onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const port = this.port;
		const token = this.token;
		if (port === undefined || token === undefined) {
			return this.respond(response, { status: 503, body: { error: 'unavailable' } });
		}
		// DNS のリバインドで外のページから叩かれるのを防ぐ
		if (!paradisTaskBoardIsAllowedHost(firstHeader(request.headers.host), port)) {
			return this.respond(response, { status: 403, body: { error: 'forbidden' } });
		}
		if (!sameToken(Buffer.from(token), paradisTaskBoardBearerToken(firstHeader(request.headers.authorization)))) {
			return this.respond(response, { status: 401, body: { error: 'unauthorized' } });
		}
		const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
		const method = request.method ?? 'GET';
		// 鍵と接続元は、本文を読む前に確かめる（確かめられない相手の本文は受け取らない）
		const verdict = await this.verifyBoard(request, port, url.pathname);
		if (!verdict.ok) {
			request.resume();
			return this.respond(response, { status: 403, body: { error: 'unverified-caller' } });
		}
		if (url.pathname === '/v1/events') {
			if (method !== 'GET') {
				return this.respond(response, { status: 405, body: { error: 'method-not-allowed' } });
			}
			return this.openEvents(request, response);
		}
		let body: unknown;
		if (method === 'POST') {
			try {
				body = await this.readJson(request);
			} catch (err) {
				return this.respond(response, err instanceof BodyTooLargeError
					? { status: 413, body: { error: 'invalid', message: 'The body is larger than 1MB.' } }
					: { status: 400, body: { error: 'invalid', message: 'The body must be JSON.' } });
			}
		}
		if (url.pathname === '/v1/relay') {
			return this.respond(response, method === 'POST' ? await this.relay.handle(body, verdict.keyHash) : { status: 405, body: { error: 'method-not-allowed' } });
		}
		this.respond(response, await this.service.handle(method, url.pathname, url.searchParams, body, verdict.keyHash, verdict.remote));
	}

	/** ボードの鍵と接続元の pid を確かめる。中継の依頼を断ったときは監査ログに残す。 */
	private async verifyBoard(request: http.IncomingMessage, port: number, pathname: string): Promise<{ readonly ok: true; readonly keyHash: string; readonly remote: boolean } | { readonly ok: false }> {
		const verdict = await this.auth.verify(firstHeader(request.headers[PARADIS_TASK_BOARD_BOARD_KEY_HEADER]), request.socket, port);
		if (verdict.ok) {
			return verdict;
		}
		if (pathname === '/v1/relay') {
			this.relay.denied(verdict.reason);
		}
		if (this.lastDeniedReason !== verdict.reason) {
			this.lastDeniedReason = verdict.reason;
			this.logService.info(`[ParadisTaskBoardBridge] refused a request that does not come from the task board Para Code started: ${verdict.reason}`);
		}
		return { ok: false };
	}

	private readJson(request: http.IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let failed = false;
			request.on('data', (chunk: Buffer) => {
				if (failed) {
					return;
				}
				size += chunk.length;
				if (size > PARADIS_TASK_BOARD_MAX_BODY_BYTES) {
					failed = true;
					reject(new BodyTooLargeError());
					request.resume();
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => {
				if (failed) {
					return;
				}
				try {
					const text = Buffer.concat(chunks).toString('utf8');
					resolve(text.trim().length === 0 ? {} : JSON.parse(text));
				} catch (err) {
					reject(err);
				}
			});
			request.on('error', reject);
		});
	}

	private openEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		// 応答の頭をすぐ送る（node は最初の write まで頭を送らないので、ターミナルが無いと最初の ping まで相手が待たされる）
		response.write(': connected\n\n');
		const client = this.service.addEventClient(chunk => {
			if (!response.writableEnded) {
				response.write(chunk);
			}
		});
		if (!client) {
			response.end(': too many event clients\n\n');
			return;
		}
		this.openResponses.add(response);
		const cleanup = () => {
			client.dispose();
			this.openResponses.delete(response);
		};
		request.on('close', cleanup);
		response.on('close', cleanup);
	}

	override dispose(): void {
		this.closeServer();
		this.removeDiscoveryFileSync();
		process.off('exit', this.onProcessExit);
		super.dispose();
	}
}
