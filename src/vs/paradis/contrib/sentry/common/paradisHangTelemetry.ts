/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 固まり（window と拡張ホスト）の Sentry への報告で共有するもの: 送る数の上限、スタックから作る束ねる鍵、
// 固まってから戻るまでの 1 回の数え方。

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { getParadisUnresponsiveSample } from '../../../../platform/windows/common/paradisUnresponsiveSample.js';

/** 10 分にこれだけ。 */
const WINDOW_MS = 10 * 60 * 1_000;
const MAX_PER_WINDOW = 3;
/** 1 起動（プロセスの寿命）でこれだけ。 */
const MAX_PER_LAUNCH = 20;

/**
 * 固まりの報告を送ってよいか。指紋ごとの「10 分 3 件」（paradisSentryEvent.ts）は、束ねる鍵が違えば別に数えるので、
 * 固まりの報告全体にもこの上限をかける。固まりが続く人から送りすぎないため。
 */
export class ParadisHangReportBudget {
	private readonly sentAt: number[] = [];
	private sentTotal = 0;
	private skipped = 0;

	constructor(private readonly now: () => number = Date.now) { }

	/** 送ってよければ true（数える）。断ったら数えない。`skipped` は断った数の累計。 */
	take(): { readonly allowed: boolean; readonly skipped: number } {
		const current = this.now();
		while (this.sentAt.length > 0 && current - this.sentAt[0] >= WINDOW_MS) {
			this.sentAt.shift();
		}
		if (this.sentTotal >= MAX_PER_LAUNCH || this.sentAt.length >= MAX_PER_WINDOW) {
			this.skipped++;
			return { allowed: false, skipped: this.skipped };
		}
		this.sentAt.push(current);
		this.sentTotal++;
		return { allowed: true, skipped: this.skipped };
	}
}

/**
 * window の固まり（upstream の UnresponsiveSampleError）の報告の項目。`unresponsiveSince` は Electron が固まりを
 * 知らせた時刻、`skipped` は上限で送らなかった数。
 */
export function paradisWindowHangSafeExtra(error: unknown, unresponsiveSince: number | undefined, now: number, skipped: number): Record<`safe_${string}`, number> {
	const sample = getParadisUnresponsiveSample(error);
	return {
		...(sample !== undefined ? {
			safe_hang_samples: sample.samples,
			safe_hang_sample_pct: sample.expectedSamples > 0 ? Math.round(sample.samples * 100 / sample.expectedSamples) : 0,
		} : {}),
		// Electron が固まりを知らせてから、upstream がスタックを取り終えるまで（戻ったとき・15 秒・window を閉じたとき）
		...(unresponsiveSince !== undefined ? { safe_hang_ms: Math.max(0, now - unresponsiveSince) } : {}),
		...(skipped > 0 ? { safe_hang_reports_skipped: skipped } : {}),
	};
}

/** 鍵に使うフレームの数。 */
const KEY_FRAMES = 5;
/** `at f (url:1:2)` / `at url:1:2` の位置（url は空白を含みうる: `Para Code.app`）。 */
const frameLocation = /^\s*at (?:[^(]*\()?(?<location>[^()]+?):(?<line>\d+):(?<column>\d+)\)?\s*$/;

/**
 * 呼び出し履歴の先頭 {@link KEY_FRAMES} フレームの「ファイル名:行:列」から作る鍵（FNV-1a 32 bit の 16 進 8 桁）。
 * パッケージ版はどのフレームも 1 本の bundle の中で関数名も縮められるので、Sentry の指紋だけではどの固まりも 1 つの
 * issue に寄る。行と列は bundle の中の位置なので、同じ版の同じ場所の固まりだけが同じ鍵になる。ファイル名は最後の
 * 区切りの後ろだけを使い（置き場所を含めない）、鍵はハッシュなので中身は送らない。位置のあるフレームが無ければ undefined。
 */
export function paradisHangStackKey(stack: string): string | undefined {
	const parts: string[] = [];
	for (const line of stack.split('\n')) {
		const match = frameLocation.exec(line.length > 1_000 ? line.slice(0, 1_000) : line);
		if (!match?.groups) {
			continue;
		}
		const location = match.groups.location.replace(/[?#].*$/, '');
		const fileName = location.slice(Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\')) + 1);
		parts.push(`${fileName}:${match.groups.line}:${match.groups.column}`);
		if (parts.length >= KEY_FRAMES) {
			break;
		}
	}
	if (parts.length === 0) {
		return undefined;
	}
	const text = parts.join('|');
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** 戻らないまま、これだけ経ったら送る（戻らずに終わった固まりも 1 件にするため）。 */
export const PARADIS_HANG_REPORT_AFTER_MS = 30_000;

/** 1 回の固まりの報告の項目。 */
export interface IParadisHangEpisode {
	/** 固まりを知らされてから、戻るか {@link PARADIS_HANG_REPORT_AFTER_MS} が経つまで。 */
	readonly safe_hang_ms: number;
	/** 戻ってから送ったか（false なら {@link PARADIS_HANG_REPORT_AFTER_MS} の時点でまだ固まっていた）。 */
	readonly safe_hang_recovered: boolean;
}

/**
 * 応答なし → 応答ありを 1 回の固まりとして数え、1 回につき 1 度だけ `report` を呼ぶ。戻ったときに呼び、戻らなければ
 * {@link PARADIS_HANG_REPORT_AFTER_MS} の時点で呼ぶ（その後に戻っても呼ばない）。
 */
export class ParadisHangEpisodeTracker extends Disposable {
	private startedAt: number | undefined;
	private reported = false;
	private readonly timer = this._register(new MutableDisposable());

	constructor(private readonly report: (episode: IParadisHangEpisode) => void, private readonly now: () => number = Date.now) {
		super();
	}

	setResponsive(responsive: boolean): void {
		if (!responsive) {
			// 知らせは状態が変わったときだけ来る。送った後に戻らないまま次の「応答なし」が来たら（拡張ホストが作り直された）、新しい 1 回として数える
			if (this.startedAt !== undefined && !this.reported) {
				return;
			}
			this.startedAt = this.now();
			this.reported = false;
			this.timer.value = disposableTimeout(() => this.finish(false), PARADIS_HANG_REPORT_AFTER_MS);
			return;
		}
		if (this.startedAt === undefined) {
			return;
		}
		if (!this.reported) {
			this.finish(true);
		}
		this.startedAt = undefined;
		this.timer.clear();
	}

	private finish(recovered: boolean): void {
		if (this.startedAt === undefined || this.reported) {
			return;
		}
		this.reported = true;
		this.report({ safe_hang_ms: Math.max(0, this.now() - this.startedAt), safe_hang_recovered: recovered });
	}
}
