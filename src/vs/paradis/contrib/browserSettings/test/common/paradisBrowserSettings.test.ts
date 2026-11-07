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

	test('accepts only http and https home pages, adding http for local hosts and https otherwise when the scheme is left out', () => {
		assert.deepStrictEqual(
			['https://example.com/start', '  example.com ', 'localhost:3000', '127.0.0.1:8080/app', 'http://localhost:3000', 'file:///etc/passwd', 'javascript:alert(1)', 'README.md', '', 42].map(paradisNormalizeHomePage),
			['https://example.com/start', 'https://example.com/', 'http://localhost:3000/', 'http://127.0.0.1:8080/app', 'http://localhost:3000/', undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('makes one row per profile and site, merging tabs of the same profile', () => {
		const rows = paradisCollectSitePermissions([
			{ id: 'a', profileKey: 'global', profileLabel: 'Global', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Microphone, state: 'allow' }, { origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'allow' }] },
			{ id: 'b', profileKey: 'global', profileLabel: 'Global', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'allow' }, { origin: 'https://meet.example.com', category: PermissionCategory.Microphone, state: 'allow' }, { origin: 'https://news.example.com', category: PermissionCategory.Notifications, state: 'deny' }] },
			{ id: 'c', profileKey: 'profile:prd', profileLabel: 'PRD', grants: [{ origin: 'https://meet.example.com', category: PermissionCategory.Camera, state: 'deny' }] },
		]);
		assert.deepStrictEqual(rows.map(row => [row.origin, row.profileLabel, row.decisions.map(d => `${d.category}=${d.state}`).join(','), row.viewIds.join(',')]), [
			['https://meet.example.com', 'Global', 'camera=allow,microphone=allow', 'a,b'],
			['https://meet.example.com', 'PRD', 'camera=deny', 'c'],
			['https://news.example.com', 'Global', 'notifications=deny', 'b'],
		]);
	});
});
