/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-background-wrapper.ts, src/main/browser/extensions/browser-extension-web-accessible-resources.ts

// 拡張機能の写しを、Para Code の詰め物が動く形に書き換える（起動ごと、最初に読み込む前に 1 回）。
//
//  - manifest: 背景の worker の入口を Para Code の入口（詰め物を読んでから拡張機能自身の worker を読む）に
//    替える。connect-src を絞っている拡張機能には私用スキームを足す。web_accessible_resources から Para Code の
//    ファイル（トークンなど）を外す（ウェブページから読めないように）
//  - 拡張機能のページ（.html）: 先頭のスクリプトの前に詰め物の <script> を入れる（ページ用の preload を足すと
//    upstream のビルドに手を入れることになるため。manifest の sandbox のページは origin が無いので入れない）
//  - 詰め物とトークンを書く
//  - 元の manifest は別のファイルに残し、何度でも元から書き換え直す
//
// Manifest V2 は書き換えない（Orca も V3 だけ。Para Code は V2 も読み込むが、詰め物の API は無い）。

import { promises as fs } from 'fs';
import { dirname, join, posix } from '../../../../base/common/path.js';
import {
	PARADIS_EXTENSION_API_SCHEME,
	PARADIS_EXTENSION_ORIGINAL_MANIFEST_FILE,
	PARADIS_EXTENSION_PRIVATE_FILES,
	PARADIS_EXTENSION_SHIM_FILE,
	PARADIS_EXTENSION_TOKEN_FILE,
	PARADIS_EXTENSION_WORKER_WRAPPER_FILE,
} from '../common/paradisBrowserExtensionApiWire.js';

type Manifest = Record<string, unknown>;

function asRecord(value: unknown): Manifest | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Manifest : undefined;
}

const API_SOURCES = ['\'self\'', `${PARADIS_EXTENSION_API_SCHEME}:`];

/** connect-src を絞っている方針に、私用スキームを足す（worker が API とトークンを読めるように）。 */
export function paradisWithApiConnectSource(policy: string): string {
	const directives = policy.split(';').map(directive => directive.trim()).filter(Boolean);
	const named = (name: string) => directives.findIndex(directive => directive.toLowerCase().split(/\s+/)[0] === name);
	const sourcesOf = (index: number) => directives[index].split(/\s+/).slice(1).filter(source => source !== '\'none\'');
	const connect = named('connect-src');
	if (connect >= 0) {
		const sources = sourcesOf(connect);
		directives[connect] = ['connect-src', ...sources, ...API_SOURCES.filter(source => !sources.includes(source))].join(' ');
	} else {
		const fallback = named('default-src');
		if (fallback < 0) {
			return policy;
		}
		const sources = sourcesOf(fallback);
		directives.push(['connect-src', ...sources, ...API_SOURCES.filter(source => !sources.includes(source))].join(' '));
	}
	return directives.join('; ');
}

/** 書き換えた manifest と、書く入口のファイル。背景の worker が無ければ入口は無い。 */
export interface IParadisRewrittenManifest {
	readonly manifest: Manifest;
	readonly wrapper?: { readonly path: string; readonly source: string };
}

/**
 * 背景の worker の入口を替え、connect-src に私用スキームを足す。入口は元の worker と同じフォルダに置く
 * （classic の worker の importScripts の相対パスは worker 自身の URL から解決されるため）。
 */
export function paradisRewriteManifestForShim(manifest: Manifest): IParadisRewrittenManifest {
	let next: Manifest = { ...manifest };
	const policy = asRecord(manifest.content_security_policy);
	if (policy && typeof policy.extension_pages === 'string') {
		next = { ...next, content_security_policy: { ...policy, extension_pages: paradisWithApiConnectSource(policy.extension_pages) } };
	}
	const background = asRecord(manifest.background);
	const worker = background?.service_worker;
	if (!background || typeof worker !== 'string' || !worker.trim()) {
		return { manifest: next };
	}
	const original = posix.normalize(worker.trim().replace(/^\/+/, ''));
	if (original.startsWith('..')) {
		throw new Error('The background worker must be inside the extension folder');
	}
	const folder = posix.dirname(original);
	const wrapperPath = folder === '.' ? PARADIS_EXTENSION_WORKER_WRAPPER_FILE : `${folder}/${PARADIS_EXTENSION_WORKER_WRAPPER_FILE}`;
	const shimUrl = JSON.stringify(`/${PARADIS_EXTENSION_SHIM_FILE}`);
	const originalUrl = JSON.stringify(`/${original.split('/').map(encodeURIComponent).join('/')}`);
	const load = background.type === 'module'
		? `import ${shimUrl};\nimport ${originalUrl};\n`
		: `importScripts(${shimUrl}, ${originalUrl});\n`;
	// scripts は Firefox の背景の書き方。Chromium の V3 は無視するが、読み込むたびに警告を出す
	const chromiumBackground = Object.fromEntries(Object.entries(background).filter(([key]) => key !== 'scripts'));
	return {
		manifest: { ...next, background: { ...chromiumBackground, service_worker: wrapperPath } },
		wrapper: { path: wrapperPath, source: `// Written by Para Code: its chrome.* additions, then this extension's own worker.\n${load}` },
	};
}

/** Chrome の web_accessible_resources の `*`（フォルダもまたぐ）と `?` を正規表現にする。 */
function resourcePatternToRegExp(pattern: string): RegExp {
	const body = pattern.replace(/^\/+/, '').split('').map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
	return new RegExp(`^${body}$`);
}

/** 名前の比べ方（大文字小文字と Unicode の正規化の違いを区別しないディスクがあるため）。 */
function foldName(name: string): string {
	return name.normalize('NFD').toLowerCase();
}

const PRIVATE_NAMES = new Set(PARADIS_EXTENSION_PRIVATE_FILES.map(foldName));

/** Para Code のファイルか（どのフォルダにあっても、名前で決める。拡張機能自身が同じ名前を持つものは写す時点で断っている）。 */
export function paradisIsPrivateExtensionFile(relative: string): boolean {
	return PRIVATE_NAMES.has(foldName(posix.basename(relative)));
}

/**
 * web_accessible_resources から Para Code のファイルを外す。Chromium は URL の綴りで照らし合わせるが、
 * 読むのはファイルシステムからなので、別の綴り（大文字小文字など）でも同じファイルを指しうる。そのため
 * パターンを写しの中の実際のファイルに展開し、Para Code のファイルを除く。
 */
export function paradisWithPrivateFilesHidden(manifest: Manifest, packageFiles: readonly string[]): Manifest {
	const entries = manifest.web_accessible_resources;
	if (!Array.isArray(entries)) {
		return manifest;
	}
	const visible = (resources: readonly unknown[]): string[] => {
		const next = new Set<string>();
		for (const resource of resources) {
			if (typeof resource !== 'string') {
				continue;
			}
			const matched = /[*?]/.test(resource) ? packageFiles.filter(file => resourcePatternToRegExp(resource).test(file)) : [resource.replace(/^\/+/, '')];
			for (const file of matched) {
				if (!paradisIsPrivateExtensionFile(file)) {
					next.add(file);
				}
			}
		}
		return [...next];
	};
	return {
		...manifest,
		web_accessible_resources: entries.map((entry: unknown) => {
			const record = asRecord(entry);
			return record && Array.isArray(record.resources) ? { ...record, resources: visible(record.resources) } : entry;
		}),
	};
}

/** 詰め物の <script> の印（何度書き換えても 1 つだけ入れる）。 */
const SHIM_SCRIPT_TAG = `<script src="/${PARADIS_EXTENSION_SHIM_FILE}" data-paracode-extension-api></script>`;

/** 拡張機能のページの最初のスクリプトの前（無ければ </head> の前、それも無ければ先頭）に詰め物を入れる。 */
export function paradisInjectShimIntoHtml(html: string): string {
	if (html.includes('data-paracode-extension-api')) {
		return html;
	}
	const firstScript = html.search(/<script\b/i);
	if (firstScript >= 0) {
		return `${html.slice(0, firstScript)}${SHIM_SCRIPT_TAG}${html.slice(firstScript)}`;
	}
	const headEnd = html.search(/<\/head\s*>/i);
	if (headEnd >= 0) {
		return `${html.slice(0, headEnd)}${SHIM_SCRIPT_TAG}${html.slice(headEnd)}`;
	}
	return `${SHIM_SCRIPT_TAG}${html}`;
}

/** 写しの中のファイル（フォルダからの相対パス、`/` 区切り）。 */
async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (folder: string, relative: string): Promise<void> => {
		for (const dirent of await fs.readdir(folder, { withFileTypes: true })) {
			const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
			if (dirent.isDirectory()) {
				await walk(join(folder, dirent.name), childRelative);
			} else if (dirent.isFile()) {
				files.push(childRelative);
			}
		}
	};
	await walk(root, '');
	return files;
}

/**
 * 写しを詰め物が動く形にする。元の manifest は {@link PARADIS_EXTENSION_ORIGINAL_MANIFEST_FILE} に残し、
 * そこから書き換える（P3 の写しには無いので、そのときは今の manifest.json を元として残す）。
 */
export async function paradisPrepareExtensionCopy(copy: string, token: string, shimSource: string): Promise<void> {
	const originalPath = join(copy, PARADIS_EXTENSION_ORIGINAL_MANIFEST_FILE);
	let originalText: string;
	try {
		originalText = await fs.readFile(originalPath, 'utf8');
	} catch {
		originalText = await fs.readFile(join(copy, 'manifest.json'), 'utf8');
		await fs.writeFile(originalPath, originalText);
	}
	const original = asRecord(JSON.parse(originalText));
	if (!original || original.manifest_version !== 3) {
		// V2（と読めない manifest）は書き換えない
		return;
	}
	const rewritten = paradisRewriteManifestForShim(original);
	if (rewritten.wrapper) {
		await fs.writeFile(join(copy, ...rewritten.wrapper.path.split('/')), rewritten.wrapper.source);
	}
	await fs.writeFile(join(copy, PARADIS_EXTENSION_SHIM_FILE), shimSource);
	await fs.writeFile(join(copy, PARADIS_EXTENSION_TOKEN_FILE), JSON.stringify({ token }));
	const files = await listFiles(copy);
	await fs.writeFile(join(copy, 'manifest.json'), JSON.stringify(paradisWithPrivateFilesHidden(rewritten.manifest, files), undefined, '\t'));
	const sandboxPages = new Set((Array.isArray(asRecord(original.sandbox)?.pages) ? asRecord(original.sandbox)!.pages as unknown[] : [])
		.filter((page): page is string => typeof page === 'string')
		.map(page => posix.normalize(page.replace(/^\/+/, ''))));
	for (const file of files) {
		if (!/\.html?$/i.test(file) || sandboxPages.has(file)) {
			continue;
		}
		const path = join(copy, ...file.split('/'));
		const html = await fs.readFile(path, 'utf8');
		const injected = paradisInjectShimIntoHtml(html);
		if (injected !== html) {
			await fs.mkdir(dirname(path), { recursive: true });
			await fs.writeFile(path, injected);
		}
	}
}
