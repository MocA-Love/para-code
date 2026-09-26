/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { IPCServer } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { ParadisProcessContributionRegistry } from '../../common/paradisProcessContributions.js';

class RecordingLogService extends NullLogService {
	readonly errors: string[] = [];
	override error(message: string | Error): void {
		this.errors.push(String(message));
	}
}

const accessor: ServicesAccessor = {
	get: () => { throw new Error('no services in this test'); },
};

suite('ParadisProcessContributionRegistry', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('runs every contribution in registration order, keeps going past a failure, and disposes what they return', () => {
		const registry = new ParadisProcessContributionRegistry<string>('test');
		const server = store.add(new IPCServer<string>(Event.None));
		const logService = new RecordingLogService();
		const events: string[] = [];

		registry.register('first', context => {
			events.push(`first:${context.server === server}`);
			return toDisposable(() => events.push('first:disposed'));
		});
		registry.register('broken', () => {
			events.push('broken');
			throw new Error('boom');
		});
		registry.register('last', () => {
			events.push('last');
		});

		const registered = registry.instantiate(server, accessor, logService);
		registered.dispose();

		assert.deepStrictEqual({ ids: registry.getIds(), events, errors: logService.errors }, {
			ids: ['first', 'broken', 'last'],
			events: ['first:true', 'broken', 'last', 'first:disposed'],
			errors: [`[Paradis] failed to register test contribution 'broken'`],
		});
	});

	test('refuses a second registration under the same id', () => {
		const registry = new ParadisProcessContributionRegistry<string>('test');
		registry.register('channel', () => undefined);
		assert.throws(() => registry.register('channel', () => undefined), /already registered/);
	});
});
