/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 読み上げを手元の aivis-mcp の worker 1 つへ流し込む口（`aivis-mcp --ingest`、aivis-mcp 2.5.0 以上）の
// 型。通知の読み上げ（notifications）と SSH 先の声（agentBrowser）の両方が使う。

import { IParadisMobileVoiceStreamWriter } from '../../mobileRelay/common/paradisMobileVoiceStream.js';

/** `--ingest` を持つ aivis-mcp の最小の版。 */
export const PARADIS_AIVIS_INGEST_MIN_VERSION: readonly [number, number, number] = [2, 5, 0];

/** `aivis-mcp v2.5.0` や `2.5.0` から版を読む。読めなければ undefined。 */
export function paradisParseAivisVersion(text: string): readonly [number, number, number] | undefined {
	const match = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/.exec(text);
	if (!match?.groups) {
		return undefined;
	}
	return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

/** aivis-mcp が着信音（prelude）として受け付けるファイルの上限（docs/ingest-protocol.md の `prelude.path`）。 */
export const PARADIS_AIVIS_PRELUDE_MAX_BYTES = 10 * 1024 * 1024;

/** `version` が `minimum` 以上か。 */
export function paradisAivisVersionAtLeast(version: readonly [number, number, number] | undefined, minimum: readonly [number, number, number]): boolean {
	if (version === undefined) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (version[i] !== minimum[i]) {
			return version[i] > minimum[i];
		}
	}
	return true;
}

/** `open` の中身（docs/ingest-protocol.md の `open`）。 */
export interface IParadisIngestOpenOptions {
	/** `sound` は着信音だけ（音声も `end` も送らない）。`prelude` が必須。 */
	readonly kind?: 'stream' | 'sound';
	readonly priority: 'high' | 'normal';
	/** 音量の表の鍵 `provider:voice:model`。 */
	readonly gainKey?: string;
	/** Para Code の音量の設定を dB に直した値（-60〜20）。 */
	readonly volumeDb?: number;
	/** 感情タグ入りなど、音量の覚え直しに使わない発話。 */
	readonly tagged?: boolean;
	/** 着信音（声の前に鳴らす）。`volume` は 0〜1。 */
	readonly prelude?: { readonly path: string; readonly volume: number };
}

/** ジョブの終わり。`ingest-exited` は Para Code 側の印（`--ingest` が落ちて行方が分からない）。 */
export interface IParadisIngestTerminal {
	readonly status: 'done' | 'skipped' | 'held' | 'muted' | 'failed';
	readonly reason?: string;
	/** `true` のときだけ、まだ鳴っていないと aivis-mcp が保証している（worker-unavailable）。親が自分で鳴らしてよい。 */
	readonly withdrawn?: boolean;
}

/** `--ingest` に開いた 1 本の流れ。 */
export interface IParadisIngestStream {
	readonly id: string;
	/** `queued`（列に入った）で true、その前に失敗したら false。ここで true になったら手放してよい。 */
	readonly handoff: Promise<boolean>;
	/** 終わりの知らせ。`playing` 以降の進み具合は {@link onDidStart} で受ける。 */
	readonly finished: Promise<IParadisIngestTerminal>;
	/** worker が鳴らし始めた（着信音を含む）。手元に控えた音声を手放す合図。 */
	onDidStart(listener: () => void): void;
	/**
	 * `accepted` に `preludeRejected` が付いていた（着信音を付けずに積んだ）。呼び出し側が着信音を鳴らす。
	 * 無ければ知らせない（テストの代わりの実装など）。
	 */
	onDidRejectPrelude?(listener: (reason: string) => void): void;
	/**
	 * まだ worker が取り出していなければ列から外してもらう。`true` は外せた（まだ鳴っていないと aivis-mcp が保証する）、
	 * `false` は外せなかった（worker が鳴らす・鳴らした）、`undefined` は分からない（返事が来ない・子が落ちた）。
	 */
	withdraw?(): Promise<boolean | undefined>;
	/** MP3 を書く。子の標準入力の drain を待ってから解決する。閉じた流れには何もしない。 */
	write(chunk: Uint8Array): Promise<void>;
	end(): Promise<void>;
	abort(reason: string): Promise<void>;
}

/** 控えの音声の枠。受け取った分だけ {@link grow} で増やし、要らなくなったら {@link release}。 */
export interface IParadisVoiceRetention {
	/** `bytes` 増やす。全体の上限を超えるなら false（以後は控えない）。 */
	grow(bytes: number): boolean;
	release(): void;
}

/** 手元で鳴らす口（SSH 先の声が使う）。 */
export interface IParadisLocalVoiceOutput {
	/**
	 * `--ingest` が使えるなら流れを開く。使えない（2.5.0 が無い・起動し直している・失敗が続いた）なら undefined。
	 * `waitMs` まで起動を待つ。
	 */
	openIngest(options: IParadisIngestOpenOptions, waitMs: number): Promise<IParadisIngestStream | undefined>;
	/** 手元に `--play-audio` か `--ingest` を持つ aivis-mcp（2.4.0 以上）があるか。`waitMs` まで版の確認を待つ。 */
	hasLocalAivis(waitMs: number): Promise<boolean>;
	/**
	 * aivis-mcp に渡せなかった声を、Para Code が自分で（afplay 等で）鳴らす。通知の読み上げと重ならないよう同じ列に入れる。
	 * `gainKey` があれば音量の表で揃える（100 は超えない）。
	 */
	playFallback(audio: Uint8Array, gainKey?: string): Promise<boolean>;
	/**
	 * worker が鳴らせなかったときのために控える音声の、全体の枠を押さえる（手元のメモリの上限）。押さえられなければ
	 * undefined（控えずに手放す）。
	 */
	reserveFallbackCopy?(): IParadisVoiceRetention | undefined;
	/**
	 * モバイルへの音声の流れを始める（受け取りながら書く）。`gainKey` からモバイルで当てる音量の補正を決める。
	 * 無ければ全部受け取ってから 1 本まるごとで渡す。
	 */
	beginMobileVoiceStream?(gainKey?: string): IParadisMobileVoiceStreamWriter;
}
