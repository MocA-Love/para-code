/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IObjectTreeElement, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { IParadisWorkspaceRepository, IParadisWorktree, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisSpaceSection, paradisGroupSpacesBySection } from '../common/paradisSpaceSections.js';
import { IParadisSectionGroup, IParadisWorkspaceSection, PARADIS_UNCATEGORIZED_SECTION_KEY } from '../common/paradisWorkspaceSections.js';
import { IParadisWorktreeCreateJobSnapshot } from '../common/paradisWorktreeCreate.js';

/** バックグラウンド作成中のジョブを表す「作成中」プレースホルダ行。クリック・メニュー対象外。 */
export interface ICreatingSpaceElement {
	readonly creatingJob: IParadisWorktreeCreateJobSnapshot;
}

/**
 * 折りたたまれたリポジトリ・セクションの下に残す、ピン留め済み worktree の控え行。
 * ツリーの折りたたみは「子を全部隠す」動作なので、ピン留め行は閉じた行の直後に兄弟として差し込む
 * （子の実体は隠れたまま残るため、identity が衝突しないようこのフラグで別IDを振る）。
 * ツリーは兄弟の深さで字下げするので、本来の深さとの差（keepLevels 段）はレンダラが寄せる。
 */
export type IPinnedKeepElement = IParadisWorktree & {
	readonly paradisPinnedKeep: true;
	/**
	 * 閉じたリポジトリの下は 1、閉じたセクションの下は 2（セクション → プロジェクト → スペースの 2 段ぶん）。
	 * 閉じたスペースのセクションの下は 0（見出しの兄弟で、スペースの段にそのまま並ぶ。keepSpaceSectionId で見分ける）
	 */
	readonly keepLevels: number;
	/** 閉じたスペースのセクションの控えなら、そのセクションの id */
	readonly keepSpaceSectionId?: string;
};

/**
 * セクションの見出し（Q607 案 B）。中のプロジェクトを本当の子に持つ（セクション → プロジェクト → スペース）。
 * 開閉はツリーの開閉で、台帳（sectionsCollapsed.v1）を正として setChildren のたびに collapsed を渡し直す。
 */
export interface ISectionHeaderElement {
	readonly paradisSectionHeader: true;
	/** undefined = 未分類（名前の変更・削除はできず、開閉だけできる） */
	readonly section: IParadisWorkspaceSection | undefined;
	/** 開閉の台帳の鍵。セクションの id か PARADIS_UNCATEGORIZED_SECTION_KEY、作りかけは SECTION_DRAFT_KEY */
	readonly key: string;
	readonly repositories: readonly IParadisWorkspaceRepository[];
	/** 一覧の先頭の行（上の切れ目を入れない） */
	readonly first: boolean;
}

/** 空のセクションの下に出す「ここへプロジェクトをドラッグ」の行（ドロップ先）。 */
export interface ISectionEmptyElement {
	readonly paradisSectionEmpty: string;
}

/**
 * スペースのセクションの見出し（Q683 案 A）。リポジトリの子で、中のスペースを本当の子に持つ
 * （プロジェクト → スペースのセクション → スペース）。字下げは足さず、中の行はレンダラが 1 段ぶん戻す。
 * 開閉は台帳（spaceSectionsCollapsed.v1）を正として setChildren のたびに collapsed を渡し直す。
 * 親のリポジトリは ownerRepositoryId に持つ（repositoryId にするとスペースの行と見分けられない）。
 */
export interface ISpaceSectionHeaderElement {
	readonly paradisSpaceSectionHeader: true;
	readonly ownerRepositoryId: string;
	/** undefined = 作りかけ（名前を入れている途中で、まだ台帳に無い） */
	readonly section: IParadisSpaceSection | undefined;
	/** 開閉の台帳の鍵。セクションの id、作りかけは SPACE_SECTION_DRAFT_KEY */
	readonly key: string;
	/** 中のスペース（作成中の行は含まない） */
	readonly spaces: readonly IParadisWorktree[];
	/** 中の「作成中」の行の数（件数とエージェントの状態の集計に足す） */
	readonly creatingCount: number;
}

/** 空のスペースのセクションの下に出す「ここへスペースをドラッグ」の行（ドロップ先）。 */
export interface ISpaceSectionEmptyElement {
	/** セクションの id */
	readonly paradisSpaceSectionEmpty: string;
	readonly ownerRepositoryId: string;
}

/** 「スペースのセクションを追加」でその場の入力欄を出している間だけ並ぶ、まだ台帳に無い見出しの鍵。 */
export const SPACE_SECTION_DRAFT_KEY = 'paradis-space-section-draft';

/** 「新しいセクション」でその場の入力欄を出している間だけ並ぶ、まだ台帳に無い見出しの鍵。 */
export const SECTION_DRAFT_KEY = 'paradis-section-draft';

/** セクションがあるときの 1 段の字下げ（Q607 案 B）。設定 workbench.tree.indent がこれより広ければそちらを使う。 */
export const PARADIS_SECTION_TREE_INDENT = 12;

export type WorkspaceTreeElement = IParadisWorkspaceRepository | IParadisWorktree | ICreatingSpaceElement | ISectionHeaderElement | ISectionEmptyElement | ISpaceSectionHeaderElement | ISpaceSectionEmptyElement;

export function isSectionHeader(element: WorkspaceTreeElement): element is ISectionHeaderElement {
	return (element as ISectionHeaderElement).paradisSectionHeader === true;
}

export function isSectionEmpty(element: WorkspaceTreeElement): element is ISectionEmptyElement {
	return typeof (element as ISectionEmptyElement).paradisSectionEmpty === 'string';
}

export function isSpaceSectionHeader(element: WorkspaceTreeElement): element is ISpaceSectionHeaderElement {
	return (element as ISpaceSectionHeaderElement).paradisSpaceSectionHeader === true;
}

export function isSpaceSectionEmpty(element: WorkspaceTreeElement): element is ISpaceSectionEmptyElement {
	return typeof (element as ISpaceSectionEmptyElement).paradisSpaceSectionEmpty === 'string';
}

export function isCreating(element: WorkspaceTreeElement): element is ICreatingSpaceElement {
	return (element as ICreatingSpaceElement).creatingJob !== undefined;
}

export function isWorktree(element: WorkspaceTreeElement): element is IParadisWorktree {
	return !isCreating(element) && (element as IParadisWorktree).repositoryId !== undefined;
}

export function isRepository(element: WorkspaceTreeElement): element is IParadisWorkspaceRepository {
	return !isCreating(element) && !isWorktree(element) && !isSectionHeader(element) && !isSectionEmpty(element) && !isSpaceSectionHeader(element) && !isSpaceSectionEmpty(element);
}

export function isPinnedKeep(element: WorkspaceTreeElement): element is IPinnedKeepElement {
	return (element as IPinnedKeepElement).paradisPinnedKeep === true;
}

export function worktreeStateKeyFor(worktree: IParadisWorktree): string {
	return worktree.isMainCheckout ? worktree.repositoryId : paradisWorktreeStateKey(worktree.uri);
}

/** ツリーの identity（選択・フォーカス・開閉の保持に使う）。 */
export function paradisWorkspaceTreeElementId(element: WorkspaceTreeElement): string {
	if (isSectionHeader(element)) {
		return `section:${element.key}`;
	}
	if (isSectionEmpty(element)) {
		return `sectionEmpty:${element.paradisSectionEmpty}`;
	}
	if (isSpaceSectionHeader(element)) {
		// 作りかけは同時に 1 つだけ。セクションの id は全リポジトリで 1 つ
		return `spaceSection:${element.key}`;
	}
	if (isSpaceSectionEmpty(element)) {
		return `spaceSectionEmpty:${element.paradisSpaceSectionEmpty}`;
	}
	if (isCreating(element)) {
		return `creating:${element.creatingJob.id}`;
	}
	// ピン留めの控え行は、折りたたまれた子として隠れている実体と同時に存在するため別IDにする
	if (isPinnedKeep(element)) {
		return `pinnedKeep:${worktreeStateKeyFor(element)}`;
	}
	return isWorktree(element) ? `worktree:${worktreeStateKeyFor(element)}` : `repo:${element.id}`;
}

/** ツリーを組み立てるのに要る今の状態。 */
export interface IParadisWorkspaceTreeSource {
	/** 一覧の並び（セクションが 0 個のときに使う） */
	readonly repositories: readonly IParadisWorkspaceRepository[];
	/** セクションごとの並び（未分類は section が undefined の最後の 1 群） */
	readonly groups: readonly IParadisSectionGroup<IParadisWorkspaceRepository>[];
	/** 台帳にあるセクションの数 */
	readonly sectionCount: number;
	/** 「新しいセクション」の名前を入れている途中か */
	readonly drafting: boolean;
	isSectionCollapsed(key: string): boolean;
	isRepositoryCollapsed(repositoryId: string): boolean;
	/** リポジトリの子（main checkout・worktree・作成中）を並びのまま */
	repositoryChildren(repository: IParadisWorkspaceRepository): readonly (IParadisWorktree | ICreatingSpaceElement)[];
	isPinned(worktree: IParadisWorktree): boolean;
	/** そのリポジトリのスペースのセクション（順のまま。無ければ空） */
	spaceSections(repositoryId: string): readonly IParadisSpaceSection[];
	/** その子（スペース・作成中）が入っているスペースのセクションの id。local・セクションなしは undefined */
	spaceSectionOf(child: IParadisWorktree | ICreatingSpaceElement): string | undefined;
	isSpaceSectionCollapsed(sectionId: string): boolean;
	/** 「スペースのセクションを追加」の名前を入れている途中のリポジトリの id */
	readonly spaceSectionDraftRepositoryId: string | undefined;
}

export interface IParadisWorkspaceTree {
	readonly elements: IObjectTreeElement<WorkspaceTreeElement>[];
	/** セクションの見出しを 1 つ以上出しているか（字下げ 12・帯・罫線を使う） */
	readonly sectioned: boolean;
	readonly headers: ReadonlyMap<string, ISectionHeaderElement>;
	/** セクションの見出しの直下のプロジェクト（上の区切り線を引かない） */
	readonly sectionFirstRepositoryIds: ReadonlySet<string>;
	/** セクションの中で最後に見えている行の identity（罫線をそこで止める） */
	readonly sectionLastRowIds: ReadonlySet<string>;
	/** スペースのセクションの見出し（鍵 → 要素）。作りかけも含む */
	readonly spaceSectionHeaders: ReadonlyMap<string, ISpaceSectionHeaderElement>;
	/** スペースのセクションの中の行の identity（ツリーが足す 1 段の字下げをレンダラが戻す） */
	readonly spaceSectionMemberIds: ReadonlySet<string>;
}

type TreeEntry = IObjectTreeElement<WorkspaceTreeElement>;

/**
 * 一覧の行を組み立てる。セクションが 0 個なら見出しを出さず、プロジェクトをルートに並べる（今までと同じ一覧）。
 * セクションがあれば、見出しの子にプロジェクト、その子にスペースを入れる。
 */
export function paradisBuildWorkspaceTree(source: IParadisWorkspaceTreeSource): IParadisWorkspaceTree {
	const elements: TreeEntry[] = [];
	const headers = new Map<string, ISectionHeaderElement>();
	const sectionFirstRepositoryIds = new Set<string>();
	const sectionLastRowIds = new Set<string>();
	const spaceSectionHeaders = new Map<string, ISpaceSectionHeaderElement>();
	const spaceSectionMemberIds = new Set<string>();

	/**
	 * リポジトリの子の並び: local → セクションなし → セクションの順（paradisGroupSpacesBySection）。
	 * セクションが 0 個で作りかけも無ければ、今までと同じ平らな並び。withKeeps は、閉じたスペースのセクションの
	 * ピン留めの控えを見出しの直後に積むか（リポジトリかプロジェクトのセクションが閉じているときは、そちらの控えに任せる）。
	 */
	const repositoryEntries = (repository: IParadisWorkspaceRepository, withKeeps: boolean): TreeEntry[] => {
		const children = source.repositoryChildren(repository);
		const sections = source.spaceSections(repository.id);
		const drafting = source.spaceSectionDraftRepositoryId === repository.id;
		if (sections.length === 0 && !drafting) {
			return children.map(child => ({ element: child }));
		}
		const isMain = (child: IParadisWorktree | ICreatingSpaceElement) => isWorktree(child) && child.isMainCheckout === true;
		const grouping = paradisGroupSpacesBySection(children.filter(child => !isMain(child)), sections, child => source.spaceSectionOf(child));
		const entries: TreeEntry[] = [...children.filter(isMain), ...grouping.unsectioned].map(child => ({ element: child }));
		const pushHeader = (section: IParadisSpaceSection | undefined, key: string, members: readonly (IParadisWorktree | ICreatingSpaceElement)[], collapsed: boolean): void => {
			const spaces = members.filter(isWorktree);
			const header: ISpaceSectionHeaderElement = { paradisSpaceSectionHeader: true, ownerRepositoryId: repository.id, section, key, spaces, creatingCount: members.length - spaces.length };
			spaceSectionHeaders.set(key, header);
			const memberEntries: TreeEntry[] = section && members.length === 0
				? [{ element: { paradisSpaceSectionEmpty: section.id, ownerRepositoryId: repository.id } }]
				: members.map(member => ({ element: member }));
			for (const entry of memberEntries) {
				spaceSectionMemberIds.add(paradisWorkspaceTreeElementId(entry.element));
			}
			entries.push({ element: header, children: memberEntries, collapsible: true, collapsed });
			if (collapsed && withKeeps && section) {
				// 閉じたセクションの中のピン留めは、控えとして見出しの直下に残す（Q683-8）。控えは見出しの兄弟なので、
				// スペースの段にそのまま並ぶ（寄せは 0 段）
				for (const space of spaces) {
					if (source.isPinned(space)) {
						const keep: IPinnedKeepElement = { ...space, paradisPinnedKeep: true, keepLevels: 0, keepSpaceSectionId: section.id };
						entries.push({ element: keep });
					}
				}
			}
		};
		for (const group of grouping.groups) {
			pushHeader(group.section, group.section.id, group.spaces, source.isSpaceSectionCollapsed(group.section.id));
		}
		if (drafting) {
			pushHeader(undefined, SPACE_SECTION_DRAFT_KEY, [], false);
		}
		return entries;
	};

	const pinnedKeeps = (repository: IParadisWorkspaceRepository, keepLevels: number): TreeEntry[] => {
		const keeps: TreeEntry[] = [];
		for (const child of source.repositoryChildren(repository)) {
			if (isWorktree(child) && source.isPinned(child)) {
				const keep: IPinnedKeepElement = { ...child, paradisPinnedKeep: true, keepLevels };
				keeps.push({ element: keep });
			}
		}
		return keeps;
	};

	/** リポジトリの行（子はスペース）を積み、閉じていてかつ withKeeps ならピン留めの控えを直後に積む。 */
	const pushRepository = (into: TreeEntry[], repository: IParadisWorkspaceRepository, withKeeps: boolean): void => {
		const collapsed = source.isRepositoryCollapsed(repository.id);
		into.push({
			element: repository,
			children: repositoryEntries(repository, withKeeps && !collapsed),
			collapsible: true,
			collapsed: collapsed
				? ObjectTreeElementCollapseState.PreserveOrCollapsed
				: ObjectTreeElementCollapseState.PreserveOrExpanded
		});
		if (collapsed && withKeeps) {
			into.push(...pinnedKeeps(repository, 1));
		}
	};

	if (source.sectionCount === 0 && !source.drafting) {
		for (const repository of source.repositories) {
			pushRepository(elements, repository, true);
		}
		return { elements, sectioned: false, headers, sectionFirstRepositoryIds, sectionLastRowIds, spaceSectionHeaders, spaceSectionMemberIds };
	}

	const pushSection = (section: IParadisWorkspaceSection | undefined, key: string, repositories: readonly IParadisWorkspaceRepository[], collapsed: boolean): void => {
		const header: ISectionHeaderElement = { paradisSectionHeader: true, section, key, repositories, first: elements.length === 0 };
		headers.set(key, header);
		const children: TreeEntry[] = [];
		if (section && repositories.length === 0) {
			children.push({ element: { paradisSectionEmpty: section.id } });
		}
		repositories.forEach((repository, index) => {
			if (index === 0) {
				sectionFirstRepositoryIds.add(repository.id);
			}
			// 閉じたセクションの中では控えを積まない（控えは見出しの直下にまとめて出す。両方に出すと同じ id が 2 つになる）
			pushRepository(children, repository, !collapsed);
		});
		elements.push({ element: header, children, collapsible: true, collapsed });
		if (collapsed) {
			// 閉じたセクションでも、ピン留めした行は控えとして見出しの直下に残す（リポジトリを閉じたときと同じ考え方）
			const keeps = repositories.flatMap(repository => pinnedKeeps(repository, 2));
			elements.push(...keeps);
			if (keeps.length > 0) {
				sectionLastRowIds.add(paradisWorkspaceTreeElementId(keeps[keeps.length - 1].element));
			}
			return;
		}
		const last = lastVisibleEntry(children);
		if (last) {
			sectionLastRowIds.add(paradisWorkspaceTreeElementId(last.element));
		}
	};

	for (const group of source.groups) {
		// 作りかけの見出しは、今あるセクションの後・未分類の前に並べる
		if (group.section === undefined && source.drafting) {
			pushSection(undefined, SECTION_DRAFT_KEY, [], false);
		}
		const key = group.section?.id ?? PARADIS_UNCATEGORIZED_SECTION_KEY;
		pushSection(group.section, key, group.repositories, source.isSectionCollapsed(key));
	}
	if (source.drafting && !headers.has(SECTION_DRAFT_KEY)) {
		pushSection(undefined, SECTION_DRAFT_KEY, [], false);
	}
	return { elements, sectioned: true, headers, sectionFirstRepositoryIds, sectionLastRowIds, spaceSectionHeaders, spaceSectionMemberIds };
}

/** entries の中で最後に見える行（開いたリポジトリならその最後の子）。 */
function lastVisibleEntry(entries: readonly TreeEntry[]): TreeEntry | undefined {
	const last = entries[entries.length - 1];
	if (!last) {
		return undefined;
	}
	const children = last.children ? [...last.children] : [];
	const expanded = last.collapsed === undefined || last.collapsed === false || last.collapsed === ObjectTreeElementCollapseState.Expanded || last.collapsed === ObjectTreeElementCollapseState.PreserveOrExpanded;
	if (children.length > 0 && expanded) {
		return lastVisibleEntry(children) ?? last;
	}
	return last;
}

/**
 * 組み立てた一覧にいるスペースの行を、深さに関わらずすべて集める（ピン留めの控えも含む）。
 * **ルートと 1 段下だけを見てはいけない**: セクションの下ではスペースが深さ 3 にいるため、拾い損ねると
 * メタ段の判定に載らず、メタ段ごと非表示・行の高さも 2 段のまま、という状態で固定される。
 */
export function paradisCollectTreeWorktrees(entries: Iterable<IObjectTreeElement<WorkspaceTreeElement>>): IParadisWorktree[] {
	const worktrees: IParadisWorktree[] = [];
	const visit = (list: Iterable<IObjectTreeElement<WorkspaceTreeElement>>) => {
		for (const entry of list) {
			if (isWorktree(entry.element)) {
				worktrees.push(entry.element);
			}
			if (entry.children) {
				visit(entry.children);
			}
		}
	};
	visit(entries);
	return worktrees;
}

/**
 * ピン留めの控えが、直前の閉じた行（プロジェクトか、セクションの見出し）のものか。
 * 閉じたプロジェクトの控えは 1 段、閉じたセクションの控えは 2 段寄せてあり、中のプロジェクトで持ち主が分かる。
 */
export function paradisKeepBelongsTo(keep: IPinnedKeepElement, owner: WorkspaceTreeElement): boolean {
	if (isSpaceSectionHeader(owner)) {
		return keep.keepSpaceSectionId !== undefined && keep.keepSpaceSectionId === owner.section?.id;
	}
	if (keep.keepSpaceSectionId !== undefined) {
		return false;
	}
	if (isSectionHeader(owner)) {
		return keep.keepLevels === 2 && owner.repositories.some(repository => repository.id === keep.repositoryId);
	}
	return isRepository(owner) && keep.keepLevels === 1 && keep.repositoryId === owner.id;
}

/**
 * ピン留めの控えの読み上げの階層（aria-level）。控えは閉じた行の兄弟としてツリーに入るのでツリーの深さは浅いが、
 * 見た目は本来のスペースの段に寄せてあるので、読み上げもその段にそろえる。
 * 閉じたセクションの下（2 段寄せ）は深さ 3、閉じたプロジェクトの下（1 段寄せ）はプロジェクトの深さ + 1、
 * 閉じたスペースのセクションの下は、開いたときの中の行と同じ深さ（プロジェクトの深さ + 2）。
 */
export function paradisPinnedKeepAriaLevel(keep: IPinnedKeepElement, sectioned: boolean): number {
	if (keep.keepSpaceSectionId !== undefined) {
		return sectioned ? 4 : 3;
	}
	if (keep.keepLevels === 2) {
		return 3;
	}
	return sectioned ? 3 : 2;
}

/** ドラッグできる行（見出し・プロジェクト・スペース）。 */
export type ParadisDraggedElement = IParadisWorkspaceRepository | IParadisWorktree | ISectionHeaderElement | ISpaceSectionHeaderElement;

/**
 * 落としたときに起きること。intoSection = そのセクションの最後へ入れる（undefined は未分類）、
 * intoSpaceSection = そのスペースのセクションの最後へ入れる（undefined はセクションから外し、local のすぐ下へ）、
 * reorder = 同じ種類の行の前後へ並べ替える（スペース同士なら、落とした先の所属へ入る）。
 */
export type ParadisWorkspaceDrop =
	| { readonly kind: 'intoSection'; readonly sectionId: string | undefined }
	| { readonly kind: 'intoSpaceSection'; readonly sectionId: string | undefined }
	| { readonly kind: 'reorder'; readonly after: boolean };

/**
 * ドラッグの判定。セクションの見出しはプロジェクトの親になったが、判定は行の種類で決める:
 * - プロジェクトを見出し・空のセクションの案内の行へ: そのセクションの中へ入れる
 * - 見出し同士: セクションの並べ替え（未分類・作りかけは動かさない）
 * - プロジェクト同士: 落とした先と同じセクションの前後へ（別のセクションでもよい）
 * - スペース同士: 同じリポジトリの中だけ（main checkout・控えは除く）。別のセクションのスペースへ落とすと所属も変わる
 * - スペースをスペースのセクションの見出し・空のセクションの案内の行へ: そのセクションの最後へ（同じリポジトリの中だけ）
 * - セクションに入っているスペースを local の行へ: セクションから外す（draggedInSpaceSection のときだけ）
 * - スペースのセクションの見出し同士: 同じリポジトリの中での並べ替え（作りかけは動かさない）
 * それ以外（見出しを中のプロジェクトへ、プロジェクトをスペースの行へ、別のリポジトリへ等）は受け付けない。
 */
export function paradisWorkspaceDropDecision(dragged: ParadisDraggedElement, target: WorkspaceTreeElement, placeAfter: boolean, draggedInSpaceSection = false): ParadisWorkspaceDrop | undefined {
	if (isSpaceSectionHeader(dragged)) {
		return isSpaceSectionHeader(target) && dragged.section !== undefined && target.section !== undefined && target.ownerRepositoryId === dragged.ownerRepositoryId && target.section.id !== dragged.section.id
			? { kind: 'reorder', after: placeAfter }
			: undefined;
	}
	if (isSpaceSectionHeader(target) || isSpaceSectionEmpty(target)) {
		if (!isWorktree(dragged) || dragged.isMainCheckout || target.ownerRepositoryId !== dragged.repositoryId) {
			return undefined;
		}
		const sectionId = isSpaceSectionHeader(target) ? target.section?.id : target.paradisSpaceSectionEmpty;
		return sectionId === undefined ? undefined : { kind: 'intoSpaceSection', sectionId };
	}
	if (isRepository(dragged)) {
		if (isSectionEmpty(target)) {
			return { kind: 'intoSection', sectionId: target.paradisSectionEmpty };
		}
		if (isSectionHeader(target)) {
			return target.key === SECTION_DRAFT_KEY ? undefined : { kind: 'intoSection', sectionId: target.section?.id };
		}
	}
	if (isPinnedKeep(target)) {
		return undefined;
	}
	if (isSectionHeader(dragged)) {
		return isSectionHeader(target) && target.section !== undefined && target.section.id !== dragged.section?.id
			? { kind: 'reorder', after: placeAfter }
			: undefined;
	}
	if (isWorktree(dragged)) {
		if (!isWorktree(target) || target.repositoryId !== dragged.repositoryId) {
			return undefined;
		}
		if (target.isMainCheckout) {
			return draggedInSpaceSection ? { kind: 'intoSpaceSection', sectionId: undefined } : undefined;
		}
		return { kind: 'reorder', after: placeAfter };
	}
	return isRepository(target) ? { kind: 'reorder', after: placeAfter } : undefined;
}
