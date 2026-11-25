/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { equals } from '../../../../base/common/arrays.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisSpaceSection, IParadisSpaceSectionsService, paradisAddSpaceSection, paradisAssignSpace, paradisDropRemovedRepositorySpaceSections, paradisMoveSpaceSection, paradisParseSpaceSections, paradisPruneSpaceAssignments, paradisRemoveSpaceSection, paradisRenameSpaceSection, paradisReorderSpaceSectionByDrop, paradisSectionOrderedSpaceKeys, paradisSerializeSpaceSections, paradisSpaceOrderAfterMove, paradisSpaceOrderAfterSwapInSection, paradisSpaceSectionIds, paradisSpaceSectionOf, ParadisSpaceMoveTarget, ParadisSpaceSections, PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, PARADIS_SPACE_SECTIONS_MAX_COLLAPSED, PARADIS_SPACE_SECTIONS_STORAGE_KEY } from '../common/paradisSpaceSections.js';
import { paradisNormalizeSectionName, paradisParseCollapsedSections, paradisSerializeCollapsedSections } from '../common/paradisWorkspaceSections.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';

export class ParadisSpaceSectionsService extends Disposable implements IParadisSpaceSectionsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: ParadisSpaceSections;
	private _collapsed: Set<string>;
	/**
	 * 自分が書いた値。同じワークスペースを開いたほかの窓が書いたときは読み直すが、自分の書き込みの通知では
	 * 読み直さない（paradisWorkspaceSectionsService と同じ）。
	 */
	private lastWrittenSections: string | undefined;
	private lastWrittenCollapsed: string | undefined;
	/** リポジトリ id → 最後に書いた並び（URI の列）。一覧がその並びになるまで残す */
	private readonly pendingOrders = new Map<string, readonly string[]>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._state = paradisParseSpaceSections(this.storageService.get(PARADIS_SPACE_SECTIONS_STORAGE_KEY, StorageScope.WORKSPACE));
		this._collapsed = paradisParseCollapsedSections(this.storageService.get(PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, StorageScope.WORKSPACE), PARADIS_SPACE_SECTIONS_MAX_COLLAPSED);
		// 同じワークスペースを 2 つの窓で開いているとき、ほかの窓の変更を読み直す。読み直さないと、
		// こちらの古い状態を次の書き込みで書き戻し、先の窓の変更を消してしまう
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PARADIS_SPACE_SECTIONS_STORAGE_KEY, this._store)(() => {
			const raw = this.storageService.get(PARADIS_SPACE_SECTIONS_STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw === this.lastWrittenSections) {
				return;
			}
			this._state = paradisParseSpaceSections(raw);
			this._onDidChange.fire();
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, this._store)(() => {
			const raw = this.storageService.get(PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw === this.lastWrittenCollapsed) {
				return;
			}
			this._collapsed = paradisParseCollapsedSections(raw, PARADIS_SPACE_SECTIONS_MAX_COLLAPSED);
			this._onDidChange.fire();
		}));
		// 新しく見つかった・作ったスペースは並びの最後に入るので、一覧が変わるたびに並び（worktreeOrder）を一覧の順へ揃える。
		// モバイルへ送る順など、並びをそのまま読む所が一覧と同じ順になる。同じ順なら書かない
		this._register(this.worktreeService.onDidChangeWorktrees(() => {
			for (const [repositoryId, entry] of this._state) {
				// 並びを書いた直後は、次の走査が終わるまで一覧が前の並びのまま。その並びから揃え直すと、いま書いた並びを書き戻してしまう
				if (!this.isOrderWritePending(repositoryId)) {
					this.alignOrder(repositoryId, paradisSectionOrderedSpaceKeys(this.orderKeys(repositoryId), entry));
				}
			}
		}));
		// リポジトリを一覧から外したら、そのリポジトリの分を丸ごと消す（一覧が空のときは何もしない）
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => {
			const next = paradisDropRemovedRepositorySpaceSections(this._state, this.workspaceSwitchService.repositories.map(repository => repository.id));
			if (next !== this._state) {
				this.apply(next);
			}
		}));
	}

	sectionsOf(repositoryId: string): readonly IParadisSpaceSection[] {
		return this._state.get(repositoryId)?.sections ?? [];
	}

	sectionOf(worktree: IParadisWorktree): string | undefined {
		return worktree.isMainCheckout ? undefined : paradisSpaceSectionOf(this._state.get(worktree.repositoryId), paradisWorktreeStateKey(worktree.uri));
	}

	orderedWorktrees(repositoryId: string): IParadisWorktree[] {
		const byKey = new Map(this.worktreeService.getWorktrees(repositoryId).map(worktree => [paradisWorktreeStateKey(worktree.uri), worktree]));
		return paradisSectionOrderedSpaceKeys([...byKey.keys()], this._state.get(repositoryId)).map(stateKey => byKey.get(stateKey)!);
	}

	isCollapsed(sectionId: string): boolean {
		return this._collapsed.has(sectionId);
	}

	setCollapsed(sectionId: string, collapsed: boolean): void {
		if (collapsed === this._collapsed.has(sectionId)) {
			return;
		}
		if (collapsed) {
			if (this._collapsed.size >= PARADIS_SPACE_SECTIONS_MAX_COLLAPSED) {
				return;
			}
			this._collapsed.add(sectionId);
		} else {
			this._collapsed.delete(sectionId);
		}
		this.storeCollapsed();
		this._onDidChange.fire();
	}

	createSection(repositoryId: string, name: string, worktree?: IParadisWorktree): string | undefined {
		const normalized = paradisNormalizeSectionName(name);
		if (normalized === undefined || !this.workspaceSwitchService.repositories.some(repository => repository.id === repositoryId)) {
			return undefined;
		}
		const id = generateUuid();
		let next = paradisAddSpaceSection(this._state, repositoryId, { id, name: normalized });
		if (!next) {
			return undefined;
		}
		const movedKey = worktree && !worktree.isMainCheckout && worktree.repositoryId === repositoryId ? paradisWorktreeStateKey(worktree.uri) : undefined;
		if (movedKey !== undefined) {
			next = paradisAssignSpace(next, repositoryId, movedKey, id) ?? next;
		}
		this.apply(next, movedKey !== undefined ? { repositoryId, stateKey: movedKey, target: 'last' } : { repositoryId });
		return id;
	}

	renameSection(repositoryId: string, id: string, name: string): void {
		this.apply(paradisRenameSpaceSection(this._state, repositoryId, id, name));
	}

	moveSection(repositoryId: string, id: string, direction: -1 | 1): void {
		this.apply(paradisMoveSpaceSection(this._state, repositoryId, id, direction), { repositoryId });
	}

	reorderSection(repositoryId: string, draggedId: string, targetId: string, placeAfter: boolean): void {
		this.apply(paradisReorderSpaceSectionByDrop(this._state, repositoryId, draggedId, targetId, placeAfter), { repositoryId });
	}

	removeSection(repositoryId: string, id: string): void {
		const next = paradisRemoveSpaceSection(this._state, repositoryId, id);
		if (next && this._collapsed.delete(id)) {
			this.storeCollapsed();
		}
		this.apply(next, { repositoryId });
	}

	moveSpaceToSection(worktree: IParadisWorktree, sectionId: string | undefined, target?: { readonly worktree: IParadisWorktree; readonly after: boolean } | 'first'): void {
		if (worktree.isMainCheckout) {
			return;
		}
		const repositoryId = worktree.repositoryId;
		const stateKey = paradisWorktreeStateKey(worktree.uri);
		const moveTarget: ParadisSpaceMoveTarget = target === undefined ? 'last' : target === 'first' ? 'first' : { stateKey: paradisWorktreeStateKey(target.worktree.uri), after: target.after };
		const next = paradisAssignSpace(this._state, repositoryId, stateKey, sectionId);
		if (next) {
			this.apply(next, { repositoryId, stateKey, target: moveTarget });
			return;
		}
		// 所属が変わらない（同じ所属の中での並べ替え）。セクションが 0 個のリポジトリの並べ替えもここを通る
		if (target !== undefined && this.sectionOf(worktree) === sectionId) {
			this.alignOrder(repositoryId, paradisSpaceOrderAfterMove(this.orderKeys(repositoryId), this._state.get(repositoryId), stateKey, moveTarget));
		}
	}

	moveSpaceWithinSection(worktree: IParadisWorktree, direction: -1 | 1): void {
		const ordered = this.orderAfterSwap(worktree, direction);
		if (ordered) {
			this.alignOrder(worktree.repositoryId, ordered);
		}
	}

	canMoveSpaceWithinSection(worktree: IParadisWorktree, direction: -1 | 1): boolean {
		return this.orderAfterSwap(worktree, direction) !== undefined;
	}

	private orderAfterSwap(worktree: IParadisWorktree, direction: -1 | 1): string[] | undefined {
		if (worktree.isMainCheckout) {
			return undefined;
		}
		return paradisSpaceOrderAfterSwapInSection(this.orderKeys(worktree.repositoryId), this._state.get(worktree.repositoryId), paradisWorktreeStateKey(worktree.uri), direction);
	}

	/** そのリポジトリのスペース（local を除く）の今の並びを、状態キーの列で。 */
	private orderKeys(repositoryId: string): string[] {
		return this.worktreeService.getWorktrees(repositoryId).map(worktree => paradisWorktreeStateKey(worktree.uri));
	}

	/** 割り当てを残してよいスペース: 一覧にあるものと、既知のスペース。一覧が空なら空（刈らない）。 */
	private liveKeys(repositoryId: string): string[] {
		const listed = this.orderKeys(repositoryId);
		return listed.length === 0 ? listed : [...listed, ...this.worktreeService.getKnownWorktreeStateKeys(repositoryId)];
	}

	/**
	 * 新しい状態を保存して知らせ、aligned のリポジトリのスペースの並び（worktreeOrder）を一覧の順へ揃える。
	 * aligned.stateKey があれば、そのスペースを target の位置へ置いてから揃える。
	 */
	private apply(next: ParadisSpaceSections | undefined, aligned?: { readonly repositoryId: string; readonly stateKey?: string; readonly target?: ParadisSpaceMoveTarget }): void {
		if (!next) {
			return;
		}
		// 一覧から消えたスペースの割り当ては、書くときに刈る（溜まると上限で新しい割り当てが断られる）。
		// 走査が終わっていない・一覧が空のリポジトリは刈らない（SSH の切断で全部の割り当てを失わないため）
		// 作った直後のスペースは一覧（getWorktrees）にまだ載っていないので、既知のスペース（addKnownWorktree 済み）も今あるものに数える
		next = paradisPruneSpaceAssignments(next, repositoryId => this.worktreeService.isWorktreeListComplete?.(repositoryId) ? this.liveKeys(repositoryId) : undefined);
		const serialized = paradisSerializeSpaceSections(next);
		if (serialized === undefined) {
			this.logService.warn('[ParadisSpaceSections] Refused to persist oversized space sections');
			return;
		}
		this._state = next;
		this.lastWrittenSections = serialized;
		this.storageService.store(PARADIS_SPACE_SECTIONS_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		// 消えたセクションの開閉の印を残さない
		const liveSectionIds = paradisSpaceSectionIds(next);
		let collapsedChanged = false;
		for (const sectionId of [...this._collapsed]) {
			if (!liveSectionIds.has(sectionId)) {
				this._collapsed.delete(sectionId);
				collapsedChanged = true;
			}
		}
		if (collapsedChanged) {
			this.storeCollapsed();
		}
		this._onDidChange.fire();
		if (aligned) {
			const keys = this.orderKeys(aligned.repositoryId);
			const entry = next.get(aligned.repositoryId);
			this.alignOrder(aligned.repositoryId, aligned.stateKey !== undefined && aligned.target !== undefined
				? paradisSpaceOrderAfterMove(keys, entry, aligned.stateKey, aligned.target)
				: paradisSectionOrderedSpaceKeys(keys, entry));
		}
	}

	/** スペースの並びを変える。今と同じなら書かない（setWorktreeOrder はディスクの読み直しを予約するため）。 */
	private alignOrder(repositoryId: string, orderedKeys: readonly string[]): void {
		const worktrees = this.worktreeService.getWorktrees(repositoryId);
		const uriByKey = new Map(worktrees.map(worktree => [paradisWorktreeStateKey(worktree.uri), worktree.uri.toString()]));
		const orderedUris = orderedKeys.map(stateKey => uriByKey.get(stateKey)).filter((uri): uri is string => uri !== undefined);
		if (orderedUris.length !== worktrees.length || equals(orderedUris, worktrees.map(worktree => worktree.uri.toString()))) {
			return;
		}
		this.pendingOrders.set(repositoryId, orderedUris);
		this.worktreeService.setWorktreeOrder(repositoryId, orderedUris);
	}

	/** 書いた並びがまだ一覧に出ていないか。出ていれば（消えた・増えたスペースは除いて比べる）覚えを捨てる。 */
	private isOrderWritePending(repositoryId: string): boolean {
		const pending = this.pendingOrders.get(repositoryId);
		if (!pending) {
			return false;
		}
		const listed = this.worktreeService.getWorktrees(repositoryId).map(worktree => worktree.uri.toString());
		const written = new Set(pending);
		const present = new Set(listed);
		if (equals(listed.filter(uri => written.has(uri)), pending.filter(uri => present.has(uri)))) {
			this.pendingOrders.delete(repositoryId);
			return false;
		}
		return true;
	}

	private storeCollapsed(): void {
		const serialized = paradisSerializeCollapsedSections(this._collapsed);
		this.lastWrittenCollapsed = serialized;
		this.storageService.store(PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
