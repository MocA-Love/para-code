/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ダッシュボードの EditorPane（案B）。
// ステータスバーのポップオーバー(案A)の「詳細を開く」から開かれる。
// 中身は統合ダイアログと共有するため `ParadisGithubMetricsSection` にあり、
// このクラスはそれを1つ内包して EditorPane のライフサイクル（入力・可視状態・寸法・
// フォーカス）をセクションへ流し込むだけの薄いラッパに留める。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_GITHUB_METRICS_EDITOR_ID } from './paradisGithubMetricsInput.js';
import { ParadisGithubMetricsSection } from './paradisGithubMetricsSection.js';

export class ParadisGithubMetricsEditor extends EditorPane {

	static readonly ID = PARADIS_GITHUB_METRICS_EDITOR_ID;

	private readonly section: ParadisGithubMetricsSection;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(PARADIS_GITHUB_METRICS_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.section = this._register(instantiationService.createInstance(ParadisGithubMetricsSection));
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.appendChild(this.section.element);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.section.ensureLoaded();
	}

	override layout(dimension: dom.Dimension): void {
		this.section.layout(dimension.width);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.section.setVisible(visible);
	}

	override focus(): void {
		super.focus();
		this.section.focus();
	}
}
