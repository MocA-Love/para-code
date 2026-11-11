/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IObjectTreeElement, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { IParadisWorkspaceRepository, IParadisWorktree, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
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
	/** 閉じたリポジトリの下は 1、閉じたセクションの下は 2（セクション → プロジェクト → スペースの 2 段ぶん） */
	readonly keepLevels: number;
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

/** 「新しいセクション」でその場の入力欄を出している間だけ並ぶ、まだ台帳に無い見出しの鍵。 */
export const SECTION_DRAFT_KEY = 'paradis-section-draft';

/** セクションがあるときの 1 段の字下げ（Q607 案 B）。設定 workbench.tree.indent がこれより広ければそちらを使う。 */
export const PARADIS_SECTION_TREE_INDENT = 12;

export type WorkspaceTreeElement = IParadisWorkspaceRepository | IParadisWorktree | ICreatingSpaceElement | ISectionHeaderElement | ISectionEmptyElement;

export function isSectionHeader(element: WorkspaceTreeElement): element is ISectionHeaderElement {
	return (element as ISectionHeaderElement).paradisSectionHeader === true;
}

export function isSectionEmpty(element: WorkspaceTreeElement): element is ISectionEmptyElement {
	return typeof (element as ISectionEmptyElement).paradisSectionEmpty === 'string';
}

export function isCreating(element: WorkspaceTreeElement): element is ICreatingSpaceElement {
	return (element as ICreatingSpaceElement).creatingJob !== undefined;
}

export function isWorktree(element: WorkspaceTreeElement): element is IParadisWorktree {
	return !isCreating(element) && (element as IParadisWorktree).repositoryId !== undefined;
}

export function isRepository(element: WorkspaceTreeElement): element is IParadisWorkspaceRepository {
	return !isCreating(element) && !isWorktree(element) && !isSectionHeader(element) && !isSectionEmpty(element);
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
			children: source.repositoryChildren(repository).map(child => ({ element: child })),
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
		return { elements, sectioned: false, headers, sectionFirstRepositoryIds, sectionLastRowIds };
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
	return { elements, sectioned: true, headers, sectionFirstRepositoryIds, sectionLastRowIds };
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
	if (isSectionHeader(owner)) {
		return keep.keepLevels === 2 && owner.repositories.some(repository => repository.id === keep.repositoryId);
	}
	return isRepository(owner) && keep.keepLevels === 1 && keep.repositoryId === owner.id;
}

/**
 * ピン留めの控えの読み上げの階層（aria-level）。控えは閉じた行の兄弟としてツリーに入るのでツリーの深さは浅いが、
 * 見た目は本来のスペースの段に寄せてあるので、読み上げもその段にそろえる。
 * 閉じたセクションの下（2 段寄せ）は深さ 3、閉じたプロジェクトの下（1 段寄せ）はプロジェクトの深さ + 1。
 */
export function paradisPinnedKeepAriaLevel(keep: IPinnedKeepElement, sectioned: boolean): number {
	if (keep.keepLevels === 2) {
		return 3;
	}
	return sectioned ? 3 : 2;
}

/** ドラッグできる行（見出し・プロジェクト・スペース）。 */
export type ParadisDraggedElement = IParadisWorkspaceRepository | IParadisWorktree | ISectionHeaderElement;

/**
 * 落としたときに起きること。intoSection = そのセクションの最後へ入れる（undefined は未分類）、
 * reorder = 同じ種類の行の前後へ並べ替える。
 */
export type ParadisWorkspaceDrop =
	| { readonly kind: 'intoSection'; readonly sectionId: string | undefined }
	| { readonly kind: 'reorder'; readonly after: boolean };

/**
 * ドラッグの判定。セクションの見出しはプロジェクトの親になったが、判定は行の種類で決める:
 * - プロジェクトを見出し・空のセクションの案内の行へ: そのセクションの中へ入れる
 * - 見出し同士: セクションの並べ替え（未分類・作りかけは動かさない）
 * - プロジェクト同士: 落とした先と同じセクションの前後へ（別のセクションでもよい）
 * - スペース同士: 同じリポジトリの中だけ（main checkout・控えは除く）
 * それ以外（見出しを中のプロジェクトへ、プロジェクトをスペースの行へ等）は受け付けない。
 */
export function paradisWorkspaceDropDecision(dragged: ParadisDraggedElement, target: WorkspaceTreeElement, placeAfter: boolean): ParadisWorkspaceDrop | undefined {
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
		return isWorktree(target) && !target.isMainCheckout && target.repositoryId === dragged.repositoryId
			? { kind: 'reorder', after: placeAfter }
			: undefined;
	}
	return isRepository(target) ? { kind: 'reorder', after: placeAfter } : undefined;
}
