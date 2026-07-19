/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { createParadisMobileTrafficDiagnostics, formatParadisMobileTrafficSnapshot, isParadisMobileTrafficDiagnosticsEnabled, ParadisMobileTrafficDiagnostics, reportParadisMobileTrafficDiagnostics, startParadisMobileTrafficDiagnostics } from '../../node/paradisMobileTrafficDiagnostics.js';

suite('ParadisMobileTrafficDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates anonymous frame sizes by channel and direction', () => {
		const diagnostics = new ParadisMobileTrafficDiagnostics();
		diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: 100, sealedBytes: 136, more: true });
		diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: 50, sealedBytes: 86, more: false });
		diagnostics.record({ direction: 'received', channel: Channels.State, payloadBytes: 10, sealedBytes: 46, more: false });

		assert.deepStrictEqual(diagnostics.takeSnapshot().channels, {
			browser: {
				sent: { frames: 2, messages: 1, payloadBytes: 150, sealedBytes: 222, relayPayloadBytes: 256 },
			},
			state: {
				received: { frames: 1, messages: 1, payloadBytes: 10, sealedBytes: 46, relayPayloadBytes: 63 },
			},
		});
	});

	test('clears the completed interval after taking a snapshot', () => {
		const diagnostics = new ParadisMobileTrafficDiagnostics();
		diagnostics.record({ direction: 'sent', channel: Channels.Agent, payloadBytes: 20, sealedBytes: 56, more: false });

		diagnostics.takeSnapshot();

		assert.deepStrictEqual(diagnostics.takeSnapshot(), { channels: {} });
	});

	test('enables diagnostics only for the explicit environment value', () => {
		assert.deepStrictEqual([
			isParadisMobileTrafficDiagnosticsEnabled(undefined),
			isParadisMobileTrafficDiagnosticsEnabled(''),
			isParadisMobileTrafficDiagnosticsEnabled('0'),
			isParadisMobileTrafficDiagnosticsEnabled('true'),
			isParadisMobileTrafficDiagnosticsEnabled('1'),
		], [false, false, false, false, true]);
	});

	test('formats only non-empty anonymous snapshots', () => {
		assert.strictEqual(formatParadisMobileTrafficSnapshot({ channels: {} }), undefined);
		assert.strictEqual(formatParadisMobileTrafficSnapshot({
			channels: {
				state: { sent: { frames: 1, messages: 1, payloadBytes: 10, sealedBytes: 46, relayPayloadBytes: 63 } },
			},
		}), '{"channels":{"state":{"sent":{"frames":1,"messages":1,"payloadBytes":10,"sealedBytes":46,"relayPayloadBytes":63}}}}');
	});

	test('creates an aggregator only for an explicitly enabled process', () => {
		assert.strictEqual(createParadisMobileTrafficDiagnostics(undefined), undefined);
		assert.strictEqual(createParadisMobileTrafficDiagnostics('0'), undefined);
		assert.ok(createParadisMobileTrafficDiagnostics('1') instanceof ParadisMobileTrafficDiagnostics);
	});

	test('reports non-empty intervals without exposing logger failures to callers', () => {
		const diagnostics = new ParadisMobileTrafficDiagnostics();
		const lines: string[] = [];
		assert.strictEqual(reportParadisMobileTrafficDiagnostics(diagnostics, (line: string) => lines.push(line)), false);
		diagnostics.record({ direction: 'received', channel: Channels.Notify, payloadBytes: 5, sealedBytes: 41, more: false });
		assert.strictEqual(reportParadisMobileTrafficDiagnostics(diagnostics, (line: string) => lines.push(line)), true);
		assert.deepStrictEqual(lines, ['{"channels":{"notify":{"received":{"frames":1,"messages":1,"payloadBytes":5,"sealedBytes":41,"relayPayloadBytes":58}}}}']);
		diagnostics.record({ direction: 'sent', channel: Channels.Agent, payloadBytes: 8, sealedBytes: 44, more: false });
		assert.doesNotThrow(() => reportParadisMobileTrafficDiagnostics(diagnostics, () => { throw new Error('log unavailable'); }));
	});

	test('starts only when opted in, flushes every 60 seconds, and disposes its timer', () => {
		let scheduled: (() => void) | undefined;
		let scheduledInterval: number | undefined;
		let disposed = false;
		const schedule = (callback: () => void, intervalMs: number) => {
			scheduled = callback;
			scheduledInterval = intervalMs;
			return { dispose: () => { disposed = true; } };
		};
		const lines: string[] = [];

		assert.strictEqual(startParadisMobileTrafficDiagnostics(undefined, line => lines.push(line), schedule), undefined);
		assert.strictEqual(scheduled, undefined);
		const session = startParadisMobileTrafficDiagnostics('1', line => lines.push(line), schedule);
		assert.ok(session);
		assert.strictEqual(scheduledInterval, 60_000);
		scheduled!();
		assert.deepStrictEqual(lines, []);
		session.diagnostics.record({ direction: 'sent', channel: Channels.State, payloadBytes: 4, sealedBytes: 40, more: false });
		scheduled!();
		assert.deepStrictEqual(lines, ['{"channels":{"state":{"sent":{"frames":1,"messages":1,"payloadBytes":4,"sealedBytes":40,"relayPayloadBytes":57}}}}']);
		session.dispose();
		assert.strictEqual(disposed, true);
	});

	test('saturates interval totals at the largest safe integer', () => {
		const diagnostics = new ParadisMobileTrafficDiagnostics();
		diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: Number.MAX_SAFE_INTEGER, sealedBytes: Number.MAX_SAFE_INTEGER, more: false });
		diagnostics.record({ direction: 'sent', channel: Channels.Browser, payloadBytes: 1, sealedBytes: 1, more: false });

		assert.deepStrictEqual(diagnostics.takeSnapshot().channels.browser?.sent, {
			frames: 2,
			messages: 2,
			payloadBytes: Number.MAX_SAFE_INTEGER,
			sealedBytes: Number.MAX_SAFE_INTEGER,
			relayPayloadBytes: Number.MAX_SAFE_INTEGER,
		});
	});
});
