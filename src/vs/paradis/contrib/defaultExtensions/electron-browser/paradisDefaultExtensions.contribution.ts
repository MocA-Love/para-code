/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { EXTENSION_INSTALL_SKIP_PUBLISHER_TRUST_CONTEXT, IExtensionGalleryService, InstallExtensionInfo } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { paradisWithSettledProgress } from '../../../common/paradisSettledProgress.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { IExtensionManagementServerService, IWorkbenchExtensionManagementService } from '../../../../workbench/services/extensionManagement/common/extensionManagement.js';
import { IExtensionManifestPropertiesService } from '../../../../workbench/services/extensions/common/extensionManifestPropertiesService.js';
import { ILocaleService } from '../../../../workbench/services/localization/common/locale.js';
import { PARADIS_DEFAULT_EXTENSION_IDS, PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, paradisPendingDefaultExtensions, paradisReadDefaultExtensionsLedger, paradisStoreDefaultExtensionsLedger } from '../common/paradisDefaultExtensionIds.js';
import { paradisInstalledForThisWindow } from '../common/paradisDefaultExtensionsTarget.js';

const JA_LANGUAGE_ID = 'ja';

/**
 * 導入済みの台帳キー。インストール先はウィンドウの接続先に従う（workspace 種別の拡張は
 * SSH ウィンドウなら接続先サーバーへ入る）ので、台帳も接続先ごとに分ける。
 * 1つの台帳を共有すると、SSH ウィンドウで入れた分が「手元にも入っている」ことになり、
 * ローカルウィンドウでは二度と導入されなくなる（逆に、手元で入れ損ねた分が接続先へ
 * まとめて入ってしまうこともある）。
 * ローカルはキーを変えず、既存ユーザーの台帳をそのまま引き継ぐ。
 */
function storageKeyForRemote(baseKey: string, remoteAuthority: string | undefined): string {
	return remoteAuthority ? `${baseKey}.${remoteAuthority.toLowerCase()}` : baseKey;
}

/**
 * 初回起動時（アイドル時）にデフォルト拡張機能を Open VSX から自動インストールし、
 * 日本語言語パック導入後は再起動を促す通知を表示する contribution。
 * 成功したIDを storage(APPLICATION) に記録し、未完了分のみ次回起動時に再試行する。
 */
class ParadisDefaultExtensionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDefaultExtensions';
	private readonly installedIdsStorageKey: string;

	constructor(
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@ILocaleService private readonly localeService: ILocaleService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IProgressService private readonly progressService: IProgressService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionManifestPropertiesService private readonly extensionManifestPropertiesService: IExtensionManifestPropertiesService,
	) {
		super();
		this.installedIdsStorageKey = storageKeyForRemote(PARADIS_DEFAULT_EXTENSIONS_LEDGER_KEY, this.environmentService.remoteAuthority);
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
		};

		if (hasWork) {
			await paradisWithSettledProgress(this.progressService, {
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
		return paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, this.readDoneIds()).length > 0;
	}

	private readDoneIds(): Set<string> {
		return paradisReadDefaultExtensionsLedger(this.storageService, this.installedIdsStorageKey);
	}

	private storeDoneIds(ids: Set<string>): void {
		paradisStoreDefaultExtensionsLedger(this.storageService, this.installedIdsStorageKey, ids);
	}

	private async installDefaultExtensions(): Promise<void> {
		const doneIds = this.readDoneIds();
		let remaining = paradisPendingDefaultExtensions(PARADIS_DEFAULT_EXTENSION_IDS, doneIds);
		if (remaining.length === 0) {
			return;
		}

		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.warn('[ParadisDefaultExtensions] extension gallery is disabled, skipping');
			return;
		}

		// 既にインストール済み（手動導入含む）のものは完了扱いにする。SSH のウィンドウでは、接続先に入っているものと
		// 手元で動くものだけを数える（手元にしか無い接続先向けの拡張機能を入れ済みとしない）
		const remoteServer = this.extensionManagementServerService.remoteExtensionManagementServer;
		const installed = paradisInstalledForThisWindow(
			await this.extensionManagementService.getInstalled(),
			!!this.environmentService.remoteAuthority && !!remoteServer,
			local => this.extensionManagementServerService.getExtensionManagementServer(local) === remoteServer,
			local => this.extensionManifestPropertiesService.prefersExecuteOnUI(local.manifest),
		);
		for (const id of remaining) {
			if (installed.some(local => areSameExtensions(local.identifier, { id }))) {
				doneIds.add(id.toLowerCase());
			}
		}
		remaining = paradisPendingDefaultExtensions(remaining, doneIds);
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
				reportParadisDiagnosticError('owned', 'default-extensions', 'gallery-install-failed', result.error);
				this.logService.warn(`[ParadisDefaultExtensions] failed to install ${result.identifier.id}`, result.error);
			} else {
				doneIds.add(result.identifier.id.toLowerCase());
			}
		}
		this.storeDoneIds(doneIds);
		this.logService.info(`[ParadisDefaultExtensions] finished (${results.filter(r => !r.error).length}/${toInstall.length} succeeded)`);
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
