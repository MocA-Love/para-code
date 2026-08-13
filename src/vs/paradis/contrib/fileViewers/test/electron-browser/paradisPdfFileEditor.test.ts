/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { getParadisPdfRenderDecision, isParadisPdfHeader, readParadisPdfHeader } from '../../electron-browser/paradisPdfFileEditor.js';

suite('ParadisPdfFileEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only the PDF header and rejects empty and corrupt input', async () => {
		const options: { length: number }[] = [];
		const fileService = {
			readFile: async (_resource: URI, readOptions: { length: number }) => {
				options.push(readOptions);
				return { value: VSBuffer.fromString('%PDF-') };
			}
		} as unknown as IFileService;

		strictEqual(await readParadisPdfHeader(fileService, URI.file('/workspace/document.pdf')), true);
		deepStrictEqual(options, [{ length: 5 }]);
		deepStrictEqual([new Uint8Array(), VSBuffer.fromString('%PDF').buffer].map(isParadisPdfHeader), [false, false]);
	});

	test('maps PDF preflight results to the observable render outcome', () => {
		const resource = URI.file('/workspace/document.pdf');
		const otherResource = URI.file('/workspace/other.pdf');

		deepStrictEqual([
			getParadisPdfRenderDecision(false, resource, resource, 1, 1),
			getParadisPdfRenderDecision(true, resource, resource, 1, 1),
			getParadisPdfRenderDecision(undefined, resource, resource, 1, 1),
			getParadisPdfRenderDecision(false, resource, otherResource, 1, 1),
			getParadisPdfRenderDecision(false, resource, resource, 1, 2),
		], ['rejected', 'viewer', 'viewer', 'stale', 'stale']);
	});
});
