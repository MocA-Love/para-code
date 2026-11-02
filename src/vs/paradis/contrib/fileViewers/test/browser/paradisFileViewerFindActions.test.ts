/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { paradisFileViewerShowFindWhen } from '../../browser/paradisFileViewerFindActions.js';
import { PARADIS_HTML_EDITOR_ID } from '../../browser/paradisFileViewers.js';

suite('paradisFileViewerFindActions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('Cmd+F reaches the HTML viewer even when another webview turned the global find flag off', () => {
		const contextKeyService = store.add(new ContextKeyService(new TestConfigurationService()));
		contextKeyService.createKey('activeEditor', PARADIS_HTML_EDITOR_ID);
		const findFlag = contextKeyService.createKey<boolean>('webviewFindWidgetEnabled', false);
		const evaluate = () => contextKeyService.contextMatchesRules(paradisFileViewerShowFindWhen);
		const withFlagOff = evaluate();
		findFlag.set(true);
		const withFlagOn = evaluate();
		contextKeyService.createKey('editorFocus', true);
		assert.deepStrictEqual({ withFlagOff, withFlagOn, whileRawEditorFocused: evaluate() }, { withFlagOff: true, withFlagOn: true, whileRawEditorFocused: false });
	});
});
