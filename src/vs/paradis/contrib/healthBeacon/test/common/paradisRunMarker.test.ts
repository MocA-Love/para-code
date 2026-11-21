/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPrepareSentryEvent } from '../../../sentry/common/paradisSentryEvent.js';
import { IParadisRunBeatInput, IParadisRunMarker, paradisBuildRunMarker, paradisClassifyRunEnd, paradisParseRunMarker, paradisRunEndExtra } from '../../common/paradisRunMarker.js';

const MB = 1024 * 1024;
const STARTED_AT = 1_800_000_000_000;
/** The last heartbeat: 13.8 hours into the run. */
const BEAT_AT = STARTED_AT + 828 * 60_000;
/** The OS had been up for a day at that heartbeat. */
const OS_UPTIME_AT_BEAT = 86_400;

function beat(overrides: Partial<IParadisRunBeatInput> = {}): IParadisRunBeatInput {
	return {
		now: BEAT_AT,
		pid: 4242,
		startedAt: STARTED_AT,
		beats: 1656,
		phase: 'running',
		appVersion: '1.146.0',
		commit: '3b55454e398aa0c1d2e3f4a5b6c7d8e9f0a1b2c3',
		sentry: 'load-failed',
		sentryError: 'ERR_MODULE_NOT_FOUND',
		osUptimeSeconds: OS_UPTIME_AT_BEAT,
		suspended: false,
		osShutdown: false,
		rss: 612 * MB,
		heapUsed: 31 * MB,
		heapTotal: 48 * MB,
		windowCount: 2,
		freeMem: 1_500 * MB,
		load1: 7.456,
		metrics: [
			{ type: 'Browser', workingSetKb: 600 * 1024 },
			{ type: 'Tab', workingSetKb: 900 * 1024 },
			{ type: 'Tab', workingSetKb: 300 * 1024 },
			{ type: 'GPU', workingSetKb: 250 * 1024 },
			{ type: 'Utility', workingSetKb: 100 * 1024 },
			{ type: 'Zygote', workingSetKb: 20 * 1024 },
		],
		...overrides,
	};
}

/** A startup five minutes after the last heartbeat, on the same OS boot and the same build. */
function reader(overrides: Partial<Parameters<typeof paradisRunEndExtra>[1]> = {}): Parameters<typeof paradisRunEndExtra>[1] {
	return { now: BEAT_AT + 300_000, osUptimeSeconds: OS_UPTIME_AT_BEAT + 300, appVersion: '1.146.0', commit: '3b55454e398aa0c1d2e3f4a5b6c7d8e9f0a1b2c3', ...overrides };
}

function marker(overrides: Partial<IParadisRunBeatInput> = {}): IParadisRunMarker {
	return paradisBuildRunMarker(beat(overrides));
}

suite('ParadisRunMarker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a heartbeat sums the processes by kind and survives the file', () => {
		const written = marker();
		assert.deepStrictEqual({
			roundTrip: paradisParseRunMarker(JSON.stringify(written)),
			processes: written.processes,
			numbers: [written.rssMb, written.heapUsedMb, written.heapTotalMb, written.freeMemMb, written.load1, written.osBootAt],
		}, {
			roundTrip: written,
			processes: {
				browser: { count: 1, mb: 600 },
				renderer: { count: 2, mb: 1200 },
				gpu: { count: 1, mb: 250 },
				utility: { count: 1, mb: 100 },
				other: { count: 1, mb: 20 },
			},
			numbers: [612, 31, 48, 1500, 7.46, BEAT_AT - OS_UPTIME_AT_BEAT * 1_000],
		});
	});

	test('a file that is not a marker is ignored, and a tampered field is emptied', () => {
		const tampered = paradisParseRunMarker(JSON.stringify({
			...marker(),
			appVersion: '/Users/alice/secret',
			commit: 'not-a-commit',
			sentry: 'https://example.com',
			sentryError: 'Cannot find /Users/alice/x',
			rssMb: 'many',
			phase: 'other',
			processes: { renderer: { count: 'x', mb: -1 } },
		}));
		assert.deepStrictEqual({
			empty: paradisParseRunMarker(''),
			truncated: paradisParseRunMarker('{"version":1,"beatAt":17'),
			otherVersion: paradisParseRunMarker(JSON.stringify({ ...marker(), version: 2 })),
			noBeat: paradisParseRunMarker(JSON.stringify({ version: 1, startedAt: 1 })),
			tampered: tampered && [tampered.appVersion, tampered.commit, tampered.sentry, tampered.sentryError, tampered.rssMb, tampered.phase, tampered.processes.renderer, tampered.processes.gpu],
		}, {
			empty: undefined,
			truncated: undefined,
			otherVersion: undefined,
			noBeat: undefined,
			tampered: ['', '', 'unknown', '', 0, 'running', { count: 0, mb: 0 }, { count: 0, mb: 0 }],
		});
	});

	test('the way the run ended is read from the marker and the OS boot time', () => {
		assert.deepStrictEqual({
			killedWhileRunning: paradisClassifyRunEnd(marker(), reader()),
			// The boot time moves by seconds between readings on the same boot.
			sameBootWithJitter: paradisClassifyRunEnd(marker(), reader({ osUptimeSeconds: OS_UPTIME_AT_BEAT + 300 - 20 })),
			quitDidNotFinish: paradisClassifyRunEnd(marker({ phase: 'quitting' }), reader()),
			asleep: paradisClassifyRunEnd(marker({ suspended: true }), reader()),
			osRestartedWithoutNotice: paradisClassifyRunEnd(marker(), reader({ osUptimeSeconds: 120 })),
			osRestartWinsOverQuitting: paradisClassifyRunEnd(marker({ phase: 'quitting' }), reader({ osUptimeSeconds: 120 })),
			osShutdownAnnounced: paradisClassifyRunEnd(marker({ osShutdown: true, phase: 'quitting' }), reader({ osUptimeSeconds: 120 })),
		}, {
			killedWhileRunning: 'running',
			sameBootWithJitter: 'running',
			quitDidNotFinish: 'quitting',
			asleep: 'suspended',
			osRestartedWithoutNotice: 'os-restart',
			osRestartWinsOverQuitting: 'os-restart',
			osShutdownAnnounced: 'os-shutdown',
		});
	});

	test('the report carries the last heartbeat', () => {
		assert.deepStrictEqual(paradisRunEndExtra(marker(), reader({ commit: 'ffffffffffffffffffffffffffffffffffffffff' })), {
			safe_end_kind: 'running',
			safe_uptime_min: 828,
			safe_restart_gap_s: 300,
			safe_beats: 1656,
			safe_rss_mb: 612,
			safe_heap_used_mb: 31,
			safe_heap_total_mb: 48,
			safe_app_total_mb: 2170,
			safe_app_process_count: 6,
			safe_browser_mb: 600,
			safe_renderer_mb: 1200,
			safe_renderer_count: 2,
			safe_gpu_mb: 250,
			safe_utility_mb: 100,
			safe_utility_count: 1,
			safe_other_mb: 20,
			safe_other_count: 1,
			safe_window_count: 2,
			safe_free_mem_mb: 1500,
			safe_load1: 7.46,
			safe_was_quitting: false,
			safe_was_suspended: false,
			safe_os_shutdown_announced: false,
			safe_os_restarted: false,
			safe_ended_version: '1.146.0',
			safe_ended_commit: '3b55454e39',
			safe_same_build: false,
			safe_ended_sentry: 'load-failed',
			safe_ended_sentry_error: 'ERR_MODULE_NOT_FOUND',
		});
	});

	test('the Sentry event sanitizer keeps every field of the report as it is', () => {
		const extra = paradisRunEndExtra(marker(), reader());
		const prepared = paradisPrepareSentryEvent({
			tags: { 'para.scope': 'owned', 'para.feature': 'run-marker', 'para.operation': 'ended:running' },
			extra,
			exception: { values: [{ type: 'Error', value: 'Para Code diagnostic: run-marker.ended:running' }] },
		}, 'main');
		assert.deepStrictEqual(prepared?.extra, extra);
	});

	// The Sentry project scrubs a field when its key contains one of these words, whatever the
	// `safe_` prefix says (sensitiveFields and the default scrubber match by substring).
	test('no key of the report contains a word the Sentry project scrubs', () => {
		const scrubbed = /token|session|terminal|cwd|command|prompt|environment|env|dsn|path|password|passwd|secret|auth|credential|key|cookie|header/i;
		assert.deepStrictEqual(Object.keys(paradisRunEndExtra(marker(), reader())).filter(key => scrubbed.test(key)), []);
	});
});
