/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// いま開いているスペース (リポジトリ / worktree) に設定された色を CSS 変数
// `--paradis-space-accent` として各ウィンドウの <body> に流すだけの contribution。
// 実際に色を使うのは media/paradisSpaceAccent.css (エディタタブのフォーカスリングのみ)。
//
// テーマの `focusBorder` 自体は書き換えない。リスト・入力欄・ボタンのフォーカス表示まで
// スペース色になると、暗いパレット色を選んだスペースでフォーカス位置が読めなくなるため。

import { getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { editorBackground } from '../../../../platform/theme/common/colors/editorColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { TAB_ACTIVE_BACKGROUND } from '../../../../workbench/common/theme.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisResolveSpaceInfo } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import './media/paradisSpaceAccent.css';

/** タブのフォーカスリングとして成立させたい、タブ背景との最小コントラスト比。 */
const MIN_CONTRAST_RATIO = 3;

const CSS_VARIABLE = '--paradis-space-accent';

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

	private applyTo(targetWindow: Window, accent: string | undefined): void {
		const body = targetWindow.document.body;
		if (accent) {
			body.style.setProperty(CSS_VARIABLE, accent);
		} else {
			body.style.removeProperty(CSS_VARIABLE);
		}
	}

	/**
	 * いま開いているスペースの色を、タブ背景に対して見えるところまで明度を寄せて返す。
	 * スペース色が未設定なら undefined (CSS 側が `focusBorder` にフォールバックする)。
	 */
	private resolveAccent(): string | undefined {
		const spaceColor = paradisResolveSpaceInfo(
			this.workspaceSwitchService.activeStateKey,
			this.workspaceSwitchService.repositories,
			this.worktreeService,
		)?.color;
		if (!spaceColor) {
			return undefined;
		}

		const accent = Color.fromHex(spaceColor);
		const theme = this.themeService.getColorTheme();
		// タブ背景は既定でエディタ背景を引き継ぐが、テーマによっては半透明を指定できるため、
		// エディタ背景と合成してから比較する (透明のまま比べると輝度が実際と食い違う)。
		const editorBg = theme.getColor(editorBackground) ?? (theme.type === 'light' ? Color.white : Color.black);
		const tabBg = theme.getColor(TAB_ACTIVE_BACKGROUND)?.makeOpaque(editorBg) ?? editorBg;
		if (tabBg.getContrastRatio(accent) >= MIN_CONTRAST_RATIO) {
			return accent.toString();
		}

		// 12色のパレットには背景に沈む暗い色 (slate 等) も混ざる。暗い背景では明るく、
		// 明るい背景では暗く寄せて、どのスペースでもリングが見える状態を保つ。
		const adjusted = tabBg.isLighter()
			? tabBg.reduceRelativeLuminace(accent, MIN_CONTRAST_RATIO)
			: tabBg.increaseRelativeLuminace(accent, MIN_CONTRAST_RATIO);
		return adjusted.toString();
	}
}

registerWorkbenchContribution2(ParadisSpaceAccentContribution.ID, ParadisSpaceAccentContribution, WorkbenchPhase.AfterRestored);
