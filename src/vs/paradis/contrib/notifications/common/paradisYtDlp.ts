/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// YouTube 取り込みが頼る外部の yt-dlp の状態の判定（版・入れ方・失敗の理由・警告）。shared process が集め、
// renderer のダイアログが案内に変える。yt-dlp は同梱せず、利用者の環境の版をそのまま使うため、古い版や
// JS ランタイムの欠けで黙って壊れないよう、ここで見分けて伝える。

/** yt-dlp 自身が「古い」と警告し始める日数（yt-dlp の `older than 90 days` と揃える）。 */
export const PARADIS_YT_DLP_OUTDATED_DAYS = 90;

/**
 * 既知の壊れた版の範囲（`from` 以上 `until` 未満）。2026-08-17 に YouTube が android_vr クライアント 1.65.10 の要求を
 * 拒むようになり、これを既定のクライアントに含む版で HTTP 403 が出る。2026.07.04 だけでなく 2026.06.09 も既定に
 * `('android_vr', 'web_safari')` と 1.65.10 を持つ（Homebrew の 2026.6.9 の `_video.py` / `_base.py` で確認）ため、
 * それより前の版もまとめて壊れた版とみなす。2026.08.19 で android_vr を既定から外して直った。
 */
const KNOWN_BROKEN_RANGES: readonly { readonly from: number; readonly until: number }[] = [
	{ from: 0, until: versionKey(2026, 8, 19) },
];

export interface IParadisYtDlpVersion {
	readonly raw: string;
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

function versionKey(year: number, month: number, day: number): number {
	return year * 10000 + month * 100 + day;
}

/** `yt-dlp --version` の出力（`2026.06.09`、nightly の `2026.08.19.233211`、Homebrew の `2026.6.9` 等）を読む。 */
export function paradisParseYtDlpVersion(output: string): IParadisYtDlpVersion | undefined {
	const match = /^\s*(?<year>\d{4})\.(?<month>\d{1,2})\.(?<day>\d{1,2})(?:\.\d+)?\s*$/m.exec(output);
	if (!match?.groups) {
		return undefined;
	}
	const year = Number(match.groups.year);
	const month = Number(match.groups.month);
	const day = Number(match.groups.day);
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return undefined;
	}
	return { raw: match[0].trim(), year, month, day };
}

export type ParadisYtDlpVersionStatus = 'ok' | 'outdated' | 'broken';

/** 版を、既知の壊れた版か・古すぎるかで判定する。`now` は UNIX ミリ秒。 */
export function paradisAssessYtDlpVersion(version: IParadisYtDlpVersion, now: number): { readonly status: ParadisYtDlpVersionStatus; readonly ageDays: number } {
	const ageDays = Math.max(0, Math.floor((now - Date.UTC(version.year, version.month - 1, version.day)) / 86_400_000));
	const key = versionKey(version.year, version.month, version.day);
	if (KNOWN_BROKEN_RANGES.some(range => key >= range.from && key < range.until)) {
		return { status: 'broken', ageDays };
	}
	return { status: ageDays > PARADIS_YT_DLP_OUTDATED_DAYS ? 'outdated' : 'ok', ageDays };
}

export type ParadisYtDlpInstallMethod = 'homebrew' | 'pipx' | 'uvTool' | 'pip' | 'standalone' | 'unknown';

/**
 * yt-dlp の入れ方を、実体のパス（シンボリックリンクを解いたもの）と先頭の数百バイトから見分ける。順に、Homebrew の
 * Cellar 配下、pipx の venv 配下、`uv tool` の置き場所、`yt_dlp` を import するだけのスクリプト（pip）、それ以外の
 * Homebrew のパスを見る（Homebrew の yt-dlp も中身は import するスクリプトなので、Cellar を先に見る）。残りで名前が
 * yt-dlp のものは公式のリリース（`yt-dlp -U` で自分を更新できる）とみなす。
 */
export function paradisDetectYtDlpInstallMethod(realPath: string, head: string): ParadisYtDlpInstallMethod {
	const normalized = realPath.replace(/\\/g, '/');
	if (/\/Cellar\//i.test(normalized)) {
		return 'homebrew';
	}
	if (/\/pipx\//i.test(normalized)) {
		return 'pipx';
	}
	if (/\/uv\/tools\//i.test(normalized)) {
		return 'uvTool';
	}
	if (/\/(?:site|dist)-packages\//i.test(normalized) || /from\s+yt_dlp\s+import|import\s+yt_dlp/.test(head)) {
		return 'pip';
	}
	if (/\/(?:homebrew|linuxbrew)\//i.test(normalized)) {
		return 'homebrew';
	}
	if (/\/yt-dlp(?:_macos|_linux(?:_aarch64|_armv7l)?|_x86)?(?:\.exe)?$/i.test(normalized)) {
		return 'standalone';
	}
	return 'unknown';
}

export interface IParadisYtDlpUpdatePlan {
	/** 利用者に見せる更新のコマンド。入れ方が分からないときは空。 */
	readonly command: string;
	/** Para Code が利用者の操作で実行してよいか（pip はどの Python か決められないので案内だけ。`command` は例）。 */
	readonly runnable: boolean;
}

export function paradisYtDlpUpdatePlan(method: ParadisYtDlpInstallMethod): IParadisYtDlpUpdatePlan {
	switch (method) {
		case 'homebrew': return { command: 'brew upgrade yt-dlp', runnable: true };
		case 'pipx': return { command: 'pipx upgrade yt-dlp', runnable: true };
		case 'uvTool': return { command: 'uv tool upgrade yt-dlp', runnable: true };
		case 'standalone': return { command: 'yt-dlp -U', runnable: true };
		// どの Python に入れたか決められないので、コマンドは例として見せるだけで実行しない。
		case 'pip': return { command: 'pip install -U "yt-dlp[default]"', runnable: false };
		case 'unknown': return { command: '', runnable: false };
	}
}

/** checkYtDlp が返す yt-dlp の版の状態。 */
export interface IParadisYtDlpStatus {
	readonly version: string;
	readonly status: ParadisYtDlpVersionStatus;
	readonly ageDays: number;
	readonly installMethod: ParadisYtDlpInstallMethod;
	readonly update: IParadisYtDlpUpdatePlan;
}

/** checkYtDlp の結果。 */
export interface IParadisYtDlpCheckResult {
	/** 取り込みに欠かせないのに見つからないもの（yt-dlp / ffmpeg / ffprobe）。 */
	readonly missing: string[];
	/** 無くても動くが、無いと一部の動画が取れなくなるもの（deno）。Para Code は入れず、入れ方を案内する。 */
	readonly optionalMissing: string[];
	/** yt-dlp が見つかり、版が読めたときだけ入る。 */
	readonly ytDlp?: IParadisYtDlpStatus;
}

/** yt-dlp が失敗したときの理由。 */
export type ParadisYtDlpFailure =
	/** HTTP 403。YouTube 側の仕様変更に yt-dlp が追いついていないことが多い（非公開ではない）。 */
	| 'forbidden'
	| 'botCheck'
	| 'ageRestricted'
	| 'membersOnly'
	| 'private'
	| 'unavailable'
	| 'liveNotStarted'
	| 'tooLong'
	/** 取れる形式が無い（JS ランタイムの欠けや古い版で形式が削られたとき）。 */
	| 'noFormats'
	| 'network'
	| 'unknown';

/**
 * `--break-match-filters` で長さの条件に合わなかったときの終了コード（yt-dlp の `YoutubeDL.py` が RejectedVideoReached
 * を投げ、`__init__.py` が DownloadCancelled として 101 を返す）。`--print-json` は出力を絞るため「does not pass filter」の
 * 行は出ず、`--match-filter` だけでは終了コード 0 で何も出ない。どちらも 2026.6.9 で、10 分 34 秒の公開動画を
 * `--simulate` で確かめた。
 */
export const PARADIS_YT_DLP_REJECTED_EXIT_CODE = 101;

/**
 * yt-dlp の失敗の理由を、終了コードと標準エラーから見分ける。`ERROR:` の行を先に見て、それで分からないときだけ全文を
 * 見る（警告の行の語に引きずられないため）。403 を「非公開」と取り違えないよう、HTTP のエラーを先に見る。
 */
export function paradisClassifyYtDlpError(stderr: string, exitCode?: number): ParadisYtDlpFailure {
	if (exitCode === PARADIS_YT_DLP_REJECTED_EXIT_CODE) {
		return 'tooLong';
	}
	const errorLines = stderr.split(/\r?\n/).filter(line => /^\s*ERROR:/.test(line)).join('\n');
	const fromErrors = errorLines ? classifyText(errorLines) : 'unknown';
	return fromErrors !== 'unknown' ? fromErrors : classifyText(stderr);
}

function classifyText(text: string): ParadisYtDlpFailure {
	if (/HTTP Error 403|\b403\b[^\n]*Forbidden/i.test(text)) {
		return 'forbidden';
	}
	if (/Sign in to confirm you(?:'|\u2019)?re not a bot|confirm you are not a bot/i.test(text)) {
		return 'botCheck';
	}
	if (/Sign in to confirm your age|age[- ]restricted|inappropriate for some users/i.test(text)) {
		return 'ageRestricted';
	}
	if (/members[- ]only|Join this channel/i.test(text)) {
		return 'membersOnly';
	}
	if (/Private video/i.test(text)) {
		return 'private';
	}
	if (/live event will begin|Premieres in|is not currently live/i.test(text)) {
		return 'liveNotStarted';
	}
	if (/Video unavailable|This video is not available|has been removed|account associated with this video has been terminated/i.test(text)) {
		return 'unavailable';
	}
	if (/Requested format is not available|No video formats found|Only images are available/i.test(text)) {
		return 'noFormats';
	}
	if (/Unable to download webpage|Failed to resolve|Connection (?:refused|reset)|timed out|getaddrinfo|Temporary failure in name resolution|Network is unreachable/i.test(text)) {
		return 'network';
	}
	return 'unknown';
}

/** yt-dlp の警告のうち、取り込みが壊れる前兆として利用者に伝えるもの。 */
export type ParadisYtDlpPrecursor =
	/** yt-dlp 自身が「古い」と言っている。 */
	| 'outdated'
	/** JS ランタイム（deno）が無く、一部の形式が取れない。 */
	| 'jsRuntime'
	/** 署名・n パラメータの解読に失敗した。 */
	| 'signature'
	/** PO Token が要る形式を飛ばした。 */
	| 'poToken'
	/** SABR の強制で形式が削られた。 */
	| 'sabr';

/** 警告の行（`WARNING:` で始まる行）と、そこから見つけた前兆（重複なし・見つけた順）。 */
export function paradisExtractYtDlpWarnings(stderr: string): { readonly lines: readonly string[]; readonly precursors: readonly ParadisYtDlpPrecursor[] } {
	const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => /^WARNING:/i.test(line));
	const precursors: ParadisYtDlpPrecursor[] = [];
	const add = (precursor: ParadisYtDlpPrecursor) => {
		if (!precursors.includes(precursor)) {
			precursors.push(precursor);
		}
	};
	for (const line of lines) {
		if (/older than \d+ days|yt-dlp version .* is (?:old|outdated)/i.test(line)) {
			add('outdated');
		}
		if (/JavaScript runtime|JS runtime|deno/i.test(line)) {
			add('jsRuntime');
		}
		if (/signature|nsig|n challenge|n parameter|player .*(?:extract|decrypt)/i.test(line)) {
			add('signature');
		}
		if (/PO ?Token|po_token/i.test(line)) {
			add('poToken');
		}
		if (/SABR/.test(line)) {
			add('sabr');
		}
	}
	return { lines, precursors };
}
