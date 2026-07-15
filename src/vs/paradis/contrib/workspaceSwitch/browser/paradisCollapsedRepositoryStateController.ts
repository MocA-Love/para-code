/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorktree } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY, paradisLoadCollapsedRepositoryIds, paradisRemoveStaleCollapsedRepositoryIds, paradisSerializeCollapsedRepositoryIds, paradisSetRepositoryCollapsed } from '../common/paradisWorkspaceTreeState.js';

const SAVE_DELAY_MS = 100;
const RETRY_DELAY_MS = 1_000;
const MAX_SAVE_RETRIES = 3;

export interface IParadisCollapsedStateScheduler extends IDisposable {
	schedule(delay: number): void;
	cancel(): void;
}

type SchedulerFactory = (runner: () => void) => IParadisCollapsedStateScheduler;

function isWorktree(element: IParadisWorkspaceRepository | IParadisWorktree): element is IParadisWorktree {
	return (element as IParadisWorktree).repositoryId !== undefined;
}

export class ParadisCollapsedRepositoryStateController extends Disposable {
	private readonly collapsedRepositoryIds: Set<string>;
	private readonly scheduler: IParadisCollapsedStateScheduler;
	private dirty = false;
	private saveFailures = 0;

	constructor(
		private readonly storageService: IStorageService,
		private readonly logService: ILogService,
		schedulerFactory: SchedulerFactory = runner => new RunOnceScheduler(runner, SAVE_DELAY_MS),
	) {
		super();
		this.collapsedRepositoryIds = paradisLoadCollapsedRepositoryIds(
			() => this.storageService.get(PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY, StorageScope.WORKSPACE),
			() => this.logService.warn('[ParadisWorkspacesView] Failed to load collapsed repository state'),
		);
		this.scheduler = this._register(schedulerFactory(() => this.persist()));
	}

	isRepositoryCollapsed(repositoryId: string): boolean {
		return this.collapsedRepositoryIds.has(repositoryId);
	}

	recordTreeCollapse(element: IParadisWorkspaceRepository | IParadisWorktree, collapsed: boolean): void {
		if (isWorktree(element)) {
			return;
		}
		if (paradisSetRepositoryCollapsed(this.collapsedRepositoryIds, element.id, collapsed)) {
			this.markDirty();
		}
	}

	removeStaleRepositories(liveRepositoryIds: ReadonlySet<string>): void {
		if (paradisRemoveStaleCollapsedRepositoryIds(this.collapsedRepositoryIds, liveRepositoryIds)) {
			this.markDirty();
		}
	}

	private markDirty(): void {
		this.dirty = true;
		this.scheduler.schedule(SAVE_DELAY_MS);
	}

	private persist(): void {
		if (!this.dirty) {
			return;
		}
		const serialized = paradisSerializeCollapsedRepositoryIds(this.collapsedRepositoryIds);
		if (serialized === undefined) {
			try {
				this.logService.warn('[ParadisWorkspacesView] Refused to persist oversized collapsed repository state');
			} catch {
				// Diagnostics must not interrupt tree interaction or view disposal.
			}
			return;
		}
		try {
			this.storageService.store(
				PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY,
				serialized,
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
			this.dirty = false;
			this.saveFailures = 0;
		} catch {
			try {
				this.logService.warn('[ParadisWorkspacesView] Failed to persist collapsed repository state');
			} catch {
				// Diagnostics must not interrupt tree interaction or view disposal.
			}
			if (this.saveFailures++ < MAX_SAVE_RETRIES) {
				this.scheduler.schedule(RETRY_DELAY_MS);
			}
		}
	}

	override dispose(): void {
		this.scheduler.cancel();
		this.persist();
		super.dispose();
	}
}
