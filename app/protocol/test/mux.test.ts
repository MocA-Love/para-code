// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, respondHandshake } from '../src/crypto.js';
import { Channels } from '../src/frames.js';
import { FrameMux } from '../src/mux.js';

function establish() {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	const initiator = createInitiator(mobile, pc.publicKey);
	const responder = respondHandshake(pc, mobile.publicKey, initiator.hello);
	const { channel: mobileChannel, confirm } = initiator.finish(responder.response);
	responder.verifyConfirm(confirm);
	return { mobileChannel, pcChannel: responder.channel };
}

describe('FrameMux over SecureChannel', () => {
	test('multiplexes channels and delivers to matching handler', () => {
		const { mobileChannel, pcChannel } = establish();

		// mobile側から送り、pc側で受ける配線
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { /* pc→mobile unused here */ } });
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: sealed => pcMux.receive(sealed) });

		const received: { ch: string; text: string; ws?: string }[] = [];
		pcMux.on(Channels.Terminal, f => received.push({ ch: f.ch, text: new TextDecoder().decode(f.payload), ws: f.ws }));
		pcMux.on(Channels.Scm, f => received.push({ ch: f.ch, text: new TextDecoder().decode(f.payload) }));

		mobileMux.send(Channels.Terminal, new TextEncoder().encode('input'), 'para-code');
		mobileMux.send(Channels.Scm, new TextEncoder().encode('commit'));
		// ハンドラ未登録のチャネルは黙って無視される
		mobileMux.send(Channels.Browser, new TextEncoder().encode('ignored'));

		expect(received).toEqual([
			{ ch: 'term', text: 'input', ws: 'para-code' },
			{ ch: 'scm', text: 'commit' },
		]);
	});

	test('reports error on out-of-order sealed bytes instead of throwing', () => {
		const { mobileChannel, pcChannel } = establish();
		const errors: unknown[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: e => errors.push(e) });

		const seq: Uint8Array[] = [];
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: s => seq.push(s) });
		mobileMux.send(Channels.State, new Uint8Array([1]));
		mobileMux.send(Channels.State, new Uint8Array([2]));

		// 2番目を先に渡す → カウンタnonce不一致でonErrorに流れる
		pcMux.receive(seq[1]!);
		expect(errors.length).toBe(1);
	});
});
