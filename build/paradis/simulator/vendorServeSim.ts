/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// serve-sim（Apache-2.0）の npm の公開物から、シミュレータのホストが使う分だけを
// `src/vs/paradis/contrib/simulator/node/media/serve-sim/` へ取り込む。
//
//   node build/paradis/simulator/vendorServeSim.ts            # 取り込み直す（tgz を落として sha256 を確かめる）
//   node build/paradis/simulator/vendorServeSim.ts --check    # 置いてあるファイルが固定した版と同じかだけ確かめる（通信しない）
//   node build/paradis/simulator/vendorServeSim.ts --work-dir <dir>  # 展開に使うフォルダを指定する（終わっても消さない）
//
// 取り込むのは `dist/middleware.js`（ホストが読むミドルウェア）、Mach-O の 3 つ（q.html Q585 の D4:
// 映像と入力の serve-sim-native.node、Duo の開閉の serve-sim-duo-hid、表示の設定の serve-sim-ax-settings）、
// `package.json`（`"type": "module"` が ESM として読むのに要る）。カメラ（simcam/）と 3D の描画
// （serve-sim-duo-render）、CLI（serve-sim.js）は使わないので入れない。`native.ts` は `dist/native/` から
// `../simduo/serve-sim-duo-hid` を引くので、`dist/` の下の並びは公開物のまま保つ。
//
// LICENSE は npm の公開物に入っていないため、GitHub のリポジトリのものを置いてある（このスクリプトは触らない。
// 下の表で中身が変わっていないことだけ確かめる）。版を上げるときは、下の 3 つの値と表を更新し、
// 同じフォルダの README.md・ThirdPartyNotices.txt・NOTES.md の版の表記も直す。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SERVE_SIM_VERSION = '0.1.49';
export const SERVE_SIM_TARBALL_URL = `https://registry.npmjs.org/serve-sim/-/serve-sim-${SERVE_SIM_VERSION}.tgz`;
export const SERVE_SIM_TARBALL_SHA256 = 'b03b6bae423998ba08269c82d0cf3feac9b6ef4862b1b966a0889267e0239ef4';

/** 取り込む先（リポジトリの根からの相対）。 */
export const SERVE_SIM_VENDOR_DIR = 'src/vs/paradis/contrib/simulator/node/media/serve-sim';

interface IVendoredFile {
	/** tgz の `package/` からの相対。LICENSE は tgz に無いので undefined。 */
	readonly source: string | undefined;
	/** 取り込む先のフォルダからの相対。 */
	readonly target: string;
	readonly sha256: string;
	readonly executable: boolean;
}

export const SERVE_SIM_FILES: readonly IVendoredFile[] = [
	{ source: 'package.json', target: 'package.json', sha256: '6df3ce3c138e6c39eae46fc48488b707a1ed73f1c86bd0b43f4948af78ce7ad2', executable: false },
	{ source: 'dist/middleware.js', target: 'dist/middleware.js', sha256: '56ee0cb5a8d785f4f9c6d26937f2e4c5ac08e9d3f7c39a29814fe42827d756c9', executable: false },
	{ source: 'dist/native/serve-sim-native.node', target: 'dist/native/serve-sim-native.node', sha256: '8fc9402be4863e80926f388cd6eca8320871ca92e0bdb494cfa8ab9cc2004b2d', executable: true },
	{ source: 'dist/simduo/serve-sim-duo-hid', target: 'dist/simduo/serve-sim-duo-hid', sha256: '2b11c2c10b2de8f07c18dd7bd109b2c5c4aae35c1d957e0d356f2300f245d221', executable: true },
	{ source: 'dist/simax/serve-sim-ax-settings', target: 'dist/simax/serve-sim-ax-settings', sha256: 'fb198ede4a5793d9f9ecbce9552d2c1f42b5f292c0127f10c31650cd6be506f4', executable: true },
	// https://github.com/EvanBacon/serve-sim/blob/main/LICENSE（2026-11-08 に取得。NOTICE はリポジトリに無い）
	{ source: undefined, target: 'LICENSE', sha256: '9024cdf56dfe7e66523698a9f63d3a0061eb15f43bd5ea8e3833a56017ae37fd', executable: false },
];

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** 置いてあるファイルを表と突き合わせ、食い違いの一覧を返す（空なら一致）。 */
export function checkVendoredServeSim(vendorDir: string): string[] {
	const problems: string[] = [];
	for (const file of SERVE_SIM_FILES) {
		const path = join(vendorDir, file.target);
		if (!existsSync(path)) {
			problems.push(`missing: ${file.target}`);
			continue;
		}
		const actual = sha256(readFileSync(path));
		if (actual !== file.sha256) {
			problems.push(`sha256 mismatch: ${file.target} (expected ${file.sha256}, got ${actual})`);
		}
	}
	return problems;
}

async function vendor(vendorDir: string, workDir: string | undefined): Promise<void> {
	const response = await fetch(SERVE_SIM_TARBALL_URL);
	if (!response.ok) {
		throw new Error(`Could not download ${SERVE_SIM_TARBALL_URL}: HTTP ${response.status}`);
	}
	const tarball = new Uint8Array(await response.arrayBuffer());
	const actual = sha256(tarball);
	if (actual !== SERVE_SIM_TARBALL_SHA256) {
		throw new Error(`serve-sim ${SERVE_SIM_VERSION} tarball sha256 mismatch (expected ${SERVE_SIM_TARBALL_SHA256}, got ${actual})`);
	}
	const work = workDir ? resolve(workDir) : mkdtempSync(join(tmpdir(), 'paradis-serve-sim-'));
	try {
		mkdirSync(work, { recursive: true });
		const tarballPath = join(work, `serve-sim-${SERVE_SIM_VERSION}.tgz`);
		writeFileSync(tarballPath, tarball);
		execFileSync('tar', ['-xzf', tarballPath, '-C', work]);
		for (const file of SERVE_SIM_FILES) {
			if (!file.source) {
				continue;
			}
			const from = join(work, 'package', file.source);
			const to = join(vendorDir, file.target);
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			chmodSync(to, file.executable ? 0o755 : 0o644);
		}
	} finally {
		if (!workDir) {
			rmSync(work, { recursive: true, force: true });
		}
	}
	const problems = checkVendoredServeSim(vendorDir);
	if (problems.length) {
		throw new Error(`Vendored serve-sim does not match the pinned files:\n${problems.join('\n')}`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const vendorDir = resolve(import.meta.dirname, '..', '..', '..', SERVE_SIM_VENDOR_DIR);
	if (args.includes('--check')) {
		const problems = checkVendoredServeSim(vendorDir);
		if (problems.length) {
			console.error(problems.join('\n'));
			process.exit(1);
		}
		console.log(`serve-sim ${SERVE_SIM_VERSION}: all ${SERVE_SIM_FILES.length} vendored files match`);
		return;
	}
	const workDirIndex = args.indexOf('--work-dir');
	const workDir = workDirIndex >= 0 ? args[workDirIndex + 1] : undefined;
	await vendor(vendorDir, workDir);
	console.log(`serve-sim ${SERVE_SIM_VERSION}: vendored into ${SERVE_SIM_VENDOR_DIR}`);
}

if (import.meta.main) {
	await main();
}
