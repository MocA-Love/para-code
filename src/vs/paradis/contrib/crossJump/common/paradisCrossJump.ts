/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 横断ジャンプ（スペース・タブ・エージェントを 1 つの検索で移る。Orca の Cmd+J 相当、G-05）の
// 並びと表示の文字を決める純関数。画面（クイックピック）は electron-browser 側にある。

import { matchesFuzzyIconAware, parseLabelWithIcons } from '../../../../base/common/iconLabels.js';
import { localize } from '../../../../nls.js';
import { IParadisAgentLiveEntry, ParadisAgentLiveStatus } from '../../agentLiveWindow/common/paradisAgentLiveWindow.js';

/** 並びの優先度。要対応（許可待ち・質問中）が先頭、待機が最後。 */
const STATUS_ORDER: Record<ParadisAgentLiveStatus, number> = {
	permission: 0,
	question: 1,
	working: 2,
	review: 3,
	idle: 4,
};

/**
 * エージェントを要対応から順に並べる。同じ状態の中では、その状態になったのが新しいものを先にする。
 * 状態ストアが知らない値（版の違いで届きうる）は待機の後ろへ回す。
 */
export function paradisSortCrossJumpAgents(entries: readonly IParadisAgentLiveEntry[]): IParadisAgentLiveEntry[] {
	const rank = (status: ParadisAgentLiveStatus) => STATUS_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
	return [...entries].sort((a, b) => rank(a.status) - rank(b.status) || b.since - a.since);
}

/** 状態が変わってからの時間を「今」「N 分前」「N 時間前」「N 日前」で表す。 */
export function paradisFormatCrossJumpAgo(elapsedMilliseconds: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMilliseconds) / 60_000);
	if (minutes < 1) {
		return localize('paradis.crossJump.ago.now', "今");
	}
	if (minutes < 60) {
		return localize('paradis.crossJump.ago.minutes', "{0} 分前", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('paradis.crossJump.ago.hours', "{0} 時間前", hours);
	}
	return localize('paradis.crossJump.ago.days', "{0} 日前", Math.floor(hours / 24));
}

/**
 * 「ワークツリーを作る」の行を出すか。入力が空でなく、名前・説明のどれにも入力が含まれないときだけ出す
 * （Orca と同じく、一致が無いときの逃げ道）。比べるのは大文字小文字を区別しない部分一致。
 */
export function paradisShouldOfferCrossJumpCreate(value: string, haystacks: readonly string[]): boolean {
	const needle = value.trim().toLowerCase();
	if (!needle) {
		return false;
	}
	return !haystacks.some(text => text.toLowerCase().includes(needle));
}

// --- 中央のパレット（Q609・Q610、案 11）: 種類のタブ・接頭辞・まとめ方・最近とピン・操作の行 -----------------------

/** 種類のタブ。`command` はコマンドパレット（`>`）へ切り替える。 */
export type ParadisPaletteKind = 'all' | 'agent' | 'editor' | 'space' | 'command';

/** タブの並び（Tab で右へ、Shift+Tab で左へ回る）。 */
export const PARADIS_PALETTE_KINDS: readonly ParadisPaletteKind[] = ['all', 'agent', 'editor', 'space', 'command'];

/** タブの名前の前に小さく添える接頭辞。「すべて」には無い。 */
export const PARADIS_PALETTE_KIND_PREFIXES: Readonly<Record<ParadisPaletteKind, string | undefined>> = {
	all: undefined,
	agent: 'a',
	editor: 't',
	space: 's',
	command: '>',
};

/** 今の種類から Tab（+1）・Shift+Tab（-1）で移る先。端は反対の端へ回る。 */
export function paradisCyclePaletteKind(kind: ParadisPaletteKind, delta: 1 | -1): ParadisPaletteKind {
	const index = PARADIS_PALETTE_KINDS.indexOf(kind);
	const count = PARADIS_PALETTE_KINDS.length;
	return PARADIS_PALETTE_KINDS[((index < 0 ? 0 : index) + delta + count) % count];
}

/** 入力の先頭の接頭辞を読んだ結果。 */
export interface IParadisPalettePrefix {
	/** 接頭辞が指す先。`help` は `?`（ヘルプ）。接頭辞が無いときは undefined。 */
	readonly kind: Exclude<ParadisPaletteKind, 'all'> | 'help' | undefined;
	/** 接頭辞を外した残り（絞り込みに使う）。 */
	readonly rest: string;
}

/**
 * 入力の先頭の接頭辞を読む。`a `・`t `・`s `（文字の後に空白）はその種類だけに絞り、`>` はコマンドパレット、`?` は
 * ヘルプへ切り替える。`a` だけ（空白の前）や `abc` は接頭辞にしない（名前の先頭の a で絞れなくなるため）。
 * 大文字小文字は区別しない。
 */
export function paradisParsePalettePrefix(value: string): IParadisPalettePrefix {
	if (value.startsWith('>')) {
		return { kind: 'command', rest: value.slice(1) };
	}
	if (value.startsWith('?')) {
		return { kind: 'help', rest: value.slice(1) };
	}
	const match = /^(?<letter>[ats]) /i.exec(value);
	if (match?.groups) {
		const letter = match.groups.letter.toLowerCase();
		const kind = letter === 'a' ? 'agent' : letter === 't' ? 'editor' : 'space';
		return { kind, rest: value.slice(match[0].length) };
	}
	return { kind: undefined, rest: value };
}

/**
 * 行が入力に一致するか。クイックピックの一覧（quickInputList.ts の filter）と同じ一致の関数を使うので、タブの件数と
 * 見えている行の数がずれない。入力が空ならすべて一致。
 */
export function paradisPaletteMatches(query: string, label: string, description: string | undefined): boolean {
	const trimmed = query.trim();
	if (!trimmed) {
		return true;
	}
	return !!matchesFuzzyIconAware(trimmed, parseLabelWithIcons(label)) || !!(description && matchesFuzzyIconAware(trimmed, parseLabelWithIcons(description)));
}

/** リポジトリごとにまとめたスペース。 */
export interface IParadisPaletteSpaceGroup<T> {
	readonly repositoryId: string;
	readonly items: readonly T[];
}

/** スペースをリポジトリごとにまとめる。リポジトリの順と、その中の順は渡された並びのまま。 */
export function paradisGroupPaletteSpaces<T extends { readonly repositoryId: string }>(spaces: readonly T[]): IParadisPaletteSpaceGroup<T>[] {
	const groups = new Map<string, T[]>();
	for (const space of spaces) {
		let items = groups.get(space.repositoryId);
		if (!items) {
			items = [];
			groups.set(space.repositoryId, items);
		}
		items.push(space);
	}
	return [...groups].map(([repositoryId, items]) => ({ repositoryId, items }));
}

/** 最近移った先・ピンを付けた先の 1 件。 */
export interface IParadisPaletteRecent {
	readonly kind: 'agent' | 'editor' | 'space';
	/** エージェントはペイントークン、タブはファイルの URI、スペースは状態キー。 */
	readonly key: string;
	/** 最後に移った時刻（epoch ms）。 */
	readonly at: number;
	readonly pinned?: boolean;
}

/** 覚えておく件数の上限（ピンは別に数えず、上限を超えたら古い「ピンの無いもの」から捨てる）。 */
const PALETTE_RECENT_LIMIT = 30;
/** 「最近・ピン」に出す件数（ピンがこれより多ければピンはすべて出す）。 */
export const PARADIS_PALETTE_RECENT_SHOWN = 4;

/** 保存した文字列を読む。壊れていたら空にする。 */
export function paradisParsePaletteRecents(raw: string | undefined): IParadisPaletteRecent[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((entry): entry is IParadisPaletteRecent =>
			!!entry && typeof entry === 'object'
			&& (entry.kind === 'agent' || entry.kind === 'editor' || entry.kind === 'space')
			&& typeof entry.key === 'string' && typeof entry.at === 'number');
	} catch {
		return [];
	}
}

function trimPaletteRecents(list: readonly IParadisPaletteRecent[]): IParadisPaletteRecent[] {
	const result = [...list];
	while (result.length > PALETTE_RECENT_LIMIT) {
		const index = result.map(entry => !entry.pinned).lastIndexOf(true);
		if (index < 0) {
			break;
		}
		result.splice(index, 1);
	}
	return result;
}

/** 移った先を先頭に記録する（同じ先は 1 件にまとめ、ピンは保つ）。 */
export function paradisRecordPaletteRecent(list: readonly IParadisPaletteRecent[], kind: IParadisPaletteRecent['kind'], key: string, now: number): IParadisPaletteRecent[] {
	const previous = list.find(entry => entry.kind === kind && entry.key === key);
	const next: IParadisPaletteRecent = { kind, key, at: now, ...(previous?.pinned ? { pinned: true } : {}) };
	return trimPaletteRecents([next, ...list.filter(entry => entry !== previous)]);
}

/** ピンを付ける・外す。記録に無い先にピンを付けたときは記録に足す。 */
export function paradisTogglePalettePin(list: readonly IParadisPaletteRecent[], kind: IParadisPaletteRecent['kind'], key: string, now: number): IParadisPaletteRecent[] {
	const previous = list.find(entry => entry.kind === kind && entry.key === key);
	if (!previous) {
		return trimPaletteRecents([{ kind, key, at: now, pinned: true }, ...list]);
	}
	return list.map(entry => entry === previous ? { kind, key, at: entry.at, ...(entry.pinned ? {} : { pinned: true }) } : entry);
}

/**
 * 「最近・ピン」に出すもの。今も在る先（`exists`）だけを、ピンはすべて、残りは新しい順に足して
 * {@link PARADIS_PALETTE_RECENT_SHOWN} 件まで。並びは移った時刻の新しい順。
 */
export function paradisPaletteRecentsToShow(list: readonly IParadisPaletteRecent[], exists: (entry: IParadisPaletteRecent) => boolean): IParadisPaletteRecent[] {
	const alive = list.filter(exists);
	const pinned = alive.filter(entry => entry.pinned);
	const rest = alive.filter(entry => !entry.pinned).sort((a, b) => b.at - a.at).slice(0, Math.max(0, PARADIS_PALETTE_RECENT_SHOWN - pinned.length));
	return [...pinned, ...rest].sort((a, b) => b.at - a.at);
}

/** 入力が空のときに先頭に出す操作の件数と、打ったときに出す件数の上限。 */
const PALETTE_ACTIONS_EMPTY = 3;
const PALETTE_ACTIONS_MATCHED = 5;

/** 操作の行（新しいスペース・ターミナル・エージェントの起動など）のうち、出すもの。 */
export function paradisPaletteActionsToShow<T extends { readonly label: string }>(actions: readonly T[], query: string): T[] {
	if (!query.trim()) {
		return actions.slice(0, PALETTE_ACTIONS_EMPTY);
	}
	return actions.filter(action => paradisPaletteMatches(query, action.label, undefined)).slice(0, PALETTE_ACTIONS_MATCHED);
}
