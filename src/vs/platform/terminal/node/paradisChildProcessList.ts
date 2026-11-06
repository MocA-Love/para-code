/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { ProcessItem } from '../../../base/common/processes.js';
import { listProcesses } from '../../../base/node/ps.js';

/*
 * The child process list that `ChildProcessMonitor` (childProcessMonitor.ts) asks for after a
 * terminal prints output, at most every 5 seconds per terminal.
 *
 * Upstream calls `listProcesses` (ps.ts), which on Linux starts `which ps`, `ps -ax` over the whole
 * machine and `cpuUsage.sh` (with `sed`, `cat` and a one-second `sleep`) every time. An agent TUI
 * redraws all the time, so this runs for every busy terminal and the pty host spends several times
 * its own CPU in those processes. The monitor only reads the direct children of the shell and the
 * command line of a single child, so on Linux we read those from /proc without starting anything.
 * macOS and Windows keep upstream's `listProcesses`, as does Linux when /proc cannot answer.
 */

/** Reads a /proc file as text. Injectable for tests. */
export type ParadisProcReader = (path: string) => Promise<string>;

/** The pty host's view of a pid's children (direct children only; the monitor reads nothing deeper). */
export async function paradisListChildProcesses(rootPid: number, readProc: ParadisProcReader = path => fs.readFile(path, 'utf8'), platform: NodeJS.Platform = process.platform): Promise<ProcessItem> {
	if (platform === 'linux') {
		const item = await paradisLinuxProcessWithChildren(rootPid, readProc);
		if (item !== undefined) {
			return item;
		}
	}
	return listProcesses(rootPid);
}

/** Splits `/proc/<pid>/stat`: the command name may hold spaces and parentheses, so cut at the last `)`. */
export function paradisParseProcStat(stat: string): { readonly comm: string; readonly state: string; readonly ppid: number; readonly startTime: string } | undefined {
	const open = stat.indexOf('(');
	const close = stat.lastIndexOf(')');
	if (open < 0 || close < open) {
		return undefined;
	}
	// Fields after the name: state(3) ppid(4) ... starttime(22)
	const fields = stat.slice(close + 2).split(' ');
	const ppid = Number(fields[1]);
	if (fields.length < 20 || !Number.isInteger(ppid)) {
		return undefined;
	}
	return { comm: stat.slice(open + 1, close), state: fields[0], ppid, startTime: fields[19] };
}

/**
 * The command line as `ps -o command=` shows it: arguments joined with spaces, or `[name]` when the
 * process has no arguments (a zombie or a kernel thread), with ` <defunct>` for a zombie.
 */
export function paradisCommandLineFromProc(cmdline: string, comm: string, state: string): string {
	const args = cmdline.endsWith('\0') ? cmdline.slice(0, -1) : cmdline;
	if (args.length > 0) {
		return args.split('\0').join(' ');
	}
	return state === 'Z' ? `[${comm}] <defunct>` : `[${comm}]`;
}

/** Reads a process's command line from /proc, as `ps -o command=` shows it. Undefined when it is gone. */
export async function paradisReadProcCommandLine(pid: number, readProc: ParadisProcReader): Promise<{ readonly command: string; readonly ppid: number; readonly startTime: string } | undefined> {
	try {
		const [stat, cmdline] = await Promise.all([readProc(`/proc/${pid}/stat`), readProc(`/proc/${pid}/cmdline`)]);
		const parsed = paradisParseProcStat(stat);
		return parsed === undefined ? undefined : { command: paradisCommandLineFromProc(cmdline, parsed.comm, parsed.state), ppid: parsed.ppid, startTime: parsed.startTime };
	} catch {
		return undefined;
	}
}

/**
 * The root and its direct children from /proc. `task/<tid>/children` lists the children each thread
 * started, so the union over the threads is every child of the process. Undefined when /proc cannot
 * answer (no `children` files without CONFIG_PROC_CHILDREN, hidepid): the caller falls back to ps.
 * Throws like `listProcesses` when the root is gone.
 */
async function paradisLinuxProcessWithChildren(rootPid: number, readProc: ParadisProcReader): Promise<ProcessItem | undefined> {
	let tids: string[];
	try {
		tids = await fs.readdir(`/proc/${rootPid}/task`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Root process ${rootPid} not found`);
		}
		return undefined;
	}
	const childPids = new Set<number>();
	try {
		for (const children of await Promise.all(tids.map(tid => readProc(`/proc/${rootPid}/task/${tid}/children`)))) {
			for (const pid of children.split(' ')) {
				if (pid.length > 0) {
					childPids.add(Number(pid));
				}
			}
		}
	} catch {
		return undefined;
	}
	const root = await paradisReadProcCommandLine(rootPid, readProc);
	if (root === undefined) {
		throw new Error(`Root process ${rootPid} not found`);
	}
	const children: ProcessItem[] = [];
	for (const pid of [...childPids].sort((a, b) => a - b)) {
		const child = await paradisReadProcCommandLine(pid, readProc);
		// A child that exited between the two reads is not listed, as ps would not list it
		if (child !== undefined) {
			children.push({ name: child.command, cmd: child.command, pid, ppid: rootPid, load: 0, mem: 0 });
		}
	}
	return {
		name: root.command, cmd: root.command, pid: rootPid, ppid: root.ppid, load: 0, mem: 0,
		...(children.length > 0 ? { children } : {}),
	};
}
