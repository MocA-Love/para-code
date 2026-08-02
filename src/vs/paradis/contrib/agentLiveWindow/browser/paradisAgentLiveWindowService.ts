/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IParadisAuxiliaryWindowScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentLiveSummary,
	IParadisAgentLiveViewState,
	IParadisAgentLiveWindowService,
	paradisParseAgentLiveViewState,
	paradisSerializeAgentLiveViewState,
} from '../common/paradisAgentLiveWindow.js';
import { ParadisAgentLiveModel } from './paradisAgentLiveModel.js';
import { ParadisAgentLiveWindowView } from './paradisAgentLiveWindowView.js';

const VIEW_STATE_STORAGE_KEY = 'paradis.agentLiveWindow.viewState';
const WINDOW_STATE_STORAGE_KEY = 'paradis.agentLiveWindow.windowState';
const STATE_SAVE_DELAY = 500;

interface ISerializedWindowBounds {
	readonly x?: number;
	readonly y?: number;
	readonly width?: number;
	readonly height?: number;
}

const EMPTY_SUMMARY: IParadisAgentLiveSummary = { total: 0, active: 0, attention: 0, byStatus: new Map() };

/**
 * ライブウィンドウの開閉と、そこに出す一覧の寿命を持つ。
 *
 * ウィンドウは auxiliary window (同一 renderer の別 BrowserWindow) として開く。同じ DI
 * コンテナ・同じサービスをそのまま使えるので、端末の状態を IPC で中継する必要がない。
 * なお editor part を伴わない素のウィンドウなので、スペースに紐づく auxiliary window の
 * 台帳 (ParadisAuxiliaryWindowScopeService は onDidCreateAuxiliaryEditorPart のみ購読) には
 * 載らない。スペースを切り替えても巻き添えで閉じられることはない。
 */
export class ParadisAgentLiveWindowService extends Disposable implements IParadisAgentLiveWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSummary = this._register(new Emitter<void>());
	readonly onDidChangeSummary = this._onDidChangeSummary.event;

	private readonly model: ParadisAgentLiveModel;
	private readonly viewState: IParadisAgentLiveViewState;
	private readonly saveScheduler: RunOnceScheduler;

	private _summary: IParadisAgentLiveSummary = EMPTY_SUMMARY;
	private windowDisposables: DisposableStore | undefined;
	private focusWindow: (() => void) | undefined;
	private opening = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAuxiliaryWindowScopeService private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
	) {
		super();

		this.viewState = paradisParseAgentLiveViewState(this.storageService.get(VIEW_STATE_STORAGE_KEY, StorageScope.WORKSPACE));
		this.saveScheduler = this._register(new RunOnceScheduler(() => this.saveViewState(), STATE_SAVE_DELAY));

		this.model = this._register(this.instantiationService.createInstance(ParadisAgentLiveModel));
		this._register(this.model.onDidChangeEntries(() => this.updateSummary()));
		this.updateSummary();
	}

	get summary(): IParadisAgentLiveSummary {
		return this._summary;
	}

	async open(): Promise<void> {
		if (this.windowDisposables) {
			this.focusWindow?.();
			return;
		}
		if (this.opening) {
			// 開いている最中の連打。開き終わったウィンドウは open() の完了時に前面へ出る。
			return;
		}
		this.opening = true;
		// サービスが先に破棄されてもウィンドウ側が取り残されないよう、生成直後に登録する。
		const disposables = this._register(new DisposableStore());
		try {
			const auxiliaryWindow = disposables.add(await this.auxiliaryWindowService.open({
				bounds: this.restoreBounds(),
				nativeTitlebar: true,
			}));
			await auxiliaryWindow.whenStylesHaveLoaded;

			auxiliaryWindow.window.document.title = localize('paradis.agentLive.windowTitle', "エージェント");

			// このウィンドウは特定のスペースに属さない。登録しないと resolveWindow が 'pending' を
			// 返し、ここにフォーカスがある間に作られたターミナル / ブラウザビューがアクティブ
			// スペースに紐付かなくなる。
			disposables.add(this.auxiliaryWindowScopeService.registerScopelessWindow(auxiliaryWindow.window.vscodeWindowId));

			const view = disposables.add(this.instantiationService.createInstance(
				ParadisAgentLiveWindowView,
				auxiliaryWindow.container,
				this.model,
				this.viewState,
			));
			disposables.add(view.onDidChangeViewState(() => this.scheduleSave()));

			disposables.add(auxiliaryWindow.onUnload(() => this.onWindowClosed(disposables, auxiliaryWindow.createState())));
			disposables.add(auxiliaryWindow.onWillLayout(() => view.layout()));

			this.focusWindow = () => auxiliaryWindow.window.focus();
			this.windowDisposables = disposables;
			this.model.setOutputTracking(true);
		} catch (error) {
			this._store.deleteAndLeak(disposables);
			disposables.dispose();
			throw error;
		} finally {
			this.opening = false;
		}
	}

	private onWindowClosed(disposables: DisposableStore, bounds: { bounds?: ISerializedWindowBounds }): void {
		if (this.windowDisposables !== disposables) {
			return;
		}
		this.windowDisposables = undefined;
		this.focusWindow = undefined;
		this.model.setOutputTracking(false);
		if (bounds.bounds) {
			this.storageService.store(WINDOW_STATE_STORAGE_KEY, JSON.stringify(bounds.bounds), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.saveViewState();
		// onUnload の中で自分を dispose すると購読の解除中に再入するため、次のタスクへ回す。
		queueMicrotask(() => {
			this._store.deleteAndLeak(disposables);
			disposables.dispose();
		});
	}

	private restoreBounds(): ISerializedWindowBounds | undefined {
		const raw = this.storageService.get(WINDOW_STATE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				const bounds = parsed as ISerializedWindowBounds;
				const isFinite = (value: number | undefined): boolean => value === undefined || Number.isFinite(value);
				if (isFinite(bounds.x) && isFinite(bounds.y) && isFinite(bounds.width) && isFinite(bounds.height)) {
					return bounds;
				}
			}
		} catch {
			// 壊れた値は捨てて既定の位置で開く。
		}
		return undefined;
	}

	private scheduleSave(): void {
		if (!this.saveScheduler.isScheduled()) {
			this.saveScheduler.schedule();
		}
	}

	private saveViewState(): void {
		this.storageService.store(VIEW_STATE_STORAGE_KEY, paradisSerializeAgentLiveViewState(this.viewState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private updateSummary(): void {
		const byStatus = this.model.countByStatus();
		let active = 0;
		let attention = 0;
		for (const [status, count] of byStatus) {
			if (status !== 'idle') {
				active += count;
			}
			if (status === 'permission' || status === 'question') {
				attention += count;
			}
		}
		const total = this.model.entries.length;
		const unchanged = this._summary.total === total
			&& this._summary.active === active
			&& this._summary.attention === attention
			// 総数が同じでも内訳だけ変わる (working → review 等) ことがある。公開する
			// サマリが古いまま残らないよう、内訳も突き合わせる。
			&& this._summary.byStatus.size === byStatus.size
			&& [...byStatus].every(([status, count]) => this._summary.byStatus.get(status) === count);
		if (unchanged) {
			return;
		}
		this._summary = { total, active, attention, byStatus };
		this._onDidChangeSummary.fire();
	}
}

registerSingleton(IParadisAgentLiveWindowService, ParadisAgentLiveWindowService, InstantiationType.Delayed);
