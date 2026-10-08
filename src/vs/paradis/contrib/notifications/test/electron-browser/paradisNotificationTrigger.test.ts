/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAivisPlaceholders, IParadisNotifyAudioRequest } from '../../common/paradisNotifications.js';
import { ParadisNotificationTrigger } from '../../electron-browser/paradisNotificationTrigger.contribution.js';

// allow-any-unicode-next-line
const PLACEHOLDERS: IParadisAivisPlaceholders = { event: '完了', space: 'space', branch: 'main', worktree: 'main', tab: 'tab' };

/**
 * 通知の遷移 1 件を、偽の設定・偽のチャネルで流し、`notifyAudio` に渡した要求を返す。DI を通さず、遷移の処理に
 * 要るものだけを持たせる（発言・台帳・OS 通知は何もしない）。
 */
async function notifyAudioCalls(options: { readonly focused: boolean; readonly doNotDisturb: boolean }): Promise<unknown[]> {
	const calls: unknown[] = [];
	const lifetime = new CancellationTokenSource();
	const trigger = Object.assign(Object.create(ParadisNotificationTrigger.prototype) as object, {
		_lifetime: lifetime,
		paneTokenService: { getInstanceForToken: () => 1 },
		terminalScopeService: { getStateKeyForInstance: () => 'space' },
		workspaceSwitchService: { activeStateKey: 'space' },
		configurationService: { getValue: () => false },
		logService: { warn: () => undefined, trace: () => undefined },
		sharedProcessService: {
			getChannel: () => ({
				call: async (command: string, args: readonly IParadisNotifyAudioRequest[]) => {
					calls.push({ command, request: args[0] });
				},
			}),
		},
		settingsService: {
			getNotifyWhileFocused: () => false,
			getDoNotDisturb: () => ({ enabled: options.doNotDisturb }),
			getOsNotificationsEnabled: () => false,
			getOsNotifyOnPermission: () => false,
			getOsNotifyOnReview: () => false,
			getSoundsMuted: () => false,
			getSelectedRingtoneId: () => 'chime',
			getVolume: () => 50,
			areApiKeysLoaded: () => true,
			getAivisSettings: () => ({ enabled: true, engine: 'aivis', apiKey: 'key', modelUuid: 'model', format: '{{event}}', formatPermission: '{{event}}', speakingRate: 1, userDictionaryUuid: '', volume: 80 }),
		},
		_isWindowFocused: () => options.focused,
		_resolvePlaceholders: async () => PLACEHOLDERS,
		_resolveMessage: async () => undefined,
		_record: () => undefined,
		_showOsNotification: () => undefined,
	});
	try {
		const handleTransition = Reflect.get(trigger, '_handleTransition') as (token: string, status: string, since: number | undefined, carriedOverFrom: number | undefined) => Promise<void>;
		await handleTransition.call(trigger, 'pane', 'review', undefined, undefined);
	} finally {
		lifetime.dispose();
	}
	return calls;
}

suite('ParadisNotificationTrigger audio', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends only the voice to the mobile during do-not-disturb, nothing while focused, and the ringtone otherwise (Q310 A)', async () => {
		// allow-any-unicode-next-line
		const voice = { apiKey: 'key', modelUuid: 'model', text: '完了', speakingRate: 1, userDictionaryUuid: undefined, volume: 80 };
		assert.deepStrictEqual({
			doNotDisturb: await notifyAudioCalls({ focused: false, doNotDisturb: true }),
			focused: await notifyAudioCalls({ focused: true, doNotDisturb: true }),
			normal: await notifyAudioCalls({ focused: false, doNotDisturb: false }),
		}, {
			doNotDisturb: [{ command: 'notifyAudio', request: { priority: 'normal', mobileOnly: true, aivis: voice } }],
			focused: [],
			normal: [{ command: 'notifyAudio', request: { priority: 'normal', ringtone: { id: 'chime', volume: 50 }, aivis: voice } }],
		});
	});
});
