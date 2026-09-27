/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 補助アプリのビルドと埋め込みのテスト。 node --test build/paradis/computerUse/*.test.ts

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARADIS_COMPUTER_USE_APP_NAME, PARADIS_COMPUTER_USE_EXECUTABLE, PARADIS_COMPUTER_USE_SOURCE_ROOT, paradisComputerUseInfoPlist } from './buildHelper.ts';
import { paradisEmbedComputerUseHelper } from './embedHelper.ts';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const commonTs = readFileSync(join(repositoryRoot, 'src', 'vs', 'paradis', 'contrib', 'computerUse', 'common', 'paradisComputerUse.ts'), 'utf8');

test('the Swift helper and the TypeScript client agree on the protocol version, app name and executable', () => {
	const swift = readFileSync(join(PARADIS_COMPUTER_USE_SOURCE_ROOT, 'Sources', 'ParadisComputerUseCore', 'ParadisProtocol.swift'), 'utf8');
	const swiftVersion = /static let protocolVersion = (?<version>\d+)/.exec(swift)?.groups?.version;
	const tsVersion = /PARADIS_COMPUTER_USE_PROTOCOL_VERSION = (?<version>\d+);/.exec(commonTs)?.groups?.version;
	const tsAppName = /PARADIS_COMPUTER_USE_APP_NAME = '(?<name>[^']+)'/.exec(commonTs)?.groups?.name;
	const tsExecutable = /PARADIS_COMPUTER_USE_EXECUTABLE = '(?<name>[^']+)'/.exec(commonTs)?.groups?.name;
	assert.deepStrictEqual({ swiftVersion, tsAppName, tsExecutable }, { swiftVersion: tsVersion, tsAppName: PARADIS_COMPUTER_USE_APP_NAME, tsExecutable: PARADIS_COMPUTER_USE_EXECUTABLE });
});

test('the Info.plist makes a background app for macOS 14 that sign.ts does not mistake for an Electron helper', () => {
	const plist = paradisComputerUseInfoPlist('ltd.paradis.paracode', '1.2.3');
	assert.ok(plist.includes('<key>CFBundleIdentifier</key>\n\t<string>ltd.paradis.paracode.computeruse</string>'));
	assert.ok(plist.includes('<key>LSUIElement</key>\n\t<true/>'));
	assert.ok(plist.includes('<key>LSMinimumSystemVersion</key>\n\t<string>14.0</string>'));
	assert.ok(plist.includes('<key>NSAccessibilityUsageDescription</key>') && plist.includes('<key>NSScreenCaptureUsageDescription</key>'));
	assert.ok(!PARADIS_COMPUTER_USE_APP_NAME.includes(' Helper'));
	assert.ok(!plist.includes('ParadisTestingBuild'));
	assert.ok(paradisComputerUseInfoPlist('ltd.paradis.paracode', '1.2.3', true).includes('<key>ParadisTestingBuild</key>'));
	if (process.platform === 'darwin') {
		const directory = mkdtempSync(join(tmpdir(), 'pcu-plist-'));
		try {
			writeFileSync(join(directory, 'Info.plist'), plist);
			execFileSync('plutil', ['-lint', join(directory, 'Info.plist')], { stdio: 'pipe' });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test('embeds the helper into Contents/Helpers, replacing an old copy, and refuses a testing build', { skip: process.platform !== 'darwin' }, () => {
	const directory = mkdtempSync(join(tmpdir(), 'pcu-embed-'));
	try {
		const app = join(directory, 'Para Code.app');
		mkdirSync(join(app, 'Contents', 'Helpers', PARADIS_COMPUTER_USE_APP_NAME, 'Contents'), { recursive: true });
		writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
		writeFileSync(join(app, 'Contents', 'Helpers', PARADIS_COMPUTER_USE_APP_NAME, 'Contents', 'stale'), 'old');
		const makeHelper = (name: string, testing: boolean) => {
			const helper = join(directory, name, PARADIS_COMPUTER_USE_APP_NAME);
			mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true });
			writeFileSync(join(helper, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE), 'binary');
			writeFileSync(join(helper, 'Contents', 'Info.plist'), paradisComputerUseInfoPlist('ltd.paradis.paracode', '1.0.0', testing));
			return helper;
		};
		const destination = paradisEmbedComputerUseHelper(app, makeHelper('release', false));
		assert.strictEqual(destination, join(app, 'Contents', 'Helpers', PARADIS_COMPUTER_USE_APP_NAME));
		assert.deepStrictEqual(readdirSync(join(destination, 'Contents')).sort(), ['Info.plist', 'MacOS']);
		assert.deepStrictEqual(readdirSync(join(app, 'Contents', 'Helpers')), [PARADIS_COMPUTER_USE_APP_NAME]);
		assert.throws(() => paradisEmbedComputerUseHelper(app, makeHelper('testing', true)), /testing build/);
		assert.throws(() => paradisEmbedComputerUseHelper(app, join(directory, 'nowhere', PARADIS_COMPUTER_USE_APP_NAME)), /was not found/);
		// 断ったときも、入っていたものはそのまま
		assert.ok(existsSync(join(destination, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE)));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
