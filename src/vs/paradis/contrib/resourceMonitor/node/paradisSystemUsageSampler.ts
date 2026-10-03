/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率の累計値を OS から 1 回読む（node レイヤー。shared process と REH サーバーの両方で動く）。
// 文字列を数に直すのは `common/paradisSystemUsageParsers.ts`。
//
// 誰も見ていなくても 5 秒ごとに読み続けるので、1 回を軽くしている:
//  - Linux はファイル 4 つを読むだけ（プロセスは起こさない）
//  - macOS は `/bin/sh -c` を 1 回だけ起こし、4 つのコマンドを続けて実行する。sh は自分のプロセスグループで
//    起こし、打ち切るときはグループごと殺す（sh だけを殺すと ioreg などの子が孤児になって残る）。
//    グループが消えるまで次は起こさない
//  - statfs は前回が返っていなければ呼ばず、前回の値を使う（返らない statfs を積み上げない）
//  - Windows は node の API だけ（CPU・メモリ・ディスク使用率）。ほかは「取得できません」

import { ChildProcess, spawn } from 'child_process';
import { readFile, statfs } from 'fs/promises';
import { cpus, freemem, homedir, totalmem } from 'os';
import { parse as parsePath } from '../../../../base/common/path.js';
import { ParadisSystemUsageMetric } from '../common/paradisSystemUsage.js';
import {
	IParadisSystemUsageCounters,
	PARADIS_DARWIN_SYSTEM_USAGE_SCRIPT,
	paradisParseIoregDiskStats,
	paradisParseNetstatIbn,
	paradisParseProcDiskstats,
	paradisParseProcMeminfo,
	paradisParseProcNetDev,
	paradisParseProcStat,
	paradisParseSwapUsage,
	paradisParseVmStat,
	paradisSplitDarwinSystemUsageOutput,
} from '../common/paradisSystemUsageParsers.js';

/** macOS のスクリプトの打ち切り時間。刻み（5 秒）より短くして、次の回と重ならないようにする。 */
const DARWIN_SCRIPT_TIMEOUT_MS = 4_000;
/** スクリプトの出力の上限。ioreg のディスクが多くても数十 KB に収まる。 */
const DARWIN_SCRIPT_MAX_BUFFER = 1024 * 1024;
/** statfs の打ち切り時間（切断済みのネットワークマウント等で返らないことがある）。 */
const STATFS_TIMEOUT_MS = 1_000;

export interface IParadisSystemUsageReader {
	readonly platform: string;
	/** ディスク使用率を測るボリューム。 */
	readonly diskPath: string;
	/** この OS では取れない項目。 */
	readonly unsupported: readonly ParadisSystemUsageMetric[];
	read(now: number): Promise<IParadisSystemUsageCounters>;
	/** 実行中の外部コマンドを止める。 */
	dispose?(): void;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
		]);
	} catch {
		return undefined;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

type ParadisDiskUsage = { diskUsed?: number; diskTotal?: number };

function diskUsageOf(stats: { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }): ParadisDiskUsage {
	const blockSize = Number(stats.bsize);
	const blocks = Number(stats.blocks);
	const free = Number(stats.bfree);
	const available = Number(stats.bavail);
	if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || blockSize <= 0 || blocks <= 0) {
		return {};
	}
	// df と同じ定義: 使用中 / (使用中 + 一般ユーザーが使える空き)。root の予約ぶんは分母から外す。
	const used = Math.max(0, blocks - (Number.isFinite(free) ? free : 0)) * blockSize;
	const usable = used + Math.max(0, Number.isFinite(available) ? available : 0) * blockSize;
	return { diskUsed: used, diskTotal: usable > 0 ? usable : blocks * blockSize };
}

/**
 * ディスク使用率を読む。前回の statfs がまだ返っていなければ（打ち切った後も裏で返っていない）新しく呼ばず、
 * 前回の値を返す。返らない statfs を 5 秒ごとに積み上げると libuv のスレッドを全部掴んでしまう。
 */
export class ParadisDiskUsageReader {

	private inflight: Promise<unknown> | undefined;
	private last: ParadisDiskUsage = {};

	constructor(
		private readonly path: string,
		private readonly read: (path: string) => Promise<{ bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }> = statfs,
		private readonly timeoutMs = STATFS_TIMEOUT_MS,
	) { }

	async readUsage(): Promise<ParadisDiskUsage> {
		if (this.inflight !== undefined) {
			return this.last;
		}
		const outcome = this.read(this.path).then(stats => ({ stats }), () => ({ stats: undefined }));
		const settled = outcome.finally(() => {
			if (this.inflight === settled) {
				this.inflight = undefined;
			}
		});
		this.inflight = settled;
		const result = await withTimeout(outcome, this.timeoutMs);
		if (result === undefined) {
			// 時間内に返らなかった。返るまでは前回の値を使い続ける
			return this.last;
		}
		// 返ってきた（次はすぐ呼んでよい）
		if (this.inflight === settled) {
			this.inflight = undefined;
		}
		// 例外で返った（ボリュームが外れた等）なら前回の値は捨てる。古い使用率を出し続けない
		this.last = result.stats !== undefined ? diskUsageOf(result.stats) : {};
		return this.last;
	}
}

/** 1 回の外部コマンドの実行。 */
export interface IParadisShellRun {
	/** sh のプロセス ID（＝プロセスグループの ID）。起こせなかったときは undefined。 */
	readonly pid: number | undefined;
	/** 終わった（打ち切った場合はグループが消えた、または待ちきれなかった）ときに解決する。 */
	readonly result: Promise<{ readonly stdout: string; readonly timedOut: boolean }>;
	/** グループごと止める。 */
	kill(): void;
}

/** そのプロセスグループにまだプロセスが居るか。 */
export function paradisIsProcessGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		// EPERM は「居るが合図を送れない」。居るとみなす
		return (error as { code?: string }).code === 'EPERM';
	}
}

/**
 * 記録しておいたグループがまだ居るか。こちらは `EPERM` を「居ない」とみなす: 自分が起こしたグループに合図を
 * 送れないのは、そのグループ ID が別のユーザーのプロセスに使い回されたときなので、もう待つ相手ではない。
 */
export function paradisIsRecordedProcessGroupAlive(pgid: number, kill: (pid: number, signal: number) => unknown = (pid, signal) => process.kill(pid, signal)): boolean {
	try {
		kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

/** グループが消えるまで待つ（上限つき）。消えたら true。 */
async function waitForProcessGroupExit(pgid: number, limitMs: number): Promise<boolean> {
	const deadline = Date.now() + limitMs;
	while (paradisIsProcessGroupAlive(pgid)) {
		if (Date.now() >= deadline) {
			return false;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	return true;
}

/** 打ち切った後、グループが消えるのを待つ上限。これを過ぎても消えなければ、次の測定の前にもう一度確かめる。 */
const PROCESS_GROUP_EXIT_WAIT_MS = 2_000;

/**
 * `/bin/sh -c` を自分のプロセスグループ（`detached`）で起こす。時間切れ・出力の上限超え・{@link IParadisShellRun.kill}
 * では `process.kill(-pid, 'SIGKILL')` でグループごと殺し、グループが消えるまで待ってから解決する。
 * sh だけを殺すと、実行中だった子（ioreg など）が孤児になって残り続ける。
 */
export function paradisRunShellInProcessGroup(script: string, options: { readonly timeoutMs: number; readonly maxBuffer: number; readonly env?: NodeJS.ProcessEnv }): IParadisShellRun {
	let child: ChildProcess;
	try {
		child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: options.env, windowsHide: true });
	} catch {
		return { pid: undefined, result: Promise.resolve({ stdout: '', timedOut: false }), kill: () => { } };
	}
	const pid = child.pid;
	const chunks: Buffer[] = [];
	let size = 0;
	let timedOut = false;
	const killGroup = () => {
		if (pid === undefined) {
			return;
		}
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			// もう居ない（グループができる前なら、下の sh 本体への合図で止める）
		}
		child.kill('SIGKILL');
	};
	child.stdout?.on('data', (chunk: Buffer) => {
		size += chunk.length;
		if (size > options.maxBuffer) {
			killGroup();
			return;
		}
		chunks.push(chunk);
	});
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, options.timeoutMs);
	const result = new Promise<{ readonly stdout: string; readonly timedOut: boolean }>(resolve => {
		let settled = false;
		const finish = async () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (pid !== undefined && paradisIsProcessGroupAlive(pid)) {
				// sh が終わっても子が残っていることがある（打ち切った・sh が先に落ちた）。残りもまとめて止める
				killGroup();
				await waitForProcessGroupExit(pid, PROCESS_GROUP_EXIT_WAIT_MS);
			}
			resolve({ stdout: Buffer.concat(chunks).toString('utf8'), timedOut });
		};
		child.once('close', () => void finish());
		child.once('error', () => void finish());
	});
	return { pid, result, kill: killGroup };
}

/** `os.cpus()` の累計（macOS・Windows 用。Linux は iowait・steal を捨てるので使わない）。 */
function readNodeCpu(): { busy: number; total: number } | undefined {
	let busy = 0;
	let idle = 0;
	for (const cpu of cpus()) {
		busy += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
		idle += cpu.times.idle;
	}
	return busy + idle > 0 ? { busy, total: busy + idle } : undefined;
}

class ParadisLinuxSystemUsageReader implements IParadisSystemUsageReader {

	readonly platform = 'linux';
	readonly diskPath = '/';
	readonly unsupported: readonly ParadisSystemUsageMetric[] = [];
	private readonly disk = new ParadisDiskUsageReader(this.diskPath);

	async read(now: number): Promise<IParadisSystemUsageCounters> {
		const read = (path: string) => readFile(path, 'utf8').catch(() => '');
		const [stat, meminfo, diskstats, netDev, disk] = await Promise.all([
			read('/proc/stat'),
			read('/proc/meminfo'),
			read('/proc/diskstats'),
			read('/proc/net/dev'),
			this.disk.readUsage(),
		]);
		const memory = paradisParseProcMeminfo(meminfo);
		const io = paradisParseProcDiskstats(diskstats);
		const net = paradisParseProcNetDev(netDev);
		return {
			at: now,
			cpu: paradisParseProcStat(stat),
			...memory,
			...(io !== undefined ? { diskReadBytes: io.readBytes, diskWriteBytes: io.writeBytes } : {}),
			...(net !== undefined ? { netRxBytes: net.rxBytes, netTxBytes: net.txBytes } : {}),
			...disk,
		};
	}
}

/** 記録したグループがこれより長く残っていたら、もう 1 本だけ起こし直してみる。 */
const LINGERING_GROUP_RETRY_MS = 5 * 60_000;
/** 消えないまま記録しておくグループの上限（最初の 1 本と、起こし直した 1 本）。超えたらもう起こさない。 */
const LINGERING_GROUP_LIMIT = 2;

export interface IParadisDarwinSystemUsageReaderOptions {
	/** 外部コマンドが止まり始めたことを 1 回だけ知らせる。 */
	readonly onError?: (error: unknown) => void;
	readonly runShell?: typeof paradisRunShellInProcessGroup;
	readonly isRecordedGroupAlive?: (pgid: number) => boolean;
	readonly killGroup?: (pgid: number) => void;
	readonly now?: () => number;
	readonly diskReader?: ParadisDiskUsageReader;
	readonly memory?: () => { readonly total: number; readonly free: number };
}

function killProcessGroup(pgid: number): void {
	try {
		process.kill(-pgid, 'SIGKILL');
	} catch {
		// もう居ない
	}
}

export class ParadisDarwinSystemUsageReader implements IParadisSystemUsageReader {

	readonly platform = 'darwin';
	/** macOS の `/` は読み取り専用のシステムボリュームで使用率がほぼ動かないので、データボリュームを見る。 */
	readonly diskPath = '/System/Volumes/Data';
	readonly unsupported: readonly ParadisSystemUsageMetric[] = [];
	private readonly disk: ParadisDiskUsageReader;
	private readonly runShell: typeof paradisRunShellInProcessGroup;
	private readonly isRecordedGroupAlive: (pgid: number) => boolean;
	private readonly killGroup: (pgid: number) => void;
	private readonly now: () => number;
	private readonly memory: () => { readonly total: number; readonly free: number };
	private readonly onError: (error: unknown) => void;
	private current: IParadisShellRun | undefined;
	/**
	 * 打ち切ったのに消えきらなかったグループ（SIGKILL でも消えない D 状態など）と、記録した時刻。
	 * 残っている間は次のスクリプトを起こさない。5 分を超えたら、上限の内で 1 本だけ起こし直す。
	 */
	private lingering: { readonly pgid: number; readonly since: number }[] = [];
	private stallReported = false;
	private disposed = false;

	constructor(options: IParadisDarwinSystemUsageReaderOptions = {}) {
		this.disk = options.diskReader ?? new ParadisDiskUsageReader(this.diskPath);
		this.runShell = options.runShell ?? paradisRunShellInProcessGroup;
		this.isRecordedGroupAlive = options.isRecordedGroupAlive ?? paradisIsRecordedProcessGroupAlive;
		this.killGroup = options.killGroup ?? killProcessGroup;
		this.now = options.now ?? (() => Date.now());
		this.memory = options.memory ?? (() => ({ total: totalmem(), free: freemem() }));
		this.onError = options.onError ?? (() => { });
	}

	async read(now: number): Promise<IParadisSystemUsageCounters> {
		const [output, disk] = await Promise.all([
			this.runScript(),
			this.disk.readUsage(),
		]);
		const sections = paradisSplitDarwinSystemUsageOutput(output);
		const vmStatUsed = paradisParseVmStat(sections.vmStat);
		const net = paradisParseNetstatIbn(sections.netstat);
		const io = paradisParseIoregDiskStats(sections.ioreg);
		const swap = paradisParseSwapUsage(sections.swap);
		const { total: memTotal, free } = this.memory();
		// スクリプトが動かなかった回（止まっている等）も、RAM だけは node の値で出し続ける
		// （定義は active + wired + compressed より高めに出るが、何も出ないよりよい）
		const memUsed = vmStatUsed !== undefined ? Math.min(memTotal, vmStatUsed) : Math.max(0, memTotal - free);
		return {
			at: now,
			cpu: readNodeCpu(),
			memTotal,
			memUsed,
			...(swap ?? {}),
			...(io !== undefined ? { diskReadBytes: io.readBytes, diskWriteBytes: io.writeBytes } : {}),
			...(net !== undefined ? { netRxBytes: net.rxBytes, netTxBytes: net.txBytes } : {}),
			...disk,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.current?.kill();
	}

	/** 次のスクリプトを起こしてよいか。残っているグループを確かめ、消えたものは記録から外す。 */
	private mayStart(): boolean {
		this.lingering = this.lingering.filter(group => this.isRecordedGroupAlive(group.pgid));
		if (this.lingering.length === 0) {
			this.stallReported = false;
			return true;
		}
		for (const group of this.lingering) {
			this.killGroup(group.pgid);
		}
		if (!this.stallReported) {
			this.stallReported = true;
			this.onError(new Error(`system usage commands are stuck (process group ${this.lingering.map(group => group.pgid).join(', ')} survived SIGKILL); disk I/O, network and swap are paused`));
		}
		const newest = this.lingering[this.lingering.length - 1];
		return this.lingering.length < LINGERING_GROUP_LIMIT && this.now() - newest.since > LINGERING_GROUP_RETRY_MS;
	}

	/** 失敗しても途中までの出力を返す（1 つのコマンドが失敗しても残りの項目は出す）。 */
	private async runScript(): Promise<string> {
		// 同時に起こすのは 1 本まで
		if (this.disposed || this.current !== undefined || !this.mayStart()) {
			return '';
		}
		const run = this.runShell(PARADIS_DARWIN_SYSTEM_USAGE_SCRIPT, {
			timeoutMs: DARWIN_SCRIPT_TIMEOUT_MS,
			maxBuffer: DARWIN_SCRIPT_MAX_BUFFER,
			// ロケールで数の書き方が変わらないようにする
			env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
		});
		this.current = run;
		try {
			const { stdout } = await run.result;
			if (run.pid !== undefined && this.isRecordedGroupAlive(run.pid)) {
				this.lingering.push({ pgid: run.pid, since: this.now() });
			}
			return stdout;
		} finally {
			this.current = undefined;
		}
	}
}

class ParadisNodeOnlySystemUsageReader implements IParadisSystemUsageReader {

	readonly diskPath: string;
	readonly unsupported: readonly ParadisSystemUsageMetric[] = ['diskIo', 'network', 'swap'];

	private readonly disk: ParadisDiskUsageReader;

	constructor(readonly platform: string) {
		this.diskPath = parsePath(homedir()).root || homedir();
		this.disk = new ParadisDiskUsageReader(this.diskPath);
	}

	async read(now: number): Promise<IParadisSystemUsageCounters> {
		const memTotal = totalmem();
		return {
			at: now,
			cpu: readNodeCpu(),
			memTotal,
			memUsed: Math.max(0, memTotal - freemem()),
			...(await this.disk.readUsage()),
		};
	}
}

export function paradisCreateSystemUsageReader(platform: string = process.platform, options: { readonly onError?: (error: unknown) => void } = {}): IParadisSystemUsageReader {
	switch (platform) {
		case 'linux': return new ParadisLinuxSystemUsageReader();
		case 'darwin': return new ParadisDarwinSystemUsageReader({ onError: options.onError });
		default: return new ParadisNodeOnlySystemUsageReader(platform);
	}
}
