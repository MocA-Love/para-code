// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * RelayClient が「接続の記録」（W2-22）へ渡す出来事。
 */

import { encodeRelayControl, generateIdentity, respondHandshake, type Identity } from '@para/protocol';
import { describe, expect, it } from 'vitest';
import { RelayClient, type PairedCredentials, type RelayConnectionEvent, type SocketLike, type Timers } from './relayClient.js';

class FakeSocket implements SocketLike {
	onopen: (() => void) | null = null;
	onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
	binaryType = 'arraybuffer';
	closed = false;
	readonly sent: (string | ArrayBufferView | ArrayBuffer)[] = [];

	send(data: string | ArrayBufferView | ArrayBuffer): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.onclose?.({ code: 0 });
	}
}

class ManualTimers implements Timers {
	private next = 1;
	readonly pending = new Map<number, { handler: () => void; ms: number }>();

	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.next++;
		this.pending.set(id, { handler, ms });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.pending.delete(handle as number);
	}
}

function toArrayBuffer(data: string | ArrayBufferView | ArrayBuffer): ArrayBuffer {
	if (data instanceof ArrayBuffer) {
		return data;
	}
	const view = data as ArrayBufferView;
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function lifecycleHarness() {
	const mobile: Identity = generateIdentity();
	const pc: Identity = generateIdentity();
	const sockets: FakeSocket[] = [];
	const timers = new ManualTimers();
	const events: RelayConnectionEvent[] = [];
	const states: string[] = [];
	const credentials: PairedCredentials = { relayUrl: 'wss://relay.test', deviceId: 'device', mobileId: 'mobile', mobileToken: 'token', pcPublicKey: pc.publicKey };
	const client = new RelayClient(mobile, credentials, () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	}, { onConnectionEvent: event => events.push(event), onStateChange: state => states.push(state) }, timers, () => 0.5, () => 1_000_000);
	const establish = () => {
		const socket = sockets[sockets.length - 1]!;
		socket.onopen?.();
		socket.onmessage?.({ data: encodeRelayControl({ type: 'presence', peer: 'pc', online: true }) });
		const hello = new Uint8Array(toArrayBuffer(socket.sent[socket.sent.length - 1]!));
		const responder = respondHandshake(pc, mobile.publicKey, hello);
		socket.onmessage?.({ data: toArrayBuffer(responder.response) });
	};
	return { client, sockets, timers, events, states, establish };
}

describe('RelayClient connection log events (W2-22)', () => {
	it('reports connect, presence, online, close codes, backoff and suspend/resume (the log redacts details)', () => {
		const h = lifecycleHarness();
		h.client.connect();
		h.establish();
		h.sockets[0]!.onerror?.(new Error('The operation could not be completed. wss://relay.test/device/x?token=secret'));
		h.sockets[0]!.onclose?.({ code: 1006 });
		h.client.suspend();
		h.client.resume();
		expect(h.events.map(event => ({ ...event }))).toEqual([
			{ kind: 'connecting', attempt: 0 },
			{ kind: 'pc-presence', online: true },
			{ kind: 'online' },
			{ kind: 'socket-error', detail: 'The operation could not be completed. wss://relay.test/device/x?token=secret' },
			{ kind: 'closed', code: 1006 },
			{ kind: 'reconnect-scheduled', delayMs: 250, attempt: 1 },
			{ kind: 'suspended' },
			{ kind: 'resumed' },
			{ kind: 'connecting', attempt: 0 },
		]);
	});

	it('reports a refused credential as its own event', () => {
		const h = lifecycleHarness();
		h.client.connect();
		h.sockets[0]!.onclose?.({ code: 4401 });
		expect(h.events.map(event => event.kind)).toEqual(['connecting', 'auth-rejected', 'reconnect-scheduled']);
	});
});
