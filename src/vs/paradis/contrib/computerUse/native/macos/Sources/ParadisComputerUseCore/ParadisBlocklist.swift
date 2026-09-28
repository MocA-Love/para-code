/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常に操作させないアプリ（設計書 6.2、Q64・Q97）。shared process の判定（common/paradisComputerUse.ts）と二重にする
// （レビュー M1）。補助アプリにつながれる経路がもし残っていても、最悪の的は守るため。
//
// 一覧は TS 側と同じにする。build/paradis/computerUse/buildHelper.test.ts が突き合わせる。
// 末尾が `*` のものは、その手前で始まる bundle id 全部に当たる。

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
	"com.authy.authy-mac",
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

enum ParadisBlockReason: String {
	case passwordManager = "password-manager"
	case keychain = "keychain"
	case paraCode = "para-code"
	case system = "system"
}

private func paradisMatches(_ bundleId: String, _ patterns: [String]) -> Bool {
	let id = bundleId.lowercased()
	return patterns.contains { pattern in
		let lower = pattern.lowercased()
		return lower.hasSuffix("*") ? id.hasPrefix(String(lower.dropLast())) : id == lower
	}
}

/** そのアプリを常に断るなら理由を返す。 */
func paradisBlockReason(bundleId: String) -> ParadisBlockReason? {
	if paradisMatches(bundleId, paradisBlockedPasswordManagers) {
		return .passwordManager
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
