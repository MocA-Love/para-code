/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileCanvasSnapshot } from '../../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasSnapshotState } from '../../electron-browser/paradisMobileCanvasModel.js';

const EMPTY: IParadisMobileCanvasSnapshot = { devices: [], attachments: [] };
const WITH_DEVICE: IParadisMobileCanvasSnapshot = {
	devices: [{ id: 'iphone', name: 'iPhone', platform: 'ios', state: 'booted', isRunning: true }],
	attachments: [],
};
const WITH_ATTACHMENT: IParadisMobileCanvasSnapshot = {
	devices: WITH_DEVICE.devices,
	attachments: [{ paneToken: 'pane-1', deviceId: 'iphone', deviceName: 'iPhone', stateKey: undefined, attachedAt: 42 }],
};

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
