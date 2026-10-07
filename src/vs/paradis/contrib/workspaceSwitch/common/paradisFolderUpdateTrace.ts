/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペース切り替えの `update_folders_write`（`updateFolders` の呼び出し → `onWillChangeWorkspaceFolders`）
 * を、upstream の中の境目で割るための短命な記録。
 *
 * 本番の集計 (paracode-160) で、この区間が SSH 間の切り替えで 6.9〜27.6 秒まで伸びていたが、
 * 区間の中身は upstream の `WorkspaceService` / `JSONEditingService` なので、書き込みと読み直しの
 * どちらに使われた時間か分からなかった。upstream のファイルには境目ごとに
 * `paradisMarkFolderUpdate(...)` の 1 行だけを置き (PARA-PATCH)、時刻はここで持つ。
 *
 * もう 1 つ、区間の間に renderer が投げたファイル IPC（切り替えに限らず、エクスプローラーなど
 * この renderer のすべての呼び出しを含む）（手元は main の `localFilesystem`、SSH は
 * 接続先の `remoteFilesystem`）を数える。チャネルの包み (`paradisCountFileChannel`) は記録中で
 * なければ何もせずに素通しする。
 *
 * **送るのは数と時間だけ**。パス・ホスト名・ワークスペース名はここへ一切入れない（URI を受け取る
 * 引数も持たない）。
 *
 * 記録は同時に 1 つだけ。切り替えは Sequencer で直列なので足りる。
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';

/**
 * 区間の境目。**この順に通る**（Sentry での読み方は NOTES.md の「スペース切り替えの計測」）。
 *
 * - `entered`              `WorkspaceService.doUpdateFolders` に入った（`workspaceEditingQueue` の待ちが済んだ）
 * - `set_folders`          新しい folders を組み立て終えて `setFolders` に入った（行き先の stat を含む）
 * - `model_resolved`       `.code-workspace` のテキストモデルを用意した（exists + 読み込み）
 * - `saved`                書き換えて保存し終えた（etag の stat・書き込み・書き込み後の stat）
 * - `reloaded`             `.code-workspace` を読み直した
 * - `validated`            新しい folders を確かめた（`toValidWorkspaceFolders`）
 * - `folder_config_loaded` 行き先の `.vscode/` の設定を読んだ（退避分の再利用なら読まない）
 */
export const PARADIS_FOLDER_UPDATE_MARKS = ['entered', 'set_folders', 'model_resolved', 'saved', 'reloaded', 'validated', 'folder_config_loaded'] as const;
export type ParadisFolderUpdateMark = typeof PARADIS_FOLDER_UPDATE_MARKS[number];

/** 区間の名前（送るキーは `safe_update_folders_<名前>_ms`）。境目の 1 つ前からその境目まで。 */
const SEGMENT_NAMES: Record<ParadisFolderUpdateMark | 'will_change', string> = {
	entered: 'queue',
	set_folders: 'compose',
	model_resolved: 'resolve',
	saved: 'save',
	reloaded: 'reload',
	validated: 'validate',
	folder_config_loaded: 'folder_config',
	will_change: 'will_change',
};

export type ParadisFileIoLocality = 'remote' | 'local';

interface IFileIoTally {
	calls: number;
	stats: number;
	reads: number;
	writes: number;
	others: number;
	readBytes: number;
	writeBytes: number;
	/** 返事が来た呼び出しの待ち時間の合計（並列の呼び出しは重なって数える）。 */
	waitMs: number;
	maxMs: number;
	/** 最短の stat。接続先との 1 往復の時間の推定に使う。 */
	minStatMs: number | undefined;
}

interface ITrace {
	readonly startedAt: number;
	readonly marks: Map<ParadisFolderUpdateMark, number>;
	parkedFolderConfigs: number;
	readonly shortcuts: Record<ParadisFolderUpdateShortcut, number>;
	readonly io: Record<ParadisFileIoLocality, IFileIoTally>;
}

let active: ITrace | undefined;
let clock: () => number = () => Date.now();

function emptyTally(): IFileIoTally {
	return { calls: 0, stats: 0, reads: 0, writes: 0, others: 0, readBytes: 0, writeBytes: 0, waitMs: 0, maxMs: 0, minStatMs: undefined };
}

/** `paradisBeginFolderUpdateTrace` の戻り値。 */
export interface IParadisFolderUpdateTrace {
	/** ここまでの記録を送る形にする。`willChangeAt` は `onWillChangeWorkspaceFolders` の時刻（来なければ undefined）。 */
	summarize(willChangeAt: number | undefined): Record<string, number>;
	/** 記録をやめる。2 回目以降は何もしない。後から始めた記録は止めない。 */
	end(): void;
}

/**
 * 記録を始める。前の記録が残っていれば捨てる（終わらせ忘れた記録を次の切り替えへ混ぜない）。
 */
export function paradisBeginFolderUpdateTrace(): IParadisFolderUpdateTrace {
	const trace: ITrace = {
		startedAt: clock(),
		marks: new Map(),
		parkedFolderConfigs: 0,
		shortcuts: emptyShortcuts(),
		io: { remote: emptyTally(), local: emptyTally() },
	};
	active = trace;
	return {
		summarize: willChangeAt => summarizeTrace(trace, willChangeAt),
		end: () => {
			if (active === trace) {
				active = undefined;
			}
		},
	};
}

/**
 * upstream の境目から呼ぶ。記録中でなければ何もしない。
 *
 * **順番どおりに来たものだけ受け取る。** 書き込みの直後、接続先の変更通知で同じ
 * `onWorkspaceConfigurationChanged` が別の経路からも走ることがあり（50ms の読み直しのスケジューラ）、
 * そちらが先に `validated` を踏むと区間が逆転する。前の境目が済んでいない境目と、2 回目以降は捨てる。
 */
export function paradisMarkFolderUpdate(mark: ParadisFolderUpdateMark): void {
	const trace = active;
	if (trace === undefined || trace.marks.has(mark)) {
		return;
	}
	const index = PARADIS_FOLDER_UPDATE_MARKS.indexOf(mark);
	if (index > 0 && !trace.marks.has(PARADIS_FOLDER_UPDATE_MARKS[index - 1])) {
		return;
	}
	trace.marks.set(mark, clock());
}

/** `onFoldersChanged` が退避してあったフォルダの設定を読まずに使い回したとき。 */
export function paradisNoteParkedFolderConfiguration(): void {
	if (active !== undefined) {
		active.parkedFolderConfigs++;
	}
}

/**
 * `.code-workspace` の往復を省いた・省けなかった印（`paradisWorkspaceFileWriteCache.ts`）。送るキーは
 * `safe_update_folders_<名前>`（回数）。
 *
 * - `resolve_cached`   覚えていた中身と etag で書いた（存在確認と読み込みをしていない）
 * - `resolve_verified` 監視の通知の後の stat を待ってから、覚えていた中身で書いた
 * - `resolve_conflict` 覚えていた etag で書いたら衝突した（または失敗した）ので、読み直して書き直した
 * - `reload_cached`    書いた直後の読み直しを、書いた中身で済ませた
 */
export const PARADIS_FOLDER_UPDATE_SHORTCUTS = ['resolve_cached', 'resolve_verified', 'resolve_conflict', 'reload_cached'] as const;
export type ParadisFolderUpdateShortcut = typeof PARADIS_FOLDER_UPDATE_SHORTCUTS[number];

function emptyShortcuts(): Record<ParadisFolderUpdateShortcut, number> {
	return { resolve_cached: 0, resolve_verified: 0, resolve_conflict: 0, reload_cached: 0 };
}

/** 往復を省いた・省けなかったとき。記録中でなければ何もしない。 */
export function paradisNoteFolderUpdateShortcut(shortcut: ParadisFolderUpdateShortcut): void {
	if (active !== undefined) {
		active.shortcuts[shortcut]++;
	}
}

function kindOf(command: string): 'stats' | 'reads' | 'writes' | 'others' {
	switch (command) {
		case 'stat':
			return 'stats';
		case 'readFile':
		case 'open':
		case 'read':
		case 'close':
		case 'readFileStream':
			return 'reads';
		case 'writeFile':
		case 'write':
			return 'writes';
		default:
			return 'others';
	}
}

function byteLengthOf(value: unknown): number {
	const length = (value as { byteLength?: unknown } | undefined)?.byteLength;
	return typeof length === 'number' && Number.isFinite(length) && length >= 0 ? length : 0;
}

/** 書き込むバイト数。`writeFile` は `[resource, VSBuffer, opts]`、`write` は `[fd, pos, VSBuffer, offset, length]`。 */
function writeBytesOf(command: string, arg: unknown): number {
	if (!Array.isArray(arg)) {
		return 0;
	}
	if (command === 'writeFile') {
		return byteLengthOf(arg[1]);
	}
	if (command === 'write') {
		return typeof arg[4] === 'number' && arg[4] >= 0 ? arg[4] : 0;
	}
	return 0;
}

/** 読んだバイト数。`readFile` は VSBuffer、`read` は `[VSBuffer, bytesRead]`。 */
function readBytesOf(command: string, result: unknown): number {
	if (command === 'readFile') {
		return byteLengthOf(result);
	}
	if (command === 'read' && Array.isArray(result)) {
		return typeof result[1] === 'number' && result[1] >= 0 ? result[1] : 0;
	}
	return 0;
}

/**
 * ファイルのプロバイダのチャネルを包み、記録中だけ呼び出しを数える。記録中でなければ
 * 元のチャネルへそのまま渡す（返す promise も元のもの）。
 */
export function paradisCountFileChannel(channel: IChannel, locality: ParadisFileIoLocality): IChannel {
	return {
		call<T>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
			const trace = active;
			if (trace === undefined) {
				return channel.call<T>(command, arg, cancellationToken);
			}
			const startedAt = clock();
			const result = channel.call<T>(command, arg, cancellationToken);
			const tally = trace.io[locality];
			const kind = kindOf(command);
			tally.calls++;
			tally[kind]++;
			tally.writeBytes += writeBytesOf(command, arg);
			const settle = (value: unknown, ok: boolean) => {
				const ms = Math.max(0, clock() - startedAt);
				tally.waitMs += ms;
				tally.maxMs = Math.max(tally.maxMs, ms);
				tally.readBytes += readBytesOf(command, value);
				// 往復の推定は成功した stat だけ (切断ですぐ失敗した stat で小さく出さない)。
				if (kind === 'stats' && ok) {
					tally.minStatMs = tally.minStatMs === undefined ? ms : Math.min(tally.minStatMs, ms);
				}
			};
			// 数えるためだけの枝。失敗は呼び出し元が受け取るので、ここでは握るだけ。
			result.then(value => settle(value, true), () => settle(undefined, false));
			return result;
		},
		listen<T>(event: string, arg?: unknown): Event<T> {
			const trace = active;
			if (trace !== undefined && event === 'readFileStream') {
				trace.io[locality].calls++;
				trace.io[locality].reads++;
			}
			return channel.listen<T>(event, arg);
		},
	};
}

function summarizeTrace(trace: ITrace, willChangeAt: number | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	// 隣り合う境目が両方あるときだけ区間を出す。抜けた境目を飛ばして繋ぐと、2 つの区間の和を
	// 1 つの区間の値として送ってしまう。
	let previous: number | undefined = trace.startedAt;
	for (const mark of PARADIS_FOLDER_UPDATE_MARKS) {
		const at = trace.marks.get(mark);
		if (previous !== undefined && at !== undefined) {
			out[`safe_update_folders_${SEGMENT_NAMES[mark]}_ms`] = Math.max(0, at - previous);
		}
		previous = at;
	}
	if (previous !== undefined && willChangeAt !== undefined) {
		out[`safe_update_folders_${SEGMENT_NAMES.will_change}_ms`] = Math.max(0, willChangeAt - previous);
	}
	out.safe_update_folders_marks = trace.marks.size;
	out.safe_update_folders_parked_configs = trace.parkedFolderConfigs;
	for (const shortcut of PARADIS_FOLDER_UPDATE_SHORTCUTS) {
		out[`safe_update_folders_${shortcut}`] = trace.shortcuts[shortcut];
	}
	for (const locality of ['remote', 'local'] as const) {
		const tally = trace.io[locality];
		if (tally.calls === 0) {
			continue;
		}
		const prefix = `safe_update_folders_${locality}`;
		out[`${prefix}_calls`] = tally.calls;
		out[`${prefix}_stats`] = tally.stats;
		out[`${prefix}_reads`] = tally.reads;
		out[`${prefix}_writes`] = tally.writes;
		out[`${prefix}_others`] = tally.others;
		out[`${prefix}_read_bytes`] = tally.readBytes;
		out[`${prefix}_write_bytes`] = tally.writeBytes;
		out[`${prefix}_wait_ms`] = Math.round(tally.waitMs);
		out[`${prefix}_max_ms`] = Math.round(tally.maxMs);
		if (tally.minStatMs !== undefined) {
			out[`${prefix}_rtt_ms`] = Math.round(tally.minStatMs);
		}
	}
	return out;
}

/**
 * Sentry のサーバ側スクラブ (sensitiveFields) は**キー名の部分一致**で値を消す。ここに無い語でも、
 * 足したキーが null で届いたらまずプロジェクト設定を疑うこと（メモ para-code-sentry-instrumentation-pitfalls の 1）。
 */
const SCRUBBED_WORDS = ['token', 'session', 'command', 'terminal', 'cwd', 'prompt', 'env', 'dsn', 'auth', 'password', 'passwd', 'secret', 'cookie', 'credential', 'bearer', 'key', 'ip'];

/**
 * 切り替えの計測へ足す項目を絞る。通すのは `safe_` で始まる英小文字・数字・`_` だけのキーと、
 * 有限の数値だけ。文字列（パス・ホスト名・ワークスペース名になりうるもの）は型の上でも値の上でも通さない。
 * スクラブされる語を含むキーも落とす（届いても null になり、「起きていない」と読み違えるため）。
 */
export function paradisSafeSwitchAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!/^safe_[a-z0-9_]+$/.test(key) || typeof value !== 'number' || !Number.isFinite(value)) {
			continue;
		}
		const words = key.slice('safe_'.length);
		if (SCRUBBED_WORDS.some(word => words.includes(word))) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

/** テスト用: 時計を差し替える。戻り値で元に戻す。 */
export function paradisOverrideFolderUpdateTraceClockForTest(now: () => number): { dispose(): void } {
	const previous = clock;
	clock = now;
	return { dispose: () => { clock = previous; } };
}
