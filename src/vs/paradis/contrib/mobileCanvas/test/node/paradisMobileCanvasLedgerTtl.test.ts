/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisMobileCanvasHostClient } from '../../node/paradisMobileCanvasHostClient.js';
import { ParadisMobileCanvasService } from '../../node/paradisMobileCanvasService.js';

const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

suite('ParadisMobileCanvasService attachment ledger TTL', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function fakeHostClient(devices: readonly { id: string }[] = [{ id: 'device-1' }]): ParadisMobileCanvasHostClient {
		return { request: async () => devices } as unknown as ParadisMobileCanvasHostClient;
	}

	function createService(devices?: readonly { id: string }[]): ParadisMobileCanvasService {
		return store.add(new ParadisMobileCanvasService(fakeHostClient(devices), new NullLogService()));
	}

	test('drops an attachment idle for more than 24h', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const service = createService();
			await service.attach('pane-1', 'device-1', undefined);
			assert.strictEqual(service.listAttachments().length, 1);

			await clock.tickAsync(IDLE_TTL_MS + SWEEP_INTERVAL_MS);

			assert.strictEqual(service.listAttachments().length, 0);
		} finally {
			clock.restore();
		}
	});

	test('keeps an attachment alive for 24h since its last MCP tool call, not since it was attached', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const service = createService();
			await service.attach('pane-1', 'device-1', undefined);

			// just before the first sweep would drop it, a real tool call resets the clock
			await clock.tickAsync(IDLE_TTL_MS - 60_000);
			await service.callTool('pane-1', 'mobile_list_devices', {});

			// this alone would have dropped it if lastActiveAt had not been refreshed above
			await clock.tickAsync(IDLE_TTL_MS - 60_000);
			assert.strictEqual(service.listAttachments().length, 1, 'a tool call must refresh lastActiveAt and keep the entry alive');

			await clock.tickAsync(IDLE_TTL_MS + SWEEP_INTERVAL_MS);
			assert.strictEqual(service.listAttachments().length, 0, 'idle time since the last tool call must still expire eventually');
		} finally {
			clock.restore();
		}
	});

	test('UI reads (getSnapshot/listAttachments) do not count as activity and do not delay the sweep', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const service = createService();
			await service.attach('pane-1', 'device-1', undefined);

			// hammer the UI-facing read paths right up to (just under) the TTL boundary;
			// none of this should count as activity
			await clock.tickAsync(IDLE_TTL_MS - 60_000);
			for (let i = 0; i < 5; i++) {
				service.listAttachments();
				await service.getSnapshot();
			}

			// cross the TTL boundary and let a sweep run
			await clock.tickAsync(60_000 + SWEEP_INTERVAL_MS);
			assert.strictEqual(service.listAttachments().length, 0, 'snapshot/list reads must not refresh lastActiveAt');
		} finally {
			clock.restore();
		}
	});

	test('keeps an actively-driven attachment forever across many sweep cycles', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const service = createService();
			await service.attach('pane-1', 'device-1', undefined);

			for (let i = 0; i < 30; i++) {
				await clock.tickAsync(SWEEP_INTERVAL_MS);
				await service.callTool('pane-1', 'mobile_list_devices', {});
			}

			assert.strictEqual(service.listAttachments().length, 1);
		} finally {
			clock.restore();
		}
	});
});
