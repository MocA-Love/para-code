/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldInlineParadisSentryImport } from '../paradisSentryBundling.ts';

describe('Para Code Sentry bundling contract', () => {
	it('inlines static SDK dependencies and the asynchronous renderer entry', () => {
		assert.strictEqual(shouldInlineParadisSentryImport('@sentry/browser', 'import-statement'), true);
		assert.strictEqual(shouldInlineParadisSentryImport('@sentry/electron/renderer', 'dynamic-import'), true);
	});

	it('keeps Node-capable process SDKs external for node_modules.asar resolution', () => {
		assert.strictEqual(shouldInlineParadisSentryImport('@sentry/electron/main', 'dynamic-import'), false);
		assert.strictEqual(shouldInlineParadisSentryImport('@sentry/electron/utility', 'dynamic-import'), false);
	});
});
