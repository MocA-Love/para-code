/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの本文とタブの右クリックに、Orca に倣った項目を足す（Q592 の案 B と案 T1）。
//
// 本文（`TerminalInstanceContext`）:
// - エージェントの節（選択をエージェントへ送る・コンテキストをコピー・チャット表示で続ける）は、
//   そのターミナルでエージェントが動いているときだけ出す（paradisIsAgentRunningInTerminal）
// - 「ターミナルを下に分割」「ターミナルをリセット」「名前の変更...」「ターミナル ID をコピー」
// タブ（`EditorTitleContext`、ターミナルのタブだけ）:
// - 「ターミナルを分割 >」（右・下）と、タブの色の丸の一列（本家の「色の変更...」と同じ ANSI の 8 色と色なし）
//
// 本家の項目は動かさない。グループ名の比較で入る位置を選ぶ（menuService の compareMenuItems）。
// 本文のメニューの引数は `InstanceContext`（instanceId）、タブのメニューの引数は (resource, IEditorCommandsContext)。
// どちらも右クリックしたターミナルを引数から引く（タブはアクティブとは限らない）。

import './media/paradisTerminalContextMenu.css';
import { addDisposableListener, EventType, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { IEditorCommandsContext, isEditorCommandsContext } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalConfigurationService, ITerminalInstance, ITerminalService, terminalEditorId } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { getCwdForSplit } from '../../../../workbench/contrib/terminal/browser/terminalActions.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisEditorSplitTerminalService } from '../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';
import { paradisHandOffToSpaceAgent, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { PARADIS_AGENT_CHAT_AVAILABLE, PARADIS_AGENT_CHAT_TOGGLE_COMMAND } from '../../agentChat/electron-browser/paradisAgentChat.contribution.js';
import { paradisInteractiveAgentCommand } from '../../mobileRelay/common/paradisAgentCliCommand.js';
import { PARADIS_COPY_TAB_ID_COMMAND_ID } from '../../tabId/electron-browser/paradisTabId.contribution.js';
import { IParadisAgentStatusStore } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisTerminalBufferLine,
	PARADIS_TERMINAL_CONTEXT_LINES,
	PARADIS_TERMINAL_INPUT_MODE_RESET,
	PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID,
	PARADIS_TERMINAL_TAB_COLORS,
	paradisIsAgentRunningInTerminal,
	paradisTerminalBufferTail,
	paradisTerminalTabColorCommandId,
} from '../common/paradisTerminalContextMenu.js';

export const PARADIS_TERMINAL_AGENT_RUNNING = new RawContextKey<boolean>('paradisTerminalAgentRunning', false, localize('paradisTerminalAgentRunning', "アクティブなターミナルでエージェントが動いているかどうか"));

export const PARADIS_TERMINAL_SPLIT_RIGHT_COMMAND_ID = 'paradis.terminal.splitEditorRight';
export const PARADIS_TERMINAL_SPLIT_DOWN_COMMAND_ID = 'paradis.terminal.splitEditorDown';
export const PARADIS_TERMINAL_RESET_COMMAND_ID = 'paradis.terminal.resetInputModes';
export const PARADIS_TERMINAL_COPY_CONTEXT_COMMAND_ID = 'paradis.terminal.copyContext';
export const PARADIS_TERMINAL_SEND_SELECTION_COMMAND_ID = 'paradis.terminal.sendSelectionToAgent';

/** 本文のメニューの、エージェントの節。プロンプト挿入（'0_1_paradisAgentPrompt'）の次、本家の '0_chat' より前。 */
export const PARADIS_TERMINAL_AGENT_MENU_GROUP = '0_2_paradisAgent';
/** 本文のメニューの「名前の変更...」と「ターミナル ID をコピー」。本家の '5_clear' と '7_kill' の間。 */
export const PARADIS_TERMINAL_IDENTITY_MENU_GROUP = '6_paradisTerminal';
/** タブのメニューの「ターミナルを分割 >」。本家の '1_close' より前。 */
export const PARADIS_TERMINAL_TAB_SPLIT_MENU_GROUP = '0_paradisTerminal';
/** タブのメニューの色の丸。本家の '2_files'（「色の変更...」など）の次。 */
export const PARADIS_TERMINAL_TAB_COLOR_MENU_GROUP = '2_paradisTabColor';

export const ParadisTerminalTabSplitSubmenu = new MenuId('paradisTerminalTabSplitSubmenu');
/**
 * タブの色のサブメニュー。HTML のメニューでは menuIcons がこのサブメニューを色の丸の一列に開く
 * （paradisMenuIcons.ts）。ネイティブのメニューは丸を描けないので、色の名前のサブメニューのまま出る。
 */
export const ParadisTerminalTabColorSubmenu = new MenuId(PARADIS_TERMINAL_TAB_COLOR_SUBMENU_ID);

/** エディタの領域のターミナル（パネルのターミナルを右クリックしたときは出さない）。 */
const inTerminalEditor = ContextKeyExpr.and(ActiveEditorContext.isEqualTo(terminalEditorId), TerminalContextKeys.editorFocus);
const isTerminalTab = ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeTerminal);
const processSupported = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.webExtensionContributedProfile);

/**
 * 右クリックしたターミナル。本文のメニューは `InstanceContext`（instanceId）、タブのメニューは
 * ターミナルの URI を渡す。どちらも無ければアクティブなターミナル。
 */
export function paradisTargetInstance(terminalService: ITerminalService, arg: unknown): ITerminalInstance | undefined {
	if (typeof arg === 'object' && arg !== null && typeof (arg as { instanceId?: unknown }).instanceId === 'number') {
		return terminalService.getInstanceFromId((arg as { instanceId: number }).instanceId);
	}
	if (URI.isUri(arg)) {
		return terminalService.getInstanceFromResource(arg);
	}
	return terminalService.activeInstance;
}

/** ターミナルのタブが入っているエディタグループ。タブのメニューから押されたら、そのグループ。 */
function paradisGroupOfInstance(editorGroupsService: IEditorGroupsService, instance: ITerminalInstance, context: IEditorCommandsContext | undefined): IEditorGroup | undefined {
	if (context !== undefined) {
		const group = editorGroupsService.getGroup(context.groupId);
		if (group !== undefined) {
			return group;
		}
	}
	return editorGroupsService.groups.find(group => group.editors.some(editor => editor instanceof TerminalEditorInput && editor.terminalInstance === instance));
}

abstract class ParadisSplitTerminalEditorAction extends Action2 {

	protected abstract readonly direction: GroupDirection;

	override async run(accessor: ServicesAccessor, arg?: unknown, context?: unknown): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const splitTerminalService = accessor.get(IParadisEditorSplitTerminalService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const commandService = accessor.get(ICommandService);
		const terminalConfigurationService = accessor.get(ITerminalConfigurationService);
		const instance = paradisTargetInstance(terminalService, arg);
		if (instance === undefined) {
			return;
		}
		const source = paradisGroupOfInstance(editorGroupsService, instance, isEditorCommandsContext(context) ? context : undefined) ?? editorGroupsService.activeGroup;
		// 本家の「ターミナルの分割」と同じく、`terminal.integrated.splitCwd` に従って元のターミナルの場所で開く
		const cwd = await getCwdForSplit(instance, workspaceContextService.getWorkspace().folders, commandService, terminalConfigurationService);
		if (cwd === undefined) {
			// フォルダの選択を取りやめた
			return;
		}
		const group = editorGroupsService.addGroup(source, this.direction);
		await splitTerminalService.openTerminalInGroup(group, { force: true, ...(cwd !== '' ? { cwd } : {}) });
	}
}

registerAction2(class extends ParadisSplitTerminalEditorAction {
	protected readonly direction = GroupDirection.RIGHT;
	constructor() {
		super({
			id: PARADIS_TERMINAL_SPLIT_RIGHT_COMMAND_ID,
			title: localize2('paradis.terminal.splitEditorRight', "右に分割"),
			icon: Codicon.splitHorizontal,
			f1: false,
			precondition: processSupported,
			menu: { id: ParadisTerminalTabSplitSubmenu, group: '1_split', order: 1 },
		});
	}
});

registerAction2(class extends ParadisSplitTerminalEditorAction {
	protected readonly direction = GroupDirection.DOWN;
	constructor() {
		super({
			id: PARADIS_TERMINAL_SPLIT_DOWN_COMMAND_ID,
			title: localize2('paradis.terminal.splitEditorDown', "ターミナルを下に分割"),
			icon: Codicon.splitVertical,
			f1: false,
			precondition: processSupported,
			menu: [
				// 本家の「ターミナルの分割」（order 1）と「新しいターミナル」（order 2）の間
				{ id: MenuId.TerminalInstanceContext, group: '1_create', order: 1.5, when: inTerminalEditor },
			],
		});
	}
});

// タブのサブメニューの中では「下に分割」と短く出す（同じコマンド）
MenuRegistry.appendMenuItem(ParadisTerminalTabSplitSubmenu, {
	command: { id: PARADIS_TERMINAL_SPLIT_DOWN_COMMAND_ID, title: localize('paradis.terminal.splitEditorDownShort', "下に分割"), icon: Codicon.splitVertical, precondition: processSupported },
	group: '1_split',
	order: 2,
});

MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
	submenu: ParadisTerminalTabSplitSubmenu,
	title: localize('paradis.terminal.tabSplitSubmenu', "ターミナルを分割"),
	icon: Codicon.splitHorizontal,
	group: PARADIS_TERMINAL_TAB_SPLIT_MENU_GROUP,
	order: 1,
	when: isTerminalTab,
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_TERMINAL_RESET_COMMAND_ID,
			title: localize2('paradis.terminal.resetInputModes', "ターミナルをリセット"),
			icon: Codicon.discard,
			f1: true,
			precondition: TerminalContextKeys.isOpen,
			// 本家の「クリア」（'5_clear'、order 0）の下
			menu: { id: MenuId.TerminalInstanceContext, group: '5_clear', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor, arg?: unknown): void {
		// 画面とスクロールバックは残し、アプリが入れたまま終わった入力モード（マウスの報告、ブラケットペーストなど）だけを戻す
		paradisTargetInstance(accessor.get(ITerminalService), arg)?.xterm?.raw.write(PARADIS_TERMINAL_INPUT_MODE_RESET);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_TERMINAL_COPY_CONTEXT_COMMAND_ID,
			title: localize2('paradis.terminal.copyContext', "コンテキストをコピー"),
			icon: Codicon.copy,
			f1: false,
			menu: { id: MenuId.TerminalInstanceContext, group: PARADIS_TERMINAL_AGENT_MENU_GROUP, order: 4, when: PARADIS_TERMINAL_AGENT_RUNNING },
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const text = paradisReadTerminalTail(paradisTargetInstance(accessor.get(ITerminalService), arg), PARADIS_TERMINAL_CONTEXT_LINES);
		if (text.length === 0) {
			notificationService.info(localize('paradis.terminal.copyContextEmpty', "コピーする内容がありません。"));
			return;
		}
		await clipboardService.writeText(text);
		notificationService.info(localize('paradis.terminal.copyContextDone', "ターミナルの最後の {0} 行までをコピーしました。", PARADIS_TERMINAL_CONTEXT_LINES));
	}
});

/** ターミナルの画面とスクロールバックの末尾。 */
export function paradisReadTerminalTail(instance: ITerminalInstance | undefined, maxLines: number): string {
	const buffer = instance?.xterm?.raw.buffer.active;
	if (buffer === undefined) {
		return '';
	}
	const lines: IParadisTerminalBufferLine[] = [];
	// 折り返しの続きをつなぐため、末尾より少し前から読む
	const start = Math.max(0, buffer.length - maxLines * 2);
	for (let index = start; index < buffer.length; index++) {
		const line = buffer.getLine(index);
		if (line !== undefined) {
			lines.push({ text: line.translateToString(true), isWrapped: line.isWrapped });
		}
	}
	return paradisTerminalBufferTail(lines, maxLines);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_TERMINAL_SEND_SELECTION_COMMAND_ID,
			title: localize2('paradis.terminal.sendSelectionToAgent', "選択をエージェントへ送る..."),
			icon: Codicon.send,
			f1: false,
			precondition: TerminalContextKeys.textSelected,
			menu: { id: MenuId.TerminalInstanceContext, group: PARADIS_TERMINAL_AGENT_MENU_GROUP, order: 1, when: PARADIS_TERMINAL_AGENT_RUNNING },
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const services = paradisSpaceAgentHandoffServices(accessor);
		const selection = paradisTargetInstance(services.terminalService, arg)?.selection?.trim();
		if (!selection) {
			return;
		}
		await paradisHandOffToSpaceAgent(services, {
			prompt: selection,
			placeholder: localize('paradis.terminal.sendSelectionPlaceholder', "選択した文を送るエージェントを選んでください"),
		});
	}
});

MenuRegistry.appendMenuItems([
	{
		id: MenuId.TerminalInstanceContext,
		item: {
			// チャット表示の切り替え（⌘⇧J。キーは既存の割り当てがそのまま出る）
			command: { id: PARADIS_AGENT_CHAT_TOGGLE_COMMAND, title: localize('paradis.terminal.continueInChat', "チャット表示で続ける"), icon: Codicon.commentDiscussion, precondition: PARADIS_AGENT_CHAT_AVAILABLE },
			group: PARADIS_TERMINAL_AGENT_MENU_GROUP,
			order: 5,
			when: ContextKeyExpr.and(PARADIS_TERMINAL_AGENT_RUNNING, inTerminalEditor),
		},
	},
	{
		id: MenuId.TerminalInstanceContext,
		item: {
			command: { id: TerminalCommandId.Rename, title: localize('paradis.terminal.rename', "名前の変更..."), icon: Codicon.edit },
			group: PARADIS_TERMINAL_IDENTITY_MENU_GROUP,
			order: 1,
		},
	},
	{
		id: MenuId.TerminalInstanceContext,
		item: {
			// タブの右クリックの「タブ ID をコピー」と同じコマンド（右クリックした時点でそのターミナルのグループがアクティブ）
			command: { id: PARADIS_COPY_TAB_ID_COMMAND_ID, title: localize('paradis.terminal.copyTerminalId', "ターミナル ID をコピー"), icon: Codicon.symbolKey },
			group: PARADIS_TERMINAL_IDENTITY_MENU_GROUP,
			order: 2,
			when: inTerminalEditor,
		},
	},
	{
		id: MenuId.EditorTitleContext,
		item: {
			submenu: ParadisTerminalTabColorSubmenu,
			title: localize('paradis.terminal.tabColorSubmenu', "タブの色"),
			icon: Codicon.symbolColor,
			group: PARADIS_TERMINAL_TAB_COLOR_MENU_GROUP,
			order: 1,
			when: isTerminalTab,
		},
	},
]);

const TAB_COLOR_LABELS: Record<string, string> = {
	black: localize('paradis.terminal.tabColor.black', "黒"),
	red: localize('paradis.terminal.tabColor.red', "赤"),
	green: localize('paradis.terminal.tabColor.green', "緑"),
	yellow: localize('paradis.terminal.tabColor.yellow', "黄"),
	blue: localize('paradis.terminal.tabColor.blue', "青"),
	magenta: localize('paradis.terminal.tabColor.magenta', "マゼンタ"),
	cyan: localize('paradis.terminal.tabColor.cyan', "シアン"),
	white: localize('paradis.terminal.tabColor.white', "白"),
	none: localize('paradis.terminal.tabColor.none', "色なし"),
};

for (const [index, color] of [...PARADIS_TERMINAL_TAB_COLORS, { colorId: undefined, key: 'none' }].entries()) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: paradisTerminalTabColorCommandId(color.key),
				title: { value: TAB_COLOR_LABELS[color.key], original: color.key },
				f1: false,
				menu: { id: ParadisTerminalTabColorSubmenu, group: '1_color', order: index },
			});
		}

		override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
			// 本家の「色の変更...」と同じ値を入れる（保存・復元とパネルのターミナルとの整合は本家のまま）。色なしは本家の「既定に戻す」
			await paradisTargetInstance(accessor.get(ITerminalService), arg)?.changeColor(color.colorId, true);
		}
	});
}

/**
 * {@link PARADIS_TERMINAL_AGENT_RUNNING} を、アクティブなターミナルに合わせて保つ。
 *
 * 本当に効くのはメニューを開く直前の判定。右クリックの `contextmenu` を捕捉の段階で受け、ターミナルが
 * メニューの項目を組み立てる前に決め直す（右クリックの mousedown でそのターミナルがアクティブになった後）。
 * エージェントを `exit` した直後は、コマンドの終わりの知らせの時点ではまだプロンプトが入力待ちになって
 * おらず、hook の実績も残るので、イベントで決めた値だけでは節が出たままになる。
 * イベントでの見直しは、コマンドパレットなど右クリック以外から条件を見る場合のため。
 */
export class ParadisTerminalContextMenuContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalContextMenu';

	private readonly agentRunning: IContextKey<boolean>;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.agentRunning = PARADIS_TERMINAL_AGENT_RUNNING.bindTo(contextKeyService);
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(addDisposableListener(window, EventType.CONTEXT_MENU, () => this.update(), true));
		}, { window: mainWindow, disposables: this._store }));
		this._register(this.terminalService.onDidChangeActiveInstance(() => this.update()));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.update()));
		const executed = this._register(this.terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.onCommandExecuted));
		this._register(executed.event(() => this.update()));
		const promptStarted = this._register(this.terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.promptInputModel.onDidStartInput));
		this._register(promptStarted.event(() => this.update()));
		this.update();
	}

	/** 今のアクティブなターミナルで決め直す。 */
	update(): void {
		const instance = this.terminalService.activeInstance;
		if (instance === undefined) {
			this.agentRunning.set(false);
			return;
		}
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		const executing = commandDetection?.executingCommand;
		const atShellPrompt = commandDetection !== undefined && executing === undefined && commandDetection.promptInputModel.state === PromptInputState.Input;
		this.agentRunning.set(paradisIsAgentRunningInTerminal(
			this.agentStatusStore.isAgentInstance(instance.instanceId),
			atShellPrompt,
			executing !== undefined && paradisInteractiveAgentCommand(executing) !== undefined,
		));
	}
}

registerWorkbenchContribution2(ParadisTerminalContextMenuContribution.ID, ParadisTerminalContextMenuContribution, WorkbenchPhase.AfterRestored);
