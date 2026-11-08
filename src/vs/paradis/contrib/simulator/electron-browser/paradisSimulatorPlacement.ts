/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのタブを開く場所。内蔵ブラウザのエージェントのタブと同じ決め方（paradisAgentTabPlacement.ts）を使う:
// シミュレータのタブがあるグループ → エージェントの要求を承認して開くときは、そのペインのターミナルの右へ分割
// （分割後に最小幅が取れるとき）→ ターミナルの無い一番広いグループ → ターミナルしか無ければ裏のタブ。
// 同じ端末のタブがあれば、そのタブを前に出すだけ。

import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { GroupDirection, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IParadisAgentTabGroupInfo, PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING, ParadisEditorSplitSizing, paradisChooseAgentTabPlacement, paradisPredictSplitWidth } from '../../agentBrowser/common/paradisAgentTabPlacement.js';
import { ParadisSimulatorEditorInput } from './paradisSimulatorEditorInput.js';

/** エージェントの要求を承認して開くときの指定。 */
export interface IParadisSimulatorOpenForPane {
	/** 要求したペインのターミナルの instanceId（エディタ領域にあれば、その右へ分割する）。 */
	readonly paneInstanceId: number | undefined;
}

/**
 * シミュレータのタブを開く（同じ端末のタブがこの窓にあれば前に出す）。開いた（または前に出した）入力を返す。
 * `forPane` を渡すとエージェントの要求の承認から開いたものとして、フォーカスを奪わずに置く。
 */
export async function paradisOpenSimulatorEditor(udid: string, name: string, editorService: IEditorService, editorGroupsService: IEditorGroupsService, configurationService: IConfigurationService, forPane?: IParadisSimulatorOpenForPane): Promise<ParadisSimulatorEditorInput> {
	const groups = editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
	const background = forPane !== undefined;
	for (const group of groups) {
		const existing = group.editors.find((editor): editor is ParadisSimulatorEditorInput => editor instanceof ParadisSimulatorEditorInput && editor.udid === udid);
		if (existing) {
			await editorService.openEditor(existing, { pinned: true, preserveFocus: background }, group);
			return existing;
		}
	}
	const input = new ParadisSimulatorEditorInput(udid, name);
	const sizing = configurationService.getValue<ParadisEditorSplitSizing>('workbench.editor.splitSizing');
	const infos: IParadisAgentTabGroupInfo[] = groups.map(group => {
		const width = editorGroupsService.getPart(group).getSize(group).width;
		const hasPaneTerminal = forPane?.paneInstanceId !== undefined && group.editors.some(editor => editor instanceof TerminalEditorInput && editor.terminalInstance?.instanceId === forPane.paneInstanceId);
		return {
			id: group.id,
			width,
			hasPaneTerminal,
			hasTerminal: group.editors.some(editor => editor instanceof TerminalEditorInput),
			hasOwnAgentTab: group.editors.some(editor => editor instanceof ParadisSimulatorEditorInput),
			...(hasPaneTerminal ? { splitWidth: paradisPredictSplitWidth(width, rowWidths(editorGroupsService, group), sizing) } : {}),
		};
	});
	const placement = paradisChooseAgentTabPlacement(infos, configurationService.getValue<number>(PARADIS_AGENT_TAB_MIN_SPLIT_WIDTH_SETTING));
	if (placement?.kind === 'split') {
		const base = groups.find(group => group.id === placement.besideGroupId)!;
		const split = editorGroupsService.getPart(base).addGroup(base, GroupDirection.RIGHT);
		await openInto(editorService, editorGroupsService, input, split, false, true, background);
		return input;
	}
	const group = (placement ? groups.find(candidate => candidate.id === placement.groupId) : undefined) ?? editorGroupsService.activeGroup;
	// 利用者がコマンドで開いたときは、ターミナルしか無いグループでも前に出す。エージェントの要求で開くときは、
	// ターミナルを隠さないよう裏のタブにする
	await openInto(editorService, editorGroupsService, input, group, background && (placement?.kind === 'group' && placement.inactive), false, background);
	return input;
}

/** そのグループと同じ横の並びにあるグループの幅（paradisAgentBrowserTabsService.ts と同じたどり方）。 */
function rowWidths(editorGroupsService: IEditorGroupsService, group: IEditorGroup): number[] {
	const part = editorGroupsService.getPart(group);
	const row = [group];
	for (const direction of [GroupDirection.LEFT, GroupDirection.RIGHT]) {
		let current: IEditorGroup | undefined = group;
		while ((current = part.findGroup({ direction }, current)) !== undefined && !row.includes(current)) {
			row.push(current);
		}
	}
	return row.map(candidate => part.getSize(candidate).width);
}

/** `createdGroup` は、開くために分割して作ったグループか（開けなかったら、作ったグループだけを消す）。 */
async function openInto(editorService: IEditorService, editorGroupsService: IEditorGroupsService, input: ParadisSimulatorEditorInput, group: IEditorGroup, inactive: boolean, createdGroup: boolean, preserveFocus: boolean): Promise<void> {
	try {
		await editorService.openEditor(input, { pinned: true, inactive, preserveFocus, activation: inactive || preserveFocus ? EditorActivation.PRESERVE : undefined }, group);
	} finally {
		if (createdGroup && group.isEmpty) {
			editorGroupsService.getPart(group).removeGroup(group);
		}
	}
}
