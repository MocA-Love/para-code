/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのダウンロード自動保存機能（paradis.browser.downloads.*）の設定キー・共有定数。

import { Event } from '../../../../base/common/event.js';

export const PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY = 'paradis.browser.downloads.enabled';
export const PARADIS_BROWSER_DOWNLOADS_PATH_KEY = 'paradis.browser.downloads.path';

/** カスタムパス未指定時に OS 標準のダウンロードフォルダ配下へ作るサブフォルダ名。 */
export const PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER = 'Paracode';

// ---------------------------------------------------------------------------------------------
// ダウンロード一覧（URL バー右のボタンとポップオーバー、q.html Q73 案B）の main ⇔ renderer 契約。
// ---------------------------------------------------------------------------------------------

/** electron-main が公開するチャネル名。 */
export const PARADIS_BROWSER_DOWNLOADS_CHANNEL = 'paradisBrowserDownloads';

/** 1件のダウンロードの状態。Electron の `DownloadItem.getState()` に「失敗」の区別を足したもの。 */
export type ParadisBrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

/** renderer へ渡す1件分。パスやURLは表示とツールチップにだけ使い、操作は必ず id で main へ頼む。 */
export interface IParadisBrowserDownloadItem {
	/** main が振る不透明なID。renderer から来た id だけを信じ、パスは受け取らない。 */
	readonly id: string;
	/** 保存されたファイル名（拡張子込み）。保存先が決まる前は Electron の推定名。 */
	readonly filename: string;
	/** 保存先の絶対パス。保存ダイアログで選ぶ前は空文字。 */
	readonly savePath: string;
	/** ダウンロード元の URL（ツールチップ用）。 */
	readonly url: string;
	readonly state: ParadisBrowserDownloadState;
	readonly receivedBytes: number;
	/** 0 はサーバーが大きさを知らせてこなかった（進み具合が分からない）ことを表す。 */
	readonly totalBytes: number;
	/** 実行ファイル。「開く」を出さず、main も開くのを断る。 */
	readonly executable: boolean;
	/** 開始時刻（epoch ms）。一覧は新しい順に並べる。 */
	readonly startTime: number;
}

/** main が公開する面（`ProxyChannel.fromService` でそのまま channel になる）。 */
export interface IParadisBrowserDownloadsMainService {
	/** 一覧が変わったとき。値は新しい順の全件（件数は上限で抑えてある）。 */
	readonly onDidChangeDownloads: Event<readonly IParadisBrowserDownloadItem[]>;
	list(): Promise<readonly IParadisBrowserDownloadItem[]>;
	/** 進行中のものを取り消す。 */
	cancel(id: string): Promise<void>;
	/** 完了したファイルを既定のアプリで開く。実行ファイルは開かない（false を返す）。 */
	open(id: string): Promise<boolean>;
	/** Finder / エクスプローラーでファイルを選んだ状態で表示する。 */
	showInFolder(id: string): Promise<boolean>;
	/** 一覧から消す（ファイルは消さない）。進行中のものは消さない。 */
	remove(id: string): Promise<void>;
	/** 終わったもの（完了・取り消し・失敗）をまとめて一覧から消す。 */
	clearFinished(): Promise<void>;
	/** 保存先フォルダを開く。 */
	openDownloadsFolder(): Promise<boolean>;
}

/**
 * 開くと何かが実行される種類のファイル。これらは一覧に「開く」を出さず「フォルダで表示」だけにする
 * （q.html Q73: 実行ファイルを誤って起動しない）。拡張子は小文字・ドット付きで持つ。
 *
 * 足すときの目安: OS が既定の関連付けで「実行・インストール・スクリプトとして評価」するもの。
 * 圧縮ファイル（.zip 等）は展開されるだけなので含めない。
 */
const PARADIS_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	// macOS
	'.app', '.command', '.tool', '.pkg', '.mpkg', '.dmg', '.terminal', '.workflow', '.action',
	'.scpt', '.scptd', '.applescript', '.osax', '.prefpane', '.kext', '.fileloc', '.inetloc',
	// Windows
	'.exe', '.com', '.bat', '.cmd', '.msi', '.msix', '.msixbundle', '.appx', '.appxbundle', '.msp',
	'.scr', '.pif', '.cpl', '.msc', '.lnk', '.url', '.reg', '.hta', '.vbs', '.vbe', '.js', '.jse',
	'.wsf', '.wsh', '.ps1', '.psm1', '.appref-ms', '.application', '.gadget', '.inf',
	// Linux / 共通
	'.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish', '.run', '.bin', '.appimage', '.deb', '.rpm',
	'.desktop', '.jar', '.py', '.pyw', '.pl', '.rb', '.php',
]);

/**
 * ファイル名が実行ファイルか。拡張子の大文字小文字は区別しない。
 * 拡張子が無いファイルは判断できないので実行ファイル扱いにする（Unix の実行形式は拡張子を持たない）。
 */
export function paradisIsExecutableDownload(filename: string): boolean {
	const name = filename.trim().replace(/[.\s]+$/, '');
	const dot = name.lastIndexOf('.');
	if (dot <= 0) {
		return true;
	}
	return PARADIS_EXECUTABLE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * ボタンの輪に出す全体の進み具合（0〜1）。進行中が無ければ 'idle'、大きさの分からないものが
 * 混じっていれば undefined（輪を回し続ける）。
 */
export function paradisAggregateDownloadProgress(items: readonly IParadisBrowserDownloadItem[]): number | undefined | 'idle' {
	const running = items.filter(item => item.state === 'progressing');
	if (running.length === 0) {
		return 'idle';
	}
	if (running.some(item => item.totalBytes <= 0)) {
		return undefined;
	}
	const total = running.reduce((sum, item) => sum + item.totalBytes, 0);
	const received = running.reduce((sum, item) => sum + Math.min(item.receivedBytes, item.totalBytes), 0);
	return total > 0 ? received / total : undefined;
}

/** 前回は進行中（または未登録）で、今回は完了か失敗になったものがあるか。取り消しは本人の操作なので数えない。 */
export function paradisHasNewlyFinished(previous: readonly IParadisBrowserDownloadItem[], next: readonly IParadisBrowserDownloadItem[]): boolean {
	const before = new Map(previous.map(item => [item.id, item.state]));
	return next.some(item => (item.state === 'completed' || item.state === 'interrupted') && before.get(item.id) !== item.state);
}
