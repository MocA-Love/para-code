/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroup, ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

interface ISerializedTerminalRepositoryEntry {
	readonly persistentProcessId: number;
	readonly repositoryId: string;
}

/**
 * ターミナルグループをリポジトリ単位でスコープする (機能1 Phase 2)。
 *
 * - 新しいグループは生成時のアクティブリポジトリでタグ付けする
 * - リポジトリ切り替え時、他リポジトリのグループを park (TerminalGroupService の
 *   PARA-PATCH メソッド。groups から外れタブリスト/パネルから消えるが PTY は生存)、
 *   切り替え先のグループを unpark する
 * - ウィンドウリロードを跨ぐ永続化: park 中のグループも terminalService のレイアウト
 *   永続化に含まれる (terminalService.ts の PARA-PATCH) ため、リロード後は全グループが
 *   一旦復元される。{persistentProcessId → repositoryId} の保存済みマッピングから
 *   再接続完了時に再タグ付け・再 park する
 */
class ParadisTerminalWorkspaceScope extends Disposable implements IParadisTerminalScopeService {

	declare readonly _serviceBrand: undefined;

	private static readonly MAPPING_STORAGE_KEY = 'paradis.workspaceSwitch.terminalRepositories';

	/** グループ → 所属リポジトリID (park 中も保持)。untagged のグループはスコープ外 (常に表示) */
	private readonly _groupRepositories = new Map<ITerminalGroup, string>();

	/** リポジトリID → park 中のグループ */
	private readonly _parkedGroups = new Map<string, ITerminalGroup[]>();

	/**
	 * リロード前に保存した {persistentProcessId → repositoryId}。起動時に一度だけ読み込む
	 * (起動後の persistMapping はこのキーを上書きするため、遅延読み込みだと自分の
	 * 起動時タグ付けで正しい対応を潰してしまう)。
	 */
	private readonly _restoredMapping: Map<number, string>;

	constructor(
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ITerminalService terminalService: ITerminalService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._restoredMapping = this.loadMapping();

		this._register(Event.runAndSubscribe(this.terminalGroupService.onDidChangeGroups, () => this.tagUntaggedGroups()));
		this._register(this.workspaceSwitchService.onDidSwitchScope(stateKey => this.applyScope(stateKey)));
		this._register(this.terminalGroupService.onDidDisposeGroup(group => this.discardGroup(group)));

		// park 中のグループも terminalService のレイアウト永続化に含まれる (PARA-PATCH) ため、
		// リロード後は全グループが一旦 groups に復元され、出現し次第 tagUntaggedGroups が
		// マッピングに基づいて park し直す。再接続完了後に取りこぼし (persistentProcessId が
		// タグ付け時点で未確定だったグループ) を掃除する
		terminalService.whenConnected.then(() => this.sweepRestoredGroups());
	}

	getStateKeyForInstance(instanceId: number): string | undefined {
		for (const [group, stateKey] of this._groupRepositories) {
			if (group.terminalInstances.some(instance => instance.instanceId === instanceId)) {
				return stateKey;
			}
		}
		return undefined;
	}

	/** 保存済みマッピングからグループの所属リポジトリを引く (リロード直後の復元グループ用) */
	private lookupRestoredRepository(group: ITerminalGroup): string | undefined {
		for (const instance of group.terminalInstances) {
			if (typeof instance.persistentProcessId === 'number') {
				const repositoryId = this._restoredMapping.get(instance.persistentProcessId);
				if (repositoryId) {
					return repositoryId;
				}
			}
		}
		return undefined;
	}

	private tagUntaggedGroups(): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		let changed = false;
		for (const group of [...groupService.groups]) {
			if (this._groupRepositories.has(group)) {
				continue;
			}

			// リロードで復元されたグループは保存済みマッピングの対応を優先し、
			// マッピングに無いもの (新規作成) はアクティブエントリ所属とする
			const stateKey = this.lookupRestoredRepository(group) ?? activeStateKey;
			if (!stateKey) {
				continue;
			}

			this._groupRepositories.set(group, stateKey);
			changed = true;

			if (stateKey !== activeStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		}
		if (changed) {
			this.persistMapping();
		}
	}

	private parkGroup(groupService: TerminalGroupService, group: ITerminalGroup, repositoryId: string): void {
		groupService.paradisParkGroup(group);
		let parked = this._parkedGroups.get(repositoryId);
		if (!parked) {
			parked = [];
			this._parkedGroups.set(repositoryId, parked);
		}
		parked.push(group);
	}

	private applyScope(targetStateKey: string): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		// 他エントリのグループを退避
		for (const group of [...groupService.groups]) {
			const stateKey = this._groupRepositories.get(group);
			if (stateKey !== undefined && stateKey !== targetStateKey) {
				this.parkGroup(groupService, group, stateKey);
			}
		}

		// 切り替え先のグループを復帰
		const parked = this._parkedGroups.get(targetStateKey);
		if (parked) {
			this._parkedGroups.delete(targetStateKey);
			for (const group of parked) {
				groupService.paradisUnparkGroup(group);
			}
		}

		this.persistMapping();
	}

	private discardGroup(group: ITerminalGroup): void {
		this._groupRepositories.delete(group);
		for (const [repositoryId, groups] of this._parkedGroups) {
			const index = groups.indexOf(group);
			if (index !== -1) {
				groups.splice(index, 1);
				if (groups.length === 0) {
					this._parkedGroups.delete(repositoryId);
				}
			}
		}
	}

	/**
	 * 再接続完了後の掃除。タグ付け時点で persistentProcessId が未確定でマッピングを
	 * 引けず、誤ってアクティブリポジトリ扱いになった復元グループを正しい対応に直す。
	 */
	private sweepRestoredGroups(): void {
		const groupService = this.terminalGroupService;
		if (!(groupService instanceof TerminalGroupService)) {
			return;
		}

		if (this._restoredMapping.size === 0) {
			return;
		}

		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		let changed = false;
		for (const group of [...groupService.groups]) {
			const restoredStateKey = this.lookupRestoredRepository(group);
			if (!restoredStateKey || this._groupRepositories.get(group) === restoredStateKey) {
				continue;
			}

			this._groupRepositories.set(group, restoredStateKey);
			changed = true;

			if (restoredStateKey !== activeStateKey) {
				this.parkGroup(groupService, group, restoredStateKey);
			}
		}
		if (changed) {
			this.persistMapping();
		}
	}

	private persistMapping(): void {
		const entries: ISerializedTerminalRepositoryEntry[] = [];
		for (const [group, repositoryId] of this._groupRepositories) {
			for (const instance of group.terminalInstances) {
				if (typeof instance.persistentProcessId === 'number') {
					entries.push({ persistentProcessId: instance.persistentProcessId, repositoryId });
				}
			}
		}
		this.storageService.store(ParadisTerminalWorkspaceScope.MAPPING_STORAGE_KEY, JSON.stringify(entries), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private loadMapping(): Map<number, string> {
		const mapping = new Map<number, string>();
		const raw = this.storageService.get(ParadisTerminalWorkspaceScope.MAPPING_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return mapping;
		}

		try {
			const entries: ISerializedTerminalRepositoryEntry[] = JSON.parse(raw);
			for (const entry of entries) {
				mapping.set(entry.persistentProcessId, entry.repositoryId);
			}
		} catch {
			// 壊れたデータは無視
		}
		return mapping;
	}
}

registerSingleton(IParadisTerminalScopeService, ParadisTerminalWorkspaceScope, InstantiationType.Delayed);

/** シングルトンを AfterRestored で確実に起動させるためのスターター */
class ParadisTerminalScopeStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalScopeStarter';
	constructor(@IParadisTerminalScopeService _service: IParadisTerminalScopeService) { }
}

registerWorkbenchContribution2(ParadisTerminalScopeStarter.ID, ParadisTerminalScopeStarter, WorkbenchPhase.AfterRestored);
