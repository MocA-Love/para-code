/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// aivis-mcp が Redis に置くキー（worker の lock・ミュート・再生 lock）があるかを、GET だけで確かめる。読むだけで書かない。
// RESP は単純な型（+ - : $）だけを読む小さな実装（依存を足さないため）。

import { promises as fs } from 'fs';
import { connect, Socket } from 'net';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';

/** 1 回の要求の返事を待つ上限。 */
const REPLY_TIMEOUT_MS = 1_000;
/** 返事として受け取る大きさの上限（これを越えたら確かめられないとする）。 */
const MAX_BUFFERED_BYTES = 64 * 1024;

/** aivis-mcp と同じ順（REDIS_URL → ~/.config/aivis-mcp/config.json → 既定）で Redis の URL を決める。 */
async function resolveRedisUrl(env: NodeJS.ProcessEnv): Promise<string> {
	if (env.REDIS_URL) {
		return env.REDIS_URL;
	}
	try {
		const settings = JSON.parse(await fs.readFile(join(homedir(), '.config', 'aivis-mcp', 'config.json'), 'utf8')) as { redisUrl?: unknown };
		if (typeof settings.redisUrl === 'string' && settings.redisUrl) {
			return settings.redisUrl;
		}
	} catch {
		// 無い・読めない
	}
	return 'redis://127.0.0.1:6379';
}

function respCommand(parts: readonly string[]): string {
	return `*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

const RESP_ERROR = Symbol('resp-error');
type RespReply = string | null | typeof RESP_ERROR;

/**
 * RESP の返事を並べて読む（単純な型だけ）。`$<長さ>` はバイト数として読む。読み切れた返事と、読んだバイト数を返す。
 */
export function paradisParseRespReplies(buffer: Buffer): { readonly replies: RespReply[]; readonly consumed: number } {
	const replies: RespReply[] = [];
	let index = 0;
	while (index < buffer.length) {
		const lineEnd = buffer.indexOf('\r\n', index);
		if (lineEnd < 0) {
			break;
		}
		const kind = String.fromCharCode(buffer[index]);
		const line = buffer.toString('utf8', index + 1, lineEnd);
		if (kind === '+' || kind === ':') {
			replies.push(line);
			index = lineEnd + 2;
		} else if (kind === '-') {
			replies.push(RESP_ERROR);
			index = lineEnd + 2;
		} else if (kind === '$') {
			const length = Number(line);
			if (length < 0) {
				replies.push(null);
				index = lineEnd + 2;
				continue;
			}
			if (buffer.length < lineEnd + 2 + length + 2) {
				break;
			}
			replies.push(buffer.toString('utf8', lineEnd + 2, lineEnd + 2 + length));
			index = lineEnd + 2 + length + 2;
		} else {
			replies.push(null);
			index = lineEnd + 2;
		}
	}
	return { replies, consumed: index };
}

/**
 * 1 本の接続で、キーがあるかを何度も確かめる。最初の要求の前に AUTH・SELECT を 1 回だけ送る。
 * 確かめられなくなったら（切れた・時間切れ・エラーの返事）以後はずっと undefined を返す。
 */
export class ParadisAivisRedisKeyProbe {

	private socket: Socket | undefined;
	private connected: Promise<boolean | undefined> | undefined;
	private buffer = Buffer.alloc(0);
	private pending: { readonly count: number; readonly replies: RespReply[]; readonly resolve: (replies: RespReply[] | undefined) => void } | undefined;
	private broken = false;
	private setupSent = false;

	private constructor(private readonly host: string, private readonly port: number, private readonly setup: readonly (readonly string[])[]) { }

	/** URL を読んで接続の準備をする（つなぐのは最初の {@link has} のとき）。rediss・壊れた URL は undefined。 */
	static async create(env: NodeJS.ProcessEnv): Promise<ParadisAivisRedisKeyProbe | undefined> {
		try {
			const url = new URL(await resolveRedisUrl(env));
			if (url.protocol !== 'redis:') {
				return undefined;
			}
			const setup: string[][] = [];
			if (url.password) {
				setup.push(url.username ? ['AUTH', decodeURIComponent(url.username), decodeURIComponent(url.password)] : ['AUTH', decodeURIComponent(url.password)]);
			}
			const db = url.pathname.replace(/^\//, '');
			if (/^\d+$/.test(db) && db !== '0') {
				setup.push(['SELECT', db]);
			}
			return new ParadisAivisRedisKeyProbe((url.hostname || '127.0.0.1').replace(/^\[(?<address>.*)\]$/, '$<address>'), Number(url.port) || 6379, setup);
		} catch {
			return undefined;
		}
	}

	/**
	 * キーがあるか。つながらない（Redis が無い）ときは false。確かめられないとき（認証の失敗・時間切れ・途中で切れた）は undefined。
	 */
	async has(key: string): Promise<boolean | undefined> {
		if (this.broken) {
			return undefined;
		}
		const connected = await this.connect();
		if (connected !== true) {
			return connected;
		}
		const commands = this.setupSent ? [['GET', key]] : [...this.setup, ['GET', key]];
		this.setupSent = true;
		const replies = await this.request(commands);
		if (replies === undefined || replies.some(reply => reply === RESP_ERROR)) {
			// NOAUTH など。確かめられない
			this.fail();
			return undefined;
		}
		const last = replies[replies.length - 1];
		return typeof last === 'string' && last.length > 0;
	}

	dispose(): void {
		this.fail();
	}

	private connect(): Promise<boolean | undefined> {
		if (this.connected === undefined) {
			this.connected = new Promise<boolean | undefined>(resolve => {
				const socket = connect({ host: this.host, port: this.port });
				this.socket = socket;
				const timer = setTimeout(() => {
					resolve(undefined);
					this.fail();
				}, REPLY_TIMEOUT_MS);
				socket.once('connect', () => {
					clearTimeout(timer);
					resolve(true);
				});
				socket.on('error', (error: NodeJS.ErrnoException) => {
					clearTimeout(timer);
					resolve(error.code === 'ECONNREFUSED' ? false : undefined);
					this.fail();
				});
				socket.on('close', () => this.fail());
				socket.on('data', (chunk: Buffer) => this.receive(chunk));
			});
		}
		return this.connected;
	}

	private request(commands: readonly (readonly string[])[]): Promise<RespReply[] | undefined> {
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.fail();
			}, REPLY_TIMEOUT_MS);
			this.pending = {
				count: commands.length, replies: [], resolve: replies => {
					clearTimeout(timer);
					resolve(replies);
				}
			};
			this.socket?.write(commands.map(respCommand).join(''));
		});
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > MAX_BUFFERED_BYTES) {
			this.fail();
			return;
		}
		const { replies, consumed } = paradisParseRespReplies(this.buffer);
		this.buffer = this.buffer.subarray(consumed);
		const pending = this.pending;
		if (pending === undefined) {
			return;
		}
		pending.replies.push(...replies);
		if (pending.replies.length >= pending.count) {
			this.pending = undefined;
			pending.resolve(pending.replies.slice(0, pending.count));
		}
	}

	private fail(): void {
		this.broken = true;
		const pending = this.pending;
		this.pending = undefined;
		pending?.resolve(undefined);
		this.socket?.destroy();
		this.socket = undefined;
	}
}

/** キーがあるかを 1 回だけ確かめる（つないで、確かめて、閉じる）。 */
export async function paradisProbeAivisRedisKey(env: NodeJS.ProcessEnv, key: string): Promise<boolean | undefined> {
	const probe = await ParadisAivisRedisKeyProbe.create(env);
	if (probe === undefined) {
		return undefined;
	}
	try {
		return await probe.has(key);
	} finally {
		probe.dispose();
	}
}
