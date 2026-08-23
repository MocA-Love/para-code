/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧ウィジェットのREHサーバーバックエンド(SSH接続先でリッスン中のポートを答える)。
//
// REHはLinux x64のみ配布されるため、lsofの存在を前提にできない(最小構成イメージでは未搭載の
// ことが多い)。よって /proc/net/tcp[6] を直読みし、ソケットinode→PIDの対応は
// `ls -l /proc/[0-9]*/fd/[0-9]* | grep socket:` から、プロセス名は /proc/<pid>/cmdline から得る。
// このソケット発見ロジックは workbench/api/node/extHostTunnelService.ts の
// loadListeningPorts/getSockets とほぼ同じだが、layer違反(workbench/api/node → paradis)を避ける
// ため、ロジックをここへ複製している(パーサー本体は不変)。
//
// 1台のREHサーバーに複数クライアントが繋がりうる(1クライアント前提の設計にしない)。ここでは
// 変化通知イベントを実装せずポーリング専用にすることで、他クライアントの利用状況の
// ブロードキャスト漏洩を避けている。ctxはログにのみ使い、利用者ごとのアクセス制御はしない
// (同一マシン上の全プロセスが対象になる点は/procを直読みする以上避けられない)。

import * as cp from 'child_process';
import * as fs from 'fs';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisPortEntry,
	IParadisPortKillRequest,
	IParadisPortListRequest,
	IParadisPortListSnapshot,
	PARADIS_PORT_LIST_CHANNEL,
	paradisIsRiskyPortAddress
} from '../common/paradisPortList.js';

const SNAPSHOT_MAX_AGE_MS = 2000;
const COMMAND_TIMEOUT_MS = 10_000;

export interface IListeningConnection {
	readonly socket: number;
	readonly ip: string;
	readonly port: number;
}

/** '0100007F' -> '127.0.0.1'、32桁hexのIPv6も展開する(extHostTunnelServiceのparseIpAddressと同じ規則)。 */
export function parseHexAddress(hex: string): string {
	if (hex.length === 8) {
		const bytes: string[] = [];
		for (let i = hex.length - 2; i >= 0; i -= 2) {
			bytes.push(String(parseInt(hex.substr(i, 2), 16)));
		}
		return bytes.join('.');
	}
	let result = '';
	for (let i = 0; i < hex.length; i += 8) {
		const word = hex.substring(i, i + 8);
		let subWord = '';
		for (let j = 8; j >= 2; j -= 2) {
			subWord += word.substring(j - 2, j);
			if (j === 6 || j === 2) {
				subWord = parseInt(subWord, 16).toString(16);
				result += subWord;
				subWord = '';
				if (i + j !== hex.length - 6) {
					result += ':';
				}
			}
		}
	}
	return result;
}

export function loadConnectionTable(stdout: string): Record<string, string>[] {
	const lines = stdout.trim().split('\n');
	if (lines.length === 0 || !lines[0]) {
		return [];
	}
	const names = lines.shift()!.trim().split(/\s+/).filter(name => name !== 'rx_queue' && name !== 'tm->when');
	return lines.map(line => line.trim().split(/\s+/).reduce((obj: Record<string, string>, value, i) => {
		obj[names[i] || i] = value;
		return obj;
	}, {}));
}

export function loadListeningConnections(...stdouts: string[]): IListeningConnection[] {
	const table = ([] as Record<string, string>[]).concat(...stdouts.map(loadConnectionTable));
	return [...new Map(
		table.filter(row => row.st === '0A' && row.local_address && row.inode)
			.map(row => {
				const address = row.local_address.split(':');
				return { socket: parseInt(row.inode, 10), ip: parseHexAddress(address[0]), port: parseInt(address[1], 16) };
			})
			.map(entry => [`${entry.ip}:${entry.port}`, entry] as const)
	).values()];
}

function execCapture(command: string, logService: ILogService): Promise<string> {
	return new Promise(resolve => {
		cp.exec(command, { maxBuffer: 8 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
			// grep がマッチ0件で非ゼロ終了するのは正常(空リスト)。ここで警告したいのは
			// シェルコマンド自体が失敗したケース(ARG_MAX超過等)で、そのときは一覧が黙って
			// 空になり原因が分からなくなるため、握りつぶさずログに残す。
			if (error && !stdout) {
				logService.warn('[paradisPortList] remote host command failed, port list may be incomplete', command, error);
			}
			resolve(stdout ?? '');
		});
	});
}

/** socket inode -> 保有PID。 */
async function readSocketOwners(logService: ILogService): Promise<Map<number, number>> {
	const stdout = await execCapture('ls -l /proc/[0-9]*/fd/[0-9]* 2>/dev/null | grep socket:', logService);
	const owners = new Map<number, number>();
	for (const line of stdout.split('\n')) {
		const match = /\/proc\/(\d+)\/fd\/\d+ -> socket:\[(\d+)\]/.exec(line);
		if (match) {
			owners.set(parseInt(match[2], 10), parseInt(match[1], 10));
		}
	}
	return owners;
}

async function readProcessNames(pids: Iterable<number>): Promise<Map<number, string>> {
	const names = new Map<number, string>();
	await Promise.all([...pids].map(async pid => {
		try {
			const cmdline = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8');
			const first = cmdline.split('\0').find(part => part.length > 0);
			names.set(pid, first ? first.split('/').pop()! : String(pid));
		} catch {
			names.set(pid, String(pid));
		}
	}));
	return names;
}

async function collectEntries(logService: ILogService): Promise<IParadisPortEntry[]> {
	const [tcp, tcp6] = await Promise.all([
		fs.promises.readFile('/proc/net/tcp', 'utf8').catch(() => ''),
		fs.promises.readFile('/proc/net/tcp6', 'utf8').catch(() => '')
	]);
	const listening = loadListeningConnections(tcp, tcp6);
	if (listening.length === 0) {
		return [];
	}
	const owners = await readSocketOwners(logService);
	const resolved: { connection: IListeningConnection; pid: number }[] = [];
	const pids = new Set<number>();
	for (const connection of listening) {
		const pid = owners.get(connection.socket);
		if (pid !== undefined) {
			pids.add(pid);
			resolved.push({ connection, pid });
		}
	}
	const names = await readProcessNames(pids);
	return resolved.map(({ connection, pid }) => ({
		port: connection.port,
		proto: 'TCP' as const,
		pid,
		processName: names.get(pid) ?? String(pid),
		address: connection.ip,
		risky: paradisIsRiskyPortAddress(connection.ip)
	}));
}

export class ParadisPortListServerService {

	private cached: IParadisPortListSnapshot | undefined;
	private inflight: Promise<IParadisPortListSnapshot> | undefined;

	constructor(private readonly logService: ILogService) { }

	async getSnapshot(request: IParadisPortListRequest): Promise<IParadisPortListSnapshot> {
		if (request.force !== true && this.cached !== undefined && Date.now() - this.cached.collectedAt <= SNAPSHOT_MAX_AGE_MS) {
			return this.cached;
		}
		if (this.inflight !== undefined && request.force !== true) {
			return this.inflight;
		}
		const collection = collectEntries(this.logService)
			.then(entries => {
				const snapshot: IParadisPortListSnapshot = { entries, collectedAt: Date.now() };
				this.cached = snapshot;
				return snapshot;
			})
			.catch(error => {
				this.logService.warn('[paradisPortList] could not list listening ports on the remote host', error);
				throw error;
			})
			.finally(() => {
				// force指定時は inflight を共有しないため、後発の force 呼び出しが自分より先に
				// 終わって inflight を undefined にしていることがある。自分が入れた promise の
				// ときだけ消す。
				if (this.inflight === collection) {
					this.inflight = undefined;
				}
			});
		this.inflight = collection;
		return collection;
	}

	async kill(request: IParadisPortKillRequest): Promise<void> {
		// PID 0 は自プロセスグループ全体、負値はより広い対象へシグナルが飛ぶ(POSIX kill(2))。
		// IPC 越しの値は型を素通りするキャストでしかないため、実行前に必ず値域を検証する。
		if (!Number.isSafeInteger(request.pid) || request.pid <= 0 || !Number.isSafeInteger(request.port) || request.port <= 0) {
			throw new Error(`Refusing to kill: invalid target (pid ${request.pid}, port ${request.port})`);
		}
		// REHサーバー自身(またはその起動元)を殺すと、接続中の全クライアントを巻き込んで
		// 落とすことになる。
		if (request.pid === process.pid || request.pid === process.ppid) {
			throw new Error('Refusing to kill the remote server process itself');
		}
		const entries = await collectEntries(this.logService);
		const stillListening = entries.some(entry => entry.pid === request.pid && entry.port === request.port && entry.processName === request.processName);
		if (!stillListening) {
			throw new Error(`Port :${request.port} is no longer held by PID ${request.pid} on the remote host (it may have already exited)`);
		}
		process.kill(request.pid, 'SIGTERM');
		this.cached = undefined;
	}
}

class ParadisPortListServerChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisPortListServerService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot':
				return this.service.getSnapshot((args[0] ?? {}) as IParadisPortListRequest) as Promise<T>;
			case 'kill':
				return this.service.kill(args[0] as IParadisPortKillRequest) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** serverServices.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisPortListForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	server.registerChannel(PARADIS_PORT_LIST_CHANNEL, new ParadisPortListServerChannel<TContext>(new ParadisPortListServerService(logService)));
	return { dispose: () => { } };
}
