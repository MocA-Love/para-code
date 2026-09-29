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
//  5. シェルとは別の端末（pty）を持つプロセスを含む部分木には触らない。GNU screen の SCREEN は
//     シェルの子孫のまま残り、SIGHUP も無視していない（実測）ので、4 だけでは中のセッションごと
//     止めてしまう。保険として screen / dtach / abduco / tmux の名前の部分木も外す。端末を持たない
//     もの（`detached` で起動された裏タスクなど）はこの規則では外さない。

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
/** SIGTERM から SIGKILL までの猶予。後片付けに時間のかかるサーバーもあるので長めに取る。 */
export const PARADIS_CLOSE_CLEANUP_KILL_GRACE_MS = 8_000;
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
	/** 制御端末（macOS は `ttys003`、Linux は `pts/3`。持たないものは `??` / `?`）。 */
	readonly tty: string;
	/** セッション ID（Linux だけ。macOS の `ps` には無い）。 */
	readonly sid?: number;
}

/** `ps -A -o <これ>` を `LC_ALL=C` で撮る。macOS の `ps` には `sid` が無いので Linux だけ足す。 */
export function paradisPsColumns(withSid: boolean): string {
	return withSid ? 'pid=,ppid=,pgid=,sid=,tty=,lstart=,comm=' : 'pid=,ppid=,pgid=,tty=,lstart=,comm=';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PS_DATE = String.raw`[A-Z][a-z]{2}\s+(?<month>[A-Z][a-z]{2})\s+(?<day>\d{1,2})\s+(?<hour>\d{1,2}):(?<minute>\d{2}):(?<second>\d{2})\s+(?<year>\d{4})\s*(?<command>.*)$`;
const PS_LINE = new RegExp(String.raw`^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<tty>\S+)\s+` + PS_DATE);
const PS_LINE_WITH_SID = new RegExp(String.raw`^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<sid>\d+)\s+(?<tty>\S+)\s+` + PS_DATE);

/** `ps` の出力を読む。読めない行は捨てる（1 行の崩れで全部を諦めない）。`withSid` は {@link paradisPsColumns} と揃える。 */
export function paradisParsePsRows(output: string, withSid: boolean = false): IParadisProcessRow[] {
	const pattern = withSid ? PS_LINE_WITH_SID : PS_LINE;
	const rows: IParadisProcessRow[] = [];
	for (const line of output.split('\n')) {
		const groups = pattern.exec(line)?.groups;
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
			tty: groups.tty,
			...(groups.sid !== undefined ? { sid: Number(groups.sid) } : {}),
		});
	}
	return rows;
}

/** 制御端末を持っているか（`??`・`?`・`-` は持っていない）。 */
function paradisHasTerminal(tty: string): boolean {
	return tty.length > 0 && !/^[?-]+$/.test(tty);
}

/** 端末を多重化する道具（中のセッションごと止めてしまうので、部分木ごと触らない）。 */
const TERMINAL_MULTIPLEXERS = /^(?:screen|dtach|abduco|tmux)(?:[:\s-].*)?$/i;

/**
 * シェルの子孫を集める（シェル自身は含めない）。
 *
 * - 親子関係はシェルから辿る。Linux ではシェルと同じセッション（sid）のものも足す。シェルが先に
 *   終わると子は引き取られて親子では辿れなくなるので、表を撮るのがシェルの終了と競ったときの保険。
 * - `bornBefore`（epoch 秒）以降に生まれたものは入れない（表を撮り終えた後の秒を渡す。時計が
 *   戻ったときの保険）。表を撮った秒に生まれたものも入れ、同じプロセスかの照合はその秒が過ぎてから
 *   行う（`paradisStopCapturedDescendants`）。`excluded` は自分や親など、決して止めてはいけない pid。
 * - シェルと別の端末を持つもの（screen の中のシェル等）がいれば、それと、シェルの端末を持つ祖先の
 *   手前までの祖先（screen の SCREEN 等）と、それらの下の木を外す。シェルの端末を持つ祖先（その
 *   screen を起動したエージェント等）とその兄弟は外さない（外しすぎない）。端末を持たないもの
 *   （`detached` で起動された裏タスク）は外さない。screen / dtach / abduco / tmux の名前の部分木も外す。
 * - 上限を超えたら何も返さない（異常な木に手を出さない）。
 */
export function paradisCollectShellDescendants(rows: readonly IParadisProcessRow[], shellPid: number, bornBefore: number, excluded: ReadonlySet<number>): IParadisProcessRow[] {
	const byPid = new Map(rows.map(row => [row.pid, row]));
	const shell = byPid.get(shellPid);
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
	const eligible = (row: IParadisProcessRow) => row.pid > 1 && row.pid !== shellPid && !excluded.has(row.pid) && row.startedAt < bornBefore;

	// 候補を集める。親子で辿ったものと、（Linux では）同じセッションのものの木。
	const candidates = new Map<number, IParadisProcessRow>();
	const queue: number[] = [shellPid];
	for (const row of rows) {
		if (shellPid > 1 && row.sid === shellPid && eligible(row)) {
			candidates.set(row.pid, row);
			queue.push(row.pid);
		}
	}
	while (queue.length > 0) {
		const parent = queue.shift()!;
		for (const child of children.get(parent) ?? []) {
			if (candidates.has(child.pid) || !eligible(child)) {
				// 生まれた秒が新しすぎるものは、その下も同じく新しいので辿らない。
				continue;
			}
			candidates.set(child.pid, child);
			if (candidates.size > PARADIS_CLOSE_CLEANUP_MAX_TARGETS) {
				return [];
			}
			queue.push(child.pid);
		}
	}

	// 触らない木の根を決める。
	const shellTty = shell !== undefined && paradisHasTerminal(shell.tty) ? shell.tty : undefined;
	const untouchable = new Set<number>();
	for (const row of candidates.values()) {
		if (TERMINAL_MULTIPLEXERS.test(row.command)) {
			untouchable.add(row.pid);
		}
		if (!paradisHasTerminal(row.tty) || row.tty === shellTty) {
			continue;
		}
		// シェルと別の端末を持つ。シェルの端末を持つ祖先の手前まで遡って外す（シェルの端末が
		// 分からないときは、候補の中の祖先を全部外す＝止めない側へ倒す）。
		for (let current: IParadisProcessRow | undefined = row, depth = 0; current !== undefined && candidates.has(current.pid) && depth <= PARADIS_CLOSE_CLEANUP_MAX_TARGETS; current = candidates.get(current.ppid), depth++) {
			if (current !== row && shellTty !== undefined && current.tty === shellTty) {
				break;
			}
			untouchable.add(current.pid);
		}
	}
	const dropped = new Set<number>();
	const dropQueue = [...untouchable];
	while (dropQueue.length > 0) {
		const pid = dropQueue.shift()!;
		if (dropped.has(pid)) {
			continue;
		}
		dropped.add(pid);
		for (const child of children.get(pid) ?? []) {
			dropQueue.push(child.pid);
		}
	}
	return [...candidates.values()].filter(row => !dropped.has(row.pid));
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
