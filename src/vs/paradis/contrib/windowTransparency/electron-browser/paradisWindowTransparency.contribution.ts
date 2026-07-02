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
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { clampParadisTransparencyOpacity, PARADIS_TRANSPARENCY_ENABLED_KEY, PARADIS_TRANSPARENCY_OPACITY_KEY, PARADIS_TRANSPARENT_CLASS } from '../common/paradisTransparency.js';

const OPACITY_CUSTOM_PROPERTY = '--paradis-transparency-opacity';

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
 * `transparent` はBrowserWindowの生成時専用フラグで、ウィンドウの再読み込み（同一BrowserWindowへのloadURL）では
 * 決して反映されない。そのため `enabled` の切り替えを実際に反映するには**アプリの再起動**が必要で、切り替え時は
 * 再起動を促す通知を出す。ネイティブウィンドウが実際に透過生成されたかは main プロセスから
 * `INativeWindowConfiguration.paradisTransparentWindow`（windowImpl.ts のPARA-PATCH参照）で渡され、
 * CSSクラスの付与はこの実状態でゲートする（設定ONでもウィンドウが不透明なら付与しない）。
 * `opacity` の変更はCSSカスタムプロパティの更新だけで即時反映される。
 */
class ParadisWindowTransparencyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisWindowTransparency';

	// ネイティブウィンドウが実際に `transparent: true` で生成されたか（生成時に確定し、以後不変）。
	private readonly nativeTransparent: boolean;

	// 透過が有効な間だけ張るパート背景ミラー用のオブザーバ群。applyStyles のたびに張り替える。
	private readonly mirrorDisposables = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INotificationService private readonly notificationService: INotificationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
	) {
		super();

		this.nativeTransparent = environmentService.window.paradisTransparentWindow === true;
		this.applyStyles();

		// BlockStartup時点ではtitle bar/status barのパートDOMやinline背景がまだ無いことがあるため、
		// 復元完了後にもう一度applyStylesして背景ミラー(MutationObserver)を張り直す。
		lifecycleService.when(LifecyclePhase.Restored).then(() => this.applyStyles());

		// 「設定はONだがウィンドウは不透明のまま」（例: 設定ON後にリロードだけした、workspace設定に書いた等）の
		// 場合、起動時に再起動が必要である旨を案内する。
		if (this.isEnabled() && !this.nativeTransparent) {
			this.promptRestart(true);
		}

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_TRANSPARENCY_ENABLED_KEY)) {
				this.onEnabledChanged();
			} else if (e.affectsConfiguration(PARADIS_TRANSPARENCY_OPACITY_KEY)) {
				this.applyStyles();
			}
		}));
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_TRANSPARENCY_ENABLED_KEY) === true;
	}

	private getOpacity(): number {
		return clampParadisTransparencyOpacity(this.configurationService.getValue<number>(PARADIS_TRANSPARENCY_OPACITY_KEY));
	}

	private applyStyles(): void {
		const container = this.layoutService.mainContainer;
		const enabled = this.isEnabled();

		// パート背景の半透明化CSSが効くのは、ネイティブウィンドウが実際に透過生成されている場合のみ。
		// 設定ONでもウィンドウが不透明なら、同色の不透明ネイティブ背景にブレンドされるだけで視覚効果が無い
		// （どころかパート間の色ずれだけ起きる）ため、クラスは付けず再起動の案内に任せる。
		const active = enabled && this.nativeTransparent;
		container.classList.toggle(PARADIS_TRANSPARENT_CLASS, active);

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

		// ネイティブウィンドウの実状態と現在の設定が食い違う＝透過状態を反映するにはアプリの再起動が必要
		// （`transparent` は生成時フラグで、ウィンドウの再読み込みでは決して反映されない）。
		if (enabled !== this.nativeTransparent) {
			this.promptRestart(enabled);
		}
	}

	private promptRestart(enabled: boolean): void {
		const message = enabled
			? localize('paradis.window.transparency.restartToEnable', "Window transparency will take effect after the application is restarted. Reloading the window is not sufficient.")
			: localize('paradis.window.transparency.restartToDisable', "Window transparency will be fully removed after the application is restarted.");

		this.notificationService.prompt(Severity.Info, message, [
			{
				label: localize('paradis.window.transparency.restartToApply', "Restart to Apply"),
				run: () => this.nativeHostService.relaunch()
			}
		]);
	}
}

// BlockStartup必須: `paradis-transparent` クラスはセッション復元で生成されるターミナル(xterm)より先に
// 付与されていなければならない。xtermは生成時に `allowTransparency` を確定するため、AfterRestored（エディタ
// 復元より後）だと、復元されたエディタ内ターミナルが不透明のままWebGLレンダラを初期化してしまう。
registerWorkbenchContribution2(ParadisWindowTransparencyContribution.ID, ParadisWindowTransparencyContribution, WorkbenchPhase.BlockStartup);
