/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// scrcpy-server（Apache-2.0, Copyright (C) 2018 Genymobile, (C) 2018-2026 Romain Vimont）を
// `src/vs/paradis/contrib/simulator/node/media/scrcpy/` へ取り込む（q.html Q585 の ⑥b・D3: v5.0.1 に固定）。
//
//   node build/paradis/simulator/vendorScrcpy.ts            # GitHub のリリースから落として sha256 を確かめる
//   node build/paradis/simulator/vendorScrcpy.ts --check    # 置いてあるファイルが固定した版と同じかだけ確かめる（通信しない）
//
// server は端末（Android）の上で `app_process` が読む jar で、Mach-O ではないので署名・公証は要らない。
// LICENSE はリポジトリのもの（v5.0.1 のタグ）を置いてある（このスクリプトは触らず、表で中身が変わっていないことだけ確かめる）。
// 版を上げるときは、下の値と、src/vs/paradis/contrib/simulator/common/paradisScrcpy.ts の PARADIS_SCRCPY_VERSION、
// 同じフォルダの README.md・ThirdPartyNotices.txt・NOTES.md の版の表記を直す（通信の形は版ごとに変わる。doc/develop.md）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCRCPY_VERSION = '5.0.1';
export const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
export const SCRCPY_VENDOR_DIR = 'src/vs/paradis/contrib/simulator/node/media/scrcpy';

const FILES: readonly { readonly name: string; readonly sha256: string }[] = [
	{ name: `scrcpy-server-v${SCRCPY_VERSION}.jar`, sha256: SCRCPY_SERVER_SHA256 },
	// https://github.com/Genymobile/scrcpy/blob/v5.0.1/LICENSE（2026-11-08 に取得）
	{ name: 'LICENSE', sha256: '01c12035bf35af37241298dc7ad538eb2a07e5c940437bc6876feeaa9d1951d0' },
];

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** 置いてあるファイルを表と突き合わせ、食い違いの一覧を返す（空なら一致）。 */
export function checkVendoredScrcpy(vendorDir: string): string[] {
	const problems: string[] = [];
	for (const file of FILES) {
		const path = join(vendorDir, file.name);
		if (!existsSync(path)) {
			problems.push(`missing: ${file.name}`);
			continue;
		}
		const actual = sha256(readFileSync(path));
		if (actual !== file.sha256) {
			problems.push(`sha256 mismatch: ${file.name} (expected ${file.sha256}, got ${actual})`);
		}
	}
	return problems;
}

async function main(): Promise<void> {
	const vendorDir = resolve(import.meta.dirname, '..', '..', '..', SCRCPY_VENDOR_DIR);
	if (!process.argv.includes('--check')) {
		const response = await fetch(SCRCPY_SERVER_URL);
		if (!response.ok) {
			throw new Error(`Could not download ${SCRCPY_SERVER_URL}: HTTP ${response.status}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (sha256(bytes) !== SCRCPY_SERVER_SHA256) {
			throw new Error(`scrcpy-server v${SCRCPY_VERSION} sha256 mismatch (got ${sha256(bytes)})`);
		}
		mkdirSync(vendorDir, { recursive: true });
		writeFileSync(join(vendorDir, FILES[0].name), bytes);
	}
	const problems = checkVendoredScrcpy(vendorDir);
	if (problems.length) {
		console.error(problems.join('\n'));
		process.exit(1);
	}
	console.log(`scrcpy-server v${SCRCPY_VERSION}: all ${FILES.length} vendored files match`);
}

if (import.meta.main) {
	await main();
}
