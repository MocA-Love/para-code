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

/**
 * 接続先（REH）が答える、マシン全体の使用量のチャネル。SSH で繋いでいる間は忙しいのが
 * 接続先のマシンなので、繋いでいるウィンドウはこちらへ聞く。
 */
export const PARADIS_HOST_RESOURCES_CHANNEL = 'paradisHostResources';

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

export interface IParadisHostMemory {
	/** 物理メモリ総量(バイト)。 */
	readonly total: number;
	/** 使用中(バイト)。total - free。 */
	readonly used: number;
}

/** マウントされたボリューム1つ分の容量。 */
export interface IParadisHostDiskVolume {
	/** 問い合わせに使ったパス。 */
	readonly path: string;
	/**
	 * 表示名。`statfs` からはマウントポイントが取れないため、問い合わせに使ったパスをそのまま出す
	 * （パス末尾だけにすると、ホーム配下に全リポジトリがある構成でアカウント名1行になってしまう）。
	 */
	readonly label: string;
	readonly total: number;
	/** 非特権ユーザーが実際に使える空き(バイト)。 */
	readonly free: number;
}

/**
 * ホストマシン全体の使用量。既存のスナップショット(Para Code本体＋ターミナルのプロセスツリー)とは
 * 対象が違うので、必ず別物として扱う(「PCが忙しいか」と「Para Codeが重いか」は別の問い)。
 * 収集の実体は node/paradisHostResources.ts。
 */
export interface IParadisHostResources {
	/** CPU使用率(0〜100、全コアの平均)。サンプルが1点しか無く算出できなかった場合はundefined。 */
	readonly cpu: number | undefined;
	readonly cores: number;
	readonly memory: IParadisHostMemory;
	/** 少なくとも1件（ホームディレクトリのボリューム）。取得に失敗した場合は空。 */
	readonly disks: readonly IParadisHostDiskVolume[];
	readonly collectedAt: number;
}

export interface IParadisHostResourcesRequest {
	/** 容量を見たいパス。省略時はホームディレクトリのボリュームのみ。 */
	readonly diskPaths?: readonly string[];
	/** trueならキャッシュを無視して再収集する（モバイルのプルダウン更新）。 */
	readonly force?: boolean;
}

/**
 * モバイルの「システム」画面へ返す1回分のレポート。ホスト全体＋Para Code内訳を1レスポンスにまとめる
 * (モバイル側で2つの数字の関係が読み取れるよう、必ず両方を同時に返す)。
 */
export interface IParadisResourceMonitorMobileReport {
	readonly host: IParadisHostResources;
	readonly snapshot: IParadisResourceMonitorSnapshot;
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
	/**
	 * ホストマシン全体の使用量。`getSnapshot` とは対象が違うため別メソッドにしてある
	 * (PC版のウィジェット/パネルはこちらを呼ばず、モバイルの「システム」画面だけが使う)。
	 * diskPaths は容量を見たいパス。省略時はホームディレクトリのボリュームのみ。
	 */
	getHostResources(request: IParadisHostResourcesRequest): Promise<IParadisHostResources>;
}
