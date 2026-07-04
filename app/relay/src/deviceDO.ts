// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * DeviceDO: 1デバイス(=1台のPara Codeが動くPC)につき1インスタンス。
 *
 * 役割はE2E暗号文の「転送」と接続管理のみ。ターミナル/ファイルの中身は復号できない
 * （鍵はPC・モバイルのみが持つ。設計書 §6）。
 *
 * WebSocket:
 *  - PCソケット (tag: "pc"): 常時1本。Para Code(shared process)が張る
 *  - モバイルソケット (tag: "m:<mobileId>"): 承認済みデバイスごとに0..N本
 *  - ペアリングソケット (tag: "pair:<pairId>"): ペアリング中の一時ソケット
 *
 * WebSocket Hibernation API を使うため、アイドル中はduration課金されない（料金は回答参照）。
 * ソケットのtagはhibernation復帰後も getTags() で復元できるので、ルーティングはtagのみに依存する。
 */

import { decodeRelayControl, encodeRelayControl, mobileIdFromString, mobileIdToString, packPcData, unpackPcData, type RelayControlMessage } from '@para/protocol';
import { hashToken, randomTokenB64u, timingSafeEqualHex } from './auth.js';

interface DeviceRecord {
	pcPublicKey: string; // base64url
	pcTokenHash: string;
}

interface MobileRecord {
	mobileId: string;
	name: string;
	tokenHash: string;
	createdAt: number;
}

interface PendingPairing {
	pairId: string;
	tokenHash: string;
	expiresAt: number;
}

const PAIRING_TTL_MS = 5 * 60 * 1000;

export class DeviceDO implements DurableObject {
	private readonly sql: SqlStorage;

	constructor(private readonly state: DurableObjectState, private readonly env: unknown) {
		this.sql = state.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), pcPublicKey TEXT, pcTokenHash TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mobiles (mobileId TEXT PRIMARY KEY, name TEXT, tokenHash TEXT, createdAt INTEGER)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (pairId TEXT PRIMARY KEY, tokenHash TEXT, expiresAt INTEGER)`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const action = url.searchParams.get('action');

		if (action === 'provision') {
			return this.provision(request);
		}
		if (action === 'begin-pairing') {
			return this.beginPairing();
		}
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}
		const role = url.searchParams.get('role');
		const token = url.searchParams.get('token') ?? '';
		if (role === 'pc') {
			return this.acceptPc(token);
		}
		if (role === 'mobile') {
			return this.acceptMobile(url.searchParams.get('mobileId') ?? '', token);
		}
		if (role === 'pair') {
			return this.acceptPairing(url.searchParams.get('pairId') ?? '', token);
		}
		return new Response('bad role', { status: 400 });
	}

	// --- HTTP: PC初期登録（PCトークンを1回だけ発行） --------------------------------

	private device(): DeviceRecord | null {
		const row = this.sql.exec('SELECT pcPublicKey, pcTokenHash FROM device WHERE id = 1').toArray()[0];
		return row ? { pcPublicKey: row.pcPublicKey as string, pcTokenHash: row.pcTokenHash as string } : null;
	}

	private async provision(request: Request): Promise<Response> {
		const body = await request.json<{ pcPublicKey?: string; pcToken?: string }>();
		if (!body.pcPublicKey || !body.pcToken) {
			return Response.json({ error: 'missing fields' }, { status: 400 });
		}
		const existing = this.device();
		if (existing) {
			// 既に登録済み: 冪等に既存レコードを尊重する（再登録は拒否）
			return Response.json({ error: 'already provisioned' }, { status: 409 });
		}
		const pcTokenHash = await hashToken(body.pcToken);
		this.sql.exec('INSERT INTO device (id, pcPublicKey, pcTokenHash) VALUES (1, ?, ?)', body.pcPublicKey, pcTokenHash);
		return Response.json({ ok: true });
	}

	private async beginPairing(): Promise<Response> {
		this.cleanupPairings();
		const pairId = randomTokenB64u(12);
		const pairingToken = randomTokenB64u(32);
		const tokenHash = await hashToken(pairingToken);
		this.sql.exec('INSERT INTO pending (pairId, tokenHash, expiresAt) VALUES (?, ?, ?)', pairId, tokenHash, Date.now() + PAIRING_TTL_MS);
		return Response.json({ pairId, pairingToken, expiresAt: Date.now() + PAIRING_TTL_MS });
	}

	private cleanupPairings(): void {
		this.sql.exec('DELETE FROM pending WHERE expiresAt < ?', Date.now());
	}

	// --- WebSocket accept ---------------------------------------------------------

	private async acceptPc(token: string): Promise<Response> {
		const device = this.device();
		if (!device || !timingSafeEqualHex(await hashToken(token), device.pcTokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		// 既存PCソケットは閉じる（1本に限定）
		for (const ws of this.state.getWebSockets('pc')) {
			try { ws.close(1000, 'superseded'); } catch { /* ignore */ }
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, ['pc']), () => {
			this.notifyPcPresence(true);
		});
	}

	private async acceptMobile(mobileIdStr: string, token: string): Promise<Response> {
		const record = this.mobile(mobileIdStr);
		if (!record || !timingSafeEqualHex(await hashToken(token), record.tokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, [`m:${mobileIdStr}`]), () => {
			// PCにモバイルのpresenceを通知
			this.sendToPc({ type: 'presence', peer: 'mobile', mobileId: mobileIdStr, online: true });
			// モバイルに現在のPC接続状態を通知
			this.sendToTag(`m:${mobileIdStr}`, { type: 'presence', peer: 'pc', online: this.state.getWebSockets('pc').length > 0 });
		});
	}

	private async acceptPairing(pairId: string, token: string): Promise<Response> {
		this.cleanupPairings();
		const row = this.sql.exec('SELECT pairId, tokenHash, expiresAt FROM pending WHERE pairId = ?', pairId).toArray()[0];
		if (!row || !timingSafeEqualHex(await hashToken(token), row.tokenHash as string)) {
			return new Response('unauthorized', { status: 401 });
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, [`pair:${pairId}`]), undefined);
	}

	private mobile(mobileIdStr: string): MobileRecord | null {
		const row = this.sql.exec('SELECT mobileId, name, tokenHash, createdAt FROM mobiles WHERE mobileId = ?', mobileIdStr).toArray()[0];
		return row ? { mobileId: row.mobileId as string, name: row.name as string, tokenHash: row.tokenHash as string, createdAt: row.createdAt as number } : null;
	}

	private upgrade(accept: (ws: WebSocket) => void, onOpen: (() => void) | undefined): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		accept(server);
		onOpen?.();
		return new Response(null, { status: 101, webSocket: client });
	}

	// --- WebSocket message routing (Hibernation handlers) -------------------------

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		const tags = this.state.getTags(ws);
		const tag = tags[0] ?? '';

		if (typeof message === 'string') {
			await this.handleControl(ws, tag, message);
			return;
		}

		const data = new Uint8Array(message);
		if (tag === 'pc') {
			// PC→モバイル: [ver][mobileId][payload] を該当モバイルへ
			try {
				const { mobileId, payload } = unpackPcData(data);
				this.forwardBinaryToTag(`m:${mobileIdToString(mobileId)}`, payload);
			} catch {
				this.sendError(ws, 'malformed pc data');
			}
		} else if (tag.startsWith('m:')) {
			// モバイル→PC: mobileIdを付与してPCへ多重化
			const mobileIdStr = tag.slice(2);
			try {
				const framed = packPcData(mobileIdFromString(mobileIdStr), data);
				this.forwardBinaryToTag('pc', framed);
			} catch {
				this.sendError(ws, 'routing failed');
			}
		}
		// pairing socketはバイナリを扱わない（制御JSONのみ）
	}

	private async handleControl(ws: WebSocket, tag: string, text: string): Promise<void> {
		let msg: RelayControlMessage;
		try {
			msg = decodeRelayControl(text);
		} catch {
			this.sendError(ws, 'malformed control');
			return;
		}

		if (tag.startsWith('pair:')) {
			// ペアリングソケット → PCへ中継（PCが承認/拒否を判断）
			const pairId = tag.slice('pair:'.length);
			if (msg.type === 'pairing-msg') {
				this.sendToPc({ type: 'pairing-msg', data: msg.data });
			}
			return;
		}

		if (tag === 'pc') {
			if (msg.type === 'pairing-msg') {
				this.broadcastToPairing({ type: 'pairing-msg', data: msg.data });
			} else if (msg.type === 'pairing-approve') {
				await this.approvePairing(msg.name);
			} else if (msg.type === 'pairing-reject') {
				this.broadcastToPairing({ type: 'error', message: 'pairing rejected' });
			}
		}
	}

	private async approvePairing(name: string): Promise<void> {
		const mobileId = mobileIdToString(crypto.getRandomValues(new Uint8Array(16)));
		const mobileToken = randomTokenB64u(32);
		const tokenHash = await hashToken(mobileToken);
		this.sql.exec('INSERT INTO mobiles (mobileId, name, tokenHash, createdAt) VALUES (?, ?, ?, ?)', mobileId, name || 'device', tokenHash, Date.now());
		const deviceId = this.state.id.toString();
		// モバイル(pairing socket)へは資格情報一式を渡す。
		this.broadcastToPairing({ type: 'paired', deviceId, mobileId, mobileToken });
		// PCへも mobileId を通知する（PCは直前のpairing-msgで得たモバイル公開鍵を
		// この mobileId に紐付けて保存し、以後のデータ接続の相手鍵とする）。mobileTokenは
		// モバイル専用の秘密なのでPCには送らず空にする。
		this.sendToPc({ type: 'paired', deviceId, mobileId, mobileToken: '' });
	}

	// --- helpers ------------------------------------------------------------------

	private forwardBinaryToTag(tag: string, payload: Uint8Array): void {
		for (const ws of this.state.getWebSockets(tag)) {
			try { ws.send(payload); } catch { /* ignore individual send failures */ }
		}
	}

	private sendToTag(tag: string, msg: RelayControlMessage): void {
		const text = encodeRelayControl(msg);
		for (const ws of this.state.getWebSockets(tag)) {
			try { ws.send(text); } catch { /* ignore */ }
		}
	}

	private sendToPc(msg: RelayControlMessage): void {
		this.sendToTag('pc', msg);
	}

	private broadcastToPairing(msg: RelayControlMessage): void {
		const text = encodeRelayControl(msg);
		for (const ws of this.state.getWebSockets()) {
			if ((this.state.getTags(ws)[0] ?? '').startsWith('pair:')) {
				try { ws.send(text); } catch { /* ignore */ }
			}
		}
	}

	private sendError(ws: WebSocket, message: string): void {
		try { ws.send(encodeRelayControl({ type: 'error', message })); } catch { /* ignore */ }
	}

	private notifyPcPresence(online: boolean): void {
		for (const ws of this.state.getWebSockets()) {
			const tag = this.state.getTags(ws)[0] ?? '';
			if (tag.startsWith('m:')) {
				try { ws.send(encodeRelayControl({ type: 'presence', peer: 'pc', online })); } catch { /* ignore */ }
			}
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const tag = this.state.getTags(ws)[0] ?? '';
		if (tag === 'pc') {
			this.notifyPcPresence(false);
		} else if (tag.startsWith('m:')) {
			this.sendToPc({ type: 'presence', peer: 'mobile', mobileId: tag.slice(2), online: false });
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws);
	}
}
