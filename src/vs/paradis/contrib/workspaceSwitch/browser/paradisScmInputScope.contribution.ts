/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISCMRepository, ISCMService } from '../../../../workbench/contrib/scm/common/scm.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

/** リポジトリID → { SCMルートURI文字列 → 入力途中のコミットメッセージ } */
type ISerializedScmInputs = Record<string, Record<string, string>>;

/**
 * ワークスペース切り替えでコミットメッセージの入力途中テキストが失われるのを防ぐ (機能1 Phase 4)。
 *
 * Git 拡張はフォルダ入れ替えで SCM リポジトリを close → 再 open する。staged 等の状態は
 * ディスク由来なので戻るが、SCM 入力ボックスの transient なテキストだけは dispose で消える
 * (調査レポート: 唯一の即時復元されない状態)。切り替え直前 (onWillSwitchRepository) に退避し、
 * 切り替え後に SCM リポジトリが再登録され次第復元する。
 */
class ParadisScmInputScope extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisScmInputScope';

	private static readonly STORAGE_KEY = 'paradis.workspaceSwitch.scmInputs';

	/** 切り替え先リポジトリの復元待ちエントリ { SCMルートURI文字列 → テキスト } */
	private _pendingRestore: Record<string, string> | undefined;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(this.workspaceSwitchService.onWillSwitchRepository(previous => this.stashInputs(previous)));
		this._register(this.workspaceSwitchService.onDidSwitchRepository(target => this.beginRestore(target)));

		// Git 拡張の再スキャンは非同期なので、SCM リポジトリの再登録を待って復元する
		this._register(this.scmService.onDidAddRepository(repository => this.tryRestoreFor(repository)));
	}

	private stashInputs(previous: IParadisWorkspaceRepository | undefined): void {
		if (!previous) {
			return;
		}

		const entries: Record<string, string> = {};
		for (const repository of this.scmService.repositories) {
			const rootUri = repository.provider.rootUri;
			if (rootUri && repository.input.value) {
				entries[rootUri.toString()] = repository.input.value;
			}
		}

		const all = this.loadAll();
		if (Object.keys(entries).length > 0) {
			all[previous.id] = entries;
		} else {
			delete all[previous.id];
		}
		this.storageService.store(ParadisScmInputScope.STORAGE_KEY, JSON.stringify(all), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private beginRestore(target: IParadisWorkspaceRepository): void {
		this._pendingRestore = this.loadAll()[target.id];
		if (!this._pendingRestore) {
			return;
		}

		// 既に登録済みの SCM リポジトリ (再スキャンが速かった場合) へ即時復元
		for (const repository of this.scmService.repositories) {
			this.tryRestoreFor(repository);
		}
	}

	private tryRestoreFor(repository: ISCMRepository): void {
		if (!this._pendingRestore) {
			return;
		}

		const rootUri = repository.provider.rootUri;
		if (!rootUri) {
			return;
		}

		const value = this._pendingRestore[rootUri.toString()];
		if (value !== undefined && !repository.input.value) {
			repository.input.setValue(value, false);
			delete this._pendingRestore[rootUri.toString()];
			if (Object.keys(this._pendingRestore).length === 0) {
				this._pendingRestore = undefined;
			}
		}
	}

	private loadAll(): ISerializedScmInputs {
		const raw = this.storageService.get(ParadisScmInputScope.STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return {};
		}
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
}

registerWorkbenchContribution2(ParadisScmInputScope.ID, ParadisScmInputScope, WorkbenchPhase.AfterRestored);
