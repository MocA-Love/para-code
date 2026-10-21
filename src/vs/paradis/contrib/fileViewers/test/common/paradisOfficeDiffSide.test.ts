/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import { IParadisWordDiffSide, isParadisOfficeEmptyGitRevision, isParadisOfficeRevisionMissing, paradisEmptyDocxBytes, resolveParadisWordDiffBytes } from '../../common/paradisOfficeDiffSide.js';

suite('paradisOfficeDiffSide', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('compares a Word document added or deleted in git against an empty document but keeps real read failures', () => {
		const gitResource = URI.from({ scheme: 'git', path: '/repo/report.docx' });
		const fileResource = URI.file('/repo/report.docx');
		const document = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
		const read = (resource: URI, bytes: Uint8Array): IParadisWordDiffSide => isParadisOfficeEmptyGitRevision(resource, bytes.byteLength) ? { bytes, absent: true } : { bytes };
		const failed = (error: unknown): IParadisWordDiffSide => ({ error, absent: isParadisOfficeRevisionMissing(error) });
		const notFound = () => failed(new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND));
		const empty = paradisEmptyDocxBytes();
		const summarize = (original: IParadisWordDiffSide, modified: IParadisWordDiffSide) => {
			try {
				const sides = resolveParadisWordDiffBytes(original, modified);
				const name = (bytes: Uint8Array) => bytes === document ? 'document' : bytes.byteLength === empty.byteLength ? 'empty document' : `${bytes.byteLength} bytes`;
				return { original: name(sides.original), modified: name(sides.modified) };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		};
		deepStrictEqual({
			added: summarize(notFound(), read(fileResource, document)),
			deleted: summarize(read(gitResource, document), notFound()),
			beforeFirstCommit: summarize(read(gitResource, new Uint8Array(0)), read(gitResource, document)),
			truncatedWorkingTreeFile: summarize(read(gitResource, document), read(fileResource, new Uint8Array(0))),
			bothMissing: summarize(notFound(), notFound()),
			tooLarge: summarize(failed(new FileOperationError('too large', FileOperationResult.FILE_TOO_LARGE)), read(fileResource, document)),
			brokenOtherSide: summarize(notFound(), failed(new Error('unreadable'))),
		}, {
			added: { original: 'empty document', modified: 'document' },
			deleted: { original: 'document', modified: 'empty document' },
			beforeFirstCommit: { original: 'empty document', modified: 'document' },
			truncatedWorkingTreeFile: { original: 'document', modified: '0 bytes' },
			bothMissing: { error: 'not found' },
			tooLarge: { error: 'too large' },
			brokenOtherSide: { error: 'not found' },
		});
	});
});
