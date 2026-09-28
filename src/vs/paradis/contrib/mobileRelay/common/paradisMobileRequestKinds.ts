/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * provider（`paradisMobileWorkspaceProvider.ts`）が自分の分岐で持っている scm / fs の種類。
 * 登録表（`paradisMobileRequestHandlers.ts`）はこれらの登録を例外で拒む（既存の処理を黙って置き換えないため）。
 *
 * provider に種類を足したらここにも足す。`paradisMobileRequestKinds.test.ts` が provider の
 * ソースから `msg.t === '…'` を拾い、ここに漏れが無いかを確かめる。
 */
export const PARADIS_MOBILE_BUILTIN_REQUEST_KINDS: { readonly scm: readonly string[]; readonly fs: readonly string[] } = {
	scm: [
		'status', 'diff', 'xlsxDiff', 'commit', 'log', 'commitFiles',
		'worktreeForm', 'createWorktree', 'launchAgent', 'noteGet', 'noteSet', 'presets', 'runPreset',
	],
	fs: [
		'read', 'list', 'xlsx', 'pdf', 'docx', 'media', 'upload', 'hl', 'find', 'grep', 'resolveLink',
		'usage', 'rtk', 'limits', 'github', 'sysres', 'spacedisk',
		'office/hello', 'office/wordDiff', 'office/cancel',
		// provider の手前（handleInbound）で受ける warm lease
		'usageWarmLease', 'spaceDiskWarmLease',
	],
};
