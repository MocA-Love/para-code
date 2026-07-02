/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import '../browser/media/paradisWindowTransparency.css';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { sharedMutationObserver } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

const CONFIG_KEY_ENABLED = 'paradis.window.transparency.enabled';
const CONFIG_KEY_OPACITY = 'paradis.window.transparency.opacity';

const TRANSPARENT_CLASS = 'paradis-transparent';
const OPACITY_CUSTOM_PROPERTY = '--paradis-transparency-opacity';

// 背景が透けすぎて前景の可読性が失われないための下限。設定値がこれを下回る場合はクランプする。
const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1;

// 状態依存の背景色（フォルダ未オープン/デバッグ中/ウィンドウ非アクティブ）を持つパートは、固定テーマ変数ではなく
// パートが実際にinline styleへ塗った背景色をミラーし、その色をCSS側で透過させる。[パート, ミラー先カスタムプロパティ]。
const MIRRORED_PARTS: readonly [part: Parts, cssProperty: string][] = [
	[Parts.TITLEBAR_PART, '--paradis-titlebar-bg'],
	[Parts.STATUSBAR_PART, '--paradis-statusbar-bg'],
];

/**
 * `paradis.window.transparency.*` 設定を反映するcontribution。
 *
 * ウィンドウ全体を一様に薄くする `BrowserWindow.setOpacity()` はダイアログやモーダルまで透けてしまうため使わない。
 * 代わりにネイティブウィンドウを `transparent: true` で生成し（`windowImpl.ts` のPARA-PATCH参照）、
 * ここではワークベンチのルート／各パート背景だけを `color-mix` で半透明にする。ダイアログ・quick input・通知・
 * メニュー・hover等はCSS側で対象外＋不透明バックストップを持たせているため不透明のまま残る。
 *
 * 状態依存の背景色を持つ title bar / status bar は、パートが実際に塗った背景色（デバッグ中オレンジ等）を
 * MutationObserver でミラーし、その実背景色を透過させる（固定テーマ変数を上書きしない）。
 *
 * `enabled` の切り替えはネイティブウィンドウの生成時フラグに依存するため、実際に反映するにはウィンドウの再読み込みが必要。
 * `opacity` の変更はCSSカスタムプロパティの更新だけで即時反映される。
 */
class ParadisWindowTransparencyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisWindowTransparency';

	// 起動時点（＝ネイティブウィンドウ生成時点）の enabled 状態。ランタイムでのトグルと区別して再読み込み案内を出すために使う。
	private lastEnabled: boolean;

	// 透過が有効な間だけ張るパート背景ミラー用のオブザーバ群。applyStyles のたびに張り替える。
	private readonly mirrorDisposables = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this.lastEnabled = this.isEnabled();
		this.applyStyles();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY_ENABLED)) {
				this.onEnabledChanged();
			} else if (e.affectsConfiguration(CONFIG_KEY_OPACITY)) {
				this.applyStyles();
			}
		}));
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED) === true;
	}

	private getOpacity(): number {
		const raw = this.configurationService.getValue<number>(CONFIG_KEY_OPACITY);
		const value = typeof raw === 'number' && !isNaN(raw) ? raw : 0.9;
		return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value));
	}

	private applyStyles(): void {
		const container = this.layoutService.mainContainer;
		const enabled = this.isEnabled();

		// パート背景の半透明化CSSが効くのは、ネイティブウィンドウが透過生成されている場合（起動時 enabled=true）のみ。
		// 起動後に enabled を切り替えた場合はウィンドウが不透明なままなので、再読み込みまではクラスを付けない。
		const active = enabled && this.lastEnabled;
		container.classList.toggle(TRANSPARENT_CLASS, active);

		this.mirrorDisposables.clear();

		if (active) {
			const percentage = `${Math.round(this.getOpacity() * 100)}%`;
			container.style.setProperty(OPACITY_CUSTOM_PROPERTY, percentage);
			for (const [part, cssProperty] of MIRRORED_PARTS) {
				this.mirrorPartBackground(part, cssProperty);
			}
		} else {
			container.style.removeProperty(OPACITY_CUSTOM_PROPERTY);
		}
	}

	/**
	 * `part` のパートコンテナ要素がinline styleへ塗る背景色を `cssProperty` カスタムプロパティへ同期する。
	 * パートは状態変化のたびに `element.style.backgroundColor` を更新するため、その変化を MutationObserver で追い、
	 * 実際の状態込みの背景色をCSSの `color-mix` に供給する。CSSクラス側の `!important` はinline styleを上書きするが
	 * `element.style.backgroundColor` の値自体は変えないため、ここで読む値は常にパート本来の状態色になる。
	 */
	private mirrorPartBackground(part: Parts, cssProperty: string): void {
		const element = this.layoutService.getContainer(mainWindow, part);
		if (!element) {
			return;
		}

		const sync = () => {
			const background = element.style.backgroundColor;
			if (background) {
				// 同値の再設定はMutationObserverの無限ループを招くため、差分がある時だけ書き込む。
				if (element.style.getPropertyValue(cssProperty) !== background) {
					element.style.setProperty(cssProperty, background);
				}
			} else if (element.style.getPropertyValue(cssProperty)) {
				element.style.removeProperty(cssProperty);
			}
		};

		sync();
		this.mirrorDisposables.add(sharedMutationObserver.observe(element, this.mirrorDisposables, { attributes: true, attributeFilter: ['style'] })(sync));
		this.mirrorDisposables.add(toDisposable(() => element.style.removeProperty(cssProperty)));
	}

	private onEnabledChanged(): void {
		const enabled = this.isEnabled();
		this.applyStyles();

		// 起動時の状態と現在の設定が食い違う＝ネイティブウィンドウの透過状態を反映するには再読み込みが必要。
		if (enabled !== this.lastEnabled) {
			this.promptReload(enabled);
		}
	}

	private promptReload(enabled: boolean): void {
		const message = enabled
			? localize('paradis.window.transparency.reloadToEnable', "Window transparency will take effect after the window is reloaded.")
			: localize('paradis.window.transparency.reloadToDisable', "Window transparency will be fully removed after the window is reloaded.");

		this.notificationService.prompt(Severity.Info, message, [
			{
				label: localize('paradis.window.transparency.reloadWindow', "Reload Window"),
				run: () => this.hostService.reload()
			}
		]);
	}
}

registerWorkbenchContribution2(ParadisWindowTransparencyContribution.ID, ParadisWindowTransparencyContribution, WorkbenchPhase.AfterRestored);
