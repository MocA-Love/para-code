/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧ウィジェットのshared processバックエンド(このマシンでリッスン中のポートを答える)。
//
// macOS/Linux: `lsof -iTCP -sTCP:LISTEN -n -P` を`child_process.execFile`で直叩きしてパースする
// (追加バイナリ不要でOS標準に入っているコマンドを使う方式)。
// Windows: lsof相当が無いため `netstat -ano -p TCP` でLISTENING行とPIDを拾い、`tasklist` で
// プロセス名を解決する(ベストエフォート。取れなければPID文字列をそのまま表示する)。
//
// REHサーバー側(SSH接続先)の同種の実装は node/paradisPortListChannelServer.ts にある。lsofが
// 使える保証がないLinux配布のため、そちらは /proc 直読みで実装しておりロジックを共有していない。

import * as cp from 'child_process';
import { isWindows } from '../../../../base/common/platform.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisPortEntry,
	IParadisPortKillBatchResult,
	IParadisPortKillRequest,
	IParadisPortListRequest,
	IParadisPortListSnapshot,
	PARADIS_PORT_LIST_CHANNEL,
	ParadisPortProtocol,
	paradisIsRiskyPortAddress
} from '../common/paradisPortList.js';
import { executeParadisPortKillBatch } from '../common/paradisPortKillBatch.js';

/** 短時間に何度も聞かれたときに、同じ結果を返してよい長さ。 */
const SNAPSHOT_MAX_AGE_MS = 2000;
const COMMAND_TIMEOUT_MS = 10_000;

function normalizeAddress(address: string): string {
	return address.replace(/^\[|\]$/g, '');
}

function execLsof(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile('lsof', args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			// lsof はマッチ0件のとき非ゼロ終了するが、それはエラーではない(空リストとして扱う)。
			// コマンド自体が見つからない場合(ENOENT)だけを本物のエラーとして呼び出し元へ返す。
			if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(error);
				return;
			}
			resolve(stdout ?? '');
		});
	});
}

function execCapture(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout ?? '');
		});
	});
}

/**
 * lsofの出力をパースする。列は `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME` の固定順だが、
 * 中間列(DEVICE等)の幅・有無は環境で揺れるため、先頭3列(COMMAND/PID/USER)と末尾の
 * "PROTO ADDRESS:PORT (LISTEN)" だけを当てにして中間列は読み飛ばす。
 */
export function parseLsofOutput(stdout: string): IParadisPortEntry[] {
	const entries: IParadisPortEntry[] = [];
	const seen = new Set<string>();
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('COMMAND')) {
			continue;
		}
		const tail = line.match(/(TCP|UDP)\s+(.+):(\d+|\*)\s*(?:\(LISTEN\))?$/);
		if (!tail || tail.index === undefined) {
			continue;
		}
		const prefix = line.slice(0, tail.index).trim().split(/\s+/);
		if (prefix.length < 2) {
			continue;
		}
		const portToken = tail[3];
		if (portToken === '*') {
			continue;
		}
		const pid = Number(prefix[1]);
		const port = Number(portToken);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(port)) {
			continue;
		}
		const proto = tail[1] as ParadisPortProtocol;
		const address = normalizeAddress(tail[2]);
		const key = `${proto}:${port}:${pid}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		entries.push({ port, proto, pid, processName: prefix[0], address, risky: paradisIsRiskyPortAddress(address) });
	}
	return entries;
}

/**
 * lsofのCOMMAND列はスペースを含む名前を `\x20` のようにエスケープしたうえ数文字に切り詰めるため
 * (例: 'Para Code Helper' -> 'Para\x20C')、`ps` で得た正しいコマンド名に差し替える。
 */
async function resolveUnixProcessNames(pids: readonly number[]): Promise<Map<number, string>> {
	const names = new Map<number, string>();
	if (pids.length === 0) {
		return names;
	}
	try {
		const stdout = await execCapture('ps', ['-eo', 'pid=,comm=']);
		const wanted = new Set(pids);
		for (const rawLine of stdout.split('\n')) {
			const line = rawLine.trim();
			const spaceIndex = line.indexOf(' ');
			if (spaceIndex < 0) {
				continue;
			}
			const pid = Number(line.slice(0, spaceIndex));
			if (!wanted.has(pid)) {
				continue;
			}
			const comm = line.slice(spaceIndex + 1).trim();
			names.set(pid, comm.split('/').pop() || comm);
		}
	} catch {
		// ベストエフォート。取れなければ呼び出し元がlsofのCOMMAND列にフォールバックする
	}
	return names;
}

async function collectUnixEntries(): Promise<IParadisPortEntry[]> {
	const stdout = await execLsof(['-iTCP', '-sTCP:LISTEN', '-n', '-P']);
	const entries = parseLsofOutput(stdout);
	const names = await resolveUnixProcessNames([...new Set(entries.map(entry => entry.pid))]);
	return entries.map(entry => names.has(entry.pid) ? { ...entry, processName: names.get(entry.pid)! } : entry);
}

async function resolveWindowsProcessNames(pids: readonly number[]): Promise<Map<number, string>> {
	const names = new Map<number, string>();
	if (pids.length === 0) {
		return names;
	}
	try {
		// PIDごとに /FI を積むとAND条件になり意図通り絞れないため、全件取得してから引き当てる。
		const stdout = await execCapture('tasklist', ['/FO', 'CSV', '/NH']);
		const wanted = new Set(pids);
		for (const rawLine of stdout.split('\n')) {
			const line = rawLine.trim();
			if (!line) {
				continue;
			}
			const cols = line.split('","').map(col => col.replace(/^"|"$/g, ''));
			const pid = Number(cols[1]);
			if (wanted.has(pid)) {
				names.set(pid, cols[0]);
			}
		}
	} catch {
		// ベストエフォート。取れなければ呼び出し元がPID文字列にフォールバックする
	}
	return names;
}

/** netstatの'TCP ... LISTENING <pid>'行をパースする(単体テスト用にexport)。 */
export function parseNetstatOutput(stdout: string): { pid: number; port: number; address: string }[] {
	const byPid = new Map<number, { port: number; address: string }[]>();
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line.startsWith('TCP')) {
			continue;
		}
		const cols = line.split(/\s+/);
		if (cols.length < 5 || cols[3] !== 'LISTENING') {
			continue;
		}
		const localAddress = cols[1];
		const pid = Number(cols[4]);
		const lastColon = localAddress.lastIndexOf(':');
		// netstat は PID 0(System Idle Process)や 4(System) の LISTENING 行を返すことがある。
		// 0 は process.kill(0, sig) がプロセスグループ全体へ飛ぶ特殊値(kill() 側でも弾く)、
		// 4 はkillしても意味がなく誤操作の的になるだけの予約PIDなので、どちらも一覧に出さない。
		if (lastColon < 0 || !Number.isSafeInteger(pid) || pid <= 0 || pid === 4) {
			continue;
		}
		const address = normalizeAddress(localAddress.slice(0, lastColon));
		const port = Number(localAddress.slice(lastColon + 1));
		if (!Number.isFinite(port)) {
			continue;
		}
		const list = byPid.get(pid) ?? [];
		list.push({ port, address });
		byPid.set(pid, list);
	}
	return [...byPid.entries()].flatMap(([pid, ports]) => ports.map(({ port, address }) => ({ pid, port, address })));
}

async function collectWindowsEntries(): Promise<IParadisPortEntry[]> {
	const stdout = await execCapture('netstat', ['-ano', '-p', 'TCP']);
	const parsed = parseNetstatOutput(stdout);
	const byPid = new Map<number, { port: number; address: string }[]>();
	for (const { pid, port, address } of parsed) {
		const list = byPid.get(pid) ?? [];
		list.push({ port, address });
		byPid.set(pid, list);
	}
	const names = await resolveWindowsProcessNames([...byPid.keys()]);
	const entries: IParadisPortEntry[] = [];
	for (const [pid, ports] of byPid) {
		const processName = names.get(pid) ?? String(pid);
		for (const { port, address } of ports) {
			entries.push({ port, proto: 'TCP', pid, processName, address, risky: paradisIsRiskyPortAddress(address) });
		}
	}
	return entries;
}

function collectEntries(): Promise<IParadisPortEntry[]> {
	return isWindows ? collectWindowsEntries() : collectUnixEntries();
}

export class ParadisPortListService {

	private cached: IParadisPortListSnapshot | undefined;
	private inflight: Promise<IParadisPortListSnapshot> | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly collect: () => Promise<readonly IParadisPortEntry[]> = collectEntries,
		private readonly signal: (pid: number) => void = pid => process.kill(pid, 'SIGTERM'),
	) { }

	async getSnapshot(request: IParadisPortListRequest): Promise<IParadisPortListSnapshot> {
		if (request.force !== true && this.cached !== undefined && Date.now() - this.cached.collectedAt <= SNAPSHOT_MAX_AGE_MS) {
			return this.cached;
		}
		if (this.inflight !== undefined && request.force !== true) {
			return this.inflight;
		}
		const collection = this.collect()
			.then(entries => {
				const snapshot: IParadisPortListSnapshot = { entries, collectedAt: Date.now() };
				this.cached = snapshot;
				return snapshot;
			})
			.catch(error => {
				this.logService.warn('[paradisPortList] could not list listening ports', error);
				throw error;
			})
			.finally(() => {
				// force指定時は inflight を共有しないため、後発の force 呼び出しが自分より先に
				// 終わって inflight を undefined にしていることがある。自分が入れた promise の
				// ときだけ消す(取り違えて後発の inflight を消すと、その完了を待つ呼び出し元が
				// 誰にも通知されず永遠に待つ)。
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
		// shared process 自身を殺すと、そこにぶら下がる他の全チャネルも道連れになる。
		if (request.pid === process.pid) {
			throw new Error('Refusing to kill the process hosting this port list channel');
		}
		const entries = await this.collect();
		const stillListening = entries.some(entry => entry.pid === request.pid && entry.port === request.port && entry.processName === request.processName);
		if (!stillListening) {
			throw new Error(`Port :${request.port} is no longer held by PID ${request.pid} (it may have already exited)`);
		}
		this.signal(request.pid);
		this.cached = undefined;
	}

	async killAll(requests: readonly unknown[]): Promise<IParadisPortKillBatchResult> {
		try {
			return await executeParadisPortKillBatch(requests, this.collect, new Set([process.pid]), this.signal);
		} finally {
			this.cached = undefined;
		}
	}
}

class ParadisPortListChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisPortListService) { }

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
			case 'killAll':
				return this.service.killAll(Array.isArray(args[0]) ? args[0] : []) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisPortList<TContext>(server: IPCServer<TContext>, logService: ILogService, service = new ParadisPortListService(logService)): IDisposable {
	server.registerChannel(PARADIS_PORT_LIST_CHANNEL, new ParadisPortListChannel<TContext>(service));
	return { dispose: () => { } };
}
