/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as path from 'path';
import { suite, test } from 'node:test';
import { findParadisForbiddenBareImports, paradisStaticBareSpecifiers } from '../paradisMainBareImports.ts';

suite('Para Code main bundle imports', () => {
	test('main, mainImpl, cli and bootstrap-fork statically import no npm package (they would stop the app before it starts)', { timeout: 300_000 }, async () => {
		assert.deepStrictEqual(await findParadisForbiddenBareImports(path.join(import.meta.dirname, '..', '..', '..')), {});
	});

	test('reads static imports and the re-exports esbuild keeps, but not relative paths or dynamic imports', () => {
		const code = [
			'import { a } from "pkg-a";',
			'import "pkg-side-effect";',
			'export * from "pkg-star";',
			'export * as ns from "pkg-namespace";',
			'export { b } from "pkg-named";',
			'import { local } from "./local.js";',
			'export * from "./relative.js";',
			'const lazy = await import("pkg-dynamic");',
			'export {',
			'  a',
			'};',
		].join('\n');
		assert.deepStrictEqual(paradisStaticBareSpecifiers(code), ['pkg-a', 'pkg-named', 'pkg-namespace', 'pkg-side-effect', 'pkg-star']);
	});
});
