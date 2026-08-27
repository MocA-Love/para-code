/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildParadisOfficeTelemetryEvent,
	emitParadisOfficeTelemetry,
	type ParadisOfficeTelemetryInput,
	type ParadisOfficeTelemetryOptions,
} from '../../common/paradisOfficeTelemetry.js';

const safeInput: ParadisOfficeTelemetryInput = {
	format: 'docx',
	scheme: 'file',
	backend: 'local',
	version: 1,
	counts: { parts: 1000, semanticUnits: 9, warnings: 1 },
	timings: { totalMilliseconds: 999_999_999.75 },
	outcome: 'complete',
};

suite('ParadisOfficeTelemetry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows only bounded format, scheme, backend, version, count buckets, timings, and outcome', () => {
		assert.deepStrictEqual(buildParadisOfficeTelemetryEvent(safeInput), {
			format: 'docx',
			scheme: 'file',
			backend: 'local',
			version: 1,
			countBuckets: { parts: '1000+', semanticUnits: '2-9', warnings: '1' },
			timings: { totalMilliseconds: 120_000 },
			outcome: 'complete',
		});
	});

	test('uses fixed count boundaries and clamps negative timings', () => {
		for (const [parts, expected] of [[0, '0'], [1, '1'], [2, '2-9'], [9, '2-9'], [10, '10-99'], [99, '10-99'], [100, '100-999'], [999, '100-999'], [1000, '1000+']] as const) {
			const event = buildParadisOfficeTelemetryEvent({ ...safeInput, counts: { ...safeInput.counts, parts }, timings: { totalMilliseconds: -1.4 } });
			assert.strictEqual(event?.countBuckets.parts, expected);
			assert.strictEqual(event?.timings.totalMilliseconds, 0);
		}
	});

	test('rejects paths, filenames, content, cell text, connection secrets, identifiers, and geometry', () => {
		for (const key of ['path', 'filename', 'content', 'cellText', 'connectionSecret', 'requestId', 'ownerCapability', 'range', 'diagonal']) {
			assert.strictEqual(buildParadisOfficeTelemetryEvent({ ...safeInput, [key]: '/private/secret.xlsx' }), undefined, key);
		}
	});

	test('rejects non-own-data records and inconsistent proxies without reading accessors', () => {
		let getterReads = 0;
		const accessorInput = { ...safeInput };
		Object.defineProperty(accessorInput, 'format', { enumerable: true, get: () => { getterReads++; return '/private/secret.docx'; } });
		assert.strictEqual(buildParadisOfficeTelemetryEvent(accessorInput), undefined);
		assert.strictEqual(getterReads, 0);

		let descriptorReads = 0;
		const proxyInput = new Proxy({ ...safeInput }, {
			getOwnPropertyDescriptor: (target, property) => {
				descriptorReads++;
				if (descriptorReads > 1) { throw new Error('/private/connection-secret'); }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		assert.strictEqual(buildParadisOfficeTelemetryEvent(proxyInput), undefined);
	});

	test('rejects values outside every public allowlist and invalid counters', () => {
		for (const input of [
			{ ...safeInput, format: 'report.docx' },
			{ ...safeInput, scheme: 'file:///private/report.docx' },
			{ ...safeInput, backend: 'ssh.example.test' },
			{ ...safeInput, version: 2 },
			{ ...safeInput, outcome: 'engine:/private/report.docx' },
			{ ...safeInput, counts: { ...safeInput.counts, parts: -1 } },
			{ ...safeInput, timings: { totalMilliseconds: Number.NaN } },
		]) {
			assert.strictEqual(buildParadisOfficeTelemetryEvent(input), undefined);
		}
	});

	test('emitter forwards one sanitized event and rejects source or connection identity', () => {
		const events: unknown[] = [];
		const options: ParadisOfficeTelemetryOptions = {
			backend: 'local',
			emit: event => events.push(event),
		};

		emitParadisOfficeTelemetry(options, { ...safeInput, outcome: 'cancelled' });
		emitParadisOfficeTelemetry(options, { ...safeInput, path: '/private/quarterly-secret.docx', connectionSecret: 'connection-secret' });

		assert.deepStrictEqual(events, [{
			format: 'docx', scheme: 'file', backend: 'local', version: 1,
			countBuckets: { parts: '1000+', semanticUnits: '2-9', warnings: '1' },
			timings: { totalMilliseconds: 120_000 }, outcome: 'cancelled',
		}]);
		assert.strictEqual(JSON.stringify(events).includes('secret'), false);
	});

	test('emitter isolates telemetry sink failures', () => {
		assert.doesNotThrow(() => emitParadisOfficeTelemetry({
			backend: 'local', emit: () => { throw new Error('/private/telemetry-secret'); },
		}, safeInput));
	});
});
