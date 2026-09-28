/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルを閉じたとき、そのシェルから起動されて裏に残ったプロセスを止める（W2-32）。
// ここは判断だけを持つ純関数の置き場で、`ps` の実行やシグナルの送信は node 層にある。
//
// **誤って別のプロセスを止めるのが最大の危険。** 次の 4 つで防ぐ。
//  1. 対象は、シェルを終わらせる**前**に 1 回だけ撮った表で、そのシェルの子孫だったものだけ。
//     シェルが死ぬと子は引き取られて辿れなくなるので、撮るのは必ず前。
//  2. シグナルを送る直前に撮り直し、pid・プロセスグループ・開始時刻がすべて一致するものだけに送る
//     （pid が再利用されていたら開始時刻が変わる）。
//  3. 開始時刻は 1 秒単位なので、表を撮った秒以降に生まれたものは最初から対象にしない
//     （同じ秒の中で pid が再利用されると見分けられないため）。
//  4. SIGHUP を無視しているもの（`nohup`）と、その下にいるものは残す。無視しているかが
//     読めないときも残す（分からないものは止めない）。

import { IProcessEnvironment, isWindows } from '../../../../base/common/platform.js';

/** 設定キー。既定は true（止める）。 */
export const PARADIS_TERMINAL_STOP_BACKGROUND_ON_CLOSE = 'paradis.terminal.stopBackgroundProcessesOnClose';

/**
 * 設定をオフにしたウィンドウが、ターミナルを作るときに env へ入れる印。
 *
 * pty ホスト（SSH 先や常駐も含む）には設定を読む手段が無いので、ターミナルごとに起動時の env で
 * 渡す。env はターミナルと一緒に常駐の台帳や復元の材料にも残るので、再起動をまたいでも失われない。
 * **シェルへは渡さない**（起動の直前に外す）。
 */
export const PARADIS_TERMINAL_KEEP_BACKGROUND_ENV = 'PARA_CODE_TERMINAL_KEEP_BACKGROUND_ON_CLOSE';

/** シェルが終わってから、残ったものに SIGTERM を送るまでの猶予。 */
export const PARADIS_CLOSE_CLEANUP_GRACE_MS = 2_000;
/** SIGTERM から SIGKILL までの猶予。 */
export const PARADIS_CLOSE_CLEANUP_KILL_GRACE_MS = 2_000;
/** シェルの終了を待つ上限。来なくても猶予の後に進む。 */
export const PARADIS_CLOSE_CLEANUP_EXIT_WAIT_MS = 10_000;
/** `ps` の打ち切り。 */
export const PARADIS_CLOSE_CLEANUP_PS_TIMEOUT_MS = 1_000;
/** 1 本のターミナルから止める数の上限。これを超える木は異常とみなして何もしない。 */
export const PARADIS_CLOSE_CLEANUP_MAX_TARGETS = 256;

/** このターミナルを閉じたとき、裏のプロセスを止めるか。Windows は対象外。 */
export function paradisShouldStopBackgroundOnClose(env: IProcessEnvironment, windows: boolean = isWindows): boolean {
	return !windows && env[PARADIS_TERMINAL_KEEP_BACKGROUND_ENV] !== '1';
}

/** シェルへ渡す env から印を外す。含まれていなければ受け取ったものをそのまま返す（書き換えない）。 */
export function paradisWithoutCloseCleanupMarker(env: IProcessEnvironment): IProcessEnvironment {
	if (!Object.prototype.hasOwnProperty.call(env, PARADIS_TERMINAL_KEEP_BACKGROUND_ENV)) {
		return env;
	}
	const copy: IProcessEnvironment = { ...env };
	delete copy[PARADIS_TERMINAL_KEEP_BACKGROUND_ENV];
	return copy;
}

/** ウィンドウ側で、設定の値を印として env に写す（オンなら印を消す）。 */
export function paradisApplyCloseCleanupPreference(env: { [key: string]: string | null | undefined }, stopBackground: boolean): void {
	if (stopBackground) {
		delete env[PARADIS_TERMINAL_KEEP_BACKGROUND_ENV];
	} else {
		env[PARADIS_TERMINAL_KEEP_BACKGROUND_ENV] = '1';
	}
}

/** `ps` の 1 行。 */
export interface IParadisProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	/** 開始時刻（epoch 秒。`lstart` を手元の時刻として読んだもの）。比較にだけ使う。 */
	readonly startedAt: number;
	/** 実行ファイル名（パスを除いた名前だけ）。ログに書くのはこれだけで、引数は持たない。 */
	readonly command: string;
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=,comm=` を `LC_ALL=C` で撮ったときの引数。macOS と Linux で共通。 */
export const PARADIS_PS_COLUMNS = 'pid=,ppid=,pgid=,lstart=,comm=';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PS_LINE = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+[A-Z][a-z]{2}\s+(?<month>[A-Z][a-z]{2})\s+(?<day>\d{1,2})\s+(?<hour>\d{1,2}):(?<minute>\d{2}):(?<second>\d{2})\s+(?<year>\d{4})\s*(?<command>.*)$/;

/** `ps` の出力を読む。読めない行は捨てる（1 行の崩れで全部を諦めない）。 */
export function paradisParsePsRows(output: string): IParadisProcessRow[] {
	const rows: IParadisProcessRow[] = [];
	for (const line of output.split('\n')) {
		const groups = PS_LINE.exec(line)?.groups;
		if (!groups) {
			continue;
		}
		const month = MONTHS.indexOf(groups.month);
		if (month < 0) {
			continue;
		}
		const startedAt = Math.floor(new Date(Number(groups.year), month, Number(groups.day), Number(groups.hour), Number(groups.minute), Number(groups.second)).getTime() / 1000);
		if (!Number.isFinite(startedAt)) {
			continue;
		}
		const command = groups.command.trim();
		rows.push({
			pid: Number(groups.pid),
			ppid: Number(groups.ppid),
			pgid: Number(groups.pgid),
			startedAt,
			command: command.slice(command.lastIndexOf('/') + 1),
		});
	}
	return rows;
}

/**
 * シェルの子孫を集める（シェル自身は含めない）。
 *
 * `bornBefore`（epoch 秒）以降に生まれたものは入れない。表を撮った秒に生まれたものは、同じ秒の
 * 中で pid が再利用されると開始時刻で見分けられないため。`excluded` は自分や親など、決して
 * 止めてはいけない pid。上限を超えたら何も返さない（異常な木に手を出さない）。
 */
export function paradisCollectShellDescendants(rows: readonly IParadisProcessRow[], shellPid: number, bornBefore: number, excluded: ReadonlySet<number>): IParadisProcessRow[] {
	const children = new Map<number, IParadisProcessRow[]>();
	for (const row of rows) {
		if (row.pid === row.ppid) {
			continue;
		}
		let list = children.get(row.ppid);
		if (!list) {
			list = [];
			children.set(row.ppid, list);
		}
		list.push(row);
	}
	const result: IParadisProcessRow[] = [];
	const seen = new Set<number>([shellPid]);
	const queue = [shellPid];
	while (queue.length > 0) {
		const parent = queue.shift()!;
		for (const child of children.get(parent) ?? []) {
			if (seen.has(child.pid)) {
				continue;
			}
			seen.add(child.pid);
			// 生まれた秒が新しすぎるものは、その下も同じく新しいので辿らない。
			if (child.pid <= 1 || excluded.has(child.pid) || child.startedAt >= bornBefore) {
				continue;
			}
			result.push(child);
			if (result.length > PARADIS_CLOSE_CLEANUP_MAX_TARGETS) {
				return [];
			}
			queue.push(child.pid);
		}
	}
	return result;
}

/** 撮ったときと同じプロセスか（pid の再利用を見分ける）。親は引き取りで変わるので見ない。 */
export function paradisSameProcess(captured: IParadisProcessRow, current: IParadisProcessRow): boolean {
	return captured.pid === current.pid && captured.pgid === current.pgid && captured.startedAt === current.startedAt;
}

/** 撮り直した表のうち、撮ったときと同じプロセスとして生きているものを返す。 */
export function paradisStillRunning(captured: readonly IParadisProcessRow[], current: readonly IParadisProcessRow[]): IParadisProcessRow[] {
	const byPid = new Map(current.map(row => [row.pid, row]));
	return captured.filter(row => {
		const now = byPid.get(row.pid);
		return now !== undefined && paradisSameProcess(row, now);
	});
}

export interface IParadisHangupPlan {
	/** SIGTERM を送るもの。 */
	readonly stop: readonly IParadisProcessRow[];
	/** 残すもの（SIGHUP を無視している・その下にいる・無視しているかが分からない）。 */
	readonly keep: readonly IParadisProcessRow[];
}

/**
 * 生き残ったものを「止める」と「残す」に分ける。
 *
 * `hangupIgnored` は pid ごとに SIGHUP を無視しているか。**分からない（undefined）ものは残す。**
 * 撮った表の親子関係で、SIGHUP を無視して生きている祖先（シェルより下）を持つものも残す
 * （`nohup ./start.sh &` の下の node は、node が起動時にシグナルの扱いを戻すので無視していない
 * が、利用者が残したかったのはその木全体）。
 */
export function paradisPlanHangupSurvivors(
	captured: readonly IParadisProcessRow[],
	survivors: readonly IParadisProcessRow[],
	hangupIgnored: ReadonlyMap<number, boolean | undefined>,
): IParadisHangupPlan {
	const parentOf = new Map(captured.map(row => [row.pid, row.ppid]));
	const alive = new Set(survivors.map(row => row.pid));
	const ignoresHangup = (pid: number) => alive.has(pid) && hangupIgnored.get(pid) === true;
	const stop: IParadisProcessRow[] = [];
	const keep: IParadisProcessRow[] = [];
	for (const row of survivors) {
		let kept = hangupIgnored.get(row.pid) !== false;
		for (let ancestor = parentOf.get(row.pid), depth = 0; !kept && ancestor !== undefined && depth <= PARADIS_CLOSE_CLEANUP_MAX_TARGETS; ancestor = parentOf.get(ancestor), depth++) {
			kept = ignoresHangup(ancestor);
		}
		(kept ? keep : stop).push(row);
	}
	return { stop, keep };
}

/** Linux の `/proc/<pid>/status` の `SigIgn` から、SIGHUP を無視しているかを読む。 */
export function paradisParseLinuxHangupIgnored(status: string): boolean | undefined {
	const mask = /^SigIgn:\s*(?<mask>[0-9a-fA-F]+)\s*$/m.exec(status)?.groups?.mask;
	if (mask === undefined) {
		return undefined;
	}
	// SIGHUP は 1 番なので最下位ビット。
	return (parseInt(mask.slice(-1), 16) & 1) === 1;
}

/** macOS の調べ役（osascript）の出力 1 行分。 */
interface IParadisDarwinProbeLine {
	readonly pid: number;
	readonly pgid: number;
	readonly ignored: number;
}

/**
 * macOS の調べ役の出力を読む。返ってきた pid・プロセスグループが撮った表と一致するときだけ
 * 答えを採る（一致しなければ別のプロセスなので「分からない」）。
 */
export function paradisParseDarwinHangupProbe(output: string, rows: readonly IParadisProcessRow[]): Map<number, boolean | undefined> {
	const result = new Map<number, boolean | undefined>(rows.map(row => [row.pid, undefined]));
	const byPid = new Map(rows.map(row => [row.pid, row]));
	for (const line of output.split('\n')) {
		let parsed: IParadisDarwinProbeLine;
		try {
			parsed = JSON.parse(line) as IParadisDarwinProbeLine;
		} catch {
			continue;
		}
		const row = byPid.get(parsed?.pid);
		if (row && typeof parsed.ignored === 'number' && parsed.pgid === row.pgid) {
			result.set(row.pid, (parsed.ignored & 1) === 1);
		}
	}
	return result;
}

/** ログ用の要約。名前ごとに数をまとめる（`node x2, vite`）。 */
export function paradisSummarizeCommands(rows: readonly IParadisProcessRow[]): string {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const name = row.command || '?';
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts].map(([name, count]) => count > 1 ? `${name} x${count}` : name).join(', ');
}
