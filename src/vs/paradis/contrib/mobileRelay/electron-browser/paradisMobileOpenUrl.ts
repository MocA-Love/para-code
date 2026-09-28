/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホのターミナルで押した `localhost` などの URL を、PC の内蔵ブラウザで開く（W2-31、Q123 A）。
// 開く道は、ターミナルの右クリックの「内蔵ブラウザで開く」と同じ `BrowserViewCommandId.Open`。
// スマホはこの後に内蔵ブラウザのページ一覧を取り直し、開いたページをブラウザのタブで映す。
// capability は `ParadisMobileCapability.BrowserOpenUrl`（広告の無い PC にはアプリが送らない）。

import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 受ける URL の長さの上限。 */
const MAX_URL_LENGTH = 4096;

/**
 * 開いてよい URL か。http(s) でホストがあるものだけ（`javascript:` や `file:` は開かない）。
 * ユーザー名・パスワードの付いた URL（`http://user:pass@host/`）も開かない（表示と行き先を取り違えさせる形のため）。
 * 開いてよければ、そのまま開く形（前後の空白を落としたもの）を返す。
 */
export function paradisMobileOpenableUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
		return undefined;
	}
	const url = value.trim();
	// 制御文字（改行など）が混じった URL は開かない。
	if (/[\u0000-\u001f\u007f]/.test(url) || !/^https?:\/\/[^/?#\s]+/i.test(url)) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0 && parsed.username.length === 0 && parsed.password.length === 0 ? url : undefined;
	} catch {
		return undefined;
	}
}

registerParadisMobileRequestHandler('fs', 'openUrl', {
	handle(accessor, request, context) {
		const url = paradisMobileOpenableUrl(request.url);
		if (url === undefined) {
			context.reply({ error: 'invalid url' });
			return;
		}
		const commandService = accessor.get(ICommandService);
		return commandService.executeCommand(BrowserViewCommandId.Open, url).then(() => context.reply({ t: 'openUrl' }));
	},
});
