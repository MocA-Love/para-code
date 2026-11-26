/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常に操作させないアプリ（設計書 6.2、Q64・Q97）。shared process の判定（common/paradisComputerUse.ts）と二重にする
// （レビュー M1）。補助アプリにつながれる経路がもし残っていても、最悪の的は守るため。
//
// 一覧は TS 側と同じにする。build/paradis/computerUse/buildHelper.test.ts が突き合わせる。
// 末尾が `*` のものは、その手前で始まる bundle id 全部に当たる。前後が `*` のものは、その間を含む bundle id 全部に当たる。

import Foundation

/** パスワードマネージャーとワンタイムコードのアプリ（Orca の一覧との和、レビュー M8）。 */
let paradisBlockedPasswordManagers: [String] = [
	"com.1password.1password",
	"com.1password.safari",
	"com.1password.1password-launcher",
	"com.agilebits.onepassword7",
	"com.agilebits.onepassword-osx",
	"com.agilebits.onepassword4",
	"com.bitwarden.desktop",
	"com.8bit.bitwarden",
	"com.dashlane.dashlanephonefinal",
	"com.dashlane.Dashlane",
	"com.lastpass.LastPass",
	"com.lastpass.lastpassmacdesktop",
	"com.nordsec.nordpass",
	"me.proton.pass.electron",
	"me.proton.pass.catalyst",
	"com.apple.Passwords",
	"org.keepassxc.keepassxc",
	"in.sinew.Enpass-Desktop",
	"com.keepersecurity.passwordmanager",
	"com.markmcguill.strongbox.mac",
	"com.hicknhacksoftware.MacPass",
	"com.siber.roboform",
]

/**
 * 2 段階認証（ワンタイムコード）のアプリ。パスワードマネージャーと同じ扱い（ベータの実機で Proton Authenticator が
 * 通っていた）。`*x*` は bundle id に x を含むもの全部。【要確認】各 id の実在。
 */
let paradisBlockedAuthenticators: [String] = [
	"me.proton.authenticator",
	"com.authy.authy-mac",
	"com.google.Authenticator",
	"com.microsoft.azureauthenticator",
	"com.bitwarden.authenticator",
	"io.ente.auth",
	"*authenticator*",
	"*2fas*",
	"*raivo*",
	"*otpauth*",
	"*steptwo*",
	"*twofas*",
	"com.duosecurity.DuoMobile",
	"*duomobile*",
	"com.authy",
	"com.okta.mobile",
	"com.yubico.yubioath",
	"*yubioath*",
]

/** キーチェーンアクセス。 */
let paradisBlockedKeychainApps: [String] = [
	"com.apple.keychainaccess",
]

/** Para Code 自身（main と、その下の helper と Computer Use の補助アプリ）。 */
let paradisBlockedParaCodeApps: [String] = [
	"ltd.paradis.paracode",
	"ltd.paradis.paracode.*",
]

/** システム設定と認証・同意のダイアログ（Q97）。 */
let paradisBlockedSystemSurfaces: [String] = [
	"com.apple.systempreferences*",
	"com.apple.settings.*",
	"com.apple.SecurityAgent",
	"com.apple.LocalAuthentication.UIAgent",
	"com.apple.loginwindow",
	"com.apple.coreservices.uiagent",
	"com.apple.UserNotificationCenter",
	"com.apple.universalaccessAuthWarn",
]

// MARK: - 読むだけにするアプリ
//
// 画面を読むのは許すが、入力は送らないアプリ。常に断るアプリ（上）と違い、利用者が設定
// `paradis.computerUse.allowOperatingReadOnlyApps` をオンにすれば操作も許せる（shared process が要求ごとに
// `allowOperatingReadOnlyApps` を渡す。渡されなければ読むだけ）。一覧は TS 側と同じにする（突き合わせテストが見る）。
// 一覧は公開されている bundle id の知識から作った。【要確認】は実機で実在を確かめていないもの。

/**
 * リモートデスクトップ・画面共有。遠隔先の画面の中では、常に断るアプリの一覧もアプリごとの承認も効かない。
 * 【要確認】com.apple.ScreenSharing・com.apple.RemoteDesktop・com.microsoft.rdc.macos・com.teamviewer.TeamViewer 以外の各 id の実在。
 */
let paradisReadOnlyRemoteDesktopApps: [String] = [
	"com.apple.ScreenSharing",
	"com.apple.RemoteDesktop",
	"com.microsoft.rdc.macos",
	"com.teamviewer.TeamViewer",
	"com.philandro.anydesk",
	"com.realvnc.vncviewer",
	"tv.parsec.www",
	"com.p5sys.jump.mac.viewer",
	"com.edovia.screens*",
	"com.citrix.receiver.*",
	"com.vmware.horizon",
	"com.omnissa.horizon.client.mac",
	"com.carriez.rustdesk",
	"com.nomachine.nxplayer",
	"com.splashtop.*",
	"*chromeremotedesktop*",
]

/**
 * ブラウザ。ログイン中のサイトを利用者として操作できる。Para Code には内蔵ブラウザの道具があるので、そちらを使わせる。
 * 末尾が `*` のものは、派生の版（Beta・Dev・Canary）とブラウザが作るウェブアプリも含む。
 * 【要確認】company.thebrowser.dia・com.kagi.kagimacOS・app.zen-browser.zen・ai.perplexity.comet・com.openai.atlas の実在。
 */
let paradisReadOnlyBrowsers: [String] = [
	"com.apple.Safari*",
	"com.google.Chrome*",
	"org.chromium.Chromium",
	"org.mozilla.firefox*",
	"org.mozilla.nightly",
	"com.microsoft.edgemac*",
	"com.brave.Browser*",
	"company.thebrowser.Browser",
	"company.thebrowser.dia",
	"com.operasoftware.Opera*",
	"com.vivaldi.Vivaldi*",
	"com.duckduckgo.macos.browser",
	"org.torproject.torbrowser",
	"com.kagi.kagimacOS*",
	"app.zen-browser.zen",
	"ai.perplexity.comet",
	"com.openai.atlas",
]

/**
 * 証券・暗号資産の取引アプリとウォレット。注文と送金は取り消せない。
 * 【要確認】どの id も実機で確かめていない（名前を含むものに広く当てている）。
 */
let paradisReadOnlyTradingApps: [String] = [
	"com.tradingview.tradingviewapp.desktop",
	"*tradingview*",
	"*metatrader*",
	"*thinkorswim*",
	"*interactivebrokers*",
	"*webull*",
	"*moomoo*",
	"*binance*",
	"*coinbase*",
	"*bitflyer*",
	"*coincheck*",
	"com.kraken.desktop",
	"com.ledger.live",
	"io.trezor.TrezorSuite",
	"io.exodus.exodus",
	"*marketspeed*",
	"*hypersbi*",
]

enum ParadisReadOnlyReason: String {
	case remoteDesktop = "remote-desktop"
	case browser = "browser"
	case trading = "trading"
}

/** そのアプリを読むだけにするなら理由を返す（常に断るアプリかどうかは `paradisBlockReason` が先に見る）。 */
func paradisReadOnlyReason(bundleId: String) -> ParadisReadOnlyReason? {
	if paradisMatches(bundleId, paradisReadOnlyRemoteDesktopApps) {
		return .remoteDesktop
	}
	if paradisMatches(bundleId, paradisReadOnlyBrowsers) {
		return .browser
	}
	if paradisMatches(bundleId, paradisReadOnlyTradingApps) {
		return .trading
	}
	return nil
}

enum ParadisBlockReason: String {
	case passwordManager = "password-manager"
	case authenticator = "authenticator"
	case keychain = "keychain"
	case paraCode = "para-code"
	case system = "system"
}

private func paradisMatches(_ bundleId: String, _ patterns: [String]) -> Bool {
	let id = bundleId.lowercased()
	return patterns.contains { pattern in
		let lower = pattern.lowercased()
		if lower.count > 2 && lower.hasPrefix("*") && lower.hasSuffix("*") {
			return id.contains(String(lower.dropFirst().dropLast()))
		}
		return lower.hasSuffix("*") ? id.hasPrefix(String(lower.dropLast())) : id == lower
	}
}

/** そのアプリを常に断るなら理由を返す。 */
func paradisBlockReason(bundleId: String) -> ParadisBlockReason? {
	if paradisMatches(bundleId, paradisBlockedPasswordManagers) {
		return .passwordManager
	}
	if paradisMatches(bundleId, paradisBlockedAuthenticators) {
		return .authenticator
	}
	if paradisMatches(bundleId, paradisBlockedKeychainApps) {
		return .keychain
	}
	if paradisMatches(bundleId, paradisBlockedParaCodeApps) {
		return .paraCode
	}
	if paradisMatches(bundleId, paradisBlockedSystemSurfaces) {
		return .system
	}
	return nil
}
