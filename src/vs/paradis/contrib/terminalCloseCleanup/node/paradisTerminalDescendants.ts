/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルを閉じたときに裏へ残ったプロセスを止める、実行の側（W2-32）。判断は common 側にある。
//
// 流れ: シェルを終わらせる前に `ps` で表を撮る → 本来の終了 → シェルの終了から 2 秒待つ →
// 撮り直して同じプロセスだけを残す → SIGHUP を無視しているかを調べ、無視していないものに
// SIGTERM → さらに 2 秒 → まだ同じプロセスで生きていれば SIGKILL。
//
// SIGHUP を無視しているかは、Linux は `/proc/<pid>/status` の `SigIgn`、macOS は `ps` に該当する
// 列が無いので `sysctl` の `kinfo_proc.kp_proc.p_sigignore`（`osascript` の JavaScript から
// 呼ぶ）で読む。**読めなければ残す。** 失敗の側はいつも「何もしない」（今までと同じ動き）。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { raceTimeout, timeout } from '../../../../base/common/async.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisProcessRow,
	paradisCollectShellDescendants,
	paradisParseDarwinHangupProbe,
	paradisParseLinuxHangupIgnored,
	paradisParsePsRows,
	paradisPlanHangupSurvivors,
	paradisStillRunning,
	paradisSummarizeCommands,
	PARADIS_CLOSE_CLEANUP_EXIT_WAIT_MS,
	PARADIS_CLOSE_CLEANUP_GRACE_MS,
	PARADIS_CLOSE_CLEANUP_KILL_GRACE_MS,
	PARADIS_CLOSE_CLEANUP_PS_TIMEOUT_MS,
	PARADIS_PS_COLUMNS,
} from '../common/paradisTerminalCloseCleanup.js';

/** 表 1 枚。 */
export interface IParadisProcessSnapshot {
	readonly rows: readonly IParadisProcessRow[];
	/** 撮り始めた時刻（epoch 秒、切り捨て）。これ以降に生まれたものは対象にしない。 */
	readonly bornBefore: number;
}

/** 外の世界との接点。テストでは差し替える。 */
export interface IParadisDescendantStopDeps {
	/** 全プロセスの表を撮る。撮れなければ undefined。 */
	snapshot(): Promise<IParadisProcessSnapshot | undefined>;
	/** 指定した pid の今の行を撮る。撮れなければ undefined（生きているものが無いだけなら空）。 */
	lookup(pids: readonly number[]): Promise<readonly IParadisProcessRow[] | undefined>;
	/** SIGHUP を無視しているか。分からないものは undefined。 */
	probeHangupIgnored(rows: readonly IParadisProcessRow[]): Promise<ReadonlyMap<number, boolean | undefined>>;
	kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
	delay(ms: number): Promise<void>;
	readonly log: Pick<ILogService, 'info' | 'warn' | 'trace'>;
}

export interface IParadisDescendantStopReport {
	readonly terminated: readonly IParadisProcessRow[];
	readonly killed: readonly IParadisProcessRow[];
	readonly kept: readonly IParadisProcessRow[];
}

const LOG_PREFIX = '[paradisTerminalCloseCleanup]';

/** シェルの子孫を撮る。失敗したら空（何もしない）。 */
export async function paradisCaptureShellDescendants(shellPid: number, deps: Pick<IParadisDescendantStopDeps, 'snapshot' | 'log'>): Promise<readonly IParadisProcessRow[]> {
	if (!(shellPid > 1)) {
		return [];
	}
	const snapshot = await deps.snapshot();
	if (!snapshot) {
		deps.log.trace(`${LOG_PREFIX} could not list processes; leaving background processes alone`);
		return [];
	}
	return paradisCollectShellDescendants(snapshot.rows, shellPid, snapshot.bornBefore, new Set([process.pid, process.ppid]));
}

/**
 * 撮っておいた子孫のうち、シェルが終わった後も残っているものを止める。
 * `exited` はシェルの終了。来なくても上限で進む。
 */
export async function paradisStopCapturedDescendants(captured: readonly IParadisProcessRow[], exited: Promise<unknown>, deps: IParadisDescendantStopDeps): Promise<IParadisDescendantStopReport> {
	const nothing: IParadisDescendantStopReport = { terminated: [], killed: [], kept: [] };
	if (captured.length === 0) {
		return nothing;
	}
	await raceTimeout(exited.then(() => undefined, () => undefined), PARADIS_CLOSE_CLEANUP_EXIT_WAIT_MS);
	await deps.delay(PARADIS_CLOSE_CLEANUP_GRACE_MS);

	const firstLook = await deps.lookup(captured.map(row => row.pid));
	if (!firstLook) {
		return nothing;
	}
	const survivors = paradisStillRunning(captured, firstLook);
	if (survivors.length === 0) {
		return nothing;
	}
	const ignored = await deps.probeHangupIgnored(survivors);
	const plan = paradisPlanHangupSurvivors(captured, survivors, ignored);
	for (const row of plan.stop) {
		deps.kill(row.pid, 'SIGTERM');
	}

	let killed: IParadisProcessRow[] = [];
	if (plan.stop.length > 0) {
		await deps.delay(PARADIS_CLOSE_CLEANUP_KILL_GRACE_MS);
		const secondLook = await deps.lookup(plan.stop.map(row => row.pid));
		killed = secondLook ? paradisStillRunning(plan.stop, secondLook) : [];
		for (const row of killed) {
			deps.kill(row.pid, 'SIGKILL');
		}
	}

	const report: IParadisDescendantStopReport = { terminated: plan.stop, killed, kept: plan.keep };
	// 名前と数だけを書く。引数は秘密値を含みうるので持っていない。
	if (report.terminated.length > 0) {
		deps.log.info(`${LOG_PREFIX} stopped ${report.terminated.length} background process(es) left by a closed terminal: ${paradisSummarizeCommands(report.terminated)}${killed.length > 0 ? `; ${killed.length} needed SIGKILL (${paradisSummarizeCommands(killed)})` : ''}${report.kept.length > 0 ? `; kept ${report.kept.length} that ignore hangup` : ''}`);
	} else if (report.kept.length > 0) {
		deps.log.info(`${LOG_PREFIX} kept ${report.kept.length} background process(es) that ignore hangup: ${paradisSummarizeCommands(report.kept)}`);
	}
	return report;
}

/**
 * 本来の終了（`shutdown`）を、撮る処理と止める処理で挟む。`shutdown` は必ず呼ぶ。
 * 止める処理はシェルの終了を待ってから裏で走るので、呼び出し側は待たない。
 */
export function paradisShutdownStoppingDescendants(shellPid: number, shutdown: () => void, exited: Promise<unknown>, logService: ILogService, deps: IParadisDescendantStopDeps = paradisDescendantStopDeps(logService)): void {
	void (async () => {
		let captured: readonly IParadisProcessRow[] = [];
		try {
			captured = await paradisCaptureShellDescendants(shellPid, deps);
		} catch (error) {
			logService.trace(`${LOG_PREFIX} capture failed`, error);
		} finally {
			shutdown();
		}
		if (captured.length === 0) {
			return;
		}
		try {
			await paradisStopCapturedDescendants(captured, exited, deps);
		} catch (error) {
			logService.warn(`${LOG_PREFIX} could not stop background processes`, error);
		}
	})();
}

function runPs(args: readonly string[]): Promise<{ stdout: string; code: number | undefined } | undefined> {
	return new Promise(resolve => {
		execFile('ps', [...args], {
			timeout: PARADIS_CLOSE_CLEANUP_PS_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
		}, (error, stdout) => {
			if (!error) {
				resolve({ stdout, code: 0 });
				return;
			}
			// 打ち切り・起動失敗は「撮れなかった」。終了コードだけのもの（`-p` に生きている pid が
			// 無いと 1 で終わる）は、出力をそのまま使う。
			const code = (error as { code?: unknown }).code;
			resolve(typeof code === 'number' && !(error as { killed?: boolean }).killed ? { stdout, code } : undefined);
		});
	});
}

/**
 * 進行中の表の撮影。同時に閉じたターミナルが続けて撮らないよう、撮っている最中なら相乗りする。
 * 撮り終えた表は再利用しない（その後に生まれたものを見落とすため）。
 */
let inFlightSnapshot: Promise<IParadisProcessSnapshot | undefined> | undefined;

async function takeSnapshot(): Promise<IParadisProcessSnapshot | undefined> {
	const bornBefore = Math.floor(Date.now() / 1000);
	const result = await runPs(['-A', '-o', PARADIS_PS_COLUMNS]);
	if (!result || result.code !== 0) {
		return undefined;
	}
	return { rows: paradisParsePsRows(result.stdout), bornBefore };
}

function snapshot(): Promise<IParadisProcessSnapshot | undefined> {
	if (!inFlightSnapshot) {
		inFlightSnapshot = takeSnapshot().finally(() => {
			inFlightSnapshot = undefined;
		});
	}
	return inFlightSnapshot;
}

async function lookup(pids: readonly number[]): Promise<readonly IParadisProcessRow[] | undefined> {
	if (pids.length === 0) {
		return [];
	}
	const result = await runPs(['-o', PARADIS_PS_COLUMNS, '-p', pids.join(',')]);
	return result ? paradisParsePsRows(result.stdout) : undefined;
}

/**
 * macOS で SIGHUP を無視しているかを読む調べ役。`osascript` の JavaScript から `sysctl` を呼び、
 * `struct kinfo_proc` の `kp_proc.p_sigignore`（オフセット 232）と `kp_eproc.e_pgid`（564）を読む。
 * 構造体は 648 バイトで、`p_pid`（40）が求めた pid と一致したときだけ答える。オフセットは SDK の
 * `sys/sysctl.h` / `sys/proc.h` から求めたもので、64 ビットの macOS で共通。
 * 出力は 1 行に 1 つの JSON（`{"pid","pgid","ignored"}`）。
 */
const DARWIN_HANGUP_PROBE = [
	`ObjC.import('Foundation');`,
	`var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';`,
	`function enc(b){var s='';for(var i=0;i<b.length;i+=3){var n=(b[i]<<16)|((b[i+1]||0)<<8)|(b[i+2]||0);s+=A[(n>>18)&63]+A[(n>>12)&63]+(i+1<b.length?A[(n>>6)&63]:'=')+(i+2<b.length?A[n&63]:'=');}return s;}`,
	`function dec(s){var o=[];s=s.replace(/=+$/,'');for(var i=0;i<s.length;i+=4){var n=(A.indexOf(s[i])<<18)|(A.indexOf(s[i+1])<<12)|((A.indexOf(s[i+2])&63)<<6)|(A.indexOf(s[i+3])&63);o.push((n>>16)&255);if(i+2<s.length){o.push((n>>8)&255);}if(i+3<s.length){o.push(n&255);}}return o;}`,
	`function le(v,w){var b=[];for(var k=0;k<w;k++){b.push(Math.floor(v/Math.pow(256,k))&255);}return b;}`,
	`function data(b){return $.NSMutableData.dataWithData($.NSData.alloc.initWithBase64EncodedStringOptions($(enc(b)),0));}`,
	`function run(argv){`,
	`ObjC.bindFunction('sysctl',['int',['void *','unsigned int','void *','void *','void *','unsigned long']]);`,
	`var out=[];`,
	`argv.forEach(function(a){`,
	`var pid=parseInt(a,10);if(!(pid>1)){return;}`,
	`var mib=data([].concat(le(1,4),le(14,4),le(1,4),le(pid,4)));`,
	`var buf=$.NSMutableData.dataWithLength(648);var len=data(le(648,8));`,
	`if($.sysctl(mib.mutableBytes,4,buf.mutableBytes,len.mutableBytes,null,0)!==0){return;}`,
	`var b=dec(buf.base64EncodedStringWithOptions(0).js);if(b.length<648){return;}`,
	`function u32(o){return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;}`,
	`if(u32(40)!==pid){return;}`,
	`out.push(JSON.stringify({pid:pid,pgid:u32(564),ignored:u32(232)}));`,
	`});`,
	`return out.join(String.fromCharCode(10));`,
	`}`,
].join('');

/** 調べ役の打ち切り。`osascript` の起動は 0.1 秒ほど。 */
const DARWIN_PROBE_TIMEOUT_MS = 3_000;

function probeDarwin(rows: readonly IParadisProcessRow[]): Promise<Map<number, boolean | undefined>> {
	return new Promise(resolve => {
		execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_HANGUP_PROBE, ...rows.map(row => String(row.pid))], {
			timeout: DARWIN_PROBE_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}, (error, stdout) => {
			resolve(paradisParseDarwinHangupProbe(error ? '' : stdout, rows));
		});
	});
}

async function probeLinux(rows: readonly IParadisProcessRow[]): Promise<Map<number, boolean | undefined>> {
	const result = new Map<number, boolean | undefined>();
	await Promise.all(rows.map(async row => {
		try {
			result.set(row.pid, paradisParseLinuxHangupIgnored(await fs.readFile(`/proc/${row.pid}/status`, 'utf8')));
		} catch {
			result.set(row.pid, undefined);
		}
	}));
	return result;
}

/** 本物の外の世界。 */
export function paradisDescendantStopDeps(logService: ILogService): IParadisDescendantStopDeps {
	return {
		snapshot,
		lookup,
		probeHangupIgnored: rows => isMacintosh ? probeDarwin(rows) : probeLinux(rows),
		kill: (pid, signal) => {
			try {
				process.kill(pid, signal);
			} catch {
				// 既に終わった（ESRCH）・権限が無い（EPERM、sudo の下など）。どちらも手を出さない。
			}
		},
		delay: ms => timeout(ms),
		log: logService,
	};
}
