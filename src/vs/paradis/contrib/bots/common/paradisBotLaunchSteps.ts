/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のターミナルを起動する手順（ウィンドウの側）。ターミナルを作ってトークンが決まったら、エージェントのコマンドを
// 送る前に shared process へペインを報告し（reportLaunch）、タブ名を Bot の名前にする。エージェントの CLI は起動の
// 直後に MCP へ接続して道具の一覧を 1 回だけ取るので、報告が遅れると、その会話の間ずっと Bot の道具が出ない
// （para-browser MCP は道具の一覧の変更を知らせない: `tools.listChanged: false`）。

/** 起動したターミナル（`IParadisLaunchedAgentTerminal` と同じ形）。 */
export interface IParadisBotLaunchedTerminal {
	readonly instanceId: number;
	readonly paneToken: string | undefined;
}

export interface IParadisBotLaunchSteps {
	reportLaunch(launchId: string, paneToken: string): Promise<boolean>;
	cancelLaunch(launchId: string): Promise<void>;
	/** ターミナルを作り、`beforeCommand` が true を返したらエージェントのコマンドを送る（false なら閉じて投げる）。 */
	launchAgent(beforeCommand: (terminal: IParadisBotLaunchedTerminal) => Promise<boolean>): Promise<IParadisBotLaunchedTerminal>;
	/** タブ名を Bot の名前にする。 */
	nameTab(instanceId: number): void;
}

export type ParadisBotLaunchOutcome =
	| { readonly ok: true; readonly instanceId: number }
	/** `refused`: shared process が結び付けを断った（番号の期限切れなど）。`failed`: ターミナルかエージェントを起動できなかった。 */
	| { readonly ok: false; readonly reason: 'refused' | 'failed' };

export async function paradisRunBotLaunch(steps: IParadisBotLaunchSteps, launchId: string): Promise<ParadisBotLaunchOutcome> {
	let reported = false;
	let refused = false;
	let launched: IParadisBotLaunchedTerminal | undefined;
	try {
		launched = await steps.launchAgent(async terminal => {
			if (terminal.paneToken === undefined) {
				return false;
			}
			reported = await steps.reportLaunch(launchId, terminal.paneToken);
			refused = !reported;
			if (reported) {
				steps.nameTab(terminal.instanceId);
			}
			return reported;
		});
	} catch {
		launched = undefined;
	}
	if (!reported) {
		// 報告の前に失敗したときだけ番号を捨てる（報告で番号は使い切っている）
		if (!refused) {
			await steps.cancelLaunch(launchId);
		}
		return { ok: false, reason: refused ? 'refused' : 'failed' };
	}
	// 報告の後でコマンドを送れなかった。結び付けはターミナルが閉じたときに外れる
	return launched !== undefined ? { ok: true, instanceId: launched.instanceId } : { ok: false, reason: 'failed' };
}

/**
 * タブ名の雛形（`titleTemplate`）にする Bot の名前。雛形の変数（`${process}` など）として読まれないよう、`${` を
 * 崩す。固定の名前（rename）にしないのは、固定の名前を付けるとエージェントが出すタイトル（OSC）の購読が止まるため。
 */
export function paradisBotTabTitle(name: string): string {
	return name.replace(/\$\{/g, '$ {');
}
