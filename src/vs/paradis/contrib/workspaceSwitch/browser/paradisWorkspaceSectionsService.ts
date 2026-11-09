/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';
import { IParadisSectionGroup, IParadisWorkspaceSections, IParadisWorkspaceSectionsService, paradisAddSection, paradisAssignRepository, paradisGroupRepositoriesBySection, paradisLedgerOrderAfterMove, paradisLedgerOrderAfterSwapInSection, paradisMoveSection, paradisNormalizeSectionName, paradisOrderRepositoriesBySection, paradisParseCollapsedSections, paradisParseWorkspaceSections, paradisRemoveSection, paradisRenameSection, paradisReorderSectionByDrop, paradisSectionOf, paradisSectionOrderedIds, paradisSerializeCollapsedSections, paradisSerializeWorkspaceSections, paradisSetSectionColor, PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY, PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY } from '../common/paradisWorkspaceSections.js';

export class ParadisWorkspaceSectionsService extends Disposable implements IParadisWorkspaceSectionsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: IParadisWorkspaceSections;
	private readonly _collapsed: Set<string>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._state = paradisParseWorkspaceSections(this.storageService.get(PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY, StorageScope.WORKSPACE));
		this._collapsed = paradisParseCollapsedSections(this.storageService.get(PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY, StorageScope.WORKSPACE));
	}

	get state(): IParadisWorkspaceSections {
		return this._state;
	}

	groups(): IParadisSectionGroup<IParadisWorkspaceRepository>[] {
		return paradisGroupRepositoriesBySection(this.workspaceSwitchService.repositories, this._state);
	}

	orderedRepositories(): IParadisWorkspaceRepository[] {
		return paradisOrderRepositoriesBySection(this.workspaceSwitchService.repositories, this._state);
	}

	sectionOf(repositoryId: string): string | undefined {
		return paradisSectionOf(this._state, repositoryId);
	}

	isCollapsed(sectionKey: string): boolean {
		return this._collapsed.has(sectionKey);
	}

	setCollapsed(sectionKey: string, collapsed: boolean): void {
		if (collapsed === this._collapsed.has(sectionKey)) {
			return;
		}
		if (collapsed) {
			this._collapsed.add(sectionKey);
		} else {
			this._collapsed.delete(sectionKey);
		}
		this.storeCollapsed();
		this._onDidChange.fire();
	}

	createSection(name: string, repositoryId?: string): string | undefined {
		const normalized = paradisNormalizeSectionName(name);
		if (normalized === undefined) {
			return undefined;
		}
		const id = generateUuid();
		let next = paradisAddSection(this._state, { id, name: normalized });
		if (!next) {
			return undefined;
		}
		if (repositoryId !== undefined) {
			next = paradisAssignRepository(next, repositoryId, id) ?? next;
		}
		this.apply(next, repositoryId !== undefined ? { repositoryId, target: undefined } : undefined);
		return id;
	}

	renameSection(id: string, name: string): void {
		this.apply(paradisRenameSection(this._state, id, name));
	}

	setSectionColor(id: string, color: string | undefined): void {
		this.apply(paradisSetSectionColor(this._state, id, color));
	}

	moveSection(id: string, direction: -1 | 1): void {
		this.apply(paradisMoveSection(this._state, id, direction));
	}

	reorderSection(draggedId: string, targetId: string, placeAfter: boolean): void {
		this.apply(paradisReorderSectionByDrop(this._state, draggedId, targetId, placeAfter));
	}

	removeSection(id: string): void {
		const next = paradisRemoveSection(this._state, id);
		if (next && this._collapsed.delete(id)) {
			this.storeCollapsed();
		}
		this.apply(next);
	}

	moveRepositoryToSection(repositoryId: string, sectionId: string | undefined, target?: { readonly repositoryId: string; readonly after: boolean }): void {
		const next = paradisAssignRepository(this._state, repositoryId, sectionId);
		if (next) {
			this.apply(next, { repositoryId, target });
			return;
		}
		// 所属が変わらない（同じセクションの中での並べ替え）
		if (target && paradisSectionOf(this._state, repositoryId) === sectionId) {
			this.alignLedger(paradisLedgerOrderAfterMove(this.ledgerIds(), this._state, repositoryId, target));
		}
	}

	moveRepositoryWithinSection(repositoryId: string, direction: -1 | 1): void {
		const ordered = paradisLedgerOrderAfterSwapInSection(this.ledgerIds(), this._state, repositoryId, direction);
		if (ordered) {
			this.alignLedger(ordered);
		}
	}

	canMoveRepositoryWithinSection(repositoryId: string, direction: -1 | 1): boolean {
		return paradisLedgerOrderAfterSwapInSection(this.ledgerIds(), this._state, repositoryId, direction) !== undefined;
	}

	private ledgerIds(): string[] {
		return this.workspaceSwitchService.repositories.map(repository => repository.id);
	}

	/**
	 * 新しい状態を保存して知らせ、プロジェクトの台帳の順を一覧の順へ揃える。moved があれば、そのプロジェクトを
	 * target の前（後）か所属先の最後へ置いてから揃える。
	 */
	private apply(next: IParadisWorkspaceSections | undefined, moved?: { readonly repositoryId: string; readonly target: { readonly repositoryId: string; readonly after: boolean } | undefined }): void {
		if (!next) {
			return;
		}
		const serialized = paradisSerializeWorkspaceSections(next);
		if (serialized === undefined) {
			this.logService.warn('[ParadisWorkspaceSections] Refused to persist oversized sections');
			return;
		}
		this._state = next;
		this.storageService.store(PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
		this.alignLedger(moved
			? paradisLedgerOrderAfterMove(this.ledgerIds(), next, moved.repositoryId, moved.target)
			: paradisSectionOrderedIds(this.ledgerIds(), next));
	}

	/** 台帳の順を変える（同じなら reorderRepositories が何もしない）。 */
	private alignLedger(orderedIds: readonly string[]): void {
		this.workspaceSwitchService.reorderRepositories(orderedIds);
	}

	private storeCollapsed(): void {
		this.storageService.store(PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY, paradisSerializeCollapsedSections(this._collapsed), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
