/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の訳を言語パックの訳に重ねる処理（paradisNls.ts）と、訳の JSON のキーが実在するかの見張り。

import assert from 'assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { INLSConfiguration } from '../../../nls.js';
import { IParadisNlsTranslations, PARADIS_NLS_MESSAGES_FILE, paradisApplyNlsTranslations, paradisMergeNlsTranslations, paradisNlsTranslationsPath } from '../../node/paradisNls.js';

suite('Paradis NLS translations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const nlsKeys: [string, string[]][] = [
		['vs/paradis/contrib/a/browser/a', ['a.one', 'a.two']],
		['vs/workbench/contrib/b/browser/b', ['b.one']],
	];
	const defaultMessages = ['One', 'Two', 'Upstream'];

	test('fills only untranslated messages of fork modules', () => {
		const translations: IParadisNlsTranslations = {
			contents: {
				'vs/paradis/contrib/a/browser/a': { 'a.one': '一', 'a.two': '二' },
				'vs/workbench/contrib/b/browser/b': { 'b.one': '本家を上書きしない' },
			}
		};
		// a.two は言語パックが訳している体（fork のモジュールでも言語パックの訳を残す）
		assert.deepStrictEqual(paradisMergeNlsTranslations(nlsKeys, defaultMessages, ['One', 'パックの二', 'Upstream'], translations), ['一', 'パックの二', 'Upstream']);
	});

	suite('applying to a language pack', () => {
		let root: string;

		setup(() => {
			root = mkdtempSync(join(tmpdir(), 'paradis-nls-'));
		});

		teardown(() => {
			rmSync(root, { recursive: true, force: true });
		});

		function layout(translations: string | undefined): INLSConfiguration {
			const metadata = join(root, 'out');
			const cache = join(root, 'clp', 'hash.ja', 'commit');
			mkdirSync(cache, { recursive: true });
			mkdirSync(metadata, { recursive: true });
			writeFileSync(join(metadata, 'nls.keys.json'), JSON.stringify(nlsKeys));
			writeFileSync(join(metadata, 'nls.messages.json'), JSON.stringify(defaultMessages));
			writeFileSync(join(cache, 'nls.messages.json'), JSON.stringify(['One', 'Two', 'アップストリーム']));
			if (translations !== undefined) {
				const file = paradisNlsTranslationsPath(metadata, 'ja');
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, translations);
			}
			return {
				userLocale: 'ja',
				osLocale: 'ja',
				resolvedLanguage: 'ja',
				defaultMessagesFile: join(metadata, 'nls.messages.json'),
				languagePack: { translationsConfigFile: join(root, 'clp', 'hash.ja', 'tcf.json'), messagesFile: join(cache, 'nls.messages.json'), corruptMarkerFile: join(root, 'clp', 'hash.ja', 'corrupted.info') },
				locale: 'ja',
				availableLanguages: { '*': 'ja' },
			};
		}

		function metadataPath(): string {
			return join(root, 'out');
		}

		test('writes the merged file once and points the configuration at it', async () => {
			const configuration = layout(JSON.stringify({ contents: { 'vs/paradis/contrib/a/browser/a': { 'a.one': '一' } } }));
			const merged = join(root, 'clp', 'hash.ja', 'commit', PARADIS_NLS_MESSAGES_FILE);

			const first = await paradisApplyNlsTranslations(configuration, metadataPath());
			const written = JSON.parse(readFileSync(merged, 'utf-8'));
			writeFileSync(merged, JSON.stringify(['cached']));
			const second = await paradisApplyNlsTranslations(configuration, metadataPath());

			assert.deepStrictEqual({
				first: first.languagePack?.messagesFile,
				written,
				upstreamKept: JSON.parse(readFileSync(configuration.languagePack!.messagesFile, 'utf-8')),
				second: second.languagePack?.messagesFile,
				secondReused: JSON.parse(readFileSync(merged, 'utf-8')),
			}, {
				first: merged,
				written: ['一', 'Two', 'アップストリーム'],
				upstreamKept: ['One', 'Two', 'アップストリーム'],
				second: merged,
				secondReused: ['cached'],
			});
		});

		test('keeps the upstream configuration without translations or with a broken file', async () => {
			const missing = layout(undefined);
			const missingResult = await paradisApplyNlsTranslations(missing, metadataPath());
			const broken = layout('{ "contents": ');
			await assert.rejects(paradisApplyNlsTranslations(broken, metadataPath()));
			const english: INLSConfiguration = { ...missing, languagePack: undefined, resolvedLanguage: 'en' };

			assert.deepStrictEqual({
				missing: missingResult,
				english: await paradisApplyNlsTranslations(english, metadataPath()),
				merged: existsSync(join(root, 'clp', 'hash.ja', 'commit', PARADIS_NLS_MESSAGES_FILE)),
			}, {
				missing,
				english,
				merged: false,
			});
		});
	});

	test('every translated key exists in the fork sources', () => {
		// out/vs を起点にリポジトリの src を指す (paradisSettingsDialogCoverage.test.ts と同じ辿り方)
		const src = FileAccess.asFileUri('vs/../../src').fsPath;
		const translations: IParadisNlsTranslations = JSON.parse(readFileSync(paradisNlsTranslationsPath(src, 'ja'), 'utf-8'));
		const problems: string[] = [];
		for (const [moduleId, keys] of Object.entries(translations.contents)) {
			const file = join(src, `${moduleId}.ts`);
			if (!moduleId.startsWith('vs/paradis/') || !existsSync(file)) {
				problems.push(`${moduleId}: not a fork source file`);
				continue;
			}
			const source = readFileSync(file, 'utf-8');
			for (const key of Object.keys(keys)) {
				const quoted = `'${key}'`;
				if (!source.includes(`localize(${quoted}`) && !source.includes(`localize2(${quoted}`) && !source.includes(`key: ${quoted}`)) {
					problems.push(`${moduleId}: no localize key ${key}`);
				}
			}
		}
		assert.deepStrictEqual(problems, []);
	});
});
