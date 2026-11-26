/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * 新しく入れた人へ、初回起動時に Open VSX から入れる拡張機能の ID。日本語化・配色・ファイルアイコンだけにしている
 * （既定の `workbench.colorTheme` と `workbench.iconTheme` が、下の 2 つのテーマを指す）。
 * ここに列挙する ID は Open VSX 上に実在することを確認済みのもののみとする。
 *
 * 一覧から外したもの。どれも、既に入れた人からはアンインストールしない（この機能は入れるだけで、消す処理を持たない）。
 * - 2026-11-01: eamodio.gitlens / bradlc.vscode-tailwindcss / Anthropic.claude-code / openai.chatgpt と、
 *   VSIX 同梱の VisualStudioExptTeam.vscodeintellicode / intellicode-api-usage-examples / ms-vsliveshare.vsliveshare
 * - 2026-11-27: 下の 3 つ以外の 23 個（Git・データベース・コンテナ・言語ごとの拡張機能、pixl-garden.BongoCat など）と、
 *   VSIX 同梱の 7 個の全部（同梱の仕組みごと消した）
 */
export const PARADIS_DEFAULT_EXTENSION_IDS: readonly string[] = [
	// 日本語言語パック（導入後、再起動の通知で表示言語へ反映する）
	'MS-CEINTL.vscode-language-pack-ja',
	// 既定のファイルアイコン
	'PKief.material-icon-theme',
	// 既定の配色
	'astro-build.houston'
];

/**
 * 一覧のうち、まだ入れていない ID。台帳（入れ終えた ID、小文字）に載っているものを除く。
 *
 * 台帳は足すだけで、一覧から外した ID も残す。外した ID は一覧に無いので、台帳に載っていてもいなくても
 * 入れ直さない（載っていない＝入れ損ねた、の場合も含む）。
 */
export function paradisPendingDefaultExtensions(defaultIds: readonly string[], doneIds: ReadonlySet<string>): string[] {
	return defaultIds.filter(id => !doneIds.has(id.toLowerCase()));
}

/** 入れ終えた ID の台帳のキー（手元のウィンドウ。SSH のウィンドウは接続先の名前を後ろに付けて分ける）。 */
export const PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY = 'paradis.defaultExtensions.installedIds';

/** 台帳を読む。壊れていれば空として扱う。 */
export function paradisReadDefaultExtensionsLedger(storageService: IStorageService, key: string): Set<string> {
	try {
		return new Set<string>(JSON.parse(storageService.get(key, StorageScope.APPLICATION, '[]')));
	} catch {
		return new Set<string>();
	}
}

/** 台帳を書く。渡された ID をそのまま書き、今の一覧に無い ID を刈り取らない。 */
export function paradisStoreDefaultExtensionsLedger(storageService: IStorageService, key: string, ids: ReadonlySet<string>): void {
	storageService.store(key, JSON.stringify([...ids]), StorageScope.APPLICATION, StorageTarget.MACHINE);
}
