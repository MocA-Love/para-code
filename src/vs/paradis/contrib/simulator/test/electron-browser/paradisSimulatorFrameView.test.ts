/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 映像の購読と Blob URL を、見えなくなったとき・タブを閉じたとき・窓を閉じたときに確実に放すこと。

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSimulatorDevice, IParadisSimulatorFrameEvent, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, ParadisSimulatorInput } from '../../common/paradisSimulator.js';
import { IParadisSimulatorClient } from '../../electron-browser/paradisSimulatorClient.js';
import { IParadisSimulatorObjectUrls, ParadisSimulatorFrameView } from '../../electron-browser/paradisSimulatorFrameView.js';
import { ParadisSimulatorEditorInput, ParadisSimulatorEditorInputSerializer } from '../../electron-browser/paradisSimulatorEditorInput.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

class FakeClient implements IParadisSimulatorClient {
	declare readonly _serviceBrand: undefined;
	listeners = 0;
	acks = 0;
	readonly inputs: ParadisSimulatorInput[] = [];
	private readonly _frames: Emitter<IParadisSimulatorFrameEvent>;

	constructor() {
		this._frames = new Emitter<IParadisSimulatorFrameEvent>({
			onWillAddFirstListener: () => this.listeners++,
			onDidRemoveLastListener: () => this.listeners--,
		});
	}
	dispose(): void {
		this._frames.dispose();
	}
	fire(): void {
		this._frames.fire({ udid: UDID, jpeg: VSBuffer.fromString('jpeg') });
	}
	onFrames(): BaseEvent<IParadisSimulatorFrameEvent> {
		return this._frames.event;
	}
	async ackFrame(): Promise<void> {
		this.acks++;
	}
	async sendInput(_udid: string, input: ParadisSimulatorInput): Promise<void> {
		this.inputs.push(input);
	}
	getStatus(): Promise<IParadisSimulatorStatus> { throw new Error('not used'); }
	listDevices(): Promise<IParadisSimulatorDevice[]> { throw new Error('not used'); }
	boot(): Promise<void> { throw new Error('not used'); }
	shutdown(): Promise<void> { throw new Error('not used'); }
	getScreenConfig(): Promise<IParadisSimulatorScreenConfig> { throw new Error('not used'); }
	captureFrame(): Promise<VSBuffer> { throw new Error('not used'); }
	fold(): Promise<{ ok: boolean }> { throw new Error('not used'); }
	deviceHubActive(): Promise<boolean> { throw new Error('not used'); }
}

class FakeUrls implements IParadisSimulatorObjectUrls {
	private _next = 0;
	readonly live = new Set<string>();
	create(): string {
		const url = `blob:paradis-simulator-test/${this._next++}`;
		this.live.add(url);
		return url;
	}
	revoke(url: string): void {
		this.live.delete(url);
	}
}

suite('Paradis simulator: frame view', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const client = new FakeClient();
		store.add({ dispose: () => client.dispose() });
		const urls = new FakeUrls();
		const container = document.createElement('div');
		const view = new ParadisSimulatorFrameView(container, UDID, client, urls);
		const image = container.querySelector('img')!;
		/** 届いた 1 枚を <img> が描き終えたことにする。 */
		const loaded = () => image.dispatchEvent(new Event('load'));
		return { client, urls, view, image, loaded };
	}

	test('keeps one Blob URL on screen, acknowledges each drawn frame, and stops when hidden', () => {
		const { client, urls, view, loaded } = setup();
		view.start();
		client.fire();
		loaded();
		client.fire();
		loaded();
		const whileVisible = { listeners: client.listeners, liveUrls: urls.live.size, acks: client.acks };
		view.stop();
		const hidden = { listeners: client.listeners, streaming: view.isStreaming };
		view.dispose();
		assert.deepStrictEqual({ whileVisible, hidden, liveUrlsAfterClose: urls.live.size }, {
			whileVisible: { listeners: 1, liveUrls: 1, acks: 2 },
			hidden: { listeners: 0, streaming: false },
			liveUrlsAfterClose: 0,
		});
	});

	// タブを閉じた・窓を閉じたとき（エディタのペインが dispose する）: 描きかけの 1 枚も含めて放す
	test('releases the subscription and every Blob URL when disposed while streaming', () => {
		const { client, urls, view, loaded } = setup();
		view.start();
		client.fire();
		loaded();
		client.fire();
		const before = { listeners: client.listeners, liveUrls: urls.live.size };
		view.dispose();
		client.fire();
		assert.deepStrictEqual({ before, after: { listeners: client.listeners, liveUrls: urls.live.size } }, {
			before: { listeners: 1, liveUrls: 2 },
			after: { listeners: 0, liveUrls: 0 },
		});
	});

	test('serializes only the udid and the name, and refuses other data', () => {
		const serializer = new ParadisSimulatorEditorInputSerializer();
		const input = store.add(new ParadisSimulatorEditorInput(UDID, 'iPhone 17'));
		const serialized = serializer.serialize(input)!;
		const restored = serializer.deserialize(undefined, serialized) as ParadisSimulatorEditorInput;
		store.add(restored);
		assert.deepStrictEqual({
			serialized: JSON.parse(serialized),
			restored: { udid: restored.udid, name: restored.getName(), resource: restored.resource.toString(), matches: restored.matches(input) },
			invalid: [serializer.deserialize(undefined, '{"udid":"../etc"}'), serializer.deserialize(undefined, 'nope')],
		}, {
			serialized: { udid: UDID, name: 'iPhone 17' },
			restored: { udid: UDID, name: 'iPhone 17', resource: `paradis-simulator:/${UDID}`, matches: true },
			invalid: [undefined, undefined],
		});
	});
});
