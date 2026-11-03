/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CPU/RAMモニタの表示オン/オフ設定。実体(タイトルバーウィジェット)はElectron専用APIに
// 依存するため electron-browser 側にあるが、設定スキーマ自体はweb/desktop共通で安全なので
// paradis.common.contribution.ts 経由でここだけ先に登録する(windowTransparency と同じ分離)。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_RESOURCE_TITLE_BAR_FORMATS, ParadisResourceTitleBarItem, ParadisResourceTitleBarSizedItem, paradisResourceTitleBarDefault, paradisResourceTitleBarFormatLabel, paradisResourceTitleBarItemLabel } from '../common/paradisResourceTitleBar.js';

function titleBarItemSchema(item: ParadisResourceTitleBarItem): IConfigurationPropertySchema {
	return {
		type: 'boolean',
		default: paradisResourceTitleBarDefault(item),
		scope: ConfigurationScope.APPLICATION,
		description: localize('paradis.resourceMonitor.titleBarItem', "タイトルバーの資源表示に「{0}」を出します。押して開く一覧には、選ばなかった項目も出ます。", paradisResourceTitleBarItemLabel(item)),
	};
}

function titleBarFormatSchema(item: ParadisResourceTitleBarSizedItem): IConfigurationPropertySchema {
	return {
		type: 'string',
		enum: [...PARADIS_RESOURCE_TITLE_BAR_FORMATS],
		enumDescriptions: PARADIS_RESOURCE_TITLE_BAR_FORMATS.map(format => paradisResourceTitleBarFormatLabel(format)),
		default: 'percent',
		scope: ConfigurationScope.APPLICATION,
		description: localize('paradis.resourceMonitor.titleBarFormat', "タイトルバーの資源表示で「{0}」をどう出すか。大きさが分からないときは割合で出します。ホバーには出し方に関わらず詳しい数字が出ます。", paradisResourceTitleBarItemLabel(item)),
	};
}

// セクションは windowTransparency 側と同じ 'paradis' に相乗り(集約セクション)。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.resourceMonitor.enabled': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.resourceMonitor.enabled', "タイトルバーに CPU / メモリ使用率のインジケーターを表示するかどうかを制御します。")
		},
		// タイトルバーの資源表示に出す項目。「設定 (Para Code)」のチェックとタイトルバーの右クリックでも選べる。
		// キーは設定の見張りのテスト（paradisSettingsDialogCoverage.test.ts）が読めるよう、文字で書く。
		'paradis.resourceMonitor.titleBar.cpu': titleBarItemSchema('cpu'),
		'paradis.resourceMonitor.titleBar.memory': titleBarItemSchema('memory'),
		'paradis.resourceMonitor.titleBar.disk': titleBarItemSchema('disk'),
		'paradis.resourceMonitor.titleBar.swap': titleBarItemSchema('swap'),
		'paradis.resourceMonitor.titleBar.diskIo': titleBarItemSchema('diskIo'),
		'paradis.resourceMonitor.titleBar.network': titleBarItemSchema('network'),
		'paradis.resourceMonitor.titleBar.machineName': titleBarItemSchema('machineName'),
		// 出し方（割合・使用量 / 全体・使用量・空き）。全体の大きさがあるメモリ・ディスク・スワップだけ
		'paradis.resourceMonitor.titleBar.memoryFormat': titleBarFormatSchema('memory'),
		'paradis.resourceMonitor.titleBar.diskFormat': titleBarFormatSchema('disk'),
		'paradis.resourceMonitor.titleBar.swapFormat': titleBarFormatSchema('swap'),
	}
});
