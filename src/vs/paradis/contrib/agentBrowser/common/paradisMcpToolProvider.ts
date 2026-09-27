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

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisAgentStatus } from './paradisAgentBrowser.js';

/**
 * MCPの `tools/list` が返すツール1件の定義。JSON Schema をそのまま載せるため
 * `inputSchema` は構造を固定しない。
 */
export interface IParadisMcpToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
	/** MCP のツール注釈（`readOnlyHint` / `destructiveHint` など）。クライアントが確認の出し分けに使う。 */
	readonly annotations?: object;
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
	callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined>;

	/**
	 * MCP の `initialize` 応答の `instructions`（サーバーの説明）へ足す文。無ければ何も足さない。
	 * エージェントCLIは接続のたびにこれを読むので、短く保つこと（詳しい説明はツールで返す）。
	 */
	instructions?(): string | undefined;
}

/** 呼び出し元ペインを所有するウィンドウへの1回の呼び出し。 */
export interface IParadisMcpOwningWindowRequest {
	readonly channelName: string;
	readonly method: string;
	readonly args: unknown[];
	/** ログに残す短い名前（ツール名など）。 */
	readonly failureLabel: string;
	/** 呼び出しに失敗したときにエージェントへ返す英文。 */
	readonly failureMessage: string;
	/** 応答を待つ上限。既定は 10 秒。worktree の作成のように長くかかるものだけ延ばす。 */
	readonly timeoutMs?: number;
	/** 時間切れのときだけ `failureMessage` の代わりに返す英文。 */
	readonly timeoutMessage?: string;
}

export type ParadisMcpOwningWindowResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** shared process 側で hook から分かっている、ペインのエージェントの状態。 */
export interface IParadisMcpPaneAgentStatus {
	readonly status: ParadisAgentStatus;
	/** その状態になった時刻（`Date.now()`）。 */
	readonly changedAt: number;
}

/**
 * ツールの実行中にだけ使える、MCP サーバー側の機能。
 *
 * プロバイダはペイントークンしか受け取らないが、画面側（ウィンドウ）の状態を読むには
 * 「そのペインを所有するウィンドウ」へ正しく届ける必要がある。その振り分けはサーバーが
 * 持っているので、ここから借りる（プロバイダが自前でウィンドウを探すと取り違えうる）。
 */
export interface IParadisMcpToolCallContext {
	/** 呼び出し元ペインを所有するウィンドウの IPC チャネルを1回呼ぶ。 */
	callOwningWindow<T>(request: IParadisMcpOwningWindowRequest, signal?: AbortSignal): Promise<ParadisMcpOwningWindowResult<T>>;
	/**
	 * 任意のペイン（トークン）のエージェントの状態。hook が状態を報告していなければ undefined。
	 * 画面側の表示は 2 秒ごとの取り直しで遅れるので、送ってよいかの判断はこちらで行う。
	 */
	getPaneAgentStatus(paneToken: string): IParadisMcpPaneAgentStatus | undefined;
	/** そのペインから hook が一度でも届いたか（hook が効いていない相手を見分けるため）。 */
	hasAgentHookHistory(paneToken: string): boolean;
	/**
	 * 接続元のプロセスが、呼び出し元ペインのシェルの子孫か。トークンは同じユーザーの別プロセスからも
	 * 読めるので、操作系のツールはこれが真のときだけ動かす。SSH 越しの接続など確かめられないときは偽。
	 */
	verifyCallerProcess(): Promise<boolean>;
}

// --- 登録口 ----------------------------------------------------------------------------------

const registeredProviders = new Set<IParadisMcpToolProvider>();

/**
 * MCP サーバーへツールのプロバイダを足す。`sharedProcessMain.ts` を触らずに、
 * `paradis.sharedProcess.contribution.ts` 経由の登録からツールを足すための口。
 * サーバーは `tools/list` / `tools/call` のたびにここを読むので、サーバーの生成より前でも後でもよい。
 */
export function paradisRegisterMcpToolProvider(provider: IParadisMcpToolProvider): IDisposable {
	registeredProviders.add(provider);
	return toDisposable(() => registeredProviders.delete(provider));
}

/** 登録口から足されたプロバイダを登録順に返す。 */
export function paradisRegisteredMcpToolProviders(): readonly IParadisMcpToolProvider[] {
	return [...registeredProviders];
}
