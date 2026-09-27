/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisComputerUseBlockReason, paradisComputerUseEnabled, paradisParseComputerUseApprovalOutcome, paradisParseComputerUseStatus } from '../../common/paradisComputerUse.js';
import { ParadisComputerUseGrantLedger } from '../../node/paradisComputerUseGrantLedger.js';

suite('ParadisComputerUse common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('blocks password managers, Keychain Access and Para Code itself; system surfaces only when Q97 turns them on', () => {
		const ids = [
			'com.1password.1password',
			'COM.BITWARDEN.DESKTOP',
			'com.apple.Passwords',
			'com.apple.keychainaccess',
			'ltd.paradis.paracode',
			'ltd.paradis.paracode.helper',
			'ltd.paradis.paracode.computeruse',
			'com.github.Electron',
			'ltd.paradis.paracodex',
			'com.apple.systempreferences',
			'com.apple.settings.PrivacySecurity.extension',
			'com.apple.SecurityAgent',
			'com.apple.finder',
		];
		assert.deepStrictEqual({
			defaults: ids.map(id => paradisComputerUseBlockReason(id) ?? ''),
			withSystem: ids.map(id => paradisComputerUseBlockReason(id, { blockSystemSurfaces: true }) ?? ''),
		}, {
			defaults: ['password-manager', 'password-manager', 'password-manager', 'keychain', 'para-code', 'para-code', 'para-code', 'para-code', '', '', '', '', ''],
			withSystem: ['password-manager', 'password-manager', 'password-manager', 'keychain', 'para-code', 'para-code', 'para-code', 'para-code', '', 'system', 'system', 'system', ''],
		});
	});

	test('reads the setting, status and approval answers defensively', () => {
		assert.deepStrictEqual({
			enabled: [paradisComputerUseEnabled(true), paradisComputerUseEnabled('true'), paradisComputerUseEnabled(undefined)],
			status: paradisParseComputerUseStatus({ enabled: true, availability: 'ok', helperVersion: '0.1.0', permissions: { accessibility: true, screenRecording: false }, extra: 1 }),
			badStatus: paradisParseComputerUseStatus({ enabled: true, availability: 'great' }),
			outcomes: [paradisParseComputerUseApprovalOutcome({ outcome: 'read' }), paradisParseComputerUseApprovalOutcome({ outcome: 'approved' }), paradisParseComputerUseApprovalOutcome('read')],
		}, {
			enabled: [true, false, false],
			status: { enabled: true, availability: 'ok', helperVersion: '0.1.0', permissions: { accessibility: true, screenRecording: false } },
			badStatus: undefined,
			outcomes: ['read', undefined, undefined],
		});
	});

	test('keeps grants per pane, case-insensitively per app, and drops the oldest past the limit', () => {
		const ledger = new ParadisComputerUseGrantLedger(3);
		ledger.set('pane-a', 'com.apple.Finder', 'read');
		ledger.set('pane-a', 'com.apple.finder', 'denied');
		ledger.set('pane-b', 'com.apple.Notes', 'read');
		ledger.set('pane-a', 'com.apple.Safari', 'read');
		const full = { a: ledger.listForPane('pane-a'), finder: ledger.get('pane-a', 'COM.APPLE.FINDER'), otherPane: ledger.get('pane-b', 'com.apple.finder') };
		// 上限 3 件を超えたら、いちばん古い行（pane-a の Finder）から落とす
		ledger.set('pane-c', 'com.apple.Mail', 'read');
		const overflow = { a: ledger.listForPane('pane-a'), b: ledger.listForPane('pane-b') };
		ledger.forgetPane('pane-b');
		assert.deepStrictEqual({ full, overflow, afterForget: ledger.listForPane('pane-b'), c: ledger.listForPane('pane-c') }, {
			full: {
				a: [{ bundleId: 'com.apple.finder', grant: 'denied' }, { bundleId: 'com.apple.Safari', grant: 'read' }],
				finder: 'denied',
				otherPane: undefined,
			},
			overflow: {
				a: [{ bundleId: 'com.apple.Safari', grant: 'read' }],
				b: [{ bundleId: 'com.apple.Notes', grant: 'read' }],
			},
			afterForget: [],
			c: [{ bundleId: 'com.apple.Mail', grant: 'read' }],
		});
	});
});
