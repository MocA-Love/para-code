/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの登録入り口。paradis.common.contribution.ts から import される
// （使うのはテーマ・設定・色レジストリ・DOM だけなので、Web ビルドでも動く）。
//   - 下書きサービス（IParadisThemeColorDraftService）
//   - エディタ（EditorPane）とタブ復元のシリアライザ
//   - コマンド「テーマの色を編集…」「テーマの色: 画面から選ぶ」
// 歯車メニューの項目は settingsMenu/browser/paradisSettingsMenu.contribution.ts が足す。

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_THEME_COLORS_EDIT_COMMAND_ID, PARADIS_THEME_COLORS_PICK_COMMAND_ID } from '../common/paradisThemeColorModel.js';
import { IParadisThemeColorDraftService, ParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';
import { ParadisThemeColorEditor } from './paradisThemeColorEditor.js';
import {
	ParadisThemeColorEditorInput,
	ParadisThemeColorEditorInputSerializer,
	ParadisThemeColorRevealTarget,
	PARADIS_THEME_COLOR_EDITOR_ID,
	PARADIS_THEME_COLOR_INPUT_TYPE_ID,
} from './paradisThemeColorEditorInput.js';
import { ParadisScreenColorPicker, ParadisScreenPickResult } from './paradisScreenColorPicker.js';

registerSingleton(IParadisThemeColorDraftService, ParadisThemeColorDraftService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisThemeColorEditor, PARADIS_THEME_COLOR_EDITOR_ID, localize('paradis.themeColors.editorName', "テーマの色")),
	[new SyncDescriptor(ParadisThemeColorEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PARADIS_THEME_COLOR_INPUT_TYPE_ID, ParadisThemeColorEditorInputSerializer);

const CATEGORY = localize2('paradis.category', "Para Code");

async function openThemeColorEditor(accessor: ServicesAccessor, target?: ParadisThemeColorRevealTarget): Promise<void> {
	const input = ParadisThemeColorEditorInput.getOrCreate(accessor.get(IInstantiationService));
	await accessor.get(IEditorService).openEditor(input, { pinned: true });
	if (target) {
		input.reveal(target);
	}
}

class ParadisEditThemeColorsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_THEME_COLORS_EDIT_COMMAND_ID,
			title: localize2('paradis.themeColors.edit', "テーマの色を編集…"),
			category: CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return openThemeColorEditor(accessor);
	}
}

let activePicker: ParadisScreenColorPicker | undefined;

function toRevealTarget(result: ParadisScreenPickResult): ParadisThemeColorRevealTarget {
	switch (result.kind) {
		case 'color': return { tab: 'ui', colorId: result.colorId };
		case 'query': return { tab: 'ui', query: result.query };
		case 'syntax': return { tab: 'syntax' };
	}
}

class ParadisPickThemeColorFromScreenAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_THEME_COLORS_PICK_COMMAND_ID,
			title: localize2('paradis.themeColors.pick', "テーマの色: 画面から選ぶ"),
			category: CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		activePicker?.dispose();
		const picker: ParadisScreenColorPicker = instantiationService.createInstance(
			ParadisScreenColorPicker,
			getActiveWindow(),
			result => instantiationService.invokeFunction(openThemeColorEditor, toRevealTarget(result)),
			() => {
				picker.dispose();
				if (activePicker === picker) {
					activePicker = undefined;
				}
			},
		);
		activePicker = picker;
	}
}

registerAction2(ParadisEditThemeColorsAction);
registerAction2(ParadisPickThemeColorFromScreenAction);
