// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * W2-35: モバイルの資格を最後に使った時刻（lastSeenAt）の記録と、使われていない資格の失効。
 * 失効は環境変数 MOBILE_CREDENTIAL_TTL_DAYS を入れたときだけ動く（既定は無効。テストの環境にも入れていない）。
 */

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { decodeRelayControl, generateIdentity, toBase64Url } from '@para/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth.js';
import { MOBILE_LAST_SEEN_WRITE_INTERVAL_MS, mobileCredentialTtlMs } from '../src/deviceDO.js';

const DAY = 24 * 60 * 60 * 1000;
const openSockets: WebSocket[] = [];
afterEach(() => { for (const ws of openSockets.splice(0)) { try { ws.close(); } catch { /* ignore */ } } });

async function provisionDevice(): Promise<{ deviceId: string; pcToken: string }> {
	const pc = generateIdentity();
	const pcToken = 'pc-token-' + Math.random().toString(36).slice(2);
	const res = await SELF.fetch('https://relay/device/new/provision', { method: 'POST', body: JSON.stringify({ pcPublicKey: toBase64Url(pc.publicKey), pcToken }) });
	const body = await res.json<{ deviceId: string }>();
	return { deviceId: body.deviceId, pcToken };
}

function deviceStub(deviceId: string) {
	return env.DEVICES.get(env.DEVICES.idFromString(deviceId));
}

async function insertMobile(deviceId: string, mobileId: string, token: string, createdAt: number, lastSeenAt: number | null): Promise<void> {
	const tokenHash = await hashToken(token);
	await runInDurableObject(deviceStub(deviceId), (_instance, state) => {
		state.storage.sql.exec('INSERT INTO mobiles (mobileId, name, tokenHash, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)', mobileId, 'phone', tokenHash, createdAt, lastSeenAt);
	});
}

async function mobileRows(deviceId: string): Promise<{ mobileId: string; lastSeenAt: number | null }[]> {
	return runInDurableObject(deviceStub(deviceId), (_instance, state) => state.storage.sql.exec('SELECT mobileId, lastSeenAt FROM mobiles ORDER BY mobileId').toArray() as { mobileId: string; lastSeenAt: number | null }[]);
}

async function openWs(url: string): Promise<WebSocket> {
	const res = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	openSockets.push(ws);
	return ws;
}

describe('mobile credential expiry (W2-35)', () => {
	it('reads the TTL from MOBILE_CREDENTIAL_TTL_DAYS and is disabled unless set', () => {
		expect([
			mobileCredentialTtlMs({}),
			mobileCredentialTtlMs({ MOBILE_CREDENTIAL_TTL_DAYS: '0' }),
			mobileCredentialTtlMs({ MOBILE_CREDENTIAL_TTL_DAYS: 'abc' }),
			mobileCredentialTtlMs({ MOBILE_CREDENTIAL_TTL_DAYS: '90' }),
			mobileCredentialTtlMs({ MOBILE_CREDENTIAL_TTL_DAYS: 1 }),
		]).toEqual([undefined, undefined, undefined, 90 * DAY, 7 * DAY]);
		expect(mobileCredentialTtlMs(env)).toBeUndefined();
	});

	it('records when a mobile credential is used, at most once an hour', async () => {
		const { deviceId } = await provisionDevice();
		const now = Date.now();
		await insertMobile(deviceId, 'stale', 'token-stale', now - 200 * DAY, now - 200 * DAY);
		await insertMobile(deviceId, 'recent', 'token-recent', now - DAY, now - MOBILE_LAST_SEEN_WRITE_INTERVAL_MS / 2);
		await openWs(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=stale&token=token-stale`);
		await openWs(`https://relay/device/${deviceId}/ws?role=mobile&mobileId=recent&token=token-recent`);
		const rows = await mobileRows(deviceId);
		expect(rows.find(row => row.mobileId === 'stale')!.lastSeenAt!).toBeGreaterThanOrEqual(now);
		expect(rows.find(row => row.mobileId === 'recent')!.lastSeenAt).toBe(now - MOBILE_LAST_SEEN_WRITE_INTERVAL_MS / 2);
	});

	it('does not expire anything while disabled (the default)', async () => {
		const { deviceId } = await provisionDevice();
		await insertMobile(deviceId, 'old', 'token-old', Date.now() - 400 * DAY, Date.now() - 400 * DAY);
		await runInDurableObject(deviceStub(deviceId), async (_instance, state) => { await state.storage.setAlarm(Date.now()); });
		await runDurableObjectAlarm(deviceStub(deviceId));
		expect((await mobileRows(deviceId)).map(row => row.mobileId)).toEqual(['old']);
	});

	it('when enabled, removes unused credentials and tells the PC now or when it next connects', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const now = Date.now();
		await insertMobile(deviceId, 'unused', 'token-unused', now - 200 * DAY, now - 100 * DAY);
		await insertMobile(deviceId, 'legacy', 'token-legacy', now - 200 * DAY, null);
		await insertMobile(deviceId, 'active', 'token-active', now - 200 * DAY, now - DAY);
		const expired = await runInDurableObject(deviceStub(deviceId), instance => (instance as unknown as { sweepUnusedMobiles(ttlMs: number): string[] }).sweepUnusedMobiles(90 * DAY));
		expect([expired.sort(), (await mobileRows(deviceId)).map(row => row.mobileId)]).toEqual([['legacy', 'unused'], ['active']]);
		// PC がつながっていなかったので、次につながったときに伝える
		const pcRes = await SELF.fetch(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`, { headers: { Upgrade: 'websocket' } });
		const pcWs = pcRes.webSocket!;
		const messages: string[] = [];
		pcWs.addEventListener('message', event => messages.push(event.data as string));
		pcWs.accept();
		openSockets.push(pcWs);
		await new Promise(resolve => setTimeout(resolve, 50));
		const revoked = messages.map(text => decodeRelayControl(text)).filter(msg => msg.type === 'mobile-revoked').map(msg => (msg as { mobileId: string }).mobileId).sort();
		expect(revoked).toEqual(['legacy', 'unused']);
		const left = await runInDurableObject(deviceStub(deviceId), (_instance, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM pc_notices').toArray()[0]!.n);
		expect(left).toBe(0);
	});
});
