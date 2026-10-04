/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」ダイアログ (paradisSettingsDialog.ts) に、fork が登録した設定の載せ忘れが無いかを見張るテスト。
//
// ダイアログの行は手で並べている (内部向けの調整値まで並べないため)。そのため設定を足したときに
// ダイアログの更新を忘れやすい。ここでは fork が登録した設定をソースから拾い、
// 「ダイアログに載っている」か「載せない理由を書いた許可リストにある」かのどちらかを求める。
//
// ダイアログは electron-browser 層で CSS も読むので node のテストからは import できない。
// 登録側も 50 を超えるファイルに散っていて、読み込むと workbench の大半が付いてくる。
// どちらもソースを読んで拾う (paradisDevtoolsPathArgumentsSync.test.ts と同じ方式)。

import assert from 'assert';
import { readdirSync, readFileSync, statSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * ダイアログに載せない fork の設定と、その理由。
 * 新しく設定を足して、ダイアログに載せないと決めたときだけここへ足す。
 */
const NOT_IN_DIALOG = new Map<string, string>([
	// 設定エディタに通知設定ダイアログへのリンクを出すためだけの項目。ダイアログでは「通知設定を開く…」の行が同じ役割
	['paradis.notifications.openSettings', 'link-only entry for the settings editor; the dialog has its own button row'],
	// 設定エディタにも出さない (included: false) 内部向けの切り替え
	['paradis.officeViewer.engine', 'internal (included: false)'],
	['paradis.officeViewer.kernelShadow', 'internal diagnostics (included: false)'],
	['paradis.officeViewer.platformBackend', 'internal (included: false)'],
]);

function repositoryRoot(): string {
	// out/vs を起点にリポジトリの src を指し、その親をルートとする (paradisMainProcessImportGraph.test.ts と同じ辿り方)
	return dirname(FileAccess.asFileUri('vs/../../src').fsPath);
}

function listSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			if (name !== 'test' && name !== 'media' && name !== 'node_modules') {
				files.push(...listSourceFiles(path));
			}
		} else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
			files.push(path);
		}
	}
	return files;
}

/** `i` が文字列・コメントの始まりなら、その終わりの次の位置を返す。そうでなければ `i` のまま。 */
function skipNonCode(source: string, i: number): number {
	const char = source[i];
	if (char === '/' && source[i + 1] === '/') {
		const end = source.indexOf('\n', i);
		return end < 0 ? source.length : end;
	}
	if (char === '/' && source[i + 1] === '*') {
		const end = source.indexOf('*/', i + 2);
		return end < 0 ? source.length : end + 2;
	}
	if (char === '\'' || char === '"' || char === '`') {
		let j = i + 1;
		while (j < source.length && source[j] !== char) {
			j += source[j] === '\\' ? 2 : 1;
		}
		return j + 1;
	}
	return i;
}

/** 設定のキーとして書かれたもの。文字列そのもの、定数名 (`[NAME]`)、展開 (`...NAME`) のどれか。 */
type KeyReference =
	| { readonly kind: 'literal'; readonly name: string }
	| { readonly kind: 'constant'; readonly name: string }
	| { readonly kind: 'spread'; readonly name: string };

const ENTRY_HEAD = /^(?:'(?<single>[^'\n]+)'|"(?<double>[^"\n]+)"|\[(?<constant>[A-Za-z_][\w]*)\]|\.\.\.(?<spread>[A-Za-z_][\w]*))/;

/** `openIndex` の `{` から始まるオブジェクトリテラルの、直下の項目のキーを拾う。 */
function objectKeys(source: string, openIndex: number): KeyReference[] {
	const keys: KeyReference[] = [];
	let depth = 0;
	let expectKey = false;
	let i = openIndex;
	while (i < source.length) {
		if (depth === 1 && expectKey) {
			while (/\s/.test(source[i])) {
				i++;
			}
			const afterComment = skipNonCode(source, i);
			if (afterComment !== i && source[i] === '/') {
				i = afterComment;
				continue;
			}
			expectKey = false;
			const head = ENTRY_HEAD.exec(source.slice(i, i + 200))?.groups;
			if (head?.single ?? head?.double) {
				keys.push({ kind: 'literal', name: (head.single ?? head.double)! });
			} else if (head?.constant) {
				keys.push({ kind: 'constant', name: head.constant });
			} else if (head?.spread) {
				keys.push({ kind: 'spread', name: head.spread });
			}
		}
		const next = skipNonCode(source, i);
		if (next !== i) {
			i = next;
			continue;
		}
		const char = source[i];
		if (char === '{' || char === '[' || char === '(') {
			depth++;
			expectKey = depth === 1;
		} else if (char === '}' || char === ']' || char === ')') {
			depth--;
			if (depth === 0) {
				return keys;
			}
		} else if (char === ',' && depth === 1) {
			expectKey = true;
		}
		i++;
	}
	throw new Error(`unterminated object literal at ${openIndex}`);
}

interface ISourceIndex {
	/** `const NAME = 'value'` の NAME → value。 */
	readonly constants: Map<string, string>;
	/** `NAME ... = {` で始まるオブジェクトリテラルの NAME → そのキー。 */
	readonly objects: Map<string, KeyReference[]>;
}

function indexSources(files: readonly { path: string; source: string }[]): ISourceIndex {
	const constants = new Map<string, string>();
	const objects = new Map<string, KeyReference[]>();
	for (const { source } of files) {
		for (const match of source.matchAll(/\bconst\s+(?<name>[A-Za-z_]\w*)\s*(?::[^=;\n]+)?=\s*'(?<value>[^'\n]+)'/g)) {
			constants.set(match.groups!.name, match.groups!.value);
		}
		for (const match of source.matchAll(/\bconst\s+(?<name>[A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*\{/g)) {
			objects.set(match.groups!.name, objectKeys(source, match.index + match[0].length - 1));
		}
	}
	return { constants, objects };
}

function resolveKeys(references: readonly KeyReference[], index: ISourceIndex, where: string): string[] {
	const keys: string[] = [];
	for (const reference of references) {
		if (reference.kind === 'literal') {
			keys.push(reference.name);
		} else if (reference.kind === 'constant') {
			const value = index.constants.get(reference.name);
			assert.ok(value !== undefined, `${where}: could not resolve the setting key constant ${reference.name}`);
			keys.push(value);
		} else {
			const spread = index.objects.get(reference.name);
			assert.ok(spread !== undefined, `${where}: could not resolve the spread properties object ${reference.name}`);
			keys.push(...resolveKeys(spread, index, where));
		}
	}
	return keys;
}

/** `registerConfiguration(...)` に渡した `properties` のキー。fork の設定 (paradis.*) だけを返す。 */
function registeredParadisSettings(root: string): Set<string> {
	const files = listSourceFiles(join(root, 'src', 'vs', 'paradis')).map(path => ({ path, source: readFileSync(path, 'utf8') }));
	const index = indexSources(files);
	const settings = new Set<string>();
	for (const { path, source } of files) {
		if (!source.includes('registerConfiguration(')) {
			continue;
		}
		const where = path.slice(root.length + 1);
		const keys: string[] = [];
		for (const match of source.matchAll(/\bproperties\s*:\s*(?:(?<object>\{)|(?<name>[A-Z][A-Z0-9_]*)\b)/g)) {
			const references = match.groups!.object
				? objectKeys(source, match.index + match[0].length - 1)
				: [{ kind: 'spread', name: match.groups!.name! } satisfies KeyReference];
			keys.push(...resolveKeys(references, index, where));
		}
		// 1 件も拾えないときは書き方が読み取れていない (取りこぼし) ので、黙って通さない
		assert.ok(keys.length > 0, `${where}: calls registerConfiguration but no setting keys were found`);
		for (const key of keys) {
			if (key.startsWith('paradis.')) {
				settings.add(key);
			}
		}
	}
	return settings;
}

/** 組み込み拡張機能の package.json に fork が足した設定 (`git.paraParkedRepositoryLimit` のような `.para` 接頭辞)。 */
function registeredExtensionForkSettings(root: string): Set<string> {
	const settings = new Set<string>();
	const extensionsRoot = join(root, 'extensions');
	for (const name of readdirSync(extensionsRoot)) {
		let manifest: { contributes?: { configuration?: unknown } };
		try {
			manifest = JSON.parse(readFileSync(join(extensionsRoot, name, 'package.json'), 'utf8'));
		} catch {
			continue;
		}
		const configuration = manifest.contributes?.configuration;
		const nodes = (Array.isArray(configuration) ? configuration : [configuration]) as ({ properties?: Record<string, unknown> } | undefined)[];
		for (const node of nodes) {
			for (const key of Object.keys(node?.properties ?? {})) {
				if (/\.para[A-Z]/.test(key)) {
					settings.add(key);
				}
			}
		}
	}
	return settings;
}

/** ダイアログの行に書いた `key:`。 */
function dialogSettings(root: string): Set<string> {
	const dialogPath = join(root, 'src', 'vs', 'paradis', 'contrib', 'paradisSettings', 'electron-browser', 'paradisSettingsDialog.ts');
	const source = readFileSync(dialogPath, 'utf8');
	const index = indexSources(listSourceFiles(join(root, 'src', 'vs', 'paradis')).map(path => ({ path, source: readFileSync(path, 'utf8') })));
	const settings = new Set<string>();
	for (const match of source.matchAll(/^\s*key:\s*(?:'(?<literal>[^'\n]+)'|(?<constant>[A-Za-z_]\w*))\s*,/gm)) {
		if (match.groups!.literal) {
			settings.add(match.groups!.literal);
		} else {
			const value = index.constants.get(match.groups!.constant!);
			assert.ok(value !== undefined, `paradisSettingsDialog.ts: could not resolve the setting key constant ${match.groups!.constant}`);
			settings.add(value);
		}
	}
	return settings;
}

suite('ParadisSettingsDialog coverage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every fork setting is in the dialog or explicitly left out', () => {
		const root = repositoryRoot();
		const registered = new Set([...registeredParadisSettings(root), ...registeredExtensionForkSettings(root)]);
		const inDialog = dialogSettings(root);

		const missing = [...registered].filter(key => !inDialog.has(key) && !NOT_IN_DIALOG.has(key)).sort();
		const staleExclusions = [...NOT_IN_DIALOG.keys()].filter(key => !registered.has(key) || inDialog.has(key)).sort();

		assert.deepStrictEqual({ missing, staleExclusions }, { missing: [], staleExclusions: [] },
			'Add each missing setting to ROWS in paradisSettingsDialog.ts, or to NOT_IN_DIALOG in this test with the reason it stays out. ' +
			'Remove NOT_IN_DIALOG entries that are no longer registered or are now in the dialog.');
	});
});
