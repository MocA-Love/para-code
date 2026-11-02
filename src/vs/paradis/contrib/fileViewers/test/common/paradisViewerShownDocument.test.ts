/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canReuseParadisShownDocument, IParadisShownDocument } from '../../common/paradisViewerShownDocument.js';

suite('canReuseParadisShownDocument', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses only a confirmed display of the same file, webview and keys', () => {
		const resource = URI.file('/docs/a.pdf');
		const webview = { id: 1 };
		const opened = { bytes: 1 };
		const shown: IParadisShownDocument<object> = { resource, webview, keys: [opened, 'etag-1'], confirmed: true };
		const reuse = (candidate: IParadisShownDocument<object> | undefined, overrides: { resource?: URI; webview?: object | null; keys?: readonly unknown[] } = {}) =>
			canReuseParadisShownDocument(candidate, overrides.resource ?? resource, overrides.webview === null ? undefined : overrides.webview ?? webview, overrides.keys ?? [opened, 'etag-1']);

		deepStrictEqual({
			same: reuse(shown),
			notRecorded: reuse(undefined),
			unconfirmed: reuse({ ...shown, confirmed: false }),
			otherFile: reuse(shown, { resource: URI.file('/docs/b.pdf') }),
			recreatedWebview: reuse(shown, { webview: { id: 1 } }),
			noWebview: reuse(shown, { webview: null }),
			changedEtag: reuse(shown, { keys: [opened, 'etag-2'] }),
			rereadEqualContent: reuse(shown, { keys: [{ bytes: 1 }, 'etag-1'] }),
			fewerKeys: reuse(shown, { keys: [opened] }),
		}, {
			same: true,
			notRecorded: false,
			unconfirmed: false,
			otherFile: false,
			recreatedWebview: false,
			noWebview: false,
			changedEtag: false,
			rereadEqualContent: false,
			fewerKeys: false,
		});
	});
});
