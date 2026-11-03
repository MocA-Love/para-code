/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { paradisCanUseWindowTransparency, paradisShouldCreateTransparentWindow, paradisWindowTransparencyDefault } from '../../common/paradisWindowTransparency.js';

suite('paradisCanUseWindowTransparency', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is unavailable only on Windows with the native title bar', () => {
		const native = new TestConfigurationService({ window: { titleBarStyle: 'native' } });
		const custom = new TestConfigurationService({ window: { titleBarStyle: 'custom' } });
		assert.deepStrictEqual({
			windowsNative: paradisCanUseWindowTransparency(native, true),
			windowsCustom: paradisCanUseWindowTransparency(custom, true),
			otherNative: paradisCanUseWindowTransparency(native, false),
		}, { windowsNative: false, windowsCustom: true, otherNative: true });
	});

	test('defaults to off only on Windows', () => {
		assert.deepStrictEqual({
			windows: paradisWindowTransparencyDefault(true),
			other: paradisWindowTransparencyDefault(false),
		}, { windows: false, other: true });
	});

	test('creates a transparent window only when the setting and the title bar allow it', () => {
		const config = (enabled: boolean | undefined, titleBarStyle: 'native' | 'custom') => new TestConfigurationService({
			window: { titleBarStyle },
			paradis: { window: { transparency: enabled === undefined ? {} : { enabled } } },
		});
		const row = (windows: boolean) => ({
			unset: paradisShouldCreateTransparentWindow(config(undefined, 'custom'), windows),
			enabled: paradisShouldCreateTransparentWindow(config(true, 'custom'), windows),
			disabled: paradisShouldCreateTransparentWindow(config(false, 'custom'), windows),
			unsetNative: paradisShouldCreateTransparentWindow(config(undefined, 'native'), windows),
			enabledNative: paradisShouldCreateTransparentWindow(config(true, 'native'), windows),
		});
		// macOS and Linux take the same (non-Windows) path.
		assert.deepStrictEqual({
			windows: row(true),
			macOS: row(false),
			linux: row(false),
		}, {
			windows: { unset: false, enabled: true, disabled: false, unsetNative: false, enabledNative: false },
			macOS: { unset: true, enabled: true, disabled: false, unsetNative: true, enabledNative: true },
			linux: { unset: true, enabled: true, disabled: false, unsetNative: true, enabledNative: true },
		});
	});
});
