/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Mobile renews every 20 seconds; three missed renewals expire the voice subscription. */
export const PARADIS_VOICE_SUBSCRIPTION_TTL_MS = 60_000;

/** A currently subscribed and online mobile that can receive the next voice clip. */
export interface IParadisVoiceRecipient {
	readonly mobileId: string;
	readonly sid: string;
}

/** Ownership token for one in-flight clip send. */
export interface IParadisVoiceSendToken {
	readonly mobileId: string;
}

/** External boundaries needed to deliver one clip using the relay wire contract. */
export interface IParadisVoiceDeliveryOptions {
	readonly now: number;
	readonly isOnline: (mobileId: string) => boolean;
	readonly encodeBase64: (clip: Uint8Array) => string;
	readonly send: (mobileId: string, payload: Uint8Array) => Promise<void>;
	readonly onDropInFlight: (mobileId: string) => void;
	readonly onSendError: (error: unknown) => void;
}

interface IParadisVoiceSubscription {
	readonly sid: string;
	readonly renewedAt: number;
}

/** Tracks the live voice recipients and prevents clips from queueing behind an in-flight send. */
export class ParadisVoiceSubscriptions {
	private readonly subscriptions = new Map<string, IParadisVoiceSubscription>();
	private readonly sending = new Map<string, IParadisVoiceSendToken>();

	constructor(private readonly ttlMs = PARADIS_VOICE_SUBSCRIPTION_TTL_MS) { }

	start(mobileId: string, sid: string, now: number): void {
		this.subscriptions.set(mobileId, { sid, renewedAt: now });
	}

	stop(mobileId: string, sid: string): boolean {
		if (this.subscriptions.get(mobileId)?.sid !== sid) {
			return false;
		}
		this.subscriptions.delete(mobileId);
		return true;
	}

	drop(mobileId: string): void {
		this.subscriptions.delete(mobileId);
		this.sending.delete(mobileId);
	}

	clear(): void {
		this.subscriptions.clear();
		this.sending.clear();
	}

	recipients(now: number, isOnline: (mobileId: string) => boolean): IParadisVoiceRecipient[] {
		const recipients: IParadisVoiceRecipient[] = [];
		for (const [mobileId, subscription] of this.subscriptions) {
			if (now - subscription.renewedAt > this.ttlMs) {
				this.subscriptions.delete(mobileId);
				continue;
			}
			if (isOnline(mobileId)) {
				recipients.push({ mobileId, sid: subscription.sid });
			}
		}
		return recipients;
	}

	beginSend(mobileId: string): IParadisVoiceSendToken | undefined {
		if (this.sending.has(mobileId)) {
			return undefined;
		}
		const token = { mobileId };
		this.sending.set(mobileId, token);
		return token;
	}

	endSend(token: IParadisVoiceSendToken): void {
		if (this.sending.get(token.mobileId) === token) {
			this.sending.delete(token.mobileId);
		}
	}
}

/** Delivers one MP3 clip to the live recipients without queueing behind a previous clip. */
export async function paradisDeliverVoiceClip(
	subscriptions: ParadisVoiceSubscriptions,
	clip: Uint8Array,
	options: IParadisVoiceDeliveryOptions,
): Promise<void> {
	const recipients = subscriptions.recipients(options.now, options.isOnline);
	if (recipients.length === 0 || clip.byteLength === 0) {
		return;
	}
	const data = options.encodeBase64(clip);
	const deliveries: Promise<void>[] = [];
	for (const { mobileId, sid } of recipients) {
		const sendToken = subscriptions.beginSend(mobileId);
		if (sendToken === undefined) {
			options.onDropInFlight(mobileId);
			continue;
		}
		const payload = new TextEncoder().encode(JSON.stringify({ t: 'voice-clip', sid, mime: 'audio/mpeg', data }));
		let delivery: Promise<void>;
		try {
			delivery = options.send(mobileId, payload);
		} catch (error) {
			options.onSendError(error);
			subscriptions.endSend(sendToken);
			continue;
		}
		deliveries.push(delivery
			.catch(error => options.onSendError(error))
			.finally(() => subscriptions.endSend(sendToken)));
	}
	await Promise.all(deliveries);
}
