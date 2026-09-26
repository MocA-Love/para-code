/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Portions adapted from stablyai/orca (MIT): src/main/browser/browser-webauthn-access.ts,
// src/renderer/src/components/browser-webauthn-account-dialog.tsx

// 内蔵ブラウザのパスキー（WebAuthn）で、セキュリティキー等に複数のアカウントが入っているときの
// アカウント選択。選択 UI は upstream のデバイス選択（USB / HID などと同じ QuickPick）をそのまま使い、
// ここではアカウントを候補の形に直す部分と、種類の表示名だけを持つ。

import { localize } from '../../../../nls.js';
import type { IBrowserDeviceCandidate } from '../../../../platform/browserView/common/browserPermissions.js';

/** Electron の `WebAuthnAccount` のうち、表示と選択に使う項目。 */
export interface IParadisWebAuthnAccount {
	readonly credentialId: string;
	readonly displayName?: string;
	readonly name?: string;
}

/** デバイス選択の QuickPick のタイトル（「{サイト} が {これ} への接続を求めています」）に入る種類名。 */
export function paradisWebAuthnDeviceTypeLabel(): string {
	return localize('paradis.browser.webauthn.kind', "パスキーのアカウント");
}

/**
 * アカウントを選択肢に直す。表示名が無いアカウントは「パスキー N」とし、ユーザー名（多くはメール
 * アドレス）は表示名と違うときだけ補足に出す。`deviceId` には資格情報 ID をそのまま入れる。
 */
export function paradisWebAuthnAccountCandidates(accounts: readonly IParadisWebAuthnAccount[]): IBrowserDeviceCandidate[] {
	return accounts.map((account, index) => {
		const label = account.displayName || account.name || localize('paradis.browser.webauthn.fallback', "パスキー {0}", index + 1);
		const detail = account.name && account.name !== label ? account.name : undefined;
		return { deviceId: account.credentialId, label, ...(detail ? { detail } : {}) };
	});
}
