/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの右クリックメニューに「エージェントにプロンプトを挿入」を出す（TM23）。
//
// 中身はエージェント向けプロンプト（action: agent-prompt）のプリセット。選ぶと、右クリックした
// ターミナル（右クリックで xterm にフォーカスが移り、アクティブなターミナルになる）で動いている
// エージェントの入力欄へ貼り付けとして入れる。Enter は送らない。
// エージェントが動いていないターミナルや、質問・許可の回答待ちのときは項目を灰色にする。
// パネルとエディタエリアのターミナルは同じ `TerminalInstanceContext` を使うので、どちらでも出る。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentStatusStore } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisPresetService,
	paradisAgentPromptAvailability,
	ParadisAgentPromptAvailability,
	paradisPresetAction,
	paradisPresetQualifiers,
	paradisPresetTooltip,
} from '../common/paradisTerminalPresets.js';

const PARADIS_HAS_AGENT_PROMPT_PRESETS = new RawContextKey<boolean>('paradisTerminalHasAgentPromptPresets', false, localize('paradisTerminalHasAgentPromptPresets', "エージェント向けプロンプトのプリセットがあるかどうか"));
const PARADIS_AGENT_PROMPT_READY = new RawContextKey<boolean>('paradisTerminalAgentPromptReady', false, localize('paradisTerminalAgentPromptReady', "アクティブなターミナルのエージェントへプロンプトを入れられるかどうか"));

const ParadisAgentPromptSubmenu = new MenuId('paradisAgentPromptSubmenu');

/** upstream の TerminalContextMenuGroup.Chat ('0_chat') より前、リンクの項目（'0_0_paradisLink'）の次。 */
const PARADIS_AGENT_PROMPT_MENU_GROUP = '0_1_paradisAgentPrompt';

MenuRegistry.appendMenuItem(MenuId.TerminalInstanceContext, {
	submenu: ParadisAgentPromptSubmenu,
	title: localize('paradis.agentPromptMenu.title', "エージェントにプロンプトを挿入"),
	group: PARADIS_AGENT_PROMPT_MENU_GROUP,
	order: 1,
	when: PARADIS_HAS_AGENT_PROMPT_PRESETS,
});

export class ParadisAgentPromptMenuContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentPromptMenu';

	private readonly _registrations = this._register(new DisposableStore());
	private readonly _hasPresets: IContextKey<boolean>;
	private readonly _ready: IContextKey<boolean>;

	constructor(
		@IParadisPresetService private readonly presetService: IParadisPresetService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._hasPresets = PARADIS_HAS_AGENT_PROMPT_PRESETS.bindTo(contextKeyService);
		this._ready = PARADIS_AGENT_PROMPT_READY.bindTo(contextKeyService);
		const menuScheduler = this._register(new RunOnceScheduler(() => this._updateMenu(), 50));
		this._register(this.presetService.onDidChangePresets(() => menuScheduler.schedule()));
		this._register(this.terminalService.onDidChangeActiveInstance(() => this._updateReady()));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this._updateReady()));
		this._updateMenu();
		this._updateReady();
	}

	private _updateReady(): void {
		const instance = this.terminalService.activeInstance;
		const availability = paradisAgentPromptAvailability(
			instance !== undefined,
			instance !== undefined && this.agentStatusStore.isAgentInstance(instance.instanceId),
			instance !== undefined ? this.agentStatusStore.getInstanceStatus(instance.instanceId) : undefined,
		);
		this._ready.set(availability === ParadisAgentPromptAvailability.Ready);
	}

	private _updateMenu(): void {
		this._registrations.clear();
		const presets = this.presetService.presets.filter(preset => !preset.envInactive && paradisPresetAction(preset) === 'agent-prompt');
		this._hasPresets.set(presets.length > 0);
		const qualifiers = paradisPresetQualifiers(presets);
		for (const preset of presets) {
			const commandId = `paradis.preset.insertAgentPrompt.${preset.key}`;
			this._registrations.add(CommandsRegistry.registerCommand(commandId, async () => {
				try {
					await this.presetService.runPreset(preset);
				} catch (error) {
					this.notificationService.error(toErrorMessage(error));
				}
			}));
			const qualifier = qualifiers.get(preset.key);
			this._registrations.add(MenuRegistry.appendMenuItem(ParadisAgentPromptSubmenu, {
				command: {
					id: commandId,
					title: qualifier ? `${preset.name} (${qualifier})` : preset.name,
					tooltip: paradisPresetTooltip(preset, qualifier),
					precondition: PARADIS_AGENT_PROMPT_READY,
				},
				group: preset.source === 'workspace' ? '1_workspace' : '2_user',
			}));
		}
	}
}
