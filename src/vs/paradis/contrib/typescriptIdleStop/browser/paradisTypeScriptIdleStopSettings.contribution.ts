/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// 読むのは本家の TypeScript 拡張機能に足した fork のファイル
// (extensions/typescript-language-features/src/paradis/paradisTsServerIdleStop.ts)。
// 拡張機能ホストの設定はこのウィンドウの設定から渡るので、SSH 先の拡張機能ホストでも同じ値が読める。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		'paradis.typescript.idleStopMinutes': {
			type: 'number',
			default: 5,
			minimum: 0,
			maximum: 1440,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.typescript.idleStopMinutes', "TypeScript・JavaScript のファイルを 1 つも開いていない状態がこの分数続いたら、TypeScript の言語サーバー (tsserver) を止めてメモリを空けます。ファイルを開くと自動で起動し直します。`0` で止めません。")
		}
	}
});
