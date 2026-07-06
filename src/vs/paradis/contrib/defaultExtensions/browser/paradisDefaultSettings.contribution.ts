/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// Para Code が全ユーザーへ配布するデフォルト設定。
// 拡張機能の `contributes.configurationDefaults` と同じ仕組み（設定の "default" レイヤーへの注入）なので、
// ユーザーが settings.json で明示的に上書きしていない項目にのみ効き、各自の上書きを一切妨げない。
// 対象拡張が未インストールの時点で登録されても問題なく、拡張側の設定スキーマ登録時に defaults として合流する。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.iconTheme': 'material-icon-theme',
		'workbench.colorTheme': 'Houston',
		// ステータスバーの Bongo Cat（pixl-garden.BongoCat）を表示するための必須設定。
		// 拡張は `$(bg-leftup)` 等のアイコンで猫を描画するが、拡張本体の contributes.icons が参照する
		// フォント（./theme/icomoon.woff）は vsix に同梱されておらず、猫が正しく描画されるのは拡張が
		// 提供する productIconTheme「bongocat」が有効なときだけ。ここで default レイヤーへ既定値として
		// 注入するため、ユーザーが settings.json で別の productIconTheme を選んでいる場合はそちらが優先され、
		// 上書きは一切しない。BongoCat 拡張自体はこの contribution とは別に初回起動時にインストールされる
		// （paradisDefaultExtensions.contribution.ts）が、colorTheme「Houston」と同様、拡張のスキーマ登録後に
		// テーマサービスが settings 値へ合流させるため、後追いインストールでも問題なく反映される。
		'workbench.productIconTheme': 'bongocat',
		// ブランドのプライマリカラー統一（#09AFD9）。既定テーマ Houston は独自のミント緑/水色アクセントを持つため、
		// 主要なアクセント色と、ステータスバーの通常/フォルダ未オープン背景をブランド色へ寄せる。
		// Dark 2026 / Light 2026（Para Code のもう一つの既定系テーマ）はアクセント自体はテーマ側で調整済みなので
		// ステータスバー背景のみ上書きする。テーマ別スコープ（[Houston] 等）なので他のテーマには一切影響せず、
		// ユーザーが settings.json に書いた colorCustomizations はキー単位でこの既定にマージされ常に優先される。
		'workbench.colorCustomizations': {
			'[Houston]': {
				'focusBorder': '#09AFD9B3',
				'button.background': '#0790B2',
				'button.hoverBackground': '#2B7DA3',
				'button.foreground': '#FFFFFF',
				'badge.background': '#09AFD9F0',
				'activityBarBadge.background': '#09AFD9',
				'progressBar.background': '#09AFD9',
				'textLink.foreground': '#18BBE4',
				'textLink.activeForeground': '#23C0E7',
				'inputOption.activeBackground': '#09AFD933',
				'inputOption.activeBorder': '#09AFD9',
				'tab.activeBorderTop': '#09AFD9',
				'panelTitle.activeBorder': '#09AFD9',
				'statusBar.background': '#09AFD9',
				'statusBar.foreground': '#FFFFFF',
				'statusBar.noFolderBackground': '#09AFD9',
				'statusBar.noFolderForeground': '#FFFFFF',
				'statusBar.focusBorder': '#FFFFFFB3',
				'agentsBadge.background': '#09AFD9',
				'agentsUnreadBadge.background': '#09AFD9'
			},
			'[Dark 2026]': {
				'statusBar.background': '#09AFD9',
				'statusBar.foreground': '#FFFFFF',
				'statusBar.noFolderBackground': '#09AFD9',
				'statusBar.noFolderForeground': '#FFFFFF'
			},
			'[Light 2026]': {
				// Light 2026 のブランドアクセントは白背景とのコントラスト確保のため #0598BD（テーマ内の debugging 色と同値）
				'statusBar.background': '#0598BD',
				'statusBar.foreground': '#FFFFFF',
				'statusBar.noFolderBackground': '#0598BD',
				'statusBar.noFolderForeground': '#FFFFFF'
			}
		},
		// 注: `github.copilot.chat.commitMessageGeneration.instructions` はここ（defaultレイヤー）では
		// 効かない。Copilot拡張の customInstructionsService.fetchInstructionsFromSetting は inspect の
		// workspaceFolder/workspace/global 値だけを読み、default 値を意図的に無視するため。
		// 代わりに paradisSeedUserSettings.contribution.ts が user settings.json へ一度だけシードする。
		// 初回インストール直後に拡張のWelcome/Get Startedタブが大量に開くのを抑止する。
		// walkthroughs.openOnInstall: インストール直後のWalkthrough自動オープン（Welcomeタブ）の抑止。
		// 各拡張固有の What's New / Welcome ページは、設定が用意されているものはここで無効化し、
		// 設定が無いもの（Dependi / Deno）は paradisSuppressExtensionWelcomeTabs.contribution.ts で閉じる。
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'gitlens.showWhatsNewAfterUpgrades': false,
		'go.showWelcome': false,
		'dependi.extras.silenceUpdateMessages': true,
		'sqlite.recordsPerPage': 500,
		'githubPullRequests.createOnPublishBranch': 'never',
		'indentRainbow.colors': [
			'rgba(3, 4, 94,0.15)',
			'rgba(2, 62, 138,0.15)',
			'rgba(0, 119, 182, 0.15)',
			'rgba(0, 150, 199,0.15)',
			'rgba(0, 180, 216,0.15)',
			'rgba(72, 202, 228,0.15)',
			'rgba(144, 224, 239,0.15)',
			'rgba(144, 224, 239,0.1)',
			'rgba(144, 224, 239,0.05)',
			'rgba(144, 224, 239,0.025)'
		],
		'gpgIndicator.enablePassphraseCache': true,
		'gpgIndicator.statusStyle': 'fingerprint'
	}
}]);
