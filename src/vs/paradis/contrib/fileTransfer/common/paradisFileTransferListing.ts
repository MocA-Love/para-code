/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の一覧の項目と、並べ替え・絞り込み・表示の整形（どれも純関数）。

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { paradisIsTransferTempName } from './paradisFileTransferQueueTypes.js';

/** 一覧の 1 行。 */
export interface IParadisPaneEntry {
	readonly name: string;
	readonly resource: URI;
	readonly kind: 'directory' | 'file' | 'symlink';
	/** 開くと中へ進めるか（フォルダーと、フォルダーを指すリンク）。 */
	readonly isDirectory: boolean;
	/** バイト数。分からなければ undefined（フォルダーは出さない）。 */
	readonly size: number | undefined;
	/** 更新日時（ミリ秒）。分からなければ undefined。 */
	readonly mtime: number | undefined;
	/** `st_mode & 0o7777`。権限のチャネルが無い相手では undefined。 */
	readonly mode: number | undefined;
}

export type ParadisSortKey = 'name' | 'mtime' | 'size' | 'kind';

export interface IParadisSortState {
	readonly key: ParadisSortKey;
	readonly descending: boolean;
}

export const PARADIS_DEFAULT_SORT: IParadisSortState = { key: 'name', descending: false };

/** 先頭が `.` の名前を隠しファイルとして扱う（手元・接続先とも Unix 系の約束に合わせる）。 */
export function paradisIsHiddenName(name: string): boolean {
	return name.startsWith('.');
}

/** 拡張子（小文字、ドットなし）。`.env` のような先頭ドットだけの名前は拡張子なし。 */
export function paradisExtensionOf(name: string): string {
	const index = name.lastIndexOf('.');
	return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

const KIND_BY_EXTENSION: Record<string, () => string> = {
	json: () => 'JSON',
	jsonc: () => 'JSON',
	md: () => 'Markdown',
	markdown: () => 'Markdown',
	ts: () => 'TypeScript',
	tsx: () => 'TypeScript',
	js: () => 'JavaScript',
	mjs: () => 'JavaScript',
	cjs: () => 'JavaScript',
	jsx: () => 'JavaScript',
	py: () => 'Python',
	rb: () => 'Ruby',
	go: () => 'Go',
	rs: () => 'Rust',
	java: () => 'Java',
	html: () => 'HTML',
	htm: () => 'HTML',
	css: () => 'CSS',
	scss: () => 'SCSS',
	yml: () => 'YAML',
	yaml: () => 'YAML',
	toml: () => 'TOML',
	xml: () => 'XML',
	csv: () => 'CSV',
	sql: () => 'SQL',
	sh: () => localize('paradis.fileTransfer.kind.shell', "シェルスクリプト"),
	bash: () => localize('paradis.fileTransfer.kind.shell', "シェルスクリプト"),
	zsh: () => localize('paradis.fileTransfer.kind.shell', "シェルスクリプト"),
	txt: () => localize('paradis.fileTransfer.kind.text', "テキスト"),
	log: () => localize('paradis.fileTransfer.kind.log', "ログ"),
	conf: () => localize('paradis.fileTransfer.kind.config', "設定"),
	ini: () => localize('paradis.fileTransfer.kind.config', "設定"),
	env: () => localize('paradis.fileTransfer.kind.text', "テキスト"),
	png: () => localize('paradis.fileTransfer.kind.png', "PNG 画像"),
	jpg: () => localize('paradis.fileTransfer.kind.jpeg', "JPEG 画像"),
	jpeg: () => localize('paradis.fileTransfer.kind.jpeg', "JPEG 画像"),
	gif: () => localize('paradis.fileTransfer.kind.gif', "GIF 画像"),
	svg: () => localize('paradis.fileTransfer.kind.svg', "SVG 画像"),
	webp: () => localize('paradis.fileTransfer.kind.webp', "WebP 画像"),
	pdf: () => 'PDF',
	zip: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	gz: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	tgz: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	tar: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	xz: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	bz2: () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
	'7z': () => localize('paradis.fileTransfer.kind.archive', "アーカイブ"),
};

/** 「種類」の列の文字。フォルダー・リンク・拡張子から決める。 */
export function paradisKindLabel(entry: Pick<IParadisPaneEntry, 'name' | 'kind'>): string {
	if (entry.kind === 'directory') {
		return localize('paradis.fileTransfer.kind.folder', "フォルダー");
	}
	if (entry.kind === 'symlink') {
		return localize('paradis.fileTransfer.kind.link', "リンク");
	}
	const name = entry.name.toLowerCase();
	if (name === '.env' || name.startsWith('.env.')) {
		return localize('paradis.fileTransfer.kind.text', "テキスト");
	}
	const extension = paradisExtensionOf(entry.name);
	const label = KIND_BY_EXTENSION[extension];
	if (label) {
		return label();
	}
	return extension
		? localize('paradis.fileTransfer.kind.extension', "{0} ファイル", extension.toUpperCase())
		: localize('paradis.fileTransfer.kind.file', "ファイル");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * 並べ替える。フォルダー（フォルダーを指すリンクを含む）は向きに関わらず常に上に置く。
 * 同じ値どうしは名前の順にして、並びが揺れないようにする。
 */
export function paradisSortEntries(entries: readonly IParadisPaneEntry[], sort: IParadisSortState): IParadisPaneEntry[] {
	const direction = sort.descending ? -1 : 1;
	const byName = (a: IParadisPaneEntry, b: IParadisPaneEntry) => collator.compare(a.name, b.name);
	return [...entries].sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? -1 : 1;
		}
		let result = 0;
		switch (sort.key) {
			case 'mtime':
				result = (a.mtime ?? 0) - (b.mtime ?? 0);
				break;
			case 'size':
				result = (a.size ?? -1) - (b.size ?? -1);
				break;
			case 'kind':
				result = collator.compare(paradisKindLabel(a), paradisKindLabel(b));
				break;
			case 'name':
				result = byName(a, b);
				break;
		}
		return result !== 0 ? result * direction : byName(a, b) * (sort.key === 'name' ? direction : 1);
	});
}

/** 同じ列をもう一度押したら向きを変え、別の列なら昇順から始める（日時とサイズは新しい・大きい順から）。 */
export function paradisNextSort(current: IParadisSortState, key: ParadisSortKey): IParadisSortState {
	if (current.key === key) {
		return { key, descending: !current.descending };
	}
	return { key, descending: key === 'mtime' || key === 'size' };
}

export interface IParadisFilterOptions {
	readonly filter: string;
	readonly showHidden: boolean;
}

/**
 * 隠しファイルと絞り込みの文字で間引く。絞り込みは大文字小文字を区別しない部分一致。
 * 転送の書きかけ（`.paratransfer-*`）は、残っていることに気付けるよう隠しファイルの設定に関わらず出す。
 */
export function paradisFilterEntries(entries: readonly IParadisPaneEntry[], options: IParadisFilterOptions): IParadisPaneEntry[] {
	const needle = options.filter.trim().toLowerCase();
	return entries.filter(entry =>
		(options.showHidden || !paradisIsHiddenName(entry.name) || paradisIsTransferTempName(entry.name)) &&
		(!needle || entry.name.toLowerCase().includes(needle)));
}

/** 名前の中で絞り込みの文字に当たる範囲（強調表示用）。当たらなければ undefined。 */
export function paradisMatchRange(name: string, filter: string): { readonly start: number; readonly end: number } | undefined {
	const needle = filter.trim().toLowerCase();
	if (!needle) {
		return undefined;
	}
	const start = name.toLowerCase().indexOf(needle);
	return start < 0 ? undefined : { start, end: start + needle.length };
}

// --- 表示の整形 ------------------------------------------------------------------------------------

/** `412 B` / `1.2 KB` / `48.3 MB` / `2.0 GB`。1024 単位。 */
export function paradisFormatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** 速度（`11.2 MB/s`）。 */
export function paradisFormatSpeed(bytesPerSecond: number): string {
	return `${paradisFormatSize(Math.max(0, Math.round(bytesPerSecond)))}/s`;
}

/** 残り時間（`残り 18 秒` / `残り 3 分` / `残り 1 時間 5 分`）。 */
export function paradisFormatRemaining(seconds: number): string {
	const total = Math.max(0, Math.ceil(seconds));
	if (total < 60) {
		return localize('paradis.fileTransfer.remainingSeconds', "残り {0} 秒", total);
	}
	const minutes = Math.ceil(total / 60);
	if (minutes < 60) {
		return localize('paradis.fileTransfer.remainingMinutes', "残り {0} 分", minutes);
	}
	return localize('paradis.fileTransfer.remainingHours', "残り {0} 時間 {1} 分", Math.floor(minutes / 60), minutes % 60);
}

/** 更新日時（`2026/10/02 14:20`、このマシンの時刻）。 */
export function paradisFormatDate(mtime: number): string {
	const date = new Date(mtime);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 同じ名前があるときに付ける番号つきの名前。`build.tar.gz` → `build (1).tar.gz`。
 * 先頭のドット（`.env`）は拡張子とみなさず、`.env (1)` にする。
 */
export function paradisNumberedName(name: string, index: number): string {
	const dot = name.indexOf('.', 1);
	if (dot <= 0) {
		return `${name} (${index})`;
	}
	return `${name.slice(0, dot)} (${index})${name.slice(dot)}`;
}

/**
 * 「権限の変更…」を選べるか。権限のチャネルを持つ相手で、選んだ全部の権限が分かっていて、
 * リンクを含まないときだけ（一覧はリンク自身の権限を出すが、chmod はリンク先を変えてしまう）。
 */
export function paradisCanChangePermissions(entries: readonly Pick<IParadisPaneEntry, 'kind' | 'mode'>[], modesAvailable: boolean): boolean {
	return modesAvailable && entries.length > 0 && entries.every(entry => entry.mode !== undefined && entry.kind !== 'symlink');
}
