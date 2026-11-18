/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown の差分を開いたときの表示（プレビュー差分・テキスト差分・前回のまま）の設定。設定エディタと
// 「設定 (Para Code)」の「ファイルビューア」に出る。paradisMarkdownViewer.contribution.ts から import される。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_MARKDOWN_DIFF_VIEW_SETTING, PARADIS_MARKDOWN_DIFF_VIEW_SETTINGS } from './paradisMarkdownRenderedDiffView.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_MARKDOWN_DIFF_VIEW_SETTING]: {
			type: 'string',
			enum: [...PARADIS_MARKDOWN_DIFF_VIEW_SETTINGS],
			enumDescriptions: [
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.diffView.rendered', "プレビュー差分（描いた見た目で比べ、変わったブロックと語に色を付ける）。"),
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.diffView.text', "テキスト差分（Markdown の記法のまま行で比べる）。"),
				// allow-any-unicode-next-line
				localize('paradis.markdownViewer.diffView.remember', "前回、上の帯で選んだ表示。"),
			],
			default: 'rendered',
			scope: ConfigurationScope.WINDOW,
			// allow-any-unicode-next-line
			description: localize('paradis.markdownViewer.diffView', "Markdown の差分を開いたときの表示です。差分の上の帯の「テキスト差分 | プレビュー差分」でいつでも切り替えられます。"),
		},
	},
});
