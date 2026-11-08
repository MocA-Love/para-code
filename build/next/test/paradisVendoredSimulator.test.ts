/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータが同梱する第三者のファイル（serve-sim 0.1.49・scrcpy-server v5.0.1）が、固定した版の中身のままか
// （`vendorServeSim.ts --check`・`vendorScrcpy.ts --check` と同じ照合。通信しない）。

import assert from 'assert';
import * as path from 'path';
import { suite, test } from 'node:test';
import { SCRCPY_VENDOR_DIR, checkVendoredScrcpy } from '../../paradis/simulator/vendorScrcpy.ts';
import { SERVE_SIM_VENDOR_DIR, checkVendoredServeSim } from '../../paradis/simulator/vendorServeSim.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

suite('Para Code vendored simulator files', () => {
	test('serve-sim and scrcpy-server match the pinned sha256', () => {
		assert.deepStrictEqual({
			serveSim: checkVendoredServeSim(path.join(repoRoot, SERVE_SIM_VENDOR_DIR)),
			scrcpy: checkVendoredScrcpy(path.join(repoRoot, SCRCPY_VENDOR_DIR)),
		}, { serveSim: [], scrcpy: [] });
	});
});
