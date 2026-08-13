/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ChannelId, Channels } from '../common/paradisMobileProtocol.js';
import { paradisDeliverVoiceClip as deliverVoiceClip, ParadisVoiceSubscriptions } from '../common/paradisVoiceSubscriptions.js';

/** The MobileSession surface needed by voice clip delivery. */
export interface IParadisVoiceClipSession {
	readonly hasCurrentProtocol: boolean;
	readonly isOnline: boolean;
	readonly sendFrame: (channel: ChannelId, workspace: string | undefined, payload: Uint8Array) => Promise<void>;
}

/** Relay service boundaries used by voice clip delivery. */
export interface IParadisVoiceClipDeliveryOptions {
	readonly getSession: (mobileId: string) => IParadisVoiceClipSession | undefined;
	readonly warn: (message: string, error?: unknown) => void;
}

/** Encodes and sends one MP3 clip with the production relay wire and failure handling. */
export function paradisDeliverVoiceClip(
	subscriptions: ParadisVoiceSubscriptions,
	clip: Uint8Array,
	now: number,
	options: IParadisVoiceClipDeliveryOptions,
): Promise<void> {
	return deliverVoiceClip(subscriptions, clip, {
		now,
		isOnline: mobileId => {
			const session = options.getSession(mobileId);
			return session?.hasCurrentProtocol === true && session.isOnline;
		},
		encodeBase64: bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
		send: async (mobileId, payload) => {
			const session = options.getSession(mobileId);
			if (session?.hasCurrentProtocol && session.isOnline) {
				await session.sendFrame(Channels.Browser, undefined, payload);
			}
		},
		onDropInFlight: () => {
			options.warn('[paradisMobileRelay] voice clip dropped while the previous clip is still in flight');
		},
		onSendError: error => options.warn('[paradisMobileRelay] voice clip send failed', error),
	});
}
