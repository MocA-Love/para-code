/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 見えていないターミナルの GPU レンダラを外す設定(既定オフ)。動きは paradisHiddenGpuRelease.ts、
// 読むのは xtermTerminal.ts の PARA-PATCH。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_HIDDEN_GPU_RELEASE_DELAY, PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING } from './paradisHiddenGpuRelease.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.terminal.releaseHiddenGpu', "裏のタブや待避中のスペースにあって見えていないターミナルは、{0} 秒たつと描画に使っている GPU のメモリを手放します。見えるようになったときに描き直すので、文字が出るまで一瞬だけ空白になることがあります。", PARADIS_HIDDEN_GPU_RELEASE_DELAY / 1000),
		},
	},
});
