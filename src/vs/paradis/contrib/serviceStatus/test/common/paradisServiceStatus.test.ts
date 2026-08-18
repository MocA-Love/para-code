/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisParseServiceStatusIndicator,
	paradisServiceStatusSeverity,
} from '../../common/paradisServiceStatus.js';

suite('ParadisServiceStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps every statuspage.io indicator to its display severity', () => {
		assert.deepStrictEqual([
			paradisServiceStatusSeverity('none'),
			paradisServiceStatusSeverity('minor'),
			paradisServiceStatusSeverity('major'),
			paradisServiceStatusSeverity('critical'),
			paradisServiceStatusSeverity('maintenance'),
			paradisServiceStatusSeverity(undefined),
			paradisServiceStatusSeverity('something-unexpected'),
		], [
			'ok',
			'minor',
			'major',
			'major',
			'maintenance',
			'unknown',
			'unknown',
		]);
	});

	test('parses a well-formed statuspage.io summary payload', () => {
		assert.deepStrictEqual(
			paradisParseServiceStatusIndicator({ status: { indicator: 'minor', description: 'Degraded performance' } }),
			{ indicator: 'minor', description: 'Degraded performance' },
		);
	});

	test('tolerates a missing description', () => {
		assert.deepStrictEqual(
			paradisParseServiceStatusIndicator({ status: { indicator: 'none' } }),
			{ indicator: 'none', description: undefined },
		);
	});

	test('returns undefined for malformed or unexpected payloads', () => {
		assert.deepStrictEqual([
			paradisParseServiceStatusIndicator(undefined),
			paradisParseServiceStatusIndicator(null),
			paradisParseServiceStatusIndicator('not an object'),
			paradisParseServiceStatusIndicator({}),
			paradisParseServiceStatusIndicator({ status: 'not an object' }),
			paradisParseServiceStatusIndicator({ status: {} }),
			paradisParseServiceStatusIndicator({ status: { indicator: 123 } }),
		], [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});
