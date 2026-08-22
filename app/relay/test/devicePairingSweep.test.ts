// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * DeviceDO のペアリング用 `pair:<pairId>` WebSocket の期限切れ掃除 (cleanupPairings + alarm) を、
 * Cloudflare の公式ヘルパー (`runInDurableObject`/`runDurableObjectAlarm`) で DO の内部に
 * 直接アクセスして検証する。TTL を実際に待つ代わりに、pending 行の `expiresAt` をストレージ側から
 * 直接書き換えて期限切れを起こす。
 */

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { generateIdentity, toBase64Url } from '@para/protocol';
import { afterEach, describe, expect, it } from 'vitest';

const openSockets: WebSocket[] = [];
afterEach(() => { for (const ws of openSockets.splice(0)) { try { ws.close(); } catch { /* ignore */ } } });

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<CloseEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
		ws.addEventListener('close', event => { clearTimeout(timer); resolve(event as CloseEvent); }, { once: true });
	});
}

async function openWs(url: string): Promise<WebSocket> {
	const res = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	openSockets.push(ws);
	return ws;
}

async function provisionDevice(): Promise<{ deviceId: string; pcToken: string }> {
	const pc = generateIdentity();
	const pcToken = 'pc-token-' + Math.random().toString(36).slice(2);
	const res = await SELF.fetch('https://relay/device/new/provision', {
		method: 'POST',
		body: JSON.stringify({ pcPublicKey: toBase64Url(pc.publicKey), pcToken }),
	});
	const body = await res.json<{ deviceId: string }>();
	return { deviceId: body.deviceId, pcToken };
}

async function beginPairing(deviceId: string, pcToken: string): Promise<{ pairId: string; pairingToken: string }> {
	const res = await SELF.fetch(`https://relay/device/${deviceId}/pair/begin`, {
		method: 'POST',
		headers: { authorization: `Bearer ${pcToken}` },
	});
	return res.json<{ pairId: string; pairingToken: string }>();
}

function deviceStub(deviceId: string) {
	return env.DEVICES.get(env.DEVICES.idFromString(deviceId));
}

/** pending 行を直接書き換えて、TTL を待たずに期限切れにする。 */
async function expirePairing(deviceId: string, pairId: string): Promise<void> {
	await runInDurableObject(deviceStub(deviceId), (_instance, state) => {
		state.storage.sql.exec('UPDATE pending SET expiresAt = ? WHERE pairId = ?', 0, pairId);
	});
}

/** cleanupPairings は private だが、テストからは直接叩いて検証する。 */
async function callCleanupPairings(deviceId: string): Promise<void> {
	await runInDurableObject(deviceStub(deviceId), instance => {
		(instance as unknown as { cleanupPairings(): void }).cleanupPairings();
	});
}

describe('DeviceDO pairing socket sweep', () => {
	it('schedules a DO alarm once a pairing begins', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		await beginPairing(deviceId, pcToken);

		const alarmTime = await runInDurableObject(deviceStub(deviceId), (_instance, state) => state.storage.getAlarm());

		expect(alarmTime).not.toBeNull();
	});

	it('closes a pair: socket once cleanupPairings sees its pending row expired', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const pair = await beginPairing(deviceId, pcToken);
		const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);
		// register the listener before triggering the close, or the event fires unobserved
		const closePromise = waitForClose(pairWs);

		await expirePairing(deviceId, pair.pairId);
		await callCleanupPairings(deviceId);

		const closeEvent = await closePromise;
		expect(closeEvent.code).toBe(1000);
		expect(closeEvent.reason).toBe('expired');
	});

	it('leaves a pair: socket alone while its pending row has not expired', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const pair = await beginPairing(deviceId, pcToken);
		const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);
		const closePromise = waitForClose(pairWs, 100);

		// cleanupPairings runs for real here (not expired), the socket must survive it
		await callCleanupPairings(deviceId);

		await expect(closePromise).rejects.toThrow();
	});

	it('runs the alarm end to end: closes expired sockets and re-arms while pendings remain', async () => {
		const { deviceId, pcToken } = await provisionDevice();
		const expiring = await beginPairing(deviceId, pcToken);
		const expiringWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${expiring.pairId}&token=${expiring.pairingToken}`);
		const fresh = await beginPairing(deviceId, pcToken);
		const freshWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${fresh.pairId}&token=${fresh.pairingToken}`);
		const expiringClosePromise = waitForClose(expiringWs);
		const freshClosePromise = waitForClose(freshWs, 300);

		await expirePairing(deviceId, expiring.pairId);

		const ran = await runDurableObjectAlarm(deviceStub(deviceId));
		expect(ran).toBe(true);

		const closeEvent = await expiringClosePromise;
		expect(closeEvent.code).toBe(1000);
		expect(closeEvent.reason).toBe('expired');

		// the still-valid pairing's socket must survive the same alarm run
		await expect(freshClosePromise).rejects.toThrow();

		// a pending row is still outstanding (the fresh one), so the alarm handler must have
		// re-armed itself instead of leaving future expiries unswept
		const nextAlarm = await runInDurableObject(deviceStub(deviceId), (_instance, state) => state.storage.getAlarm());
		expect(nextAlarm).not.toBeNull();
	});

	it('does not send a false offline notification for a server-closed pairing socket', async () => {
		// webSocketClose only reacts to 'pc' and 'm:*' tags; a pair: close must not touch pc presence.
		const { deviceId, pcToken } = await provisionDevice();
		const pcWs = await openWs(`https://relay/device/${deviceId}/ws?role=pc&token=${pcToken}`);
		const pcMessages: unknown[] = [];
		pcWs.addEventListener('message', event => pcMessages.push(event.data));

		const pair = await beginPairing(deviceId, pcToken);
		const pairWs = await openWs(`https://relay/device/${deviceId}/ws?role=pair&pairId=${pair.pairId}&token=${pair.pairingToken}`);
		const closePromise = waitForClose(pairWs);
		await expirePairing(deviceId, pair.pairId);
		await callCleanupPairings(deviceId);
		await closePromise;

		// give any (incorrect) presence push a moment to arrive, then assert none did
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(pcMessages).toHaveLength(0);
	});
});
