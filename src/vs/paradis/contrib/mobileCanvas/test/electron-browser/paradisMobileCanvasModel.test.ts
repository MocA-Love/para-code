/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMobileCanvasSnapshot } from '../../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasModel, ParadisMobileCanvasSnapshotState } from '../../electron-browser/paradisMobileCanvasModel.js';

const EMPTY: IParadisMobileCanvasSnapshot = { devices: [], attachments: [] };
const WITH_DEVICE: IParadisMobileCanvasSnapshot = {
	devices: [{ id: 'iphone', name: 'iPhone', platform: 'ios', state: 'booted', isRunning: true }],
	attachments: [],
};
const WITH_ATTACHMENT: IParadisMobileCanvasSnapshot = {
	devices: WITH_DEVICE.devices,
	attachments: [{ paneToken: 'pane-1', deviceId: 'iphone', deviceName: 'iPhone', stateKey: undefined, attachedAt: 42 }],
};

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

class RecordingMobileCanvasChannel implements IChannel {
	readonly calls: IRecordedCall[] = [];
	private readonly snapshotResults: Array<() => Promise<IParadisMobileCanvasSnapshot | undefined>> = [];

	queueSnapshot(snapshot: IParadisMobileCanvasSnapshot | undefined): void {
		this.snapshotResults.push(() => Promise.resolve(snapshot));
	}

	queueSnapshotFailure(message: string): void {
		this.snapshotResults.push(() => Promise.reject(new Error(message)));
	}

	queueDeferredSnapshot(): DeferredPromise<IParadisMobileCanvasSnapshot | undefined> {
		const deferred = new DeferredPromise<IParadisMobileCanvasSnapshot | undefined>();
		this.snapshotResults.push(() => deferred.p);
		return deferred;
	}

	call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		if (command === 'getSnapshot') {
			const result = this.snapshotResults.shift();
			if (!result) {
				throw new Error('Missing queued mobile canvas snapshot');
			}
			return result() as Promise<T>;
		}
		return Promise.resolve(undefined as T);
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}

function createSharedProcessService(channel: IChannel): ISharedProcessService {
	return { getChannel: () => channel } as unknown as ISharedProcessService;
}

suite('ParadisMobileCanvasSnapshotState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes loading only for the first refresh and ignores an identical normalized snapshot', () => {
		const snapshots = new ParadisMobileCanvasSnapshotState();

		assert.strictEqual(snapshots.beginRefresh(), true);
		assert.strictEqual(snapshots.complete(EMPTY), false);
		assert.strictEqual(snapshots.beginRefresh(), false);
		assert.strictEqual(snapshots.complete({ devices: [], attachments: [] }), false);
		assert.deepStrictEqual(snapshots.snapshot, EMPTY);
	});

	test('publishes and retains changes to devices, attachments, and the unavailable reason', () => {
		const snapshots = new ParadisMobileCanvasSnapshotState();
		snapshots.complete(EMPTY);

		assert.strictEqual(snapshots.complete(WITH_DEVICE), true);
		assert.strictEqual(snapshots.snapshot, WITH_DEVICE);
		assert.strictEqual(snapshots.complete(WITH_ATTACHMENT), true);
		assert.strictEqual(snapshots.snapshot, WITH_ATTACHMENT);
		const unavailable: IParadisMobileCanvasSnapshot = { devices: WITH_DEVICE.devices, attachments: WITH_ATTACHMENT.attachments, unavailableReason: 'host unavailable' };
		assert.strictEqual(snapshots.complete(unavailable), true);
		assert.strictEqual(snapshots.snapshot, unavailable);
		assert.strictEqual(snapshots.complete({ devices: [...WITH_DEVICE.devices], attachments: [...WITH_ATTACHMENT.attachments], unavailableReason: 'host unavailable' }), false);
	});
});

suite('ParadisMobileCanvasModel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createModel(channel: RecordingMobileCanvasChannel): ParadisMobileCanvasModel {
		return store.add(new ParadisMobileCanvasModel(createSharedProcessService(channel), new NullLogService()));
	}

	test('publishes first-load loading transitions and suppresses an identical normalized result', async () => {
		const channel = new RecordingMobileCanvasChannel();
		const model = createModel(channel);
		const loadingEvents: boolean[] = [];
		store.add(model.onDidChange(() => loadingEvents.push(model.loading)));
		channel.queueSnapshot(undefined);

		await model.refresh();
		const initialSnapshot = model.snapshot;
		assert.deepStrictEqual(loadingEvents, [true, false]);

		loadingEvents.length = 0;
		channel.queueSnapshot({ devices: [], attachments: [] });
		await model.refresh();
		assert.deepStrictEqual({ loadingEvents, preservedIdentity: model.snapshot === initialSnapshot }, { loadingEvents: [], preservedIdentity: true });
	});

	test('publishes one completion event for each normalized snapshot field change', async () => {
		const channel = new RecordingMobileCanvasChannel();
		const model = createModel(channel);
		const snapshots: IParadisMobileCanvasSnapshot[] = [];
		store.add(model.onDidChange(() => {
			if (!model.loading) {
				snapshots.push(model.snapshot);
			}
		}));
		channel.queueSnapshot(EMPTY);
		await model.refresh();
		snapshots.length = 0;

		const unavailable: IParadisMobileCanvasSnapshot = { devices: WITH_DEVICE.devices, attachments: WITH_ATTACHMENT.attachments, unavailableReason: 'host unavailable' };
		channel.queueSnapshot(WITH_DEVICE);
		channel.queueSnapshot(WITH_ATTACHMENT);
		channel.queueSnapshot(unavailable);
		await model.refresh();
		await model.refresh();
		await model.refresh();

		assert.deepStrictEqual(snapshots, [WITH_DEVICE, WITH_ATTACHMENT, unavailable]);
	});

	test('publishes failure and recovery changes but suppresses an identical repeated failure', async () => {
		const channel = new RecordingMobileCanvasChannel();
		const model = createModel(channel);
		const snapshots: IParadisMobileCanvasSnapshot[] = [];
		store.add(model.onDidChange(() => {
			if (!model.loading) {
				snapshots.push(model.snapshot);
			}
		}));
		channel.queueSnapshot(EMPTY);
		await model.refresh();
		snapshots.length = 0;

		channel.queueSnapshotFailure('offline');
		channel.queueSnapshotFailure('offline');
		channel.queueSnapshot(EMPTY);
		await model.refresh();
		await model.refresh();
		await model.refresh();

		assert.deepStrictEqual(snapshots, [
			{ devices: [], attachments: [], unavailableReason: 'offline' },
			{ devices: [], attachments: [] },
		]);
	});

	test('coalesces concurrent refreshes into one snapshot channel call', async () => {
		const channel = new RecordingMobileCanvasChannel();
		const model = createModel(channel);
		const deferred = channel.queueDeferredSnapshot();

		const first = model.refresh();
		const second = model.refresh();
		assert.deepStrictEqual({ samePromise: first === second, calls: channel.calls }, {
			samePromise: true,
			calls: [{ command: 'getSnapshot', arg: undefined }],
		});

		await deferred.complete(EMPTY);
		await Promise.all([first, second]);
	});

	test('refreshes after attach and detach commands in channel order', async () => {
		const channel = new RecordingMobileCanvasChannel();
		const model = createModel(channel);
		channel.queueSnapshot(EMPTY);
		channel.queueSnapshot(EMPTY);

		await model.attach('pane-1', 'iphone', 'state-1');
		await model.detach('pane-1');

		assert.deepStrictEqual(channel.calls, [
			{ command: 'attach', arg: { paneToken: 'pane-1', deviceId: 'iphone', stateKey: 'state-1' } },
			{ command: 'getSnapshot', arg: undefined },
			{ command: 'detach', arg: { paneToken: 'pane-1' } },
			{ command: 'getSnapshot', arg: undefined },
		]);
	});
});
