/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページの共有（ペイン ⇔ ページの紐づけ）を再起動の後に張り直すための台帳。
//
// 紐づけの実体は shared process のメモリにしか無く、再起動で消える。ペイントークン（シェルの nonce から
// 決まる）とブラウザのページの ID（エディタの復元で同じ値に戻る）は再起動の後も同じなので、その組を
// WORKSPACE の storage に控え、起動後に同じ組だけを既存の共有の経路で張り直す。
//
// 行は、共有が続いている間は今の状態で書き直し、共有が外れても残す（一覧からの欠落・窓の消滅のように勝手に
// 外れたものを、後で同じ組へ戻すため）。行を消すのは、利用者が共有を外したとき・端末が終わったとき・戻せないと
// 分かったときで、消す側（paradisBindingRestoreController.ts）が決める。
//
// ページのオリジン（共有していた間の最後のもの）も控える。戻すときにページが別のサイトへ移っていたら戻さない。
// オリジンの無い行（この項目を足す前の版が書いた行）は確かめられないので戻さない。
//
// 1 つのペインは複数のページを共有できる。current のページを `pageId` に、2 枚目以降を `more`（古い順）に控え、
// 張り直すときは `more` を古い順に共有してから `pageId` を共有する（最後に共有したものが current になる）。
//
// トークンはそのまま保存しない（ペインの識別子で、MCP の Bearer にもなる）。ハッシュにして、生きている
// ペインのトークンから同じハッシュを作って突き合わせる。

import { StringSHA1 } from '../../../../base/common/hash.js';
import { PARADIS_USER_SHARED_PAGE_LIMIT } from './paradisAgentBrowserTabs.js';

/** 台帳の1件。キーはトークンのハッシュ。 */
export interface IParadisBindingRestoreEntry {
	/** ブラウザのページ（BrowserView）の ID。 */
	readonly pageId: string;
	/** 最後に紐づいているのを見た時刻（古いものを捨てるため）。 */
	readonly at: number;
	/** そのペインへ 2 枚目以降に共有していたページ（古い順。current の `pageId` は含まない）。 */
	readonly more?: readonly string[];
	/** 共有していた間の最後のオリジン（ページの ID → オリジン）。外れた後は書き直さない。 */
	readonly origins?: Readonly<Record<string, string>>;
}

/** 台帳に残す件数の上限。 */
export const PARADIS_BINDING_RESTORE_MAX_ENTRIES = 64;

/** これより古い記録は張り直さない（長く開いていなかったワークスペースで、急に共有が戻らないように）。 */
export const PARADIS_BINDING_RESTORE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** 共有が続いている組の時刻を書き直す間隔。{@link PARADIS_BINDING_RESTORE_MAX_AGE_MS} より十分短くする。 */
export const PARADIS_BINDING_RESTORE_REFRESH_MS = 24 * 60 * 60_000;

const KEY_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PAGE_ID_LENGTH = 512;
const MAX_ORIGIN_LENGTH = 512;

/**
 * 照合に使うオリジン（スキームとホスト・ポート）。`file:` や `about:` のようにホストの無い URL は
 * スキームだけになる（パスは比べない）。読めない URL は undefined（照合できないので戻さない）。
 */
export function paradisBindingRestoreOrigin(url: string | undefined): string | undefined {
	if (url === undefined || url.length === 0) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
		return origin.length <= MAX_ORIGIN_LENGTH ? origin : undefined;
	} catch {
		return undefined;
	}
}

/** トークンから台帳のキーを作る。読めても元のトークンに戻せなければよく、衝突への強さは要らない。 */
export function paradisBindingRestoreKey(token: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-binding-restore:${token}`);
	return sha.digest();
}

/** storage の文字列から台帳を読む。壊れた行・古い行は捨てる。 */
export function paradisParseBindingRestoreLedger(raw: string | undefined, now: number): Map<string, IParadisBindingRestoreEntry> {
	const result = new Map<string, IParadisBindingRestoreEntry>();
	if (raw === undefined) {
		return result;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return result;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return result;
	}
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = value as { pageId?: unknown; at?: unknown; more?: unknown; origins?: unknown } | null;
		if (!KEY_PATTERN.test(key) || !entry || typeof entry !== 'object'
			|| !isPageId(entry.pageId)
			|| typeof entry.at !== 'number' || !Number.isFinite(entry.at) || now - entry.at > PARADIS_BINDING_RESTORE_MAX_AGE_MS) {
			continue;
		}
		const more = paradisNormalizeMorePages(entry.pageId, Array.isArray(entry.more) ? entry.more.filter(isPageId) : []);
		const stored = entry.origins && typeof entry.origins === 'object' && !Array.isArray(entry.origins) ? entry.origins as Record<string, unknown> : {};
		const origins = new Map<string, string>();
		for (const pageId of [...more, entry.pageId]) {
			const origin = Object.hasOwn(stored, pageId) ? stored[pageId] : undefined;
			if (typeof origin === 'string' && origin.length > 0 && origin.length <= MAX_ORIGIN_LENGTH) {
				origins.set(pageId, origin);
			}
		}
		result.set(key, makeEntry(entry.pageId, entry.at, more, origins));
	}
	return paradisTrimBindingRestoreLedger(result);
}

function makeEntry(pageId: string, at: number, more: readonly string[], originByPageId: ReadonlyMap<string, string>): IParadisBindingRestoreEntry {
	const origins: Record<string, string> = {};
	for (const candidate of [...more, pageId]) {
		const origin = originByPageId.get(candidate);
		if (origin !== undefined) {
			origins[candidate] = origin;
		}
	}
	return {
		pageId,
		at,
		...(more.length > 0 ? { more } : {}),
		...(Object.keys(origins).length > 0 ? { origins } : {}),
	};
}

/**
 * 行から 1 ページを外す。current を外したら、残りのうち最後に共有したものが current になる。
 * ページが残らなければ undefined。
 */
export function paradisRemovePageFromBindingRestoreEntry(entry: IParadisBindingRestoreEntry, pageId: string): IParadisBindingRestoreEntry | undefined {
	const pages = [...(entry.more ?? []), entry.pageId].filter(candidate => candidate !== pageId);
	const current = pages.pop();
	if (current === undefined) {
		return undefined;
	}
	return makeEntry(current, entry.at, pages, new Map(Object.entries(entry.origins ?? {})));
}

function isPageId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_PAGE_ID_LENGTH;
}

/** 2 枚目以降のページを、重複と current を除き、新しい方から共有の上限に収まるだけ残す（古い順のまま）。 */
function paradisNormalizeMorePages(pageId: string, more: readonly string[]): string[] {
	const result: string[] = [];
	for (const candidate of [...more].reverse()) {
		if (candidate !== pageId && !result.includes(candidate) && result.length < PARADIS_USER_SHARED_PAGE_LIMIT - 1) {
			result.unshift(candidate);
		}
	}
	return result;
}

/** 新しいものから上限まで残す。 */
export function paradisTrimBindingRestoreLedger(ledger: ReadonlyMap<string, IParadisBindingRestoreEntry>): Map<string, IParadisBindingRestoreEntry> {
	return new Map([...ledger].sort((a, b) => b[1].at - a[1].at).slice(0, PARADIS_BINDING_RESTORE_MAX_ENTRIES));
}

export function paradisSerializeBindingRestoreLedger(ledger: ReadonlyMap<string, IParadisBindingRestoreEntry>): string {
	return JSON.stringify(Object.fromEntries(paradisTrimBindingRestoreLedger(ledger)));
}

/**
 * 今の紐づけから次の台帳を作る。
 *
 * - 共有が続いているペインの行は、今の状態（ページとそのオリジン）で書き直す
 * - 共有が無いペインの行はそのまま残す（起動直後でまだ張り直していないもの、勝手に外れたもの、ペインや
 *   ページがまだ戻っていないもの）。時刻も書き直さないので、戻らないまま古くなった行は読むときに捨てられる
 *
 * @param boundPageByKey このウィンドウの生きているペインのうち、紐づいているもの（キー → current のページの ID）
 * @param morePagesByKey そのペインが 2 枚目以降に共有しているページ（キー → 古い順のページの ID）
 * @param originByPageId ページの今のオリジン（分からないページは入れない）
 */
export function paradisNextBindingRestoreLedger(
	previous: ReadonlyMap<string, IParadisBindingRestoreEntry>,
	boundPageByKey: ReadonlyMap<string, string>,
	now: number,
	morePagesByKey: ReadonlyMap<string, readonly string[]> = new Map(),
	originByPageId: ReadonlyMap<string, string> = new Map(),
): Map<string, IParadisBindingRestoreEntry> {
	const next = new Map<string, IParadisBindingRestoreEntry>();
	for (const [key, pageId] of boundPageByKey) {
		const more = paradisNormalizeMorePages(pageId, morePagesByKey.get(key) ?? []);
		const fresh = makeEntry(pageId, now, more, originByPageId);
		// 同じ内容の行の時刻は、古くなるまで書き直さない（評価のたびに storage へ書かないため）
		const kept = previous.get(key);
		const same = kept !== undefined && JSON.stringify({ ...kept, at: 0 }) === JSON.stringify({ ...fresh, at: 0 });
		next.set(key, same && now - kept.at < PARADIS_BINDING_RESTORE_REFRESH_MS ? kept : fresh);
	}
	for (const [key, entry] of previous) {
		if (!next.has(key)) {
			next.set(key, entry);
		}
	}
	return paradisTrimBindingRestoreLedger(next);
}

/** 張り直す候補の1件。 */
export interface IParadisBindingRestoreCandidate {
	readonly key: string;
	readonly token: string;
	/** current として戻すページ（最後に共有する）。 */
	readonly pageId: string;
	/** 先に共有する 2 枚目以降のページ（古い順。このウィンドウにあるものだけ）。 */
	readonly morePageIds: readonly string[];
	/** 行に控えたオリジン（ページの ID → オリジン）。ページを開いた後にもう一度照合する。 */
	readonly origins: Readonly<Record<string, string>>;
}

/** 戻さないと決まったページ。`moved` は別のサイトへ移っていた、`unverified` は行にオリジンが無く確かめられない。 */
export interface IParadisBindingRestoreDroppedPage {
	readonly key: string;
	readonly pageId: string;
	readonly reason: 'moved' | 'unverified';
}

/**
 * 共有が無い行のうち、今張り直せるもの（同じトークンのペインが生きていて、まだ紐づいておらず、同じページが
 * このウィンドウにあり、ページのオリジンが控えと同じ）。ペインやページがまだ復元されていない行は候補にしない
 * （後で再び見る）。オリジンが違う・控えに無いページは `dropped` に入れる（呼び出し側が行から外す）。
 *
 * @param liveTokenByKey このウィンドウの生きているペイン（キー → トークン）
 * @param boundKeys 今紐づいているペインのキー
 * @param knownPageIds このウィンドウにあるページの ID
 * @param originOf ページの今のオリジン（まだ分からなければ undefined。そのページは後で再び見る）
 */
export function paradisBindingRestoreCandidates(
	ledger: ReadonlyMap<string, IParadisBindingRestoreEntry>,
	liveTokenByKey: ReadonlyMap<string, string>,
	boundKeys: ReadonlySet<string>,
	knownPageIds: ReadonlySet<string>,
	originOf: (pageId: string) => string | undefined,
): { candidates: IParadisBindingRestoreCandidate[]; dropped: IParadisBindingRestoreDroppedPage[] } {
	const candidates: IParadisBindingRestoreCandidate[] = [];
	const dropped: IParadisBindingRestoreDroppedPage[] = [];
	for (const [key, entry] of ledger) {
		const token = liveTokenByKey.get(key);
		if (token === undefined || boundKeys.has(key)) {
			continue;
		}
		const alive: string[] = [];
		for (const pageId of [...(entry.more ?? []), entry.pageId]) {
			const origin = knownPageIds.has(pageId) ? originOf(pageId) : undefined;
			if (origin === undefined) {
				continue;
			}
			const recorded = entry.origins && Object.hasOwn(entry.origins, pageId) ? entry.origins[pageId] : undefined;
			if (recorded === origin) {
				alive.push(pageId);
			} else {
				dropped.push({ key, pageId, reason: recorded === undefined ? 'unverified' : 'moved' });
			}
		}
		// current のページが無くなっていたら、2 枚目以降のうち最後に共有した生きているページを current にする
		const pageId = alive.pop();
		if (pageId === undefined) {
			continue;
		}
		candidates.push({ key, token, pageId, morePageIds: alive, origins: entry.origins ?? {} });
	}
	return { candidates, dropped };
}
