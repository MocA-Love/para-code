/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_MAX_VIEWS,
	ParadisExactViewFrameKeepaliveRegistry,
} from '../../common/paradisExactViewFrameKeepalive.js';

suite('ParadisExactViewFrameKeepaliveRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const exactA = Object.freeze({ windowId: 1, viewId: 'view', targetId: 'target', viewLease: 'lease' });

	test('folds the same exact view into one entry however many panes share it', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry();

		assert.strictEqual(registry.add(exactA), true);
		assert.strictEqual(registry.add({ ...exactA }), false);
		assert.deepStrictEqual({ size: registry.size, snapshot: registry.snapshot() }, { size: 1, snapshot: [exactA] });
	});

	test('treats a view as new when any identity field differs, including a rotated lease', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry();
		registry.add(exactA);

		registry.add({ ...exactA, windowId: 2 });
		registry.add({ ...exactA, viewId: 'other-view' });
		registry.add({ ...exactA, targetId: 'other-target' });
		registry.add({ ...exactA, viewLease: 'other-lease' });

		assert.strictEqual(registry.size, 5);
	});

	test('leaves the ledger untouched for descriptors it cannot trust', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry();
		const rejected = [
			undefined,
			null,
			'not-a-descriptor',
			{ ...exactA, windowId: '1' },
			{ viewId: 'view', targetId: 'target', viewLease: 'lease' },
			{ ...exactA, viewLease: '' },
		];

		assert.deepStrictEqual(
			{
				added: rejected.map(value => registry.add(value)),
				removed: rejected.map(value => registry.remove(value)),
				size: registry.size,
			},
			{
				added: rejected.map(() => false),
				removed: rejected.map(() => false),
				size: 0,
			},
		);
	});

	test('stops accepting views at the cap', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry(2);

		assert.strictEqual(registry.add(exactA), true);
		assert.strictEqual(registry.add({ ...exactA, viewId: 'second' }), true);
		assert.strictEqual(registry.add({ ...exactA, viewId: 'third' }), false);
		assert.strictEqual(registry.size, 2);
	});

	test('hands out a copy so a sweep can drop entries while iterating', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry();
		registry.add(exactA);
		registry.add({ ...exactA, viewId: 'second' });

		// This is what runFrameKeepalive() does: walk the snapshot and retire views that are gone.
		const walked: string[] = [];
		for (const descriptor of registry.snapshot()) {
			walked.push(descriptor.viewId);
			registry.remove(descriptor);
		}

		assert.deepStrictEqual({ walked, size: registry.size }, { walked: ['view', 'second'], size: 0 });
	});

	test('empties out again so the owner can stop its timer', () => {
		const registry = new ParadisExactViewFrameKeepaliveRegistry();
		registry.add(exactA);

		assert.strictEqual(registry.remove({ ...exactA }), true);
		assert.strictEqual(registry.remove(exactA), false);
		assert.strictEqual(registry.size, 0);
	});

	test('caps at the shared maximum by default', () => {
		assert.strictEqual(new ParadisExactViewFrameKeepaliveRegistry().size, 0);
		assert.ok(PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_MAX_VIEWS > 0);
	});
});
