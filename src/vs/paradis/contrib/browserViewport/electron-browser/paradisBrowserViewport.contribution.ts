/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの「決まった大きさで表示する」機能の入口。paradis.electron-browser.contribution.ts への
// import 1 行だけで全部が有効になる。

import './media/paradisBrowserViewport.css';
import './paradisBrowserViewportChip.js';
import './paradisBrowserViewportMcp.contribution.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_VIEWPORT_DEFAULT_SETTING } from '../common/paradisBrowserViewport.js';
import { IParadisBrowserViewportService, ParadisBrowserViewportService } from './paradisBrowserViewportService.js';

registerSingleton(IParadisBrowserViewportService, ParadisBrowserViewportService, InstantiationType.Delayed);

// セクションは他の Para Code 独自設定と同じ 'paradis' に相乗りする。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_VIEWPORT_DEFAULT_SETTING]: {
			type: 'string',
			default: '',
			// 全体の既定。スペースごとの既定は chip の一覧から付け、WORKSPACE ストレージに置く
			// （workspace 設定に書くと利用者のリポジトリの .vscode を汚すため）。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.browser.viewport.default', "内蔵ブラウザで新しく開いたタブのページの大きさです。保存した大きさの名前（例: `ノート PC`）か `1366x768` の形で書きます。空欄ならエディタの大きさに合わせます。スペースごとの既定は、アドレスバーの大きさの表示から付けられます。"),
		}
	}
});
