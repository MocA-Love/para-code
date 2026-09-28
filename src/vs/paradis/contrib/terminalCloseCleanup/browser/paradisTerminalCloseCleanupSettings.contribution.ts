/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「ターミナルを閉じたときに裏のプロセスを止める」（W2-32）の設定。読むのはウィンドウ側で、
// ターミナルを作るときに env の印として pty ホストへ渡す（`paradisTerminalCloseCleanupEnv.ts`）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_TERMINAL_STOP_BACKGROUND_ON_CLOSE } from '../common/paradisTerminalCloseCleanup.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		[PARADIS_TERMINAL_STOP_BACKGROUND_ON_CLOSE]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.stopBackgroundProcessesOnClose', "ターミナルを閉じたとき、そのターミナルから起動されて裏で動き続けているプロセス（`&` で起動した開発サーバーや、エージェントが裏で起動したものなど）も止めます。`nohup` で起動したもの（SIGHUP を無視しているもの）とその下にあるものは残します。\n\nmacOS と Linux（SSH 先を含む）で働きます。変更は、その後に開いたターミナルから反映されます。"),
		},
	},
});
