// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { paradisBuildMobileIconThemeManifest } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileFileIconTheme.js';
import { applyIconThemeReply, iconIdFor, iconTargetOf, parseIconSvgsReply, parseIconThemeReply, parseStoredIconTheme, serializeIconTheme, type IconThemeEntry } from './fileIconTheme.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>';

/** PC が作る対応表（Material Icon Theme の形を縮めたもの）を、JSON を通してアプリが受け取った形にする。 */
function pcReply(revision = 'r1') {
	const build = paradisBuildMobileIconThemeManifest({
		iconDefinitions: {
			file: { iconPath: 'file.svg' },
			folder: { iconPath: 'folder.svg' },
			'folder-open': { iconPath: 'folder-open.svg' },
			'folder-src': { iconPath: 'folder-src.svg' },
			typescript: { iconPath: 'typescript.svg' },
			'test-ts': { iconPath: 'test-ts.svg' },
			nodejs: { iconPath: 'nodejs.svg' },
			readme: { iconPath: 'readme.svg' },
		},
		file: 'file',
		folder: 'folder',
		folderExpanded: 'folder-open',
		folderNames: { src: 'folder-src' },
		fileExtensions: { 'test.ts': 'test-ts' },
		fileNames: { 'package.json': 'nodejs', 'readme.md': 'readme' },
		languageIds: { typescript: 'typescript' },
	}, { extensions: id => (id === 'typescript' ? ['.ts'] : []), filenames: () => [] });
	if (!build.supported) {
		throw new Error('unsupported');
	}
	return JSON.parse(JSON.stringify({ t: 'iconTheme', themeId: 'material-icon-theme', revision, supported: true, manifest: build.manifest })) as unknown;
}

function entryOf(reply: unknown): IconThemeEntry {
	const parsed = parseIconThemeReply(reply);
	const entry = parsed !== undefined ? applyIconThemeReply(undefined, parsed) : undefined;
	if (entry === undefined) {
		throw new Error('no entry');
	}
	return entry;
}

describe('fileIconTheme', () => {
	test('PC から届いた対応表で、ファイル名・拡張子・言語・フォルダーのアイコンを決める', () => {
		const entry = entryOf(pcReply());
		const id = (name: string, dir = false, expanded?: boolean) => iconIdFor(entry, name, undefined, iconTargetOf(dir, expanded));
		expect({
			readme: id('README.md'),
			pkg: id('package.json'),
			test: id('app.test.ts'),
			ts: id('app.ts'),
			other: id('notes.txt'),
			src: id('src', true),
			srcOpen: id('src', true, true),
			docsOpen: id('docs', true, true),
			noTheme: iconIdFor(undefined, 'a.ts', undefined, 'file'),
		}).toEqual({
			readme: 'readme', pkg: 'nodejs', test: 'test-ts', ts: 'typescript', other: 'file',
			src: 'folder-src', srcOpen: 'folder-open', docsOpen: 'folder-open', noTheme: undefined,
		});
	});

	test('未対応のテーマ・notModified・版の変更', () => {
		const entry = { ...entryOf(pcReply()), svgs: { file: SVG } };
		const unsupported = parseIconThemeReply({ t: 'iconTheme', themeId: 'vs-seti', revision: 'unsupported:vs-seti', supported: false });
		expect({
			unsupported: unsupported !== undefined ? applyIconThemeReply(undefined, unsupported) : 'none',
			sameKept: applyIconThemeReply(entry, { kind: 'notModified', revision: 'r1' }) === entry,
			mismatch: applyIconThemeReply(entry, { kind: 'notModified', revision: 'r2' }),
			newRevisionDropsSvgs: applyIconThemeReply(entry, parseIconThemeReply(pcReply('r2'))!)?.svgs,
			broken: parseIconThemeReply({ revision: 1 }),
		}).toEqual({
			unsupported: { revision: 'unsupported:vs-seti', themeId: 'vs-seti', supported: false, manifest: undefined, svgs: {} },
			sameKept: true,
			mismatch: undefined,
			newRevisionDropsSvgs: {},
			broken: undefined,
		});
	});

	test('SVG の応答は頼んだ ID だけを取り、危ない SVG は既定のアイコン（null）にする', () => {
		expect(parseIconSvgsReply({
			t: 'iconSvgs',
			revision: 'r1',
			svgs: { file: SVG, folder: '<svg><script>x()</script></svg>', other: SVG },
			missing: ['png', 'unknown'],
		}, ['file', 'folder', 'png', 'later'])).toEqual({
			revision: 'r1',
			stale: false,
			svgs: { file: SVG, folder: null, png: null },
		});
	});

	test('端末の写しは JSON を通して戻せ、形の違う写しは捨てる', () => {
		const entry = { ...entryOf(pcReply()), svgs: { file: SVG, png: null } };
		const restored = parseStoredIconTheme(serializeIconTheme(entry));
		expect({
			same: restored !== undefined && iconIdFor(restored, 'app.test.ts', undefined, 'file'),
			svgs: restored?.svgs,
			broken: parseStoredIconTheme('{'),
			oldVersion: parseStoredIconTheme(JSON.stringify({ v: 0, revision: 'r', themeId: 't' })),
		}).toEqual({ same: 'test-ts', svgs: { file: SVG, png: null }, broken: undefined, oldVersion: undefined });
	});
});
