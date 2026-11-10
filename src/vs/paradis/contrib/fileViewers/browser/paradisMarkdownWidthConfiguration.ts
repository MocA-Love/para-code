/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの本文の幅の既定の設定（設定エディタと「設定 (Para Code)」の「ファイルビューア」に出る）。
// paradisMarkdownViewer.contribution.ts から import される。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_MARKDOWN_DEFAULT_WIDTH, PARADIS_MARKDOWN_WIDTH_SETTING, PARADIS_MARKDOWN_WIDTHS } from '../common/paradisMarkdownWidth.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_MARKDOWN_WIDTH_SETTING]: {
			type: 'string',
			enum: [...PARADIS_MARKDOWN_WIDTHS],
			enumDescriptions: [
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.width.readable', "読みやすい幅（882px）。本家の Markdown プレビューと同じ幅です。"),
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.width.wide', "広い（1280px）。表やコードが折れにくくなります。"),
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.width.full', "全幅（窓いっぱい）。"),
			],
			default: PARADIS_MARKDOWN_DEFAULT_WIDTH,
			scope: ConfigurationScope.WINDOW,
			// allow-any-unicode-next-line
			description: localize('paradis.markdownViewer.width', "Markdown のプレビューで本文を広げる幅の既定です。上の帯の「読みやすい | 広い | 全幅」で替えた幅は、ファイルごとに覚えて次もその幅で開きます。"),
		},
	},
});
