/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SecureChannel（webcrypto・非同期）の上にチャネル多重化フレームの送受信を提供する。
// app/protocol/src/mux.ts の非同期版（PC側の webcrypto は seal/open が Promise を返すため）。

import { SecureChannel } from './paradisMobileCrypto.js';
import { ChannelId, decodeFrame, encodeFrame, Frame } from './paradisMobileProtocol.js';

export type FrameHandler = (frame: Frame) => void;

export interface FrameMuxOptions {
	readonly sendSealed: (sealed: Uint8Array) => void;
	readonly onError?: (error: unknown) => void;
}

export class FrameMux {
	private readonly handlers = new Map<ChannelId, FrameHandler>();
	private readonly seq = new Map<ChannelId, number>();

	// webcryptoのseal/openは非同期。SecureChannelは方向別にカウンタnonceを持つため、
	// seal（nonce採番）→送出、および open（nonce厳密一致で復号）を**厳密に直列化**しないと、
	// 並行呼び出しでnonce採番と暗号化完了の順序がずれてnonce再利用や受信desyncを起こす（H-2）。
	// tx/rxそれぞれをPromiseチェーンで直列化する。
	private txChain: Promise<void> = Promise.resolve();
	private rxChain: Promise<void> = Promise.resolve();

	constructor(private readonly channel: SecureChannel, private readonly options: FrameMuxOptions) { }

	on(channel: ChannelId, handler: FrameHandler): void {
		this.handlers.set(channel, handler);
	}

	send(channel: ChannelId, payload: Uint8Array, ws?: string): Promise<void> {
		const seq = this.seq.get(channel) ?? 0;
		this.seq.set(channel, seq + 1);
		const frame: Frame = ws === undefined ? { ch: channel, seq, payload } : { ch: channel, ws, seq, payload };
		const run = this.txChain.then(async () => {
			// seal(nonce採番+暗号化)と送出を不可分にする。
			this.options.sendSealed(await this.channel.seal(encodeFrame(frame)));
		});
		// チェーンは失敗しても後続を止めないよう握りつぶす（各呼び出しには元のPromiseを返す）。
		this.txChain = run.catch(() => { /* keep chain alive */ });
		return run;
	}

	receive(sealed: Uint8Array): Promise<void> {
		const run = this.rxChain.then(async () => {
			let frame: Frame;
			try {
				frame = decodeFrame(await this.channel.open(sealed));
			} catch (error) {
				if (this.options.onError) {
					this.options.onError(error);
					return;
				}
				throw error;
			}
			this.handlers.get(frame.ch)?.(frame);
		});
		this.rxChain = run.catch(() => { /* keep chain alive */ });
		return run;
	}
}
