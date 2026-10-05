/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEncryptionService } from '../../../../../platform/encryption/common/encryptionService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisFrameGzipJsonResponse } from '../../common/paradisMobileGzipJson.js';
import { paradisEncodeBinaryFsResponse } from '../../common/paradisMobileFileResponse.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileRendererManifest } from '../../common/paradisMobileWindowLease.js';
import { IParadisMobileSendHandle, ParadisMobileSendResult, paradisMobileRejectedSend } from '../../common/paradisMobileSendQueue.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { paradisMobileResponseRequestId } from '../../node/paradisMobileResponseRequestId.js';

interface IServiceInternals {
	readonly terminalRegistry: { syncWindow(windowId: number, windowSession: string, rendererGeneration: number, state: object): void };
	readonly sessions: Map<string, object>;
	readonly sendQueue: { cancelTag(tag: string): number };
}

/** 送り終わりを手で決められる、確立済みのセッションの代わり。 */
class FakeSession {
	readonly hasCurrentProtocol = true;
	readonly isOnline = false;
	readonly submitted: { ch: string; text: string; options: object | undefined }[] = [];
	readonly replies: string[] = [];
	readonly finish: ((result: ParadisMobileSendResult) => void)[] = [];
	refuse = false;

	submitFrame(ch: string, _ws: string | undefined, payload: Uint8Array, options?: object): IParadisMobileSendHandle {
		if (this.refuse) {
			return paradisMobileRejectedSend('busy');
		}
		this.submitted.push({ ch, text: new TextDecoder().decode(payload), options });
		return { accepted: true, settled: new Promise<ParadisMobileSendResult>(resolve => this.finish.push(resolve)) };
	}

	async sendFrame(_ch: string, _ws: string | undefined, payload: Uint8Array): Promise<void> {
		this.replies.push(new TextDecoder().decode(payload));
	}

	close(): void { }
}

suite('ParadisMobileRelay renderer authority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let userData: string;
	setup(async () => {
		userData = join(tmpdir(), `paradis-renderer-authority-${generateUuid()}`);
		await fs.mkdir(userData, { recursive: true });
	});
	teardown(async () => {
		await fs.rm(userData, { recursive: true, force: true });
	});

	const lease = { windowId: 7, windowSession: 'session', rendererGeneration: 1 };
	const manifestAt = (revision: number): IParadisMobileRendererManifest => ({
		revision,
		entries: [{ windowId: 7, rendererGeneration: 1, windowRevision: 1, claimed: true, windowSession: 'session' }],
	});

	function createHarness() {
		const manifest = new Emitter<IParadisMobileRendererManifest>();
		let validations = 0;
		const service = new ParadisMobileRelayService(userData, {} as IEncryptionService, undefined, undefined, {
			onDidChangeManifest: manifest.event,
			validate: async () => {
				validations++;
				return { valid: true, manifestRevision: 1, windowRevision: 1 };
			},
			manifest: async () => manifestAt(1),
		} as never, new NullLogService(), undefined, undefined, undefined, { disableHostResourceSampling: true, readMachineIdHash: async () => undefined });
		const internals = service as unknown as IServiceInternals;
		internals.terminalRegistry.syncWindow(lease.windowId, lease.windowSession, lease.rendererGeneration, { activeWs: 'repo', workspaces: [{ id: 'repo', name: 'Repo' }], terminals: [] });
		const session = new FakeSession();
		internals.sessions.set('mobile-a', session);
		const dispose = () => {
			internals.sessions.clear();
			service.dispose();
			manifest.dispose();
		};
		return { service, internals, session, manifest, validations: () => validations, dispose };
	}

	test('積んだら権限の列を空け、送り終わりは列の外で待つ（遅い送信が別の仕事と次のフレームを止めない）', async () => {
		const { service, session, dispose } = createHarness();
		try {
			const first = service.sendFrame(lease, Channels.Terminal, undefined, 'mobile-a', VSBuffer.fromString('out-1'));
			const second = service.sendFrame(lease, Channels.Terminal, undefined, 'mobile-a', VSBuffer.fromString('out-2'));
			await service.setPcFocus(lease, true);
			const beforeSent = session.submitted.map(entry => entry.text);
			session.finish.forEach(finish => finish('sent'));

			assert.deepStrictEqual({ beforeSent, results: await Promise.all([first, second]), options: session.submitted[0]?.options }, {
				beforeSent: ['out-1', 'out-2'],
				results: ['sent', 'sent'],
				options: { bounded: true, cancelTag: '7:session:1' },
			});
		} finally {
			dispose();
		}
	});

	test('main の確かめは同じ世代のうち 1 回だけ。manifest が進んだら確かめ直す。古い lease は stale', async () => {
		const { service, session, manifest, validations, dispose } = createHarness();
		try {
			const send = (text: string, owner = lease) => {
				const result = service.sendFrame(owner, Channels.Terminal, undefined, 'mobile-a', VSBuffer.fromString(text));
				return result;
			};
			const results = [send('a'), send('b')];
			await new Promise(resolve => setTimeout(resolve, 0));
			const cachedValidations = validations();
			manifest.fire(manifestAt(2));
			results.push(send('c'));
			results.push(send('stale', { ...lease, rendererGeneration: 0 }));
			await new Promise(resolve => setTimeout(resolve, 0));
			session.finish.forEach(finish => finish('sent'));

			assert.deepStrictEqual({ cachedValidations, afterManifest: validations(), results: await Promise.all(results) }, {
				cachedValidations: 1,
				afterManifest: 2,
				results: ['sent', 'sent', 'sent', 'stale'],
			});
		} finally {
			dispose();
		}
	});

	test('送信前の列が上限なら busy を返し、ファイルの要求元には小さな失敗の返事を返す', async () => {
		const { service, session, dispose } = createHarness();
		try {
			session.refuse = true;
			const result = await service.sendFrame(lease, Channels.Fs, undefined, 'mobile-a', VSBuffer.fromString(JSON.stringify({ id: 'read-1', t: 'read', content: 'x'.repeat(1024) })));

			assert.deepStrictEqual({ result, replies: session.replies.map(reply => JSON.parse(reply).id) }, { result: 'busy', replies: ['read-1'] });
		} finally {
			dispose();
		}
	});

	test('renderer が去ったら、その世代の nonce 予約前の送信を取り下げる', async () => {
		const { service, internals, dispose } = createHarness();
		const tags: string[] = [];
		internals.sendQueue.cancelTag = tag => {
			tags.push(tag);
			return 0;
		};
		try {
			await service.removeTerminalWindow(lease);
			assert.deepStrictEqual([...new Set(tags)], ['7:session:1']);
		} finally {
			dispose();
		}
	});

	test('応答のバイト列から要求の ID を読む（JSON・gzip v1・binary v1）', () => {
		const json = new TextEncoder().encode(JSON.stringify({ id: 'json-1', t: 'read', content: 'y'.repeat(4096) }));
		const gzip = paradisFrameGzipJsonResponse(json.length, gzipSync(json));
		const binary = paradisEncodeBinaryFsResponse('pdf', 'binary-1', 3, new Uint8Array([1, 2, 3]));
		assert.deepStrictEqual([json, gzip, binary, new Uint8Array([1, 2, 3])].map(payload => payload === undefined ? 'no payload' : paradisMobileResponseRequestId(payload)), ['json-1', 'json-1', 'binary-1', undefined]);
	});
});
