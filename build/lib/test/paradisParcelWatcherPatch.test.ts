/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { paradisPatchParcelWatcher } from '../../npm/paradisParcelWatcherPatch.ts';

const globSource = [
	'bool Glob::isIgnored(std::string relative_path) {',
	'  #ifdef WASM',
	'    return wasm_regex_match(relative_path, mRegex);',
	'  #else',
	'    return std::regex_match(relative_path, mRegex);',
	'  #endif',
	'}',
].join('\n');

const patchedGlobSource = [
	'bool Glob::isIgnored(std::string relative_path) {',
	'  #ifdef WASM',
	'    return wasm_regex_match(relative_path, mRegex);',
	'  #else',
	'    // PARA-PATCH (PARADIS_MAX_GLOB_MATCH_LENGTH): std::regex_match recurses on input length and blows this',
	'    // thread\'s stack on long paths, killing the whole process (parcel-bundler/watcher#250,',
	'    // unfixed as of 2.5.6). Skip the regex for over-long paths; parcelWatcher.ts re-applies the',
	'    // excludes in JS. See build/npm/paradisParcelWatcherPatch.ts for the threshold and its cost.',
	'    if (relative_path.size() > 200u) {',
	'      return false;',
	'    }',
	'',
	'    return std::regex_match(relative_path, mRegex);',
	'  #endif',
	'}',
].join('\n');

suite('paradis Parcel watcher patch', () => {
	test('patches a built Parcel watcher 2.5.6 fixture with the long-path guard', () => {
		const fixture = createFixture(globSource, true);
		try {
			assert.deepStrictEqual(paradisPatchParcelWatcher(fixture.packageRoot), {
				globPath: fixture.globPath,
				original: globSource,
			});
			assert.strictEqual(fs.readFileSync(fixture.globPath, 'utf8'), patchedGlobSource);
		} finally {
			fixture.dispose();
		}
	});

	test('skips a watcher fixture without a built native module', () => {
		const fixture = createFixture(globSource, false);
		try {
			assert.strictEqual(paradisPatchParcelWatcher(fixture.packageRoot), undefined);
			assert.strictEqual(fs.readFileSync(fixture.globPath, 'utf8'), globSource);
		} finally {
			fixture.dispose();
		}
	});

	test('skips a built watcher fixture at an unsupported version', () => {
		const fixture = createFixture(globSource, true, '2.5.7');
		try {
			assert.strictEqual(paradisPatchParcelWatcher(fixture.packageRoot), undefined);
			assert.strictEqual(fs.readFileSync(fixture.globPath, 'utf8'), globSource);
		} finally {
			fixture.dispose();
		}
	});

	test('does not apply the long-path guard twice', () => {
		const fixture = createFixture(globSource, true);
		try {
			assert.ok(paradisPatchParcelWatcher(fixture.packageRoot));
			const oncePatched = fs.readFileSync(fixture.globPath, 'utf8');

			assert.strictEqual(paradisPatchParcelWatcher(fixture.packageRoot), undefined);
			assert.strictEqual(fs.readFileSync(fixture.globPath, 'utf8'), oncePatched);
		} finally {
			fixture.dispose();
		}
	});

	test('rejects malformed source before changing the fixture file', () => {
		const malformedSource = 'bool Glob::isIgnored(std::string relative_path) { return false; }';
		const fixture = createFixture(malformedSource, true);
		try {
			assert.throws(() => paradisPatchParcelWatcher(fixture.packageRoot), /expected code not found/);
			assert.strictEqual(fs.readFileSync(fixture.globPath, 'utf8'), malformedSource);
		} finally {
			fixture.dispose();
		}
	});
});

function createFixture(source: string, hasNativeModule: boolean, version = '2.5.6'): { packageRoot: string; globPath: string; dispose(): void } {
	const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-parcel-watcher-patch-test-'));
	const watcherRoot = path.join(packageRoot, 'node_modules', '@parcel', 'watcher');
	const globPath = path.join(watcherRoot, 'src', 'Glob.cc');
	fs.mkdirSync(path.dirname(globPath), { recursive: true });
	fs.writeFileSync(path.join(watcherRoot, 'package.json'), JSON.stringify({ version }), 'utf8');
	fs.writeFileSync(globPath, source, 'utf8');

	if (hasNativeModule) {
		const nativeModulePath = path.join(watcherRoot, 'build', 'Release', 'watcher.node');
		fs.mkdirSync(path.dirname(nativeModulePath), { recursive: true });
		fs.writeFileSync(nativeModulePath, '');
	}

	return {
		packageRoot,
		globPath,
		dispose: () => fs.rmSync(packageRoot, { recursive: true, force: true }),
	};
}
