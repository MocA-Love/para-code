/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getRingtoneById,
	getRingtoneFilename,
	isBuiltInRingtoneId,
	renderParadisAivisTemplate,
} from '../../common/paradisNotifications.js';

suite('Paradis notifications common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves a built-in ringtone and its non-derived filename', () => {
		const ringtone = getRingtoneById('quick');

		assert.strictEqual(ringtone?.id, 'quick');
		assert.strictEqual(ringtone?.filename, 'supersetquick.mp3');
		assert.strictEqual(isBuiltInRingtoneId('quick'), true);
		assert.strictEqual(getRingtoneFilename('quick'), 'supersetquick.mp3');
	});

	test('rejects an unknown ringtone without inventing a filename', () => {
		assert.strictEqual(getRingtoneById('missing'), undefined);
		assert.strictEqual(isBuiltInRingtoneId('missing'), false);
		assert.strictEqual(getRingtoneFilename('missing'), '');
	});

	test('replaces every repeated placeholder occurrence', () => {
		assert.strictEqual(
			renderParadisAivisTemplate('{{space}} / {{ space }} / {{event}}', {
				space: 'Para Code',
				event: 'complete',
			}),
			'Para Code / Para Code / complete',
		);
	});

	test('removes unknown and missing placeholders while preserving plain text', () => {
		assert.strictEqual(
			renderParadisAivisTemplate('before {{unknown}} {{branch}} {{tab}} after', {
				branch: 'feature/notifications',
			}),
			'before  feature/notifications  after',
		);
	});
});
