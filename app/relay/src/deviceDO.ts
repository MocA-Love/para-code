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
import { sendApnsNotification, type ApnsEnv, type ApnsJwtCache } from './apns.js';
import { extractToken, hashToken, randomTokenB64u, timingSafeEqualHex } from './auth.js';

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
// APNsのペイロード上限は4KB。base64url暗号文はそのまま `e` に載るため、余裕をみて上限を設ける。
const MAX_PUSH_PAYLOAD_BYTES = 3800;

export class DeviceDO implements DurableObject {
	private readonly sql: SqlStorage;
	// ES256 JWTのメモリキャッシュ（apns.ts が45分間再利用する）。
	private readonly apnsJwtCache: ApnsJwtCache = {};

	constructor(private readonly state: DurableObjectState, private readonly env: unknown) {
		this.sql = state.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), pcPublicKey TEXT, pcTokenHash TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mobiles (mobileId TEXT PRIMARY KEY, name TEXT, tokenHash TEXT, createdAt INTEGER)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (pairId TEXT PRIMARY KEY, tokenHash TEXT, expiresAt INTEGER)`);
		// 後方互換マイグレーション: 既存DOの mobiles テーブルにAPNs列を追加する。
		// SQLiteは `ADD COLUMN IF NOT EXISTS` を持たないため、既に存在する場合の例外は握りつぶす。
		this.migrateMobilesForPush();
	}

	private migrateMobilesForPush(): void {
		for (const column of ['apnsToken TEXT', 'apnsEnv TEXT']) {
			try {
				this.sql.exec(`ALTER TABLE mobiles ADD COLUMN ${column}`);
			} catch {
				// 列が既に存在する（=マイグレーション済み）。無視してよい。
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const action = url.searchParams.get('action');

		if (action === 'provision') {
			return this.provision(request);
		}
		if (action === 'begin-pairing') {
			return this.beginPairing(request);
		}
		if (action === 'revoke') {
			return this.revokeMobile(request);
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

	private async beginPairing(request: Request): Promise<Response> {
		// C-1: ペアリングセッションの発行はPC本人（pcToken保持者）に限定する。
		// 未認証だと deviceId を知る第三者が有効な pairId/token を発行してペアリング
		// ソケットを開けてしまう。
		const device = this.device();
		const token = extractToken(request);
		if (!device || token === null || !timingSafeEqualHex(await hashToken(token), device.pcTokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
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

	// M-1: PC(pcToken保持者)からのデバイス失効。資格情報を削除し、既存のモバイル接続を切断する。
	private async revokeMobile(request: Request): Promise<Response> {
		const device = this.device();
		const token = extractToken(request);
		if (!device || token === null || !timingSafeEqualHex(await hashToken(token), device.pcTokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		const body = await request.json<{ mobileId?: string }>().catch(() => ({} as { mobileId?: string }));
		if (typeof body.mobileId !== 'string') {
			return Response.json({ error: 'missing mobileId' }, { status: 400 });
		}
		this.sql.exec('DELETE FROM mobiles WHERE mobileId = ?', body.mobileId);
		for (const ws of this.state.getWebSockets(`m:${body.mobileId}`)) {
			try { ws.close(1000, 'revoked'); } catch { /* ignore */ }
		}
		return Response.json({ ok: true });
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
			// ペアリングソケット → PCへ中継（PCが承認/拒否を判断）。送信元pairIdを付与して、
			// PCが「どのペアリングのメッセージか」を検証できるようにする（C-2）。
			const pairId = tag.slice('pair:'.length);
			if (msg.type === 'pairing-msg') {
				this.sendToPc({ type: 'pairing-msg', data: msg.data, pairId });
			}
			return;
		}

		if (tag.startsWith('m:')) {
			// 認証済みモバイルソケット上でのみ register-push を受理し、その mobileId の行に保存する。
			if (msg.type === 'register-push') {
				this.registerPush(tag.slice(2), msg.token, msg.env);
			}
			return;
		}

		if (tag === 'pc') {
			if (msg.type === 'pairing-approve') {
				await this.approvePairing(msg.pairId, msg.name);
			} else if (msg.type === 'pairing-reject') {
				this.sendToTag(`pair:${msg.pairId}`, { type: 'error', message: 'pairing rejected' });
			} else if (msg.type === 'push-notify') {
				await this.pushNotify(msg.mobileId, msg.payload);
			}
			// 注: PC→pairing方向のpairing-msg中継は行わない（現行プロトコルはpairing→PCの一方向）。
		}
	}

	// --- APNs プッシュ ---------------------------------------------------------------

	private registerPush(mobileId: string, token: string, env: 'prod' | 'dev' | undefined): void {
		// APNsデバイストークンは16進64桁想定。それ以外は黙って破棄する（不正入力の保存防止）。
		if (!/^[0-9a-f]{64}$/i.test(token)) {
			return;
		}
		if (!this.mobile(mobileId)) {
			return;
		}
		const apnsEnv = env === 'dev' ? 'dev' : 'prod';
		this.sql.exec('UPDATE mobiles SET apnsToken = ?, apnsEnv = ? WHERE mobileId = ?', token, apnsEnv, mobileId);
	}

	private async pushNotify(mobileId: string, payload: string): Promise<void> {
		if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > MAX_PUSH_PAYLOAD_BYTES) {
			console.warn('[push] payload missing or too large; dropping');
			return;
		}
		// オンライン（m:<mobileId> のソケットが1本以上）なら通常のE2Eフレームが届くので何もしない。
		if (this.state.getWebSockets(`m:${mobileId}`).length > 0) {
			return;
		}
		const row = this.sql.exec('SELECT apnsToken, apnsEnv FROM mobiles WHERE mobileId = ?', mobileId).toArray()[0];
		if (!row || !row.apnsToken) {
			return;
		}
		const apnsEnv = (row.apnsEnv as string | null) === 'dev' ? 'dev' : 'prod';
		const result = await sendApnsNotification(this.env as ApnsEnv, { token: row.apnsToken as string, env: apnsEnv, payload }, this.apnsJwtCache);
		if (result === 'unregistered') {
			// 410 Unregistered: 失効したトークンをDBから消す。
			this.sql.exec('UPDATE mobiles SET apnsToken = NULL, apnsEnv = NULL WHERE mobileId = ?', mobileId);
		}
	}

	private async approvePairing(pairId: string, name: string): Promise<void> {
		// C-1: 承認対象の pairId が実在する（PCが発行し、まだ有効な）ことを確認する。
		this.cleanupPairings();
		const pending = this.sql.exec('SELECT pairId FROM pending WHERE pairId = ?', pairId).toArray()[0];
		if (!pending) {
			this.sendToPc({ type: 'error', message: 'unknown or expired pairId' });
			return;
		}
		// C-1: ペアリングトークンを1回限りにする（承認後は即失効）。
		this.sql.exec('DELETE FROM pending WHERE pairId = ?', pairId);

		const mobileId = mobileIdToString(crypto.getRandomValues(new Uint8Array(16)));
		const mobileToken = randomTokenB64u(32);
		const tokenHash = await hashToken(mobileToken);
		this.sql.exec('INSERT INTO mobiles (mobileId, name, tokenHash, createdAt) VALUES (?, ?, ?, ?)', mobileId, name || 'device', tokenHash, Date.now());
		const deviceId = this.state.id.toString();
		// C-1: 資格情報は承認対象の pairId ソケットにのみ渡す（全pairソケットへのブロードキャストは
		// mobileToken 漏洩になる）。
		this.sendToTag(`pair:${pairId}`, { type: 'paired', deviceId, mobileId, mobileToken });
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
