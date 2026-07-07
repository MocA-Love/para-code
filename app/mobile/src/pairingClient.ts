// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイル側のペアリングクライアント（トランスポート非依存）。
 *
 * QRから得た PairingPayload を使い、リレーの pair ソケットへ接続して自分の公開鍵を送り、
 * SAS検証コードを算出してUIに提示する。PCがSASを承認するとリレーが `paired`(mobileId,mobileToken)
 * を返し、以後のデータ接続に使う PairedCredentials が確定する。
 */

import {
	type Identity,
	type PairingPayload,
	decodeRelayControl,
	deriveSasCode,
	encodeRelayControl,
	toBase64Url,
} from '@para/protocol';
import type { PairedCredentials } from './relayClient.js';
import type { SocketFactory, SocketLike } from './relayClient.js';

export interface PairingCallbacks {
	/** SAS検証コードが確定した（ユーザーにPCと突き合わせてもらう）。 */
	readonly onSasCode?: (code: string) => void;
	readonly onError?: (error: unknown) => void;
}

interface Timers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

// ソケット接続確立の上限。RNのWebSocketは接続失敗時に onclose が届かないまま黙り込む
// ことがある（relayClient.ts の CONNECT_TIMEOUT_MS と同じ理由）ため、ここでも打ち切る。
const CONNECT_TIMEOUT_MS = 12_000;
// SAS提示後（＝PC側のユーザー承認待ち）の上限。人手の操作を待つので長めに取る。
const APPROVAL_TIMEOUT_MS = 120_000;

export class PairingClient {
	private socket: SocketLike | undefined;
	/** 進行中のペアリングを外部から中断するためのフック（pair() 実行中のみ有効）。 */
	private abort: ((reason: Error) => void) | undefined;

	constructor(
		private readonly identity: Identity,
		private readonly deviceName: string,
		private readonly socketFactory: SocketFactory,
		private readonly timers: Timers = globalThis,
	) { }

	/**
	 * ペアリングを実行し、成立した資格情報を返す。失敗時は reject。
	 */
	pair(payload: PairingPayload, callbacks: PairingCallbacks = {}): Promise<PairedCredentials> {
		return new Promise<PairedCredentials>((resolve, reject) => {
			const base = payload.relayUrl.replace(/\/$/, '');
			// finding #7: pairingTokenはクエリではなくサブプロトコル（`para-auth.<token>`）で送る。
			const params = new URLSearchParams({ role: 'pair', pairId: payload.pairId });
			const socket = this.socketFactory(
				`${base}/device/${payload.deviceId}/ws?${params.toString()}`,
				`para-auth.${toBase64Url(payload.pairingToken)}`,
			);
			socket.binaryType = 'arraybuffer';
			this.socket = socket;

			// settled 後は resolve/reject もタイマーも二度と動かさない。中断（cancel）後に
			// 遅れて 'paired' が届いても資格情報を確定させないためのガード。
			let settled = false;
			let timer: unknown = this.timers.setTimeout(() => fail(new Error('pairing connection timeout')), CONNECT_TIMEOUT_MS);
			const clearTimer = () => {
				if (timer !== undefined) {
					this.timers.clearTimeout(timer);
					timer = undefined;
				}
			};

			const fail = (err: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				this.abort = undefined;
				clearTimer();
				callbacks.onError?.(err);
				try { socket.close(); } catch { /* ignore */ }
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			const succeed = (creds: PairedCredentials) => {
				if (settled) {
					return;
				}
				settled = true;
				this.abort = undefined;
				clearTimer();
				try { socket.close(); } catch { /* ignore */ }
				resolve(creds);
			};
			// cancel() から呼ばれる中断フック。
			this.abort = reason => fail(reason);

			socket.onopen = () => {
				// 接続は確立したので、以後はPC側ユーザーの承認待ち用の長めのタイムアウトに切り替える。
				clearTimer();
				timer = this.timers.setTimeout(() => fail(new Error('pairing approval timeout')), APPROVAL_TIMEOUT_MS);

				// 自分の長期公開鍵と名前を pairing-msg で送る（中身はリレーに不透明な JSON）。
				const inner = JSON.stringify({ pub: toBase64Url(this.identity.publicKey), name: this.deviceName });
				const data = toBase64Url(new TextEncoder().encode(inner));
				socket.send(encodeRelayControl({ type: 'pairing-msg', data }));

				// SASコードを算出して提示（PC側と一致するはず）。
				deriveSasCodeSafe(this.identity, payload.pcPublicKey, payload.pairingToken)
					.then(code => { if (!settled) { callbacks.onSasCode?.(code); } })
					.catch(fail);
			};

			socket.onmessage = event => {
				if (typeof event.data !== 'string') {
					return;
				}
				let msg;
				try {
					msg = decodeRelayControl(event.data);
				} catch {
					return;
				}
				if (msg.type === 'paired') {
					succeed({
						relayUrl: payload.relayUrl,
						deviceId: msg.deviceId,
						mobileId: msg.mobileId,
						mobileToken: msg.mobileToken,
						pcPublicKey: payload.pcPublicKey,
					});
				} else if (msg.type === 'error') {
					fail(new Error(msg.message));
				}
			};

			socket.onerror = err => fail(err);
			socket.onclose = () => fail(new Error('pairing socket closed'));
		});
	}

	cancel(): void {
		// 進行中なら pair() の Promise を reject させ、ソケットも閉じる。
		if (this.abort) {
			this.abort(new Error('pairing cancelled'));
		} else {
			try { this.socket?.close(); } catch { /* ignore */ }
		}
	}
}

function deriveSasCodeSafe(identity: Identity, peerPub: Uint8Array, token: Uint8Array): Promise<string> {
	return Promise.resolve(deriveSasCode(identity, peerPub, token));
}
