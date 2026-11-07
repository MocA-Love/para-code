/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの新しいタブに「このスペースで動いているサーバー」を出すための下回り。
// 手元（shared process、node/paradisPortListChannel.ts）と接続先（REH、node/paradisPortListChannelServer.ts）の
// 両方から使う。
//
//  - プロセスの作業フォルダ（cwd）: Linux は /proc/<pid>/cwd、macOS は lsof -d cwd。Windows は取らない。
//  - ページの題とアイコン: loopback にだけ `GET /` を送り、2xx の HTML から <title> と <link rel=icon> を読む。
//    打ち切りは 1.5 秒・本文 256 KB・アイコン 64 KB（Orca の workspace-port-page-probe と同じ上限）。
//    結果は 15 秒覚えておき、新しいタブを開くたびに同じサーバーへ要求を送らない。

import * as cp from 'child_process';
import * as fs from 'fs';
import type * as http from 'http';
import type * as https from 'https';
import * as os from 'os';
import { isLinux, isMacintosh } from '../../../../base/common/platform.js';
import { IParadisPortEntry, IParadisPortPageInfo, IParadisPortPageRequest, IParadisPortServerEntry, IParadisPortServersSnapshot, PARADIS_PORT_PAGE_PROBE_LIMIT } from '../common/paradisPortList.js';

const PROBE_TIMEOUT_MS = 1500;
const PAGE_MAX_BYTES = 256 * 1024;
const ICON_MAX_BYTES = 64 * 1024;
const PROBE_CACHE_MS = 15_000;
const MAX_REDIRECTS = 3;
const TITLE_MAX_CHARS = 200;

/**
 * HTTP を話さないことが分かっている有名なポート。データベースなどへ `GET /` を送ると、
 * 相手のログにエラーが残ったり接続の数を使ったりするので、読みに行かない。
 */
export const PARADIS_NON_HTTP_PORTS: ReadonlySet<number> = new Set([
	21, 22, 23, 25, 53, 110, 143, 389, 445, 465, 587, 993, 995, // ftp・ssh・telnet・メール・DNS・LDAP・SMB
	1433, 1521, 2375, 2376, 3306, 5432, 5672, 6379, 6380, 7000, 7001, 9042, 9092, 11211, 15672, 27017, 27018, 28015, 2181, // DB・キュー・Docker
]);

/** `lsof -a -d cwd -Fn -p <pids>` の出力（`p<pid>` の行の次に `n<path>` の行）を読む。 */
export function parseLsofCwdOutput(stdout: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | undefined;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('p')) {
			const value = Number(line.slice(1));
			pid = Number.isSafeInteger(value) && value > 0 ? value : undefined;
		} else if (line.startsWith('n') && pid !== undefined && !cwds.has(pid)) {
			const path = line.slice(1);
			if (path.startsWith('/')) {
				cwds.set(pid, path);
			}
		}
	}
	return cwds;
}

/** プロセスの作業フォルダを引く。取れなかったものは結果に入れない。 */
export async function readProcessCwds(pids: readonly number[]): Promise<Map<number, string>> {
	const unique = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0);
	if (unique.length === 0) {
		return new Map();
	}
	if (isLinux) {
		const cwds = new Map<number, string>();
		await Promise.all(unique.map(async pid => {
			try {
				cwds.set(pid, await fs.promises.readlink(`/proc/${pid}/cwd`));
			} catch {
				// 別のユーザーのプロセスや、もう終わったプロセス
			}
		}));
		return cwds;
	}
	if (isMacintosh) {
		return new Promise(resolve => {
			cp.execFile('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', unique.join(',')], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => {
				// 一部の PID が無くなっていると非ゼロで終わるが、出せた分は使う
				resolve(parseLsofCwdOutput(stdout ?? ''));
			});
		});
	}
	return new Map();
}

export interface IParadisPortServerDescriberOptions {
	readonly readCwds?: (pids: readonly number[]) => Promise<Map<number, string>>;
	/**
	 * Para Code 自身の内部の口（MCP・hook の受け口・CDP のゲートウェイ・リレーなど）を開いているプロセス。
	 * 省略時は、このプロセス（手元では shared process、接続先では REH のサーバー）と親（手元では main）。
	 * 拡張機能のホストは別のプロセスなので、拡張機能が立てたサーバー（とその子）のポートは残る。
	 */
	readonly ownPids?: readonly number[];
	readonly homeDir?: string;
	/** cwd と実行ファイルを覚えておく長さ（ポートの一覧を同じ結果で返す長さと同じ）。 */
	readonly cacheMs: number;
	readonly now?: () => number;
}

/**
 * 待ち受けのポートに作業フォルダを付け、Para Code 自身の内部の口を外す。
 * cwd は PID ごとに覚えておき、短い間に何度も聞かれても lsof を起こし直さない。
 */
export class ParadisPortServerDescriber {

	private readonly cache = new Map<number, { at: number; cwd: string | undefined }>();
	private readonly readCwds: (pids: readonly number[]) => Promise<Map<number, string>>;
	private readonly ownPids: ReadonlySet<number>;
	private readonly homeDir: string;
	private readonly now: () => number;

	constructor(private readonly options: IParadisPortServerDescriberOptions) {
		this.readCwds = options.readCwds ?? readProcessCwds;
		this.ownPids = new Set(options.ownPids ?? [process.pid, process.ppid]);
		this.homeDir = options.homeDir ?? paradisHomeDir();
		this.now = options.now ?? Date.now;
	}

	async describe(entries: readonly IParadisPortEntry[], collectedAt: number): Promise<IParadisPortServersSnapshot> {
		const now = this.now();
		for (const [pid, info] of this.cache) {
			if (now - info.at > this.options.cacheMs) {
				this.cache.delete(pid);
			}
		}
		const missing = [...new Set(entries.map(entry => entry.pid))].filter(pid => !this.cache.has(pid));
		if (missing.length > 0) {
			const cwds = await this.readCwds(missing);
			for (const pid of missing) {
				this.cache.set(pid, { at: now, cwd: cwds.get(pid) });
			}
		}
		const result: IParadisPortServerEntry[] = [];
		for (const entry of entries) {
			const info = this.cache.get(entry.pid);
			if (this.ownPids.has(entry.pid)) {
				continue;
			}
			result.push(info?.cwd !== undefined ? { ...entry, cwd: info.cwd } : entry);
		}
		return { entries: result, homeDir: this.homeDir, collectedAt };
	}
}

export function paradisHomeDir(): string {
	return os.homedir();
}

/** 待ち受けのアドレスから、`GET /` を送る先のホストを決める。loopback か全公開でなければ送らない。 */
export function probeHostForAddress(address: string): string | undefined {
	const normalized = address.replace(/^\[|\]$/g, '');
	if (normalized === '::1') {
		return '::1';
	}
	if (normalized === '*' || normalized === '0.0.0.0' || normalized === '::' || normalized === '0:0:0:0:0:0:0:0' || normalized === 'localhost' || normalized.startsWith('127.')) {
		return '127.0.0.1';
	}
	return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === '#') {
			const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

/** HTML から <title> を読む。無い・空なら undefined。 */
export function parseHtmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) {
		return undefined;
	}
	const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
	return title ? title.slice(0, TITLE_MAX_CHARS) : undefined;
}

/** HTML の <link rel="icon"> などの href。最初に見つかったもの。 */
export function parseHtmlIconHref(html: string): string | undefined {
	const linkPattern = /<link\b[^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(html)) !== null) {
		const tag = match[0];
		const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const relValue = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().split(/\s+/);
		if (!relValue.includes('icon')) {
			continue;
		}
		const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const value = href?.[1] ?? href?.[2] ?? href?.[3];
		if (value) {
			return decodeEntities(value.trim());
		}
	}
	return undefined;
}

interface IFetchResult {
	readonly status: number;
	readonly contentType: string;
	readonly location?: string;
	readonly body: Buffer;
}

async function fetchOnce(url: URL, maxBytes: number): Promise<IFetchResult> {
	// http・https は読み込みが重いので、新しいタブが初めて題を読むときに読み込む
	const httpsModule: typeof https | undefined = url.protocol === 'https:' ? await import('https') : undefined;
	const httpModule: typeof http | undefined = httpsModule ? undefined : await import('http');
	const options: https.RequestOptions = {
		method: 'GET',
		// 手元の開発サーバーは自己署名の証明書が多い。送るのは loopback だけなので検証しない
		rejectUnauthorized: false,
		headers: { 'accept': 'text/html,image/*;q=0.8,*/*;q=0.5', 'user-agent': 'ParaCode-NewTab' },
		timeout: PROBE_TIMEOUT_MS,
	};
	return new Promise((resolve, reject) => {
		const onResponse = (response: http.IncomingMessage) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
					response.destroy();
					return;
				}
				chunks.push(chunk);
			});
			const finish = () => resolve({
				status: response.statusCode ?? 0,
				contentType: String(response.headers['content-type'] ?? ''),
				location: typeof response.headers.location === 'string' ? response.headers.location : undefined,
				body: Buffer.concat(chunks),
			});
			response.on('end', finish);
			response.on('close', finish);
			response.on('error', finish);
		};
		const request = httpsModule ? httpsModule.request(url, options, onResponse) : httpModule!.request(url, options, onResponse);
		request.on('timeout', () => request.destroy(new Error('timeout')));
		request.on('error', reject);
		request.end();
	});
}

/** 同じオリジンへのリダイレクトだけを最大 3 回たどる。 */
async function fetchFollowing(url: URL, maxBytes: number): Promise<{ url: URL; result: IFetchResult }> {
	let current = url;
	for (let i = 0; ; i++) {
		const result = await fetchOnce(current, maxBytes);
		if (result.status >= 300 && result.status < 400 && result.location && i < MAX_REDIRECTS) {
			const next = new URL(result.location, current);
			if (next.origin !== url.origin) {
				return { url: current, result };
			}
			current = next;
			continue;
		}
		return { url: current, result };
	}
}

async function readIcon(pageUrl: URL, html: string): Promise<string | undefined> {
	const href = parseHtmlIconHref(html) ?? '/favicon.ico';
	let iconUrl: URL;
	try {
		iconUrl = new URL(href, pageUrl);
	} catch {
		return undefined;
	}
	if (iconUrl.origin !== pageUrl.origin) {
		return undefined;
	}
	try {
		const { result } = await fetchFollowing(iconUrl, ICON_MAX_BYTES + 1);
		const type = result.contentType.split(';')[0].trim().toLowerCase();
		if (result.status < 200 || result.status >= 300 || !type.startsWith('image/') || result.body.length === 0 || result.body.length > ICON_MAX_BYTES) {
			return undefined;
		}
		return `data:${type};base64,${result.body.toString('base64')}`;
	} catch {
		return undefined;
	}
}

async function probeScheme(host: string, port: number, scheme: 'http' | 'https'): Promise<IParadisPortPageInfo> {
	const base = new URL(`${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/`);
	const { url, result } = await fetchFollowing(base, PAGE_MAX_BYTES);
	const isHtml = result.contentType.toLowerCase().includes('text/html');
	if (result.status < 200 || result.status >= 300 || !isHtml) {
		return { port, isPage: false, scheme };
	}
	const html = result.body.toString('utf8');
	return { port, isPage: true, scheme, title: parseHtmlTitle(html), faviconDataUrl: await readIcon(url, html) };
}

/** 1 つのポートの題とアイコン。http で話せなければ https を試す。 */
export async function probePortPage(request: IParadisPortPageRequest): Promise<IParadisPortPageInfo> {
	const host = probeHostForAddress(request.address);
	if (host === undefined || !Number.isSafeInteger(request.port) || request.port <= 0 || request.port > 65535) {
		return { port: request.port, isPage: false, scheme: 'http' };
	}
	try {
		return await probeScheme(host, request.port, 'http');
	} catch {
		try {
			return await probeScheme(host, request.port, 'https');
		} catch {
			return { port: request.port, isPage: false, scheme: 'http' };
		}
	}
}

/** ページの題を 15 秒覚えておく入れ物。手元と接続先のチャネルが 1 つずつ持つ。 */
export class ParadisPortPageProbeCache {

	private readonly cache = new Map<string, { at: number; info: Promise<IParadisPortPageInfo> }>();
	/** 「ページでない」と分かった (pid, port)。そのプロセスが続く間は聞き直さない。 */
	private readonly notPages = new Set<string>();

	constructor(
		private readonly probe: (request: IParadisPortPageRequest) => Promise<IParadisPortPageInfo> = probePortPage,
		private readonly now: () => number = Date.now,
		private readonly isAlive: (pid: number) => boolean = paradisIsProcessAlive,
	) { }

	probePages(requests: readonly unknown[]): Promise<IParadisPortPageInfo[]> {
		const valid: IParadisPortPageRequest[] = [];
		for (const value of requests) {
			if (valid.length >= PARADIS_PORT_PAGE_PROBE_LIMIT) {
				break;
			}
			const candidate = value as Partial<IParadisPortPageRequest> | undefined;
			if (candidate && typeof candidate.port === 'number' && typeof candidate.address === 'string') {
				valid.push({ port: candidate.port, address: candidate.address, pid: typeof candidate.pid === 'number' ? candidate.pid : undefined });
			}
		}
		const now = this.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.at > PROBE_CACHE_MS) {
				this.cache.delete(key);
			}
		}
		for (const key of [...this.notPages]) {
			if (!this.isAlive(Number(key.split('|')[0]))) {
				this.notPages.delete(key);
			}
		}
		return Promise.all(valid.map(request => {
			const notPage: IParadisPortPageInfo = { port: request.port, isPage: false, scheme: 'http' };
			const pidKey = request.pid !== undefined ? `${request.pid}|${request.port}` : undefined;
			if (PARADIS_NON_HTTP_PORTS.has(request.port) || (pidKey !== undefined && this.notPages.has(pidKey))) {
				return Promise.resolve(notPage);
			}
			const key = `${request.address}|${request.port}`;
			let entry = this.cache.get(key);
			if (!entry) {
				const info = this.probe(request).then(result => {
					if (!result.isPage && pidKey !== undefined) {
						this.notPages.add(pidKey);
					}
					return result;
				});
				entry = { at: now, info };
				this.cache.set(key, entry);
			}
			return entry.info;
		}));
	}
}

/** プロセスがまだあるか（権限が無くてシグナルを送れないだけなら、あるとみなす）。 */
export function paradisIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
