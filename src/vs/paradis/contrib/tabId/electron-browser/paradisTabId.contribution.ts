/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのタブの右クリックに「タブ ID をコピー」を出す（Orca の Copy Tab ID と同じ考え方）。
// コピーした 1 行をエージェントへ貼ると、エージェントは para-browser MCP の既存の道具でそのタブを指せる。
// 新しい受け口は作らないので、届くかどうか・何ができるかは既存の道具の権限の確かめ（ペインの持ち主・
// スペースの範囲・ユーザーの承認）がそのまま決める。

import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { MultipleEditorsSelectedInGroupContext, ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { EditorResourceAccessor, IEditorCommandsContext, isEditorCommandsContext, SideBySideEditor } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisAgentIdeTerminalId } from '../../agentIde/electron-browser/paradisAgentIdeChannel.js';
import { PARADIS_SIMULATOR_DEVICE_ID_PREFIX } from '../../simulator/common/paradisSimulator.js';
import { ParadisAndroidEditorInput } from '../../simulator/electron-browser/paradisAndroidEditorInput.js';
import { PARADIS_SIMULATOR_SCHEME, ParadisSimulatorEditorInput } from '../../simulator/electron-browser/paradisSimulatorEditorInput.js';
import { IParadisTabId, paradisFormatTabId, paradisTabIdFilePath } from '../common/paradisTabId.js';

export const PARADIS_COPY_TAB_ID_COMMAND_ID = 'paradis.editor.copyTabId';

registerAction2(class ParadisCopyTabIdAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_COPY_TAB_ID_COMMAND_ID,
			title: localize2('paradis.tabId.copy', "タブ ID をコピー"),
			f1: false,
			// 右クリックしたタブ 1 つだけ（複数のタブを選んでいるときは押せない）
			precondition: MultipleEditorsSelectedInGroupContext.negate(),
			menu: {
				id: MenuId.EditorTitleContext,
				group: '1_cutcopypaste',
				order: 100,
				// エージェントの道具で指せる種類のタブだけ。種類の最終的な見分けは run() でエディタの型で行う
				// （内蔵ブラウザでローカルの HTML を開いているタブは file になるので、scheme では決めない）
				when: ContextKeyExpr.or(
					ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeTerminal),
					ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeBrowser),
					ResourceContextKey.Scheme.isEqualTo(PARADIS_SIMULATOR_SCHEME),
					ResourceContextKey.Scheme.isEqualTo(Schemas.file),
					ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote),
				),
			},
		});
	}

	override async run(accessor: ServicesAccessor, _resource?: unknown, context?: unknown): Promise<void> {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const paneTokenService = accessor.get(IParadisPaneTokenService);
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);

		const commandsContext: IEditorCommandsContext | undefined = isEditorCommandsContext(context) ? context : undefined;
		const group = commandsContext ? editorGroupsService.getGroup(commandsContext.groupId) : editorGroupsService.activeGroup;
		const editor = group && commandsContext?.editorIndex !== undefined ? group.getEditorByIndex(commandsContext.editorIndex) : group?.activeEditor ?? undefined;
		const id = editor ? tabIdOf(editor, paneTokenService) : undefined;
		const line = id ? paradisFormatTabId(id) : undefined;
		if (!line) {
			notificationService.info(localize('paradis.tabId.unavailable', "このタブにはエージェントが指せる ID がありません。"));
			return;
		}
		await clipboardService.writeText(line);
		notificationService.info(localize('paradis.tabId.copied', "タブ ID をコピーしました"));
	}
});

/** 右クリックしたタブの ID。エディタの型で種類を決める。 */
function tabIdOf(editor: EditorInput, paneTokenService: IParadisPaneTokenService): IParadisTabId | undefined {
	if (editor instanceof TerminalEditorInput) {
		const instanceId = editor.terminalInstance?.instanceId;
		const token = instanceId !== undefined ? paneTokenService.getTokenForInstance(instanceId) : undefined;
		// list_terminals に出るのは、トークンとインスタンスが互いに指し合うペインだけ（paradisCollectLivePaneInstances と同じ）。
		// トークンそのものは貼らない（ハッシュの id だけ）
		if (!token || paneTokenService.getInstanceForToken(token) !== instanceId) {
			return undefined;
		}
		return { kind: 'terminal', value: paradisAgentIdeTerminalId(token) };
	}
	if (editor instanceof BrowserEditorInput) {
		return { kind: 'browser', value: editor.id };
	}
	if (editor instanceof ParadisSimulatorEditorInput) {
		return { kind: 'simulator', value: `${PARADIS_SIMULATOR_DEVICE_ID_PREFIX}${editor.udid}` };
	}
	if (editor instanceof ParadisAndroidEditorInput) {
		return { kind: 'simulator', value: editor.deviceId };
	}
	const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
	if (!resource) {
		return undefined;
	}
	const path = paradisTabIdFilePath(resource);
	return path !== undefined ? { kind: 'file', value: path } : undefined;
}
