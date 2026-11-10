/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 横断ジャンプ（G-05）: 要対応のエージェント（全スペース）・今のスペースの開いているタブ・スペースを
// 1 つのクイックピックで選んで移る。Orca の Cmd+J（Linux・Windows は Ctrl+Shift+J）に当たるが、
// 既定のキーは付けない（Linux・Windows の Ctrl+Shift+J はチャット表示の切り替えが使っている。
// 利用者がキー割り当てで付ける）。
//
// エージェントへの移動は OS 通知のクリックと同じ paradisRevealNotifiedPane を使う（別スペースなら
// 切り替え、切り替えが割り込まれたら開かない、補助ウィンドウのペインはそのウィンドウを前へ）。

import { Codicon } from '../../../../base/common/codicons.js';
import { stripIcons } from '../../../../base/common/iconLabels.js';
import { Schemas } from '../../../../base/common/network.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { EditorResourceAccessor, EditorsOrder, IEditorIdentifier, SideBySideEditor } from '../../../../workbench/common/editor.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisAgentLiveEntry, IParadisAgentLiveWindowService, ParadisAgentLiveStatus } from '../../agentLiveWindow/common/paradisAgentLiveWindow.js';
import { paradisRevealNotifiedPane } from '../../notifications/electron-browser/paradisNotificationReveal.js';
import { IParadisAgentStatusStore, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisFormatCrossJumpAgo, paradisShouldOfferCrossJumpCreate, paradisSortCrossJumpAgents } from '../common/paradisCrossJump.js';

/** 横断ジャンプのコマンド。キーは付けない（利用者がキー割り当てで付ける）。 */
export const PARADIS_CROSS_JUMP_COMMAND_ID = 'paradis.crossJump.open';

/** ワークツリースペースの作成（ダイアログ）。登録元の contribution を import すると登録の副作用が走るので ID だけ持つ。 */
const CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';

const STATUS_LABELS: Record<ParadisAgentLiveStatus, string> = {
	permission: localize('paradis.crossJump.status.permission', "許可待ち"),
	question: localize('paradis.crossJump.status.question', "質問中"),
	working: localize('paradis.crossJump.status.working', "実行中"),
	review: localize('paradis.crossJump.status.review', "完了"),
	idle: localize('paradis.crossJump.status.idle', "待機"),
};

type ParadisCrossJumpItem = IQuickPickItem & (
	| { readonly kind: 'agent'; readonly entry: IParadisAgentLiveEntry }
	| { readonly kind: 'editor'; readonly identifier: IEditorIdentifier }
	| { readonly kind: 'space'; readonly stateKey: string }
	| { readonly kind: 'create'; readonly repositoryId: string; readonly name: string }
);

class ParadisCrossJumpAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_CROSS_JUMP_COMMAND_ID,
			title: localize2('paradis.crossJump.open', "エージェント・タブ・スペースへ移動..."),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const hostService = accessor.get(IHostService);
		const terminalService = accessor.get(ITerminalService);
		const workspaceSwitchService = accessor.get(IParadisWorkspaceSwitchService);
		const worktreeService = accessor.get(IParadisWorktreeService);
		const agentStatusStore = accessor.get(IParadisAgentStatusStore);
		const agentLiveWindowService = accessor.get(IParadisAgentLiveWindowService);
		const modelService = accessor.get(IModelService);
		const languageService = accessor.get(ILanguageService);

		const now = Date.now();
		const activeStateKey = workspaceSwitchService.activeStateKey;
		const spaces = paradisListSpaces(workspaceSwitchService.repositories, worktreeService);
		const agents = paradisSortCrossJumpAgents(agentLiveWindowService.entries);

		const agentItems: ParadisCrossJumpItem[] = agents.map(entry => ({
			kind: 'agent',
			entry,
			label: `$(${(entry.status === 'permission' || entry.status === 'question' ? Codicon.bell : Codicon.terminal).id}) ${entry.title}`,
			description: [entry.spaceName, STATUS_LABELS[entry.status] ?? entry.status, paradisFormatCrossJumpAgo(now - entry.since)].join(' · '),
		}));

		// エージェントの端末がエディタのタブになっているときは、上のエージェントの行と同じものなので外す。
		const agentTerminalResources = new Set<string>();
		for (const entry of agents) {
			const resource = terminalService.getInstanceFromId(entry.instanceId)?.resource;
			if (resource) {
				agentTerminalResources.add(resource.toString());
			}
		}
		const editorItems: ParadisCrossJumpItem[] = [];
		for (const identifier of editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			const resource = identifier.editor.resource;
			if (resource?.scheme === Schemas.vscodeTerminal && agentTerminalResources.has(resource.toString())) {
				continue;
			}
			// アイコンは「開いているエディターを表示」（editorQuickAccess.ts）と同じ組み立てにする。iconClasses は
			// 行のラベルの要素そのものに付くので、`codicon` の class を渡すとラベル全体が codicon のフォントで描かれ、
			// 文字が欠けてアイコンが縦にずれる（paracode-183〜185 の崩れ）。
			const icon = identifier.editor.getIcon();
			const iconResource = EditorResourceAccessor.getOriginalUri(identifier.editor, { supportSideBySide: SideBySideEditor.PRIMARY });
			editorItems.push({
				kind: 'editor',
				identifier,
				label: identifier.editor.getName(),
				description: identifier.editor.getDescription(),
				iconPath: URI.isUri(icon) ? { dark: icon } : undefined,
				iconClasses: getIconClasses(modelService, languageService, iconResource, undefined, icon).concat(identifier.editor.getLabelExtraClasses()),
			});
		}

		const spaceItems: ParadisCrossJumpItem[] = spaces.map(space => {
			const branch = space.kind === 'worktree' ? space.worktree?.branch : worktreeService.getRepositoryBranch(space.repositoryId);
			const status = agentStatusStore.getScopeStatus(space.space);
			const parts = [branch, status ? STATUS_LABELS[status] : undefined, space.space === activeStateKey ? localize('paradis.crossJump.currentSpace', "今のスペース") : undefined];
			return {
				kind: 'space',
				stateKey: space.space,
				label: `$(${(space.kind === 'worktree' ? Codicon.gitBranch : Codicon.repo).id}) ${space.name}`,
				description: parts.filter((part): part is string => !!part).join(' · '),
			};
		});

		// 作成の行の行き先は今のスペースのリポジトリ（スペースの外なら先頭のリポジトリ）。
		const createRepositoryId = spaces.find(space => space.space === activeStateKey)?.repositoryId ?? workspaceSwitchService.repositories[0]?.id;
		// アイコンの書式（`$(bell)` など）は検索の対象にならないので外して比べる
		const haystacks = [...agentItems, ...editorItems, ...spaceItems].flatMap(item => [stripIcons(item.label), item.description ?? '']);

		const disposables = new DisposableStore();
		const picker = disposables.add(quickInputService.createQuickPick<ParadisCrossJumpItem>({ useSeparators: true }));
		picker.placeholder = localize('paradis.crossJump.placeholder', "エージェント・タブ・スペースを検索");
		picker.matchOnDescription = true;

		const render = () => {
			const items: (ParadisCrossJumpItem | IQuickPickSeparator)[] = [];
			if (agentItems.length) {
				items.push({ type: 'separator', label: localize('paradis.crossJump.agents', "エージェント（要対応から）") }, ...agentItems);
			}
			if (editorItems.length) {
				items.push({ type: 'separator', label: localize('paradis.crossJump.editors', "開いているタブ（今のスペース）") }, ...editorItems);
			}
			if (spaceItems.length) {
				items.push({ type: 'separator', label: localize('paradis.crossJump.spaces', "スペース") }, ...spaceItems);
			}
			const name = picker.value.trim();
			if (createRepositoryId && paradisShouldOfferCrossJumpCreate(name, haystacks)) {
				items.push({
					kind: 'create',
					repositoryId: createRepositoryId,
					name,
					label: `$(${Codicon.add.id}) ${localize('paradis.crossJump.create', "ワークツリー「{0}」を作る", name)}`,
					alwaysShow: true,
				});
			}
			picker.items = items;
		};
		render();
		disposables.add(picker.onDidChangeValue(() => render()));

		const picked = await new Promise<ParadisCrossJumpItem | undefined>(resolve => {
			disposables.add(picker.onDidAccept(() => {
				resolve(picker.selectedItems[0]);
				picker.hide();
			}));
			disposables.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		disposables.dispose();

		switch (picked?.kind) {
			case 'agent':
				await paradisRevealNotifiedPane({ hostService, terminalService, workspaceSwitchService }, picked.entry.stateKey, picked.entry.instanceId);
				break;
			case 'editor':
				await editorService.openEditor(picked.identifier.editor, { preserveFocus: false }, picked.identifier.groupId);
				break;
			case 'space':
				// UI からの切り替えなので連打は畳み込む（中間のスペースを経由しない）。
				await workspaceSwitchService.switchToStateKey(picked.stateKey, { coalesce: true });
				break;
			case 'create':
				// 名前を入れた状態で作成のダイアログを開く（ベースブランチ・エージェントはダイアログで選ぶ）。
				await commandService.executeCommand(CREATE_WORKTREE_COMMAND_ID, picked.repositoryId, { repositoryId: picked.repositoryId, name: picked.name });
				break;
		}
	}
}

registerAction2(ParadisCrossJumpAction);
