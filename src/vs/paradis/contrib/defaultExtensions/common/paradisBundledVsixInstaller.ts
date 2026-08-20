/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Open VSX 未公開のためリポジトリに .vsix を同梱してインストールする拡張のファイル名一覧。
 * ビルド時に build/gulpfile.vscode.ts の packageTask が resources/paradis/extensions/*.vsix を
 * 成果物へコピーする。開発時は appRoot（= リポジトリルート）直下の同パスから解決される。
 */
export const BUNDLED_VSIX_FILES: readonly string[] = [
	'mosapride.zenkaku-0.0.3.vsix',
	'AntiAntiSepticeye.vscode-color-picker-0.0.4.vsix',
	'netcorext.uuid-generator-0.0.5.vsix',
	'ms-vsliveshare.vsliveshare-1.1.122.vsix',
	'jeff-hykin.polacode-2019-0.6.2.vsix',
	'yudai1204.polacode-button-0.0.1.vsix',
	'VisualStudioExptTeam.vscodeintellicode-1.3.2.vsix',
	'VisualStudioExptTeam.intellicode-api-usage-examples-0.2.9.vsix',
	'evondev.indent-rainbow-palettes-0.0.20.vsix',
	// Para Codeパッチ版 (upstream v2.4.5ベース、composeプロジェクトで現在のワークスペース外の
	// コンテナ/イメージ/ボリューム/ネットワークをContainers系ビューから隠す)。installGivenVersion:true
	// でpinnedになるため、ギャラリーの新版に自動更新で置き換えられることはない (ユーザーが拡張ビューで
	// 手動更新した場合のみ失われる)。既にギャラリー版がインストール済みでもVSIXインストールが既存版を
	// 置き換える。ビルド手順はNOTES.md参照
	'ms-azuretools.vscode-containers-2.4.107.vsix'
];

const BUNDLED_VSIX_DIR = 'resources/paradis/extensions';

export const INSTALLED_VSIX_STORAGE_KEY = 'paradis.defaultExtensions.installedVsix';

export interface IParadisBundledVsixInstallerOptions {
	readonly files: readonly string[];
	readonly appRoot: string;
	readonly storageService: IStorageService;
	/**
	 * 導入済みファイルの台帳キー。省略時は {@link INSTALLED_VSIX_STORAGE_KEY}。
	 * インストール先はウィンドウの接続先に従うので、呼び出し側は接続先ごとに別のキーを渡す。
	 */
	readonly storageKey?: string;
	readonly exists: (location: URI) => Promise<boolean>;
	readonly install: (location: URI) => Promise<void>;
	readonly warn: (message: string, error?: unknown) => void;
	readonly info: (message: string) => void;
}

export class ParadisBundledVsixInstaller {

	private readonly storageKey: string;

	constructor(private readonly options: IParadisBundledVsixInstallerOptions) {
		this.storageKey = options.storageKey ?? INSTALLED_VSIX_STORAGE_KEY;
	}

	hasPendingInstalls(): boolean {
		const done = this.readDone();
		return this.uniqueFiles().some(file => !done.has(file));
	}

	async install(): Promise<void> {
		const done = this.readDone();
		const remaining = this.uniqueFiles().filter(file => !done.has(file));
		if (remaining.length === 0) {
			return;
		}

		for (const file of remaining) {
			const location = joinPath(URI.file(this.options.appRoot), ...BUNDLED_VSIX_DIR.split('/'), file);
			try {
				if (!(await this.options.exists(location))) {
					this.options.warn(`[ParadisDefaultExtensions] bundled vsix not found: ${file}`);
					continue;
				}
				await this.options.install(location);
				done.add(file);
				this.options.info(`[ParadisDefaultExtensions] installed bundled vsix: ${file}`);
			} catch (error) {
				this.options.warn(`[ParadisDefaultExtensions] failed to install bundled vsix ${file}`, error);
			}
		}

		this.options.storageService.store(this.storageKey, JSON.stringify([...done]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private uniqueFiles(): readonly string[] {
		return [...new Set(this.options.files)];
	}

	private readDone(): Set<string> {
		try {
			const raw = this.options.storageService.get(this.storageKey, StorageScope.APPLICATION, '[]');
			const parsed = JSON.parse(raw);
			return new Set<string>(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []);
		} catch {
			return new Set<string>();
		}
	}
}
