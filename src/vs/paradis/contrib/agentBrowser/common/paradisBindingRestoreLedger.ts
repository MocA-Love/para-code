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
// トークンはそのまま保存しない（ペインの識別子で、MCP の Bearer にもなる）。ハッシュにして、生きている
// ペインのトークンから同じハッシュを作って突き合わせる。

import { StringSHA1 } from '../../../../base/common/hash.js';

/** 台帳の1件。キーはトークンのハッシュ。 */
export interface IParadisBindingRestoreEntry {
	/** ブラウザのページ（BrowserView）の ID。 */
	readonly pageId: string;
	/** 最後に紐づいているのを見た時刻（古いものを捨てるため）。 */
	readonly at: number;
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
		const entry = value as { pageId?: unknown; at?: unknown } | null;
		if (!KEY_PATTERN.test(key) || !entry || typeof entry !== 'object'
			|| typeof entry.pageId !== 'string' || entry.pageId.length === 0 || entry.pageId.length > MAX_PAGE_ID_LENGTH
			|| typeof entry.at !== 'number' || !Number.isFinite(entry.at) || now - entry.at > PARADIS_BINDING_RESTORE_MAX_AGE_MS) {
			continue;
		}
		result.set(key, { pageId: entry.pageId, at: entry.at });
	}
	return paradisTrimBindingRestoreLedger(result);
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
 * @param boundPageByKey このウィンドウの生きているペインのうち、紐づいているもの（キー → ページの ID）
 */
export function paradisNextBindingRestoreLedger(
	previous: ReadonlyMap<string, IParadisBindingRestoreEntry>,
	pendingKeys: ReadonlySet<string>,
	boundPageByKey: ReadonlyMap<string, string>,
	now: number,
): Map<string, IParadisBindingRestoreEntry> {
	const next = new Map<string, IParadisBindingRestoreEntry>();
	for (const [key, pageId] of boundPageByKey) {
		// 同じ組の時刻は、古くなるまで書き直さない（評価のたびに storage へ書かないため）
		const kept = previous.get(key);
		next.set(key, kept !== undefined && kept.pageId === pageId && now - kept.at < PARADIS_BINDING_RESTORE_REFRESH_MS ? kept : { pageId, at: now });
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
	readonly pageId: string;
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
		if (entry === undefined || token === undefined || boundKeys.has(key) || !knownPageIds.has(entry.pageId)) {
			continue;
		}
		candidates.push({ key, token, pageId: entry.pageId });
	}
	return candidates;
}
