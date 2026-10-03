/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisParkableFolderConfiguration, ParadisFolderConfigurationParking } from '../../common/paradisFolderConfigurationParking.js';

class FakeFolderConfiguration implements IParadisParkableFolderConfiguration {
	private readonly emitter = new Emitter<void>();
	readonly onDidChange = this.emitter.event;
	disposed = false;
	constructor(readonly name: string) { }
	change(): void {
		this.emitter.fire();
	}
	dispose(): void {
		this.disposed = true;
		this.emitter.dispose();
	}
}

const WORKSPACE = 3;
const FOLDER = 2;

suite('ParadisFolderConfigurationParking', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(capacity = 4, enabled = true): { parking: ParadisFolderConfigurationParking<FakeFolderConfiguration>; values: FakeFolderConfiguration[]; make(name: string): FakeFolderConfiguration } {
		const parking = store.add(new ParadisFolderConfigurationParking<FakeFolderConfiguration>(capacity, () => enabled));
		const values: FakeFolderConfiguration[] = [];
		const cleanup = store.add(new DisposableStore());
		return {
			parking,
			values,
			make: name => {
				const value = new FakeFolderConfiguration(name);
				values.push(value);
				cleanup.add({ dispose: () => { if (!value.disposed) { value.dispose(); } } });
				return value;
			},
		};
	}

	test('hands an unchanged folder configuration back to the same folder only', () => {
		const { parking, make } = create();
		const a = make('a');
		parking.park(URI.file('/workspace-a'), a, WORKSPACE);
		const otherFolder = parking.take(URI.file('/workspace-b'), WORKSPACE);
		const sameFolder = parking.take(URI.file('/workspace-a'), WORKSPACE);
		const again = parking.take(URI.file('/workspace-a'), WORKSPACE);
		assert.deepStrictEqual({ otherFolder, sameFolder: sameFolder?.name, again, disposed: a.disposed, size: parking.size }, {
			otherFolder: undefined,
			sameFolder: 'a',
			again: undefined,
			disposed: false,
			size: 0,
		});
	});

	test('does not reuse a folder configuration whose files changed while parked, or under another workbench state', () => {
		const { parking, make } = create();
		const changed = make('changed');
		const otherState = make('other-state');
		parking.park(URI.file('/workspace-a'), changed, WORKSPACE);
		parking.park(URI.file('/workspace-b'), otherState, WORKSPACE);
		// 待避中に外部で .vscode/settings.json が書き換わった。
		changed.change();
		assert.deepStrictEqual({
			changed: parking.take(URI.file('/workspace-a'), WORKSPACE),
			otherState: parking.take(URI.file('/workspace-b'), FOLDER),
			disposed: [changed.disposed, otherState.disposed],
		}, { changed: undefined, otherState: undefined, disposed: [true, true] });
	});

	test('keeps only the most recent folders and disposes the rest', () => {
		const { parking, values, make } = create(2);
		for (const name of ['a', 'b', 'c']) {
			parking.park(URI.file(`/workspace-${name}`), make(name), WORKSPACE);
		}
		assert.deepStrictEqual({
			disposed: values.map(value => value.disposed),
			hasA: parking.has(URI.file('/workspace-a')),
			c: parking.take(URI.file('/workspace-c'), WORKSPACE)?.name,
		}, { disposed: [true, false, false], hasA: false, c: 'c' });
	});

	test('disposes immediately outside a Para Code managed window or with no capacity, and on dispose', () => {
		const unmanaged = create(4, false);
		const none = create(0);
		const managed = create();
		const a = unmanaged.make('a');
		const b = none.make('b');
		const c = managed.make('c');
		unmanaged.parking.park(URI.file('/a'), a, WORKSPACE);
		none.parking.park(URI.file('/b'), b, WORKSPACE);
		managed.parking.park(URI.file('/c'), c, WORKSPACE);
		managed.parking.dispose();
		assert.deepStrictEqual([a.disposed, b.disposed, c.disposed, managed.parking.size], [true, true, true, 0]);
	});
});
