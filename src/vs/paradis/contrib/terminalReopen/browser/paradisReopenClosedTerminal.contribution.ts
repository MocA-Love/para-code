/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 閉じたエディタエリアのターミナルを ⌘⇧T で戻す（Q45 A / TM4）。
//
// upstream の「閉じたエディタを開き直す」（workbench.action.reopenClosedEditor、⌘⇧T）は
// ターミナルのタブを履歴に入れない（TerminalEditorInput.canReopen() が false）ので、ターミナルを閉じた
// 直後に ⌘⇧T を押すと、その前に閉じたファイルが開くか何も起きない。ここでは ⌘⇧T を
// 「最後に閉じたものがターミナルならターミナルを、そうでなければ upstream の開き直し」に差し替える。
//
// - 中のプロセスは戻らない。閉じた時点のフォルダで新しいシェルを開く（Q45 A）。
// - 閉じたタブがあったエディタグループへ、同じタブ位置で戻す。グループごと消えていたら、
//   隣のグループの同じ側にグループを作り直す（グリッド上の位置をできるだけ戻す）。
// - スペース（workspaceSwitch）ごとに履歴を分け、スペースを削除したら捨てる。スペース切り替えで
//   タブが入れ替わる間の「閉じる」は記録しない（ターミナルは退避されているだけで閉じていない）。
// - 各スペースで覚えるのは 10 件まで。

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ReopenClosedEditorAction } from '../../../../workbench/browser/parts/editor/editorActions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { EditorCloseContext, IEditorCloseEvent } from '../../../../workbench/common/editor.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisClosedTerminal, paradisPlanReopen, ParadisClosedTerminalHistory } from './paradisClosedTerminalHistory.js';

export const PARADIS_REOPEN_CLOSED_EDITOR_OR_TERMINAL_COMMAND_ID = 'paradis.editor.reopenClosedEditorOrTerminal';

// ターミナルにフォーカスがあっても ⌘⇧T をシェルへ送らない（upstream の既定リストへ起動時に追記するだけ）
if (!DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(PARADIS_REOPEN_CLOSED_EDITOR_OR_TERMINAL_COMMAND_ID)) {
	DEFAULT_COMMANDS_TO_SKIP_SHELL.push(PARADIS_REOPEN_CLOSED_EDITOR_OR_TERMINAL_COMMAND_ID);
}

/**
 * 閉じたグループをグリッドのどこに作り直すか。左→上→右→下の順に隣のグループを探し、
 * 見つかった隣のグループから見て、閉じたグループがあった側を返す。
 */
const NEIGHBOR_LOOKUPS: readonly { readonly find: GroupDirection; readonly recreate: GroupDirection }[] = [
	{ find: GroupDirection.LEFT, recreate: GroupDirection.RIGHT },
	{ find: GroupDirection.UP, recreate: GroupDirection.DOWN },
	{ find: GroupDirection.RIGHT, recreate: GroupDirection.LEFT },
	{ find: GroupDirection.DOWN, recreate: GroupDirection.UP },
];

const IParadisClosedTerminalService = createDecorator<IParadisClosedTerminalService>('paradisClosedTerminalService');

interface IParadisClosedTerminalService {
	readonly _serviceBrand: undefined;
	/** 最後に閉じたものを開き直す。ターミナルでなければ upstream の開き直しに任せる。 */
	reopenLastClosed(): Promise<void>;
}

class ParadisClosedTerminalService extends Disposable implements IParadisClosedTerminalService {
	declare readonly _serviceBrand: undefined;

	private readonly _history = new ParadisClosedTerminalHistory();

	constructor(
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IParadisWorkspaceSwitchService private readonly _workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(editorService.onDidCloseEditor(event => this._onDidCloseEditor(event)));
		this._register(this._workspaceSwitchService.onDidRetireScope(stateKey => this._history.clearScope(stateKey)));
	}

	private get _scope(): string {
		return this._workspaceSwitchService.activeStateKey ?? '';
	}

	private _onDidCloseEditor(event: IEditorCloseEvent): void {
		const { editor, context } = event;
		if (context === EditorCloseContext.REPLACE || context === EditorCloseContext.MOVE) {
			return;
		}
		// 終了中と、スペース切り替えでタブが入れ替わっている間の「閉じる」は数えない
		if (this._lifecycleService.willShutdown || this._workspaceSwitchService.isSwitching || this._workspaceSwitchService.pendingSwitchTargetKey !== undefined) {
			return;
		}
		if (editor instanceof TerminalEditorInput) {
			// パネルへ移したターミナルは input から切り離されている（terminalInstance が undefined）
			const instance = editor.terminalInstance;
			if (instance && isReopenableTerminal(instance)) {
				this._history.recordTerminal(this._scope, this._snapshot(instance, event));
			}
			return;
		}
		// upstream の閉じたエディタ履歴と同じ条件（historyService.handleEditorCloseEventInReopen）
		if (editor.canReopen() && editor.toUntyped()) {
			this._history.recordEditor(this._scope);
		}
	}

	private _snapshot(instance: ITerminalInstance, event: IEditorCloseEvent): IParadisClosedTerminal {
		const group = this._editorGroupsService.getGroup(event.groupId);
		let neighbor: IParadisClosedTerminal['neighbor'];
		// 最後のタブだったら、このあとグループごと消える（workbench.editor.closeEmptyGroups）
		if (group && group.count === 0) {
			const part = this._editorGroupsService.getPart(group);
			for (const lookup of NEIGHBOR_LOOKUPS) {
				const found = part.findGroup({ direction: lookup.find }, group);
				if (found && found !== group) {
					neighbor = { groupId: found.id, direction: lookup.recreate };
					break;
				}
			}
		}
		return {
			cwd: instance.cwd || instance.initialCwd || undefined,
			groupId: event.groupId,
			index: event.index,
			neighbor,
		};
	}

	async reopenLastClosed(): Promise<void> {
		const scope = this._scope;
		for (; ;) {
			const batch = this._history.takeLastBatch(scope);
			if (!batch.length) {
				await this._reopenClosedEditor();
				return;
			}
			const plan = paradisPlanReopen(batch, this._canReopenClosedEditor());
			if (!plan) {
				continue;
			}
			if (plan.reopenEditors) {
				await this._reopenClosedEditor();
			}
			for (const terminal of plan.terminals) {
				await this._reopenTerminal(terminal);
			}
			return;
		}
	}

	private _canReopenClosedEditor(): boolean {
		return this._contextKeyService.getContextKeyValue<boolean>('canReopenClosedEditor') === true;
	}

	private async _reopenClosedEditor(): Promise<void> {
		await this._commandService.executeCommand(ReopenClosedEditorAction.ID);
	}

	private async _reopenTerminal(closed: IParadisClosedTerminal): Promise<void> {
		const group = this._resolveGroup(closed);
		try {
			const instance = await this._terminalService.createTerminal({
				location: { viewColumn: group.id },
				paradisExactEditorGroup: group,
				cwd: closed.cwd,
				// 拡張の既定プロファイルは editor group を番号でしか受け取れないので、組み込みのシェルで開く
				skipContributedProfileCheck: true,
			});
			const input = group.editors.find(editor => editor instanceof TerminalEditorInput && editor.terminalInstance === instance);
			if (input && closed.index < group.count && group.getIndexOfEditor(input) !== closed.index) {
				group.moveEditor(input, group, { index: closed.index });
			}
			await this._terminalService.focusInstance(instance);
		} catch (error) {
			this._logService.warn('[paradis] could not reopen the closed terminal', error);
		}
	}

	private _resolveGroup(closed: IParadisClosedTerminal): IEditorGroup {
		const original = this._editorGroupsService.getGroup(closed.groupId);
		if (original) {
			return original;
		}
		const neighbor = closed.neighbor && this._editorGroupsService.getGroup(closed.neighbor.groupId);
		if (neighbor && closed.neighbor) {
			return this._editorGroupsService.getPart(neighbor).addGroup(neighbor, closed.neighbor.direction);
		}
		return this._editorGroupsService.activeGroup;
	}
}

/** 開き直す対象は、ユーザーが使うシェルのターミナルだけ（タスクや拡張の疑似ターミナルは除く）。 */
function isReopenableTerminal(instance: ITerminalInstance): boolean {
	const config = instance.shellLaunchConfig;
	return !config.customPtyImplementation && !config.isFeatureTerminal && !config.hideFromUser && config.type !== 'Task';
}

registerSingleton(IParadisClosedTerminalService, ParadisClosedTerminalService, InstantiationType.Eager);

/** 起動時に履歴の記録を始める（サービスを作るだけ）。 */
class ParadisClosedTerminalTrackingContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.terminalReopen.tracking';

	constructor(@IParadisClosedTerminalService _service: IParadisClosedTerminalService) { }
}

registerWorkbenchContribution2(ParadisClosedTerminalTrackingContribution.ID, ParadisClosedTerminalTrackingContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_REOPEN_CLOSED_EDITOR_OR_TERMINAL_COMMAND_ID,
			title: localize2('paradis.editor.reopenClosedEditorOrTerminal', "閉じたエディタまたはターミナルを開き直す"),
			f1: true,
			keybinding: {
				// upstream の「閉じたエディタを開き直す」と同じキー。1つ上の weight で先に受け、
				// ターミナル以外なら upstream のコマンドへそのまま渡す
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyT,
				when: IsSessionsWindowContext.negate(),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IParadisClosedTerminalService).reopenLastClosed();
	}
});
