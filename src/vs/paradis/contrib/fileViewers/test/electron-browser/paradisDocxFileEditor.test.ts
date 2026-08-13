/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, strictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { getParadisDocxRenderDecision, isParadisDocxHeader, readParadisDocxHeader } from '../../electron-browser/paradisDocxFileEditor.js';

suite('ParadisDocxFileEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only the DOCX header and rejects empty and corrupt input', async () => {
		const options: { length: number }[] = [];
		const fileService = {
			readFile: async (_resource: URI, readOptions: { length: number }) => {
				options.push(readOptions);
				return { value: VSBuffer.wrap(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)) };
			}
		} as unknown as IFileService;

		strictEqual(await readParadisDocxHeader(fileService, URI.file('/workspace/document.docx')), true);
		deepStrictEqual(options, [{ length: 4 }]);
		deepStrictEqual([new Uint8Array(), Uint8Array.of(0x50, 0x4b, 0x03)].map(isParadisDocxHeader), [false, false]);
	});

	test('maps DOCX preflight results to the observable render outcome', () => {
		const resource = URI.file('/workspace/document.docx');
		const otherResource = URI.file('/workspace/other.docx');

		deepStrictEqual([
			getParadisDocxRenderDecision(false, resource, resource, 1, 1),
			getParadisDocxRenderDecision(true, resource, resource, 1, 1),
			getParadisDocxRenderDecision(undefined, resource, resource, 1, 1),
			getParadisDocxRenderDecision(false, resource, otherResource, 1, 1),
			getParadisDocxRenderDecision(false, resource, resource, 1, 2),
		], ['rejected', 'viewer', 'viewer', 'stale', 'stale']);
	});
});
