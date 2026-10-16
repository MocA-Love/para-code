/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 今いるスペース（PC で開いているもの・スマホで開いているもの）の PR・Issue を使い回す時間。
 * 一覧とスマホのリレーは5分ごとに問い合わせるので、それより少し短くして5分ごとに取り直させる。
 */
export const PARADIS_GITHUB_ACTIVE_SPACE_MAX_AGE_MS = 270_000;

/** それ以外のスペースの PR・Issue を使い回す時間。5分ごとの問い合わせの3回に1回（15分ごと）だけ取り直させる。 */
export const PARADIS_GITHUB_OTHER_SPACE_MAX_AGE_MS = 870_000;

/**
 * 閉じた Issue を使い回す時間。開き直されることはまれなので長く使うが、接続先のサーバーは何日も動き続けるため、
 * 開き直されたときに数時間のうちには戻るよう期限は付ける。
 */
export const PARADIS_GITHUB_CLOSED_ISSUE_MAX_AGE_MS = 2 * 60 * 60_000;

/** 今いるスペースかどうかで、PR・Issue の状態をどれだけ古くても使ってよいかを決める。 */
export function paradisGithubStatusMaxAge(active: boolean): number {
	return active ? PARADIS_GITHUB_ACTIVE_SPACE_MAX_AGE_MS : PARADIS_GITHUB_OTHER_SPACE_MAX_AGE_MS;
}

/**
 * IPC で届いた「どれだけ古くてもよいか」を検証する。指定が無い（古いクライアント）・不正なら今いるスペースと同じに扱い、
 * それ以外のスペースの値より長くは使い回さない。
 */
export function paradisCoerceGithubStatusMaxAge(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return PARADIS_GITHUB_ACTIVE_SPACE_MAX_AGE_MS;
	}
	return Math.max(0, Math.min(PARADIS_GITHUB_OTHER_SPACE_MAX_AGE_MS, value));
}

/**
 * gh で取った PR・Issue の状態を、ウィンドウやスマホのリレーをまたいで使い回すための入れ物。
 * worktree の git チャネル（shared process、接続先ではサーバー）に1つずつ置く。各ウィンドウの一覧と
 * スマホのリレーは同じ worktree をそれぞれの周期で問い合わせるので、ここで束ねないと gh が呼び出し元の数だけ走る。
 *
 * - 呼び出し元が許す古さ（既定は ttlMs）の間は取り直さない。`longLivedMaxAgeMs` が時間を返す値（閉じた Issue）は、
 *   その時間と呼び出し元の古さの長い方まで使う
 * - 同じキーの取得が進行中なら、その結果に相乗りする（同じ周期で同時に来た問い合わせを1本にする）
 * - 期限切れでも最後の値は残す。枠を使い切って取れない間の表示に使う
 */
export class ParadisGithubLookupCache<T> {

	private readonly entries = new Map<string, { readonly value: T; readonly at: number }>();
	private readonly inFlight = new Map<string, Promise<T>>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
		private readonly longLivedMaxAgeMs: (value: T) => number | undefined = () => undefined,
		private readonly now: () => number = Date.now,
	) { }

	/** `maxAgeMs`（長く使う値ならその時間）より新しければ返す（undefined を値として持てるよう包んで返す）。 */
	getFresh(key: string, maxAgeMs: number = this.ttlMs): { readonly value: T } | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		const maxAge = Math.max(maxAgeMs, this.longLivedMaxAgeMs(entry.value) ?? 0);
		return this.now() - entry.at < maxAge ? { value: entry.value } : undefined;
	}

	/** 期限に関わらず、最後に取れた値。 */
	getLast(key: string): { readonly value: T } | undefined {
		const entry = this.entries.get(key);
		return entry === undefined ? undefined : { value: entry.value };
	}

	set(key: string, value: T): void {
		// 入れ直して末尾（新しい側）へ回し、上限を超えたら古い側から捨てる
		this.entries.delete(key);
		this.entries.set(key, { value, at: this.now() });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
	}

	/** 条件に合うキーを捨てる（マージした PR のように、状態が変わったと分かったもの）。 */
	deleteWhere(predicate: (key: string) => boolean): void {
		for (const key of [...this.entries.keys()]) {
			if (predicate(key)) {
				this.entries.delete(key);
			}
		}
	}

	/** 同じキーの取得が進行中ならそれを待ち、無ければ `fetch` を始める。 */
	dedupe(key: string, fetch: () => Promise<T>): Promise<T> {
		const running = this.inFlight.get(key);
		if (running !== undefined) {
			return running;
		}
		const promise = fetch().finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}
}
