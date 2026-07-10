/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// プロセスツリーのスナップショット取得(Superset apps/desktop の
// src/main/lib/resource-metrics/process-tree.ts 移植)。macOS/Linuxでは `ps -eo`、Windowsでは
// Win32_PerfFormattedData_PerfProc_Process を1回取得し、
// PID/親PID/CPU%/RSS を同一時点のスナップショットとして取得することで、
// 「子孫の列挙」と「使用率の読み取り」の間の競合(別々にプロセス一覧を取る場合に起き得る)を避ける。

import { exec, execFile } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);
const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface IParadisProcessInfo {
	readonly pid: number;
	readonly ppid: number;
	/** CPU使用率(%)。マルチコアでは100を超え得る。 */
	readonly cpu: number;
	/** 常駐メモリ(バイト)。 */
	readonly memory: number;
}

export interface IParadisProcessSnapshot {
	/** PIDをキーにしたプロセス情報。 */
	readonly byPid: Map<number, IParadisProcessInfo>;
	/** 親PIDをキーにした子PID一覧。 */
	readonly childrenOf: Map<number, number[]>;
}

export interface IParadisSubtreeResources {
	readonly cpu: number;
	readonly memory: number;
}

/**
 * 実行中の全プロセスをアトミックにスナップショットする。
 * macOS/Linuxでは `ps -eo pid=,ppid=,pcpu=,rss=` を1回実行するだけで
 * ツリー構造とリソース値を同一時点から得る。
 */
export async function captureParadisProcessSnapshot(): Promise<IParadisProcessSnapshot> {
	const raw = platform() === 'win32' ? await listWindowsProcesses() : await listUnixProcesses();

	const byPid = new Map<number, IParadisProcessInfo>();
	const childrenOf = new Map<number, number[]>();

	for (const info of raw) {
		byPid.set(info.pid, info);
		let children = childrenOf.get(info.ppid);
		if (!children) {
			children = [];
			childrenOf.set(info.ppid, children);
		}
		children.push(info.pid);
	}

	return { byPid, childrenOf };
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
	'$ErrorActionPreference = \'Stop\'',
	'@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |',
	'Where-Object { [int64]$_.IDProcess -gt 0 } |',
	'ForEach-Object { [PSCustomObject]@{ pid = [int64]$_.IDProcess; ppid = [int64]$_.CreatingProcessID; cpu = [double]$_.PercentProcessorTime; memory = [int64]$_.WorkingSet } }) |',
	'ConvertTo-Json -Compress',
].join(' ');

function listWindowsProcesses(): Promise<IParadisProcessInfo[]> {
	return new Promise(resolve => {
		execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT], {
			encoding: 'utf8',
			maxBuffer: MAX_BUFFER,
			timeout: EXEC_TIMEOUT_MS,
			windowsHide: true,
		}, (error, stdout) => {
			if (error) {
				resolve([]);
				return;
			}
			try {
				const parsed: unknown = JSON.parse(stdout || '[]');
				const entries = Array.isArray(parsed) ? parsed : [parsed];
				const result: IParadisProcessInfo[] = [];
				for (const entry of entries) {
					if (!entry || typeof entry !== 'object') {
						continue;
					}
					const record = entry as Record<string, unknown>;
					const pid = Number(record.pid);
					const ppid = Number(record.ppid);
					if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
						continue;
					}
					const cpu = Number(record.cpu);
					const memory = Number(record.memory);
					result.push({
						pid,
						ppid,
						cpu: Number.isFinite(cpu) ? Math.max(0, cpu) : 0,
						memory: Number.isFinite(memory) ? Math.max(0, memory) : 0,
					});
				}
				resolve(result);
			} catch {
				resolve([]);
			}
		});
	});
}

/**
 * `rootPid` を根とするプロセスサブツリー(自身を含む)のPIDを全て返す。
 * スナップショットに存在しないPIDは無視する。
 */
export function getParadisSubtreePids(snapshot: IParadisProcessSnapshot, rootPid: number): number[] {
	const pids: number[] = [];
	const stack = [rootPid];
	const visited = new Set<number>();

	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || visited.has(pid)) {
			continue;
		}
		visited.add(pid);

		if (snapshot.byPid.has(pid)) {
			pids.push(pid);
		}
		const children = snapshot.childrenOf.get(pid);
		if (children) {
			stack.push(...children);
		}
	}

	return pids;
}

/**
 * `rootPid` を根とするプロセスサブツリー全体のCPU/メモリを合算する。
 */
export function getParadisSubtreeResources(snapshot: IParadisProcessSnapshot, rootPid: number): IParadisSubtreeResources {
	let cpu = 0;
	let memory = 0;

	for (const pid of getParadisSubtreePids(snapshot, rootPid)) {
		const info = snapshot.byPid.get(pid);
		if (info) {
			cpu += info.cpu;
			memory += info.memory;
		}
	}

	return { cpu, memory };
}

async function listUnixProcesses(): Promise<IParadisProcessInfo[]> {
	try {
		// 1回の呼び出しで PID・親PID・CPU%・RSS(KB) をまとめて取得する。
		const { stdout } = await execAsync('ps -eo pid=,ppid=,pcpu=,rss=', {
			maxBuffer: MAX_BUFFER,
			timeout: EXEC_TIMEOUT_MS,
		});

		const result: IParadisProcessInfo[] = [];
		for (const line of stdout.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			const parts = trimmed.split(/\s+/);
			if (parts.length < 4) {
				continue;
			}

			const pid = Number.parseInt(parts[0], 10);
			const ppid = Number.parseInt(parts[1], 10);
			if (Number.isNaN(pid) || Number.isNaN(ppid)) {
				continue;
			}

			const cpu = Number.parseFloat(parts[2]);
			const rssKb = Number.parseInt(parts[3], 10);

			result.push({
				pid,
				ppid,
				cpu: Number.isFinite(cpu) ? Math.max(0, cpu) : 0,
				memory: Number.isFinite(rssKb) ? Math.max(0, rssKb) * 1024 : 0,
			});
		}

		return result;
	} catch {
		return [];
	}
}
