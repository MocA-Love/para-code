/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Portions adapted from stablyai/orca (MIT): src/main/browser/browser-webauthn-access.ts

// 内蔵ブラウザで `navigator.credentials.get()` が複数のアカウント（discoverable credential）を返したときに
// Electron が出す `select-webauthn-account` を処理する。リスナーが無いと Electron はその場で要求を
// 取り消すので、ページには NotAllowedError が返り、パスキーでログインできなかった。
//
// 選択 UI は upstream のデバイス選択の流れ（browserSessionPermissions の `_beginDeviceRequest`）に乗せる。
// そうすると、要求元のページを表示しているビューが要求を引き受け、そのビューがあるウィンドウ
// （補助ウィンドウを含む）に QuickPick が出る。ページが閉じられたときの取り消しもその流れが持つ。
// 呼び出し元は browserSessionPermissions.ts のコンストラクタ（PARA-PATCH 1行）。

import type { Session, WebContents, WebFrameMain } from 'electron';
import type { BrowserDeviceType, IBrowserDeviceCandidate } from '../../../../platform/browserView/common/browserPermissions.js';
import { paradisWebAuthnAccountCandidates } from '../common/paradisBrowserWebAuthn.js';

/** upstream の `_beginDeviceRequest` に渡す要求（同じ形）。 */
export interface IParadisWebAuthnChooserRequest {
	readonly webContents: WebContents;
	readonly origin: string;
	readonly deviceType: BrowserDeviceType;
	readonly devices: IBrowserDeviceCandidate[];
	readonly invoke: (deviceId: string | null) => void;
}

/**
 * `select-webauthn-account` を配線する。
 *
 * - アカウントが1つ以下なら聞かずにそれを返す（Electron は通常2つ以上のときだけ発火する）
 * - 要求元のページが分からなければ取り消す
 * - 選ばれた ID が候補に無いもの（取り消しを含む）なら取り消す
 */
export function paradisInstallWebAuthnAccountChooser(
	session: Pick<Session, 'on'>,
	resolveTarget: (frame: WebFrameMain | null) => { readonly webContents: WebContents; readonly origin: string } | undefined,
	begin: (request: IParadisWebAuthnChooserRequest) => void,
): void {
	session.on('select-webauthn-account', (event, details, callback) => {
		event.preventDefault();
		if (details.accounts.length <= 1) {
			callback(details.accounts[0]?.credentialId ?? null);
			return;
		}
		const target = resolveTarget(details.frame);
		if (!target) {
			callback(null);
			return;
		}
		const credentialIds = new Set(details.accounts.map(account => account.credentialId));
		begin({
			webContents: target.webContents,
			origin: target.origin,
			deviceType: 'webauthn',
			devices: paradisWebAuthnAccountCandidates(details.accounts),
			invoke: credentialId => callback(credentialId !== null && credentialIds.has(credentialId) ? credentialId : null),
		});
	});
}
