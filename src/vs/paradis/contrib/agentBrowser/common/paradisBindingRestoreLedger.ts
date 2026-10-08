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
}

/** 台帳に残す件数の上限。 */
export const PARADIS_BINDING_RESTORE_MAX_ENTRIES = 64;

/** これより古い記録は張り直さない（長く開いていなかったワークスペースで、急に共有が戻らないように）。 */
export const PARADIS_BINDING_RESTORE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** 共有が続いている組の時刻を書き直す間隔。{@link PARADIS_BINDING_RESTORE_MAX_AGE_MS} より十分短くする。 */
export const PARADIS_BINDING_RESTORE_REFRESH_MS = 24 * 60 * 60_000;

const KEY_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PAGE_ID_LENGTH = 512;

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
		const entry = value as { pageId?: unknown; at?: unknown; more?: unknown } | null;
		if (!KEY_PATTERN.test(key) || !entry || typeof entry !== 'object'
			|| !isPageId(entry.pageId)
			|| typeof entry.at !== 'number' || !Number.isFinite(entry.at) || now - entry.at > PARADIS_BINDING_RESTORE_MAX_AGE_MS) {
			continue;
		}
		const more = paradisNormalizeMorePages(entry.pageId, Array.isArray(entry.more) ? entry.more.filter(isPageId) : []);
		result.set(key, more.length > 0 ? { pageId: entry.pageId, at: entry.at, more } : { pageId: entry.pageId, at: entry.at });
	}
	return paradisTrimBindingRestoreLedger(result);
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
 * - このウィンドウのペインの紐づけは、今のものだけを残す（ユーザーが外した・ページを閉じた・ペインが消えた
 *   ものは消える）
 * - まだ張り直しを決めていない起動時の記録（`pendingKeys`）は消さない（起動直後は紐づけが空なので、
 *   そのまま書くと張り直す前に台帳が消える。ペインやページが別のスペースにあって今回は試せなかったものも残す）
 *
 * @param boundPageByKey このウィンドウの生きているペインのうち、紐づいているもの（キー → current のページの ID）
 * @param morePagesByKey そのペインが 2 枚目以降に共有しているページ（キー → 古い順のページの ID）
 */
export function paradisNextBindingRestoreLedger(
	previous: ReadonlyMap<string, IParadisBindingRestoreEntry>,
	pendingKeys: ReadonlySet<string>,
	boundPageByKey: ReadonlyMap<string, string>,
	now: number,
	morePagesByKey: ReadonlyMap<string, readonly string[]> = new Map(),
): Map<string, IParadisBindingRestoreEntry> {
	const next = new Map<string, IParadisBindingRestoreEntry>();
	for (const [key, pageId] of boundPageByKey) {
		const more = paradisNormalizeMorePages(pageId, morePagesByKey.get(key) ?? []);
		// 同じ組の時刻は、古くなるまで書き直さない（評価のたびに storage へ書かないため）
		const kept = previous.get(key);
		const same = kept !== undefined && kept.pageId === pageId && (kept.more ?? []).join('\n') === more.join('\n');
		next.set(key, same && now - kept.at < PARADIS_BINDING_RESTORE_REFRESH_MS ? kept : more.length > 0 ? { pageId, at: now, more } : { pageId, at: now });
	}
	for (const key of pendingKeys) {
		const entry = previous.get(key);
		if (entry !== undefined && !next.has(key)) {
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
}

/**
 * まだ試していない記録のうち、今張り直せるもの（同じトークンのペインが生きていて、まだ紐づいておらず、
 * 同じページがこのウィンドウにある）。ペインやページがまだ復元されていない記録は候補にしない（後で再び見る）。
 *
 * @param liveTokenByKey このウィンドウの生きているペイン（キー → トークン）
 * @param boundKeys 今紐づいているペインのキー
 * @param knownPageIds このウィンドウにあるページの ID
 */
export function paradisBindingRestoreCandidates(
	ledger: ReadonlyMap<string, IParadisBindingRestoreEntry>,
	pendingKeys: ReadonlySet<string>,
	liveTokenByKey: ReadonlyMap<string, string>,
	boundKeys: ReadonlySet<string>,
	knownPageIds: ReadonlySet<string>,
): IParadisBindingRestoreCandidate[] {
	const candidates: IParadisBindingRestoreCandidate[] = [];
	for (const key of pendingKeys) {
		const entry = ledger.get(key);
		const token = liveTokenByKey.get(key);
		if (entry === undefined || token === undefined || boundKeys.has(key)) {
			continue;
		}
		// current のページが無くなっていたら、2 枚目以降のうち最後に共有した生きているページを current にする
		const alive = [...(entry.more ?? []), entry.pageId].filter(pageId => knownPageIds.has(pageId));
		const pageId = alive.pop();
		if (pageId === undefined) {
			continue;
		}
		candidates.push({ key, token, pageId, morePageIds: alive });
	}
	return candidates;
}
