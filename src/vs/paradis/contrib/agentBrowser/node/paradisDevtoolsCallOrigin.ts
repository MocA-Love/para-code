/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp の道具の呼び出しが、何のための呼び出しかを Sentry の報告に載せる（q.html Q462 の D1・D2）。
// 道具の失敗は paradisDevtoolsMcpProxy.ts が報告するが、そこからは中で使った道具（evaluate_script など）しか見えない。
// サービスは、エージェントが呼んだ道具（wait_until など）と、Para Code 自身の見張り（操作の前後の観測）かどうかを
// tryCallTool に渡す。道具の結果は変えない。

/** 呼び出しの由来。 */
export interface IParadisDevtoolsCallOrigin {
	/** エージェントが呼んだ道具の名前。 */
	readonly agentTool?: string;
	/** Para Code 自身の見張り（操作の前後の観測）の呼び出し。エージェントには結果が届かない。 */
	readonly internal?: 'observe';
}

/** Sentry へ載せてよい道具の名前の形（エージェントが渡した名前をそのまま送らない）。 */
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** 呼び出しの由来を、報告に足す項目にする（分からなければ空）。 */
export function paradisDevtoolsCallOriginExtra(origin: IParadisDevtoolsCallOrigin | undefined): { readonly safe_agent_tool?: string; readonly safe_internal?: string } {
	return {
		...(origin?.agentTool !== undefined && SAFE_TOOL_NAME.test(origin.agentTool) ? { safe_agent_tool: origin.agentTool } : {}),
		...(origin?.internal !== undefined ? { safe_internal: origin.internal } : {}),
	};
}
