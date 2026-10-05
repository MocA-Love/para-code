/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ChannelId, Channels } from '../common/paradisMobileProtocol.js';
import { ParadisMobileVoiceDelivery, ParadisVoiceSubscriptions } from '../common/paradisVoiceSubscriptions.js';

/** The MobileSession surface needed by voice delivery. */
export interface IParadisVoiceClipSession {
	readonly hasCurrentProtocol: boolean;
	readonly isOnline: boolean;
	readonly epoch: number;
	readonly capabilities: readonly string[] | undefined;
	readonly sendFrame: (channel: ChannelId, workspace: string | undefined, payload: Uint8Array) => Promise<void>;
}

/** Relay service boundaries used by voice delivery. */
export interface IParadisVoiceClipDeliveryOptions {
	readonly getSession: (mobileId: string) => IParadisVoiceClipSession | undefined;
	/** PC からリレーへのソケット全体の送信の詰まり。 */
	readonly congestionBytes: () => number;
	readonly warn: (message: string, error?: unknown) => void;
}

/** 本番の配信（browser チャネル・Buffer の base64）で {@link ParadisMobileVoiceDelivery} を作る。 */
export function paradisCreateVoiceDelivery(subscriptions: ParadisVoiceSubscriptions, options: IParadisVoiceClipDeliveryOptions): ParadisMobileVoiceDelivery {
	return new ParadisMobileVoiceDelivery(subscriptions, {
		getSession: mobileId => {
			const session = options.getSession(mobileId);
			if (session === undefined) {
				return undefined;
			}
			return {
				get hasCurrentProtocol() { return session.hasCurrentProtocol; },
				get isOnline() { return session.isOnline; },
				get epoch() { return session.epoch; },
				get capabilities() { return session.capabilities; },
				sendFrame: payload => session.sendFrame(Channels.Browser, undefined, payload),
			};
		},
		congestionBytes: options.congestionBytes,
		encodeBase64: bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
		warn: options.warn,
	});
}
