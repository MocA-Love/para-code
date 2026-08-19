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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuxiliaryWindowService } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { paradisApplyAuxiliaryWindowTransparency, paradisIsAuxiliaryWindowTransparencyActive } from '../../windowTransparency/browser/paradisAuxiliaryWindowTransparency.js';
import { IParadisAuxiliaryWindowScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisBrowserLiveSummary,
	IParadisBrowserLiveViewState,
	IParadisBrowserLiveWindowService,
	paradisParseBrowserLiveViewState,
	paradisSerializeBrowserLiveViewState,
} from '../common/paradisBrowserLiveWindow.js';
import { ParadisBrowserLiveModel } from './paradisBrowserLiveModel.js';
import { ParadisBrowserLiveWindowView } from './paradisBrowserLiveWindowView.js';

const VIEW_STATE_STORAGE_KEY = 'paradis.browserLiveWindow.viewState';
const WINDOW_STATE_STORAGE_KEY = 'paradis.browserLiveWindow.windowState';
const STATE_SAVE_DELAY = 500;

interface ISerializedWindowBounds {
	readonly x?: number;
	readonly y?: number;
	readonly width?: number;
	readonly height?: number;
}

const EMPTY_SUMMARY: IParadisBrowserLiveSummary = { total: 0, shared: 0 };

/**
 * ブラウザ一覧ウィンドウの開閉と、そこに出す一覧の寿命を持つ。
 *
 * ウィンドウは auxiliary window (同一 renderer の別 BrowserWindow) として開く。同じ DI
 * コンテナ・同じサービスをそのまま使えるので、ブラウザビューの状態を IPC で中継する必要が
 * ない。editor part を伴わない素のウィンドウなので、スペースに紐づく auxiliary window の
 * 台帳には載らず、スペースを切り替えても巻き添えで閉じられることはない
 * (エージェント一覧ウィンドウと同じ作り)。
 *
 * このクラスは ParadisAgentLiveWindowService とほぼ同じ形をしている (ウィンドウの復元位置、
 * 開き直し、透過、スコープ登録、閉じたときの後始末)。同型の3つ目を作るときは、その時点で
 * auxiliary window のシェルを共通ヘルパへ抜くこと —— 2つのうち片方だけ直す事故を避けるため。
 */
export class ParadisBrowserLiveWindowService extends Disposable implements IParadisBrowserLiveWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSummary = this._register(new Emitter<void>());
	readonly onDidChangeSummary = this._onDidChangeSummary.event;

	private readonly model: ParadisBrowserLiveModel;
	private readonly viewState: IParadisBrowserLiveViewState;
	private readonly saveScheduler: RunOnceScheduler;

	private _summary: IParadisBrowserLiveSummary = EMPTY_SUMMARY;
	private windowDisposables: DisposableStore | undefined;
	private focusWindow: (() => void) | undefined;
	private opening = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAuxiliaryWindowScopeService private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.viewState = paradisParseBrowserLiveViewState(this.storageService.get(VIEW_STATE_STORAGE_KEY, StorageScope.WORKSPACE));
		this.saveScheduler = this._register(new RunOnceScheduler(() => this.saveViewState(), STATE_SAVE_DELAY));

		this.model = this._register(this.instantiationService.createInstance(ParadisBrowserLiveModel));
		this._register(this.model.onDidChangeEntries(() => this.updateSummary()));
		this.updateSummary();
	}

	get summary(): IParadisBrowserLiveSummary {
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
			const transparencyActive = paradisIsAuxiliaryWindowTransparencyActive(this.layoutService);
			// nativeTitlebar と transparent の組み合わせについてはエージェント一覧ウィンドウと
			// 同じ制約がある (macOS で両立させると信号ボタンの帯まで透ける)。
			const auxiliaryWindow = disposables.add(await this.auxiliaryWindowService.open({
				bounds: this.restoreBounds(),
				nativeTitlebar: !transparencyActive,
				transparent: transparencyActive,
			}));

			// 閉じられたことを拾う購読は、スタイルの読み込みを待つ前に張る。View を組み立てる
			// 途中で閉じられた場合、後から張ったのでは unload を取り逃がし、この store が
			// サービスの寿命まで残ってモデルを購読し続けることになる。
			let closed = false;
			disposables.add(auxiliaryWindow.onUnload(() => {
				closed = true;
				this.onWindowClosed(disposables, auxiliaryWindow.createState());
			}));

			await auxiliaryWindow.whenStylesHaveLoaded;
			if (closed) {
				// 後片付けは onWindowClosed が済ませている。
				return;
			}

			auxiliaryWindow.window.document.title = localize('paradis.browserLive.windowTitle', "ブラウザ");

			disposables.add(paradisApplyAuxiliaryWindowTransparency(auxiliaryWindow.container, this.configurationService));

			// このウィンドウは特定のスペースに属さない。登録しないと resolveWindow が 'pending' を
			// 返し、ここにフォーカスがある間に作られたブラウザビューがアクティブスペースに
			// 紐付かなくなる。
			//
			// 一覧そのものの成立条件でもある: どのエディタグループにも載っていないページの
			// スコープ判定は「いまアクティブなウィンドウ」へフォールバックするため、この登録が
			// 無いと、壁にフォーカスがある間だけそうしたページが一覧から消える。
			disposables.add(this.auxiliaryWindowScopeService.registerScopelessWindow(auxiliaryWindow.window.vscodeWindowId));

			const view = disposables.add(this.instantiationService.createInstance(
				ParadisBrowserLiveWindowView,
				auxiliaryWindow.container,
				this.model,
				this.viewState,
				transparencyActive,
			));
			disposables.add(view.onDidChangeViewState(() => this.scheduleSave()));

			this.focusWindow = () => auxiliaryWindow.window.focus();
			this.windowDisposables = disposables;
		} catch (error) {
			this._store.deleteAndLeak(disposables);
			disposables.dispose();
			throw error;
		} finally {
			this.opening = false;
		}
	}

	private onWindowClosed(disposables: DisposableStore, bounds: { bounds?: ISerializedWindowBounds }): void {
		// open() の途中で閉じられた場合はまだ windowDisposables へ入っていない。その store も
		// 必ず回収する (取りこぼすとサービスの寿命まで残る)。
		if (this.windowDisposables === disposables) {
			this.windowDisposables = undefined;
			this.focusWindow = undefined;
		}
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
		this.storageService.store(VIEW_STATE_STORAGE_KEY, paradisSerializeBrowserLiveViewState(this.viewState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private updateSummary(): void {
		const summary = this.model.summary;
		if (this._summary.total === summary.total && this._summary.shared === summary.shared) {
			return;
		}
		this._summary = summary;
		this._onDidChangeSummary.fire();
	}
}

registerSingleton(IParadisBrowserLiveWindowService, ParadisBrowserLiveWindowService, InstantiationType.Delayed);
