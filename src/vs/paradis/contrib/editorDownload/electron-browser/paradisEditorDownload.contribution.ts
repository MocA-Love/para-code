/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブの右クリックに「ダウンロード...」を出す（SSH の窓の接続先のファイルのタブだけ）。
// 保存先のダイアログ・前回の保存先の記憶・進み具合の表示は upstream の FileDownload に任せる
// （エクスプローラーの「ダウンロード...」と同じ動き）。

import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { MultipleEditorsSelectedInGroupContext } from '../../../../workbench/common/contextkeys.js';
import { EditorResourceAccessor, IEditorCommandsContext, isDiffEditorInput, isEditorCommandsContext, isSideBySideEditorInput, SideBySideEditor } from '../../../../workbench/common/editor.js';
import { FileDownload } from '../../../../workbench/contrib/files/browser/fileImportExport.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_EDITOR_DOWNLOAD_COMMAND_ID, PARADIS_EDITOR_DOWNLOAD_WHEN, paradisEditorDownloadSource, paradisIsParadisDiffInput } from '../common/paradisEditorDownload.js';

registerAction2(class ParadisEditorDownloadAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_EDITOR_DOWNLOAD_COMMAND_ID,
			title: localize2('paradis.editorDownload.download', "ダウンロード..."),
			f1: false,
			// 右クリックしたタブ 1 つだけを落とす（複数のタブを選んでいるときは押せない。upstream の「エクスプローラーで表示」と同じ）
			precondition: MultipleEditorsSelectedInGroupContext.negate(),
			menu: {
				id: MenuId.EditorTitleContext,
				// 「エクスプローラーで表示」（order 1）の下
				group: '2_files',
				order: 2,
				when: PARADIS_EDITOR_DOWNLOAD_WHEN,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: unknown, context?: unknown): Promise<void> {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);

		const commandsContext: IEditorCommandsContext | undefined = isEditorCommandsContext(context) ? context : undefined;
		const group = commandsContext ? editorGroupsService.getGroup(commandsContext.groupId) : undefined;
		const editor = group && commandsContext?.editorIndex !== undefined ? group.getEditorByIndex(commandsContext.editorIndex) : group?.activeEditor ?? undefined;
		const target = URI.isUri(resource) ? resource : EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		const source = paradisEditorDownloadSource(target, editor ? { sideBySide: isSideBySideEditorInput(editor) || isDiffEditorInput(editor) || paradisIsParadisDiffInput(editor), dirty: editor.isDirty() } : undefined);
		if (!source) {
			notificationService.info(localize('paradis.editorDownload.unavailable', "差分のタブや未保存の変更があるタブはダウンロードできません。ファイルのタブを保存してから選んでください。"));
			return;
		}
		try {
			await instantiationService.createInstance(FileDownload).download([source]);
		} catch (error) {
			notificationService.error(error);
		}
	}
});
