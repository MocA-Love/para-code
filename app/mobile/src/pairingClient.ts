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

export class PairingClient {
	private socket: SocketLike | undefined;

	constructor(
		private readonly identity: Identity,
		private readonly deviceName: string,
		private readonly socketFactory: SocketFactory,
	) { }

	/**
	 * ペアリングを実行し、成立した資格情報を返す。失敗時は reject。
	 */
	pair(payload: PairingPayload, callbacks: PairingCallbacks = {}): Promise<PairedCredentials> {
		return new Promise<PairedCredentials>((resolve, reject) => {
			const base = payload.relayUrl.replace(/\/$/, '');
			const params = new URLSearchParams({ role: 'pair', pairId: payload.pairId, token: toBase64Url(payload.pairingToken) });
			const socket = this.socketFactory(`${base}/device/${payload.deviceId}/ws?${params.toString()}`);
			socket.binaryType = 'arraybuffer';
			this.socket = socket;

			const fail = (err: unknown) => {
				callbacks.onError?.(err);
				try { socket.close(); } catch { /* ignore */ }
				reject(err instanceof Error ? err : new Error(String(err)));
			};

			socket.onopen = () => {
				// 自分の長期公開鍵と名前を pairing-msg で送る（中身はリレーに不透明な JSON）。
				const inner = JSON.stringify({ pub: toBase64Url(this.identity.publicKey), name: this.deviceName });
				const data = toBase64Url(new TextEncoder().encode(inner));
				socket.send(encodeRelayControl({ type: 'pairing-msg', data }));

				// SASコードを算出して提示（PC側と一致するはず）。
				deriveSasCodeSafe(this.identity, payload.pcPublicKey, payload.pairingToken)
					.then(code => callbacks.onSasCode?.(code))
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
					try { socket.close(); } catch { /* ignore */ }
					resolve({
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
		try { this.socket?.close(); } catch { /* ignore */ }
	}
}

function deriveSasCodeSafe(identity: Identity, peerPub: Uint8Array, token: Uint8Array): Promise<string> {
	return Promise.resolve(deriveSasCode(identity, peerPub, token));
}
