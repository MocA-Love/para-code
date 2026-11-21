/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先の受け口の中継そのもの（取り決めは common/paradisAgentGateway.ts）。
//
// 1 つの要求を、今のポートファイルが指す戻りトンネルへ流す。決まりは 4 つ。
//
//  1. 流し先は要求のたびにポートファイルから読む。覚えるのは「このトークンは前にどの PC へ
//     届いたか」だけで、それも当て直せる（トークンそのものは持たず、ハッシュを鍵にする）
//  2. 戻りトンネルが無い・手元がまだそのペインを同期していない間は、断らずに待つ。上限を過ぎたら
//     503 と符丁を返す
//  3. 流し直すのは、手元へ 1 バイトも届いていないと言える要求だけ。sshd の `-R` の待ち受けは、
//     手元の ssh が無言で死んでいる間も接続を受けるので、「接続できた」だけでは決まらない。本体を
//     送る前に軽い生存確認（手元の health の GET）を挟み、通った後に本体を送る。本体を送り始めて
//     からの失敗は流し直さず 502 にする（道具の二重実行を避ける）
//  4. PC が 2 台あるときは、「そのトークンを知らない」（404）と答えた PC を飛ばして次を試す
//
// WebSocket（Upgrade）は通さない。要求の本文は流し直しのために一度メモリへ受けるので、流し続ける
// 本文（chunked の音声など）にも向かない。応答はそのまま流す（SSE を含む）。

import { createHash } from 'crypto';
import type * as http from 'http';
import { PARADIS_AGENT_GATEWAY_PROBE_PATH, PARADIS_AGENT_GATEWAY_REQUEST_HEADER, PARADIS_AGENT_GATEWAY_TIMEOUT_CODE, PARADIS_AGENT_GATEWAY_UNSYNCED_HEADER, PARADIS_AGENT_GATEWAY_WAIT_LIMIT_MS } from '../common/paradisAgentGateway.js';

/** 流し先の 1 つ（接続元の PC ごとのポートファイル）。 */
export interface IParadisAgentGatewaySource {
	/** PC の印（ポートファイルの名前）。共有のポートファイルは `shared`。 */
	readonly id: string;
	/** 戻りトンネルが接続先で待っている番号。 */
	readonly port: number;
}

export interface IParadisAgentGatewayRelayOptions {
	/** 今の流し先。新しく書かれたものから順に返す。 */
	readonly readSources: () => Promise<readonly IParadisAgentGatewaySource[]>;
	/** 待たせる上限。 */
	readonly waitLimitMs?: number;
	/** 待っている間、流し先を見直す間隔。 */
	readonly retryDelayMs?: number;
	/** 生存確認の時間切れ。 */
	readonly probeTimeoutMs?: number;
	/**
	 * 直前に応答のあった流し先へ、生存確認を省いてよい長さ。既定は 0（毎回確かめる）。省くと、手元の ssh が
	 * 無言で止まった直後の要求が死んだトンネルへ送られ、流し直せなくなる（本物の sshd で確かめた）。
	 */
	readonly probeFreshMs?: number;
	/**
	 * 初めて見るトークンで、生きている PC がすべて「知らない」と答えたとき、落ちている流し先を待つ長さ。
	 * 古いポートファイル（もう繋いでこない PC のもの）が残っていても、終わったペインの要求を上限まで
	 * 待たせないために短くする。
	 */
	readonly unknownTokenWaitMs?: number;
	/** 受ける本文の上限。 */
	readonly maxBodyBytes?: number;
	/** 流した後、手元から何も届かないまま待つ上限（道具の制限の 300 秒より長く）。 */
	readonly upstreamIdleTimeoutMs?: number;
}

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect', 'host', 'content-length']);

/** 手元が「そのトークンのペインは無い」と答えるときの本文（paradisAgentBrowserService の `_sendIngressRejected`）。 */
const NOT_THIS_WINDOW_MARKER = 'Para Browser endpoint unavailable';

/** 404・503 の本文を、中身を確かめるために受ける上限。 */
const MAX_INSPECTED_BODY_BYTES = 256 * 1024;

/** トークンと流し先の対応を覚える数。 */
const MAX_REMEMBERED_TOKENS = 512;

interface IBufferedResponse {
	readonly status: number;
	readonly headers: http.OutgoingHttpHeaders;
	readonly body: Buffer;
}

type ForwardOutcome =
	/** 応答を返し終えた（成功・失敗とも）。 */
	| { readonly kind: 'done' }
	/** 手元に届かなかった（接続拒否）。流し直してよい。 */
	| { readonly kind: 'refused' }
	/** この PC はそのトークンを知らない。 */
	| { readonly kind: 'not-mine'; readonly response: IBufferedResponse }
	/** この PC はまだそのペインを同期していないだけかもしれない。 */
	| { readonly kind: 'unsynced' };

function bearerToken(req: http.IncomingMessage): string | undefined {
	const auth = req.headers.authorization;
	return typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7 ? auth.slice(7).trim() || undefined : undefined;
}

function filterHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const result: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
			result[name] = value;
		}
	}
	return result;
}

function sendJson(res: http.ServerResponse, status: number, payload: object): void {
	if (res.writableEnded || res.destroyed) {
		return;
	}
	if (!res.headersSent) {
		res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	}
	res.end(JSON.stringify(payload));
}

export class ParadisAgentGatewayRelay {

	private readonly waitLimitMs: number;
	private readonly retryDelayMs: number;
	private readonly probeTimeoutMs: number;
	private readonly probeFreshMs: number;
	private readonly unknownTokenWaitMs: number;
	private readonly maxBodyBytes: number;
	private readonly upstreamIdleTimeoutMs: number;

	/**
	 * 手元へ話しかける口。手元の受け口は、接続元の確認の結果を接続ごとに覚えるので、接続を使い回して
	 * 道具のたびに確かめ直させない。`http` は使うときに読み込む（起動を遅くしない）。
	 */
	private transport: Promise<{ readonly request: typeof http.request; readonly agent: http.Agent }> | undefined;
	/** トークンのハッシュ → 前に届いた流し先の印。 */
	private readonly tokenSources = new Map<string, string>();
	/** 流し先の番号 → 最後に応答のあった時刻。 */
	private readonly lastAlive = new Map<number, number>();
	/** 待っている要求の、待ちを切り上げる口。 */
	private readonly waiters = new Set<() => void>();
	private disposed = false;

	constructor(private readonly options: IParadisAgentGatewayRelayOptions) {
		this.waitLimitMs = options.waitLimitMs ?? PARADIS_AGENT_GATEWAY_WAIT_LIMIT_MS;
		this.retryDelayMs = options.retryDelayMs ?? 500;
		this.probeTimeoutMs = options.probeTimeoutMs ?? 3000;
		this.probeFreshMs = options.probeFreshMs ?? 0;
		this.unknownTokenWaitMs = options.unknownTokenWaitMs ?? 15_000;
		this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
		this.upstreamIdleTimeoutMs = options.upstreamIdleTimeoutMs ?? 330_000;
	}

	dispose(): void {
		this.disposed = true;
		for (const wake of [...this.waiters]) {
			wake();
		}
		void this.transport?.then(transport => transport.agent.destroy());
	}

	private upstream(): Promise<{ readonly request: typeof http.request; readonly agent: http.Agent }> {
		this.transport ??= import('http').then(module => ({ request: module.request, agent: new module.Agent({ keepAlive: true, maxSockets: 64 }) }));
		return this.transport;
	}

	/** 1 つの要求を流す。必ず応答を返すか、相手が切れたら何もせず終える。 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const startedAt = Date.now();
		let clientGone = false;
		const onClientGone: Array<() => void> = [];
		res.on('close', () => {
			if (!res.writableEnded) {
				clientGone = true;
				for (const listener of onClientGone.splice(0)) {
					listener();
				}
			}
		});

		const body = await this.readBody(req);
		if (body === undefined) {
			if (!clientGone) {
				sendJson(res, 413, { error: 'Request body rejected.' });
			}
			return;
		}

		const token = bearerToken(req);
		const tokenKey = token === undefined ? undefined : createHash('sha256').update(token).digest('hex').slice(0, 32);
		const deadline = startedAt + this.waitLimitMs;

		while (!clientGone && !this.disposed) {
			let sources: readonly IParadisAgentGatewaySource[];
			try {
				sources = await this.options.readSources();
			} catch {
				sources = [];
			}
			const rememberedId = tokenKey === undefined ? undefined : this.tokenSources.get(tokenKey);
			const ordered = rememberedId === undefined ? sources : [...sources.filter(source => source.id === rememberedId), ...sources.filter(source => source.id !== rememberedId)];

			let sawUnsynced = false;
			let sawDown = sources.length === 0;
			let rememberedDown = false;
			let notMine: IBufferedResponse | undefined;
			for (const source of ordered) {
				if (clientGone || this.disposed) {
					return;
				}
				if (!await this.isAlive(source.port)) {
					sawDown = true;
					rememberedDown ||= source.id === rememberedId;
					continue;
				}
				if (clientGone || this.disposed) {
					return;
				}
				const outcome = await this.forward(source, req, body, res, onClientGone);
				if (outcome.kind === 'done') {
					if (tokenKey !== undefined) {
						this.remember(tokenKey, source.id);
					}
					return;
				}
				if (outcome.kind === 'refused') {
					this.lastAlive.delete(source.port);
					sawDown = true;
					rememberedDown ||= source.id === rememberedId;
				} else if (outcome.kind === 'unsynced') {
					sawUnsynced = true;
				} else {
					notMine = outcome.response;
					if (tokenKey !== undefined && source.id === rememberedId) {
						this.tokenSources.delete(tokenKey);
					}
				}
			}

			if (!sawUnsynced && !sawDown && notMine !== undefined) {
				// 生きている PC がすべて「知らない」と答えた。待っても変わらない
				this.sendBuffered(res, notMine);
				return;
			}
			// 待つ長さ。生きている PC が「知らない」と答え、覚えの無いトークンで、残りは落ちている流し先だけ
			// （古いポートファイルかもしれない）なら短く切り上げる
			const waitUntil = !sawUnsynced && !rememberedDown && notMine !== undefined
				? Math.min(deadline, startedAt + this.unknownTokenWaitMs)
				: deadline;
			if (Date.now() >= waitUntil) {
				if (notMine !== undefined) {
					this.sendBuffered(res, notMine);
				} else {
					sendJson(res, 503, {
						error: 'The Para Code window for this terminal is not connected right now. The request was held and then given up; nothing was run. Try again once the window has reconnected.',
						code: PARADIS_AGENT_GATEWAY_TIMEOUT_CODE,
					});
				}
				return;
			}
			await this.sleep(Math.min(this.retryDelayMs, Math.max(0, waitUntil - Date.now())), onClientGone);
		}
	}

	private remember(tokenKey: string, sourceId: string): void {
		this.tokenSources.delete(tokenKey);
		this.tokenSources.set(tokenKey, sourceId);
		if (this.tokenSources.size > MAX_REMEMBERED_TOKENS) {
			const oldest = this.tokenSources.keys().next().value;
			if (oldest !== undefined) {
				this.tokenSources.delete(oldest);
			}
		}
	}

	private sleep(ms: number, onClientGone: Array<() => void>): Promise<void> {
		return new Promise(resolve => {
			const wake = () => {
				clearTimeout(timer);
				this.waiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			this.waiters.add(wake);
			onClientGone.push(wake);
		});
	}

	private sendBuffered(res: http.ServerResponse, response: IBufferedResponse): void {
		if (res.writableEnded || res.destroyed) {
			return;
		}
		res.writeHead(response.status, { ...response.headers, 'content-length': response.body.length });
		res.end(response.body);
	}

	/** 本文を受ける。上限を超えた・相手が途中で切れたら undefined。 */
	private readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
		return new Promise(resolve => {
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const settle = (value: Buffer | undefined) => {
				if (!settled) {
					settled = true;
					resolve(value);
				}
			};
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > this.maxBodyBytes) {
					req.pause();
					settle(undefined);
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => settle(Buffer.concat(chunks)));
			req.on('error', () => settle(undefined));
			req.on('close', () => {
				if (!req.complete) {
					settle(undefined);
				}
			});
		});
	}

	/**
	 * 流し先が今応えるか。直前に応答があったなら確かめ直さない。
	 * 応答の中身は見ない（古い版の手元は health を知らず 405 を返すが、届いていることは分かる）。
	 */
	private async isAlive(port: number): Promise<boolean> {
		const last = this.lastAlive.get(port);
		if (last !== undefined && Date.now() - last < this.probeFreshMs) {
			return true;
		}
		const { request, agent } = await this.upstream();
		return new Promise(resolve => {
			let settled = false;
			const settle = (alive: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				if (alive) {
					this.lastAlive.set(port, Date.now());
				} else {
					this.lastAlive.delete(port);
				}
				resolve(alive);
			};
			const probe = request({
				host: '127.0.0.1', port, method: 'GET', path: PARADIS_AGENT_GATEWAY_PROBE_PATH, agent,
				headers: { [PARADIS_AGENT_GATEWAY_REQUEST_HEADER]: '1' },
			}, response => {
				response.resume();
				response.on('end', () => settle(true));
				response.on('error', () => settle(false));
				response.on('close', () => settle(response.complete));
			});
			probe.setTimeout(this.probeTimeoutMs, () => probe.destroy(new Error('probe timed out')));
			probe.on('error', () => settle(false));
			probe.end();
		});
	}

	private async forward(source: IParadisAgentGatewaySource, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, onClientGone: Array<() => void>): Promise<ForwardOutcome> {
		const { request, agent } = await this.upstream();
		return new Promise(resolve => {
			let settled = false;
			const settle = (outcome: ForwardOutcome) => {
				if (!settled) {
					settled = true;
					resolve(outcome);
				}
			};
			const headers = filterHeaders(req.headers);
			headers.host = `127.0.0.1:${source.port}`;
			headers[PARADIS_AGENT_GATEWAY_REQUEST_HEADER] = '1';
			if (body.length > 0 || (req.method !== 'GET' && req.method !== 'HEAD')) {
				headers['content-length'] = body.length;
			}
			const upstream = request({ host: '127.0.0.1', port: source.port, method: req.method, path: req.url, headers, agent });
			onClientGone.push(() => upstream.destroy());
			upstream.setTimeout(this.upstreamIdleTimeoutMs, () => upstream.destroy(new Error('upstream idle timeout')));
			upstream.on('error', (error: NodeJS.ErrnoException) => {
				if (settled) {
					return;
				}
				if (error.code === 'ECONNREFUSED') {
					settle({ kind: 'refused' });
					return;
				}
				// 本体を送り始めた後の失敗。手元が受け取って動かしたかもしれないので、流し直さない
				sendJson(res, 502, { error: 'The connection to the Para Code window was lost while the request was being handled. It may or may not have run; check before repeating it.' });
				settle({ kind: 'done' });
			});
			upstream.on('response', response => {
				this.lastAlive.set(source.port, Date.now());
				const status = response.statusCode ?? 502;
				const responseHeaders = filterHeaders(response.headers);
				if (response.headers['content-length'] !== undefined) {
					responseHeaders['content-length'] = response.headers['content-length'];
				}
				if (status !== 404 && status !== 503) {
					this.pipeResponse(status, responseHeaders, [], response, res, () => settle({ kind: 'done' }));
					return;
				}
				// 「知らないトークン」「同期前かも」を見分けるために、短い本文を受けてから決める
				const chunks: Buffer[] = [];
				let size = 0;
				let piping = false;
				response.on('data', (chunk: Buffer) => {
					if (piping) {
						return;
					}
					chunks.push(chunk);
					size += chunk.length;
					if (size > MAX_INSPECTED_BODY_BYTES) {
						// 見分ける対象の応答ではない。そのまま返す
						piping = true;
						this.pipeResponse(status, responseHeaders, chunks, response, res, () => settle({ kind: 'done' }));
					}
				});
				response.on('error', () => {
					if (!piping) {
						sendJson(res, 502, { error: 'The connection to the Para Code window was lost while the request was being handled.' });
						settle({ kind: 'done' });
					}
				});
				response.on('end', () => {
					if (piping) {
						return;
					}
					const buffered: IBufferedResponse = { status, headers: responseHeaders, body: Buffer.concat(chunks) };
					if (status === 503 && response.headers[PARADIS_AGENT_GATEWAY_UNSYNCED_HEADER] !== undefined) {
						settle({ kind: 'unsynced' });
					} else if (status === 404 && buffered.body.includes(NOT_THIS_WINDOW_MARKER)) {
						settle({ kind: 'not-mine', response: buffered });
					} else {
						this.sendBuffered(res, buffered);
						settle({ kind: 'done' });
					}
				});
			});
			upstream.end(body);
		});
	}

	private pipeResponse(status: number, headers: http.OutgoingHttpHeaders, head: readonly Buffer[], response: http.IncomingMessage, res: http.ServerResponse, done: () => void): void {
		if (res.writableEnded || res.destroyed) {
			response.destroy();
			done();
			return;
		}
		res.writeHead(status, headers);
		// SSE の最初の行をためない
		res.flushHeaders();
		for (const chunk of head) {
			res.write(chunk);
		}
		response.on('data', (chunk: Buffer) => {
			if (!res.write(chunk)) {
				response.pause();
				res.once('drain', () => response.resume());
			}
		});
		response.on('end', () => {
			res.end();
			done();
		});
		response.on('error', () => {
			// 応答の途中で手元が切れた。途中までの応答を「全部」に見せないよう、接続ごと切る
			res.destroy();
			done();
		});
		response.on('close', () => {
			if (!response.complete) {
				res.destroy();
			}
			done();
		});
	}
}
