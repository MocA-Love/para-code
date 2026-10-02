/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisBuildMobileIconThemeManifest,
	paradisMobileIconThemeRevision,
	paradisParseMobileIconThemeManifest,
	paradisResolveMobileFileIcon,
	paradisSanitizeMobileIconSvg,
	type IParadisMobileIconThemeManifest,
} from '../../common/paradisMobileFileIconTheme.js';

const languages: Record<string, { extensions: string[]; filenames: string[] }> = {
	typescript: { extensions: ['.ts', '.cts', '.mts'], filenames: [] },
	dockerfile: { extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
	json: { extensions: ['.json'], filenames: [] },
	jsonc: { extensions: ['.jsonc'], filenames: [] },
};

const lookup = {
	extensions: (id: string) => languages[id]?.extensions ?? [],
	filenames: (id: string) => languages[id]?.filenames ?? [],
};

/** Material Icon Theme の形を縮めた見本。 */
const materialLike = {
	iconDefinitions: {
		file: { iconPath: './../icons/file.svg' },
		folder: { iconPath: './../icons/folder.svg' },
		'folder-open': { iconPath: './../icons/folder-open.svg' },
		'folder-src': { iconPath: './../icons/folder-src.svg' },
		'folder-src-open': { iconPath: './../icons/folder-src-open.svg' },
		'folder-gh-workflows': { iconPath: './../icons/folder-gh-workflows.svg' },
		typescript: { iconPath: './../icons/typescript.svg' },
		'test-ts': { iconPath: './../icons/test-ts.svg' },
		'typescript-def': { iconPath: './../icons/typescript-def.svg' },
		docker: { iconPath: './../icons/docker.svg' },
		nodejs: { iconPath: './../icons/nodejs.svg' },
		json: { iconPath: './../icons/json.svg' },
		png: { iconPath: './../icons/png.png' },
	},
	file: 'file',
	folder: 'folder',
	folderExpanded: 'folder-open',
	folderNames: { SRC: 'folder-src', 'github/workflows': 'folder-gh-workflows', ghost: 'missing-definition' },
	folderNamesExpanded: { src: 'folder-src-open' },
	fileExtensions: { 'test.ts': 'test-ts', 'd.ts': 'typescript-def', png: 'png' },
	fileNames: { 'package.json': 'nodejs' },
	languageIds: { typescript: 'typescript', dockerfile: 'docker', json: 'json' },
	light: { fileExtensions: { 'test.ts': 'file' } },
};

function manifestOf(document: unknown): IParadisMobileIconThemeManifest {
	const build = paradisBuildMobileIconThemeManifest(document, lookup);
	if (!build.supported) {
		throw new Error(`unsupported: ${build.reason}`);
	}
	return build.manifest;
}

suite('ParadisMobileFileIconTheme', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('PC のエクスプローラーと同じ詳細度でアイコンを決める', () => {
		const manifest = manifestOf(materialLike);
		const resolve = (name: string, target: 'file' | 'folder' | 'folderExpanded' = 'file', parent?: string) => paradisResolveMobileFileIcon(manifest, name, parent, target);
		assert.deepStrictEqual({
			plain: resolve('notes.txt'),
			language: resolve('main.ts'),
			languageUpper: resolve('MAIN.MTS'),
			longerExtension: resolve('a.test.ts'),
			declaration: resolve('index.d.ts'),
			fileName: resolve('package.json'),
			fileNameUpper: resolve('Package.JSON'),
			languageFileName: resolve('Dockerfile'),
			jsoncFollowsJson: resolve('x.jsonc'),
			pngIsListed: resolve('a.png'),
			folder: resolve('docs', 'folder'),
			folderNamed: resolve('src', 'folder'),
			folderOpen: resolve('docs', 'folderExpanded'),
			folderNamedOpen: resolve('Src', 'folderExpanded'),
			parentQualified: resolve('workflows', 'folder', 'github'),
			parentMismatch: resolve('workflows', 'folder', 'other'),
			inheritedKey: resolve('constructor', 'folder'),
		}, {
			plain: 'file',
			language: 'typescript',
			languageUpper: 'typescript',
			longerExtension: 'test-ts',
			declaration: 'typescript-def',
			fileName: 'nodejs',
			fileNameUpper: 'nodejs',
			languageFileName: 'docker',
			jsoncFollowsJson: 'json',
			pngIsListed: 'png',
			folder: 'folder',
			folderNamed: 'folder-src',
			folderOpen: 'folder-open',
			folderNamedOpen: 'folder-src-open',
			parentQualified: 'folder-gh-workflows',
			parentMismatch: 'folder',
			inheritedKey: 'folder',
		});
	});

	test('フォントだけのテーマ（Seti）と壊れた JSON は未対応、定義の無い ID を指す規則は捨てる', () => {
		const seti = { iconDefinitions: { _ts: { fontCharacter: '\\E001', fontColor: '#519aba' } }, fileExtensions: { ts: '_ts' }, fonts: [{ id: 'seti' }] };
		const build = paradisBuildMobileIconThemeManifest(materialLike, lookup);
		assert.deepStrictEqual({
			seti: paradisBuildMobileIconThemeManifest(seti, lookup),
			invalid: paradisBuildMobileIconThemeManifest([], lookup),
			ghostDropped: build.supported && Object.keys(build.manifest.folderNames),
			svgOnly: build.supported && [...build.svgPaths.keys()].includes('png'),
		}, {
			seti: { supported: false, reason: 'no-svg' },
			invalid: { supported: false, reason: 'invalid' },
			ghostDropped: ['src', 'github/workflows'],
			svgOnly: false,
		});
	});

	test('対応表は JSON を通しても同じに読め、版は中身で変わる', () => {
		const manifest = manifestOf(materialLike);
		const roundTrip = paradisParseMobileIconThemeManifest(JSON.parse(JSON.stringify(manifest)));
		assert.deepStrictEqual({
			roundTrip: roundTrip !== undefined && paradisResolveMobileFileIcon(roundTrip, 'a.test.ts', undefined, 'file'),
			badIndex: paradisParseMobileIconThemeManifest({ ...manifest, file: 999 })?.file,
			notObject: paradisParseMobileIconThemeManifest('x'),
			sameRevision: paradisMobileIconThemeRevision('m', '1.0.0', manifest) === paradisMobileIconThemeRevision('m', '1.0.0', manifest),
			versionChanges: paradisMobileIconThemeRevision('m', '1.0.0', manifest) === paradisMobileIconThemeRevision('m', '1.0.1', manifest),
		}, { roundTrip: 'test-ts', badIndex: undefined, notObject: undefined, sameRevision: true, versionChanges: false });
	});

	test('SVG はスクリプト・外部参照・埋め込みを含むものを捨て、宣言とコメントを外す', () => {
		const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="a"/></defs><path fill="url(#a)" d="M0 0h16v16z"/><use href="#a"/></svg>';
		assert.deepStrictEqual([
			paradisSanitizeMobileIconSvg(`<?xml version="1.0"?><!-- c -->${ok}`),
			paradisSanitizeMobileIconSvg('<svg><script>alert(1)</script></svg>'),
			paradisSanitizeMobileIconSvg('<svg onload="x()"></svg>'),
			paradisSanitizeMobileIconSvg('<svg><image href="https://example.com/a.png"/></svg>'),
			paradisSanitizeMobileIconSvg('<svg><use xlink:href="https://example.com/a.svg#x"/></svg>'),
			paradisSanitizeMobileIconSvg('<svg><path fill="url(https://example.com/x)"/></svg>'),
			paradisSanitizeMobileIconSvg('<svg><foreignObject/></svg>'),
			paradisSanitizeMobileIconSvg('<html></html>'),
			paradisSanitizeMobileIconSvg(`<svg>${'x'.repeat(70_000)}</svg>`),
		], [ok, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('SVG の検査は実体参照・CSS のエスケープ・アニメーションでのすり抜けも捨てる', () => {
		assert.deepStrictEqual([
			'<svg/onload=alert(1)></svg>',
			'<svg><set attributeName="href" to="#x"/></svg>',
			'<svg><animate attributeName="xlink:href" values="x"/></svg>',
			'<svg><a href="&#106;avascript:alert(1)"><path/></a></svg>',
			'<svg><path style="fill:u\\72l(http://x)"/></svg>',
			'<svg><use xlink:href="&#x68;ttps://example.com/a.svg"/></svg>',
			'<svg><path fill="url(\'#a\')" d="M0 0"/><use xlink:href="#a"/></svg>',
		].map(svg => paradisSanitizeMobileIconSvg(svg) === undefined), [true, true, true, true, true, true, false]);
	});
});
