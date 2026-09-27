/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の補助アプリを Para Code.app の `Contents/Helpers/` へ入れる。
//
//   node build/paradis/computerUse/embedHelper.ts "<Para Code.app>" [--helper "<Para Code Computer Use.app>"]
//
// `Contents/Helpers/` は gulp の出力の外なので、upstream のファイルを増やさずに置ける。この後の
// build/darwin/sign.ts が `Contents/` を歩いて、入れ子の .app も hardened runtime とタイムスタンプ付きで署名し直す。
//
// 手元のパッケージ（`npm run gulp vscode-darwin-<arch>-min`）では、gulpfile.vscode.ts の PARA-PATCH から
// {@link paradisComputerUseHelperPackageTask} が呼ばれ、ビルドと埋め込みまで行う。失敗してもパッケージは止めない。
// CI では gulp からは何もせず、ワークフローの3段（Build / Pre-notarize / Embed）に任せる
// （公証を先に通せたものだけを入れるため）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildParadisComputerUseHelper, PARADIS_COMPUTER_USE_APP_NAME, PARADIS_COMPUTER_USE_DEFAULT_OUT, PARADIS_COMPUTER_USE_EXECUTABLE } from './buildHelper.ts';

/** 補助アプリを埋め込んで、入れた先の場所を返す。 */
export function paradisEmbedComputerUseHelper(appBundlePath: string, helperAppPath: string = join(PARADIS_COMPUTER_USE_DEFAULT_OUT, PARADIS_COMPUTER_USE_APP_NAME)): string {
	const app = resolve(appBundlePath);
	const helper = resolve(helperAppPath);
	if (!existsSync(join(app, 'Contents', 'Info.plist'))) {
		throw new Error(`Not an app bundle: ${app}`);
	}
	const executable = join(helper, 'Contents', 'MacOS', PARADIS_COMPUTER_USE_EXECUTABLE);
	if (!existsSync(executable) || !statSync(executable).isFile()) {
		throw new Error(`The Computer Use helper was not found at ${helper}`);
	}
	// 接続相手の確認を外したテスト用のビルドは入れない
	if (readFileSync(join(helper, 'Contents', 'Info.plist'), 'utf8').includes('<key>ParadisTestingBuild</key>')) {
		throw new Error(`Refusing to embed a testing build of the Computer Use helper: ${helper}`);
	}
	const helpersDir = join(app, 'Contents', 'Helpers');
	const destination = join(helpersDir, PARADIS_COMPUTER_USE_APP_NAME);
	const staging = join(helpersDir, `.${PARADIS_COMPUTER_USE_APP_NAME}.partial`);
	mkdirSync(helpersDir, { recursive: true });
	rmSync(staging, { recursive: true, force: true });
	try {
		// 途中で失敗しても半端なものを署名に回さないよう、別名に写してから差し替える
		execFileSync('ditto', [helper, staging], { stdio: 'inherit' });
		rmSync(destination, { recursive: true, force: true });
		renameSync(staging, destination);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

/**
 * gulp のパッケージの段から呼ぶ。macOS の手元のビルドでだけ、補助アプリを（古ければ）ビルドして埋め込む。
 * CI（`CI` がある）と `PARADIS_COMPUTER_USE_HELPER=0` では何もしない。失敗は警告にとどめ、パッケージは続ける。
 */
export function paradisComputerUseHelperPackageTask(platform: string, appBundlePath: string): () => Promise<void> {
	const embed = async () => {
		if (platform !== 'darwin' || process.platform !== 'darwin' || process.env['CI'] || process.env['PARADIS_COMPUTER_USE_HELPER'] === '0') {
			return;
		}
		try {
			const helper = buildParadisComputerUseHelper({ ifStale: true });
			const destination = paradisEmbedComputerUseHelper(appBundlePath, helper);
			console.log(`[computer-use-helper] embedded ${destination}`);
		} catch (error) {
			console.warn(`[computer-use-helper] skipped: the package ships without Computer Use (${error instanceof Error ? error.message : String(error)})`);
		}
	};
	return embed;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const appBundle = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--helper');
	const helperIndex = args.indexOf('--helper');
	if (!appBundle) {
		console.error('Usage: node build/paradis/computerUse/embedHelper.ts "<Para Code.app>" [--helper "<Para Code Computer Use.app>"]');
		process.exit(2);
	}
	const destination = paradisEmbedComputerUseHelper(appBundle, helperIndex >= 0 ? args[helperIndex + 1] : undefined);
	console.log(`[computer-use-helper] embedded ${destination}`);
}
