/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 下部パネルの共通ターミナル（Q39 案C・Q87 案A）。
//
// スペースへ所属させない・退避しない判定は `paradisTerminalScope.contribution.ts` が持つ
// （スペースの所属台帳と同じ場所で判定しないと、台帳の方から所属が付き直る）。ここでは
// 設定の登録と、新しく開く共通ターミナルの開始フォルダだけを受け持つ。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { paradisRegisterTerminalLaunchPreparer } from '../../workspaceSwitch/common/paradisTerminalLaunchPreparers.js';
import { isParadisManagedWorkspaceWindow } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_TERMINAL_SHARED_PANEL_CWD, PARADIS_TERMINAL_SHARED_PANEL_ENABLED, paradisIsTerminalSharedPanelEnabled, paradisResolveSharedPanelCwd, paradisShouldApplySharedPanelCwd } from '../common/paradisTerminalSharedPanel.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		[PARADIS_TERMINAL_SHARED_PANEL_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.terminal.sharedPanel.enabled', "下部パネルのターミナルを、どのスペースにも属さない共通のターミナルにします。スペースを切り替えても入れ替わらず、スペースを削除しても閉じません。パネルの開閉もスペースごとには切り替わりません。\n\nオフにすると、パネルのターミナルもエディタのタブと同じようにスペースごとに入れ替わります。変更はウィンドウの再読み込み後に反映されます。"),
		},
		[PARADIS_TERMINAL_SHARED_PANEL_CWD]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('paradis.terminal.sharedPanel.cwd', "共通ターミナル（下部パネル）を新しく開くときのフォルダです。空のときはホームフォルダで開きます。`~/` から始めるとホームフォルダからの相対パスになります。SSH で接続しているときは接続先のフォルダとして扱います。"),
		},
	},
});

/**
 * パネルに新しく作るシェルの開始フォルダを、共通ターミナルの設定で決める。
 *
 * 指定しないと upstream はワークスペースのフォルダ（＝今のスペース）で開くので、共通の置き場
 * なのに開いた時点のスペースに引きずられる。スペースを切り替えた後もそのフォルダのまま残り
 * 紛らわしい（Q87 案B で気になる点として挙げたもの）。
 */
class ParadisTerminalSharedPanelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalSharedPanel';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		// 所属の判定側（paradisTerminalScope）と同じく、起動時の値で固定する。途中で切り替えると
		// 「スペースに属しているのにホームで開く」ような食い違いが出るため。
		const enabled = paradisIsTerminalSharedPanelEnabled(this.configurationService.getValue(PARADIS_TERMINAL_SHARED_PANEL_ENABLED));
		if (!enabled) {
			return;
		}
		this._register(paradisRegisterTerminalLaunchPreparer((shellLaunchConfig, target) => this.prepare(shellLaunchConfig, target)));
	}

	private prepare(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
		// スペースを持たないウィンドウ（ふつうにフォルダを開いたウィンドウ）では、パネルのターミナルも
		// upstream どおりそのフォルダで開くのが自然なので触らない。
		if (!isParadisManagedWorkspaceWindow() || !paradisShouldApplySharedPanelCwd(shellLaunchConfig, target)) {
			return;
		}
		// 起動直後でまだ解決していなければ upstream の既定に任せる（同期でしか書き換えられない）。
		const userHome = this.pathService.resolvedUserHome;
		if (userHome === undefined) {
			return;
		}
		shellLaunchConfig.cwd = paradisResolveSharedPanelCwd(this.configurationService.getValue(PARADIS_TERMINAL_SHARED_PANEL_CWD), userHome);
	}
}

registerWorkbenchContribution2(ParadisTerminalSharedPanelContribution.ID, ParadisTerminalSharedPanelContribution, WorkbenchPhase.BlockRestore);
