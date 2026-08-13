/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Channels, ChannelId } from '../../common/paradisMobileProtocol.js';
import { PARADIS_VOICE_SUBSCRIPTION_TTL_MS, ParadisVoiceSubscriptions } from '../../common/paradisVoiceSubscriptions.js';
import { IParadisVoiceClipSession, paradisDeliverVoiceClip } from '../../node/paradisVoiceClipDelivery.js';

suite('ParadisVoiceClipDelivery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends browser voice-clip wire data as base64 MP3', async () => {
		const subscriptions = new ParadisVoiceSubscriptions();
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		const sent: { readonly channel: ChannelId; readonly workspace: string | undefined; readonly payload: Uint8Array }[] = [];
		const session: IParadisVoiceClipSession = {
			hasCurrentProtocol: true,
			isOnline: true,
			sendFrame: async (channel, workspace, payload) => { sent.push({ channel, workspace, payload }); },
		};

		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(0, 1, 2, 253, 254, 255), 2_000, {
			getSession: mobileId => mobileId === 'mobile-1' ? session : undefined,
			warn: message => assert.fail(message),
		});

		assert.deepStrictEqual({
			channel: sent[0]?.channel,
			workspace: sent[0]?.workspace,
			wire: JSON.parse(new TextDecoder().decode(sent[0]?.payload)),
		}, {
			channel: Channels.Browser,
			workspace: undefined,
			wire: { t: 'voice-clip', sid: 'sid-1', mime: 'audio/mpeg', data: 'AAEC/f7/' },
		});
	});

	test('drops a duplicate clip while the previous send is in flight', async () => {
		const subscriptions = new ParadisVoiceSubscriptions();
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		let releaseSend: () => void = () => assert.fail('send did not start');
		let sendCount = 0;
		const warnings: string[] = [];
		const session: IParadisVoiceClipSession = {
			hasCurrentProtocol: true,
			isOnline: true,
			sendFrame: async () => {
				sendCount++;
				await new Promise<void>(resolve => { releaseSend = resolve; });
			},
		};
		const options = {
			getSession: () => session,
			warn: (message: string) => { warnings.push(message); },
		};

		const firstDelivery = paradisDeliverVoiceClip(subscriptions, Uint8Array.of(1), 2_000, options);
		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(2), 2_001, options);

		assert.deepStrictEqual({ sendCount, warnings }, {
			sendCount: 1,
			warnings: ['[paradisMobileRelay] voice clip dropped while the previous clip is still in flight'],
		});
		releaseSend();
		await firstDelivery;
	});

	test('logs a send failure and releases the guard for the next clip', async () => {
		const subscriptions = new ParadisVoiceSubscriptions();
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		let sendCount = 0;
		const warnings: { readonly message: string; readonly error: unknown }[] = [];
		const session: IParadisVoiceClipSession = {
			hasCurrentProtocol: true,
			isOnline: true,
			sendFrame: async () => {
				sendCount++;
				if (sendCount === 1) {
					throw new Error('send failed');
				}
			},
		};
		const options = {
			getSession: () => session,
			warn: (message: string, error?: unknown) => { warnings.push({ message, error }); },
		};

		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(1), 2_000, options);
		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(2), 2_001, options);

		assert.deepStrictEqual({
			sendCount,
			warnings: warnings.map(({ message, error }) => ({ message, error: error instanceof Error ? error.message : error })),
		}, {
			sendCount: 2,
			warnings: [{ message: '[paradisMobileRelay] voice clip send failed', error: 'send failed' }],
		});
	});

	test('excludes offline sessions without discarding them before the 60 second TTL', async () => {
		const subscriptions = new ParadisVoiceSubscriptions();
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		let online = false;
		let sendCount = 0;
		const session: IParadisVoiceClipSession = {
			hasCurrentProtocol: true,
			get isOnline() { return online; },
			sendFrame: async () => { sendCount++; },
		};
		const options = {
			getSession: () => session,
			warn: (message: string) => assert.fail(message),
		};

		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(1), 2_000, options);
		online = true;
		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(2), 1_000 + PARADIS_VOICE_SUBSCRIPTION_TTL_MS, options);
		await paradisDeliverVoiceClip(subscriptions, Uint8Array.of(3), 1_000 + PARADIS_VOICE_SUBSCRIPTION_TTL_MS + 1, options);

		assert.deepStrictEqual({ ttl: PARADIS_VOICE_SUBSCRIPTION_TTL_MS, sendCount }, { ttl: 60_000, sendCount: 1 });
	});
});
