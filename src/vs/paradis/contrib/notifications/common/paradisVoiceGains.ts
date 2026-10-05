/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定の「音量の補正」ページが、この PC の aivis-mcp（2.5.4 以上）の音量の表を扱うための共有定義。
// 実行は shared process の node 側（node/paradisVoiceGainsService.ts）。
//
// aivis-mcp 2.5.4 の取り決め:
//   aivis-mcp --list-gains --json
//     → {"version":1,"target":-20,"learnWindow":9,"minLearnSeconds":2.5,"entries":[{"key","provider","voice","model","gainDb","sampleCount","updatedAt"}]}
//   aivis-mcp --reset-gain --key <key>                       → `ok`
//   aivis-mcp --export-gains <file> --json                   → {"ok":true,"written":N}
//   aivis-mcp --import-gains <file> [--overwrite] --json     → {"ok":true,"added":N,"updated":N,"skipped":N,"evicted":N,"dropped":N}
//   aivis-mcp --set-gain-learning [--window N] [--min-seconds S]  → `ok`
// 失敗は標準エラーに `error: <理由>` で終了 1。
//
// `--list-gains` の行には、学習した行のほかに aivis-mcp が最初から持つ値だけの行（`sampleCount: 0`・
// `updatedAt: null`）も入る。`learnWindow` / `minLearnSeconds` は CLI を動かしたプロセスの環境変数 >
// config.json > 既定で決まるので、worker を起こしたプロセスの環境変数と違うと worker の値とずれることがある。

export const PARADIS_VOICE_GAINS_CHANNEL = 'paradisVoiceGains';

/** 音量の表を扱う引数を持つ aivis-mcp の版。 */
export const PARADIS_VOICE_GAINS_MIN_VERSION: readonly [number, number, number] = [2, 5, 4];

/** 学習の窓に指定できる範囲（aivis-mcp の MIN/MAX_LEARN_WINDOW・MIN_LEARN_SECONDS_LOWER/UPPER）。 */
export const PARADIS_GAIN_LEARN_WINDOW_MIN = 1;
export const PARADIS_GAIN_LEARN_WINDOW_MAX = 50;
export const PARADIS_GAIN_MIN_SECONDS_LOWER = 0.5;
export const PARADIS_GAIN_MIN_SECONDS_UPPER = 30;

/** 表の 1 行（声とモデルの組）。 */
export interface IParadisVoiceGainEntry {
	readonly key: string;
	readonly provider: string;
	readonly voice: string;
	readonly model: string;
	/** 今の補正（dB）。読めなければ undefined。 */
	readonly gainDb: number | undefined;
	/** 覚えている測定の数（窓より多いことがある）。aivis-mcp が最初から持つ値だけの行は 0。 */
	readonly sampleCount: number;
	/** 最後に測った時刻（epoch ms）。 */
	readonly updatedAt: number | undefined;
}

export interface IParadisVoiceGainList {
	readonly target: number | undefined;
	readonly learnWindow: number;
	readonly minLearnSeconds: number;
	readonly entries: readonly IParadisVoiceGainEntry[];
}

export interface IParadisVoiceGainImportResult {
	readonly added: number;
	readonly updated: number;
	readonly skipped: number;
	readonly evicted: number;
	/** 表の上限で入らなかった、ファイルの行。 */
	readonly dropped: number;
}

/** node 側の返事。古い・無い aivis-mcp は `unsupported`（`version` は読めた版）。 */
export type ParadisVoiceGainsResult<T> =
	| { readonly status: 'ok'; readonly value: T }
	| { readonly status: 'unsupported'; readonly version: string | undefined }
	| { readonly status: 'failed'; readonly message: string };

/** aivis-mcp の `--reset-gain --key` が受け付ける鍵の文字と長さ。 */
const KEY = /^[A-Za-z0-9:_.-]{1,200}$/;

/**
 * 鍵を `provider:voice:model` に分ける（aivis-mcp の splitKey と同じく、最初と最後の `:` で切る。
 * voice に `:` が入っていてもよい）。分けられなければ undefined。
 */
export function paradisSplitVoiceGainKey(key: string): { readonly provider: string; readonly voice: string; readonly model: string } | undefined {
	const first = key.indexOf(':');
	const last = key.lastIndexOf(':');
	if (first <= 0 || last <= first || last === key.length - 1) {
		return undefined;
	}
	return { provider: key.slice(0, first), voice: key.slice(first + 1, last), model: key.slice(last + 1) };
}

/** aivis-mcp の音量の表の鍵の形か（`provider:voice:model`。`--reset-gain --key` が受け付けるもの）。 */
export function paradisIsVoiceGainKey(key: string): boolean {
	return KEY.test(key) && paradisSplitVoiceGainKey(key) !== undefined;
}

/** aivis-mcp が最初から持つ値だけの行か（まだ一度も測っていない）。 */
export function paradisIsInitialVoiceGain(entry: Pick<IParadisVoiceGainEntry, 'sampleCount' | 'updatedAt'>): boolean {
	return entry.sampleCount === 0 && entry.updatedAt === undefined;
}

/**
 * ファイルの引数として渡してよい絶対パスか。制御文字を含むもの・相対パスは拒む。Windows は cmd.exe を
 * 通すので、cmd.exe が特別に読む文字（`"` `%` `^` `&` `|` `<` `>` `!`）を含むものも拒む。
 */
export function paradisIsSafeAivisMcpPath(path: string, platform: string): boolean {
	if (!path || path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) {
		return false;
	}
	if (platform === 'win32') {
		return /^[A-Za-z]:\\/.test(path) && !/["%^&|<>!]/.test(path);
	}
	return path.startsWith('/');
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
	const number = finiteNumber(value);
	return number !== undefined && number >= 0 ? Math.floor(number) : 0;
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout.trim());
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** `--list-gains --json` の出力を読む。形が違えば undefined。`provider:voice:model` に分けられない行は捨てる。 */
export function paradisParseVoiceGainList(stdout: string): IParadisVoiceGainList | undefined {
	const json = parseJson(stdout);
	if (!json || !Array.isArray(json.entries)) {
		return undefined;
	}
	const learnWindow = finiteNumber(json.learnWindow);
	const minLearnSeconds = finiteNumber(json.minLearnSeconds);
	const entries: IParadisVoiceGainEntry[] = [];
	for (const raw of json.entries) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const value = raw as Record<string, unknown>;
		// 表示は aivis-mcp が読む行（300 文字まで）をすべて出す。やり直せるかは paradisIsVoiceGainKey で別に見る
		const key = typeof value.key === 'string' && value.key.length <= 300 ? value.key : '';
		const parts = paradisSplitVoiceGainKey(key);
		if (!parts) {
			continue;
		}
		entries.push({
			key,
			provider: typeof value.provider === 'string' && value.provider ? value.provider : parts.provider,
			voice: typeof value.voice === 'string' && value.voice ? value.voice : parts.voice,
			model: typeof value.model === 'string' && value.model ? value.model : parts.model,
			gainDb: finiteNumber(value.gainDb),
			sampleCount: count(value.sampleCount),
			updatedAt: finiteNumber(value.updatedAt),
		});
	}
	return {
		target: finiteNumber(json.target),
		learnWindow: learnWindow !== undefined && learnWindow >= 1 ? Math.floor(learnWindow) : 9,
		minLearnSeconds: minLearnSeconds !== undefined && minLearnSeconds > 0 ? minLearnSeconds : 2.5,
		entries,
	};
}

/** `--export-gains --json` の出力（書き出した行の数）。形が違えば undefined。 */
export function paradisParseVoiceGainExport(stdout: string): number | undefined {
	const json = parseJson(stdout);
	return json?.ok === true ? count(json.written) : undefined;
}

/** `--import-gains --json` の出力。形が違えば undefined。 */
export function paradisParseVoiceGainImport(stdout: string): IParadisVoiceGainImportResult | undefined {
	const json = parseJson(stdout);
	if (json?.ok !== true) {
		return undefined;
	}
	return { added: count(json.added), updated: count(json.updated), skipped: count(json.skipped), evicted: count(json.evicted), dropped: count(json.dropped) };
}

export function paradisListVoiceGainsArgs(): string[] {
	return ['--list-gains', '--json'];
}

export function paradisResetVoiceGainArgs(key: string): string[] | undefined {
	// `-` で始まる鍵は次の引数の名前と取り違えられるので渡さない
	return paradisIsVoiceGainKey(key) && !key.startsWith('-') ? ['--reset-gain', '--key', key] : undefined;
}

export function paradisExportVoiceGainsArgs(path: string, platform: string): string[] | undefined {
	return paradisIsSafeAivisMcpPath(path, platform) ? ['--export-gains', path, '--json'] : undefined;
}

export function paradisImportVoiceGainsArgs(path: string, overwrite: boolean, platform: string): string[] | undefined {
	return paradisIsSafeAivisMcpPath(path, platform) ? ['--import-gains', path, ...(overwrite ? ['--overwrite'] : []), '--json'] : undefined;
}

/** 学習の窓を変える引数。範囲外・整数でない回数は undefined（どちらも無いときも）。 */
export function paradisSetGainLearningArgs(window: number | undefined, minSeconds: number | undefined): string[] | undefined {
	const args = ['--set-gain-learning'];
	if (window !== undefined) {
		if (!Number.isInteger(window) || window < PARADIS_GAIN_LEARN_WINDOW_MIN || window > PARADIS_GAIN_LEARN_WINDOW_MAX) {
			return undefined;
		}
		args.push('--window', String(window));
	}
	if (minSeconds !== undefined) {
		if (!Number.isFinite(minSeconds) || minSeconds < PARADIS_GAIN_MIN_SECONDS_LOWER || minSeconds > PARADIS_GAIN_MIN_SECONDS_UPPER) {
			return undefined;
		}
		args.push('--min-seconds', String(Math.round(minSeconds * 100) / 100));
	}
	return args.length > 1 ? args : undefined;
}

/** aivis-mcp のエラー出力の 1 行目（`error: ` を外す）。 */
export function paradisAivisMcpErrorMessage(stderr: string): string {
	const line = stderr.trim().split(/\r?\n/, 1)[0] ?? '';
	return line.replace(/^error:\s*/i, '').slice(0, 300);
}

/** 表の行の学習の進み（窓までで打ち切る）と、窓に届いていないか。 */
export function paradisVoiceGainProgress(entry: Pick<IParadisVoiceGainEntry, 'sampleCount'>, learnWindow: number): { readonly done: number; readonly learning: boolean } {
	const window = Math.max(1, learnWindow);
	const done = Math.min(entry.sampleCount, window);
	return { done, learning: done < window };
}
