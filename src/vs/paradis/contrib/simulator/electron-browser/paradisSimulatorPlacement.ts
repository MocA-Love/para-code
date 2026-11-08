/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのタブを開く場所。内蔵ブラウザのエージェントのタブと同じ決め方（paradisAgentTabPlacement.ts）を使う:
// シミュレータのタブがあるグループ → （ペインのターミナルの右への分割は ③ の承認から開くときに使う）→
// ターミナルの無い一番広いグループ → ターミナルしか無ければ裏のタブ。同じ端末のタブがあれば、そのタブを前に出すだけ。

import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IParadisAgentTabGroupInfo, PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING, paradisChooseAgentTabPlacement } from '../../agentBrowser/common/paradisAgentTabPlacement.js';
import { ParadisSimulatorEditorInput } from './paradisSimulatorEditorInput.js';

/** シミュレータのタブを開く（同じ端末のタブがこの窓にあれば前に出す）。 */
export async function paradisOpenSimulatorEditor(udid: string, name: string, editorService: IEditorService, editorGroupsService: IEditorGroupsService, configurationService: IConfigurationService): Promise<void> {
	const groups = editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
	for (const group of groups) {
		const existing = group.editors.find(editor => editor instanceof ParadisSimulatorEditorInput && editor.udid === udid);
		if (existing) {
			await editorService.openEditor(existing, { pinned: true }, group);
			return;
		}
	}
	const input = new ParadisSimulatorEditorInput(udid, name);
	const infos: IParadisAgentTabGroupInfo[] = groups.map(group => ({
		id: group.id,
		width: editorGroupsService.getPart(group).getSize(group).width,
		hasPaneTerminal: false,
		hasTerminal: group.editors.some(editor => editor instanceof TerminalEditorInput),
		hasOwnAgentTab: group.editors.some(editor => editor instanceof ParadisSimulatorEditorInput),
	}));
	const placement = paradisChooseAgentTabPlacement(infos, configurationService.getValue<number>(PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING));
	if (placement?.kind === 'split') {
		const base = groups.find(group => group.id === placement.besideGroupId)!;
		const split = editorGroupsService.getPart(base).addGroup(base, GroupDirection.RIGHT);
		await openInto(editorService, editorGroupsService, input, split, false, true);
		return;
	}
	const group = (placement ? groups.find(candidate => candidate.id === placement.groupId) : undefined) ?? editorGroupsService.activeGroup;
	// 利用者がコマンドで開いたので、ターミナルしか無いグループでも前に出す（エージェントの要求で開くとき（③）は裏）
	await openInto(editorService, editorGroupsService, input, group, false, false);
}

/** `createdGroup` は、開くために分割して作ったグループか（開けなかったら、作ったグループだけを消す）。 */
async function openInto(editorService: IEditorService, editorGroupsService: IEditorGroupsService, input: ParadisSimulatorEditorInput, group: IEditorGroup, inactive: boolean, createdGroup: boolean): Promise<void> {
	try {
		await editorService.openEditor(input, { pinned: true, inactive, activation: inactive ? EditorActivation.PRESERVE : undefined }, group);
	} finally {
		if (createdGroup && group.isEmpty) {
			editorGroupsService.getPart(group).removeGroup(group);
		}
	}
}
