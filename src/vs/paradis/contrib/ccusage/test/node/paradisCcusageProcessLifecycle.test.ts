/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCcusageService } from '../../node/paradisCcusageChannel.js';

suite('ParadisCcusage process lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('tree-kills at 60 seconds and classifies the explicit deadline without an offline retry', async () => {
		const clock = sinon.useFakeTimers();
		const kill = sinon.spy(() => true);
		let callback: ((error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) | undefined;
		let timeoutOption: number | undefined;
		let invocations = 0;
		const execFile = ((_file: string, _args: readonly string[], options: cp.ExecFileOptionsWithStringEncoding, cb: typeof callback) => {
			invocations++;
			timeoutOption = options.timeout;
			callback = cb;
			return {
				pid: undefined,
				exitCode: null,
				signalCode: null,
				kill,
			} as unknown as cp.ChildProcess;
		}) as unknown as typeof cp.execFile;
		const service = new ParadisCcusageService(new NullLogService(), undefined, undefined, execFile, () => clock.now);

		const pending = service.fetchDaily({ executablePath: '/test/ccusage' });
		while (!callback) {
			await Promise.resolve();
		}
		await clock.tickAsync(60_000);
		assert.strictEqual(kill.callCount, 1);
		assert.strictEqual(timeoutOption, undefined);

		callback!(Object.assign(new Error('terminated'), { killed: false }), '', 'terminated');
		await assert.rejects(pending, /terminated/);
		assert.strictEqual(invocations, 1, 'an explicitly timed out execution must not retry with --offline');
		service.dispose();
	});
});
