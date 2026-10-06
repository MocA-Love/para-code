/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストへの SSH（SFTP）の接続。shared process で動く。
//
// 段階 1 は公開鍵（ssh-agent と鍵ファイル）だけで入る。パスワード・keyboard-interactive・パスフレーズは聞かない
// （shared process には端末が無く、聞く画面も段階 2）。ホストの鍵は known_hosts と**一致したときだけ**受け入れ、
// 未知・不一致は断る（勝手に known_hosts へ足さない）。設定は `ssh -G` に解かせ、upstream の known_hosts の照合
// （sshKnownHosts.ts）と ProxyCommand（sshProxyCommand.ts）を借りる。
//
// 接続はホストごとに 1 本を使い回し（ウィンドウが複数でも 1 本）、ハンドルも進行中の操作も無くなってから
// 設定の秒数で閉じる。ログにはホスト名・パスを書かない（種類と時間と件数だけ）。

import * as cp from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import type { AnyAuthMethod, AuthenticationType, BaseAgent, Client, ConnectConfig, ParsedKey, SFTPWrapper } from 'ssh2';
import type { Duplex } from 'stream';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { resolveSSHKnownHostsFiles } from '../../../../platform/agentHost/node/sshConfigPaths.js';
import { matchKnownHosts, parseKnownHosts, readHostKeyType } from '../../../../platform/agentHost/node/sshKnownHosts.js';
import { expandSSHProxyCommand, SSHProxyCommand } from '../../../../platform/agentHost/node/sshProxyCommand.js';
import {
	IParadisSshHostConfig,
	paradisSftpFailureMessage,
	ParadisSftpFailureReason,
	paradisSftpIdleMs,
	paradisSshConfigFromFile,
	paradisSshConfigFromSshG,
	paradisSshIncludePatterns,
	PARADIS_SFTP_IDLE_DEFAULT_SECONDS,
} from '../common/paradisSftp.js';
import { paradisIsSafeSshHost } from '../../remoteHosts/common/paradisRemoteHosts.js';

const LOG_PREFIX = '[ParadisSftp]';
/** 鍵の交換から認証までの上限。 */
const PARADIS_SFTP_HANDSHAKE_TIMEOUT_MS = 20_000;
/** `ssh -G` の上限。 */
const PARADIS_SSH_G_TIMEOUT_MS = 5_000;

/** 接続の失敗。メッセージには理由の名前だけを入れる（ホスト名・パスはログにも画面にも渡さない）。 */
export class ParadisSftpFailure extends Error {
	constructor(readonly reason: ParadisSftpFailureReason) {
		super(paradisSftpFailureMessage(reason));
		this.name = 'ParadisSftpFailure';
	}
}

/** ssh2 のうち、ここで使う部分。 */
export interface IParadisSsh2Module {
	readonly Client: new () => Client;
	readonly BaseAgent: abstract new () => BaseAgent;
	readonly OpenSSHAgent: new (socketPath: string) => BaseAgent<ParsedKey>;
	createAgent(socketPath: string): BaseAgent;
	readonly utils: { parseKey(data: Buffer | string, passphrase?: string): ParsedKey | ParsedKey[] | Error };
}

/** 本物の ssh2 を読む（native module と同じく createRequire で。Electron の ESM ローダーを通さない）。 */
export async function paradisLoadSsh2(): Promise<IParadisSsh2Module> {
	// `node:module` ではなく `module` で読む（単体テストの renderer は import map で組み込みの名前だけを解く）
	const nodeModule = await import('module');
	const require = nodeModule.createRequire(import.meta.url);
	return require('ssh2') as IParadisSsh2Module;
}

// --- 設定の解決 ------------------------------------------------------------------------------------

function expandHome(path: string, home: string): string {
	return path === '~' ? home : path.replace(/^~(?=[/\\])/, home);
}

/** `~/.ssh/config` の Include を展開した行の並び（ssh が起動できないときの代わり）。 */
async function readSshConfigLines(path: string, home: string, seen: Set<string>): Promise<string[]> {
	if (seen.has(path) || seen.size > 64) {
		return [];
	}
	seen.add(path);
	let content: string;
	try {
		content = await fsp.readFile(path, 'utf-8');
	} catch {
		return [];
	}
	const lines: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		const patterns = paradisSshIncludePatterns(line);
		if (!patterns) {
			lines.push(line);
			continue;
		}
		for (const raw of patterns) {
			const expanded = expandHome(raw, home);
			const resolved = isAbsolute(expanded) ? expanded : join(home, '.ssh', expanded);
			if (/[*?]/.test(resolved)) {
				const base = resolved.slice(resolved.lastIndexOf('/') + 1);
				const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
				const files = await fsp.readdir(dirname(resolved)).catch(() => [] as string[]);
				for (const file of files.filter(name => regex.test(name)).sort()) {
					lines.push(...await readSshConfigLines(join(dirname(resolved), file), home, seen));
				}
			} else {
				lines.push(...await readSshConfigLines(resolved, home, seen));
			}
		}
	}
	return lines;
}

/**
 * 別名の設定を解く。`ssh -G` に解かせ（Include・Match・既定値まで OpenSSH 自身が解く）、`ssh` が起動できない
 * 環境だけ `~/.ssh/config` を自前で読む。
 */
export async function paradisResolveSshHost(alias: string): Promise<IParadisSshHostConfig> {
	if (!paradisIsSafeSshHost(alias)) {
		throw new ParadisSftpFailure('sshConfig');
	}
	const home = os.homedir();
	let stdout: string;
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			cp.execFile('ssh', ['-G', '--', alias.trim()], { timeout: PARADIS_SSH_G_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(String(out ?? '')));
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			throw new ParadisSftpFailure('sshConfig');
		}
		const lines = await readSshConfigLines(join(home, '.ssh', 'config'), home, new Set());
		return paradisSshConfigFromFile(alias.trim(), lines, os.userInfo().username);
	}
	let knownHosts: { userKnownHostsFiles: string[]; globalKnownHostsFiles: string[] };
	try {
		knownHosts = await resolveSSHKnownHostsFiles(stdout);
	} catch {
		// known_hosts の場所を確かめられないなら、既定へ戻さずに断る（照合を緩めない）
		throw new ParadisSftpFailure('sshConfig');
	}
	return paradisSshConfigFromSshG(alias.trim(), stdout, knownHosts);
}

// --- 認証 ------------------------------------------------------------------------------------------

/** 試す認証の 1 つ。 */
type ParadisAuthAttempt =
	| { readonly kind: 'agent'; readonly agent: BaseAgent | string }
	| { readonly kind: 'key'; readonly key: ParsedKey };

/** 接続に要る、手元の環境（テストで差し替える）。 */
export interface IParadisSftpEnvironment {
	readonly homedir: string;
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readFile(path: string): Promise<Buffer>;
}

export function paradisDefaultSftpEnvironment(): IParadisSftpEnvironment {
	return { homedir: os.homedir(), platform: process.platform, env: process.env, readFile: path => fsp.readFile(path) };
}

/** `IdentityAgent` と環境から、使う agent の場所を決める。無ければ undefined。 */
export function paradisResolveAgentPath(identityAgent: string | undefined, environment: Pick<IParadisSftpEnvironment, 'env' | 'homedir' | 'platform'>): string | undefined {
	const fromEnv = (name: string) => environment.env[name] || undefined;
	const fallback = () => fromEnv('SSH_AUTH_SOCK') ?? (environment.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
	if (identityAgent === undefined) {
		return fallback();
	}
	const trimmed = identityAgent.trim();
	if (!trimmed || trimmed.toLowerCase() === 'none') {
		return undefined;
	}
	if (trimmed === 'SSH_AUTH_SOCK') {
		return fallback();
	}
	if (trimmed.startsWith('$')) {
		const match = /^\$\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}$|^\$(?<plain>[A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
		return match?.groups ? fromEnv(match.groups.braced ?? match.groups.plain) : undefined;
	}
	return expandHome(trimmed, environment.homedir);
}

function firstKey(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
	return Array.isArray(parsed) ? parsed[0] ?? new Error('empty key') : parsed;
}

/**
 * 試す認証を並べる。OpenSSH と同じく agent が先、鍵ファイルが後。
 * `IdentitiesOnly yes` なら、agent の鍵は IdentityFile の公開鍵と一致するものだけに絞る。
 * パスフレーズ付きの鍵ファイルは（聞けないので）飛ばす。agent が同じ鍵を持っていればそちらで入れる。
 */
async function buildAuthAttempts(ssh2: IParadisSsh2Module, config: IParadisSshHostConfig, environment: IParadisSftpEnvironment): Promise<ParadisAuthAttempt[]> {
	const keys: ParsedKey[] = [];
	const allowedPublicKeys: Buffer[] = [];
	for (const raw of config.identityFiles) {
		const path = expandHome(raw, environment.homedir);
		const privateData = await environment.readFile(path).catch(() => undefined);
		if (privateData) {
			const parsed = firstKey(ssh2.utils.parseKey(privateData));
			if (!(parsed instanceof Error) && parsed.isPrivateKey()) {
				keys.push(parsed);
				allowedPublicKeys.push(parsed.getPublicSSH());
				continue;
			}
		}
		// パスフレーズ付き・読めない鍵でも、公開鍵が隣にあれば agent の鍵を絞るのに使う
		const publicData = await environment.readFile(`${path}.pub`).catch(() => undefined);
		if (publicData) {
			const parsed = firstKey(ssh2.utils.parseKey(publicData));
			if (!(parsed instanceof Error)) {
				allowedPublicKeys.push(parsed.getPublicSSH());
			}
		}
	}

	const attempts: ParadisAuthAttempt[] = [];
	const agentPath = paradisResolveAgentPath(config.identityAgent, environment);
	if (agentPath) {
		if (config.identitiesOnly) {
			if (allowedPublicKeys.length) {
				attempts.push({ kind: 'agent', agent: createFilteredAgent(ssh2, ssh2.createAgent(agentPath), allowedPublicKeys) });
			}
		} else {
			attempts.push({ kind: 'agent', agent: agentPath });
		}
	}
	attempts.push(...keys.map(key => ({ kind: 'key' as const, key })));
	return attempts;
}

/** agent の鍵のうち、許した公開鍵だけを見せる agent。 */
function createFilteredAgent(ssh2: IParadisSsh2Module, inner: BaseAgent, allowed: readonly Buffer[]): BaseAgent {
	class ParadisFilteredAgent extends (ssh2.BaseAgent as unknown as new () => BaseAgent) {
		getIdentities(callback: (error: Error | undefined, keys?: ParsedKey[]) => void): void {
			inner.getIdentities((error, identities) => {
				if (error || !identities) {
					callback(error ?? undefined, undefined);
					return;
				}
				const keys: ParsedKey[] = [];
				for (const identity of identities) {
					const parsed = identity as Partial<ParsedKey>;
					if (typeof identity === 'object' && typeof parsed.getPublicSSH === 'function') {
						const blob = parsed.getPublicSSH();
						if (allowed.some(key => key.equals(blob))) {
							keys.push(identity as ParsedKey);
						}
					}
				}
				callback(undefined, keys);
			});
		}
		sign(...args: unknown[]): void {
			// 引数の形（options の有無）はそのまま中の agent へ渡す。`this` を中の agent にするため apply を使う
			(inner.sign as (this: BaseAgent, ...a: unknown[]) => void).apply(inner, args);
		}
	}
	return new ParadisFilteredAgent();
}

/** ssh2 の authHandler。サーバーが受け付ける方式だけを順に出し、尽きたら諦める（パスワード等は出さない）。 */
function makeAuthHandler(attempts: ParadisAuthAttempt[], username: string, onAttempt: (kind: ParadisAuthAttempt['kind']) => void) {
	const queue = [...attempts];
	return (methodsLeft: AuthenticationType[] | null, _partialSuccess: boolean | null, next: (method: AnyAuthMethod | false) => void) => {
		if (methodsLeft && !methodsLeft.includes('publickey')) {
			next(false);
			return;
		}
		const attempt = queue.shift();
		if (!attempt) {
			next(false);
			return;
		}
		onAttempt(attempt.kind);
		next(attempt.kind === 'agent'
			? { type: 'agent', username, agent: attempt.agent }
			: { type: 'publickey', username, key: attempt.key });
	};
}

// --- ホストの鍵 -----------------------------------------------------------------------------------

async function readKnownHosts(config: IParadisSshHostConfig, environment: IParadisSftpEnvironment) {
	const files = [...config.userKnownHostsFiles, ...config.globalKnownHostsFiles];
	const entries = [];
	for (const file of files) {
		const content = await environment.readFile(expandHome(file, environment.homedir)).catch(() => undefined);
		if (content) {
			entries.push(...parseKnownHosts(content.toString('utf8')));
		}
	}
	return entries;
}

/** known_hosts と照合する。一致したときだけ `undefined`（受け入れる）、それ以外は断る理由。 */
export async function paradisCheckHostKey(config: IParadisSshHostConfig, key: Buffer, environment: IParadisSftpEnvironment): Promise<ParadisSftpFailureReason | undefined> {
	const keyType = readHostKeyType(key);
	if (!keyType) {
		return 'hostKeyMismatch';
	}
	const entries = await readKnownHosts(config, environment);
	// HostKeyAlias があれば、その名前だけで引く（OpenSSH と同じ。ポートは付けない）
	const result = config.hostKeyAlias
		? matchKnownHosts(entries, config.hostKeyAlias, 22, keyType, key)
		: matchKnownHosts(entries, config.hostname, config.port, keyType, key);
	switch (result) {
		case 'match':
			return undefined;
		case 'mismatch':
		case 'revoked':
			return 'hostKeyMismatch';
		default:
			return 'hostKeyUnknown';
	}
}

// --- 接続 ------------------------------------------------------------------------------------------

/** 繋がった 1 本。 */
export interface IParadisSftpSession {
	readonly sftp: SFTPWrapper;
	/** ログインしたユーザーのホーム（絶対パス）。 */
	readonly home: string;
	/** 自分の uid（ホームの所有者とみなす）。読めなければ undefined。 */
	readonly ownUid: number | undefined;
}

export interface IParadisSftpConnectorOptions {
	readonly logService: ILogService;
	readonly resolveHost?: (alias: string) => Promise<IParadisSshHostConfig>;
	readonly loadSsh2?: () => Promise<IParadisSsh2Module>;
	readonly environment?: IParadisSftpEnvironment;
	readonly handshakeTimeoutMs?: number;
}

/** ssh2 の接続の失敗を理由に直す。 */
function classifyConnectError(error: unknown, hostKeyReason: ParadisSftpFailureReason | undefined): ParadisSftpFailureReason {
	if (error instanceof ParadisSftpFailure) {
		return error.reason;
	}
	if (hostKeyReason) {
		return hostKeyReason;
	}
	const level = (error as { level?: string } | undefined)?.level;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const message = error instanceof Error ? error.message : '';
	if (level === 'client-authentication' || /authentication methods failed/i.test(message)) {
		return 'authUnsupported';
	}
	if (level === 'client-timeout' || /timed out/i.test(message) || code === 'ETIMEDOUT') {
		return 'timeout';
	}
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET' || level === 'client-socket') {
		return 'unreachable';
	}
	return 'other';
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
	return new Promise((resolve, reject) => sftp.realpath(path, (error, absolute) => error ? reject(error) : resolve(absolute)));
}

function sftpStatUid(sftp: SFTPWrapper, path: string): Promise<number | undefined> {
	return new Promise(resolve => sftp.stat(path, (error, stats) => resolve(error ? undefined : stats.uid)));
}

/**
 * 1 ホストへ繋ぐ。成功すると SFTP のセッションを返し、`onClose` は切れたときに 1 回呼ぶ。
 * 失敗は {@link ParadisSftpFailure}（理由つき）で投げる。
 */
export async function paradisConnectSftp(
	alias: string,
	options: IParadisSftpConnectorOptions,
	onClose: () => void,
): Promise<{ readonly session: IParadisSftpSession; readonly dispose: () => void }> {
	const started = Date.now();
	const environment = options.environment ?? paradisDefaultSftpEnvironment();
	const logService = options.logService;
	const fail = (reason: ParadisSftpFailureReason): never => {
		logService.info(`${LOG_PREFIX} connect failed reason=${reason} ms=${Date.now() - started}`);
		throw new ParadisSftpFailure(reason);
	};

	let config: IParadisSshHostConfig;
	try {
		config = await (options.resolveHost ?? paradisResolveSshHost)(alias);
	} catch (error) {
		return fail(error instanceof ParadisSftpFailure ? error.reason : 'sshConfig');
	}
	if (config.proxyJump) {
		return fail('proxyJump');
	}
	const ssh2 = await (options.loadSsh2 ?? paradisLoadSsh2)();
	const attempts = await buildAuthAttempts(ssh2, config, environment);
	if (!attempts.length) {
		return fail('authUnsupported');
	}

	const client = new ssh2.Client();
	let proxy: SSHProxyCommand | undefined;
	let hostKeyReason: ParadisSftpFailureReason | undefined;
	let lastAuth: ParadisAuthAttempt['kind'] | undefined;
	const username = config.user || os.userInfo().username;

	const connectConfig: ConnectConfig = {
		host: config.hostname,
		port: config.port,
		username,
		readyTimeout: options.handshakeTimeoutMs ?? PARADIS_SFTP_HANDSHAKE_TIMEOUT_MS,
		keepaliveInterval: 15_000,
		keepaliveCountMax: 3,
		authHandler: makeAuthHandler(attempts, username, kind => lastAuth = kind) as unknown as ConnectConfig['authHandler'],
		hostVerifier: ((key: Buffer, verify: (permitted: boolean) => void) => {
			paradisCheckHostKey(config, key, environment).then(reason => {
				hostKeyReason = reason;
				verify(!reason);
			}, () => {
				// 照合の途中の失敗は断る（失敗を通り道にしない）
				hostKeyReason = 'hostKeyUnknown';
				verify(false);
			});
		}) as unknown as ConnectConfig['hostVerifier'],
	};

	const disposeConnection = () => {
		client.end();
		proxy?.dispose();
		proxy = undefined;
	};

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			client.once('ready', () => settle());
			client.on('error', error => settle(error));
			client.once('close', () => settle(new Error('closed before ready')));
			if (config.proxyCommand) {
				proxy = new SSHProxyCommand(expandSSHProxyCommand(config.proxyCommand, config.hostname, config.alias, config.port, username), logService);
				proxy.stream.on('error', error => settle(Object.assign(error, { level: 'client-socket' })));
				connectConfig.sock = proxy.stream as Duplex as ConnectConfig['sock'];
			}
			try {
				client.connect(connectConfig);
			} catch (error) {
				settle(error);
			}
		});
	} catch (error) {
		disposeConnection();
		return fail(classifyConnectError(error, hostKeyReason));
	}

	let sftp: SFTPWrapper;
	try {
		sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, wrapper) => error ? reject(error) : resolve(wrapper)));
	} catch {
		disposeConnection();
		return fail('other');
	}
	const home = await sftpRealpath(sftp, '.').catch(() => '/');
	const ownUid = await sftpStatUid(sftp, home);

	let closed = false;
	const notifyClose = () => {
		if (!closed) {
			closed = true;
			proxy?.dispose();
			proxy = undefined;
			onClose();
		}
	};
	client.on('close', notifyClose);
	client.on('error', () => notifyClose());
	// ready の後に ssh2 は自前の error のリスナーを外す。壊れたパケットで shared process ごと落ちないよう受ける
	sftp.on('error', () => {
		client.end();
		notifyClose();
	});
	sftp.on('close', () => {
		client.end();
		notifyClose();
	});
	logService.info(`${LOG_PREFIX} connect ok auth=${lastAuth ?? 'unknown'} proxy=${config.proxyCommand ? 'command' : 'none'} ms=${Date.now() - started}`);
	return {
		session: { sftp, home, ownUid },
		dispose: () => {
			closed = true;
			disposeConnection();
		},
	};
}

// --- 使い回し --------------------------------------------------------------------------------------

interface IPoolEntry {
	readonly alias: string;
	connecting: Promise<IParadisSftpSession> | undefined;
	session: IParadisSftpSession | undefined;
	dispose: (() => void) | undefined;
	/** 進行中の操作の数。 */
	busy: number;
	/** 開いているファイルの数。 */
	handles: number;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** 切れた・閉じたら 1 つ進む（古い世代のハンドルを見分ける）。 */
	generation: number;
}

/** 接続をホストごとに 1 本使い回し、使い終わってから一定時間で閉じる。 */
export class ParadisSftpConnectionPool extends Disposable {

	private readonly entries = new Map<string, IPoolEntry>();
	private idleMs = paradisSftpIdleMs(PARADIS_SFTP_IDLE_DEFAULT_SECONDS);

	constructor(private readonly options: IParadisSftpConnectorOptions) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) {
				this.close(entry, 'dispose');
			}
		}));
	}

	setIdleMs(ms: number): void {
		this.idleMs = ms;
		for (const entry of this.entries.values()) {
			this.scheduleIdle(entry);
		}
	}

	/** 繋がっている（または繋ぎかけの）ホストの数。 */
	get size(): number {
		return this.entries.size;
	}

	private entryFor(alias: string): IPoolEntry {
		let entry = this.entries.get(alias);
		if (!entry) {
			entry = { alias, connecting: undefined, session: undefined, dispose: undefined, busy: 0, handles: 0, idleTimer: undefined, generation: 0 };
			this.entries.set(alias, entry);
		}
		return entry;
	}

	private async session(entry: IPoolEntry): Promise<IParadisSftpSession> {
		if (entry.session) {
			return entry.session;
		}
		if (!entry.connecting) {
			const generation = entry.generation;
			entry.connecting = paradisConnectSftp(entry.alias, this.options, () => {
				if (entry.generation === generation) {
					this.options.logService.info(`${LOG_PREFIX} closed by peer handles=${entry.handles} busy=${entry.busy}`);
					this.forget(entry);
				}
			}).then(connected => {
				if (entry.generation !== generation) {
					connected.dispose();
					throw new ParadisSftpFailure('other');
				}
				entry.session = connected.session;
				entry.dispose = connected.dispose;
				return connected.session;
			}).finally(() => {
				entry.connecting = undefined;
			});
		}
		return entry.connecting;
	}

	/**
	 * 1 つの操作の間だけ接続を借りる。繋がっていなければ繋ぐ。
	 * 繋げなかったときは、使っていない枠を残さない。
	 */
	async use<T>(alias: string, run: (session: IParadisSftpSession, generation: number) => Promise<T>): Promise<T> {
		const entry = this.entryFor(alias);
		entry.busy++;
		this.clearIdle(entry);
		try {
			const session = await this.session(entry);
			return await run(session, entry.generation);
		} finally {
			entry.busy--;
			if (!entry.session && !entry.connecting && entry.busy === 0 && entry.handles === 0 && this.entries.get(alias) === entry) {
				this.entries.delete(alias);
			} else {
				this.scheduleIdle(entry);
			}
		}
	}

	/** その世代の接続がまだ生きているか（開いたファイルのハンドルが使えるか）。 */
	isCurrent(alias: string, generation: number): boolean {
		const entry = this.entries.get(alias);
		return !!entry?.session && entry.generation === generation;
	}

	/** ファイルを開いた・閉じた（開いている間は閉じない）。 */
	retainHandle(alias: string): IDisposable {
		const entry = this.entryFor(alias);
		entry.handles++;
		this.clearIdle(entry);
		let released = false;
		return toDisposable(() => {
			if (!released) {
				released = true;
				entry.handles = Math.max(0, entry.handles - 1);
				this.scheduleIdle(entry);
			}
		});
	}

	private clearIdle(entry: IPoolEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
	}

	private scheduleIdle(entry: IPoolEntry): void {
		this.clearIdle(entry);
		if (entry.busy > 0 || entry.handles > 0 || !entry.session) {
			return;
		}
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = undefined;
			if (entry.busy === 0 && entry.handles === 0) {
				this.close(entry, 'idle');
			}
		}, this.idleMs);
	}

	private close(entry: IPoolEntry, why: 'idle' | 'dispose'): void {
		if (entry.session) {
			this.options.logService.info(`${LOG_PREFIX} closed ${why}`);
		}
		const dispose = entry.dispose;
		this.forget(entry);
		dispose?.();
	}

	private forget(entry: IPoolEntry): void {
		this.clearIdle(entry);
		entry.generation++;
		entry.session = undefined;
		entry.dispose = undefined;
		if (this.entries.get(entry.alias) === entry && entry.busy === 0 && entry.handles === 0) {
			this.entries.delete(entry.alias);
		}
	}
}
