/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループ（案 B: Bot のペインを並べて、上の 1 行から名指しで送る）のウィンドウ側。
// paradis.electron-browser.contribution.ts から読み込む。
//
// - 開く（コマンド `paradis.bots.openGroup`、引数はグループの id）: グループの部屋（入力欄と記録の短いエディタ）を
//   開き、その下にメンバーの Bot のターミナルを横に並べる。今あるエディタの配置は組み直さず、グループを足すだけ。
//   別のスペースで動いている Bot は動かさない（開くとスペースが切り替わるため）。部屋に「別のスペースで動作中」と出す。
// - 送る: 部屋の入力欄の文を、名指しした Bot のペインへ送る。送る口はチャット表示と同じ
//   （IParadisAgentChatService.sendMessageToPane。許可・質問の画面が出ている間などは断られる）。新しい入力の経路は作らない。
// - Bot 同士の伝言はペインへ打ち込まない。伝言の道具（paradisBotMessageToolProvider.ts）が shared process で台帳に記録し、
//   宛先の Bot の受け箱（未読の記録）に入る。宛先は道具 `bot_inbox` で読む。このウィンドウ側には窓口を置かない。
//
// どれも設定 paradis.bots.enabled（既定オフ）の下。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentChatService } from '../../agentChat/browser/paradisAgentChatService.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisBotGroupSender, ParadisBotGroupEditorInput } from '../browser/paradisBotGroupEditor.js';
import { paradisFindBotChatPane } from '../browser/paradisBotPaneHash.js';
import { paradisBotGroupMembers } from '../common/paradisBotGroups.js';
import { IParadisBotGroupsService, PARADIS_BOTS_OPEN_GROUP_COMMAND } from '../common/paradisBotGroupsApi.js';
import { IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { paradisOpenBot } from './paradisBotsLaunch.contribution.js';
import './paradisBotGroupsService.js';
import '../browser/paradisBotGroupEditor.contribution.js';

/** 部屋の高さ（入力欄 1 行と、記録の数行）。 */
const ROOM_HEIGHT = 220;

/** このウィンドウでの、Bot のペインの居場所。 */
type ParadisBotPaneWhere =
	| { readonly kind: 'here'; readonly instanceId: number }
	| { readonly kind: 'elsewhere'; readonly instanceId: number }
	| { readonly kind: 'none' };

async function botPaneWhere(accessor: ServicesAccessor, botId: string): Promise<ParadisBotPaneWhere> {
	const botsService = accessor.get(IParadisBotsService);
	const paneTokenService = accessor.get(IParadisPaneTokenService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	// 会話のペインだけを見る（部屋から送る先。見回りのペインへは送らない）
	const found = await paradisFindBotChatPane({
		paneTokenService,
		findInstance: instanceId => paradisCollectAllTerminalInstances(terminalService, terminalGroupService).find(instance => instance.instanceId === instanceId),
		stateKeyOf: instanceId => terminalScopeService.getStateKeyForInstance(instanceId),
	}, botsService, botId);
	if (found === undefined) {
		return { kind: 'none' };
	}
	// スペースを使っていないウィンドウ、または今のスペースのペインなら、ここで並べられる
	const here = found.stateKey === undefined || switchService.activeStateKey === undefined || found.stateKey === switchService.activeStateKey;
	return { kind: here ? 'here' : 'elsewhere', instanceId: found.instanceId };
}

/** そのターミナルのエディタと、それを持つグループ。 */
function findTerminalEditor(editorGroupsService: IEditorGroupsService, instanceId: number): { readonly group: IEditorGroup; readonly input: TerminalEditorInput } | undefined {
	for (const group of editorGroupsService.groups) {
		for (const editor of group.editors) {
			if (editor instanceof TerminalEditorInput && editor.terminalInstance?.instanceId === instanceId) {
				return { group, input: editor };
			}
		}
	}
	return undefined;
}

/** 開いた結果。`elsewhere` は別のスペースで動いているので並べなかった Bot。 */
export interface IParadisOpenBotGroupResult {
	readonly elsewhere: readonly string[];
}

/**
 * グループを開く。部屋を開き（もう開いていれば前に出す）、その下にメンバーのターミナルを横に並べる。
 * 今のエディタの配置は組み直さない（足すだけ）。1 つのグループに 2 人のターミナルが重なっていれば、後の方を隣へ移す。
 */
export async function paradisOpenBotGroup(accessor: ServicesAccessor, groupId: string): Promise<IParadisOpenBotGroupResult | undefined> {
	const groupsService = accessor.get(IParadisBotGroupsService);
	const botsService = accessor.get(IParadisBotsService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groupsService.snapshot.groups.find(candidate => candidate.id === groupId);
	if (group === undefined) {
		return undefined;
	}
	const bots = botsService.snapshot.bots;
	const members = paradisBotGroupMembers(group, new Set(bots.map(bot => bot.id)))
		.filter(id => bots.find(bot => bot.id === id)?.paused !== true);

	// 部屋。もう開いていればそのグループ、無ければ今のグループが空ならそこ、空でなければ右に足したグループ
	const input = ParadisBotGroupEditorInput.getOrCreate(instantiationService, groupId);
	let room = editorGroupsService.groups.find(candidate => candidate.contains(input));
	if (room === undefined) {
		const active = editorGroupsService.activeGroup;
		room = active.isEmpty ? active : editorGroupsService.addGroup(active, GroupDirection.RIGHT);
	}
	await room.openEditor(input, { pinned: true });

	const elsewhere: string[] = [];
	// 並べたメンバーの枠（並べた順）。次のメンバーは最後の枠の右、最初のメンバーは部屋の下
	const placed: IEditorGroup[] = [];
	const nextGroup = () => placed.length > 0 ? editorGroupsService.addGroup(placed[placed.length - 1], GroupDirection.RIGHT) : editorGroupsService.addGroup(room, GroupDirection.DOWN);
	for (const botId of members) {
		const where = await instantiationService.invokeFunction(botPaneWhere, botId);
		if (where.kind === 'elsewhere') {
			elsewhere.push(botId);
			continue;
		}
		const existing = where.kind === 'here' ? findTerminalEditor(editorGroupsService, where.instanceId) : undefined;
		if (existing !== undefined && existing.group.id !== room.id && !placed.some(candidate => candidate.id === existing.group.id)) {
			// もう見える枠にある。その枠で前に出すだけ（利用者の配置は動かさない）
			await existing.group.openEditor(existing.input, { preserveFocus: true });
			placed.push(existing.group);
			continue;
		}
		const target = nextGroup();
		if (existing !== undefined) {
			existing.group.moveEditor(existing.input, target);
			placed.push(target);
			continue;
		}
		// 起動する。起動はアクティブなグループに開くので、先に並べる先を前にする
		editorGroupsService.activateGroup(target);
		const opened = await instantiationService.invokeFunction(paradisOpenBot, botId);
		if (opened.ok && !target.isEmpty) {
			placed.push(target);
		} else if (target.isEmpty) {
			// 起動できなかった Bot の空の枠を残さない
			editorGroupsService.removeGroup(target);
		}
	}
	// 部屋は入力欄と記録が見える高さに
	editorGroupsService.setSize(room, { width: editorGroupsService.getSize(room).width, height: ROOM_HEIGHT });
	editorGroupsService.activateGroup(room);
	return { elsewhere };
}

/** 部屋の入力欄から、名指しした Bot のペインへ送る（チャット表示の送信と同じ口）。 */
class ParadisBotGroupSender implements IParadisBotGroupSender {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisAgentChatService private readonly chatService: IParadisAgentChatService,
	) { }

	async whereIs(botId: string): Promise<'here' | 'elsewhere' | 'none'> {
		return (await this.instantiationService.invokeFunction(botPaneWhere, botId)).kind;
	}

	async send(botId: string, text: string): Promise<string | undefined> {
		const where = await this.instantiationService.invokeFunction(botPaneWhere, botId);
		if (where.kind === 'none') {
			// allow-any-unicode-next-line
			return localize('paradis.botGroups.notRunning', "起動していません");
		}
		return this.chatService.sendMessageToPane(where.instanceId, text);
	}

}

registerSingleton(IParadisBotGroupSender, ParadisBotGroupSender, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: PARADIS_BOTS_OPEN_GROUP_COMMAND, title: localize2('paradisBots.openGroup', "Open Bot Group"), f1: false });
	}
	async run(accessor: ServicesAccessor, groupId: unknown): Promise<void> {
		if (typeof groupId !== 'string' || accessor.get(IConfigurationService).getValue(PARADIS_BOTS_ENABLED_SETTING) !== true) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		const result = await paradisOpenBotGroup(accessor, groupId);
		if (result === undefined) {
			// allow-any-unicode-next-line
			notificationService.warn(localize('paradis.botGroups.missing', "グループが見つかりませんでした。"));
		}
	}
});
