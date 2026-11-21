/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先の受け口の「番号の持ち主」を決めるところ（取り決めは common/paradisAgentGateway.ts）。
//
// 受け口は接続先のサーバーの中で待つ。端末の常駐の側には置かない。常駐は版ごとに分かれていて
// （ソケットの名前に版を混ぜている）、抱える端末が無くなると自分で終わり、設定で切られている
// 接続先や Windows の接続先にはそもそも居ないので、「サーバーより長く番号を持ち続ける者」に
// ならないため。
//
// サーバーはアプリの更新のたびに入れ替わり、古いサーバーはしばらく居残る。番号を手放さない形は
// 次のとおり。
//
//  - 中継は状態を持たない（要求ごとにポートファイルを読む）。だから番号を持っているのがどの
//    サーバーでも、同じホームのサーバーなら全員の要求を同じように流せる
//  - 番号は接続先のホームから決め、取れた番号を `~/.para-code/gateway.json` に書く。次のサーバーは
//    その番号を先に試すので、候補が一度ずれても番号は続く
//  - 番号が同じホームの受け口に取られていたら、控えに回って番号を聞いて答え、持ち主が終わるのを
//    見張って取り直す（数秒の空白は、エージェントの側のつなぎ直しで埋まる）
//  - 持ち主の受け口の版が自分より古ければ、合い言葉（gateway.json。0600）を見せて譲り受ける。
//    持ち主は新しい接続を受けるのをやめ、流している途中の要求は最後まで流す
//  - 別のホームの受け口・関係の無いプログラムが取っている番号は使わず、次の候補へ進む

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { join } from '../../../../base/common/path.js';
import { IParadisAgentGatewayEndpoint, IParadisAgentGatewayFile, PARADIS_AGENT_GATEWAY_FILE_NAME, PARADIS_AGENT_GATEWAY_FILE_PROTOCOL_VERSION, PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER, PARADIS_AGENT_GATEWAY_HANDOVER_PATH, PARADIS_AGENT_GATEWAY_INFO_PATH, PARADIS_AGENT_GATEWAY_VERSION, paradisAgentGatewayPortCandidates, paradisParseAgentGatewayFile, paradisParseAgentGatewayPortFile } from '../common/paradisAgentGateway.js';
import { PARADIS_REMOTE_HOOK_PORTS_DIR_NAME, PARADIS_REMOTE_HOOK_SOURCE_ID_PATTERN } from '../common/paradisRemoteHookSource.js';
import { IParadisAgentGatewaySource, ParadisAgentGatewayRelay } from './paradisAgentGatewayRelay.js';

/** 接続元を区別しない、前からあるポートファイル（古い Para Code はこれだけを書く）。 */
const SHARED_PORT_FILE_NAME = 'paradis-browser-mcp.json';

export interface IParadisAgentGatewayHostOptions {
	/** 接続先の `~/.para-code`。 */
	readonly paraCodeDirectory: string;
	readonly log: { info(message: string): void; warn(message: string, error?: unknown): void };
	/** 受け口の版。テストで差し替える。 */
	readonly version?: number;
	/** 控えの間、番号を取り直しに行く間隔。 */
	readonly standbyPollMs?: number;
	/** 受け口の場所か、自分が番号を持っているかが変わったら呼ぶ（テスト用）。 */
	readonly onDidChange?: (endpoint: IParadisAgentGatewayEndpoint | undefined, holding: boolean) => void;
	/** 中継の設定。テストで差し替える。 */
	readonly relay?: Omit<ConstructorParameters<typeof ParadisAgentGatewayRelay>[0], 'readSources'>;
}

interface IGatewayInfo {
	readonly version: number;
	readonly home: string;
}

/**
 * 接続先の `~/.para-code` にあるポートファイルを、新しく書かれたものから順に読む。
 * 書きかけ・壊れたものは飛ばす（次の見直しで読める）。同じ番号は 1 つにまとめる。
 */
export async function paradisReadAgentGatewaySources(paraCodeDirectory: string): Promise<IParadisAgentGatewaySource[]> {
	const found: Array<{ readonly id: string; readonly port: number; readonly mtime: number }> = [];
	const read = async (id: string, file: string) => {
		try {
			const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
			const port = paradisParseAgentGatewayPortFile(raw);
			if (port !== undefined) {
				found.push({ id, port, mtime: stat.mtimeMs });
			}
		} catch {
			// 無い・読めない。飛ばす
		}
	};
	const portsDirectory = join(paraCodeDirectory, PARADIS_REMOTE_HOOK_PORTS_DIR_NAME);
	let names: string[] = [];
	try {
		names = await fs.readdir(portsDirectory);
	} catch {
		// PC ごとのポートファイルがまだ無い
	}
	await Promise.all([
		...names
			.filter(name => name.endsWith('.json') && PARADIS_REMOTE_HOOK_SOURCE_ID_PATTERN.test(name.slice(0, -'.json'.length)))
			.map(name => read(name.slice(0, -'.json'.length), join(portsDirectory, name))),
		read('shared', join(paraCodeDirectory, SHARED_PORT_FILE_NAME)),
	]);
	// PC ごとのものを先に（同じ番号なら共有のものを落とす）、その中では新しい順
	found.sort((a, b) => (a.id === 'shared' ? 1 : 0) - (b.id === 'shared' ? 1 : 0) || b.mtime - a.mtime);
	const seen = new Set<number>();
	const sources: IParadisAgentGatewaySource[] = [];
	for (const entry of found) {
		if (!seen.has(entry.port)) {
			seen.add(entry.port);
			sources.push({ id: entry.id, port: entry.port });
		}
	}
	return sources;
}

async function getJson(port: number, path: string, timeoutMs: number): Promise<unknown> {
	const { request: httpRequest } = await import('http');
	return new Promise(resolve => {
		const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, agent: false }, response => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size <= 4096) {
					chunks.push(chunk);
				}
			});
			response.on('end', () => {
				try {
					resolve(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
				} catch {
					resolve(undefined);
				}
			});
			response.on('error', () => resolve(undefined));
		});
		request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
		request.on('error', () => resolve(undefined));
		request.end();
	});
}

export class ParadisAgentGatewayHost {

	private readonly version: number;
	private readonly standbyPollMs: number;
	private readonly gatewayFile: string;
	/** このホームの印。別のホームの受け口（別の利用者・試験用のホーム）を自分の仲間と見なさないために使う。 */
	private readonly homeKey: string;
	private readonly seed: number;
	private readonly relay: ParadisAgentGatewayRelay;

	private server: http.Server | undefined;
	private heldPort: number | undefined;
	private handoverKey: string | undefined;
	/** 控えのときの、持ち主の受け口。 */
	private observed: IParadisAgentGatewayEndpoint | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private acquiring: Promise<void> | undefined;
	private disposed = false;

	/** ポートファイルの読み取りを、要求が重なっても短い間は 1 回にまとめる。 */
	private sourcesCache: { readonly at: number; readonly value: Promise<IParadisAgentGatewaySource[]> } | undefined;

	constructor(private readonly options: IParadisAgentGatewayHostOptions) {
		this.version = options.version ?? PARADIS_AGENT_GATEWAY_VERSION;
		this.standbyPollMs = options.standbyPollMs ?? 2000;
		this.gatewayFile = join(options.paraCodeDirectory, PARADIS_AGENT_GATEWAY_FILE_NAME);
		const digest = createHash('sha256').update(`para-code-agent-gateway:${options.paraCodeDirectory}`).digest();
		this.homeKey = digest.toString('hex').slice(0, 16);
		this.seed = digest.readUInt16BE(8);
		this.relay = new ParadisAgentGatewayRelay({ ...options.relay, readSources: () => this.readSources() });
		this.acquiring = this.acquire();
	}

	/** 今の受け口。番号を取りに行っている最中なら決着を待つ。 */
	async getEndpoint(): Promise<IParadisAgentGatewayEndpoint | undefined> {
		await this.acquiring;
		if (this.heldPort !== undefined) {
			return { port: this.heldPort, version: this.version };
		}
		return this.observed;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.release();
		this.relay.dispose();
	}

	private lastNotified = '';

	private notify(): void {
		const endpoint = this.heldPort !== undefined ? { port: this.heldPort, version: this.version } : this.observed;
		const holding = this.heldPort !== undefined;
		const key = JSON.stringify([endpoint, holding]);
		if (key !== this.lastNotified) {
			this.lastNotified = key;
			this.options.onDidChange?.(endpoint, holding);
		}
	}

	private readSources(): Promise<IParadisAgentGatewaySource[]> {
		const now = Date.now();
		if (this.sourcesCache === undefined || now - this.sourcesCache.at > 200) {
			this.sourcesCache = { at: now, value: paradisReadAgentGatewaySources(this.options.paraCodeDirectory) };
		}
		return this.sourcesCache.value;
	}

	private release(): void {
		const server = this.server;
		this.server = undefined;
		this.heldPort = undefined;
		if (server !== undefined) {
			// 新しい接続は受けない。流している途中の要求は最後まで流す
			server.close();
			server.closeIdleConnections();
		}
	}

	private scheduleAcquire(delayMs: number): void {
		if (this.disposed || this.timer !== undefined) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.acquiring = this.acquire();
		}, delayMs);
		// 見張りの時計がサーバーの終了を妨げないようにする
		(this.timer as { unref?: () => void }).unref?.();
	}

	private async readGatewayFile(): Promise<IParadisAgentGatewayFile | undefined> {
		try {
			return paradisParseAgentGatewayFile(await fs.readFile(this.gatewayFile, 'utf8'));
		} catch {
			return undefined;
		}
	}

	/** 番号を取りに行く。取れなければ控えに回り、後でまた試す。投げない。 */
	private async acquire(): Promise<void> {
		if (this.disposed || this.server !== undefined) {
			return;
		}
		try {
			const recorded = await this.readGatewayFile();
			let observed: IParadisAgentGatewayEndpoint | undefined;
			for (const port of paradisAgentGatewayPortCandidates(this.seed, recorded?.port)) {
				if (this.disposed) {
					return;
				}
				if (await this.tryHold(port)) {
					return;
				}
				const info = await this.fetchInfo(port);
				if (info === undefined || info.home !== this.homeKey) {
					continue; // 関係の無いプログラムか、別のホームの受け口。次の候補へ
				}
				if (info.version < this.version && recorded?.port === port && await this.takeOver(port, recorded.handoverKey)) {
					return;
				}
				observed = { port, version: info.version };
				break;
			}
			if (observed === undefined && this.observed !== undefined) {
				this.options.log.info('[ParadisAgentGateway] the gateway this server was standing by for is gone and no port could be taken yet');
			}
			this.observed = observed;
			this.notify();
		} catch (error) {
			this.options.log.warn('[ParadisAgentGateway] could not set up the gateway (will retry)', error);
		}
		this.scheduleAcquire(this.standbyPollMs);
	}

	/** その番号で待ち受けを始める。取れたら true。 */
	private async tryHold(port: number): Promise<boolean> {
		const { createServer } = await import('http');
		const server = createServer((req, res) => this.onRequest(req, res));
		server.headersTimeout = 10_000;
		// 本文を受け取りきるまでの上限。応答を待つ時間は縛らない（待たせるのが役目）
		server.requestTimeout = 130_000;
		server.keepAliveTimeout = 120_000;
		server.timeout = 0;
		server.maxConnections = 512;
		const listening = await new Promise<boolean>(resolve => {
			server.once('error', () => resolve(false));
			server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true));
		});
		if (!listening || this.disposed) {
			server.close();
			return false;
		}
		// 待ち受けがサーバーの終了を妨げないようにする
		server.unref();
		server.on('error', error => this.options.log.warn('[ParadisAgentGateway] the gateway listener reported an error', error));
		this.server = server;
		this.heldPort = port;
		this.observed = undefined;
		this.handoverKey = randomBytes(24).toString('hex');
		try {
			await this.writeGatewayFile(port, this.handoverKey);
		} catch (error) {
			// 番号は持てている。ファイルが書けないと譲り受けと CLI からの発見ができないだけなので続ける
			this.options.log.warn('[ParadisAgentGateway] could not record the gateway port', error);
		}
		this.options.log.info(`[ParadisAgentGateway] holding the gateway on port ${port} (version ${this.version})`);
		this.notify();
		return true;
	}

	private async writeGatewayFile(port: number, handoverKey: string): Promise<void> {
		const content: IParadisAgentGatewayFile = {
			protocolVersion: PARADIS_AGENT_GATEWAY_FILE_PROTOCOL_VERSION,
			port,
			pid: process.pid,
			gatewayVersion: this.version,
			handoverKey,
		};
		await fs.mkdir(this.options.paraCodeDirectory, { recursive: true });
		// 読む側が書きかけを読まないよう、別名で書いてから置き換える。合い言葉が入るので本人だけが読める
		const staging = `${this.gatewayFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		await fs.writeFile(staging, JSON.stringify(content), { mode: 0o600 });
		await fs.rename(staging, this.gatewayFile);
	}

	private async fetchInfo(port: number): Promise<IGatewayInfo | undefined> {
		const value = await getJson(port, PARADIS_AGENT_GATEWAY_INFO_PATH, 1500);
		if (typeof value !== 'object' || value === null) {
			return undefined;
		}
		const record = value as { readonly gateway?: unknown; readonly version?: unknown; readonly home?: unknown };
		return record.gateway === 'para-code' && typeof record.version === 'number' && typeof record.home === 'string'
			? { version: record.version, home: record.home }
			: undefined;
	}

	/** 古い版の受け口から番号を譲り受ける。取れたら true。 */
	private async takeOver(port: number, handoverKey: string): Promise<boolean> {
		const { request: httpRequest } = await import('http');
		const accepted = await new Promise<boolean>(resolve => {
			const body = JSON.stringify({ version: this.version });
			const request = httpRequest({
				host: '127.0.0.1', port, method: 'POST', path: PARADIS_AGENT_GATEWAY_HANDOVER_PATH, agent: false,
				headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER]: handoverKey },
			}, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode === 200));
				response.on('error', () => resolve(false));
			});
			request.setTimeout(1500, () => request.destroy(new Error('timed out')));
			request.on('error', () => resolve(false));
			request.end(body);
		});
		if (!accepted) {
			return false;
		}
		// 持ち主が待ち受けを閉じるまで少し掛かる
		for (let attempt = 0; attempt < 30 && !this.disposed; attempt++) {
			if (await this.tryHold(port)) {
				this.options.log.info(`[ParadisAgentGateway] took the gateway port ${port} over from an older server`);
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return false;
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const path = (req.url ?? '/').split('?')[0];
		if (path === PARADIS_AGENT_GATEWAY_INFO_PATH && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ gateway: 'para-code', version: this.version, home: this.homeKey }));
			return;
		}
		if (path === PARADIS_AGENT_GATEWAY_HANDOVER_PATH && req.method === 'POST') {
			this.onHandover(req, res);
			return;
		}
		if (path.startsWith('/paradis-gateway/')) {
			res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ error: 'Unknown gateway request.' }));
			return;
		}
		this.relay.handle(req, res).catch(error => {
			this.options.log.warn('[ParadisAgentGateway] could not relay a request', error);
			if (!res.headersSent && !res.destroyed) {
				res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
				res.end(JSON.stringify({ error: 'The Para Code gateway could not relay the request.' }));
			} else {
				res.destroy();
			}
		});
	}

	private onHandover(req: http.IncomingMessage, res: http.ServerResponse): void {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size <= 1024) {
				chunks.push(chunk);
			}
		});
		req.on('end', () => {
			const offered = req.headers[PARADIS_AGENT_GATEWAY_HANDOVER_KEY_HEADER];
			const expected = this.handoverKey;
			let requestedVersion: unknown;
			try {
				requestedVersion = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown })?.version;
			} catch {
				requestedVersion = undefined;
			}
			const keyMatches = typeof offered === 'string' && expected !== undefined
				&& offered.length === expected.length
				&& timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
			if (!keyMatches || typeof requestedVersion !== 'number' || requestedVersion <= this.version) {
				res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
				res.end(JSON.stringify({ error: 'Handover refused.' }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
			res.end(JSON.stringify({ released: true }), () => {
				this.options.log.info('[ParadisAgentGateway] handing the gateway port over to a newer server');
				this.release();
				this.notify();
				// 譲った先の受け口の番号を、控えとして聞き直す
				this.scheduleAcquire(this.standbyPollMs);
			});
		});
		req.on('error', () => res.destroy());
	}
}
