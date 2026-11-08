/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータの作り直し（q.html Q585）の設定。Mobile Canvas を外す PR（⑦）までは既定オフ（D2）。
// 実体は shared process（node/paradisSimulator.sharedProcess.ts）が読む。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_SIMULATOR_ENABLED_SETTING } from '../common/paradisSimulator.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_SIMULATOR_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			// リポジトリの .vscode/settings.json から勝手にオンにされないよう、利用者の設定でだけ変えられる
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			tags: ['experimental'],
			markdownDescription: localize('paradis.simulator.enabled', "（開発中・macOS だけ）作り直し中の iOS シミュレータの仕組み（同梱の serve-sim を使う）を有効にします。今はまだ画面には何も増えず、今のモバイルのサイドバーとエージェントの `mobile_*` の操作はそのまま動きます。"),
		},
	},
});
