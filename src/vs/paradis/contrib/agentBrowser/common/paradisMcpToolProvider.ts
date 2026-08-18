/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI向けMCPサーバー（ParadisAgentBrowserService が 127.0.0.1 に立てている
// Streamable HTTP エンドポイント）へ、別のcontribが自前のツールを足すための拡張点。
//
// なぜ拡張点にするか: ツール本体を ParadisAgentBrowserService へ直接足すと、既に3000行ある
// あのサービスが機能ごとに肥大化し続ける。逆にツールごとに別のMCPエンドポイントを立てると、
// ユーザーがエージェントCLIへ登録するMCPサーバーが機能追加のたびに増えてしまう。
// 「サーバーは1本のまま、ツールの実装は各contribが持つ」ためにこの1枚を挟む。
//
// 認証・ペイン解決・同時実行制御は既にサーバー側が済ませているため、プロバイダは
// 「解決済みのペイントークン」を受け取るところから始められる。

/**
 * MCPの `tools/list` が返すツール1件の定義。JSON Schema をそのまま載せるため
 * `inputSchema` は構造を固定しない。
 */
export interface IParadisMcpToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

/**
 * MCPサーバーへツールを提供する側が実装するインターフェース。
 *
 * `callTool` は解決済みのペイントークンを受け取る。呼び出し元のペインを identify する処理は
 * サーバー側（Bearerトークンの検証と ingress lease）で完了しているので、プロバイダは
 * 「このペインが何を触ってよいか」の判断だけに集中すればよい。
 */
export interface IParadisMcpToolProvider {
	/**
	 * このプロバイダが提供するツールの一覧。`tools/list` のたびに呼ばれるため、
	 * 実行時の状態によって出し分けてよい（例: 前提となるバックエンドが無ければ空を返す）。
	 */
	listTools(): readonly IParadisMcpToolDefinition[];

	/**
	 * `name` が自分の提供するツールなら実行して結果を返す。自分のツールでなければ
	 * `undefined` を返すこと（サーバーは次のプロバイダ、最終的には内蔵の
	 * chrome-devtools-mcp への転送を試みる）。
	 *
	 * @param paneToken 呼び出し元のターミナルペインを表す解決済みトークン
	 */
	callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown | undefined>;
}
