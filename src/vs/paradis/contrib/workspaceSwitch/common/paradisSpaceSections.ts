/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースのセクション（リポジトリの中のスペースを「進行中・レビュー待ち」のようにまとめる見出し、Q683 案 A）。
//
// 台帳はスペースの台帳（knownWorktrees）にもプロジェクトのセクションの台帳（sections.v1）にも混ぜず、別のキーに持つ。
// - スペースの台帳は git が見つけただけのスペースに項目が無く、古い版が名前を書き直すと 3 項目だけを書くので足した項目が消える。
// - プロジェクトのセクションの台帳に混ぜると、古い版が中のセクションを一覧の最上位に空の見出しとして描く。
// 古い版はこのキーを知らないので触らず、版を戻して進め直しても割り当てはそのまま残る。
//
// 割り当ての鍵はピン留めと同じ状態キー（worktree:<uri>）。local（メインの checkout）はセクションに入れない。
// 並びは「local → セクションなし → セクションの順」で、それぞれの中は worktreeOrder の順のまま。この順を決めるのは
// paradisGroupSpacesBySection だけで、一覧の描画・モバイルへ送る順・並べ替えの後の worktreeOrder の揃え直しが同じ関数を読む。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisNormalizeSectionName } from './paradisWorkspaceSections.js';
import { IParadisWorktree } from './paradisWorkspaceSwitch.js';
import { paradisReorderByDrop, paradisSwapAdjacent } from './paradisWorkspaceTreeState.js';

/** リポジトリごとの、セクションの定義とスペースの割り当て（StorageScope.WORKSPACE / StorageTarget.MACHINE）。 */
export const PARADIS_SPACE_SECTIONS_STORAGE_KEY = 'paradis.workspaceSwitch.spaceSections.v1';

/** 閉じているスペースのセクションの id の集合。 */
export const PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY = 'paradis.workspaceSwitch.spaceSectionsCollapsed.v1';

const MAX_REPOSITORIES = 1024;
const MAX_SECTIONS_PER_REPOSITORY = 100;
const MAX_ASSIGNMENTS_PER_REPOSITORY = 1024;
const MAX_ID_LENGTH = 512;
/** 割り当ての鍵は絶対パスを含む（ピン留めの上限と同じ）。 */
const MAX_STATE_KEY_LENGTH = 2048;
const MAX_STORAGE_LENGTH = 4 * 1024 * 1024;

/** 開閉の台帳に入れられる id の数（全リポジトリのセクションの合計の目安）。 */
export const PARADIS_SPACE_SECTIONS_MAX_COLLAPSED = 4096;

export interface IParadisSpaceSection {
	readonly id: string;
	readonly name: string;
}

/** 1 つのリポジトリの分。 */
export interface IParadisRepositorySpaceSections {
	readonly sections: readonly IParadisSpaceSection[];
	/** スペースの状態キー（worktree:<uri>）→ セクション id。読むときは今の一覧に無い鍵も残し、書くときに刈る */
	readonly assignments: ReadonlyMap<string, string>;
}

/** リポジトリ id → その分。セクションが 0 個のリポジトリは持たない。 */
export type ParadisSpaceSections = ReadonlyMap<string, IParadisRepositorySpaceSections>;

export const PARADIS_EMPTY_SPACE_SECTIONS: ParadisSpaceSections = new Map<string, IParadisRepositorySpaceSections>();

function isValidId(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * 台帳を読む。壊れた項目は 1 件ずつ捨て、読めた分は残す。キーが無ければセクション 0 個 = 今までと同じ一覧。
 * セクションの id は全リポジトリで 1 つ（開閉の台帳が id だけで引くため）。後から出た同じ id は捨てる。
 */
export function paradisParseSpaceSections(raw: string | undefined): ParadisSpaceSections {
	if (!raw || raw.length > MAX_STORAGE_LENGTH) {
		return PARADIS_EMPTY_SPACE_SECTIONS;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return PARADIS_EMPTY_SPACE_SECTIONS;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return PARADIS_EMPTY_SPACE_SECTIONS;
	}
	const result = new Map<string, IParadisRepositorySpaceSections>();
	const seenSectionIds = new Set<string>();
	for (const [repositoryId, entry] of Object.entries(value as Record<string, unknown>)) {
		if (result.size >= MAX_REPOSITORIES) {
			break;
		}
		if (!isValidId(repositoryId, MAX_ID_LENGTH) || !entry || typeof entry !== 'object') {
			continue;
		}
		const candidate = entry as { sections?: unknown; assignments?: unknown };
		const sections: IParadisSpaceSection[] = [];
		const ownSectionIds = new Set<string>();
		if (Array.isArray(candidate.sections)) {
			for (const section of candidate.sections) {
				if (sections.length >= MAX_SECTIONS_PER_REPOSITORY) {
					break;
				}
				if (!section || typeof section !== 'object') {
					continue;
				}
				const { id, name } = section as { id?: unknown; name?: unknown };
				const normalized = typeof name === 'string' ? paradisNormalizeSectionName(name) : undefined;
				if (!isValidId(id, MAX_ID_LENGTH) || seenSectionIds.has(id) || normalized === undefined) {
					continue;
				}
				seenSectionIds.add(id);
				ownSectionIds.add(id);
				sections.push({ id, name: normalized });
			}
		}
		if (sections.length === 0) {
			continue;
		}
		const assignments = new Map<string, string>();
		if (candidate.assignments && typeof candidate.assignments === 'object' && !Array.isArray(candidate.assignments)) {
			for (const [stateKey, sectionId] of Object.entries(candidate.assignments as Record<string, unknown>)) {
				if (assignments.size >= MAX_ASSIGNMENTS_PER_REPOSITORY) {
					break;
				}
				// 消したセクションへの割り当てと、local（鍵がリポジトリの id）の割り当ては読まない
				if (isValidId(stateKey, MAX_STATE_KEY_LENGTH) && stateKey !== repositoryId && typeof sectionId === 'string' && ownSectionIds.has(sectionId)) {
					assignments.set(stateKey, sectionId);
				}
			}
		}
		result.set(repositoryId, { sections, assignments });
	}
	return result;
}

/** 台帳を書く形にする。読むときと同じ上限に収まらなければ undefined（呼び出し側は書かない）。 */
export function paradisSerializeSpaceSections(state: ParadisSpaceSections): string | undefined {
	if (state.size > MAX_REPOSITORIES) {
		return undefined;
	}
	const serialized: Record<string, { sections: IParadisSpaceSection[]; assignments: Record<string, string> }> = {};
	for (const [repositoryId, entry] of state) {
		if (entry.sections.length === 0) {
			continue;
		}
		if (entry.sections.length > MAX_SECTIONS_PER_REPOSITORY || entry.assignments.size > MAX_ASSIGNMENTS_PER_REPOSITORY) {
			return undefined;
		}
		serialized[repositoryId] = {
			sections: entry.sections.map(section => ({ id: section.id, name: section.name })),
			assignments: Object.fromEntries(entry.assignments),
		};
	}
	const json = JSON.stringify(serialized);
	return json.length <= MAX_STORAGE_LENGTH ? json : undefined;
}

// --- 並び ---------------------------------------------------------------------------------------

export interface IParadisSpaceSectionGroup<T> {
	readonly section: IParadisSpaceSection;
	readonly spaces: readonly T[];
}

export interface IParadisSpaceGrouping<T> {
	/** セクションに入れていないスペース（local のすぐ下に見出しなしで並ぶ） */
	readonly unsectioned: readonly T[];
	/** セクションの順。空のセクションも含む */
	readonly groups: readonly IParadisSpaceSectionGroup<T>[];
}

/** そのスペースの所属。割り当てが無い・消えたセクションへの割り当てはセクションなし。 */
export function paradisSpaceSectionOf(entry: IParadisRepositorySpaceSections | undefined, stateKey: string): string | undefined {
	const sectionId = entry?.assignments.get(stateKey);
	return sectionId !== undefined && entry!.sections.some(section => section.id === sectionId) ? sectionId : undefined;
}

/**
 * 1 つのリポジトリのスペース（local を除く）をセクションでまとめる。それぞれの中は渡された順のまま。
 * sectionIdOf はそのスペースが入っているセクションの id（無い・知らない id ならセクションなし）。
 */
export function paradisGroupSpacesBySection<T>(spaces: readonly T[], sections: readonly IParadisSpaceSection[], sectionIdOf: (space: T) => string | undefined): IParadisSpaceGrouping<T> {
	if (sections.length === 0) {
		return { unsectioned: spaces, groups: [] };
	}
	const bySection = new Map<string, T[]>(sections.map(section => [section.id, []]));
	const unsectioned: T[] = [];
	for (const space of spaces) {
		const sectionId = sectionIdOf(space);
		(sectionId === undefined ? unsectioned : bySection.get(sectionId) ?? unsectioned).push(space);
	}
	return { unsectioned, groups: sections.map(section => ({ section, spaces: bySection.get(section.id)! })) };
}

/** 一覧に出る順（セクションなし → セクションの順。閉じたセクションの中も含む）。 */
export function paradisOrderSpacesBySection<T>(spaces: readonly T[], sections: readonly IParadisSpaceSection[], sectionIdOf: (space: T) => string | undefined): T[] {
	const grouping = paradisGroupSpacesBySection(spaces, sections, sectionIdOf);
	return [...grouping.unsectioned, ...grouping.groups.flatMap(group => group.spaces)];
}

/** 状態キーの列を一覧の順に揃える。 */
export function paradisSectionOrderedSpaceKeys(stateKeys: readonly string[], entry: IParadisRepositorySpaceSections | undefined): string[] {
	return paradisOrderSpacesBySection(stateKeys, entry?.sections ?? [], stateKey => paradisSpaceSectionOf(entry, stateKey));
}

/** スペースを動かした先。前後のスペース、または所属先（セクションなし・セクション）の先頭・最後。 */
export type ParadisSpaceMoveTarget = { readonly stateKey: string; readonly after: boolean } | 'first' | 'last';

/**
 * スペースを動かした後の並び（状態キーの列）。target の前（後）か、所属先の先頭・最後へ置き、最後に一覧の順へ揃える。
 * entry は所属を変えた後のものを渡す。
 */
export function paradisSpaceOrderAfterMove(stateKeys: readonly string[], entry: IParadisRepositorySpaceSections | undefined, stateKey: string, target: ParadisSpaceMoveTarget): string[] {
	let keys = stateKeys.slice();
	if (keys.includes(stateKey)) {
		if (target === 'first') {
			keys = [stateKey, ...keys.filter(key => key !== stateKey)];
		} else if (target === 'last') {
			keys = [...keys.filter(key => key !== stateKey), stateKey];
		} else {
			keys = paradisReorderByDrop(keys, stateKey, target.stateKey, target.after) ?? keys;
		}
	}
	return paradisSectionOrderedSpaceKeys(keys, entry);
}

/**
 * 同じ所属（同じセクション・セクションなし）の中で隣と入れ替えた後の並び（「上へ移動」「下へ移動」）。
 * 境目を越える入れ替えはしない（越えると並びの台帳だけが動いて見た目が変わらないため）。端なら undefined。
 */
export function paradisSpaceOrderAfterSwapInSection(stateKeys: readonly string[], entry: IParadisRepositorySpaceSections | undefined, stateKey: string, direction: -1 | 1): string[] | undefined {
	const ordered = paradisSectionOrderedSpaceKeys(stateKeys, entry);
	const sectionId = paradisSpaceSectionOf(entry, stateKey);
	const siblings = ordered.filter(key => paradisSpaceSectionOf(entry, key) === sectionId);
	const swapped = paradisSwapAdjacent(siblings, siblings.indexOf(stateKey), direction);
	if (!swapped) {
		return undefined;
	}
	let next = 0;
	return ordered.map(key => paradisSpaceSectionOf(entry, key) === sectionId ? swapped[next++] : key);
}

// --- 変更（どれも新しい状態を返す。変わらなければ undefined） -----------------------------------

const EMPTY_ENTRY: IParadisRepositorySpaceSections = Object.freeze({ sections: Object.freeze([]), assignments: new Map<string, string>() });

/** リポジトリの分を差し替える。セクションが 0 個になったら、そのリポジトリの分を丸ごと消す。 */
function withEntry(state: ParadisSpaceSections, repositoryId: string, entry: IParadisRepositorySpaceSections): ParadisSpaceSections {
	const next = new Map(state);
	if (entry.sections.length === 0) {
		next.delete(repositoryId);
	} else {
		next.set(repositoryId, entry);
	}
	return next;
}

export function paradisAddSpaceSection(state: ParadisSpaceSections, repositoryId: string, section: IParadisSpaceSection): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId) ?? EMPTY_ENTRY;
	if (entry.sections.length >= MAX_SECTIONS_PER_REPOSITORY || (!state.has(repositoryId) && state.size >= MAX_REPOSITORIES)) {
		return undefined;
	}
	// id は全リポジトリで 1 つ
	for (const other of state.values()) {
		if (other.sections.some(candidate => candidate.id === section.id)) {
			return undefined;
		}
	}
	return withEntry(state, repositoryId, { sections: [...entry.sections, section], assignments: entry.assignments });
}

/** 名前を変える。同じリポジトリの中の同じ名前は許す（id で持つため）。空の名前・同じ名前なら undefined。 */
export function paradisRenameSpaceSection(state: ParadisSpaceSections, repositoryId: string, id: string, name: string): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId);
	const normalized = paradisNormalizeSectionName(name);
	const index = entry?.sections.findIndex(section => section.id === id) ?? -1;
	if (!entry || normalized === undefined || index === -1 || entry.sections[index].name === normalized) {
		return undefined;
	}
	const sections = entry.sections.slice();
	sections[index] = { id, name: normalized };
	return withEntry(state, repositoryId, { sections, assignments: entry.assignments });
}

/** 隣のセクションと入れ替える（「上へ移動」「下へ移動」）。同じリポジトリの中だけ。 */
export function paradisMoveSpaceSection(state: ParadisSpaceSections, repositoryId: string, id: string, direction: -1 | 1): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId);
	const sections = entry ? paradisSwapAdjacent(entry.sections, entry.sections.findIndex(section => section.id === id), direction) : null;
	return entry && sections ? withEntry(state, repositoryId, { sections, assignments: entry.assignments }) : undefined;
}

/** 見出しのドラッグで、draggedId を targetId の前（後）へ動かす。 */
export function paradisReorderSpaceSectionByDrop(state: ParadisSpaceSections, repositoryId: string, draggedId: string, targetId: string, placeAfter: boolean): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId);
	const ids = entry ? paradisReorderByDrop(entry.sections.map(section => section.id), draggedId, targetId, placeAfter) : null;
	if (!entry || !ids) {
		return undefined;
	}
	const byId = new Map(entry.sections.map(section => [section.id, section]));
	return withEntry(state, repositoryId, { sections: ids.map(id => byId.get(id)!), assignments: entry.assignments });
}

/** セクションを消す。中のスペースはセクションなしへ戻るだけで、ワークツリーもブランチも消さない。 */
export function paradisRemoveSpaceSection(state: ParadisSpaceSections, repositoryId: string, id: string): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId);
	if (!entry?.sections.some(section => section.id === id)) {
		return undefined;
	}
	return withEntry(state, repositoryId, {
		sections: entry.sections.filter(section => section.id !== id),
		assignments: new Map([...entry.assignments].filter(([, sectionId]) => sectionId !== id)),
	});
}

/** スペースの所属を変える。sectionId が undefined ならセクションなしへ。local（鍵がリポジトリの id）は入れない。 */
export function paradisAssignSpace(state: ParadisSpaceSections, repositoryId: string, stateKey: string, sectionId: string | undefined): ParadisSpaceSections | undefined {
	const entry = state.get(repositoryId);
	if (!entry || stateKey === repositoryId || !isValidId(stateKey, MAX_STATE_KEY_LENGTH)) {
		return undefined;
	}
	if (sectionId !== undefined && !entry.sections.some(section => section.id === sectionId)) {
		return undefined;
	}
	if (paradisSpaceSectionOf(entry, stateKey) === sectionId) {
		return undefined;
	}
	const assignments = new Map(entry.assignments);
	if (sectionId === undefined) {
		assignments.delete(stateKey);
	} else {
		if (!assignments.has(stateKey) && assignments.size >= MAX_ASSIGNMENTS_PER_REPOSITORY) {
			return undefined;
		}
		assignments.set(stateKey, sectionId);
	}
	return withEntry(state, repositoryId, { sections: entry.sections, assignments });
}

/**
 * 一覧から消えたスペースの割り当てを捨てる。liveStateKeys はリポジトリごとの今の一覧の状態キーで、
 * **走査が終わっていないリポジトリは undefined を返す**（そのリポジトリは何も捨てない）。一覧が空のリポジトリも捨てない。
 * SSH が切れている間は一覧が空・不完全なので、ここを誤ると接続が切れただけで全部の割り当てが消える。
 * 捨てるものが無ければ同じ state を返す。
 */
export function paradisPruneSpaceAssignments(state: ParadisSpaceSections, liveStateKeys: (repositoryId: string) => readonly string[] | undefined): ParadisSpaceSections {
	let next: Map<string, IParadisRepositorySpaceSections> | undefined;
	for (const [repositoryId, entry] of state) {
		const liveKeys = liveStateKeys(repositoryId);
		if (!liveKeys || liveKeys.length === 0) {
			continue;
		}
		const live = new Set(liveKeys);
		if ([...entry.assignments.keys()].every(stateKey => live.has(stateKey))) {
			continue;
		}
		next ??= new Map(state);
		next.set(repositoryId, { sections: entry.sections, assignments: new Map([...entry.assignments].filter(([stateKey]) => live.has(stateKey))) });
	}
	return next ?? state;
}

/**
 * 一覧から外したリポジトリの分を丸ごと捨てる。liveRepositoryIds が空（一覧を読む前など）なら何も捨てない。
 * 捨てるものが無ければ同じ state を返す。
 */
export function paradisDropRemovedRepositorySpaceSections(state: ParadisSpaceSections, liveRepositoryIds: readonly string[]): ParadisSpaceSections {
	if (liveRepositoryIds.length === 0) {
		return state;
	}
	const live = new Set(liveRepositoryIds);
	if ([...state.keys()].every(repositoryId => live.has(repositoryId))) {
		return state;
	}
	return new Map([...state].filter(([repositoryId]) => live.has(repositoryId)));
}

/** 台帳にあるセクションの id（開閉の台帳の掃除に使う）。 */
export function paradisSpaceSectionIds(state: ParadisSpaceSections): Set<string> {
	const ids = new Set<string>();
	for (const entry of state.values()) {
		for (const section of entry.sections) {
			ids.add(section.id);
		}
	}
	return ids;
}

// --- サービス -------------------------------------------------------------------------------------

export const IParadisSpaceSectionsService = createDecorator<IParadisSpaceSectionsService>('paradisSpaceSectionsService');

/**
 * スペースのセクションの台帳と開閉の状態を持つ。台帳は接続先ごとに別（スペースの台帳と同じ WORKSPACE のスコープ）。
 * 所属や並びを変えるたびに、スペースの並び（worktreeOrder）も一覧の順へ揃える。
 */
export interface IParadisSpaceSectionsService {
	readonly _serviceBrand: undefined;
	/** 台帳か開閉が変わった。 */
	readonly onDidChange: Event<void>;
	/** そのリポジトリのセクション（順のまま）。無ければ空。 */
	sectionsOf(repositoryId: string): readonly IParadisSpaceSection[];
	/** そのスペースが入っているセクションの id。local・セクションなしは undefined。 */
	sectionOf(worktree: IParadisWorktree): string | undefined;
	/** そのリポジトリのスペース（local を除く）を一覧に出る順に並べたもの。 */
	orderedWorktrees(repositoryId: string): IParadisWorktree[];
	isCollapsed(sectionId: string): boolean;
	setCollapsed(sectionId: string, collapsed: boolean): void;
	/** 新しいセクションを最後に作り、worktree があればそこへ移す。名前が空なら作らず undefined。 */
	createSection(repositoryId: string, name: string, worktree?: IParadisWorktree): string | undefined;
	renameSection(repositoryId: string, id: string, name: string): void;
	moveSection(repositoryId: string, id: string, direction: -1 | 1): void;
	reorderSection(repositoryId: string, draggedId: string, targetId: string, placeAfter: boolean): void;
	/** セクションを消す。中のスペースはセクションなしへ戻る（ワークツリーは消さない）。 */
	removeSection(repositoryId: string, id: string): void;
	/**
	 * スペースを sectionId（undefined = セクションなし）へ移す。target があればそのスペースの前（後）へ、
	 * 'first' なら所属先の先頭へ、無ければ最後へ置く。
	 */
	moveSpaceToSection(worktree: IParadisWorktree, sectionId: string | undefined, target?: { readonly worktree: IParadisWorktree; readonly after: boolean } | 'first'): void;
	/** 同じ所属の中で隣と入れ替える。 */
	moveSpaceWithinSection(worktree: IParadisWorktree, direction: -1 | 1): void;
	canMoveSpaceWithinSection(worktree: IParadisWorktree, direction: -1 | 1): boolean;
}
