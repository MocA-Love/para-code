/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IParadisComputerUseActivity, paradisComputerUseActivityView, paradisComputerUseAllowOperatingReadOnlyApps, paradisComputerUseBlockReason, paradisComputerUseConfirmForeground, paradisComputerUseEnabled, paradisComputerUseNextActivity, paradisComputerUseNoticeWindowId, paradisComputerUseReadOnlyReason, paradisComputerUseRunsCommands, paradisParseComputerUseActivity, paradisParseComputerUseApprovalOutcome, paradisParseComputerUseStatus } from '../../common/paradisComputerUse.js';
import { createParadisComputerUseCallDiagnostics, PARADIS_COMPUTER_USE_FAILURES, paradisComputerUseCallAttributes, paradisComputerUseFailureCode } from '../../common/paradisComputerUseDiagnostics.js';
import { ParadisComputerUseGrantLedger } from '../../node/paradisComputerUseGrantLedger.js';
import { ParadisComputerUseStatusChannel } from '../../node/paradisComputerUse.sharedProcess.js';
import { PARADIS_COMPUTER_USE_TOOLS } from '../../node/paradisComputerUseToolProvider.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';

suite('ParadisComputerUse common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('blocks password managers, Keychain Access, Para Code itself and the Q97 system surfaces, and knows the apps that run commands', () => {
		const ids = [
			'com.1password.1password',
			'COM.BITWARDEN.DESKTOP',
			'com.apple.Passwords',
			'com.apple.keychainaccess',
			'ltd.paradis.paracode',
			'ltd.paradis.paracode.helper',
			'ltd.paradis.paracode.computeruse',
			'com.github.Electron',
			'org.keepassxc.keepassxc',
			'com.apple.systempreferences.legacyLoader.x86_64',
			'ltd.paradis.paracodex',
			'com.apple.systempreferences',
			'com.apple.settings.PrivacySecurity.extension',
			'com.apple.SecurityAgent',
			'com.apple.finder',
			'me.proton.authenticator',
			'com.example.2FAS',
		];
		assert.deepStrictEqual({
			defaults: ids.map(id => paradisComputerUseBlockReason(id) ?? ''),
			withoutSystem: ids.map(id => paradisComputerUseBlockReason(id, { blockSystemSurfaces: false }) ?? ''),
			commands: ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'com.apple.ScriptEditor2', 'com.jetbrains.intellij', 'com.microsoft.VSCode', 'com.apple.finder', 'com.apple.Notes'].map(paradisComputerUseRunsCommands),
		}, {
			// Q97 の回答 A: システム設定と認証のダイアログも既定で断る
			// 素の Electron は Para Code とみなさない（レビュー L1）
			defaults: ['password-manager', 'password-manager', 'password-manager', 'keychain', 'para-code', 'para-code', 'para-code', '', 'password-manager', 'system', '', 'system', 'system', 'system', '', 'authenticator', 'authenticator'],
			withoutSystem: ['password-manager', 'password-manager', 'password-manager', 'keychain', 'para-code', 'para-code', 'para-code', '', 'password-manager', '', '', '', '', '', '', 'authenticator', 'authenticator'],
			// Q98 の回答 A: ターミナル類は断らず、ダイアログで警告する
			commands: [true, true, true, true, true, true, true, true, false],
		});
	});

	test('reads browsers, remote desktop apps and trading apps only, unless they are blocked outright', () => {
		const ids = [
			'com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'COM.GOOGLE.CHROME', 'com.google.Chrome.canary', 'com.google.Chrome.app.abcdef', 'org.mozilla.firefox', 'com.microsoft.edgemac.Beta', 'company.thebrowser.Browser',
			'com.apple.ScreenSharing', 'com.microsoft.rdc.macos', 'com.teamviewer.TeamViewer',
			'com.tradingview.tradingviewapp.desktop', 'com.example.Binance', 'com.ledger.live',
			'com.apple.finder', 'com.apple.Notes', 'com.axosoft.gitkraken', 'com.apple.Terminal',
		];
		assert.deepStrictEqual({
			reasons: ids.map(id => paradisComputerUseReadOnlyReason(id) ?? ''),
			// 常に断るアプリは、読むだけにする一覧より先に見る（1Password の Safari 拡張など）
			blockedFirst: paradisComputerUseBlockReason('com.1password.safari'),
			setting: [paradisComputerUseAllowOperatingReadOnlyApps(true), paradisComputerUseAllowOperatingReadOnlyApps(undefined), paradisComputerUseAllowOperatingReadOnlyApps('true')],
		}, {
			reasons: ['browser', 'browser', 'browser', 'browser', 'browser', 'browser', 'browser', 'browser', 'remote-desktop', 'remote-desktop', 'remote-desktop', 'trading', 'trading', 'trading', '', '', '', ''],
			blockedFirst: 'password-manager',
			setting: [true, false, false],
		});
	});

	test('notifies once when the user stops Computer Use, shows "operating" only while input is sent, and hides both while the setting is off', () => {
		const idle = { stopped: false, active: false };
		const steps: IParadisComputerUseActivity[] = [
			{ stopped: false, input: true },
			{ stopped: true, input: false },
			// 止まっている間の入力の知らせ（断られた操作）では「操作中」にしない。通知ももう出さない
			{ stopped: true, input: true },
			{ stopped: false, input: false },
			{ stopped: false, input: true },
		];
		let state = idle;
		const log = steps.map(activity => {
			const next = paradisComputerUseNextActivity(state, activity);
			state = next.state;
			return [paradisComputerUseActivityView(next.state, true) ?? '', next.notify, next.closeNotice, next.armActiveTimer];
		});
		assert.deepStrictEqual({
			log,
			off: [paradisComputerUseActivityView({ stopped: true, active: false }, false), paradisComputerUseActivityView({ stopped: false, active: true }, false)],
			parsed: [paradisParseComputerUseActivity({ stopped: true, input: 1 }), paradisParseComputerUseActivity({ stopped: false, input: true }), paradisParseComputerUseActivity({ stopped: 'yes' }), paradisParseComputerUseActivity(undefined)],
		}, {
			log: [
				['active', false, false, true],
				['stopped', true, false, false],
				['stopped', false, false, false],
				['', false, true, false],
				['active', false, false, true],
			],
			off: [undefined, undefined],
			parsed: [{ stopped: true, input: false }, { stopped: false, input: true }, undefined, undefined],
		});
	});

	test('the status channel tells windows about the stop and resumes only through its resume method', async () => {
		const emitter = new Emitter<IParadisComputerUseActivity>();
		let stopped = true;
		let resumes = 0;
		const helper = { availability: 'ok' as const, detail: undefined, lastStatus: undefined, check: async () => 'ok' as const };
		const channel = new ParadisComputerUseStatusChannel(helper, () => true, {
			onDidChangeActivity: emitter.event,
			get stopped() { return stopped; },
			resume: async () => { resumes++; stopped = false; },
		});
		const seen: IParadisComputerUseActivity[] = [];
		const listener = channel.listen<IParadisComputerUseActivity>(undefined, 'onDidChangeActivity')(activity => seen.push(activity));
		emitter.fire({ stopped: true, input: false });
		const before = await channel.call<IParadisComputerUseActivity>(undefined, 'getActivity');
		// 状態を読む・確かめ直すだけでは再開しない
		await channel.call<unknown>(undefined, 'getStatus');
		await channel.call<unknown>(undefined, 'refresh');
		const resumesAfterReads = resumes;
		const after = await channel.call<IParadisComputerUseActivity>(undefined, 'resume');
		listener.dispose();
		emitter.dispose();
		assert.deepStrictEqual({ seen, before, resumesAfterReads, after, resumes, unknownEvent: (() => { try { channel.listen(undefined, 'other'); return 'ok'; } catch { return 'threw'; } })() }, {
			seen: [{ stopped: true, input: false }],
			before: { stopped: true, input: false },
			resumesAfterReads: 0,
			after: { stopped: false, input: false },
			resumes: 1,
			unknownEvent: 'threw',
		});
	});

	test('reads the setting, status and approval answers defensively', () => {
		assert.deepStrictEqual({
			enabled: [paradisComputerUseEnabled(true), paradisComputerUseEnabled('true'), paradisComputerUseEnabled(undefined)],
			confirmForeground: [paradisComputerUseConfirmForeground(undefined), paradisComputerUseConfirmForeground(true), paradisComputerUseConfirmForeground(false), paradisComputerUseConfirmForeground('false')],
			status: paradisParseComputerUseStatus({ enabled: true, availability: 'ok', helperVersion: '0.1.0', permissions: { accessibility: true, screenRecording: false }, extra: 1 }),
			badStatus: paradisParseComputerUseStatus({ enabled: true, availability: 'great' }),
			outcomes: [paradisParseComputerUseApprovalOutcome({ outcome: 'read' }), paradisParseComputerUseApprovalOutcome({ outcome: 'approved' }), paradisParseComputerUseApprovalOutcome('read')],
		}, {
			enabled: [true, false, false],
			confirmForeground: [true, true, false, true],
			status: { enabled: true, availability: 'ok', helperVersion: '0.1.0', permissions: { accessibility: true, screenRecording: false } },
			badStatus: undefined,
			outcomes: ['read', undefined, undefined],
		});
	});

	test('shows the enabled notice in one normal window, falling back to the lowest id when the last focused window is not a normal one', () => {
		assert.deepStrictEqual({
			lastFocusedNormal: paradisComputerUseNoticeWindowId(3, [5, 3, 7]),
			lastFocusedAgents: paradisComputerUseNoticeWindowId(2, [5, 3, 7]),
			unknown: paradisComputerUseNoticeWindowId(undefined, [5, 3, 7]),
			noNormalWindow: paradisComputerUseNoticeWindowId(2, []),
		}, {
			lastFocusedNormal: 3,
			lastFocusedAgents: 3,
			unknown: 3,
			noNormalWindow: undefined,
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
		ledger.set('pane-d', 'com.apple.Notes', 'read', true);
		ledger.set('pane-e', 'com.apple.Notes', 'operate', true);
		const refused = [ledger.operateRefused('pane-d', 'com.apple.notes'), ledger.operateRefused('pane-e', 'com.apple.Notes'), ledger.operateRefused('pane-c', 'com.apple.Mail')];
		ledger.forgetPane('pane-b');
		assert.deepStrictEqual({ full, overflow, refused, afterForget: ledger.listForPane('pane-b'), c: ledger.listForPane('pane-c') }, {
			full: {
				a: [{ bundleId: 'com.apple.finder', grant: 'denied' }, { bundleId: 'com.apple.Safari', grant: 'read' }],
				finder: 'denied',
				otherPane: undefined,
			},
			overflow: {
				a: [{ bundleId: 'com.apple.Safari', grant: 'read' }],
				b: [{ bundleId: 'com.apple.Notes', grant: 'read' }],
			},
			// 「操作は断られた」の印は、読み取りの許可にだけ付く
			refused: [true, false, false],
			afterForget: [],
			c: [{ bundleId: 'com.apple.Mail', grant: 'read' }],
		});
	});

	test('sends no reason word, tool name or key that Sentry would scrub, and keeps every tool and helper code apart', () => {
		// 補助アプリ（ParadisProtocol.swift ほか）と接続（paradisComputerUseHelperClient.ts）が返すコード
		const helperCodes = [
			'accessibility_not_granted', 'app_blocked', 'app_not_found', 'cancelled', 'focus_changed', 'foreground_needs_approval', 'input_failed',
			'input_unsupported', 'internal_error', 'invalid_argument', 'invalid_request', 'key_blocked', 'menu_open', 'point_obscured', 'point_outside_window',
			'queue_full', 'screen_locked', 'screen_recording_not_granted', 'screenshot_failed', 'stale_element', 'system_dialog', 'unknown_method',
			'user_active', 'window_not_focused', 'window_not_found', 'timeout', 'helper_disconnected', 'helper_error', 'unavailable',
			'stopped_by_user', 'secure_input_active', 'read_only_app',
		];
		// computer_press_key・computer_hotkey は素の key を含む。Sentry の既定のスクラブ（api_key 等）には当たらない
		const tools = PARADIS_COMPUTER_USE_TOOLS.map(tool => tool.name);
		const keys = Object.keys(paradisComputerUseCallAttributes('computer_click', 'error', 'timeout', 1, { ...createParadisComputerUseCallDiagnostics(), route: 'foreground', inputSent: 1, stateFailure: 'tree_timeout' }, '0.1.0'));
		assert.deepStrictEqual({
			scrubbed: [...PARADIS_COMPUTER_USE_FAILURES, ...helperCodes, ...tools, ...keys].filter(isParadisSentryScrubbedWord),
			tools: tools.map(paradisComputerUseFailureCode),
			helperCodes: helperCodes.map(paradisComputerUseFailureCode),
			unknown: [paradisComputerUseFailureCode('auth_failed'), paradisComputerUseFailureCode('api_key_missing'), paradisComputerUseFailureCode('/Users/someone'), paradisComputerUseFailureCode('Timeout')],
		}, {
			scrubbed: [],
			tools,
			helperCodes,
			unknown: ['other', 'other', 'other', 'other'],
		});
	});
});
