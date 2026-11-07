/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PermissionCategory } from '../../../../../platform/browserView/common/browserPermissions.js';
import { paradisNormalizeHomePage } from '../../common/paradisBrowserSettings.js';
import { paradisCollectSitePermissions } from '../../common/paradisBrowserSitePermissions.js';

suite('ParadisBrowserSettings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only http and https home pages, adding https when the scheme is left out', () => {
		assert.deepStrictEqual(
			['https://example.com/start', '  example.com ', 'http://localhost:3000', 'file:///etc/passwd', 'javascript:alert(1)', '', 42].map(paradisNormalizeHomePage),
			['https://example.com/start', 'https://example.com/', 'http://localhost:3000/', undefined, undefined, undefined, undefined],
		);
	});

	test('groups recorded permissions by site and keeps different decisions of other profiles apart', () => {
		const rows = paradisCollectSitePermissions([
			{ id: 'a', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Microphone, state: 'allow' }, { origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'allow' }] },
			{ id: 'b', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'allow' }, { origin: 'https://meet.example.com', category: PermissionCategory.Microphone, state: 'allow' }, { origin: 'https://news.example.com', category: PermissionCategory.Notifications, state: 'deny' }] },
			{ id: 'c', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'deny' }] },
		]);
		assert.deepStrictEqual(rows.map(row => [row.origin, row.decisions.map(d => `${d.category}=${d.state}`).join(','), row.viewIds.join(',')]), [
			['https://meet.example.com', 'camera=allow,microphone=allow', 'a,b'],
			['https://meet.example.com', 'camera=deny', 'c'],
			['https://news.example.com', 'notifications=deny', 'b'],
		]);
	});
});
