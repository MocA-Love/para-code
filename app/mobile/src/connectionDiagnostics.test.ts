// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { classifyRelayProbe, diagnoseInternet, relayProbeUrl, runConnectionDiagnostics, type DiagnosticPc } from './connectionDiagnostics.js';

const pc = (overrides: Partial<DiagnosticPc>): DiagnosticPc => ({
	id: 'pc-1', name: 'MacBook', relayUrl: 'wss://relay.example/', connection: 'online', pcOnline: true, pairingRejected: false, ...overrides,
});

describe('connection diagnostics (W2-22)', () => {
	test('probes the relay root over https (the relay has no /health; a 404 means reachable)', () => {
		expect([
			relayProbeUrl('wss://para-mobile-relay.example.workers.dev'),
			relayProbeUrl('ws://127.0.0.1:8787/'),
			relayProbeUrl('https://relay.example/path?q=1'),
			relayProbeUrl('not a url'),
		]).toEqual(['https://para-mobile-relay.example.workers.dev/', 'http://127.0.0.1:8787/', 'https://relay.example/', undefined]);
		expect([
			classifyRelayProbe({ status: 404 }).status,
			classifyRelayProbe({ status: 503 }).status,
			classifyRelayProbe({ error: 'timeout' }).status,
			classifyRelayProbe({ error: 'network' }).status,
		]).toEqual(['ok', 'warn', 'fail', 'fail']);
	});

	test('reads internet reachability from the device network state only', () => {
		expect([
			diagnoseInternet(undefined).status,
			diagnoseInternet({ isConnected: false }).status,
			diagnoseInternet({ isConnected: true, isInternetReachable: false, type: 'WIFI' }).detail,
			diagnoseInternet({ isConnected: true, isInternetReachable: true, type: 'CELLULAR' }).detail,
		]).toEqual(['unknown', 'fail', '回線はありますが、インターネットに届きません（Wi-Fi）', 'つながっています（モバイル回線）']);
	});

	test('probes each relay once and reports every PC and its protocol window', async () => {
		const probed: string[] = [];
		const items = await runConnectionDiagnostics({
			pcs: [
				pc({}),
				pc({ id: 'pc-2', name: 'iMac', pcOnline: false }),
				pc({ id: 'pc-3', name: 'Old', connection: 'offline', pcOnline: false, updateRequired: 'pc' }),
				pc({ id: 'pc-4', name: 'Gone', connection: 'offline', pcOnline: false, pairingRejected: true }),
			],
			network: { isConnected: true, isInternetReachable: true },
			fetcher: async url => { probed.push(url); return { status: 404 }; },
		});
		expect(probed).toEqual(['https://relay.example/']);
		expect(items.map(item => `${item.key}=${item.status}`)).toEqual([
			'pcs=ok', 'internet=ok', 'relay:https://relay.example/=ok',
			'pc:pc-1=ok', 'compat:pc-1=ok',
			'pc:pc-2=warn', 'compat:pc-2=unknown',
			'pc:pc-3=fail', 'compat:pc-3=fail',
			'pc:pc-4=fail', 'compat:pc-4=unknown',
		]);
		expect(items.some(item => item.detail.includes('relay.example'))).toBe(false);
	});

	test('a relay that never answers times out', async () => {
		const items = await runConnectionDiagnostics({
			pcs: [pc({})],
			network: undefined,
			fetcher: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
			timeoutMs: 10,
		});
		expect(items.find(item => item.key.startsWith('relay:'))?.status).toBe('fail');
	});
});
