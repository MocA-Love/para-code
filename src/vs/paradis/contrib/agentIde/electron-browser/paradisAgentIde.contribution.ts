/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// IDE 操作ツール（O1）のウィンドウ側の登録。
//  - 設定 `paradis.agentIde.*` のスキーマ
//  - shared process の MCP サーバーから呼ばれるチャネル（paradisAgentIdeChannel.ts）

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_CHANNEL,
} from '../common/paradisAgentIde.js';
import { ParadisAgentIdeChannel } from './paradisAgentIdeChannel.js';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING]: {
			type: 'boolean',
			default: false,
			// リポジトリの .vscode/settings.json から勝手にオンにされないよう、利用者の設定でだけ変えられる
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentIde.allowActions', "Para Code の MCP ツールを使って、エージェントが他のターミナルへ入力を送る・Claude Code や Codex を起動する・スペース（worktree）を作る・自分で作ったターミナルを閉じることを許可します。\n\nオフの間も、ターミナルやスペースの一覧、画面の読み取り、終わるまで待つことはできます。\n\nオンにすると、Web ページなどに仕込まれた指示を読んだエージェントが、それを別のエージェントへ伝えてしまう危険があります。許可待ち・質問中のターミナルへは送りません。"),
		},
		[PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING]: {
			type: 'string',
			enum: ['space', 'window'],
			default: 'space',
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			enumDescriptions: [
				// allow-any-unicode-next-line
				localize('paradis.agentIde.actionScope.space', "同じスペースのターミナルだけ。エージェント自身が作ったターミナルとスペースには、スペースが違っても送れます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentIde.actionScope.window', "同じウィンドウのすべてのターミナル。別のウィンドウへは送れません。"),
			],
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentIde.actionScope', "エージェントが入力を送れる範囲です。`#paradis.agentIde.allowActions#` がオンのときだけ使われます。"),
		},
	}
});

/** MCP サーバー（shared process）から呼ばれるチャネルを、このウィンドウの分だけ登録する。 */
class ParadisAgentIdeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentIde';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_IDE_CHANNEL, instantiationService.createInstance(ParadisAgentIdeChannel));
	}
}

registerWorkbenchContribution2(ParadisAgentIdeContribution.ID, ParadisAgentIdeContribution, WorkbenchPhase.AfterRestored);
