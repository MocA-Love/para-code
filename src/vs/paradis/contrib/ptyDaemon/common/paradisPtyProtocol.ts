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
//  - `Cwd` / `InitialCwd` / `HasChildProcesses` は pid から引ける。常駐とアプリ側は常に同じ機械の
//    上に居る (ローカルは当然、SSH でも「アプリ側」＝ REH サーバーはリモート上に居る) ので、
//    {@link IParadisPtySummary.pid} さえ渡ればアプリ側で引ける
//  - `Title` だけは pid では引けない。前面プロセスの名前は pty を持っている側にしか見えないため
//    (node-pty の `IPty.process`)。**ただの文字列**なので、常駐から文字列として渡す
//    ({@link IParadisPtySummary.title})。`IProcessPropertyMap` に組み立てるのはアプリ側のまま
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

import { Event } from '../../../../base/common/event.js';

/**
 * 話が通じる相手かを決める版。
 *
 * 履歴:
 *   1 → 2: `attach` に見に来た相手の名札を足し（必須）、接続の名乗りを相手ごとに一意にした。
 *          どちらも古い相手とは噛み合わない。**版を上げないと新旧が同じソケットで出会い、
 *          両方向とも「離したことに気づけない」形で壊れる**（古い常駐は新しい名乗りを
 *          自分の相手だと認識できず、新しい常駐は名札なしの `attach` を誰の持ち分にも
 *          入れられない）。しかも症状は「更新したらターミナルが戻ってこない」なので、
 *          この機能そのものが壊れているようにしか見えない。
 *
 * **アプリのビルドとは無関係**。ここが同じなら、更新をまたいでも同じ常駐へ繋ぎ直せる。
 * 逆にここを上げた更新では、古い常駐は「別のもの」として扱われ、抱えていたターミナルは
 * そちらに残る (見えるが繋がらない、という今までの状態になる)。
 */
export const PARADIS_PTY_PROTOCOL_VERSION = 2;

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
	/**
	 * 端末の種類（TERM）。
	 *
	 * **渡さないと `xterm` に落ちる。** node-pty は `name` が無ければ `TERM` 環境変数を見るが、
	 * VS Code は env に `TERM` を入れないので、既定の `xterm` になる。upstream は非 Windows で
	 * `xterm-256color` を渡しており、Linux の既定 `~/.bashrc` の色付きプロンプトはこれを見て
	 * 判断する。**黙って色が落ちる**類の差なので、面に載せて渡す側が決める。
	 */
	readonly term: string;
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
	/**
	 * 終わっていたときの終了コードと signal。
	 *
	 * **イベントでは足りない。** イベントは繋がっている相手にしか届かないが、この機能の主目的は
	 * 「閉じている間に走り切らせ、戻ってきて結果を読む」こと。戻ってきた側が
	 * 「死んでいる」しか分からないのでは、その主目的の経路で肝心の答えが落ちる。
	 */
	readonly exitCode: number | undefined;
	readonly exitSignal: string | undefined;
	/**
	 * すでに誰かが見ているか。
	 *
	 * **引き取る側が二重に引き取らないため。** 同じ機械で2つのサーバーが生き残ることがあり
	 * （更新のあと古い方が居座る）、両方が同じ置き場所を見る。両方が同じ端末を引き取ると、
	 * 入力も出力も二重になり、片方の終了操作がもう片方の端末を殺す。
	 */
	readonly attached: boolean;
	/**
	 * 前面で動いているものの名前。
	 *
	 * **ここだけは pid から引けない**ので常駐が渡す（冒頭参照）。文字列なので、この面に
	 * VS Code の型は増えない。
	 */
	readonly title: string;
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

export interface IParadisPtyTitleEvent {
	readonly handle: number;
	readonly title: string;
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

/** 常駐と話すチャネルの名前。 */
export const PARADIS_PTY_HOST_CHANNEL = 'paradisPtyHost';

/**
 * ターミナルを見に来た相手が名乗る名前。
 *
 * **見ている相手と、様子を見に来ただけの相手を区別するために要る。** 状態パネルや停止 UI も
 * 同じソケットへ繋ぐので、接続の数だけでは「もう誰も見ていない」を判断できない。名乗りが
 * 一致する接続が消えたときだけ、抱えているものを離す。
 */
export const PARADIS_PTY_HOST_CLIENT = 'paradis-pty-host';

/**
 * この pty ホストの名札を作る。
 *
 * 接続の名乗りと `attach` の `viewer` に同じものを使う。**プロセスごとに違う値**でなければ、
 * 2つのサーバーが同じ常駐に繋いだときに見分けが付かない。
 */
export function paradisPtyHostClientId(): string {
	return `${PARADIS_PTY_HOST_CLIENT}:${process.pid}:${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

/** その名乗りが pty ホストのものか。接続が消えたときの判断に使う。 */
export function paradisIsPtyHostClient(ctx: string): boolean {
	return ctx.startsWith(`${PARADIS_PTY_HOST_CLIENT}:`);
}

/**
 * 常駐にできること。**これが凍結する面そのもの。**
 *
 * ここに VS Code の型が1つも出てこないことが、更新をまたいで繋ぎ直せる理由。増やすときは
 * 省略可能な項目の追加だけにし、互換を壊すなら {@link PARADIS_PTY_PROTOCOL_VERSION} を上げる。
 */
export interface IParadisPtyHost {
	readonly onDidChangeData: Event<IParadisPtyDataEvent>;
	readonly onDidChangeTitle: Event<IParadisPtyTitleEvent>;
	readonly onDidExit: Event<IParadisPtyExitEvent>;

	hello(): Promise<IParadisPtyGreeting>;
	list(): Promise<readonly IParadisPtySummary[]>;

	/** 起こす。**要約ごと返す**のは、直後に pid が要るため（往復を1回に）。 */
	spawn(request: IParadisPtySpawnRequest): Promise<IParadisPtySummary>;

	/**
	 * 繋ぎ直す。控えを受け取り、以後の出力が流れ始める。
	 *
	 * `viewer` は見に来た相手の名札で、繋いだときの名乗りと同じ文字列を渡す。**誰が見ているかを
	 * 持たないと、離すときに粒度が合わない。** 同じ機械で2つのサーバーが生き残ることがあり
	 * （更新のあと古い方が居座る）、片方が消えたときにもう片方の分まで離すと、動いている窓が
	 * 無音になる。逆に何も離さないと、消えた側が見ていた端末は「まだ見られている」ままになり、
	 * 誰も ack しないので高水位で止まったうえ、引き取りからも飛ばされて**永久に戻らない**。
	 */
	attach(handle: number, viewer: string): Promise<IParadisPtyAttachment>;
	/**
	 * 見るのをやめる。**pty は止まらない。**
	 *
	 * `viewer` を渡すと、その相手の持ち分からだけ外す。渡さないと全員の持ち分から外れる。
	 */
	detach(handle: number, viewer?: string): Promise<void>;

	/**
	 * 打鍵などを送る。
	 *
	 * `binary` を立てたときは、`data` を **latin1（1文字＝1バイト）** として書く。立てない
	 * ときは UTF-8。分けないと 0x80-0xFF が別のバイト列になり、**マウス報告や貼り付けが
	 * 静かに壊れる**（upstream も `Buffer.from(data, 'binary')` と使い分けている）。
	 */
	input(handle: number, data: string, binary?: boolean): Promise<void>;
	acknowledge(handle: number, charCount: number): Promise<void>;
	resize(handle: number, cols: number, rows: number): Promise<void>;
	setMetadata(handle: number, metadata: string): Promise<void>;
	/**
	 * 控えを捨てる。画面を消したときに呼ぶ。
	 *
	 * 効かせないと、消したはずの出力が繋ぎ直したときに戻ってくる。
	 */
	clearScrollback(handle: number): Promise<void>;
	kill(handle: number, signal?: string): Promise<void>;
	/** 抱えるのをやめる。終わったものを片付ける合図。 */
	release(handle: number): Promise<void>;

	setLayout(scopeId: string, layout: string): Promise<void>;
	getLayout(scopeId: string): Promise<string | undefined>;
}
