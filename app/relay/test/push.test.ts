// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * APNsプッシュ経路のテスト:
 *  - register-push の保存とトークンバリデーション
 *  - push-notify の登録token送信（ソケットのonline状態によらず送る）
 *  - APNs fetch のモックによるヘッダ/ボディ形状の検証と JWTキャッシュ再利用
 *  - 410 Unregistered / 400 BadDeviceToken でのトークン削除
 *  - 429 / 5xx の再送（SQLの待ち行列 + alarm。Retry-After の尊重と回数上限）
 *  - apns-collapse-id / thread-id の受け渡し（形の外れた値は捨てる）
 *
 * APNsシークレットは vitest.config.ts の miniflare.bindings に使い捨てP-256鍵で注入している。
 */

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { decodeRelayControl, encodeRelayControl, generateIdentity, toBase64Url } from '@para/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyApnsFailure, parseRetryAfter } from '../src/apns.js';
import { PUSH_MAX_RETRIES, PUSH_RETRY_AFTER_MAX_MS, pushRetryDelayMs } from '../src/pushRetry.js';

class BufferedSocket {
	readonly ws: WebSocket;
	private readonly queue: (string | ArrayBuffer)[] = [];
	private waiter: ((v: string | ArrayBuffer) => void) | null = null;

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.addEventListener('message', event => {
			const data = event.data as string | ArrayBuffer;
			if (this.waiter) {
				const w = this.waiter;
				this.waiter = null;
				w(data);
			} else {
				this.queue.push(data);
			}
		});
	}

	next(timeoutMs = 2000): Promise<string | ArrayBuffer> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.waiter = null; reject(new Error('ws message timeout')); }, timeoutMs);
			this.waiter = v => { clearTimeout(timer); resolve(v); };
		});
	}

	/** 指定typeの制御メッセージが来るまで読み飛ばす。 */
	async nextControlOfType(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const data = await this.next(Math.max(1, deadline - Date.now()));
			if (typeof data === 'string') {
				const msg = decodeRelayControl(data) as unknown as Record<string, unknown>;
				if (msg.type === type) {
					return msg;
				}
			}
		}
	}

	send(data: string): void {
		this.ws.send(data);
	}

	close(): void {
		try { this.ws.close(); } catch { /* ignore */ }
	}
}

const openSockets: BufferedSocket[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const s of openSockets.splice(0)) {
		s.close();
	}
});

async function openWs(url: string): Promise<BufferedSocket> {
	const res = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const buffered = new BufferedSocket(ws);
	openSockets.push(buffered);
	return buffered;
}

async function provisionDevice(): Promise<{ deviceId: string; pcToken: string }> {
	const pc = generateIdentity();
	const pcToken = 'pc-token-' + Math.random().toString(36).slice(2);
	const res = await SELF.fetch('https://relay/device/new/provision', {
		method: 'POST',
		body: JSON.stringify({ pcPublicKey: toBase64Url(pc.publicKey), pcToken }),
	});
	expect(res.ok).toBe(true);
	const body = await res.json<{ deviceId: string }>();
	return { deviceId: body.deviceId, pcToken };
}

/** provision → pcソケット → ペアリング承認まで通し、モバイル資格情報を得る。 */
async function pairMobile(): Promise<{ deviceId: string; pcToken: string; pcWs: BufferedSocket; mobileId: string; mobileToken: string }> {
	const { deviceId, pcToken } = await provisionDevice();
	const pcWs = await openWs(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`);
	const pair = await (await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` } })).json<{ pairId: string; pairingToken: string }>();
	const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);

	pairWs.send(encodeRelayControl({ type: 'pairing-msg', data: 'aGVsbG8' }));
	await pcWs.nextControlOfType('pairing-msg');
	pcWs.send(encodeRelayControl({ type: 'pairing-approve', pairId: pair.pairId, name: 'iPhone' }));
	const paired = await pairWs.nextControlOfType('paired');
	pairWs.close();
	return { deviceId, pcToken, pcWs, mobileId: paired.mobileId as string, mobileToken: paired.mobileToken as string };
}

/** モバイルを接続し、presence交換を消費して返す。 */
async function connectMobile(deviceId: string, mobileId: string, mobileToken: string, pcWs: BufferedSocket): Promise<BufferedSocket> {
	const mobileWs = await openWs(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=${mobileId}&token=${mobileToken}`);
	await pcWs.nextControlOfType('presence'); // PC: mobile online
	await mobileWs.nextControlOfType('presence'); // mobile: pc presence
	return mobileWs;
}

const VALID_APNS_TOKEN = 'a'.repeat(64);

function stubFetch(status = 200, reason?: string, headers?: Record<string, string>): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(reason !== undefined ? JSON.stringify({ reason }) : null, { status, headers }));
}

function deviceStub(deviceId: string) {
	return env.DEVICES.get(env.DEVICES.idFromString(deviceId));
}

interface QueueRow { attempt: number; nextAt: number; expiresAt: number; collapseId: string | null }

async function readQueue(deviceId: string): Promise<QueueRow[]> {
	return runInDurableObject(deviceStub(deviceId), (_instance, state) =>
		state.storage.sql.exec('SELECT attempt, nextAt, expiresAt, collapseId FROM push_queue ORDER BY id').toArray() as unknown as QueueRow[]);
}

/** 再送待ちを「今が送信時刻」にしてから alarm を走らせる（実時間の待ちを省く）。 */
async function runDueRetries(deviceId: string): Promise<void> {
	await runInDurableObject(deviceStub(deviceId), (_instance, state) => {
		state.storage.sql.exec('UPDATE push_queue SET nextAt = 0');
	});
	await runDurableObjectAlarm(deviceStub(deviceId));
}

/** register-push 済みのオフラインのモバイルを用意する。 */
async function offlineMobileWithToken(): Promise<{ deviceId: string; pcWs: BufferedSocket; mobileId: string }> {
	const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
	const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
	mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
	mobileWs.close();
	await pcWs.nextControlOfType('presence');
	return { deviceId, pcWs, mobileId };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timeout');
		}
		await new Promise(r => setTimeout(r, 5));
	}
}

describe('relay APNs push', () => {
	it('sends an APNs request when the target mobile is offline (headers + body shape)', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN, env: 'dev' }));

		// オフライン化: モバイルを閉じ、PCがpresence(offline)を受けるまで待つ（server側close処理の完了）。
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		const payload = toBase64Url(new TextEncoder().encode('ciphertext-blob'));
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);

		const [urlArg, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(urlArg).toBe(`https://api.sandbox.push.apple.com/3/device/${VALID_APNS_TOKEN}`);
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toMatch(/^bearer eyJ/);
		expect(headers['apns-topic']).toBe('ltd.paradis.paracode.mobile');
		expect(headers['apns-push-type']).toBe('alert');
		expect(headers['apns-priority']).toBe('10');
		expect(Number(headers['apns-expiration'])).toBeGreaterThan(Math.floor(Date.now() / 1000));
		const body = JSON.parse(init.body as string) as { aps: Record<string, unknown>; e: string };
		expect(body.e).toBe(payload);
		expect(body.aps['mutable-content']).toBe(1);
	});

	it('sends once to the registered token when the mobile is online', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		// register-pushが処理されるまで少し待つ（順序保証のため小休止）。
		await new Promise(r => setTimeout(r, 50));

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [urlArg, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(urlArg).toBe(`https://api.push.apple.com/3/device/${VALID_APNS_TOKEN}`);
		const body = JSON.parse(init.body as string) as { e: string };
		expect(body.e).toBe('AAAA');
	});

	it('rejects an invalid apns token (no push is sent)', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: 'not-a-valid-hex-token' }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await new Promise(r => setTimeout(r, 150));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reuses the cached JWT across pushes', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await waitFor(() => fetchMock.mock.calls.length >= 2);

		const auth1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
		const auth2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
		expect(auth1.authorization).toBe(auth2.authorization);
	});

	it('drops the apns token on 410 Unregistered', async () => {
		const { deviceId, pcWs, mobileId, mobileToken } = await pairMobile();
		const mobileWs = await connectMobile(deviceId, mobileId, mobileToken, pcWs);
		mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
		mobileWs.close();
		await pcWs.nextControlOfType('presence');

		const gone = stubFetch(410);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => gone.mock.calls.length >= 1);
		vi.restoreAllMocks();

		// トークンは削除されたはず: 次の push-notify では fetch されない。
		const after = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await new Promise(r => setTimeout(r, 150));
		expect(after).not.toHaveBeenCalled();
	});

	it('drops the apns token on 400 BadDeviceToken as well', async () => {
		const { pcWs, mobileId } = await offlineMobileWithToken();

		const bad = stubFetch(400, 'BadDeviceToken');
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => bad.mock.calls.length >= 1);
		vi.restoreAllMocks();

		const after = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await new Promise(r => setTimeout(r, 150));
		expect(after).not.toHaveBeenCalled();
	});

	it('keeps the token and does not retry on other 400s', async () => {
		const { deviceId, pcWs, mobileId } = await offlineMobileWithToken();

		const bad = stubFetch(400, 'PayloadTooLarge');
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => bad.mock.calls.length >= 1);
		await new Promise(r => setTimeout(r, 50));
		expect(await readQueue(deviceId)).toEqual([]);
		vi.restoreAllMocks();

		const after = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB' }));
		await waitFor(() => after.mock.calls.length >= 1);
	});

	it('retries a 503 from the alarm with the same expiration, then clears the queue', async () => {
		const { deviceId, pcWs, mobileId } = await offlineMobileWithToken();

		const failing = stubFetch(503, 'ServiceUnavailable');
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => failing.mock.calls.length >= 1);
		await new Promise(r => setTimeout(r, 50));
		const queued = await readQueue(deviceId);
		expect(queued.map(row => row.attempt)).toEqual([1]);
		const alarm = await runInDurableObject(deviceStub(deviceId), (_instance, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		const firstExpiration = ((failing.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)['apns-expiration'];
		vi.restoreAllMocks();

		const ok = stubFetch(200);
		await runDueRetries(deviceId);
		expect(ok).toHaveBeenCalledTimes(1);
		const retried = (ok.mock.calls[0]![1] as RequestInit);
		expect((retried.headers as Record<string, string>)['apns-expiration']).toBe(firstExpiration);
		expect((JSON.parse(retried.body as string) as { e: string }).e).toBe('AAAA');
		expect(await readQueue(deviceId)).toEqual([]);
	});

	it('honors Retry-After when scheduling the retry', async () => {
		const { deviceId, pcWs, mobileId } = await offlineMobileWithToken();

		const before = Date.now();
		const limited = stubFetch(429, 'TooManyRequests', { 'retry-after': '120' });
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => limited.mock.calls.length >= 1);
		await new Promise(r => setTimeout(r, 50));
		const [row] = await readQueue(deviceId);
		expect(row!.nextAt).toBeGreaterThanOrEqual(before + 120_000);
	});

	it('gives up after the retry limit', async () => {
		const { deviceId, pcWs, mobileId } = await offlineMobileWithToken();

		const failing = stubFetch(500, 'InternalServerError');
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => failing.mock.calls.length >= 1);
		await new Promise(r => setTimeout(r, 50));
		for (let i = 0; i < PUSH_MAX_RETRIES; i++) {
			await runDueRetries(deviceId);
		}
		expect(failing).toHaveBeenCalledTimes(1 + PUSH_MAX_RETRIES);
		expect(await readQueue(deviceId)).toEqual([]);
	});

	it('does not resend a queued push once the mobile has been revoked', async () => {
		const { deviceId, pcToken, pcWs, mobileId } = await (async () => {
			const paired = await pairMobile();
			const mobileWs = await connectMobile(paired.deviceId, paired.mobileId, paired.mobileToken, paired.pcWs);
			mobileWs.send(encodeRelayControl({ type: 'register-push', token: VALID_APNS_TOKEN }));
			mobileWs.close();
			await paired.pcWs.nextControlOfType('presence');
			return paired;
		})();

		const failing = stubFetch(503);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA' }));
		await waitFor(() => failing.mock.calls.length >= 1);
		await new Promise(r => setTimeout(r, 50));
		vi.restoreAllMocks();
		const revoke = await SELF.fetch(`https://relay/device/${deviceId}/mobile/revoke`, { method: 'POST', headers: { authorization: `Bearer ${pcToken}` }, body: JSON.stringify({ mobileId }) });
		expect(revoke.ok).toBe(true);

		const after = stubFetch(200);
		await runDueRetries(deviceId);
		expect(after).not.toHaveBeenCalled();
	});

	it('passes an opaque collapse id and thread id through, and ignores malformed ones', async () => {
		const { pcWs, mobileId } = await offlineMobileWithToken();

		const fetchMock = stubFetch(200);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'AAAA', collapseId: 'c0llapse_Id-123', threadId: 'thread-0123456789' }));
		await waitFor(() => fetchMock.mock.calls.length >= 1);
		pcWs.send(encodeRelayControl({ type: 'push-notify', mobileId, payload: 'BBBB', collapseId: 'has space', threadId: 'x'.repeat(65) }));
		await waitFor(() => fetchMock.mock.calls.length >= 2);

		const shape = (call: unknown[]) => {
			const init = call[1] as RequestInit;
			const body = JSON.parse(init.body as string) as { aps: Record<string, unknown> };
			return { collapse: (init.headers as Record<string, string>)['apns-collapse-id'], thread: body.aps['thread-id'] };
		};
		expect([shape(fetchMock.mock.calls[0]!), shape(fetchMock.mock.calls[1]!)]).toEqual([
			{ collapse: 'c0llapse_Id-123', thread: 'thread-0123456789' },
			{ collapse: undefined, thread: undefined },
		]);
	});
});

describe('APNs failure classification', () => {
	it('sorts status codes into drop / retry / fail', () => {
		const now = Date.parse('2026-09-28T00:00:00Z');
		expect([
			classifyApnsFailure(410, 'Unregistered', null, now).kind,
			classifyApnsFailure(400, 'BadDeviceToken', null, now).kind,
			classifyApnsFailure(400, 'DeviceTokenNotForTopic', null, now).kind,
			classifyApnsFailure(400, 'BadCollapseId', null, now).kind,
			classifyApnsFailure(403, 'InvalidProviderToken', null, now).kind,
			classifyApnsFailure(403, 'ExpiredProviderToken', null, now).kind,
			classifyApnsFailure(429, 'TooManyRequests', '3', now),
			classifyApnsFailure(500, 'InternalServerError', null, now).kind,
			classifyApnsFailure(503, 'ServiceUnavailable', 'Sun, 28 Sep 2026 00:00:10 GMT', now),
		]).toEqual([
			'drop-token',
			'drop-token',
			'drop-token',
			'failed',
			'failed',
			'retry',
			{ kind: 'retry', status: 429, reason: 'TooManyRequests', retryAfterMs: 3_000 },
			'retry',
			{ kind: 'retry', status: 503, reason: 'ServiceUnavailable', retryAfterMs: 10_000 },
		]);
		expect([parseRetryAfter(null, now), parseRetryAfter('garbage', now), parseRetryAfter('-5', now)]).toEqual([undefined, undefined, 0]);
	});

	it('backs off 1s -> 2s -> 4s with half jitter and never goes under Retry-After', () => {
		expect([
			[pushRetryDelayMs(1, undefined, 0), pushRetryDelayMs(1, undefined, 0.999)],
			[pushRetryDelayMs(2, undefined, 0), pushRetryDelayMs(2, undefined, 0.999)],
			[pushRetryDelayMs(3, undefined, 0), pushRetryDelayMs(3, undefined, 0.999)],
			pushRetryDelayMs(20, undefined, 0.999),
			pushRetryDelayMs(1, 120_000, 0.5),
			pushRetryDelayMs(1, 24 * 3600_000, 0.5),
		]).toEqual([
			[500, 999],
			[1_000, 1_999],
			[2_000, 3_998],
			29_985,
			120_000,
			PUSH_RETRY_AFTER_MAX_MS,
		]);
	});
});
