/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能の権限の名前を、確認のダイアログで利用者に見せる言い方へ変える。
// 名前の一覧は Chrome の公式の権限の一覧（developer.chrome.com/docs/extensions/reference/permissions-list）に合わせる。
// 一覧に無いものは、API の参照のページ（webRequestAuthProvider は chrome.webRequest、wallpaper・systemLog はそれぞれの API）と、
// Chromium の _permission_features.json で許可リスト無しに使えるもの（downloads.shelf・input・enterprise.login・enterprise.kioskInput）から足す
import { localize } from '../../../../nls.js';

/**
 * 権限の名前の、利用者に見せる言い方。知らない名前はそのまま返す。
 */
export function paradisBrowserExtensionPermissionLabel(permission: string): string {
	switch (permission) {
		case 'cookies': return localize('paradis.browserExtensions.permission.cookies', "サイトの cookie の読み取りと変更");
		case 'downloads': return localize('paradis.browserExtensions.permission.downloads', "ファイルのダウンロード");
		case 'downloads.open': return localize('paradis.browserExtensions.permission.downloadsOpen', "ダウンロードしたファイルを開く");
		case 'downloads.shelf': return localize('paradis.browserExtensions.permission.downloadsShelf', "ダウンロードの表示の切り替え");
		case 'downloads.ui': return localize('paradis.browserExtensions.permission.downloadsUi', "ダウンロードの表示の変更");
		case 'notifications': return localize('paradis.browserExtensions.permission.notifications', "通知の表示");
		case 'management': return localize('paradis.browserExtensions.permission.management', "ほかの拡張機能の有効・無効の切り替え");
		case 'tabs': return localize('paradis.browserExtensions.permission.tabs', "タブの URL とタイトルの読み取り");
		case 'tabGroups': return localize('paradis.browserExtensions.permission.tabGroups', "タブのグループの読み取りと変更");
		case 'contextMenus': return localize('paradis.browserExtensions.permission.contextMenus', "右クリックのメニューへの項目の追加");
		case 'clipboardRead': return localize('paradis.browserExtensions.permission.clipboardRead', "クリップボードの読み取り");
		case 'clipboardWrite': return localize('paradis.browserExtensions.permission.clipboardWrite', "クリップボードへの書き込み");
		case 'webNavigation': return localize('paradis.browserExtensions.permission.webNavigation', "ページの移動の読み取り");
		case 'storage': return localize('paradis.browserExtensions.permission.storage', "拡張機能のデータの保存");
		case 'unlimitedStorage': return localize('paradis.browserExtensions.permission.unlimitedStorage', "上限の無いデータの保存");
		case 'activeTab': return localize('paradis.browserExtensions.permission.activeTab', "拡張機能を押したタブの読み取りと変更");
		case 'alarms': return localize('paradis.browserExtensions.permission.alarms', "決まった時刻の処理");
		case 'nativeMessaging': return localize('paradis.browserExtensions.permission.nativeMessaging', "パソコンに入っているアプリとのやりとり");
		case 'history': return localize('paradis.browserExtensions.permission.history', "閲覧の履歴の読み取りと変更");
		case 'bookmarks': return localize('paradis.browserExtensions.permission.bookmarks', "ブックマークの読み取りと変更");
		case 'readingList': return localize('paradis.browserExtensions.permission.readingList', "リーディング リストの読み取りと変更");
		case 'topSites': return localize('paradis.browserExtensions.permission.topSites', "よく見るサイトの一覧の読み取り");
		case 'sessions': return localize('paradis.browserExtensions.permission.sessions', "最近閉じたタブとほかの端末のタブの読み取り");
		case 'browsingData': return localize('paradis.browserExtensions.permission.browsingData', "閲覧のデータの削除");
		case 'privacy': return localize('paradis.browserExtensions.permission.privacy', "プライバシーの設定の変更");
		case 'proxy': return localize('paradis.browserExtensions.permission.proxy', "プロキシの設定の変更");
		case 'contentSettings': return localize('paradis.browserExtensions.permission.contentSettings', "サイトごとの設定（cookie・JavaScript・カメラなど）の変更");
		case 'fontSettings': return localize('paradis.browserExtensions.permission.fontSettings', "フォントの設定の読み取りと変更");
		case 'webRequest': return localize('paradis.browserExtensions.permission.webRequest', "ページの通信の読み取り");
		case 'webRequestBlocking': return localize('paradis.browserExtensions.permission.webRequestBlocking', "ページの通信の遮断・書き換え");
		case 'webRequestAuthProvider': return localize('paradis.browserExtensions.permission.webRequestAuthProvider', "サイトのログインの求めへの応答");
		case 'declarativeNetRequest': return localize('paradis.browserExtensions.permission.declarativeNetRequest', "ページの通信の遮断・書き換え");
		case 'declarativeNetRequestWithHostAccess': return localize('paradis.browserExtensions.permission.declarativeNetRequestWithHostAccess', "許したサイトの通信の遮断・書き換え");
		case 'declarativeNetRequestFeedback': return localize('paradis.browserExtensions.permission.declarativeNetRequestFeedback', "遮断・書き換えたページの通信の読み取り");
		case 'declarativeContent': return localize('paradis.browserExtensions.permission.declarativeContent', "ページの中身に応じたボタンの表示");
		case 'scripting': return localize('paradis.browserExtensions.permission.scripting', "ページへのスクリプトの挿入");
		case 'userScripts': return localize('paradis.browserExtensions.permission.userScripts', "ユーザー スクリプトのページへの挿入");
		case 'debugger': return localize('paradis.browserExtensions.permission.debugger', "ページのデバッガーへの接続");
		case 'pageCapture': return localize('paradis.browserExtensions.permission.pageCapture', "ページの MHTML での保存");
		case 'tabCapture': return localize('paradis.browserExtensions.permission.tabCapture', "タブの画面と音の取り込み");
		case 'desktopCapture': return localize('paradis.browserExtensions.permission.desktopCapture', "画面・ウィンドウ・タブの取り込み");
		case 'favicon': return localize('paradis.browserExtensions.permission.favicon', "サイトのアイコンの読み取り");
		case 'idle': return localize('paradis.browserExtensions.permission.idle', "パソコンが使われていないかの検出");
		case 'power': return localize('paradis.browserExtensions.permission.power', "パソコンのスリープの抑止");
		case 'geolocation': return localize('paradis.browserExtensions.permission.geolocation', "現在地の読み取り");
		case 'identity': return localize('paradis.browserExtensions.permission.identity', "アカウントでのログイン");
		case 'identity.email': return localize('paradis.browserExtensions.permission.identityEmail', "メールアドレスの読み取り");
		case 'gcm': return localize('paradis.browserExtensions.permission.gcm', "サーバーからのメッセージの受け取り");
		case 'offscreen': return localize('paradis.browserExtensions.permission.offscreen', "見えないページでの処理");
		case 'sidePanel': return localize('paradis.browserExtensions.permission.sidePanel', "サイドパネルの表示");
		case 'background': return localize('paradis.browserExtensions.permission.background', "ブラウザを閉じた後も動き続ける");
		case 'search': return localize('paradis.browserExtensions.permission.search', "既定の検索エンジンでの検索");
		case 'tts': return localize('paradis.browserExtensions.permission.tts', "文章の読み上げ");
		case 'ttsEngine': return localize('paradis.browserExtensions.permission.ttsEngine', "読み上げの音声の提供");
		case 'dns': return localize('paradis.browserExtensions.permission.dns', "ホスト名の IP アドレスの読み取り");
		case 'processes': return localize('paradis.browserExtensions.permission.processes', "ブラウザのプロセスの読み取り");
		case 'runtime': return localize('paradis.browserExtensions.permission.runtime', "パソコンに入っているアプリへの接続");
		case 'publicSuffix': return localize('paradis.browserExtensions.permission.publicSuffix', "ドメインの区切りの一覧の読み取り");
		case 'audio': return localize('paradis.browserExtensions.permission.audio', "音の入出力の機器の読み取りと変更");
		case 'printing': return localize('paradis.browserExtensions.permission.printing', "プリンターへの印刷");
		case 'printingMetrics': return localize('paradis.browserExtensions.permission.printingMetrics', "印刷の履歴の読み取り");
		case 'printerProvider': return localize('paradis.browserExtensions.permission.printerProvider', "プリンターの提供");
		case 'documentScan': return localize('paradis.browserExtensions.permission.documentScan', "スキャナーからの読み込み");
		case 'fileBrowserHandler': return localize('paradis.browserExtensions.permission.fileBrowserHandler', "ファイルの一覧からのファイルの受け取り");
		case 'fileSystemProvider': return localize('paradis.browserExtensions.permission.fileSystemProvider', "ファイルの置き場の提供");
		case 'certificateProvider': return localize('paradis.browserExtensions.permission.certificateProvider', "証明書の提供");
		case 'platformKeys': return localize('paradis.browserExtensions.permission.platformKeys', "端末の証明書と鍵の使用");
		case 'loginState': return localize('paradis.browserExtensions.permission.loginState', "ログインの状態の読み取り");
		case 'vpnProvider': return localize('paradis.browserExtensions.permission.vpnProvider', "VPN の提供");
		case 'webAuthenticationProxy': return localize('paradis.browserExtensions.permission.webAuthenticationProxy', "Web 認証（パスキーなど）の求めの代理");
		case 'accessibilityFeatures.read': return localize('paradis.browserExtensions.permission.accessibilityFeaturesRead', "ユーザー補助の設定の読み取り");
		case 'accessibilityFeatures.modify': return localize('paradis.browserExtensions.permission.accessibilityFeaturesModify', "ユーザー補助の設定の変更");
		case 'enterprise.deviceAttributes': return localize('paradis.browserExtensions.permission.enterpriseDeviceAttributes', "管理された端末の情報の読み取り");
		case 'enterprise.hardwarePlatform': return localize('paradis.browserExtensions.permission.enterpriseHardwarePlatform', "端末の製造元と機種の読み取り");
		case 'enterprise.networkingAttributes': return localize('paradis.browserExtensions.permission.enterpriseNetworkingAttributes', "端末のネットワークの情報の読み取り");
		case 'enterprise.platformKeys': return localize('paradis.browserExtensions.permission.enterprisePlatformKeys', "管理された端末の証明書と鍵の使用");
		case 'enterprise.login': return localize('paradis.browserExtensions.permission.enterpriseLogin', "管理された端末のログインの操作");
		case 'enterprise.kioskInput': return localize('paradis.browserExtensions.permission.enterpriseKioskInput', "キオスク端末の入力の設定の変更");
		case 'input': return localize('paradis.browserExtensions.permission.input', "文字の入力の方法（IME）の提供");
		case 'wallpaper': return localize('paradis.browserExtensions.permission.wallpaper', "デスクトップの壁紙の変更");
		case 'systemLog': return localize('paradis.browserExtensions.permission.systemLog', "端末のログへの書き込み");
		case 'system.cpu': return localize('paradis.browserExtensions.permission.systemCpu', "CPU の情報の読み取り");
		case 'system.display': return localize('paradis.browserExtensions.permission.systemDisplay', "画面の情報の読み取り");
		case 'system.memory': return localize('paradis.browserExtensions.permission.systemMemory', "メモリの情報の読み取り");
		case 'system.storage': return localize('paradis.browserExtensions.permission.systemStorage', "ストレージの機器の情報の読み取り");
		default: return permission;
	}
}
