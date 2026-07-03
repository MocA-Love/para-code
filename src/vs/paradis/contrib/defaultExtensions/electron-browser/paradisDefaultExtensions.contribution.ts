/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EXTENSION_INSTALL_SKIP_PUBLISHER_TRUST_CONTEXT, IExtensionGalleryService, InstallExtensionInfo } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { IWorkbenchExtensionManagementService } from '../../../../workbench/services/extensionManagement/common/extensionManagement.js';
import { ILocaleService } from '../../../../workbench/services/localization/common/locale.js';

/**
 * Para Code が全ユーザーへデフォルト導入する拡張機能のID一覧（ギャラリー = Open VSX）。
 * ここに列挙するIDは Open VSX 上に実在することを確認済みのもののみとする。
 * （Open VSX 未公開のため見送り: VisualStudioExptTeam.vscodeintellicode / intellicode-api-usage-examples /
 * mosapride.zenkaku / AntiAntiSepticeye.vscode-color-picker / netcorext.uuid-generator /
 * ms-vsliveshare.vsliveshare / evondev.indent-rainbow-palettes / jeff-hykin.polacode-2019 /
 * yudai1204.polacode-button。cweijan.vscode-postgresql-client2 は同作者の上位版
 * cweijan.vscode-database-client2 で代替。）
 */
const DEFAULT_EXTENSION_IDS: readonly string[] = [
	// Git / GitHub
	'eamodio.gitlens',
	'mhutchie.git-graph',
	'GitHub.vscode-pull-request-github',
	'github.vscode-github-actions',
	'wdhongtw.gpg-indicator',
	// AI
	'Anthropic.claude-code',
	'openai.chatgpt',
	// 汎用生産性
	'mechatroner.rainbow-csv',
	'PKief.material-icon-theme',
	'shardulm94.trailing-spaces',
	'fill-labs.dependi',
	// 装飾
	'oderwat.indent-rainbow',
	// 趣味・ビューア
	'pixl-garden.BongoCat',
	'ngtystr.ppm-pgm-viewer-for-vscode',
	// データベース
	'alexcvzz.vscode-sqlite',
	'cweijan.vscode-database-client2',
	'cweijan.dbclient-jdbc',
	// コンテナ
	'docker.docker',
	'ms-azuretools.vscode-docker',
	// Web / フロントエンド
	'bradlc.vscode-tailwindcss',
	'denoland.vscode-deno',
	'astro-build.houston',
	'Vue.volar',
	'jock.svg',
	// 言語ツールチェイン
	'ms-python.python',
	'rust-lang.rust-analyzer',
	'golang.go',
	'Dart-Code.dart-code',
	'Dart-Code.flutter',
	'swiftlang.swift-vscode',
	// 日本語言語パック（導入後、下の再起動通知で表示言語へ反映する）
	'MS-CEINTL.vscode-language-pack-ja'
];

/**
 * Open VSX 未公開のためリポジトリに .vsix を同梱してインストールする拡張のファイル名一覧。
 * ビルド時に build/gulpfile.vscode.ts の packageTask が resources/paradis/extensions/*.vsix を
 * 成果物へコピーする。開発時は appRoot（= リポジトリルート）直下の同パスから解決される。
 */
const BUNDLED_VSIX_FILES: readonly string[] = [
	'mosapride.zenkaku-0.0.3.vsix',
	'AntiAntiSepticeye.vscode-color-picker-0.0.4.vsix',
	'netcorext.uuid-generator-0.0.5.vsix',
	'ms-vsliveshare.vsliveshare-1.1.122.vsix',
	'jeff-hykin.polacode-2019-0.6.2.vsix',
	'yudai1204.polacode-button-0.0.1.vsix',
	'VisualStudioExptTeam.vscodeintellicode-1.3.2.vsix',
	'VisualStudioExptTeam.intellicode-api-usage-examples-0.2.9.vsix',
	'evondev.indent-rainbow-palettes-0.0.20.vsix'
];

const BUNDLED_VSIX_DIR = 'resources/paradis/extensions';

const INSTALLED_IDS_STORAGE_KEY = 'paradis.defaultExtensions.installedIds';
const INSTALLED_VSIX_STORAGE_KEY = 'paradis.defaultExtensions.installedVsix';
const JA_LANGUAGE_ID = 'ja';

/**
 * 初回起動時（アイドル時）にデフォルト拡張機能を Open VSX から自動インストールし、
 * 日本語言語パック導入後は再起動を促す通知を表示する contribution。
 * 成功したIDを storage(APPLICATION) に記録し、未完了分のみ次回起動時に再試行する。
 */
class ParadisDefaultExtensionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDefaultExtensions';

	constructor(
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@ILocaleService private readonly localeService: ILocaleService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();

		this.run();
	}

	private async run(): Promise<void> {
		// インストール対象が残っている初回のみ、進行状況を通知トーストで見せる。
		// 何も入れるものが無ければ通知は一切出さない（2回目以降の起動では静か）。
		const hasWork = this.hasPendingInstalls();

		const install = async () => {
			try {
				await this.installDefaultExtensions();
			} catch (error) {
				this.logService.error('[ParadisDefaultExtensions] failed to install default extensions', error);
			}
			try {
				await this.installBundledVsixExtensions();
			} catch (error) {
				this.logService.error('[ParadisDefaultExtensions] failed to install bundled vsix extensions', error);
			}
		};

		if (hasWork) {
			await this.progressService.withProgress({
				location: ProgressLocation.Notification,
				// allow-any-unicode-next-line
				title: localize('paradis.defaultExtensions.installing', "Para Code の推奨拡張機能をインストールしています…"),
				cancellable: false
			}, install);
		} else {
			await install();
		}

		try {
			await this.promptRestartForJapaneseLocale();
		} catch (error) {
			this.logService.error('[ParadisDefaultExtensions] failed to prompt for locale change', error);
		}
	}

	private hasPendingInstalls(): boolean {
		const doneGallery = this.readDoneIds();
		if (DEFAULT_EXTENSION_IDS.some(id => !doneGallery.has(id.toLowerCase()))) {
			return true;
		}
		let doneVsix: Set<string>;
		try {
			doneVsix = new Set<string>(JSON.parse(this.storageService.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION, '[]')));
		} catch {
			doneVsix = new Set<string>();
		}
		return BUNDLED_VSIX_FILES.some(file => !doneVsix.has(file));
	}

	private readDoneIds(): Set<string> {
		try {
			const raw = this.storageService.get(INSTALLED_IDS_STORAGE_KEY, StorageScope.APPLICATION, '[]');
			return new Set<string>(JSON.parse(raw));
		} catch {
			return new Set<string>();
		}
	}

	private storeDoneIds(ids: Set<string>): void {
		this.storageService.store(INSTALLED_IDS_STORAGE_KEY, JSON.stringify([...ids]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async installDefaultExtensions(): Promise<void> {
		const doneIds = this.readDoneIds();
		let remaining = DEFAULT_EXTENSION_IDS.filter(id => !doneIds.has(id.toLowerCase()));
		if (remaining.length === 0) {
			return;
		}

		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.warn('[ParadisDefaultExtensions] extension gallery is disabled, skipping');
			return;
		}

		// 既にインストール済み（手動導入含む）のものは完了扱いにする
		const installed = await this.extensionManagementService.getInstalled();
		for (const id of remaining) {
			if (installed.some(local => areSameExtensions(local.identifier, { id }))) {
				doneIds.add(id.toLowerCase());
			}
		}
		remaining = remaining.filter(id => !doneIds.has(id.toLowerCase()));
		if (remaining.length === 0) {
			this.storeDoneIds(doneIds);
			return;
		}

		this.logService.info(`[ParadisDefaultExtensions] installing ${remaining.length} default extensions`);

		const targetPlatform = await this.extensionManagementService.getTargetPlatform();
		const galleryExtensions = await this.extensionGalleryService.getExtensions(
			remaining.map(id => ({ id })),
			{ targetPlatform, compatible: true },
			CancellationToken.None
		);

		// Para Code が選定した既定拡張なので、初回起動時にパブリッシャー信頼ダイアログは出さない。
		// このバッチはコンテキストでダイアログをスキップしつつ、パブリッシャー自体も信頼済みとして
		// 登録する（以後ユーザーが同パブリッシャーの拡張を手動インストールする際にも出さない）。
		const publishers = new Map<string, { publisher: string; publisherDisplayName: string }>();
		for (const gallery of galleryExtensions) {
			publishers.set(gallery.publisher.toLowerCase(), { publisher: gallery.publisher, publisherDisplayName: gallery.publisherDisplayName });
		}
		this.extensionManagementService.trustPublishers(...publishers.values());

		const toInstall: InstallExtensionInfo[] = [];
		for (const gallery of galleryExtensions) {
			toInstall.push({ extension: gallery, options: { isMachineScoped: false, context: { [EXTENSION_INSTALL_SKIP_PUBLISHER_TRUST_CONTEXT]: true } } });
		}
		for (const id of remaining) {
			if (!galleryExtensions.some(gallery => areSameExtensions(gallery.identifier, { id }))) {
				this.logService.warn(`[ParadisDefaultExtensions] extension not found in gallery: ${id}`);
			}
		}

		if (toInstall.length === 0) {
			this.storeDoneIds(doneIds);
			return;
		}

		const results = await this.extensionManagementService.installGalleryExtensions(toInstall);
		for (const result of results) {
			if (result.error) {
				this.logService.warn(`[ParadisDefaultExtensions] failed to install ${result.identifier.id}`, result.error);
			} else {
				doneIds.add(result.identifier.id.toLowerCase());
			}
		}
		this.storeDoneIds(doneIds);
		this.logService.info(`[ParadisDefaultExtensions] finished (${results.filter(r => !r.error).length}/${toInstall.length} succeeded)`);
	}

	private async installBundledVsixExtensions(): Promise<void> {
		const doneRaw = this.storageService.get(INSTALLED_VSIX_STORAGE_KEY, StorageScope.APPLICATION, '[]');
		let done: Set<string>;
		try {
			done = new Set<string>(JSON.parse(doneRaw));
		} catch {
			done = new Set<string>();
		}

		const remaining = BUNDLED_VSIX_FILES.filter(file => !done.has(file));
		if (remaining.length === 0) {
			return;
		}

		for (const file of remaining) {
			const location = joinPath(URI.file(this.environmentService.appRoot), ...BUNDLED_VSIX_DIR.split('/'), file);
			try {
				if (!(await this.fileService.exists(location))) {
					this.logService.warn(`[ParadisDefaultExtensions] bundled vsix not found: ${location.fsPath}`);
					continue;
				}
				await this.extensionManagementService.install(location, { installGivenVersion: true });
				done.add(file);
				this.logService.info(`[ParadisDefaultExtensions] installed bundled vsix: ${file}`);
			} catch (error) {
				this.logService.warn(`[ParadisDefaultExtensions] failed to install bundled vsix ${file}`, error);
			}
		}

		this.storageService.store(INSTALLED_VSIX_STORAGE_KEY, JSON.stringify([...done]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async promptRestartForJapaneseLocale(): Promise<void> {
		if (language === JA_LANGUAGE_ID || language.startsWith(`${JA_LANGUAGE_ID}-`)) {
			return; // 既に日本語表示
		}

		const installedLanguages = await this.languagePackService.getInstalledLanguages();
		const jaLanguagePack = installedLanguages.find(item => item.id === JA_LANGUAGE_ID);
		if (!jaLanguagePack) {
			return; // 言語パック未導入（インストール失敗時は次回起動時に再試行される）
		}

		this.notificationService.prompt(
			Severity.Info,
			// allow-any-unicode-next-line
			localize('paradis.defaultExtensions.restartForJapanese', "日本語言語パックをインストールしました。表示言語を日本語に切り替えるには再起動が必要です。"),
			[{
				// allow-any-unicode-next-line
				label: localize('paradis.defaultExtensions.restartNow', "今すぐ再起動"),
				run: () => this.localeService.setLocale(jaLanguagePack, true)
			}, {
				// allow-any-unicode-next-line
				label: localize('paradis.defaultExtensions.later', "後で"),
				run: () => { }
			}]
		);
	}
}

registerWorkbenchContribution2(ParadisDefaultExtensionsContribution.ID, ParadisDefaultExtensionsContribution, WorkbenchPhase.Eventually);
