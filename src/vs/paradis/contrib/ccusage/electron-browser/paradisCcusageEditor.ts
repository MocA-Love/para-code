/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ccusage ダッシュボードの EditorPane。中身の描画・データ取得・フィルタ状態は
// ParadisCcusageSection が全部持っているので、ここは EditorPane のライフサイクルを
// セクションへ渡すだけの薄いラッパ。統合ダイアログも同じセクションを包む。

import { Dimension } from '../../../../base/browser/dom.js';
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
import { PARADIS_CCUSAGE_EDITOR_ID } from './paradisCcusageInput.js';
import { ParadisCcusageSection } from './paradisCcusageSection.js';

export class ParadisCcusageEditor extends EditorPane {

	static readonly ID = PARADIS_CCUSAGE_EDITOR_ID;

	private section: ParadisCcusageSection | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(PARADIS_CCUSAGE_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.section = this._register(this.instantiationService.createInstance(ParadisCcusageSection));
		parent.appendChild(this.section.element);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateSectionVisibility();
		this.section?.ensureLoaded();
	}

	override clearInput(): void {
		super.clearInput();
		this.updateSectionVisibility();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.updateSectionVisibility();
	}

	override layout(dimension: Dimension): void {
		this.section?.layout(dimension.width);
	}

	override focus(): void {
		super.focus();
		this.section?.focus();
	}

	/**
	 * セクションから見た「見えている」は、タブが可視かつ入力が付いている状態。
	 * warm lease はこの状態の間だけ持つ(タブを閉じた/裏に回した間は CLI を回さない)。
	 */
	private updateSectionVisibility(): void {
		this.section?.setVisible(this.isVisible() && !!this.input);
	}
}
