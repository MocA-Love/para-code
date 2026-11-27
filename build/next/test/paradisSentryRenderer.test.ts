/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer の Sentry が、開発ビルドと配布版の両方で窓を壊さないことの網。
//
// 開発ビルド (`./scripts/code.sh`) は `out/` を vscode-file:// の素のブラウザ ESM として読むので、
// renderer が読むファイルに `@sentry/...` の静的 import が 1 つでもあると、指定子を解決できずに
// workbench の import 全体が失敗し、窓が白いままになる。配布版はバンドル時に
// `inlineParadisSentryPlugin` が静的 import を埋め込むので動くが、動的 import の `@sentry/...` は
// 外部のまま残るので、配布版で同じ白紙（または Sentry の無言の停止）になる。
// なので「`@sentry` の静的 import は paradisSentryRendererClient.ts だけ、それを読むのは動的 import
// だけ」と「配布版のバンドルに `@sentry` の指定子が残らない」の両方を押さえる。

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { suite, test } from 'node:test';
import { getBundleOptions } from '../bundle.ts';
import { inlineParadisSentryPlugin } from '../paradisSentryPlugin.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const srcVs = path.join(repoRoot, 'src', 'vs');
const sentryDir = 'vs/paradis/contrib/sentry/electron-browser';
const clientFile = `${sentryDir}/paradisSentryRendererClient.ts`;

/** Directories whose code never runs in a renderer, so a static `@sentry` import there is fine. */
const NON_RENDERER_DIRS = new Set(['test', 'node', 'electron-main', 'electron-utility', 'electron-node']);

function rendererSources(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!NON_RENDERER_DIRS.has(entry.name)) {
				rendererSources(path.join(dir, entry.name), out);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			out.push(path.join(dir, entry.name));
		}
	}
	return out;
}

/** Static, value-level imports (`import type` is erased and harmless). */
const STATIC_IMPORT = /^\s*import\s+(?!type\s)(?:[^;'"]*?\sfrom\s+)?['"](?<specifier>[^'"]+)['"]/gm;

suite('Renderer Sentry loads in builds run out of sources and in the packaged bundle', () => {

	test('only the on-demand client statically imports @sentry, and nothing statically imports the client', () => {
		const offenders: string[] = [];
		for (const file of rendererSources(srcVs)) {
			const relative = `vs/${path.relative(srcVs, file).split(path.sep).join('/')}`;
			const source = fs.readFileSync(file, 'utf-8');
			for (const match of source.matchAll(STATIC_IMPORT)) {
				const specifier = match.groups!.specifier;
				if (/^@sentry(-internal)?\//.test(specifier) && relative !== clientFile) {
					offenders.push(`${relative} -> ${specifier}`);
				}
				if (/paradisSentryRendererClient(\.js)?$/.test(specifier)) {
					offenders.push(`${relative} -> ${specifier}`);
				}
			}
		}
		assert.deepStrictEqual(offenders, []);
	});

	test('the packaged bundle inlines the client and leaves no @sentry specifier', async () => {
		const result = await esbuild.build({
			...getBundleOptions(false, 'neutral'),
			absWorkingDir: repoRoot,
			entryPoints: [path.join(repoRoot, 'src', `${sentryDir}/paradisSentryRenderer.ts`)],
			outfile: path.join(repoRoot, 'out-test', 'paradisSentryRenderer.js'),
			plugins: [inlineParadisSentryPlugin()],
			logLevel: 'silent',
		});
		const code = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
		assert.deepStrictEqual({
			sentrySpecifiers: code.match(/(?:from|import\()\s*["']@sentry[^"']*["']/g) ?? [],
			clientLeftExternal: /import\(\s*["'][^"']*paradisSentryRendererClient/.test(code),
			clientInlined: code.includes('"process.type": "renderer"'),
		}, {
			sentrySpecifiers: [],
			clientLeftExternal: false,
			clientInlined: true,
		});
	});
});
