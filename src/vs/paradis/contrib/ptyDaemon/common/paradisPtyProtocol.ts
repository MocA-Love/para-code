/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルとアプリの間で話す言葉。**凍結する面**。
//
// なぜ凍結できるのか。ここに VS Code の型が1つも出てこないから。
//
// 以前は `IPtyService` (42メソッド) をそのままソケットの向こうに置いていた。あの面には
// `ISerializedTerminalState` や `IProcessDetails` のように upstream の都合で形が変わるものが
// 含まれるので、新旧のビルドを出会わせられず、**更新すると常駐へ繋ぎ直せなかった**。
//
// 分割線を1段下げると景色が変わる。`ITerminalChildProcess` の13個のうち11個は pty に対する
// 原始的な操作で、VS Code の型を運ばない。残る2つ (`refreshProperty` / `updateProperty`) は
// `IProcessPropertyMap` を運ぶが、**あれは常駐を越える必要が無い**:
//
//  - `Cwd` / `InitialCwd` / `Title` / `ShellType` / `HasChildProcesses` は pid から引ける。
//    常駐とアプリ側は常に同じ機械の上に居る (ローカルは当然、SSH でも「アプリ側」＝ REH サーバーは
//    リモート上に居る) ので、{@link IParadisPtySummary.pid} さえ渡ればアプリ側で引ける
//  - `FixedDimensions` / `OverrideDimensions` はもともとアプリ側の状態
//  - `ResolvedShellLaunchConfig` / `UsedShellIntegrationInjection` / `FailedShellIntegrationActivation` /
//    `ShellIntegrationInjectionFailureReason` はシェル統合の注入の結果で、注入自体をアプリ側へ
//    寄せる (後述) ので最初からアプリ側にある
//
// **シェル統合の注入をアプリ側へ寄せるのは、この面を薄く保つためだけではない。** 注入する
// スクリプトが出す OSC を読むのはアプリ側なので、出す側と読む側が別々に更新されると壊れ方が
// 読めなくなる。だから常駐へは解決し切った {@link IParadisPtySpawnRequest} を渡し、
// スクリプトはアプリの中に留める。
//
// **`metadata` と `layout` は常駐にとってただの文字列**で、中身は一切見ない。題名・アイコン・
// スペースの所属・タブの配置のように「増えるもの・形が変わるもの」は全部こちらへ入れる。
// 常駐が読まないものは、形が変わっても壊れない。
//
// 版を上げるときは**省略可能な項目の追加だけ**にする。互換を壊す変更をするなら
// {@link PARADIS_PTY_PROTOCOL_VERSION} を上げること。上げれば置き場所の名前が変わり、
// 新旧が出会わなくなる (`paradisPtyDaemonPaths.ts`)。

/**
 * 話が通じる相手かを決める版。
 *
 * **アプリのビルドとは無関係**。ここが同じなら、更新をまたいでも同じ常駐へ繋ぎ直せる。
 * 逆にここを上げた更新では、古い常駐は「別のもの」として扱われ、抱えていたターミナルは
 * そちらに残る (見えるが繋がらない、という今までの状態になる)。
 */
export const PARADIS_PTY_PROTOCOL_VERSION = 1;

/** 環境変数。`IProcessEnvironment` を持ち込まないのは、この面に VS Code の型を出さないため。 */
export type ParadisPtyEnv = { readonly [key: string]: string };

/** 常駐に渡す起動要求。**解決し切った状態**で渡す（後述の理由でシェル統合の注入も済ませてある）。 */
export interface IParadisPtySpawnRequest {
	/** 実行するもの。`findExecutable` はアプリ側で済ませる。 */
	readonly file: string;
	readonly args: readonly string[];
	readonly env: ParadisPtyEnv;
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	/** 常駐は中身を見ない。 */
	readonly metadata: string;
}

/** 常駐が抱えているターミナル1本の見え方。 */
export interface IParadisPtySummary {
	readonly handle: number;
	/**
	 * 子プロセスの pid。
	 *
	 * **アプリ側が題名や cwd を引くための鍵**。常駐とアプリ側は同じ機械の上に居るので、
	 * これがあれば `IProcessPropertyMap` の大半をアプリ側で作れる。
	 */
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	readonly alive: boolean;
	/** 預かったものをそのまま返す。 */
	readonly metadata: string;
}

/** 画面を作り直すための1コマ。大きさが変わるたびに区切られる。 */
export interface IParadisPtyFrame {
	readonly cols: number;
	readonly rows: number;
	readonly data: string;
}

/** 繋ぎ直したときに返るもの。 */
export interface IParadisPtyAttachment {
	readonly frames: readonly IParadisPtyFrame[];
	/**
	 * 溜められる量を超えて、**古い出力が捨てられたか**。
	 *
	 * 誰も繋いでいない間もプログラムを走らせ切る方針（tmux と同じ）を採った以上、こぼれることが
	 * ある。**黙って歯抜けの画面を見せない**ために、こぼれたかどうかは必ず返して画面に出す。
	 */
	readonly dropped: boolean;
}

/** 常駐が押し付けてくるもの。 */
export interface IParadisPtyDataEvent {
	readonly handle: number;
	readonly data: string;
}

export interface IParadisPtyExitEvent {
	readonly handle: number;
	readonly code: number | undefined;
	readonly signal: string | undefined;
}

/** 名乗り合いの答え。 */
export interface IParadisPtyGreeting {
	readonly protocolVersion: number;
	readonly daemonPid: number;
}
