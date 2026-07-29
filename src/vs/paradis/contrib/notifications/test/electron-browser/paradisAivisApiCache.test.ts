/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAivisDictionaryListItem, IParadisAivisModelSummary } from '../../common/paradisNotifications.js';
import {
	clearAivisApiCaches,
	getCachedAivisDictionaryList,
	getCachedAivisModelInfo,
	invalidateAivisDictionaryListCache,
	setCachedAivisDictionaryList,
	setCachedAivisModelInfo,
} from '../../electron-browser/paradisAivisApiCache.js';

const DICTIONARY_A: IParadisAivisDictionaryListItem = {
	uuid: 'dictionary-a',
	name: 'Dictionary A',
	description: 'first',
	word_count: 1,
	created_at: '2026-07-01T00:00:00Z',
	updated_at: '2026-07-02T00:00:00Z',
};

const DICTIONARY_B: IParadisAivisDictionaryListItem = {
	uuid: 'dictionary-b',
	name: 'Dictionary B',
	description: 'second',
	word_count: 2,
	created_at: '2026-07-03T00:00:00Z',
	updated_at: '2026-07-04T00:00:00Z',
};

function model(uuid: string, name: string): IParadisAivisModelSummary {
	return {
		uuid,
		name,
		description: `${name} description`,
		iconUrl: `https://example.test/${uuid}.png`,
		sampleUrl: `https://example.test/${uuid}.mp3`,
		authorName: 'Author',
		authorHandle: 'author',
	};
}

suite('Paradis Aivis API cache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => clearAivisApiCaches());
	teardown(() => clearAivisApiCaches());

	test('separates dictionary lists by API key and invalidates only the selected key', () => {
		setCachedAivisDictionaryList('api-key-a', [DICTIONARY_A]);
		setCachedAivisDictionaryList('api-key-b', [DICTIONARY_B]);

		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-a'), [DICTIONARY_A]);
		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-b'), [DICTIONARY_B]);

		invalidateAivisDictionaryListCache('api-key-a');
		assert.strictEqual(getCachedAivisDictionaryList('api-key-a'), undefined);
		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-b'), [DICTIONARY_B]);
	});

	test('separates model entries by both API key and model UUID', () => {
		const modelA = model('model-a', 'Model A');
		const modelB = model('model-b', 'Model B');
		const modelForOtherKey = model('model-a', 'Model A for another key');

		setCachedAivisModelInfo('api-key-a', 'model-a', modelA);
		setCachedAivisModelInfo('api-key-a', 'model-b', modelB);
		setCachedAivisModelInfo('api-key-b', 'model-a', modelForOtherKey);

		assert.strictEqual(getCachedAivisModelInfo('api-key-a', 'model-a'), modelA);
		assert.strictEqual(getCachedAivisModelInfo('api-key-a', 'model-b'), modelB);
		assert.strictEqual(getCachedAivisModelInfo('api-key-b', 'model-a'), modelForOtherKey);
	});

	test('does not cache a null model lookup', () => {
		setCachedAivisModelInfo('api-key', 'missing-model', null);

		assert.strictEqual(getCachedAivisModelInfo('api-key', 'missing-model'), undefined);
	});

	test('clears dictionary and model caches together', () => {
		setCachedAivisDictionaryList('api-key', [DICTIONARY_A]);
		setCachedAivisModelInfo('api-key', 'model-a', model('model-a', 'Model A'));

		clearAivisApiCaches();

		assert.strictEqual(getCachedAivisDictionaryList('api-key'), undefined);
		assert.strictEqual(getCachedAivisModelInfo('api-key', 'model-a'), undefined);
	});
});
