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
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { PARADIS_TERMINAL_SHARED_PANEL_CWD, PARADIS_TERMINAL_SHARED_PANEL_ENABLED, paradisResolveSharedPanelCwd, paradisSharedPanelEnabledAtStartup, paradisShouldApplySharedPanelCwd } from '../common/paradisTerminalSharedPanel.js';

/** upstream の開始フォルダの設定。 */
const UPSTREAM_TERMINAL_CWD = 'terminal.integrated.cwd';

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
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.terminal.sharedPanel.cwd', "共通ターミナル（下部パネル）を新しく開くときのフォルダです。空のときはホームフォルダで開きます（`#terminal.integrated.cwd#` を設定していればそちらに従います）。`~/` から始めるとホームフォルダからの相対パスになります。フォルダが無いときはホームフォルダで開きます。\n\nSSH で接続しているウィンドウでは、同じ値を接続先のフォルダとして扱います（`~/` から始めておくと、手元と接続先のどちらでもそれぞれのホームを基準にできます）。"),
		},
	},
});

/** 新しく開く共通ターミナルのフォルダの決め方。 */
type ParadisSharedPanelCwdDecision =
	/** このフォルダで開く（存在を確かめたもの。無ければホーム）。 */
	| { readonly kind: 'folder'; readonly uri: URI }
	/** upstream の `terminal.integrated.cwd` に任せる。 */
	| { readonly kind: 'upstream' };

/**
 * パネルに新しく作るシェルの開始フォルダを、共通ターミナルの設定で決める。
 *
 * 指定しないと upstream はワークスペースのフォルダ（＝今のスペース）で開くので、共通の置き場
 * なのに開いた時点のスペースに引きずられる。スペースを切り替えた後もそのフォルダのまま残り
 * 紛らわしい。
 *
 * - 設定が空で、ユーザーが upstream の `terminal.integrated.cwd` を決めていればそちらに従う
 * - 設定したフォルダが無ければホームで開く。存在しないフォルダを渡すと、それ以降のパネルの
 *   ターミナルがすべて起動に失敗するため。確かめるのは非同期なので、設定を読んだ時点で
 *   先に確かめておき、ターミナルを作るときは結果だけを使う
 */
class ParadisTerminalSharedPanelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalSharedPanel';

	private _decision: ParadisSharedPanelCwdDecision | undefined;
	private _refreshSequence = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IFileService private readonly fileService: IFileService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// 所属の判定側（paradisTerminalScope）と同じ、ウィンドウの起動時の値を使う。
		if (!paradisSharedPanelEnabledAtStartup(this.configurationService)) {
			return;
		}
		this._register(paradisRegisterTerminalLaunchPreparer((shellLaunchConfig, target) => this.prepare(shellLaunchConfig, target)));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_TERMINAL_SHARED_PANEL_CWD) || event.affectsConfiguration(UPSTREAM_TERMINAL_CWD)) {
				void this.refreshDecision();
			}
		}));
		void this.refreshDecision();
	}

	private async refreshDecision(): Promise<void> {
		const sequence = ++this._refreshSequence;
		const configured = this.configurationService.getValue<unknown>(PARADIS_TERMINAL_SHARED_PANEL_CWD);
		const upstreamCwd = this.configurationService.getValue<unknown>(UPSTREAM_TERMINAL_CWD);
		if ((typeof configured !== 'string' || configured.trim().length === 0) && typeof upstreamCwd === 'string' && upstreamCwd.trim().length > 0) {
			this._decision = { kind: 'upstream' };
			return;
		}
		let home: URI;
		try {
			home = await this.pathService.userHome();
		} catch (error) {
			this.logService.warn('[paradisTerminalSharedPanel] could not resolve the home folder', error);
			return;
		}
		const resolved = paradisResolveSharedPanelCwd(configured, home);
		let uri = resolved;
		if (resolved.toString() !== home.toString()) {
			const isFolder = await this.fileService.stat(resolved).then(stat => stat.isDirectory, () => false);
			if (!isFolder) {
				this.logService.warn(`[paradisTerminalSharedPanel] the configured start folder does not exist; opening the shared terminal in the home folder instead (${resolved.toString()})`);
				uri = home;
			}
		}
		if (sequence === this._refreshSequence) {
			this._decision = { kind: 'folder', uri };
		}
	}

	private prepare(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
		// スペースを持たないウィンドウ（ふつうにフォルダを開いたウィンドウ）では、パネルのターミナルも
		// upstream どおりそのフォルダで開くのが自然なので触らない。
		if (!this.workspaceSwitchService.isManagedWorkspaceWindow || !paradisShouldApplySharedPanelCwd(shellLaunchConfig, target)) {
			return;
		}
		const decision = this._decision;
		if (decision?.kind === 'upstream') {
			return;
		}
		// 確かめ終わる前（起動直後）はホームで開く。ホームは必ずある。
		const cwd = decision?.uri ?? this.pathService.resolvedUserHome;
		if (cwd !== undefined) {
			shellLaunchConfig.cwd = cwd;
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalSharedPanelContribution.ID, ParadisTerminalSharedPanelContribution, WorkbenchPhase.BlockRestore);
