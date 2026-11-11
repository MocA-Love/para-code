/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBrowserExtensionPermissionLabel } from '../../common/paradisBrowserExtensionPermissionLabels.js';

/** Chrome の公式の権限の一覧（developer.chrome.com/docs/extensions/reference/permissions-list）と、chrome.webRequest の参照にある webRequestAuthProvider。 */
const CHROME_PERMISSIONS = [
	'accessibilityFeatures.modify', 'accessibilityFeatures.read', 'activeTab', 'alarms', 'audio', 'background', 'bookmarks', 'browsingData',
	'certificateProvider', 'clipboardRead', 'clipboardWrite', 'contentSettings', 'contextMenus', 'cookies', 'debugger', 'declarativeContent',
	'declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback', 'dns', 'desktopCapture', 'documentScan',
	'downloads', 'downloads.open', 'downloads.ui', 'enterprise.deviceAttributes', 'enterprise.hardwarePlatform', 'enterprise.networkingAttributes',
	'enterprise.platformKeys', 'favicon', 'fileBrowserHandler', 'fileSystemProvider', 'fontSettings', 'gcm', 'geolocation', 'history', 'identity',
	'identity.email', 'idle', 'loginState', 'management', 'nativeMessaging', 'notifications', 'offscreen', 'pageCapture', 'platformKeys', 'power',
	'printerProvider', 'printing', 'printingMetrics', 'privacy', 'processes', 'proxy', 'publicSuffix', 'readingList', 'runtime', 'scripting', 'search',
	'sessions', 'sidePanel', 'storage', 'system.cpu', 'system.display', 'system.memory', 'system.storage', 'tabCapture', 'tabGroups', 'tabs', 'topSites',
	'tts', 'ttsEngine', 'unlimitedStorage', 'userScripts', 'vpnProvider', 'webAuthenticationProxy', 'webNavigation', 'webRequest', 'webRequestBlocking',
	'webRequestAuthProvider',
];

suite('Para Code browser extension permission labels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every Chrome permission has a label and an unknown name is shown as is', () => {
		assert.deepStrictEqual({
			untranslated: CHROME_PERMISSIONS.filter(permission => paradisBrowserExtensionPermissionLabel(permission) === permission),
			unknown: paradisBrowserExtensionPermissionLabel('someFuturePermission'),
		}, {
			untranslated: [],
			unknown: 'someFuturePermission',
		});
	});
});
