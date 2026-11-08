/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBearerToken, paradisResolveSimulatorButton, paradisSimulatorHostRoute } from '../../common/paradisSimulator.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

suite('Paradis simulator: host routes and names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 通すのは映像・ax・config・health と入力の upgrade だけ。シェル・DevTools・診断・grid・録画・認証の交換は通さない
	test('lets only the allowed helper routes through', () => {
		const cases: [string, string, boolean][] = [
			['GET', `/helper/${UDID}/stream.mjpeg`, false],
			['GET', `/helper/${UDID}/stream.avcc?raw=1`, false],
			['GET', `/helper/${UDID}/ax`, false],
			['GET', `/helper/${UDID}/config`, false],
			['GET', `/helper/${UDID}/health`, false],
			['GET', `/helper/${UDID}/ws`, true],
			['GET', `/helper/${UDID}/ws`, false],
			['GET', `/helper/${UDID}/stream.mjpeg`, true],
			['POST', `/helper/${UDID}/config`, false],
			['GET', '/exec', false],
			['POST', '/exec', false],
			['GET', '/exec-ws', true],
			['GET', '/devtools', false],
			['GET', '/devtools-frontend/inspector.html', false],
			['GET', '/api/diagnostics', false],
			['POST', '/grid/api/start', false],
			['POST', '/grid/api/shutdown', false],
			['POST', '/auth', false],
			['GET', `/helper/${UDID}/recording/start`, false],
			['GET', `/helper/${UDID}/camera/status`, false],
			['GET', `/helper/${UDID}/foreground`, false],
			['GET', '/helper/not-a-udid/config', false],
			['GET', `/helper/${UDID}/../exec`, false],
			['GET', `/helper/${UDID}/%2e%2e`, false],
			['GET', `//helper/${UDID}/config`, false],
			['GET', `/helper/${UDID}/config/`, false],
			['GET', `/helper/config?device=${UDID}`, false],
		];
		assert.deepStrictEqual(
			cases.map(([method, url, upgrade]) => paradisSimulatorHostRoute(method, url, upgrade)?.url ?? null),
			[
				`/helper/${UDID}/stream.mjpeg`,
				`/helper/${UDID}/stream.avcc`,
				`/helper/${UDID}/ax`,
				`/helper/${UDID}/config`,
				`/helper/${UDID}/health`,
				`/helper/${UDID}/ws`,
				null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
			],
		);
	});

	test('maps button names and aliases, and refuses unknown ones', () => {
		assert.deepStrictEqual(
			['home', 'Home', 'side_button', 'side-button', 'lock', 'power', 'siri', 'app_switcher', 'appSwitcher', 'volume_up', 'volumeUp', 'volume-down', 'back', ''].map(name => paradisResolveSimulatorButton(name)?.name ?? null),
			['home', 'home', 'side_button', 'side_button', 'lock', 'lock', 'siri', 'app_switcher', 'app_switcher', 'volume_up', 'volume_up', 'volume_down', null, null],
		);
	});

	test('reads a bearer token', () => {
		assert.deepStrictEqual(
			['Bearer abc', 'bearer abc', 'Bearer  abc ', 'Basic abc', 'Bearer', undefined, ['Bearer x', 'Bearer y']].map(paradisBearerToken),
			['abc', 'abc', 'abc', undefined, undefined, undefined, 'x'],
		);
	});
});
