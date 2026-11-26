/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の台帳の保存先。`<userData>/paradis/bots/bots.json`（Bot の一覧）と `items.json`（作業項目）、`panes.json`
// （ペインとの結び付け。トークンのハッシュだけ）。
// フォルダは 0700、ファイルは 0600。書き込みは一時ファイル＋rename で 1 つずつ順に行う。
//
// 壊れたファイル（JSON として読めない・全体の形が違う）は、消さずに `<名前>.broken-<時刻>` へ rename で
// 退避してから空で始める。そのまま空で始めると、次の書き込みで元の中身が消えるため。
// 今より新しい版のファイルは読むだけにする（{@link IParadisBotsJsonFile.write} が断る）。

import { promises as fs } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
import { ParadisJsonStateWriter } from '../../../node/paradisJsonStateWriter.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState, PARADIS_BOT_ITEMS_VERSION, paradisBotItemsToStored, paradisParseBotItemsState } from '../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBotsState, PARADIS_BOTS_VERSION, paradisParseBotsState } from '../common/paradisBots.js';
import { EMPTY_PARADIS_BOT_PANES_STATE, IParadisBotPanesState, PARADIS_BOT_PANES_VERSION, paradisParseBotPanesState } from './paradisBotPanes.js';

export interface IParadisBotsLoaded<T> {
	readonly state: T;
	/** 壊れていたので退避した先。 */
	readonly quarantined?: string;
}

/** 台帳 1 枚の保存先（テストではメモリに置き換える）。 */
export interface IParadisBotsJsonFile<T> {
	read(): Promise<IParadisBotsLoaded<T>>;
	/** 渡した中身か、それより新しい中身を書き終えたら解決する。新しい版の台帳は書かない（reject）。 */
	write(state: T): Promise<void>;
}

interface IFormat<T extends { readonly version: number }> {
	readonly empty: T;
	readonly version: number;
	parse(value: unknown): T | undefined;
	stored(state: T): unknown;
}

function jsonFile<T extends { readonly version: number }>(path: string, format: IFormat<T>, now: () => number): IParadisBotsJsonFile<T> {
	const writer = new ParadisJsonStateWriter(path);
	let prepared: Promise<unknown> | undefined;
	return {
		async read() {
			let raw: string;
			try {
				raw = await fs.readFile(path, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return { state: format.empty };
				}
				throw error;
			}
			let state: T | undefined;
			try {
				state = format.parse(JSON.parse(raw));
			} catch {
				state = undefined;
			}
			if (state !== undefined) {
				return { state };
			}
			const quarantined = `${path}.broken-${now()}`;
			await fs.rename(path, quarantined);
			return { state: format.empty, quarantined };
		},
		async write(state) {
			if (state.version !== format.version) {
				throw new Error(`refusing to write ${path}: it was written by a newer Para Code (version ${state.version})`);
			}
			prepared ??= fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await prepared;
			await writer.write(JSON.stringify(format.stored(state), undefined, '\t'));
		},
	};
}

/** Bot の台帳を置くフォルダ。 */
export function paradisBotsDataFolder(userDataPath: string): string {
	return join(userDataPath, 'paradis', 'bots');
}

export function createParadisBotsFile(userDataPath: string, now: () => number = Date.now): IParadisBotsJsonFile<IParadisBotsState> {
	return jsonFile(join(paradisBotsDataFolder(userDataPath), 'bots.json'), { empty: EMPTY_PARADIS_BOTS_STATE, version: PARADIS_BOTS_VERSION, parse: paradisParseBotsState, stored: state => state }, now);
}

export function createParadisBotItemsFile(userDataPath: string, now: () => number = Date.now): IParadisBotsJsonFile<IParadisBotItemsState> {
	return jsonFile(join(paradisBotsDataFolder(userDataPath), 'items.json'), { empty: EMPTY_PARADIS_BOT_ITEMS_STATE, version: PARADIS_BOT_ITEMS_VERSION, parse: paradisParseBotItemsState, stored: paradisBotItemsToStored }, now);
}

/** ペインとの結び付け（ペイントークンの SHA-256 と Bot の id だけ。トークンの値は書かない）。 */
export function createParadisBotPanesFile(userDataPath: string, now: () => number = Date.now): IParadisBotsJsonFile<IParadisBotPanesState> {
	return jsonFile(join(paradisBotsDataFolder(userDataPath), 'panes.json'), { empty: EMPTY_PARADIS_BOT_PANES_STATE, version: PARADIS_BOT_PANES_VERSION, parse: paradisParseBotPanesState, stored: state => state }, now);
}
