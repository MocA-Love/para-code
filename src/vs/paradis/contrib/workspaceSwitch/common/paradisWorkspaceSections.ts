/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// プロジェクト一覧の「セクション」（仕事・趣味のように複数のプロジェクトをまとめて開閉する見出し、Q601 案 A）。
//
// 台帳はプロジェクトの台帳（paradis.workspaceSwitch.repositories）に項目を足さず、別のキーに分ける。
// プロジェクトの台帳は読むときに 4 項目しか写さないので、項目を足すと古い版で保存したときに消えるため。
// 古い版はこのキーを知らないので触らず、版を戻して進め直しても割り当てはそのまま残る。
// 開閉の状態も別のキーに置く。collapsedRepositories.v1 は描き直しのたびに「今のリポジトリに無い id」を
// 刈るので、セクションの id を混ぜると消える。
//
// 並び順は「セクションの順、その中はプロジェクトの台帳の順、未分類は最後」。この順を決めるのは
// paradisGroupRepositoriesBySection だけで、一覧の描画・次/前の切り替え・台帳の順の揃え直しが同じ関数を読む。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisWorkspaceRepository } from './paradisWorkspaceSwitch.js';
import { paradisReorderByDrop, paradisSwapAdjacent } from './paradisWorkspaceTreeState.js';

/** セクションの定義と、プロジェクトの割り当て（StorageScope.WORKSPACE / StorageTarget.MACHINE）。 */
export const PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY = 'paradis.workspaceSwitch.sections.v1';

/** 閉じているセクションの id の集合（未分類は PARADIS_UNCATEGORIZED_SECTION_KEY）。 */
export const PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY = 'paradis.workspaceSwitch.sectionsCollapsed.v1';

/** 開閉の台帳で「未分類」を表す鍵。セクションの id には使えない（読むときに捨てる）。 */
export const PARADIS_UNCATEGORIZED_SECTION_KEY = 'uncategorized';

const MAX_SECTIONS = 200;
const MAX_ASSIGNMENTS = 1024;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 200;
const MAX_STORAGE_LENGTH = 1024 * 1024;

export interface IParadisWorkspaceSection {
	readonly id: string;
	readonly name: string;
	/** PARADIS_WORKSPACE_COLORS のパレット id。名前の前の点にだけ使う。undefined = 点なし */
	readonly color?: string;
}

export interface IParadisWorkspaceSections {
	readonly sections: readonly IParadisWorkspaceSection[];
	/** リポジトリ id → セクション id。読むときは今の一覧に無い id も残し（描画で無視する）、書くときに刈る（paradisPruneAssignments） */
	readonly assignments: ReadonlyMap<string, string>;
}

export const PARADIS_EMPTY_WORKSPACE_SECTIONS: IParadisWorkspaceSections = Object.freeze({ sections: Object.freeze([]), assignments: new Map<string, string>() });

interface ISerializedWorkspaceSections {
	readonly sections: readonly { readonly id: string; readonly name: string; readonly color?: string }[];
	readonly assignments: Readonly<Record<string, string>>;
}

function isValidId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * 台帳を読む。壊れた項目は 1 件ずつ捨て、読めた分は残す（1 件の不正で全部の割り当てを失わないため）。
 * キーが無い（古い版の台帳しか無い）ときはセクション 0 個 = 全部未分類 = 今と同じ見た目。
 */
export function paradisParseWorkspaceSections(raw: string | undefined): IParadisWorkspaceSections {
	if (!raw || raw.length > MAX_STORAGE_LENGTH) {
		return PARADIS_EMPTY_WORKSPACE_SECTIONS;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return PARADIS_EMPTY_WORKSPACE_SECTIONS;
	}
	if (!value || typeof value !== 'object') {
		return PARADIS_EMPTY_WORKSPACE_SECTIONS;
	}
	const candidate = value as { sections?: unknown; assignments?: unknown };
	const sections: IParadisWorkspaceSection[] = [];
	const seen = new Set<string>();
	if (Array.isArray(candidate.sections)) {
		for (const entry of candidate.sections) {
			if (sections.length >= MAX_SECTIONS) {
				break;
			}
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const { id, name, color } = entry as { id?: unknown; name?: unknown; color?: unknown };
			if (!isValidId(id) || id === PARADIS_UNCATEGORIZED_SECTION_KEY || seen.has(id) || typeof name !== 'string' || !name.trim()) {
				continue;
			}
			seen.add(id);
			sections.push({ id, name: name.slice(0, MAX_NAME_LENGTH), color: typeof color === 'string' && color ? color : undefined });
		}
	}
	const assignments = new Map<string, string>();
	if (candidate.assignments && typeof candidate.assignments === 'object' && !Array.isArray(candidate.assignments)) {
		for (const [repositoryId, sectionId] of Object.entries(candidate.assignments as Record<string, unknown>)) {
			if (assignments.size >= MAX_ASSIGNMENTS) {
				break;
			}
			// 消したセクションへの割り当ては読まない（未分類に戻る）
			if (isValidId(repositoryId) && isValidId(sectionId) && seen.has(sectionId)) {
				assignments.set(repositoryId, sectionId);
			}
		}
	}
	return { sections, assignments };
}

/** 台帳を書く形にする。読むときと同じ上限に収まらなければ undefined（呼び出し側は書かない）。 */
export function paradisSerializeWorkspaceSections(state: IParadisWorkspaceSections): string | undefined {
	if (state.sections.length > MAX_SECTIONS || state.assignments.size > MAX_ASSIGNMENTS) {
		return undefined;
	}
	const serialized: ISerializedWorkspaceSections = {
		sections: state.sections.map(section => section.color ? { id: section.id, name: section.name, color: section.color } : { id: section.id, name: section.name }),
		assignments: Object.fromEntries(state.assignments),
	};
	const json = JSON.stringify(serialized);
	return json.length <= MAX_STORAGE_LENGTH ? json : undefined;
}

/** 閉じているセクションの鍵の集合を読む。不正な値は 1 件ずつ捨てる。 */
export function paradisParseCollapsedSections(raw: string | undefined): Set<string> {
	const result = new Set<string>();
	if (!raw || raw.length > MAX_STORAGE_LENGTH) {
		return result;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (Array.isArray(value)) {
			for (const key of value) {
				if (isValidId(key) && result.size < MAX_SECTIONS + 1) {
					result.add(key);
				}
			}
		}
	} catch {
		// 読めなければ全部開いている扱い
	}
	return result;
}

export function paradisSerializeCollapsedSections(keys: ReadonlySet<string>): string {
	return JSON.stringify([...keys].sort());
}

/** 名前を台帳に入れられる形に整える。空なら undefined。 */
export function paradisNormalizeSectionName(name: string): string | undefined {
	const trimmed = name.trim();
	return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : undefined;
}

// --- 並び ---------------------------------------------------------------------------------------

export interface IParadisSectionGroup<R> {
	/** undefined = 未分類（セクションが 0 個のときは見出しを出さない 1 群） */
	readonly section: IParadisWorkspaceSection | undefined;
	readonly repositories: readonly R[];
}

/** そのリポジトリの所属。消えたセクションへの割り当ては未分類として扱う。 */
export function paradisSectionOf(state: IParadisWorkspaceSections, repositoryId: string): string | undefined {
	const sectionId = state.assignments.get(repositoryId);
	return sectionId !== undefined && state.sections.some(section => section.id === sectionId) ? sectionId : undefined;
}

/**
 * 一覧の並び。セクションが 0 個なら台帳の順の 1 群だけ（見出しは出さない = 今と同じ）。
 * セクションがあれば、セクションの順に（空のセクションも）並べ、中は台帳の順。未分類は中身があるときだけ最後に置く。
 */
export function paradisGroupRepositoriesBySection<R extends { readonly id: string }>(repositories: readonly R[], state: IParadisWorkspaceSections): IParadisSectionGroup<R>[] {
	if (state.sections.length === 0) {
		return [{ section: undefined, repositories }];
	}
	const bySection = new Map<string, R[]>(state.sections.map(section => [section.id, []]));
	const uncategorized: R[] = [];
	for (const repository of repositories) {
		const sectionId = state.assignments.get(repository.id);
		const bucket = sectionId === undefined ? undefined : bySection.get(sectionId);
		(bucket ?? uncategorized).push(repository);
	}
	const groups: IParadisSectionGroup<R>[] = state.sections.map(section => ({ section, repositories: bySection.get(section.id)! }));
	if (uncategorized.length > 0) {
		groups.push({ section: undefined, repositories: uncategorized });
	}
	return groups;
}

/** 一覧に出る順（閉じたセクションの中も含む）。次・前の切り替えはこの順に回る。 */
export function paradisOrderRepositoriesBySection<R extends { readonly id: string }>(repositories: readonly R[], state: IParadisWorkspaceSections): R[] {
	return paradisGroupRepositoriesBySection(repositories, state).flatMap(group => group.repositories);
}

/** ordered の中で activeId から delta 個先（端は反対へ回る）。activeId が無ければ先頭。 */
export function paradisRelativeRepository<R extends { readonly id: string }>(ordered: readonly R[], activeId: string | undefined, delta: number): R | undefined {
	if (ordered.length === 0) {
		return undefined;
	}
	const activeIndex = ordered.findIndex(repository => repository.id === activeId);
	if (activeIndex === -1) {
		return ordered[0];
	}
	const length = ordered.length;
	return ordered[((activeIndex + delta) % length + length) % length];
}

/**
 * プロジェクトの台帳の順を、一覧の順（セクションの順、その中は台帳の順）に揃えた id の列。
 * モバイルへ送る順と Ctrl+数字の番号は台帳の順なので、セクションを動かすたびにこれで揃え直す。
 */
export function paradisSectionOrderedIds(ledgerIds: readonly string[], state: IParadisWorkspaceSections): string[] {
	return paradisOrderRepositoriesBySection(ledgerIds.map(id => ({ id })), state).map(entry => entry.id);
}

// --- 変更（どれも新しい状態を返す。変わらなければ undefined） -----------------------------------

/**
 * 今の一覧に無いリポジトリの割り当てを捨てる。liveRepositoryIds が空（一覧を読む前など）なら何も捨てない。
 * 捨てるものが無ければ同じ state を返す。
 */
export function paradisPruneAssignments(state: IParadisWorkspaceSections, liveRepositoryIds: readonly string[]): IParadisWorkspaceSections {
	if (liveRepositoryIds.length === 0) {
		return state;
	}
	const live = new Set(liveRepositoryIds);
	if ([...state.assignments.keys()].every(id => live.has(id))) {
		return state;
	}
	return { sections: state.sections, assignments: new Map([...state.assignments].filter(([repositoryId]) => live.has(repositoryId))) };
}

export function paradisAddSection(state: IParadisWorkspaceSections, section: IParadisWorkspaceSection): IParadisWorkspaceSections | undefined {
	if (state.sections.length >= MAX_SECTIONS || state.sections.some(candidate => candidate.id === section.id)) {
		return undefined;
	}
	return { sections: [...state.sections, section], assignments: state.assignments };
}

function updateSection(state: IParadisWorkspaceSections, id: string, update: (section: IParadisWorkspaceSection) => IParadisWorkspaceSection): IParadisWorkspaceSections | undefined {
	const index = state.sections.findIndex(section => section.id === id);
	if (index === -1) {
		return undefined;
	}
	const next = update(state.sections[index]);
	if (next.name === state.sections[index].name && next.color === state.sections[index].color) {
		return undefined;
	}
	const sections = state.sections.slice();
	sections[index] = next;
	return { sections, assignments: state.assignments };
}

export function paradisRenameSection(state: IParadisWorkspaceSections, id: string, name: string): IParadisWorkspaceSections | undefined {
	const normalized = paradisNormalizeSectionName(name);
	return normalized === undefined ? undefined : updateSection(state, id, section => ({ ...section, name: normalized }));
}

export function paradisSetSectionColor(state: IParadisWorkspaceSections, id: string, color: string | undefined): IParadisWorkspaceSections | undefined {
	return updateSection(state, id, section => ({ ...section, color }));
}

/** 隣のセクションと入れ替える（「上へ移動」「下へ移動」）。 */
export function paradisMoveSection(state: IParadisWorkspaceSections, id: string, direction: -1 | 1): IParadisWorkspaceSections | undefined {
	const sections = paradisSwapAdjacent(state.sections, state.sections.findIndex(section => section.id === id), direction);
	return sections ? { sections, assignments: state.assignments } : undefined;
}

/** 見出しのドラッグで、draggedId を targetId の前（後）へ動かす。 */
export function paradisReorderSectionByDrop(state: IParadisWorkspaceSections, draggedId: string, targetId: string, placeAfter: boolean): IParadisWorkspaceSections | undefined {
	const ids = paradisReorderByDrop(state.sections.map(section => section.id), draggedId, targetId, placeAfter);
	if (!ids) {
		return undefined;
	}
	const byId = new Map(state.sections.map(section => [section.id, section]));
	return { sections: ids.map(id => byId.get(id)!), assignments: state.assignments };
}

/** セクションを消す。中のプロジェクトは未分類へ戻るだけで、リポジトリもワークツリーも消さない。 */
export function paradisRemoveSection(state: IParadisWorkspaceSections, id: string): IParadisWorkspaceSections | undefined {
	if (!state.sections.some(section => section.id === id)) {
		return undefined;
	}
	const assignments = new Map([...state.assignments].filter(([, sectionId]) => sectionId !== id));
	return { sections: state.sections.filter(section => section.id !== id), assignments };
}

/** プロジェクトの所属を変える。sectionId が undefined なら未分類へ。 */
export function paradisAssignRepository(state: IParadisWorkspaceSections, repositoryId: string, sectionId: string | undefined): IParadisWorkspaceSections | undefined {
	if (sectionId !== undefined && !state.sections.some(section => section.id === sectionId)) {
		return undefined;
	}
	if (paradisSectionOf(state, repositoryId) === sectionId) {
		return undefined;
	}
	const assignments = new Map(state.assignments);
	if (sectionId === undefined) {
		assignments.delete(repositoryId);
	} else {
		if (!assignments.has(repositoryId) && assignments.size >= MAX_ASSIGNMENTS) {
			return undefined;
		}
		assignments.set(repositoryId, sectionId);
	}
	return { sections: state.sections, assignments };
}

/**
 * プロジェクトを動かした後の台帳の順。target があればその前（後）へ、無ければ所属先の最後へ置き、
 * 最後に一覧の順へ揃える。state は所属を変えた後のものを渡す。
 */
export function paradisLedgerOrderAfterMove(ledgerIds: readonly string[], state: IParadisWorkspaceSections, repositoryId: string, target: { readonly repositoryId: string; readonly after: boolean } | undefined): string[] {
	let ids = ledgerIds.slice();
	if (target) {
		ids = paradisReorderByDrop(ids, repositoryId, target.repositoryId, target.after) ?? ids;
	} else if (ids.includes(repositoryId)) {
		ids = [...ids.filter(id => id !== repositoryId), repositoryId];
	}
	return paradisSectionOrderedIds(ids, state);
}

/**
 * 同じセクションの中で隣と入れ替えた後の台帳の順（「上へ移動」「下へ移動」）。
 * セクションの境目を越える入れ替えはしない（越えると台帳だけが動いて見た目が変わらないため）。端なら undefined。
 */
export function paradisLedgerOrderAfterSwapInSection(ledgerIds: readonly string[], state: IParadisWorkspaceSections, repositoryId: string, direction: -1 | 1): string[] | undefined {
	const ordered = paradisSectionOrderedIds(ledgerIds, state);
	const sectionId = paradisSectionOf(state, repositoryId);
	const siblings = ordered.filter(id => paradisSectionOf(state, id) === sectionId);
	const swapped = paradisSwapAdjacent(siblings, siblings.indexOf(repositoryId), direction);
	if (!swapped) {
		return undefined;
	}
	let next = 0;
	return ordered.map(id => paradisSectionOf(state, id) === sectionId ? swapped[next++] : id);
}

// --- サービス -------------------------------------------------------------------------------------

export const IParadisWorkspaceSectionsService = createDecorator<IParadisWorkspaceSectionsService>('paradisWorkspaceSectionsService');

/**
 * セクションの台帳と開閉の状態を持つ。台帳は接続先ごとに別（プロジェクトの台帳と同じ WORKSPACE のスコープ）。
 * 割り当てや並びを変えるたびに、プロジェクトの台帳の順も一覧の順へ揃える（reorderRepositories）。
 */
export interface IParadisWorkspaceSectionsService {
	readonly _serviceBrand: undefined;
	/** 台帳か開閉が変わった。 */
	readonly onDidChange: Event<void>;
	readonly state: IParadisWorkspaceSections;
	/** 今のプロジェクトの一覧をセクションでまとめたもの（paradisGroupRepositoriesBySection）。 */
	groups(): IParadisSectionGroup<IParadisWorkspaceRepository>[];
	/** 一覧に出る順のプロジェクト（閉じたセクションの中も含む）。 */
	orderedRepositories(): IParadisWorkspaceRepository[];
	sectionOf(repositoryId: string): string | undefined;
	/** sectionKey はセクションの id か PARADIS_UNCATEGORIZED_SECTION_KEY。 */
	isCollapsed(sectionKey: string): boolean;
	setCollapsed(sectionKey: string, collapsed: boolean): void;
	/** 新しいセクションを最後に作り、repositoryId があればそこへ移す。名前が空なら作らず undefined。 */
	createSection(name: string, repositoryId?: string): string | undefined;
	renameSection(id: string, name: string): void;
	setSectionColor(id: string, color: string | undefined): void;
	moveSection(id: string, direction: -1 | 1): void;
	reorderSection(draggedId: string, targetId: string, placeAfter: boolean): void;
	removeSection(id: string): void;
	/** プロジェクトを sectionId（undefined = 未分類）へ移す。target があればそのプロジェクトの前（後）へ置く。 */
	moveRepositoryToSection(repositoryId: string, sectionId: string | undefined, target?: { readonly repositoryId: string; readonly after: boolean }): void;
	/** 同じセクションの中で隣と入れ替える。 */
	moveRepositoryWithinSection(repositoryId: string, direction: -1 | 1): void;
	canMoveRepositoryWithinSection(repositoryId: string, direction: -1 | 1): boolean;
}
