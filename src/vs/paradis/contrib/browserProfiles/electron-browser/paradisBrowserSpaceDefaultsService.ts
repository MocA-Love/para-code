/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースごとの「新しいタブの既定のプロファイル」の表を持つサービス。
//
// 表はこのウィンドウのワークスペースのストレージ（WORKSPACE）に置く。Para Code はスペースを
// 切り替えてもワークスペースの ID が変わらないので、同じウィンドウの全スペースの分が1つの表に入る。
// プロファイルの台帳は知らない（知ると台帳のサービスと循環する）。台帳に無いプロファイルを
// 指す既定は、台帳のサービスが pruneProfiles() で外す。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	IParadisBrowserScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisResolveSpaceInfo,
	paradisSpaceInfoLabel,
	paradisWorktreeStateKey,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisSpaceDefaultResolution,
	PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY,
	ParadisSpaceDefaultTarget,
	paradisParseSpaceDefaults,
	paradisPruneSpaceDefaults,
	paradisResolveSpaceDefault,
	paradisSerializeSpaceDefaults,
	paradisSpaceDefaultTargetsEqual,
} from '../common/paradisBrowserSpaceDefaults.js';

export const IParadisBrowserSpaceDefaultsService = createDecorator<IParadisBrowserSpaceDefaultsService>('paradisBrowserSpaceDefaultsService');

export interface IParadisBrowserSpaceDefaultsService {
	readonly _serviceBrand: undefined;

	/** 表が変わったとき（このウィンドウでの変更・他のウィンドウでの変更・スペースの削除）。 */
	readonly onDidChange: Event<void>;

	/** ビューが属するスペースの状態キー。スペースの管理外・所属が未確定なら undefined。 */
	getSpaceOfView(viewId: string): string | undefined;

	/** スペースで使う既定（親のスペースからの引き継ぎを含む）。無ければ undefined。 */
	getDefault(stateKey: string): IParadisSpaceDefaultResolution | undefined;

	/** スペース自身の既定を変える。undefined で外す（設定 `workbench.browser.dataStorage` に戻る）。 */
	setDefault(stateKey: string, target: ParadisSpaceDefaultTarget | undefined): void;

	/**
	 * これから作るビューに使う既定。前のセッションから続くビュー（復元するタブ）と、所属する
	 * スペースがまだ決まっていないビューには undefined を返す。
	 */
	getDefaultForNewView(viewId: string): ParadisSpaceDefaultTarget | undefined;

	/** スペースの表示名（「リポジトリ名 / ブランチ」）。分からなければ空文字。 */
	getSpaceLabel(stateKey: string): string;

	/** 台帳に無いプロファイルを指す既定を外す（プロファイルが削除されたとき）。 */
	pruneProfiles(existingProfileIds: ReadonlySet<string>): void;
}

export class ParadisBrowserSpaceDefaultsService extends Disposable implements IParadisBrowserSpaceDefaultsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _defaults: Map<string, ParadisSpaceDefaultTarget>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
	) {
		super();

		this._defaults = paradisParseSpaceDefaults(this.storageService.get(PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE));

		// 同じワークスペースを別のウィンドウでも開いていると、そちらの変更がここへ届く。読み直さないと
		// 古い表で上書きしてしまう。
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY, this._store)(event => {
			if (!event.external) {
				return;
			}
			this._defaults = paradisParseSpaceDefaults(this.storageService.get(PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE));
			this._onDidChange.fire();
		}));

		// スペースが一覧から消えたら（リポジトリの削除・worktree の削除）、その既定も消す。
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => {
			if (this._defaults.delete(stateKey)) {
				this._persist();
			}
		}));
	}

	getSpaceOfView(viewId: string): string | undefined {
		const scope = this.browserScopeService.resolveScope(viewId);
		return scope.kind === 'managed' ? scope.stateKey : undefined;
	}

	getDefault(stateKey: string): IParadisSpaceDefaultResolution | undefined {
		return paradisResolveSpaceDefault(this._defaults, stateKey, this._parentStateKey(stateKey));
	}

	setDefault(stateKey: string, target: ParadisSpaceDefaultTarget | undefined): void {
		if (paradisSpaceDefaultTargetsEqual(this._defaults.get(stateKey), target)) {
			return;
		}
		if (target) {
			this._defaults.set(stateKey, target);
		} else {
			this._defaults.delete(stateKey);
		}
		this._persist();
	}

	getDefaultForNewView(viewId: string): ParadisSpaceDefaultTarget | undefined {
		if (this.browserScopeService.isCarriedOverView(viewId)) {
			return undefined;
		}
		const stateKey = this.getSpaceOfView(viewId);
		return stateKey !== undefined ? this.getDefault(stateKey)?.target : undefined;
	}

	getSpaceLabel(stateKey: string): string {
		return paradisSpaceInfoLabel(paradisResolveSpaceInfo(stateKey, this.workspaceSwitchService.repositories, this.worktreeService));
	}

	pruneProfiles(existingProfileIds: ReadonlySet<string>): void {
		if (paradisPruneSpaceDefaults(this._defaults, existingProfileIds).length > 0) {
			this._persist();
		}
	}

	/** worktree のスペースなら親（メインツリー）の状態キー。リポジトリ本体・不明なら undefined。 */
	private _parentStateKey(stateKey: string): string | undefined {
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.id === stateKey) {
				return undefined;
			}
			const isWorktreeOfRepository = this.worktreeService.getDetectedWorktrees(repository.id)
				.some(worktree => !worktree.isMainCheckout && paradisWorktreeStateKey(worktree.uri) === stateKey)
				|| this.worktreeService.getKnownWorktreeStateKeys(repository.id).includes(stateKey);
			if (isWorktreeOfRepository) {
				return repository.id;
			}
		}
		return undefined;
	}

	private _persist(): void {
		if (this._defaults.size === 0) {
			this.storageService.remove(PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE);
		} else {
			this.storageService.store(
				PARADIS_BROWSER_SPACE_DEFAULTS_STORAGE_KEY,
				paradisSerializeSpaceDefaults(this._defaults),
				StorageScope.WORKSPACE,
				// プロファイルのログイン状態はマシン固有なので、既定も同期しない。
				StorageTarget.MACHINE,
			);
		}
		this._onDidChange.fire();
	}
}
