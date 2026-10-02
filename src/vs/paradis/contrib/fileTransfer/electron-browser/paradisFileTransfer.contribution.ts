/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送（段階 1）の登録入り口。paradis.electron-browser.contribution.ts から import される
// （手元の file:// を読むのも、手元の権限のチャネルも Electron のときだけ使えるので、Web には載せない）。
//
// 入口は 4 つ。
// - 主: アクティビティバーの左下、アカウントと設定の間のボタン（paradisFileTransferActivity.ts）
// - 補助 1: タイトルバーのボタン。`workbench.activityBar.location` が既定（左右）以外のときだけ
//   （上・下・非表示では左下の欄ごと描かれないため）
// - 補助 2: エクスプローラーのフォルダーの右クリック。手元のフォルダーは左、接続先のフォルダーは右に出す
// - コマンドパレット

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import {
	PARADIS_FILE_TRANSFER_EDITOR_ID,
	PARADIS_FILE_TRANSFER_INPUT_TYPE_ID,
	PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID,
	PARADIS_FILE_TRANSFER_OPEN_FOLDER_COMMAND_ID,
	PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY,
	PARADIS_FILE_TRANSFER_TITLE_BAR_COMMAND_ID,
	paradisShouldOpenFromPending,
	paradisSideForResource,
} from '../common/paradisFileTransfer.js';
import { PARADIS_FILE_TRANSFER_EXPLORER_WHEN, PARADIS_FILE_TRANSFER_TITLE_BAR_WHEN } from '../common/paradisFileTransferEntryPoints.js';
import { ParadisFileTransferEditor } from './paradisFileTransferEditor.js';
import { PARADIS_FILE_TRANSFER_ICON, ParadisFileTransferInput, ParadisFileTransferInputSerializer } from './paradisFileTransferInput.js';
import './paradisFileTransferActivity.js';
import './paradisFileTransferService.js';
import './media/paradisFileTransfer.css';

const PARADIS_CATEGORY = localize2('paradis.fileTransfer.category', "Para Code");

// ---------- editor pane / serializer ----------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisFileTransferEditor,
		PARADIS_FILE_TRANSFER_EDITOR_ID,
		localize('paradis.fileTransfer.editorName', "ファイル転送"),
	),
	[new SyncDescriptor(ParadisFileTransferInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_FILE_TRANSFER_INPUT_TYPE_ID,
	ParadisFileTransferInputSerializer,
);

// ---------- 開く ----------

async function openFileTransfer(accessor: ServicesAccessor, resource?: URI): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const input = ParadisFileTransferInput.instance;
	if (URI.isUri(resource)) {
		const side = paradisSideForResource(resource, environmentService.remoteAuthority || undefined);
		if (side) {
			input.reveal({ side, resource });
		}
	}
	await editorService.openEditor(input, { pinned: true });
}

registerAction2(class OpenParadisFileTransferAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID,
			title: localize2('paradis.fileTransfer.open', "ファイル転送を開く"),
			category: PARADIS_CATEGORY,
			icon: PARADIS_FILE_TRANSFER_ICON,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		await openFileTransfer(accessor, resource);
	}
});

registerAction2(class OpenParadisFileTransferFromTitleBarAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_FILE_TRANSFER_TITLE_BAR_COMMAND_ID,
			title: localize2('paradis.fileTransfer.openFromTitleBar', "ファイル転送"),
			icon: PARADIS_FILE_TRANSFER_ICON,
			f1: false,
			menu: {
				id: MenuId.TitleBar,
				group: 'navigation',
				// 内蔵ブラウザ（10）や通知のベル（10000）より手前、レイアウトの切り替えの左に並ぶ
				order: 5,
				when: PARADIS_FILE_TRANSFER_TITLE_BAR_WHEN,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openFileTransfer(accessor);
	}
});

registerAction2(class OpenParadisFileTransferFolderAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_FILE_TRANSFER_OPEN_FOLDER_COMMAND_ID,
			title: localize2('paradis.fileTransfer.openFolder', "ファイル転送で開く"),
			f1: false,
			menu: {
				id: MenuId.ExplorerContext,
				group: '6_paradis',
				order: 10,
				when: PARADIS_FILE_TRANSFER_EXPLORER_WHEN,
			},
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		await openFileTransfer(accessor, resource);
	}
});

// ---------- 「接続して開く」で開いたウィンドウ ----------

/**
 * 手元のウィンドウの右側で「接続して開く」を押すと、そのホストに繋いだ新しいウィンドウが開く。
 * 開いた側が残した控えがこのウィンドウ宛てなら、起動後に転送画面を出す（控えは読んだら消す）。
 */
class ParadisFileTransferPendingOpenContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.contrib.fileTransferPendingOpen';

	constructor(
		@IStorageService storageService: IStorageService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		const remoteAuthority = environmentService.remoteAuthority || undefined;
		const raw = storageService.get(PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY, StorageScope.APPLICATION);
		if (!remoteAuthority || !raw) {
			return;
		}
		if (paradisShouldOpenFromPending(raw, remoteAuthority, Date.now())) {
			storageService.remove(PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY, StorageScope.APPLICATION);
			void editorService.openEditor(ParadisFileTransferInput.instance, { pinned: true });
		}
	}
}

registerWorkbenchContribution2(ParadisFileTransferPendingOpenContribution.ID, ParadisFileTransferPendingOpenContribution, WorkbenchPhase.AfterRestored);
