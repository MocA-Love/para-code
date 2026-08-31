/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

export function setup(logger: Logger): void {
	describe('Para Code settings', () => {
		installAllHandlers(logger);

		it('opens the standard settings editor filtered to Para settings', async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand('paradis.openSettings');

			const page = app.code.driver.currentPage;
			const editor = page.locator('.settings-editor');
			await editor.waitFor();
			// Settings search is a one-line Monaco editor, not a native <input>.
			const search = editor.locator('.settings-header .search-container .suggest-input-container .monaco-editor');
			await search.waitFor();
			const query = search.locator('.view-lines');
			await query.getByText('@id:paradis.*', { exact: true }).waitFor();
			assert.strictEqual((await query.innerText()).trim(), '@id:paradis.*');

			const settings = editor.locator('.settings-tree-container .setting-item-contents[data-key]');
			await settings.first().waitFor();
			const visibleKeys = await settings.evaluateAll(elements => elements.map(element => element.getAttribute('data-key')));
			assert.ok(visibleKeys.length > 0, 'Para settings filter returned no visible settings');
			assert.ok(visibleKeys.every(key => key?.startsWith('paradis.')), `Para settings filter leaked a foreign key: ${JSON.stringify(visibleKeys)}`);
		});
	});
}
