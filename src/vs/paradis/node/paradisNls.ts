/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の localize の訳を、入っている言語パックの訳の上に足す。
//
// 言語パック（MS-CEINTL.vscode-language-pack-ja など）は本家のモジュールの訳しか持たないので、
// fork のモジュールの文言は原文のまま出る。fork の訳は fork 所有の JSON
// （`src/vs/paradis/nls/paradisNls.<言語>.json`、言語パックの main.i18n.json と同じ `contents` の形）
// に持ち、配布版へは `build/next/paradisResources.ts` で同梱する。
//
// 本家の `resolveNLSConfiguration`（`src/vs/base/node/nls.ts`）が作った訳の一覧はそのまま残し、
// 同じキャッシュのディレクトリに fork の訳を重ねた別のファイルを作って、そちらを読ませる。
// どこで失敗しても本家の結果をそのまま返す（起動を止めない）。

import { promises } from 'fs';
import { dirname, join } from '../../base/common/path.js';
import { IResolveNLSConfigurationContext, resolveNLSConfiguration as resolveUpstreamNLSConfiguration } from '../../base/node/nls.js';
import { Promises } from '../../base/node/pfs.js';
import { INLSConfiguration } from '../../nls.js';
import { paradisWriteFileAtomic } from './paradisWriteFileAtomic.js';

/**
 * Module ids whose messages the fork translations may fill. Upstream modules keep the
 * language pack's translations only.
 */
const PARADIS_TRANSLATABLE_MODULE_PREFIX = 'vs/paradis/';

/** Name of the merged messages file written next to the language pack's `nls.messages.json`. */
export const PARADIS_NLS_MESSAGES_FILE = 'paradis.nls.messages.json';

/**
 * Fork translations in the shape of a language pack's `main.i18n.json`:
 * module id → localize key → translated message.
 */
export interface IParadisNlsTranslations {
	readonly contents: Record<string, Record<string, string>>;
}

/**
 * Path of the fork translations file for a language, relative to the NLS metadata folder
 * (`out/` in a packaged build).
 */
export function paradisNlsTranslationsPath(nlsMetadataPath: string, language: string): string {
	return join(nlsMetadataPath, 'vs', 'paradis', 'nls', `paradisNls.${language}.json`);
}

/**
 * Overlays the fork translations on the language pack's messages. A message is replaced only
 * when its module is a fork module and the language pack left it untranslated (it still equals
 * the default message).
 *
 * @param nlsKeys `nls.keys.json`: module id and its keys, in the order of the messages
 * @param defaultMessages `nls.messages.json` of the build (the source messages)
 * @param languagePackMessages messages the upstream resolver produced for the language pack
 */
export function paradisMergeNlsTranslations(nlsKeys: ReadonlyArray<readonly [string, readonly string[]]>, defaultMessages: readonly string[], languagePackMessages: readonly string[], translations: IParadisNlsTranslations): string[] {
	const result = languagePackMessages.slice();
	let index = 0;
	for (const [moduleId, keys] of nlsKeys) {
		const moduleTranslations = moduleId.startsWith(PARADIS_TRANSLATABLE_MODULE_PREFIX) ? translations.contents[moduleId] : undefined;
		for (const key of keys) {
			const translated = moduleTranslations?.[key];
			if (typeof translated === 'string' && translated && result[index] === defaultMessages[index]) {
				result[index] = translated;
			}
			index++;
		}
	}
	return result;
}

/**
 * Writes (once per language pack and build) the messages file with the fork translations and
 * points the configuration at it. Returns the configuration unchanged when there is no
 * language pack or no fork translations for the language.
 */
export async function paradisApplyNlsTranslations(configuration: INLSConfiguration, nlsMetadataPath: string): Promise<INLSConfiguration> {
	const languagePack = configuration.languagePack;
	if (!languagePack) {
		return configuration;
	}

	const translationsFile = paradisNlsTranslationsPath(nlsMetadataPath, configuration.resolvedLanguage);
	if (!(await Promises.exists(translationsFile))) {
		return configuration;
	}

	// The upstream cache folder is keyed by the language pack hash and the build's NLS hash
	// (which includes the commit), so a new release or a new language pack gets a new file.
	const messagesFile = join(dirname(languagePack.messagesFile), PARADIS_NLS_MESSAGES_FILE);
	const withFork: INLSConfiguration = { ...configuration, languagePack: { ...languagePack, messagesFile } };
	if (await Promises.exists(messagesFile)) {
		return withFork;
	}

	const [nlsKeys, defaultMessages, languagePackMessages, translations] = await Promise.all([
		readJson<Array<[string, string[]]>>(join(nlsMetadataPath, 'nls.keys.json')),
		readJson<string[]>(configuration.defaultMessagesFile),
		readJson<string[]>(languagePack.messagesFile),
		readJson<IParadisNlsTranslations>(translationsFile)
	]);
	if (!Array.isArray(nlsKeys) || !Array.isArray(defaultMessages) || !Array.isArray(languagePackMessages) || languagePackMessages.length !== defaultMessages.length || typeof translations?.contents !== 'object' || !translations.contents) {
		return configuration;
	}

	await paradisWriteFileAtomic(messagesFile, JSON.stringify(paradisMergeNlsTranslations(nlsKeys, defaultMessages, languagePackMessages, translations)));
	return withFork;
}

/**
 * Same contract as upstream `resolveNLSConfiguration`, with the fork translations added on
 * top of the language pack. `src/mainImpl.ts` imports this instead of the upstream function.
 */
export async function resolveNLSConfiguration(context: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	const configuration = await resolveUpstreamNLSConfiguration(context);
	try {
		return await paradisApplyNlsTranslations(configuration, context.nlsMetadataPath);
	} catch (error) {
		console.error('[ParadisNls] Adding the Para Code translations failed.', error);
		return configuration;
	}
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await promises.readFile(path, 'utf-8'));
}
