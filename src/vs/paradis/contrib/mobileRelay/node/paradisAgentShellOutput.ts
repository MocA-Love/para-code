/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のバックグラウンドのシェルの出力ファイルの末尾を読む（agent の `shell-output`。agent.shells.v1）。
// agent チャネルのシェルの要求・応答の形と検査もここに置く（ParadisMobileAgentChat は呼ぶだけにする）。
//
// 出力ファイルは `<tmp>/claude-<uid>/<cwd のスラッグ>/<sessionId>/tasks/<taskId>.output`（macOS は /private/tmp）。
// stdout と stderr が混ざっていて、終わると最後の行に `[exited with code N]` か `[killed]` が付く。
// 読むパスは transcript で覚えたものだけ（モバイルからは ID しか受け取らない）。それでも transcript は
// 書き換えられうるので、読む前に realpath がこのユーザーの tasks ディレクトリの下の `<taskId>.output` かを確かめる。

import { constants, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join, relative, sep } from '../../../../base/common/path.js';
import { IParadisAgentShell, IParadisAgentShellsAccess, paradisShellOutputEndMarker } from '../../agentChat/common/paradisAgentShells.js';
import type { ParadisClaudeModStopResult } from '../../claudeMod/node/paradisClaudeModBridge.js';

/** 一度に返す行数の上限と既定（ユーザーの決定: 詳細は末尾 20 行）。 */
export const PARADIS_SHELL_OUTPUT_LINES_MAX = 50;
export const PARADIS_SHELL_OUTPUT_LINES_DEFAULT = 20;
/** 1 回の要求で読むシェルの数の上限。 */
export const PARADIS_SHELL_OUTPUT_IDS_MAX = 20;
/** ファイルの末尾から読む量。 */
const TAIL_BYTES = 64 * 1024;
/** 1 行の上限（Monitor の表示と同じ 1,000 文字）。 */
const LINE_LENGTH = 1_000;

export interface IParadisShellOutputTail {
	/** 末尾の行（古い順）。終わりの印（`[exited with code N]` など）も含む。 */
	readonly lines: readonly string[];
	/** これより前にも行がある。 */
	readonly truncated: boolean;
	/** 最後の行が終わりの印だった。 */
	readonly ended?: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number };
}

export type ParadisShellOutputError = 'not-found' | 'unavailable';

// 端末の制御（色・カーソル移動・OSC）を落とす。
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 1 行を表示用にそろえる（制御を落とし、`\r` で上書きされた進捗は最後の書き込みだけ残す）。 */
export function paradisCleanShellOutputLine(line: string): string {
	const withoutAnsi = line.replace(ANSI, '');
	const lastReturn = withoutAnsi.replace(/\r+$/, '').lastIndexOf('\r');
	const visible = (lastReturn >= 0 ? withoutAnsi.slice(lastReturn + 1) : withoutAnsi).replace(CONTROL, '').replace(/\s+$/, '');
	// allow-any-unicode-next-line
	return visible.length > LINE_LENGTH ? `${visible.slice(0, LINE_LENGTH)}…` : visible;
}

/** 読んだ末尾のバイト列を行へ分ける（先頭が行の途中なら捨てる）。 */
export function paradisSplitShellOutputTail(text: string, fromStart: boolean, lines: number): IParadisShellOutputTail {
	let all = text.split('\n');
	if (!fromStart) {
		all = all.slice(1);
	}
	if (all.length > 0 && all[all.length - 1] === '') {
		all.pop();
	}
	const cleaned = all.map(paradisCleanShellOutputLine);
	const count = Math.max(1, Math.min(PARADIS_SHELL_OUTPUT_LINES_MAX, Math.trunc(lines)));
	const tail = cleaned.slice(-count);
	const ended = paradisShellOutputEndMarker(cleaned.at(-1));
	return { lines: tail, truncated: !fromStart || cleaned.length > tail.length, ...(ended !== undefined ? { ended } : {}) };
}

/**
 * `realPath` がこのユーザーの Claude Code の tasks ディレクトリの下の、このセッション・このタスクの出力ファイルか。
 * `<root>/claude-<uid>/<スラッグ>/<sessionId>/tasks/<taskId>.output` の形だけを通す（root は /tmp と os.tmpdir() の realpath）。
 */
export function paradisIsShellOutputPath(realPath: string, roots: readonly string[], uid: number, sessionId: string, taskId: string): boolean {
	return paradisShellOutputBase(realPath, roots, uid, sessionId, taskId) !== undefined;
}

/** {@link paradisIsShellOutputPath} に当たったときの `<root>/claude-<uid>`。 */
function paradisShellOutputBase(realPath: string, roots: readonly string[], uid: number, sessionId: string, taskId: string): string | undefined {
	for (const root of roots) {
		const base = join(root, `claude-${uid}`);
		const parts = relative(base, realPath).split(sep);
		if (parts.length === 4 && parts[0].length > 0 && parts[0] !== '..' && parts[0] !== '.'
			&& parts[1] === sessionId && parts[2] === 'tasks' && parts[3] === `${taskId}.output`) {
			return base;
		}
	}
	return undefined;
}

/** Claude Code が出力ファイルを置く一時ディレクトリの候補（/tmp と os.tmpdir()）。 */
const DEFAULT_ROOTS: readonly string[] = ['/tmp', tmpdir()];

/** transcript のパスから Claude Code のセッション ID（ファイル名から `.jsonl` を除いたもの）。 */
export function paradisClaudeSessionIdFromTranscript(transcriptPath: string): string | undefined {
	const id = basename(transcriptPath).replace(/\.jsonl$/, '');
	return /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : undefined;
}

/**
 * 出力ファイルの末尾を読む。Windows（uid が無い）・形の合わないパスは読まない。
 * sessionId は Claude Code のセッション ID（tailer が読んでいる transcript のファイル名）。
 * `roots` はテストが一時ディレクトリを渡すためのもの（既定は /tmp と os.tmpdir()）。
 * `<root>/claude-<uid>` は、自分の持ち物で、他人が書き込めないものだけを信じる（ほかのユーザーが先に
 * 作ったディレクトリに置かれたファイルを読まない）。
 */
export async function paradisReadShellOutputTail(outputFile: string, sessionId: string, taskId: string, lines: number, roots: readonly string[] = DEFAULT_ROOTS): Promise<IParadisShellOutputTail | ParadisShellOutputError> {
	if (process.platform === 'win32' || typeof process.getuid !== 'function' || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
		return 'unavailable';
	}
	const uid = process.getuid();
	let realPath: string;
	try {
		realPath = await fs.realpath(outputFile);
	} catch {
		return 'not-found';
	}
	const realRoots = [...new Set(await Promise.all(roots.map(root => fs.realpath(root).catch(() => root))))];
	const base = paradisShellOutputBase(realPath, realRoots, uid, sessionId, taskId);
	if (base === undefined) {
		return 'unavailable';
	}
	try {
		const baseStat = await fs.lstat(base);
		// Claude Code はこのディレクトリを 0700 で作る（2026-10-04 に /tmp/claude-<uid> の実物で確認）。他人が書き込めるものは信じない
		if (!baseStat.isDirectory() || baseStat.uid !== uid || (baseStat.mode & 0o002) !== 0) {
			return 'unavailable';
		}
	} catch {
		return 'unavailable';
	}
	let handle: fs.FileHandle | undefined;
	try {
		// realpath の後にすり替えられても辿らない。FIFO にすり替えられても開くところで止まらない
		handle = await fs.open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== uid) {
			return 'unavailable';
		}
		const start = Math.max(0, stat.size - TAIL_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.alloc(length);
		const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
		return paradisSplitShellOutputTail(buffer.subarray(0, bytesRead).toString('utf8'), start === 0, lines);
	} catch {
		return 'not-found';
	} finally {
		await handle?.close().catch(() => { /* ignore */ });
	}
}

// ---- agent チャネルの形（agent.shells.v1） ------------------------------------------------------------

/**
 * モバイル→PC。
 * - `shell-output`: シェルの出力の末尾を求める。`shellIds` は snapshot / delta の `shells` の id（パスは受け取らない）、
 *   `lines` は 1 シェルあたりの行数（既定 20、上限 50）
 * - `action/stopShell`: シェルを止める（mod の TaskStop）。答えは `action-result`
 */
export type ParadisAgentShellInbound =
	| { t: 'shell-output'; id: number; token?: string; requestId: string; epoch: string; shellIds: readonly string[]; lines?: number }
	| { t: 'action/stopShell'; id: number; token?: string; requestId: string; epoch: string; shellId: string };

/** 1 シェルぶんの出力。`error` があれば読めなかった（not-found: もう無い、unavailable: この構成では読めない）。 */
export interface IParadisAgentShellOutputItem {
	readonly id: string;
	readonly lines?: readonly string[];
	readonly truncated?: true;
	readonly error?: ParadisShellOutputError;
}

/** PC→モバイル。`error` は要求全体が通らなかった（stale-session / unavailable / busy）。 */
export type ParadisAgentShellOutbound =
	| { t: 'shell-output'; id: number; requestId: string; shells?: readonly IParadisAgentShellOutputItem[]; readAt?: number; error?: string };

/** snapshot / delta の任意項目（Claude のセッションだけ）。時刻は PC の時計で、`shellsAt`（PC の送信時刻）を添える。 */
export interface IParadisAgentShellsField {
	shells?: readonly IParadisAgentShell[];
	shellsAt?: number;
	shellsAccess?: IParadisAgentShellsAccess;
}

const SHELL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `shell-output` / `action/stopShell` の中身の検査（id・requestId・token は呼び出し側が確かめる）。 */
export function paradisIsValidShellRequest(msg: Record<string, unknown>): boolean {
	if (typeof msg.epoch !== 'string' || msg.epoch.length === 0 || msg.epoch.length > 200) {
		return false;
	}
	if (msg.t === 'shell-output') {
		return Array.isArray(msg.shellIds) && msg.shellIds.length > 0 && msg.shellIds.length <= PARADIS_SHELL_OUTPUT_IDS_MAX
			&& msg.shellIds.every(id => typeof id === 'string' && SHELL_ID.test(id))
			&& (msg.lines === undefined || (typeof msg.lines === 'number' && Number.isInteger(msg.lines) && msg.lines >= 1 && msg.lines <= PARADIS_SHELL_OUTPUT_LINES_MAX));
	}
	return msg.t === 'action/stopShell' && typeof msg.shellId === 'string' && SHELL_ID.test(msg.shellId);
}

/** 出力を読むのに要るもの（tailer とペインの情報）。 */
export interface IParadisShellOutputSource {
	readonly sessionId: string | undefined;
	/** テストが一時ディレクトリを渡す（既定は /tmp と os.tmpdir()）。 */
	readonly roots?: readonly string[];
	outputFile(shellId: string): string | undefined;
	/** 出力の最後の印で終わりが分かった（推定として、動いているものだけ直す）。 */
	markOutputEnded(shellId: string, end: { readonly status: 'completed' | 'failed' | 'stopped'; readonly exitCode?: number }): void;
	/** 最後の行が印ではなかった（印から推定した終わりがあれば取り消す）。 */
	markOutputRunning(shellId: string): void;
}

/** `shell-output` の各シェルの出力を読む（ファイルは並べて読まず、1 つずつ）。 */
export async function paradisReadShellOutputs(source: IParadisShellOutputSource, shellIds: readonly string[], lines: number | undefined): Promise<IParadisAgentShellOutputItem[]> {
	const items: IParadisAgentShellOutputItem[] = [];
	for (const id of [...new Set(shellIds)]) {
		const file = source.outputFile(id);
		if (file === undefined || source.sessionId === undefined) {
			items.push({ id, error: 'not-found' });
			continue;
		}
		const tail = await paradisReadShellOutputTail(file, source.sessionId, id, lines ?? PARADIS_SHELL_OUTPUT_LINES_DEFAULT, source.roots);
		if (typeof tail === 'string') {
			items.push({ id, error: tail });
			continue;
		}
		if (tail.ended !== undefined) {
			source.markOutputEnded(id, tail.ended);
		} else {
			source.markOutputRunning(id);
		}
		items.push({ id, lines: tail.lines, ...(tail.truncated ? { truncated: true as const } : {}) });
	}
	return items;
}

/** {@link paradisHandleShellRequest} が使うペインの情報（ParadisMobileAgentChat が tailer とペインから作る）。 */
export interface IParadisShellRequestContext extends IParadisShellOutputSource {
	/** ペインのトークン（同じペインの読み取りを 1 本にする鍵）。 */
	readonly key: string;
	readonly access: IParadisAgentShellsAccess;
	/** 出力を読んでいるペイン（1 ペインで同時に 1 本）。 */
	readonly reads: Set<string>;
	isRunning(shellId: string): boolean;
	/** アプリから止めた（mod の ack で止まったと分かった）。 */
	markStopped(shellId: string): void;
	stopTask(sessionId: string, shellId: string): Promise<ParadisClaudeModStopResult>;
	/** mod・例外の生の文はアプリへ送らず、ここ（ログ）へだけ出す。 */
	log(message: string): void;
}

/** `shell-output` の返事か、`action/stopShell` の `action-result`（id と requestId は呼び出し側が付ける）。 */
export type ParadisShellRequestReply =
	| { readonly t: 'shell-output'; readonly shells?: readonly IParadisAgentShellOutputItem[]; readonly readAt?: number; readonly error?: string }
	| { readonly t: 'action-result'; readonly status: 'accepted' | 'rejected'; readonly code?: string; readonly message?: string };

/**
 * バックグラウンドのシェルの出力の末尾（`shell-output`）と停止（`action/stopShell`）。agent.shells.v1。
 * context が無いのは、ペインが無い・会話が替わった・購読していないとき。
 * 出力のパスは transcript で覚えたものだけを使い、SSH・WSL・Windows では読まない・止めない（`access`）。
 * 止めるのは mod（Claude Mods）の TaskStop だけで、transcript に残らないので ack で一覧を「停止」に直す。
 */
export async function paradisHandleShellRequest(msg: ParadisAgentShellInbound, context: IParadisShellRequestContext | undefined, reply: (body: ParadisShellRequestReply) => void): Promise<void> {
	if (msg.t === 'shell-output') {
		if (context === undefined) {
			reply({ t: 'shell-output', error: 'stale-session' });
			return;
		}
		if (!context.access.output) {
			reply({ t: 'shell-output', error: 'unavailable' });
			return;
		}
		if (context.reads.has(context.key)) {
			reply({ t: 'shell-output', error: 'busy' });
			return;
		}
		context.reads.add(context.key);
		try {
			const shells = await paradisReadShellOutputs(context, msg.shellIds, msg.lines);
			reply({ t: 'shell-output', shells, readAt: Date.now() });
		} finally {
			context.reads.delete(context.key);
		}
		return;
	}
	const reject = (code: string, message: string) => reply({ t: 'action-result', status: 'rejected', code, message });
	if (context === undefined) {
		reject('stale-session', '操作対象のエージェントセッションが変わりました');
		return;
	}
	if (!context.access.stop || context.sessionId === undefined) {
		reject('unsupported', 'このペインでは Claude Mods が動いていないため、アプリからは止められません');
		return;
	}
	if (!context.isRunning(msg.shellId)) {
		reject('not-running', 'このシェルはもう止まっています');
		return;
	}
	let result: ParadisClaudeModStopResult;
	try {
		result = await context.stopTask(context.sessionId, msg.shellId);
	} catch (error) {
		context.log(`[paradisAgentShells] stopping ${msg.shellId} failed: ${error instanceof Error ? error.message : String(error)}`);
		reject('outcome-unknown', '止めたかどうかを確かめられませんでした。PC の端末で /tasks を確かめてください');
		return;
	}
	if (result.message !== undefined) {
		context.log(`[paradisAgentShells] TaskStop ${msg.shellId}: ${result.outcome}: ${result.message}`);
	}
	switch (result.outcome) {
		case 'stopped':
			context.markStopped(msg.shellId);
			reply({ t: 'action-result', status: 'accepted' });
			return;
		case 'refused':
			// Claude Code の文面はアプリへ送らない（ログにだけ出す）
			reject('stop-failed', '止められませんでした。もう終わっていたかもしれません。PC の端末で /tasks を確かめてください');
			return;
		case 'unavailable':
			reject('mod-unavailable', 'Claude Mods へ届きませんでした。少し待ってからもう一度試してください');
			return;
		default:
			reject('outcome-unknown', '止めたかどうかを確かめられませんでした。PC の端末で /tasks を確かめてください');
	}
}
