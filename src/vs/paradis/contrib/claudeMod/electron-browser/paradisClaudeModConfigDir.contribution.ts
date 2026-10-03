/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer の Claude Code の mod の準備（paradisClaudeModEnvironment.ts、browser 層）へ、shared process が読んでいる
// Claude Code の設定フォルダ（`CLAUDE_CONFIG_DIR`）を教える。そこの `remote-settings.json`（組織の方針の控え）も
// 確かめるため。browser 層からは shared process へ話せないので、ここで口を入れる。

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisSetClaudeConfigDirProvider } from '../common/paradisClaudeMod.js';

class ParadisClaudeModConfigDirContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.claudeModConfigDir';

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super();
		let cached: Promise<string | undefined> | undefined;
		paradisSetClaudeConfigDirProvider(() => {
			cached ??= sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<string>('getClaudeConfigDir').then(
				directory => typeof directory === 'string' && directory.length > 0 ? directory : undefined,
				() => {
					cached = undefined;
					return undefined;
				},
			);
			return cached;
		});
		this._register(toDisposable(() => paradisSetClaudeConfigDirProvider(undefined)));
	}
}

// BlockStartup: 起動直後に開くターミナルより前に口を入れておくため（入る前の managed 設定の確かめは ~/.claude だけを見る）。
// 中身は口を入れるだけで、shared process への問い合わせは最初に使われたときに 1 回だけなので、起動を遅らせない。
registerWorkbenchContribution2(ParadisClaudeModConfigDirContribution.ID, ParadisClaudeModConfigDirContribution, WorkbenchPhase.BlockStartup);
