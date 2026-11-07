/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame } from '../../common/paradisMobileRelay.js';
import { ParadisMobileWebrtcStreamer } from '../../electron-browser/paradisMobileWebrtcStreamer.js';

suite('ParadisMobileWebrtcStreamer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 止められたかを数える偽の映像。`displaySurface` で取得した面を装う。 */
	function fakeStream(displaySurface: string) {
		const stopped: string[] = [];
		const track = {
			stop: () => stopped.push('video'),
			getSettings: () => ({ displaySurface }),
			onended: null,
		};
		const stream = {
			getTracks: () => [track],
			getVideoTracks: () => [track],
		} as unknown as MediaStream;
		return { stream, stopped };
	}

	function create() {
		const sent: { readonly mobileId: string | undefined; readonly body: { t?: string; error?: string } }[] = [];
		const pending: ((stream: MediaStream) => void)[] = [];
		const streamer = store.add(new ParadisMobileWebrtcStreamer(
			frame => sent.push({ mobileId: frame.mobileId, body: JSON.parse(new TextDecoder().decode(frame.payload.buffer)) }),
			new NullLogService(),
			() => new Promise<MediaStream>(resolve => pending.push(resolve)),
		));
		const offer = (mobileId: string) => streamer.handleInbound({
			ch: Channels.Browser,
			ws: undefined,
			seq: 0,
			payload: VSBuffer.fromString(JSON.stringify({ t: 'webrtc-offer', id: 'req', sdp: 'v=0', sid: 'sid' })),
			mobileId,
		} satisfies IParadisMobileInboundFrame);
		return { streamer, sent, pending, offer };
	}

	test('止めたときに getDisplayMedia を待っている写しも取り消し、届いた映像はすぐ止める', async () => {
		const { streamer, sent, pending, offer } = create();
		offer('m');
		streamer.stopAll();
		const { stream, stopped } = fakeStream('browser');
		pending[0](stream);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({ stopped, sent }, { stopped: ['video'], sent: [] });
	});

	test('古い offer の確立の失敗が、後から来た offer を止めない', async () => {
		const { streamer, sent, pending } = create();
		const offer = (id: string, sid: string) => streamer.handleInbound({
			ch: Channels.Browser,
			ws: undefined,
			seq: 0,
			payload: VSBuffer.fromString(JSON.stringify({ t: 'webrtc-offer', id, sdp: 'v=0', sid })),
			mobileId: 'm',
		} satisfies IParadisMobileInboundFrame);
		// RTCPeerConnection に渡すので本物の映像（canvas）を使う
		const realStream = () => mainWindow.document.createElement('canvas').captureStream();
		const first = realStream();
		const [track] = first.getVideoTracks();
		const settings = track.getSettings.bind(track);
		// 古い offer がピアを作って setRemoteDescription を待ち始めたところで、次の offer を届ける
		track.getSettings = () => {
			queueMicrotask(() => offer('new', 'b'));
			return settings();
		};
		offer('old', 'a');
		pending[0](first);
		await new Promise(resolve => setTimeout(resolve, 100));
		pending[1](realStream());
		await new Promise(resolve => setTimeout(resolve, 100));

		// どちらの offer も自分の確立まで進み（この偽の SDP では失敗する）、それぞれの失敗を返す
		assert.deepStrictEqual(sent.map(message => `${message.body.t}:${(message.body as { id?: string }).id}`), ['webrtc-error:old', 'webrtc-error:new']);
	});

	test('画面全体（monitor）の映像が来たら写しに使わず、止めて断る', async () => {
		const { sent, pending, offer } = create();
		offer('m');
		const { stream, stopped } = fakeStream('monitor');
		pending[0](stream);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({ stopped, sent }, {
			stopped: ['video'],
			sent: [{ mobileId: 'm', body: { t: 'webrtc-error', id: 'req', error: 'unexpected capture surface' } }],
		});
	});
});
