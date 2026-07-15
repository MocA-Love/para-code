/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ParadisAgentPreviewChannel } from '../../electron-browser/paradisAgentPreview.contribution.js';

suite('ParadisAgentPreviewChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not return file paths or raw renderer exceptions over IPC', async () => {
		const privatePath = '/private/customer/project/secret.txt';
		const privateMarker = 'renderer-private-exception-marker';
		const channel = new ParadisAgentPreviewChannel(
			{ openEditor: async () => { throw new Error(privateMarker); } } as unknown as IEditorService,
			{ stat: async () => ({ isDirectory: false }) } as unknown as IFileService,
		);

		const result = await channel.call<unknown>(undefined, 'previewFile', [privatePath]);
		const serialized = JSON.stringify(result);

		assert.strictEqual(serialized.includes(privatePath), false);
		assert.strictEqual(serialized.includes(privateMarker), false);
		assert.deepStrictEqual(result, { ok: false, error: 'Failed to open the file in Para Code.' });
	});

	test('does not return stat failures over IPC', async () => {
		const privateMarker = 'stat-private-exception-marker';
		const channel = new ParadisAgentPreviewChannel(
			{ openEditor: async () => undefined } as unknown as IEditorService,
			{ stat: async () => { throw new Error(privateMarker); } } as unknown as IFileService,
		);

		const result = await channel.call<unknown>(undefined, 'previewFile', ['/private/missing.txt']);

		assert.strictEqual(JSON.stringify(result).includes(privateMarker), false);
		assert.deepStrictEqual(result, { ok: false, error: 'Failed to open the file in Para Code.' });
	});
});
