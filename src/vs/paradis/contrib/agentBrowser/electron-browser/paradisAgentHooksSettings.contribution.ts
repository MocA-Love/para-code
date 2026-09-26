/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// hook の自動設置の ON/OFF 設定と、オフにしたときの警告。
//
// 取り外しそのものは shared process（手元の ~/.claude・~/.codex）と、SSH で繋いでいるウィンドウ
// （接続先）がそれぞれ設定の変化を見て行う。ここは「何が起きるか・何が弱くなるか」を伝えるだけ。
// 取り外しは別のプロセスで後から走るので、結果を待たずに「取り外します」と予告する。
//
// electron-browser に置く。取り外す側（shared process と SSH 接続先向けの処理）がデスクトップにしか
// 無いため、Web ビルドでこの設定を出すと、オフにしても何も外れないのに外すと告げることになる。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, paradisAgentHooksEnabled } from '../common/paradisAgentHooks.js';
import { paradisIsSettingsDialogOpen } from '../../paradisSettings/common/paradisSettingsDialogState.js';

// 他の Para Code 設定と同じ id/title にして、設定 UI では1つの「Para Code」セクションにまとめる。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_AGENT_HOOKS_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			// hook の設定ファイルは PC（接続先）全体で1つなので、ワークスペースごとに変えられても意味が無い
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentHooks.enabled', "Claude Code と Codex へ、Para Code がエージェントの状態を受け取るための hook を自動で設置します（`~/.claude/settings.json` と `~/.codex/hooks.json`。SSH で接続中は接続先にも）。\n\nオフにすると、その時点で Para Code が設置した hook だけを取り外し、オフの間は設置し直しません。あなた自身が書いた hook は触りません。起動した時点でオフの場合は、取り外しもしません（同じ PC の別の Para Code が使っている hook を壊さないため）。\n\nオフの間は、エージェントの状態表示（実行中・許可待ち・完了）、完了や許可待ちの通知、モバイルへの通知とチャットの表示、音声での読み上げが弱くなるか、働かなくなります。"),
		}
	}
});

/**
 * オフに切り替わったとき、何が弱くなるかを知らせる。元に戻す操作も添える。
 *
 * 設定の変化はすべてのウィンドウに届くので、**フォーカスのあるウィンドウだけ**が出す
 * （設定を変えた本人が見ているウィンドウ）。
 *
 * 「設定 (Para Code)」ダイアログの中で切り替えたときは通知を出さない。通知はダイアログの背景より
 * 下の層に出るので、裏に隠れて「元に戻す」が押せない。その場合はダイアログの行の中に同じ内容を
 * 出す（paradisSettingsDialog.ts の `offWarning`）。通知は設定エディタや settings.json から
 * 変えたときだけ出る。
 */
class ParadisAgentHooksSettingWarning extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.agentHooksSettingWarning';

	private enabled: boolean;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this.enabled = this.readEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(PARADIS_AGENT_HOOKS_ENABLED_SETTING)) {
				return;
			}
			const wasEnabled = this.enabled;
			this.enabled = this.readEnabled();
			if (wasEnabled && !this.enabled && this.hostService.hasFocus && !paradisIsSettingsDialogOpen()) {
				this.warnTurnedOff();
			}
		}));
	}

	private readEnabled(): boolean {
		return paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING));
	}

	private warnTurnedOff(): void {
		this.notificationService.prompt(
			Severity.Warning,
			// allow-any-unicode-next-line
			localize('paradis.agentHooks.turnedOff', "Claude Code と Codex から、Para Code が設置した hook を取り外します。エージェントの状態表示、完了・許可待ちの通知、モバイルへの通知、読み上げが弱くなります。あなた自身の hook はそのままです。"),
			[{
				// allow-any-unicode-next-line
				label: localize('paradis.agentHooks.turnBackOn', "元に戻す"),
				run: () => this.configurationService.updateValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING, true, ConfigurationTarget.USER),
			}],
		);
	}
}

registerWorkbenchContribution2(ParadisAgentHooksSettingWarning.ID, ParadisAgentHooksSettingWarning, WorkbenchPhase.AfterRestored);
