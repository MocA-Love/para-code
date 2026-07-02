/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのCPU/RAM使用率インジケータ(機能E-3、Superset移植)の共有定義。
// electron-main(実際の収集)と electron-browser(表示・ポーリング)の両方から参照される。

/**
 * electron-main ⇔ electron-browser 間のリソーススナップショット取得用IPCチャネル名。
 */
export const PARADIS_RESOURCE_MONITOR_CHANNEL = 'paradisResourceMonitor';

export interface IParadisResourceUsage {
	/** CPU使用率(%)。マルチコアでは100を超え得る。 */
	readonly cpu: number;
	/** 常駐メモリ(バイト)。 */
	readonly memory: number;
}

/**
 * renderer側が把握している「ターミナルセッション1件」の集計依頼。
 * pid はシェルのPID(プロセスツリーの起点)。
 */
export interface IParadisResourceMonitorSessionRequest {
	/** 所属スコープの状態キー (IParadisWorkspaceSwitchService.activeStateKey と同じ空間)。 */
	readonly stateKey: string;
	readonly scopeName: string;
	readonly sessionName: string;
	readonly pid: number;
}

export interface IParadisResourceMonitorSnapshotRequest {
	readonly sessions: readonly IParadisResourceMonitorSessionRequest[];
	/** trueならキャッシュを無視して再収集する(手動リフレッシュ用)。 */
	readonly force?: boolean;
}

export interface IParadisResourceMonitorSessionMetrics extends IParadisResourceUsage {
	readonly name: string;
	readonly pid: number;
}

export interface IParadisResourceMonitorScopeMetrics extends IParadisResourceUsage {
	readonly stateKey: string;
	readonly scopeName: string;
	readonly sessions: readonly IParadisResourceMonitorSessionMetrics[];
}

export interface IParadisResourceMonitorAppMetrics extends IParadisResourceUsage {
	readonly main: IParadisResourceUsage;
	readonly renderer: IParadisResourceUsage;
	readonly other: IParadisResourceUsage;
}

export interface IParadisResourceMonitorSnapshot {
	readonly app: IParadisResourceMonitorAppMetrics;
	readonly scopes: readonly IParadisResourceMonitorScopeMetrics[];
	readonly totalCpu: number;
	readonly totalMemory: number;
	/** ホストの物理メモリ総量(バイト)。RAM Share算出に使う。 */
	readonly hostTotalMemory: number;
	readonly collectedAt: number;
}

/**
 * electron-browser側で `ProxyChannel.toService` によりプロキシ化される際の型。
 * 実装は electron-main/paradisResourceMonitorMainService.ts の ParadisResourceMonitorMainService。
 */
export interface IParadisResourceMonitorMainService {
	getSnapshot(request: IParadisResourceMonitorSnapshotRequest): Promise<IParadisResourceMonitorSnapshot>;
}
