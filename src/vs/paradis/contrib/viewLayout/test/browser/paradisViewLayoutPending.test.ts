/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { paradisCountPendingOfInstalledExtensions } from '../../browser/paradisViewLayout.contribution.js';

suite('paradisCountPendingOfInstalledExtensions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts only placements whose extension is installed', () => {
		const owners = new Map([
			['workbench.view.extension.github-actions', 'github.vscode-github-actions'],
			['workbench.view.extension.claude-sidebar-secondary', 'Anthropic.claude-code'],
			['chatgpt.sidebarView', 'openai.chatgpt'],
		]);
		// GitHub Actions だけ入っている（ID の大文字小文字は問わない）
		const installed = [new ExtensionIdentifier('GitHub.vscode-github-actions')];
		assert.deepStrictEqual({
			moves: paradisCountPendingOfInstalledExtensions(['workbench.view.extension.github-actions', 'workbench.view.extension.claude-sidebar-secondary'], owners, installed),
			hides: paradisCountPendingOfInstalledExtensions(['chatgpt.sidebarView'], owners, installed),
			nothingInstalled: paradisCountPendingOfInstalledExtensions(owners.keys(), owners, []),
		}, {
			moves: 1,
			hides: 0,
			nothingInstalled: 0,
		});
	});
});
