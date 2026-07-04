// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Para Code Mobile リレーのエントリWorkerとDurable Object。
 *
 * ルーティング（すべて deviceId ベースで DeviceDO へ委譲）:
 *  - POST /device/:deviceId/provision   PC初期登録（PCトークン発行）
 *  - POST /device/:deviceId/pair/begin  ペアリングトークン発行（QR用）
 *  - GET  /device/:deviceId/ws?role=pc|mobile|pair&...   WebSocket
 *
 * deviceId は DurableObjectId の文字列表現（`idFromName` ではなく `newUniqueId` を
 * provision 時に払い出し、以降その文字列で `idFromString`）。
 */

import { DeviceDO } from './deviceDO.js';

export { DeviceDO };

interface Env {
	DEVICES: DurableObjectNamespace;
}

function doStubFor(env: Env, deviceId: string | null): DurableObjectStub | null {
	if (deviceId === null || deviceId.length === 0) {
		return null;
	}
	try {
		return env.DEVICES.get(env.DEVICES.idFromString(deviceId));
	} catch {
		return null;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const parts = url.pathname.split('/').filter(Boolean);

		// POST /device/new/provision : 新規deviceIdを払い出してprovision
		if (request.method === 'POST' && parts[0] === 'device' && parts[1] === 'new' && parts[2] === 'provision') {
			const id = env.DEVICES.newUniqueId();
			const stub = env.DEVICES.get(id);
			const forward = new Request(`https://do/?action=provision`, request);
			const res = await stub.fetch(forward);
			if (res.ok) {
				const body = await res.json<Record<string, unknown>>();
				return Response.json({ ...body, deviceId: id.toString() });
			}
			return res;
		}

		if (parts[0] !== 'device' || parts.length < 3) {
			return new Response('not found', { status: 404 });
		}
		const deviceId = parts[1] ?? null;
		const stub = doStubFor(env, deviceId);
		if (!stub) {
			return new Response('invalid device', { status: 400 });
		}

		if (request.method === 'POST' && parts[2] === 'pair' && parts[3] === 'begin') {
			return stub.fetch(new Request('https://do/?action=begin-pairing', request));
		}
		if (request.method === 'POST' && parts[2] === 'mobile' && parts[3] === 'revoke') {
			return stub.fetch(new Request('https://do/?action=revoke', request));
		}
		if (parts[2] === 'ws') {
			const forward = new Request(`https://do/?${url.searchParams.toString()}`, request);
			return stub.fetch(forward);
		}
		return new Response('not found', { status: 404 });
	},
};
