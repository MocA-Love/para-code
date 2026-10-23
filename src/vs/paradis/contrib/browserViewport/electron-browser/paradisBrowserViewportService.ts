/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの大きさの台帳。名前付きの大きさ・既定（全体とスペースごと）・エージェントが変えた記録を持つ。
//
// 大きさそのものは持たない。正は upstream の Device Emulation（`IBrowserViewModel.device`）で、ここは
// それを当てる口と、表示に要る周辺の情報だけを持つ（paradisBrowserViewport.ts の冒頭を参照）。
//
// 置き場所:
//  - 名前付きの大きさ: APPLICATION ストレージ（ブックマーク・プロファイルと同じく、アプリの中で作って直す一覧）
//  - 全体の既定: 設定 `paradis.browser.viewport.default`（「設定 (Para Code)」にも載せる）
//  - スペースごとの既定: WORKSPACE ストレージ（プロファイルのスペースの既定 paradisBrowserSpaceDefaults と同じ形。
//    workspace 設定に書くと利用者のリポジトリの .vscode を汚し、1 つのウィンドウでスペースを切り替える使い方にも合わない）

import { Emitter, Event } from '../../../../base/common/event.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IBrowserDeviceProfile } from '../../../../platform/browserView/common/browserView.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import {
	IParadisBrowserScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisResolveSpaceInfo,
	paradisSpaceInfoLabel,
	paradisWorktreeStateKey,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisViewportSize,
	IParadisViewportState,
	PARADIS_BUILT_IN_VIEWPORT_SIZES,
	PARADIS_VIEWPORT_DEFAULT_SETTING,
	PARADIS_VIEWPORT_SIZE_LIMIT,
	PARADIS_VIEWPORT_SIZES_STORAGE_KEY,
	PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY,
	PARADIS_VIEWPORT_VIEW_SPECS_STORAGE_KEY,
	paradisInitialViewportSpec,
	paradisParseViewportViewSpecs,
	paradisRememberViewportViewSpec,
	paradisResolveViewportSpec,
	paradisViewportTargetSpec,
	ParadisViewportDefaultSource,
	ParadisViewportTarget,
	paradisDescribeViewport,
	paradisFindViewportSize,
	paradisParseViewportSizes,
	paradisParseViewportSpaceDefaults,
	paradisResolveViewportDefault,
	paradisViewportDevice,
} from '../common/paradisBrowserViewport.js';
import { paradisDevicesEqual } from '../common/paradisBrowserViewportCdp.js';

/** CDP の命令で変わった device が renderer に届くのを待つ上限。 */
const AGENT_EMULATION_SETTLE_MS = 1000;

/** エージェントが大きさを変えた記録（chip の強調とホバーに使う）。 */
export interface IParadisViewportAgentChange {
	/** 「claude、ターミナル 1」のようなペインの呼び名。 */
	readonly agentLabel: string;
	readonly previous: IParadisViewportState;
	readonly next: IParadisViewportState;
	readonly at: number;
}

/** 誰が大きさを変えるか。 */
export type ParadisViewportOrigin =
	| { readonly kind: 'user' }
	| { readonly kind: 'default' }
	| { readonly kind: 'agent'; readonly agentLabel: string };

export const IParadisBrowserViewportService = createDecorator<IParadisBrowserViewportService>('paradisBrowserViewportService');

export interface IParadisBrowserViewportService {
	readonly _serviceBrand: undefined;

	/** 名前付きの大きさ・既定が変わった。 */
	readonly onDidChange: Event<void>;
	/** エージェントが、あるタブ（viewId）の大きさを変えた。 */
	readonly onDidAgentChange: Event<string>;

	getSizes(): readonly IParadisViewportSize[];
	/** 同じ名前があれば置き換える。上限に達していれば false。 */
	saveSize(size: IParadisViewportSize): boolean;
	/** `oldName` の大きさを `size` に置き換える（名前を変えたら、それを指す既定も付け替える）。 */
	replaceSize(oldName: string, size: IParadisViewportSize): Promise<void>;
	removeSize(name: string): void;

	getGlobalDefault(): string;
	setGlobalDefault(spec: string): Promise<void>;

	/** そのタブが属するスペースの状態キー。スペースの管理外・未確定なら undefined。 */
	getSpaceOfView(viewId: string): string | undefined;
	getSpaceLabel(stateKey: string): string;
	getSpaceDefault(stateKey: string): string | undefined;
	setSpaceDefault(stateKey: string, spec: string | undefined): void;

	/** そのタブに当てる既定と、どこで決めたものか。 */
	resolveDefaultForView(viewId: string): { readonly spec: string; readonly source: ParadisViewportDefaultSource };
	/**
	 * このウィンドウで初めてそのタブのページに触れたときに当てる大きさ。2 回目以降と、もう大きさが付いている
	 * タブでは undefined（同じタブを別のグループへ動かしたり、スペースを行き来したり、帯を閉じたりしたときに、
	 * 利用者やエージェントが変えた大きさを潰さないため）。最後に当てた大きさの控え（APPLICATION ストレージ）が
	 * あればそれを、無ければ既定を返す。控えがあるので、再読み込み・別ウィンドウへの移動の後も既定は当たり直らず、
	 * 再起動で失われた大きさは戻る。
	 */
	takeInitialViewport(model: IBrowserViewModel): ParadisViewportTarget | undefined;

	/** 大きさを当てる。エージェントのときは記録を残して知らせる。 */
	apply(model: IBrowserViewModel, target: ParadisViewportTarget, origin: ParadisViewportOrigin): Promise<void>;
	/** 今の大きさの説明。エディタに合わせているときの数字は、最後に測ったエディタの大きさ。 */
	describe(model: IBrowserViewModel): IParadisViewportState;
	/** エディタに合わせたときのページの大きさ（CSS px）を覚える。背面のタブでも数字を出せるように。 */
	notePaneSize(viewId: string, size: { readonly width: number; readonly height: number }): void;
	getPaneSize(viewId: string): { readonly width: number; readonly height: number } | undefined;

	getAgentChange(viewId: string): IParadisViewportAgentChange | undefined;
	/**
	 * エージェントが CDP の命令（emulate など）で大きさを変えた。device は main が変えるので、renderer に変化が
	 * 届くのを少し待ってから記録する。
	 */
	noteAgentEmulation(model: IBrowserViewModel, agentLabel: string, previousDevice: IBrowserDeviceProfile | undefined): Promise<void>;
}

export class ParadisBrowserViewportService extends Disposable implements IParadisBrowserViewportService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidAgentChange = this._register(new Emitter<string>());
	readonly onDidAgentChange: Event<string> = this._onDidAgentChange.event;

	private _sizes: readonly IParadisViewportSize[];
	private _spaceDefaults: Map<string, string>;
	private readonly _paneSizes = new Map<string, { readonly width: number; readonly height: number }>();
	private readonly _agentChanges = new Map<string, IParadisViewportAgentChange>();
	/** このウィンドウで初めて触れたときの処理を済ませたタブ（{@link takeInitialViewport}）。 */
	private readonly _defaultClaimed = new Set<string>();
	/** タブごとに最後に当てた大きさの控え（paradisBrowserViewport.ts）。 */
	private _viewSpecs: Map<string, string>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
	) {
		super();
		this._sizes = this._readSizes();
		this._viewSpecs = paradisParseViewportViewSpecs(this.storageService.get(PARADIS_VIEWPORT_VIEW_SPECS_STORAGE_KEY, StorageScope.APPLICATION));
		this._spaceDefaults = paradisParseViewportSpaceDefaults(this.storageService.get(PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE));

		// 別のウィンドウで直した一覧・既定を読み直す（読み直さないと古い表で上書きしてしまう）
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PARADIS_VIEWPORT_SIZES_STORAGE_KEY, this._store)(event => {
			if (event.external) {
				this._sizes = this._readSizes();
				this._onDidChange.fire();
			}
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY, this._store)(event => {
			if (event.external) {
				this._spaceDefaults = paradisParseViewportSpaceDefaults(this.storageService.get(PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE));
				this._onDidChange.fire();
			}
		}));
		// 別のウィンドウが書いた控えを読み直す（タブを別ウィンドウへ移したとき、移す前の控えを見るため）
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PARADIS_VIEWPORT_VIEW_SPECS_STORAGE_KEY, this._store)(event => {
			if (event.external) {
				this._viewSpecs = paradisParseViewportViewSpecs(this.storageService.get(PARADIS_VIEWPORT_VIEW_SPECS_STORAGE_KEY, StorageScope.APPLICATION));
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_VIEWPORT_DEFAULT_SETTING)) {
				this._onDidChange.fire();
			}
		}));
		// スペースが一覧から消えたら、その既定も消す
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => {
			if (this._spaceDefaults.delete(stateKey)) {
				this._persistSpaceDefaults();
			}
		}));
	}

	// #region 名前付きの大きさ

	getSizes(): readonly IParadisViewportSize[] {
		return this._sizes;
	}

	saveSize(size: IParadisViewportSize): boolean {
		const existing = paradisFindViewportSize(this._sizes, size.name);
		if (!existing && this._sizes.length >= PARADIS_VIEWPORT_SIZE_LIMIT) {
			return false;
		}
		this._sizes = existing
			? this._sizes.map(candidate => candidate === existing ? size : candidate)
			: [...this._sizes, size];
		this._persistSizes();
		return true;
	}

	async replaceSize(oldName: string, size: IParadisViewportSize): Promise<void> {
		const existing = paradisFindViewportSize(this._sizes, oldName);
		if (!existing) {
			this.saveSize(size);
			return;
		}
		this._sizes = this._sizes
			.filter(candidate => candidate === existing || candidate.name !== size.name)
			.map(candidate => candidate === existing ? size : candidate);
		this._persistSizes();
		if (existing.name !== size.name) {
			for (const [stateKey, spec] of this._spaceDefaults) {
				if (paradisFindViewportSize([existing], spec)) {
					this._spaceDefaults.set(stateKey, size.name);
				}
			}
			this._persistSpaceDefaults();
			if (paradisFindViewportSize([existing], this.getGlobalDefault())) {
				await this.setGlobalDefault(size.name);
			}
		}
	}

	removeSize(name: string): void {
		const existing = paradisFindViewportSize(this._sizes, name);
		if (existing) {
			this._sizes = this._sizes.filter(candidate => candidate !== existing);
			this._persistSizes();
		}
	}

	private _persistSizes(): void {
		this.storageService.store(PARADIS_VIEWPORT_SIZES_STORAGE_KEY, JSON.stringify(this._sizes), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire();
	}

	private _readSizes(): readonly IParadisViewportSize[] {
		return paradisParseViewportSizes(this.storageService.get(PARADIS_VIEWPORT_SIZES_STORAGE_KEY, StorageScope.APPLICATION)) ?? PARADIS_BUILT_IN_VIEWPORT_SIZES;
	}

	// #endregion

	// #region 既定

	getGlobalDefault(): string {
		const value = this.configurationService.getValue<unknown>(PARADIS_VIEWPORT_DEFAULT_SETTING);
		return typeof value === 'string' ? value.trim() : '';
	}

	async setGlobalDefault(spec: string): Promise<void> {
		await this.configurationService.updateValue(PARADIS_VIEWPORT_DEFAULT_SETTING, spec, ConfigurationTarget.USER);
	}

	getSpaceOfView(viewId: string): string | undefined {
		const scope = this.browserScopeService.resolveScope(viewId);
		return scope.kind === 'managed' ? scope.stateKey : undefined;
	}

	getSpaceLabel(stateKey: string): string {
		return paradisSpaceInfoLabel(paradisResolveSpaceInfo(stateKey, this.workspaceSwitchService.repositories, this.worktreeService));
	}

	getSpaceDefault(stateKey: string): string | undefined {
		return this._spaceDefaults.get(stateKey);
	}

	setSpaceDefault(stateKey: string, spec: string | undefined): void {
		if (this._spaceDefaults.get(stateKey) === spec) {
			return;
		}
		if (spec === undefined) {
			this._spaceDefaults.delete(stateKey);
		} else {
			this._spaceDefaults.set(stateKey, spec);
		}
		this._persistSpaceDefaults();
	}

	resolveDefaultForView(viewId: string): { readonly spec: string; readonly source: ParadisViewportDefaultSource } {
		const stateKey = this.getSpaceOfView(viewId);
		return paradisResolveViewportDefault(this._spaceDefaults, stateKey, stateKey !== undefined ? this._parentStateKey(stateKey) : undefined, this.getGlobalDefault());
	}

	takeInitialViewport(model: IBrowserViewModel): ParadisViewportTarget | undefined {
		if (this._defaultClaimed.has(model.id)) {
			return undefined;
		}
		this._defaultClaimed.add(model.id);
		if (model.device) {
			return undefined;
		}
		const initial = paradisInitialViewportSpec(this._viewSpecs.get(model.id), this.resolveDefaultForView(model.id).spec);
		if (initial.remember) {
			this._rememberViewSpec(model.id, initial.spec);
		}
		const target = paradisResolveViewportSpec(initial.spec, this._sizes);
		return target?.kind === 'size' ? target : undefined;
	}

	private _rememberViewSpec(viewId: string, spec: string): void {
		if (this._viewSpecs.get(viewId) === spec) {
			return;
		}
		paradisRememberViewportViewSpec(this._viewSpecs, viewId, spec);
		this.storageService.store(PARADIS_VIEWPORT_VIEW_SPECS_STORAGE_KEY, JSON.stringify([...this._viewSpecs]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** worktree のスペースなら親（メインツリー）の状態キー（paradisBrowserSpaceDefaultsService.ts と同じ判定）。 */
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

	private _persistSpaceDefaults(): void {
		if (this._spaceDefaults.size === 0) {
			this.storageService.remove(PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY, StorageScope.WORKSPACE);
		} else {
			this.storageService.store(PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(this._spaceDefaults)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this._onDidChange.fire();
	}

	// #endregion

	// #region 当てる・説明する

	async apply(model: IBrowserViewModel, target: ParadisViewportTarget, origin: ParadisViewportOrigin): Promise<void> {
		const previous = this.describe(model);
		this._defaultClaimed.add(model.id);
		this._rememberViewSpec(model.id, paradisViewportTargetSpec(target));
		await model.setDevice(target.kind === 'fit' ? undefined : paradisViewportDevice(target.size));
		if (origin.kind === 'agent') {
			this._agentChanges.set(model.id, { agentLabel: origin.agentLabel, previous, next: this.describe(model), at: Date.now() });
			this._onDidAgentChange.fire(model.id);
		} else if (origin.kind === 'user') {
			// 利用者が自分で選び直したら、エージェントが変えた印は外す
			this._agentChanges.delete(model.id);
		}
	}

	describe(model: IBrowserViewModel): IParadisViewportState {
		return paradisDescribeViewport(model.device, this._sizes, this._paneSizes.get(model.id));
	}

	notePaneSize(viewId: string, size: { readonly width: number; readonly height: number }): void {
		this._paneSizes.set(viewId, { width: Math.round(size.width), height: Math.round(size.height) });
	}

	getPaneSize(viewId: string): { readonly width: number; readonly height: number } | undefined {
		return this._paneSizes.get(viewId);
	}

	getAgentChange(viewId: string): IParadisViewportAgentChange | undefined {
		return this._agentChanges.get(viewId);
	}

	async noteAgentEmulation(model: IBrowserViewModel, agentLabel: string, previousDevice: IBrowserDeviceProfile | undefined): Promise<void> {
		if (paradisDevicesEqual(model.device, previousDevice)) {
			const store = new DisposableStore();
			try {
				await raceTimeout(Event.toPromise(model.onDidChangeDevice, store), AGENT_EMULATION_SETTLE_MS);
			} finally {
				store.dispose();
			}
		}
		const previous = paradisDescribeViewport(previousDevice, this._sizes, this._paneSizes.get(model.id));
		this._agentChanges.set(model.id, { agentLabel, previous, next: this.describe(model), at: Date.now() });
		this._onDidAgentChange.fire(model.id);
	}

	// #endregion
}
