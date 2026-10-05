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

import { PARADIS_PUSH_ID_PATTERN, PARADIS_RELAY_CLOSE_CODE, PARADIS_RELAY_KEEPALIVE_PING, PARADIS_RELAY_KEEPALIVE_PONG, decodeRelayControl, encodeRelayControl, mobileIdFromString, mobileIdToString, packPcData, unpackPcData, type RelayControlMessage } from '@para/protocol';
import { PUSH_EXPIRATION_SECONDS, sendApnsNotification, type ApnsEnv, type ApnsJwtCache, type ApnsSendResult } from './apns.js';
import { pushRetryDelayMs, PUSH_MAX_RETRIES } from './pushRetry.js';
import { extractToken, hashToken, randomTokenB64u, subprotocolAuthHeader, timingSafeEqualHex } from './auth.js';

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
/** alarm を pending の失効時刻より少し後ろにずらすための余裕（expiresAt < now 比較を確実に通す）。 */
const PAIRING_SWEEP_MARGIN_MS = 1_000;
// APNsのペイロード上限は4KB。base64url暗号文はそのまま `e` に載るため、余裕をみて上限を設ける。
const MAX_PUSH_PAYLOAD_BYTES = 3800;

/**
 * APNs再送待ちの行数の上限（DO単位）。PCが暴走しても永続ストレージが際限なく増えないようにする。
 * 溢れたら古いものから捨てる（古い通知ほど鳴らす価値が低い）。
 */
const MAX_PUSH_QUEUE_ROWS = 50;

/**
 * 送信中の行を「送った」とみなして別の送信から外しておく時間。送っている間に DO が落ちて結果を書けなかった
 * 行は、この後で送り直す（同じ apns-collapse-id なので、届いていても端末上で置き換わる）。
 */
const PUSH_SEND_LEASE_MS = 60_000;

/**
 * PC の依頼 ID（push-notify の requestId）を覚えておく時間と数。PC の outbox は最長 10 分で諦めるので、
 * それより長く覚えて、同じ依頼の送り直しで APNs へ二重に送らない。
 */
const PUSH_REQUEST_RETENTION_MS = 15 * 60_000;
const MAX_PUSH_REQUEST_ROWS = 500;

/** 再送待ちのプッシュ1件（push_queue の1行）。 */
interface QueuedPush {
	readonly id: number;
	readonly mobileId: string;
	readonly payload: string;
	readonly collapseId: string | undefined;
	readonly threadId: string | undefined;
	/** これまでに失敗した回数（最初の送信を含む）。 */
	readonly attempt: number;
	/** apns-expiration（epoch秒）。再送しても延ばさない。 */
	readonly expiresAtSeconds: number;
}

/** TURN資格情報発行のレート制限（デバイスDO単位、スライディングウィンドウ）。 */
const TURN_RATE_WINDOW_MS = 60 * 1000;
const TURN_RATE_MAX_PER_WINDOW = 6;

/**
 * モバイルの資格を最後に使った時刻（`mobiles.lastSeenAt`）を書き直す最小の間隔（W2-35）。
 * 接続のたびに書くと DO のストレージ書き込みが増えるので、1時間に1回までにする。
 */
export const MOBILE_LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;
/** 使われていないモバイルの資格を掃除する間隔（失効を有効にしているときだけ）。 */
export const MOBILE_CREDENTIAL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** PC へまだ伝えていない失効の知らせを覚えておく数の上限。 */
const MAX_PENDING_PC_NOTICES = 100;

/**
 * 使われていないモバイルの資格を失効させるまでの日数（W2-35、Q127 A は 90 日）。環境変数
 * `MOBILE_CREDENTIAL_TTL_DAYS` で決め、**未設定・0・読めない値なら失効させない（既定は無効）**。
 * 理由付きの切断（W2-04）を知らない旧アプリは、失効すると理由の分からない「再接続中」を続けるので、
 * W2-04 を載せたアプリが行き渡ってから有効にする。最後に使った時刻の記録は、無効の間も続ける。
 */
export function mobileCredentialTtlMs(env: unknown): number | undefined {
	const raw = (env as { MOBILE_CREDENTIAL_TTL_DAYS?: unknown } | null | undefined)?.MOBILE_CREDENTIAL_TTL_DAYS;
	const days = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : NaN;
	if (!Number.isFinite(days) || days <= 0) {
		return undefined;
	}
	// 誤って短くしすぎて全端末を切らないよう、7日を下限にする。
	return Math.max(7, days) * 24 * 60 * 60 * 1000;
}

export class DeviceDO implements DurableObject {
	private readonly sql: SqlStorage;
	// ES256 JWTのメモリキャッシュ（apns.ts が45分間再利用する）。
	private readonly apnsJwtCache: ApnsJwtCache = {};
	/** TURN資格情報の発行時刻（レート制限用。インメモリで十分、詳細は turnCredentials 参照）。 */
	private turnIssueTimes: number[] = [];
	/** 資格を使った時刻を最後に確かめた時刻（メモリ。`touchMobile` の間引き）。 */
	private readonly lastTouchedAt = new Map<string, number>();

	constructor(private readonly state: DurableObjectState, private readonly env: unknown) {
		this.sql = state.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), pcPublicKey TEXT, pcTokenHash TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mobiles (mobileId TEXT PRIMARY KEY, name TEXT, tokenHash TEXT, createdAt INTEGER)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (pairId TEXT PRIMARY KEY, tokenHash TEXT, expiresAt INTEGER)`);
		// APNsの一時的な失敗（429 / 5xx / 通信失敗）を後で送り直すための待ち行列。
		// DOは再送を待つ間に退避（evict）されうるので、メモリではなくSQLへ置いてalarmで起こす。
		this.sql.exec(`CREATE TABLE IF NOT EXISTS push_queue (id INTEGER PRIMARY KEY, mobileId TEXT, payload TEXT, collapseId TEXT, threadId TEXT, attempt INTEGER, nextAt INTEGER, expiresAt INTEGER)`);
		// PC が依頼 ID を付けて頼んだプッシュ（受理した ID）。同じ ID の送り直しを二重に送らないため。
		this.sql.exec(`CREATE TABLE IF NOT EXISTS push_requests (requestId TEXT PRIMARY KEY, at INTEGER)`);
		// 後方互換マイグレーション: 既存DOの mobiles テーブルにAPNs列を追加する。
		// SQLiteは `ADD COLUMN IF NOT EXISTS` を持たないため、既に存在する場合の例外は握りつぶす。
		this.migrateMobilesForPush();
		this.migrateMobilesForLastSeen();
		// PC がつながっていない間に失効させたモバイル。次に PC がつながったら mobile-revoked で伝える（W2-35）。
		this.sql.exec(`CREATE TABLE IF NOT EXISTS pc_notices (mobileId TEXT PRIMARY KEY, at INTEGER)`);
		// 失効の掃除の次の時刻など、1行だけの値。
		this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER)`);
		// 保活のping/pongはエッジが自動応答する。hibernation中のDOを起こさないので、
		// アイドル接続を維持するコストがほぼゼロで済む（起こすと課金対象の実行時間が発生する）。
		// 照合はバイト列の完全一致なので、クライアントは必ず同じ定数を送ること。
		this.state.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(PARADIS_RELAY_KEEPALIVE_PING, PARADIS_RELAY_KEEPALIVE_PONG),
		);
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

	/**
	 * 最後に使った時刻の列を足す（W2-35）。列を足したときは、既にある行に今の時刻を入れる: 列が無かった頃の
	 * 行は「いつ使ったか分からない」ので、失効の数え始めをこのデプロイの時点にする（作った時刻で数えると、
	 * 毎日使っている古いペアリングまで、失効を有効にした日に切れてしまう）。
	 */
	private migrateMobilesForLastSeen(): void {
		try {
			this.sql.exec('ALTER TABLE mobiles ADD COLUMN lastSeenAt INTEGER');
		} catch {
			return; // 列が既にある
		}
		this.sql.exec('UPDATE mobiles SET lastSeenAt = ? WHERE lastSeenAt IS NULL', Date.now());
	}

	/**
	 * モバイルの資格を使った時刻を残す（1時間に1回まで）。メッセージを受けるたびにも呼ぶので、SQL を
	 * 叩く前にメモリで間引く（DO が休止から起きた後の最初の1回だけは SQL で確かめる）。
	 */
	private touchMobile(mobileId: string, now: number = Date.now()): void {
		const touched = this.lastTouchedAt.get(mobileId);
		if (touched !== undefined && now - touched < MOBILE_LAST_SEEN_WRITE_INTERVAL_MS) {
			return;
		}
		this.lastTouchedAt.set(mobileId, now);
		this.sql.exec('UPDATE mobiles SET lastSeenAt = ? WHERE mobileId = ? AND (lastSeenAt IS NULL OR lastSeenAt < ?)', now, mobileId, now - MOBILE_LAST_SEEN_WRITE_INTERVAL_MS);
	}

	/**
	 * 使われていないモバイルの資格を失効させる（W2-35。失効を有効にしているときだけ、1日1回）。
	 * 行を消してソケットを閉じ（4404）、PC がつながっていれば mobile-revoked を送る。つながっていなければ
	 * 次に PC がつながったときに送る（PC の台帳から外すため。PC は既存の mobile-revoked の処理で外す）。
	 */
	private sweepUnusedMobiles(ttlMs: number, now: number = Date.now()): string[] {
		const expired = this.sql.exec('SELECT mobileId FROM mobiles WHERE COALESCE(lastSeenAt, createdAt, 0) < ?', now - ttlMs).toArray().map(row => row.mobileId as string);
		for (const mobileId of expired) {
			this.sql.exec('DELETE FROM mobiles WHERE mobileId = ?', mobileId);
			this.sql.exec('DELETE FROM push_queue WHERE mobileId = ?', mobileId);
			for (const ws of this.state.getWebSockets(`m:${mobileId}`)) {
				try { ws.close(PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE, 'expired'); } catch { /* ignore */ }
			}
			if (this.state.getWebSockets('pc').length > 0) {
				this.sendToPc({ type: 'mobile-revoked', mobileId });
			} else {
				this.sql.exec('INSERT OR REPLACE INTO pc_notices (mobileId, at) VALUES (?, ?)', mobileId, now);
			}
		}
		this.sql.exec('DELETE FROM pc_notices WHERE mobileId NOT IN (SELECT mobileId FROM pc_notices ORDER BY at DESC LIMIT ?)', MAX_PENDING_PC_NOTICES);
		return expired;
	}

	/** PC がつながったとき、つながっていない間に失効させたモバイルを伝える。 */
	private flushPcNotices(): void {
		const rows = this.sql.exec('SELECT mobileId FROM pc_notices').toArray();
		for (const row of rows) {
			this.sendToPc({ type: 'mobile-revoked', mobileId: row.mobileId as string });
		}
		if (rows.length > 0) {
			this.sql.exec('DELETE FROM pc_notices');
		}
	}

	/** 失効の掃除の次の時刻（失効が無効・モバイルが1台も無いなら undefined）。無ければ今から1日後に決める。 */
	private nextCredentialSweepAt(now: number = Date.now()): number | undefined {
		if (mobileCredentialTtlMs(this.env) === undefined) {
			return undefined;
		}
		const count = this.sql.exec('SELECT COUNT(*) AS n FROM mobiles').toArray()[0] as { n?: unknown } | undefined;
		if (typeof count?.n !== 'number' || count.n === 0) {
			return undefined;
		}
		const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'credentialSweepAt'`).toArray()[0] as { value?: unknown } | undefined;
		if (typeof row?.value === 'number' && Number.isFinite(row.value)) {
			return row.value;
		}
		const next = now + MOBILE_CREDENTIAL_SWEEP_INTERVAL_MS;
		this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('credentialSweepAt', ?)`, next);
		return next;
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
		if (action === 'self-revoke') {
			return this.selfRevokeMobile(request);
		}
		if (action === 'turn-credentials') {
			return this.turnCredentials(request);
		}
		if (action === 'pc-check') {
			return this.checkPcToken(request);
		}
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}
		const role = url.searchParams.get('role');
		// finding #7: トークンはサブプロトコル（推奨）/ クエリ（deprecated）両対応で受理する。
		const token = extractToken(request) ?? '';
		// 提示された para-auth.<token> サブプロトコルは101応答でそのままecho（RFC6455準拠、
		// 厳格なクライアント対策）。クエリ方式の旧クライアントでは undefined。
		const echoSubprotocol = subprotocolAuthHeader(request) ?? undefined;
		if (role === 'pc') {
			return this.acceptPc(token, echoSubprotocol);
		}
		if (role === 'mobile') {
			return this.acceptMobile(url.searchParams.get('mobileId') ?? '', token, echoSubprotocol);
		}
		if (role === 'pair') {
			return this.acceptPairing(url.searchParams.get('pairId') ?? '', token, echoSubprotocol);
		}
		return new Response('bad role', { status: 400 });
	}

	// --- HTTP: PC初期登録（PCトークンを1回だけ発行） --------------------------------

	private device(): DeviceRecord | null {
		const row = this.sql.exec('SELECT pcPublicKey, pcTokenHash FROM device WHERE id = 1').toArray()[0];
		return row ? { pcPublicKey: row.pcPublicKey as string, pcTokenHash: row.pcTokenHash as string } : null;
	}

	private async provision(request: Request): Promise<Response> {
		const body = await request.json<{ pcPublicKey?: string; pcToken?: string }>().catch(() => ({} as { pcPublicKey?: string; pcToken?: string }));
		if (!body.pcPublicKey || !body.pcToken) {
			return Response.json({ error: 'missing fields' }, { status: 400 });
		}
		// finding #9: 形式・長さを厳密に検証し、巨大文字列の永続化（ストレージ増幅）を防ぐ。
		// pcPublicKey は32バイト公開鍵のbase64url（パディングなし=43文字）であるべき。
		if (typeof body.pcPublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pcPublicKey)) {
			return Response.json({ error: 'invalid pcPublicKey' }, { status: 400 });
		}
		// pcToken は randomTokenB64u(32)=43文字想定。上限を設けて任意長トークンの保存を防ぐ。
		if (typeof body.pcToken !== 'string' || body.pcToken.length < 16 || body.pcToken.length > 128) {
			return Response.json({ error: 'invalid pcToken' }, { status: 400 });
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
		await this.scheduleAlarm();
		return Response.json({ pairId, pairingToken, expiresAt: Date.now() + PAIRING_TTL_MS });
	}

	/**
	 * pcToken の有効性だけを返す（副作用なし）。
	 * WebSocket のハンドシェイク失敗は、認証拒否でも経路断でもクライアントには同じ
	 * close 1006 として届く。PC 側が「待てば直る」のか「再ペアリングが要る」のかを
	 * 判別するための唯一の手段。
	 */
	private async checkPcToken(request: Request): Promise<Response> {
		const device = this.device();
		const token = extractToken(request);
		if (!device || token === null || !timingSafeEqualHex(await hashToken(token), device.pcTokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		return Response.json({ ok: true });
	}

	private cleanupPairings(): void {
		const expired = this.sql.exec('SELECT pairId FROM pending WHERE expiresAt < ?', Date.now()).toArray();
		if (expired.length === 0) {
			return;
		}
		this.sql.exec('DELETE FROM pending WHERE expiresAt < ?', Date.now());
		// SQL行だけ消してもソケットは残る。モバイル側のPairingClientは正常フローでは必ず
		// 自己closeするが、強制終了・half-open等の異常系では hibernated WS として積み上がる。
		// TTL切れの pair ソケットをサーバ側からも閉じる（QR再読込のたびに積み上がる問題）。
		for (const row of expired) {
			for (const ws of this.state.getWebSockets(`pair:${row.pairId}`)) {
				try { ws.close(1000, 'expired'); } catch { /* ignore */ }
			}
		}
	}

	/**
	 * alarm を「次に何かすべき時刻」に張る。対象は2つ:
	 *  - pending の失効（TTL切れの掃除。cleanupPairings はPC/モバイル起点のリクエスト時にしか
	 *    呼ばれないので、誰もリクエストしなくても失効時に確実に掃除が走るようにする）
	 *  - APNs再送待ちの次の送信時刻
	 * DOの alarm は1本しか持てないので、両方の早い方に合わせる。
	 */
	private async scheduleAlarm(): Promise<void> {
		const pairingRow = this.sql.exec('SELECT MIN(expiresAt) AS next FROM pending').toArray()[0] as { next?: unknown } | undefined;
		const pushRow = this.sql.exec('SELECT MIN(nextAt) AS next FROM push_queue').toArray()[0] as { next?: unknown } | undefined;
		const candidates: number[] = [];
		if (typeof pairingRow?.next === 'number' && Number.isFinite(pairingRow.next)) {
			candidates.push(pairingRow.next + PAIRING_SWEEP_MARGIN_MS);
		}
		if (typeof pushRow?.next === 'number' && Number.isFinite(pushRow.next)) {
			candidates.push(pushRow.next);
		}
		const sweepAt = this.nextCredentialSweepAt();
		if (sweepAt !== undefined) {
			candidates.push(sweepAt);
		}
		if (candidates.length === 0) {
			return;
		}
		const target = Math.min(...candidates);
		// アラームは storage 配下のAPIで管理する（state 直下には存在しない）。
		const current = await this.state.storage.getAlarm();
		if (current === null || current > target) {
			await this.state.storage.setAlarm(target);
		}
	}

	/** Durable Objects のアラーム。pending のTTL切れ掃除（pair ソケット close 含む）と、APNsの再送。 */
	async alarm(): Promise<void> {
		this.cleanupPairings();
		await this.flushPushQueue();
		// 使われていないモバイルの資格の失効（W2-35。既定は無効）。
		const ttlMs = mobileCredentialTtlMs(this.env);
		const sweepAt = this.nextCredentialSweepAt();
		if (ttlMs !== undefined && sweepAt !== undefined && sweepAt <= Date.now()) {
			this.sweepUnusedMobiles(ttlMs);
			this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('credentialSweepAt', ?)`, Date.now() + MOBILE_CREDENTIAL_SWEEP_INTERVAL_MS);
		}
		await this.scheduleAlarm();
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
		// 失効した端末へのプッシュの再送待ちは届け先が無いので消す
		this.sql.exec('DELETE FROM push_queue WHERE mobileId = ?', body.mobileId);
		// 1000 で閉じるとアプリは理由を知らずに張り直し続ける。アプリが認証拒否として扱う 4404 で閉じる
		// （4410 は新しいアプリしか知らないので、まだ使わない）
		for (const ws of this.state.getWebSockets(`m:${body.mobileId}`)) {
			try { ws.close(PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE, 'revoked'); } catch { /* ignore */ }
		}
		return Response.json({ ok: true });
	}

	// モバイル(mobileToken保持者)自身によるペアリング解除。トークンは対象 mobileId 本人の
	// ものと一致する必要があるため、自分の資格情報しか削除できない。
	private async selfRevokeMobile(request: Request): Promise<Response> {
		const body = await request.json<{ mobileId?: string }>().catch(() => ({} as { mobileId?: string }));
		if (typeof body.mobileId !== 'string') {
			return Response.json({ error: 'missing mobileId' }, { status: 400 });
		}
		const record = this.mobile(body.mobileId);
		const token = extractToken(request);
		if (!record || token === null || !timingSafeEqualHex(await hashToken(token), record.tokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		this.sql.exec('DELETE FROM mobiles WHERE mobileId = ?', body.mobileId);
		this.sql.exec('DELETE FROM push_queue WHERE mobileId = ?', body.mobileId);
		for (const ws of this.state.getWebSockets(`m:${body.mobileId}`)) {
			try { ws.close(1000, 'revoked'); } catch { /* ignore */ }
		}
		// PC側にも通知し、PCの登録デバイス一覧から取り除けるようにする。
		this.sendToPc({ type: 'mobile-revoked', mobileId: body.mobileId });
		return Response.json({ ok: true });
	}

	/**
	 * WebRTCミラー用のTURN短期資格情報の発行（mobileToken認証、Cloudflare Realtime TURN）。
	 * シークレット（TURN_KEY_ID / TURN_KEY_API_TOKEN）未設定の環境では空のiceServersを返し、
	 * クライアントはSTUNのみで続行する（機能ゲート）。TURNはDTLSを終端しない純中継のため
	 * E2E方針に抵触しない（SFUは使わない）。
	 */
	private async turnCredentials(request: Request): Promise<Response> {
		const body = await request.json<{ mobileId?: string }>().catch(() => ({} as { mobileId?: string }));
		if (typeof body.mobileId !== 'string') {
			return Response.json({ error: 'missing mobileId' }, { status: 400 });
		}
		const record = this.mobile(body.mobileId);
		const token = extractToken(request);
		if (!record || token === null || !timingSafeEqualHex(await hashToken(token), record.tokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		this.touchMobile(body.mobileId);
		// デバイス単位の発行レート制限。1リクエストごとにCloudflare TURN APIへの外部fetchが
		// 走るため、暴走クライアントによるクォータ消費を抑える（インメモリで十分:
		// DOのハイバネーションでリセットされても制限が緩む方向にしか倒れない）。
		// 429を受けたモバイル側は非okとして空のiceServers扱い＝STUNのみで続行する。
		const now = Date.now();
		this.turnIssueTimes = this.turnIssueTimes.filter(t => now - t < TURN_RATE_WINDOW_MS);
		if (this.turnIssueTimes.length >= TURN_RATE_MAX_PER_WINDOW) {
			return Response.json({ error: 'rate limited' }, { status: 429 });
		}
		this.turnIssueTimes.push(now);
		const env = this.env as { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string };
		if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
			return Response.json({ iceServers: [] });
		}
		try {
			const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
				method: 'POST',
				headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
				body: JSON.stringify({ ttl: 86_400 }),
				signal: AbortSignal.timeout(5_000),
			});
			if (!res.ok) {
				return Response.json({ iceServers: [] });
			}
			const data = await res.json<{ iceServers?: unknown }>();
			return Response.json({ iceServers: data.iceServers ?? [] });
		} catch {
			return Response.json({ iceServers: [] });
		}
	}

	// --- WebSocket accept ---------------------------------------------------------

	private async acceptPc(token: string, echoSubprotocol?: string): Promise<Response> {
		const device = this.device();
		if (!device || !timingSafeEqualHex(await hashToken(token), device.pcTokenHash)) {
			return new Response('unauthorized', { status: 401 });
		}
		// 既存PCソケットは閉じる（1本に限定）
		const superseded = this.state.getWebSockets('pc');
		for (const ws of superseded) {
			try { ws.close(1000, 'superseded'); } catch { /* ignore */ }
		}
		// 張り替え時はモバイルへ offline→online のフラップを見せる。webSocketClose の offline通知は
		// 「PCソケットが1本も無い」ときだけなので、張り替えでは発火しない。しかしPCが張り替える＝
		// PC側のE2Eセッションは破棄済みなので、モバイルが再ハンドシェイクしないまま旧muxで送り続けると
		// PCがそれをhelloと誤解して恒久的に無視する（acceptMobile側と同じ理由の措置）。
		if (superseded.length > 0) {
			this.notifyPcPresence(false);
		}
		// 失効を有効にしていれば掃除の予定を張る（PC がつながるのは頻繁なので、ここで張れば取りこぼさない）。
		// 失効が無効なら何もしない。予定を張れなくても PC の接続は止めない。
		if (mobileCredentialTtlMs(this.env) !== undefined) {
			try {
				await this.scheduleAlarm();
			} catch (err) {
				console.warn('[relay] failed to schedule the credential sweep', err);
			}
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, ['pc']), () => {
			this.notifyPcPresence(true);
			this.flushPcNotices();
		}, echoSubprotocol);
	}

	private async acceptMobile(mobileIdStr: string, token: string, echoSubprotocol?: string): Promise<Response> {
		const record = this.mobile(mobileIdStr);
		// 資格を認めないモバイルは、upgrade前のHTTP 401ではなく、受理してから理由コードで閉じる。
		// 401 だとスマホからは経路断と同じ close 1006 にしか見えず、取り消された端末が
		// 「再接続中」のまま永久に再試行していた（W2-04）。旧アプリは未知のcloseとして
		// 従来どおり再接続するだけで、401 のときと振る舞いは変わらない。
		if (!record) {
			return this.rejectWithClose(PARADIS_RELAY_CLOSE_CODE.UNKNOWN_MOBILE, 'unknown mobile', echoSubprotocol);
		}
		if (!timingSafeEqualHex(await hashToken(token), record.tokenHash)) {
			return this.rejectWithClose(PARADIS_RELAY_CLOSE_CODE.CREDENTIAL_REFUSED, 'unauthorized', echoSubprotocol);
		}
		// 資格を使った時刻（W2-35。使われていない資格の失効の元）。
		this.touchMobile(mobileIdStr);
		// 同一モバイルの既存ソケットは閉じる（1本に限定）。iOSがバックグラウンドで
		// ソケットをhalf-openのまま放置した場合、これが残っていると再接続時に
		// 「offline通知が飛ばない→PC側が古いE2Eセッションを保持し続ける→新しい
		// ハンドシェイクを復号失敗で無視し続ける」恒久ループになる（acceptPcと同様の措置）。
		const superseded = this.state.getWebSockets(`m:${mobileIdStr}`);
		for (const ws of superseded) {
			try { ws.close(1000, 'superseded'); } catch { /* ignore */ }
		}
		if (superseded.length > 0) {
			this.sendToPc({ type: 'presence', peer: 'mobile', mobileId: mobileIdStr, online: false });
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, [`m:${mobileIdStr}`]), () => {
			// PCにモバイルのpresenceを通知
			this.sendToPc({ type: 'presence', peer: 'mobile', mobileId: mobileIdStr, online: true });
			// モバイルに現在のPC接続状態を通知
			this.sendToTag(`m:${mobileIdStr}`, { type: 'presence', peer: 'pc', online: this.state.getWebSockets('pc').length > 0 });
		}, echoSubprotocol);
	}

	private async acceptPairing(pairId: string, token: string, echoSubprotocol?: string): Promise<Response> {
		this.cleanupPairings();
		const row = this.sql.exec('SELECT pairId, tokenHash, expiresAt FROM pending WHERE pairId = ?', pairId).toArray()[0];
		if (!row || !timingSafeEqualHex(await hashToken(token), row.tokenHash as string)) {
			return new Response('unauthorized', { status: 401 });
		}
		return this.upgrade(ws => this.state.acceptWebSocket(ws, [`pair:${pairId}`]), undefined, echoSubprotocol);
	}

	private mobile(mobileIdStr: string): MobileRecord | null {
		const row = this.sql.exec('SELECT mobileId, name, tokenHash, createdAt FROM mobiles WHERE mobileId = ?', mobileIdStr).toArray()[0];
		return row ? { mobileId: row.mobileId as string, name: row.name as string, tokenHash: row.tokenHash as string, createdAt: row.createdAt as number } : null;
	}

	/**
	 * WebSocketを受理した直後に理由コード付きで閉じる。hibernation 用の acceptWebSocket は使わない
	 * （タグを付けて残す理由が無い。閉じたソケットはDOに何も残さない）。
	 */
	private rejectWithClose(code: number, reason: string, echoSubprotocol?: string): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();
		server.close(code, reason);
		const headers = echoSubprotocol ? { 'Sec-WebSocket-Protocol': echoSubprotocol } : undefined;
		return new Response(null, { status: 101, webSocket: client, headers });
	}

	private upgrade(accept: (ws: WebSocket) => void, onOpen: (() => void) | undefined, echoSubprotocol?: string): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		accept(server);
		onOpen?.();
		// finding #7: クライアントが para-auth.<token> サブプロトコルを提示した場合は
		// RFC6455準拠でそのまま選択subprotocolとしてechoする（厳格なクライアント互換）。
		const headers = echoSubprotocol ? { 'Sec-WebSocket-Protocol': echoSubprotocol } : undefined;
		return new Response(null, { status: 101, webSocket: client, headers });
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
			// つなぎっぱなしのスマホも「使っている」として残す（W2-35。1時間に1回まで）。
			this.touchMobile(mobileIdStr);
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

		// 保活pingは通常エッジが自動応答するのでここには来ない。自動応答が効かない環境
		// （将来のランタイム変更など）で無応答になると、クライアントが死活判定を諦めて保活が
		// 静かに無効化されるだけなので、DO側でも応答できるようにしておく。
		// ペアリングソケットは上で return 済み＝対象外。保活するのはPC/モバイルの常時接続だけ。
		if (msg.type === 'ping') {
			try { ws.send(PARADIS_RELAY_KEEPALIVE_PONG); } catch { /* 送れないソケットは間もなく閉じる */ }
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
				// 拒否したペアリングは即座に無効化する。pending を残したままだと、PCが後から
				// 同じ pairId を承認できてしまい「拒否した」が守られない。
				this.sql.exec('DELETE FROM pending WHERE pairId = ?', msg.pairId);
				for (const ws of this.state.getWebSockets(`pair:${msg.pairId}`)) {
					try { ws.close(1000, 'rejected'); } catch { /* ignore */ }
				}
			} else if (msg.type === 'push-notify') {
				const requestId = pushIdOrUndefined(msg.requestId);
				if (requestId !== undefined) {
					await this.pushNotifyDurably(ws, requestId, msg.mobileId, msg.payload, pushIdOrUndefined(msg.collapseId), pushIdOrUndefined(msg.threadId));
				} else {
					await this.pushNotify(msg.mobileId, msg.payload, pushIdOrUndefined(msg.collapseId), pushIdOrUndefined(msg.threadId));
				}
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

	private async pushNotify(mobileId: string, payload: string, collapseId: string | undefined, threadId: string | undefined): Promise<void> {
		if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > MAX_PUSH_PAYLOAD_BYTES) {
			console.warn('[push] payload missing or too large; dropping');
			return;
		}
		// ここでソケットの有無を見てはいけない。iOSはアプリをバックグラウンドへ回しても
		// ソケットをhalf-openのまま放置する（acceptMobile のコメント参照）ので、
		// 「ソケットが残っている＝アプリが受け取れる」は成り立たない。以前ここに同じ判定が
		// あったせいで、PCが「このアプリは応答が無いからプッシュが要る」と判断して送っても
		// リレーが無言で捨て、通知が誰にも届かないまま消えていた。
		// 送るかどうかはPCが決める（`paradisNotifyDelivery.ts`。PCは最後にモバイルから
		// 実際に何か受け取った時刻で判断していて、リレーより確かな材料を持っている）。
		const expiresAtSeconds = Math.floor(Date.now() / 1000) + PUSH_EXPIRATION_SECONDS;
		// PC が collapseId を付けない通知（許可・質問）には、この通知だけの乱数を付けて送る。応答の無い
		// 通信失敗の後に送り直して APNs が先の1通も受理していた場合、通知センターでは1件に置き換わる
		// （ただし届くたびにバナーと音が出うる。鳴らないことまでは保証しない）。
		// 通知ごとの乱数なので、別の通知どうしを紐付ける手掛かりにはならない（置き換えもしない）。
		const pushCollapseId = collapseId ?? randomTokenB64u(16);
		const result = await this.sendPushOnce({ mobileId, payload, collapseId: pushCollapseId, threadId, expiresAtSeconds });
		if (result?.kind === 'retry') {
			// PCはこの通知を「プッシュで鳴らすからフレームでは鳴らすな」と送り済みのことがある。
			// ここで落とすとその通知は一度も鳴らないので、一時的な失敗は後で送り直す（W2-07）。
			// 送り直しでも同じ collapseId を使う（行に保存する）。
			this.enqueuePushRetry({ mobileId, payload, collapseId: pushCollapseId, threadId, attempt: 1, expiresAtSeconds }, result.retryAfterMs);
			await this.scheduleAlarm();
		}
	}

	/**
	 * 依頼 ID 付きの push-notify（push.ack.v1）。APNs へ送る前に依頼と再送待ちの行を SQL へ書き、書けたら
	 * PC へ push-ack を返す（PC はそれを見て自分の outbox から外す）。同じ依頼 ID がもう一度来たら、送らずに
	 * もう一度 push-ack だけ返す（PC の送り直しで二重に鳴らさない）。結果（送れた・再送待ち）は後から行に残す。
	 */
	private async pushNotifyDurably(ws: WebSocket, requestId: string, mobileId: string, payload: string, collapseId: string | undefined, threadId: string | undefined): Promise<void> {
		const now = Date.now();
		this.sql.exec('DELETE FROM push_requests WHERE at < ?', now - PUSH_REQUEST_RETENTION_MS);
		if (this.sql.exec('SELECT requestId FROM push_requests WHERE requestId = ?', requestId).toArray().length > 0) {
			this.sendPushAck(ws, requestId, 'accepted');
			return;
		}
		if (typeof payload !== 'string' || typeof mobileId !== 'string' || new TextEncoder().encode(payload).length > MAX_PUSH_PAYLOAD_BYTES) {
			console.warn('[push] payload missing or too large; dropping');
			// 送り直しても変わらないので、PC には受け取ったと返して outbox から外させる
			this.sendPushAck(ws, requestId, 'rejected');
			return;
		}
		const expiresAtSeconds = Math.floor(now / 1000) + PUSH_EXPIRATION_SECONDS;
		const pushCollapseId = collapseId ?? randomTokenB64u(16);
		this.sql.exec('INSERT INTO push_requests (requestId, at) VALUES (?, ?)', requestId, now);
		this.sql.exec('DELETE FROM push_requests WHERE requestId NOT IN (SELECT requestId FROM push_requests ORDER BY at DESC LIMIT ?)', MAX_PUSH_REQUEST_ROWS);
		// 送る前に行を置く。送っている間に落ちても alarm が送り直す（行は送り終えてから消す）
		const id = this.insertPushRow({ mobileId, payload, collapseId: pushCollapseId, threadId, attempt: 0, expiresAtSeconds }, now + PUSH_SEND_LEASE_MS);
		await this.scheduleAlarm();
		this.sendPushAck(ws, requestId, 'accepted');
		await this.sendQueuedPush({ id, mobileId, payload, collapseId: pushCollapseId, threadId, attempt: 0, expiresAtSeconds });
		await this.scheduleAlarm();
	}

	private sendPushAck(ws: WebSocket, requestId: string, result: 'accepted' | 'rejected'): void {
		try { ws.send(encodeRelayControl({ type: 'push-ack', requestId, result })); } catch { /* PC は送り直すので、その時にまた返す */ }
	}

	private insertPushRow(push: Omit<QueuedPush, 'id'>, nextAt: number): number {
		const row = this.sql.exec(
			'INSERT INTO push_queue (mobileId, payload, collapseId, threadId, attempt, nextAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
			push.mobileId, push.payload, push.collapseId ?? null, push.threadId ?? null, push.attempt, nextAt, push.expiresAtSeconds,
		).toArray()[0];
		this.sql.exec('DELETE FROM push_queue WHERE id NOT IN (SELECT id FROM push_queue ORDER BY id DESC LIMIT ?)', MAX_PUSH_QUEUE_ROWS);
		return row!.id as number;
	}

	/**
	 * 行に置いたプッシュを1回送り、結果を行へ書く。送れた・送り先が無い・送り直しても変わらない失敗なら行を消し、
	 * 一時的な失敗なら次の時刻を書く（上限・有効期限を超えるなら消す）。送信が例外で終わったら、行は貸し出しの
	 * 期限まで残し、その後に送り直す（失敗の回数は数える）。
	 */
	private async sendQueuedPush(push: QueuedPush): Promise<void> {
		this.sql.exec('UPDATE push_queue SET nextAt = ? WHERE id = ?', Date.now() + PUSH_SEND_LEASE_MS, push.id);
		let result: ApnsSendResult | undefined;
		try {
			result = await this.sendPushOnce(push);
		} catch (err) {
			console.warn('[push] send failed:', err);
			this.reschedulePushRow(push, undefined, Date.now() + PUSH_SEND_LEASE_MS);
			return;
		}
		if (result?.kind === 'retry') {
			this.reschedulePushRow(push, result.retryAfterMs);
			return;
		}
		this.sql.exec('DELETE FROM push_queue WHERE id = ?', push.id);
	}

	/** 失敗を1回数えて次の時刻を書く。上限を超えた・有効期限までに送れないなら消す。 */
	private reschedulePushRow(push: QueuedPush, retryAfterMs: number | undefined, at?: number): void {
		const attempt = push.attempt + 1;
		const nextAt = at ?? Date.now() + pushRetryDelayMs(attempt, retryAfterMs, Math.random());
		if (attempt > PUSH_MAX_RETRIES || nextAt >= push.expiresAtSeconds * 1000) {
			if (attempt > PUSH_MAX_RETRIES) {
				console.warn('[push] giving up after retries');
			}
			this.sql.exec('DELETE FROM push_queue WHERE id = ?', push.id);
			return;
		}
		this.sql.exec('UPDATE push_queue SET attempt = ?, nextAt = ? WHERE id = ?', attempt, nextAt, push.id);
	}

	/**
	 * 登録済みトークンへ1回だけ送る。トークンが無い（未登録・削除済み・モバイル自体が解除済み）
	 * なら undefined。トークンが失効していれば、ここで消す。
	 */
	private async sendPushOnce(push: Omit<QueuedPush, 'id' | 'attempt'>): Promise<ApnsSendResult | undefined> {
		const row = this.sql.exec('SELECT apnsToken, apnsEnv FROM mobiles WHERE mobileId = ?', push.mobileId).toArray()[0];
		if (!row || !row.apnsToken) {
			return undefined;
		}
		const token = row.apnsToken as string;
		const apnsEnv = (row.apnsEnv as string | null) === 'dev' ? 'dev' : 'prod';
		const result = await sendApnsNotification(this.env as ApnsEnv, {
			token,
			env: apnsEnv,
			payload: push.payload,
			expiresAtSeconds: push.expiresAtSeconds,
			...(push.collapseId !== undefined ? { collapseId: push.collapseId } : {}),
			...(push.threadId !== undefined ? { threadId: push.threadId } : {}),
		}, this.apnsJwtCache);
		if (result.kind === 'drop-token') {
			// 410 Unregistered / 400 BadDeviceToken: 失効・不正なトークンをDBから消す。
			// 送った後にアプリが別のトークンを登録し直していたら、そちらは消さない。
			this.sql.exec('UPDATE mobiles SET apnsToken = NULL, apnsEnv = NULL WHERE mobileId = ? AND apnsToken = ?', push.mobileId, token);
		}
		return result;
	}

	private enqueuePushRetry(push: Omit<QueuedPush, 'id'>, retryAfterMs: number | undefined): void {
		if (push.attempt > PUSH_MAX_RETRIES) {
			console.warn('[push] giving up after retries');
			return;
		}
		const nextAt = Date.now() + pushRetryDelayMs(push.attempt, retryAfterMs, Math.random());
		// 次の送信が有効期限を過ぎるなら、APNsはどのみち配送しない。
		if (nextAt >= push.expiresAtSeconds * 1000) {
			return;
		}
		this.insertPushRow(push, nextAt);
	}

	/**
	 * 送信時刻が来た再送待ちを送る（alarm から呼ぶ）。行は送り終えてから消す（送る前に消すと、送っている間に
	 * 落ちたときに通知が消える）。送っている間は貸し出しの時刻を書いておき、落ちたらその後に送り直す
	 * （同じ apns-collapse-id なので、届いていても端末上で置き換わる）。
	 */
	private async flushPushQueue(): Promise<void> {
		const now = Date.now();
		const due = this.sql.exec('SELECT id, mobileId, payload, collapseId, threadId, attempt, expiresAt FROM push_queue WHERE nextAt <= ? ORDER BY nextAt LIMIT ?', now, MAX_PUSH_QUEUE_ROWS).toArray();
		for (const raw of due) {
			const push: QueuedPush = {
				id: raw.id as number,
				mobileId: raw.mobileId as string,
				payload: raw.payload as string,
				collapseId: (raw.collapseId as string | null) ?? undefined,
				threadId: (raw.threadId as string | null) ?? undefined,
				attempt: raw.attempt as number,
				expiresAtSeconds: raw.expiresAt as number,
			};
			if (push.expiresAtSeconds * 1000 <= Date.now()) {
				this.sql.exec('DELETE FROM push_queue WHERE id = ?', push.id);
				continue;
			}
			await this.sendQueuedPush(push);
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
		this.sql.exec('INSERT INTO mobiles (mobileId, name, tokenHash, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)', mobileId, name || 'device', tokenHash, Date.now(), Date.now());
		const deviceId = this.state.id.toString();
		// C-1: 資格情報は承認対象の pairId ソケットにのみ渡す（全pairソケットへのブロードキャストは
		// mobileToken 漏洩になる）。
		this.sendToTag(`pair:${pairId}`, { type: 'paired', deviceId, mobileId, mobileToken });
		// PCへも mobileId を通知する（PCは直前のpairing-msgで得たモバイル公開鍵を
		// この mobileId に紐付けて保存し、以後のデータ接続の相手鍵とする）。mobileTokenは
		// モバイル専用の秘密なのでPCには送らず空にする。
		this.sendToPc({ type: 'paired', deviceId, mobileId, mobileToken: '' });
		// 承認した時点で pending 行は消しているので、この pair ソケットは以後 cleanupPairings の
		// TTL掃除の対象にならない。モバイル側の PairingClient は 'paired' を受けたら自己closeする
		// が、強制終了・half-open 等でそれが起きないと hibernated WS として残り続ける。用が済んだ
		// ソケットはサーバ側からも閉じる（失効ソケットと同じ扱い）。
		for (const ws of this.state.getWebSockets(`pair:${pairId}`)) {
			try { ws.close(1000, 'paired'); } catch { /* ignore */ }
		}
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
		// finding #8: 同role/同idの残存ソケットが無いときのみoffline通知する。
		// クローズ済みソケットは getWebSockets から除外されるため残数で判定できる。
		// これが無いと、PC再接続(supersede)や同一mobileIdの再接続レースで、旧ソケットの
		// close配送が新接続のonline通知の後に届き、恒久的な偽オフライン表示になる。
		if (tag === 'pc') {
			if (this.state.getWebSockets('pc').length === 0) {
				this.notifyPcPresence(false);
			}
		} else if (tag.startsWith('m:')) {
			if (this.state.getWebSockets(tag).length === 0) {
				this.sendToPc({ type: 'presence', peer: 'mobile', mobileId: tag.slice(2), online: false });
			}
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws);
	}
}

/** PCが付けてきた collapseId / threadId を検証する。形が外れていれば使わない（プッシュ自体は送る）。 */
function pushIdOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && PARADIS_PUSH_ID_PATTERN.test(value) ? value : undefined;
}
