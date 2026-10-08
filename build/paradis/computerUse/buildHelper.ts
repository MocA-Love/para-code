/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の補助アプリ（Para Code Computer Use.app）をビルドする。
//
//   node build/paradis/computerUse/buildHelper.ts [--out <dir>] [--arch universal|arm64|x86_64] [--if-stale]
//   node build/paradis/computerUse/buildHelper.ts --test
//   node build/paradis/computerUse/buildHelper.ts --out <dir> --allow-any-peer-for-testing
//
// swiftc で arm64 と x86_64 を別々にビルドして lipo で universal にし、.app に包んで ad-hoc 署名する。
// Swift Package（Package.swift）にしないのは、`// swift-tools-version` を1行目に置く決まりと、
// hygiene の「1行目から Microsoft の著作権ヘッダー」の決まりが両立しないため。
//
// リリースの署名は CI（.github/workflows/para-release.yml）が本番の identity でやり直す。
// ad-hoc の補助アプリはビルドのたびに TCC から別物と見なされるので、手元では許可を付け直す必要がある。
//
// `--allow-any-peer-for-testing` は接続相手の確認を外したビルドを作る（node から直接つないで試すため）。
// チーム ID のある署名では効かないようにしてあるが、同梱先（.build/paradis/computerUse）には出さないこと。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

export const PARADIS_COMPUTER_USE_APP_NAME = 'Para Code Computer Use.app';
export const PARADIS_COMPUTER_USE_EXECUTABLE = 'ParadisComputerUse';
export const PARADIS_COMPUTER_USE_SOURCE_ROOT = join(repositoryRoot, 'src', 'vs', 'paradis', 'contrib', 'computerUse', 'native', 'macos');
export const PARADIS_COMPUTER_USE_DEFAULT_OUT = join(repositoryRoot, '.build', 'paradis', 'computerUse');
export const PARADIS_COMPUTER_USE_ENTITLEMENTS = join(import.meta.dirname, 'paradis-computer-use-entitlements.plist');

const MINIMUM_MACOS = '14.0';
const ARCHITECTURES = ['arm64', 'x86_64'] as const;
type HelperArchitecture = typeof ARCHITECTURES[number];

export interface IParadisHelperBuildOptions {
	readonly outDir?: string;
	readonly architectures?: readonly HelperArchitecture[];
	/** 接続相手の確認を外す（node から直接つないで試すためのビルド）。同梱してはいけない。 */
	readonly allowAnyPeerForTesting?: boolean;
	/** 出来上がりがソースより新しければビルドしない。 */
	readonly ifStale?: boolean;
	readonly log?: (message: string) => void;
}

interface IProductInfo {
	readonly darwinBundleIdentifier: string;
	readonly dataFolderName: string;
	readonly version: string;
}

function readProductInfo(): IProductInfo {
	const product = JSON.parse(readFileSync(join(repositoryRoot, 'product.json'), 'utf8')) as { darwinBundleIdentifier?: string; dataFolderName?: string };
	const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version?: string };
	return {
		darwinBundleIdentifier: product.darwinBundleIdentifier ?? 'ltd.paradis.paracode',
		dataFolderName: product.dataFolderName ?? '.para-code',
		version: packageJson.version ?? '0.0.0',
	};
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 補助アプリの Info.plist。名前に ` Helper` を含めない（build/darwin/sign.ts の `' Helper.app'` の判定に当たると
 * Electron の helper 用の entitlements が付いてしまう）。
 */
export function paradisComputerUseInfoPlist(mainBundleIdentifier: string, version: string, testingBuild: boolean = false, dataFolderName: string = '.para-code'): string {
	const entries: [string, string][] = [
		['CFBundleDevelopmentRegion', 'ja'],
		['CFBundleExecutable', PARADIS_COMPUTER_USE_EXECUTABLE],
		['CFBundleIdentifier', `${mainBundleIdentifier}.computeruse`],
		['CFBundleInfoDictionaryVersion', '6.0'],
		['CFBundleName', 'Para Code Computer Use'],
		['CFBundleDisplayName', 'Para Code Computer Use'],
		['CFBundlePackageType', 'APPL'],
		['CFBundleShortVersionString', version],
		['CFBundleVersion', version],
		['LSMinimumSystemVersion', MINIMUM_MACOS],
		// allow-any-unicode-next-line
		['NSAccessibilityUsageDescription', 'Para Code のエージェントが、あなたの承認したアプリの画面の構造を読むために使います。'],
		// allow-any-unicode-next-line
		['NSScreenCaptureUsageDescription', 'Para Code のエージェントが、あなたの承認したアプリのウィンドウを撮るために使います。'],
		['ParadisMainBundleIdentifier', mainBundleIdentifier],
		// argv.json の場所（補助アプリが実行中に足されるスイッチを確かめる）
		['ParadisDataFolderName', dataFolderName],
	];
	const body = entries.map(([key, value]) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`).join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		body,
		'\t<key>LSUIElement</key>',
		'\t<true/>',
		...(testingBuild ? ['\t<key>ParadisTestingBuild</key>', '\t<true/>'] : []),
		'</dict>',
		'</plist>',
		'',
	].join('\n');
}

function swiftFiles(directory: string): string[] {
	return readdirSync(directory).filter(name => name.endsWith('.swift')).sort().map(name => join(directory, name));
}

function coreSources(): string[] {
	return swiftFiles(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'Sources', 'ParadisComputerUseCore'));
}

function appSources(): string[] {
	return [...coreSources(), ...swiftFiles(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'Sources', 'ParadisComputerUse'))];
}

function newestMtime(files: readonly string[]): number {
	return Math.max(...files.map(file => statSync(file).mtimeMs));
}

function swiftc(args: readonly string[]): void {
	execFileSync('xcrun', ['swiftc', ...args], { stdio: 'inherit' });
}

/** 補助アプリをビルドして .app の場所を返す。 */
export function buildParadisComputerUseHelper(options: IParadisHelperBuildOptions = {}): string {
	if (process.platform !== 'darwin') {
		throw new Error('The Computer Use helper can only be built on macOS.');
	}
	const log = options.log ?? (message => console.log(`[computer-use-helper] ${message}`));
	const outDir = resolve(options.outDir ?? PARADIS_COMPUTER_USE_DEFAULT_OUT);
	const appPath = join(outDir, PARADIS_COMPUTER_USE_APP_NAME);
	const executablePath = join(appPath, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE);
	const sources = appSources();
	if (options.ifStale && existsSync(executablePath)) {
		const newestInput = Math.max(newestMtime(sources), statSync(import.meta.filename).mtimeMs, statSync(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'THIRD_PARTY_NOTICES.md')).mtimeMs);
		if (statSync(executablePath).mtimeMs >= newestInput) {
			log(`up to date: ${appPath}`);
			return appPath;
		}
	}

	if (options.allowAnyPeerForTesting && outDir === PARADIS_COMPUTER_USE_DEFAULT_OUT) {
		// 同梱の元になる場所へ、確認を外したビルドを置かない
		throw new Error('--allow-any-peer-for-testing needs --out pointing somewhere other than the default location.');
	}
	const architectures = options.architectures ?? ARCHITECTURES;
	const product = readProductInfo();
	mkdirSync(outDir, { recursive: true });
	const staging = join(outDir, `.staging-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		const thin: string[] = [];
		for (const architecture of architectures) {
			const output = join(staging, `bin-${architecture}`);
			log(`compiling ${architecture}`);
			swiftc([
				'-O',
				'-swift-version', '5',
				'-target', `${architecture}-apple-macos${MINIMUM_MACOS}`,
				'-module-name', 'ParadisComputerUse',
				...(options.allowAnyPeerForTesting ? ['-D', 'PARADIS_ALLOW_ANY_PEER'] : []),
				...sources,
				'-o', output,
			]);
			thin.push(output);
		}
		const stagedApp = join(staging, PARADIS_COMPUTER_USE_APP_NAME);
		const macosDir = join(stagedApp, 'Contents', 'MacOS');
		mkdirSync(macosDir, { recursive: true });
		const stagedExecutable = join(macosDir, PARADIS_COMPUTER_USE_EXECUTABLE);
		if (thin.length === 1) {
			renameSync(thin[0], stagedExecutable);
		} else {
			execFileSync('lipo', ['-create', ...thin, '-output', stagedExecutable], { stdio: 'inherit' });
		}
		writeFileSync(join(stagedApp, 'Contents', 'Info.plist'), paradisComputerUseInfoPlist(product.darwinBundleIdentifier, product.version, options.allowAnyPeerForTesting === true, product.dataFolderName));
		writeFileSync(join(stagedApp, 'Contents', 'PkgInfo'), 'APPL????');
		mkdirSync(join(stagedApp, 'Contents', 'Resources'), { recursive: true });
		writeFileSync(join(stagedApp, 'Contents', 'Resources', 'THIRD_PARTY_NOTICES.md'), readFileSync(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'THIRD_PARTY_NOTICES.md')));
		// ad-hoc 署名。リリースは CI が本番の identity で署名し直す
		execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', stagedApp], { stdio: 'inherit' });
		rmSync(appPath, { recursive: true, force: true });
		renameSync(stagedApp, appPath);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	log(`built ${appPath}${options.allowAnyPeerForTesting ? ' (testing build: peer check disabled)' : ''}`);
	return appPath;
}

/** Core の Swift テストをビルドして回す。 */
export function runParadisComputerUseHelperTests(): void {
	const directory = join(tmpdir(), `paradis-computer-use-tests-${process.pid}`);
	mkdirSync(directory, { recursive: true });
	try {
		const binary = join(directory, 'tests');
		swiftc([
			'-swift-version', '5',
			'-module-name', 'ParadisComputerUseTests',
			...coreSources(),
			...swiftFiles(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'Tests', 'ParadisComputerUseCoreTests')),
			'-o', binary,
		]);
		execFileSync(binary, [], { stdio: 'inherit' });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function parseArchitectures(value: string | undefined): readonly HelperArchitecture[] | undefined {
	if (value === undefined || value === 'universal') {
		return undefined;
	}
	if (value === 'arm64' || value === 'x86_64') {
		return [value];
	}
	throw new Error(`Unknown --arch ${value} (use universal, arm64 or x86_64)`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const valueOf = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	if (args.includes('--test')) {
		runParadisComputerUseHelperTests();
	} else {
		const outDir = valueOf('--out');
		buildParadisComputerUseHelper({
			outDir: outDir ? resolve(outDir) : undefined,
			architectures: parseArchitectures(valueOf('--arch')),
			allowAnyPeerForTesting: args.includes('--allow-any-peer-for-testing'),
			ifStale: args.includes('--if-stale'),
		});
	}
}
