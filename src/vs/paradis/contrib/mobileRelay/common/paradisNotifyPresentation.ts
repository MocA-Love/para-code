/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイル通知の見出しの組み立て。
 *
 * ロック画面でiOSが太字にするのは `title` だけなので、そこは**ワークツリー（スペース）の名前**
 * だけに使い切る。同時に何本もエージェントを回していると「どこが待っているか」が唯一の手掛かりに
 * なるためで、エージェント名やPC名を混ぜると肝心の名前が先に切れる。
 *
 * エージェント種別は `subtitle` に回す。PC名はここでは付けない——何台のPCとペアリングしているかを
 * 知っているのは受け取る側だけで、1台しか繋いでいない人にPC名を出しても場所を食うだけになる。
 * 2台以上のときに `pcName` を継ぎ足すのは、通知拡張（NotificationService.swift）とアプリ
 * （app/mobile/src/notifyPresentation.ts）の役目。
 *
 * 通知を作る場所が shared process（transcript 由来の質問）と renderer（状態遷移由来）の2つあり、
 * どちらも同じ見た目にする必要があるためここへ切り出している。
 */

/** 通知に出すエージェントの呼び名。 */
export function paradisAgentLabel(agent: 'claude' | 'codex'): string {
	return agent === 'codex' ? 'Codex' : 'Claude';
}

/**
 * スペース名から、旧アプリ互換のために付いている worktree 印を外す。
 *
 * PCは worktree のスペース名を「印 + 名前」で配っており（paradisMobileWorkspaceProvider）、
 * 新しいアプリは親子で並べたうえで表示のときに外している。通知でも同じ見え方に揃える。
 */
// allow-any-unicode-next-line
const WORKTREE_MARK = /^✦\s*/;

/**
 * タイトル（＝ワークツリー名）を決める。
 *
 * スペースに属さないターミナルからの通知もあるため、名前が取れないときはターミナル名へ、
 * それも無ければ製品名へ落とす。空文字を返さない（iOSはタイトルが空だと詰めて表示し、
 * 本文だけの通知に見える）。
 */
export function paradisNotifyTitle(workspaceName: string | undefined, terminalTitle?: string): string {
	const candidates = [workspaceName?.replace(WORKTREE_MARK, ''), terminalTitle];
	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed !== undefined && trimmed.length > 0) {
			return trimmed;
		}
	}
	return 'Para Code';
}

/**
 * 副題に出す候補を、タイトルと突き合わせて採否まで決める。
 *
 * ワークツリー名が引けないとタイトルはターミナル名へ落ちるので、そのまま副題にも同じものを
 * 入れると、ロック画面に同じ名前が2行並ぶ。
 */
export function paradisNotifySubtitleCandidate(candidate: string | undefined, title: string): string | undefined {
	const trimmed = candidate?.trim();
	if (trimmed === undefined || trimmed.length === 0 || trimmed === title) {
		return undefined;
	}
	return trimmed;
}
