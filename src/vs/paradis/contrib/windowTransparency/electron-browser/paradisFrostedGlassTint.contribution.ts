/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, LayoutSettings } from '../../../../workbench/services/layout/browser/layoutService.js';
import { clampParadisGlassOpacity, computeParadisGlassTintValues, PARADIS_GLASS_SURFACES } from '../common/paradisFrostedGlassTint.js';

/**
 * ウィンドウ透過中のすりガラス（q.html Q330 D）。
 *
 * 透過中は fork の下支え（paradisWindowTransparency.css）がポップアップの背景にエディタの地の色を敷いていたため、
 * upstream のすりガラスと重なると通知の一覧がエディタの地の色になり、クイック入力やホバーも暗くなっていた。
 * CSS 側でその下支えをすりガラスのときだけ外し、ここで層の色を「エディタの地の色の上で paracode-165 の色になる」よう
 * 補正して各ウィンドウのワークベンチ要素に変数として入れる。ぼかしの強さは upstream のまま。
 *
 * 変数を置くだけで、効くかどうかは CSS が決める（透過 `.paradis-transparent` とすりガラス `.modern-ui-frosted-glass`
 * の両方があり、ハイコントラストでも OS の「透明度を下げる」でもないときだけ）。透過がオフのときは upstream の
 * すりガラスがそのまま出る。テーマと透け具合の設定が変わるたび、補助ウィンドウが開くたびに計算し直す。
 */
class ParadisFrostedGlassTintContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisFrostedGlassTint';

	private values: readonly [string, string][] = [];

	constructor(
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		this._register(this.themeService.onDidColorThemeChange(() => this.update()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LayoutSettings.MODERN_UI_FROSTED_GLASS_OPACITY)) {
				this.update();
			}
		}));
		this._register(this.layoutService.onDidAddContainer(({ container, disposables }) => {
			this.applyTo(container);
			disposables.add(toDisposable(() => this.clear(container)));
		}));
		this._register(toDisposable(() => {
			for (const container of this.layoutService.containers) {
				this.clear(container);
			}
		}));

		this.update();
	}

	private update(): void {
		this.values = computeParadisGlassTintValues(
			this.themeService.getColorTheme(),
			clampParadisGlassOpacity(this.configurationService.getValue<number>(LayoutSettings.MODERN_UI_FROSTED_GLASS_OPACITY)),
		);
		for (const container of this.layoutService.containers) {
			this.applyTo(container);
		}
	}

	private applyTo(container: HTMLElement): void {
		this.clear(container);
		for (const [property, value] of this.values) {
			container.style.setProperty(property, value);
		}
	}

	private clear(container: HTMLElement): void {
		for (const [property] of PARADIS_GLASS_SURFACES) {
			container.style.removeProperty(property);
		}
	}
}

// すりガラスのクラスは upstream が AfterRestored で付けるので、変数はそれより前に置いておけばよい。
registerWorkbenchContribution2(ParadisFrostedGlassTintContribution.ID, ParadisFrostedGlassTintContribution, WorkbenchPhase.BlockRestore);
