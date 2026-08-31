/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// いま開いているスペース (リポジトリ / worktree) に設定された色を CSS 変数
// `--paradis-space-accent` として各ウィンドウの <body> に流すだけの contribution。
// 実際に色を使うのは media/paradisSpaceAccent.css (エディタタブ上端の色帯のみ)。

import { getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { editorBackground } from '../../../../platform/theme/common/colors/editorColors.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { TAB_ACTIVE_BACKGROUND, TAB_SELECTED_BACKGROUND } from '../../../../workbench/common/theme.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisResolveSpaceInfo } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import './media/paradisSpaceAccent.css';

/** タブ上端の色帯として成立させたい、タブ背景との最小コントラスト比。 */
const MIN_CONTRAST_RATIO = 3;

/**
 * フォーカスされていないグループのアクティブタブに使う減光率。upstream の
 * `tab.unfocusedActiveBorderTop` 既定値 (`transparent(tab.activeBorderTop, 0.5)`,
 * theme.ts) と同じ 0.5 に揃え、フォーカスの有無が帯の濃さからも分かる状態を保つ。
 */
const UNFOCUSED_GROUP_ALPHA = 0.5;

const CSS_VARIABLE = '--paradis-space-accent';
const CSS_VARIABLE_UNFOCUSED = '--paradis-space-accent-unfocused';

/**
 * スペース色を CSS 変数として全ウィンドウへ配る。
 * 補助ウィンドウ (エディタの別ウィンドウ表示) にもタブがあるため、登録済みの全ウィンドウと
 * 後から開かれるウィンドウの両方に同じ値を書く。
 */
class ParadisSpaceAccentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.spaceAccent';

	constructor(
		@IThemeService private readonly themeService: IThemeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
	) {
		super();

		this._register(this.themeService.onDidColorThemeChange(() => this.update()));
		// 色の変更 (setRepositoryColor) と登録の増減はどちらも onDidChangeRepositories で届く。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.update()));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.update()));
		// worktree を開いている場合、検出が終わるまでスペースを解決できない。
		this._register(this.worktreeService.onDidChangeWorktrees(() => this.update()));
		this._register(onDidRegisterWindow(({ window }) => this.applyTo(window, this.resolveAccent())));

		this.update();
	}

	private update(): void {
		const accent = this.resolveAccent();
		for (const { window } of getWindows()) {
			this.applyTo(window, accent);
		}
	}

	private applyTo(targetWindow: Window, accent: Color | undefined): void {
		const body = targetWindow.document.body;
		if (accent) {
			body.style.setProperty(CSS_VARIABLE, accent.toString());
			// フォーカスされていないグループのアクティブタブ用に、あらかじめ減光した値も配る
			// (upstream の `tab.unfocusedActiveBorderTop` と同じ考え方。CSS 側で毎回演算しない)。
			body.style.setProperty(CSS_VARIABLE_UNFOCUSED, accent.transparent(UNFOCUSED_GROUP_ALPHA).toString());
		} else {
			body.style.removeProperty(CSS_VARIABLE);
			body.style.removeProperty(CSS_VARIABLE_UNFOCUSED);
		}
	}

	/**
	 * いま開いているスペースの色を、タブ背景に対して見えるところまで明度を寄せて返す。
	 * スペース色が未設定なら undefined (CSS 側が upstream 既定の色帯にフォールバックする)。
	 */
	private resolveAccent(): Color | undefined {
		const spaceColor = paradisResolveSpaceInfo(
			this.workspaceSwitchService.activeStateKey,
			this.workspaceSwitchService.repositories,
			this.worktreeService,
		)?.color;
		if (!spaceColor) {
			return undefined;
		}

		const theme = this.themeService.getColorTheme();
		// ハイコントラストテーマの帯色 (`activeContrastBorder` 等) はアクセシビリティ上テーマが
		// 意図的に握っている値なので、装飾目的のスペース色で上書きしない。
		if (isHighContrast(theme.type)) {
			return undefined;
		}

		const accent = Color.fromHex(spaceColor);
		// タブ背景は既定でエディタ背景を引き継ぐが、テーマによっては半透明を指定できるため、
		// エディタ背景と合成してから比較する (透明のまま比べると輝度が実際と食い違う)。
		const editorBg = theme.getColor(editorBackground) ?? (theme.type === 'light' ? Color.white : Color.black);
		// 色帯はアクティブタブ (tab.activeBackground) だけでなく、選択中タブ (tab.selectedBackground、
		// 既定は listInactiveSelectionBackground で別の色) にも出る。両方に対して見える色を選ぶため、
		// コントラストが厳しい方を基準に判定・調整する。
		const candidateBackgrounds = [TAB_ACTIVE_BACKGROUND, TAB_SELECTED_BACKGROUND]
			.map(colorId => theme.getColor(colorId)?.makeOpaque(editorBg) ?? editorBg);
		const worstBg = candidateBackgrounds.reduce((worst, bg) =>
			bg.getContrastRatio(accent) < worst.getContrastRatio(accent) ? bg : worst);
		if (worstBg.getContrastRatio(accent) >= MIN_CONTRAST_RATIO) {
			return accent;
		}

		// 12色のパレットには背景に沈む暗い色 (slate 等) も混ざる。暗い背景では明るく、
		// 明るい背景では暗く寄せて、どのスペースでも色帯が見える状態を保つ。
		return worstBg.isLighter()
			? worstBg.reduceRelativeLuminace(accent, MIN_CONTRAST_RATIO)
			: worstBg.increaseRelativeLuminace(accent, MIN_CONTRAST_RATIO);
	}
}

registerWorkbenchContribution2(ParadisSpaceAccentContribution.ID, ParadisSpaceAccentContribution, WorkbenchPhase.AfterRestored);
