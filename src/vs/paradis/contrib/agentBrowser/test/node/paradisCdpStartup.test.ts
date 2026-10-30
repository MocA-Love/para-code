/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code).

import assert from 'assert';
import { createServer } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisConfigureCdpPort } from '../../node/paradisCdpStartup.js';

suite('ParadisCdpStartup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function commandLine(initial: [string, string][] = []) {
		const switches = new Map(initial);
		return {
			switches,
			hasSwitch: (name: string) => switches.has(name),
			appendSwitch: (name: string, value = '') => { switches.set(name, value); },
		};
	}

	test('sets an explicit nonzero loopback port', async () => {
		const args = commandLine();
		await paradisConfigureCdpPort(args, async () => 41_001);
		assert.deepStrictEqual([...args.switches], [['remote-debugging-port', '41001'], ['remote-debugging-address', '127.0.0.1']]);
	});

	for (const entry of [['remote-debugging-port', '0'], ['remote-debugging-port', '9222'], ['remote-debugging-pipe', '']] satisfies [string, string][]) {
		test(`preserves explicit ${entry.join('=')} without allocating`, async () => {
			const args = commandLine([entry]);
			await paradisConfigureCdpPort(args, async () => { throw new Error('must not allocate'); });
			assert.deepStrictEqual([...args.switches], [entry]);
		});
	}

	test('does not enable port zero if allocation fails', async () => {
		const args = commandLine();
		await assert.rejects(paradisConfigureCdpPort(args, async () => { throw new Error('no port'); }), /no port/);
		assert.deepStrictEqual([...args.switches], []);
	});

	for (const port of [0, -1, 65_536, 1.5, NaN]) {
		test(`rejects invalid allocated port ${port}`, async () => {
			const args = commandLine();
			await assert.rejects(paradisConfigureCdpPort(args, async () => port));
			assert.deepStrictEqual([...args.switches], []);
		});
	}

	test('allocates a real available loopback port and releases it', async () => {
		const args = commandLine();
		await paradisConfigureCdpPort(args);
		const port = Number(args.switches.get('remote-debugging-port'));
		assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
