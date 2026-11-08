/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code の音声入力の認識エンジン（upstream の ILocalTranscriptionService の差し替え先）の共通部分。
//
// upstream のディクテーションの画面（チャットの入力・エディタ・ターミナル）とマイクの取り込みはそのまま使い、
// 認識だけを Para の実装へ回す。Mac は macOS 26 以上の SpeechAnalyzer を使う Swift の補助プログラム
// （`ParadisSpeech`）を utility process から起動し、PCM を標準入力で渡して、標準出力の JSON の行を読む。
// upstream の Foundry Local の部品（Q92 で断ったもの）は一度も取りに行かない。
//
// 補助プログラムとの約束:
//  - 起動: `ParadisSpeech transcribe --locale <BCP 47 | auto>`
//  - 標準入力: PCM16（リトルエンディアン）・モノラル・16kHz。閉じると「話し終わり」（残りを書き起こして終わる）
//  - 止める（捨てる）: SIGTERM
//  - 標準出力: 1 行に 1 つの JSON（{@link IParadisSpeechHelperMessage}）

import { Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { ILocalTranscriptionModelStatus, ILocalTranscriptionResult } from '../../../../platform/localTranscription/common/localTranscription.js';

/** utility process の IPC のチャンネル名。 */
export const PARADIS_SPEECH_ENGINE_CHANNEL = 'paradisSpeechEngine';

/** utility process の入口（build/next/index.ts の desktopEntryPoints にも同じ値がある）。 */
export const PARADIS_SPEECH_ENGINE_MODULE_ID = 'vs/paradis/contrib/dictation/node/paradisSpeechEngineMain';

/** 補助プログラムの実行ファイルの名前。配布版は `<Para Code.app>/Contents/Helpers/` に置く。 */
export const PARADIS_SPEECH_HELPER_EXECUTABLE = 'ParadisSpeech';

/** SpeechAnalyzer（SpeechTranscriber / DictationTranscriber）が使える最低の Darwin の版（macOS 26 = Darwin 25）。 */
export const PARADIS_SPEECH_MIN_DARWIN_MAJOR = 25;

/** この機械で Para の音声入力が使えるか。使えないときはその理由。 */
export type ParadisSpeechEngineAvailability = 'available' | 'macOSTooOld' | 'unsupportedPlatform';

/** 機械の種類と OS の版（Darwin のカーネルの版。例 `25.0.0`）から、Para の音声入力が使えるか。 */
export function paradisSpeechEngineAvailability(platform: string, osRelease: string): ParadisSpeechEngineAvailability {
	if (platform !== 'darwin') {
		return 'unsupportedPlatform';
	}
	const major = Number.parseInt(osRelease.split('.')[0], 10);
	return Number.isFinite(major) && major >= PARADIS_SPEECH_MIN_DARWIN_MAJOR ? 'available' : 'macOSTooOld';
}

/** 使えないときの案内の文。使えるなら undefined。 */
export function paradisSpeechEngineUnavailableMessage(availability: ParadisSpeechEngineAvailability): string | undefined {
	switch (availability) {
		case 'available':
			return undefined;
		case 'macOSTooOld':
			return localize('paradisSpeech.macOSTooOld', "音声入力は macOS 26 以降の Mac で使えます。この Mac の macOS では使えません。");
		case 'unsupportedPlatform':
			return localize('paradisSpeech.unsupportedPlatform', "音声入力はいまは macOS 26 以降の Mac だけで使えます。Windows・Linux は今後の更新で対応します。");
	}
}

/**
 * 認識の失敗の種類（upstream の `ILocalTranscriptionModelStatus.errorCode` に入れる）。
 * upstream は `network` と `notFound` のときだけ Foundry のモデルの取り込み（Q92 で断った部品）へ誘導するので、
 * その 2 つとは別の値にする。
 */
export const enum ParadisSpeechErrorCode {
	/** この OS では使えない。 */
	Unsupported = 'paradisUnsupported',
	/** 補助プログラムが配布物に入っていない。 */
	HelperMissing = 'paradisHelperMissing',
	/** 話す言語に対応していない。 */
	Locale = 'paradisLocale',
	/** 言語の資源（OS が落とすもの）を用意できなかった。 */
	Assets = 'paradisAssets',
	/** 音声の形式を変換できなかった。 */
	Audio = 'paradisAudio',
	/** 補助プログラムが途中で終わった・それ以外の失敗。 */
	Failed = 'paradisFailed',
}

/** 補助プログラムが標準出力に書く 1 行。 */
export type IParadisSpeechHelperMessage =
	| { readonly type: 'status'; readonly state: 'downloading' | 'loading'; readonly progress?: number }
	| { readonly type: 'ready'; readonly locale: string; readonly transcriber?: string }
	| { readonly type: 'text'; readonly committed: string; readonly tentative: string }
	| { readonly type: 'final'; readonly text: string }
	| { readonly type: 'error'; readonly code: string; readonly message?: string };

/** 補助プログラムの 1 行を読む。形が違えば undefined（読み飛ばす）。 */
export function paradisParseSpeechHelperLine(line: string): IParadisSpeechHelperMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const text = (key: string): string | undefined => typeof record[key] === 'string' ? record[key] as string : undefined;
	switch (record.type) {
		case 'status': {
			if (record.state !== 'downloading' && record.state !== 'loading') {
				return undefined;
			}
			const progress = typeof record.progress === 'number' && Number.isFinite(record.progress) ? Math.max(0, Math.min(1, record.progress)) : undefined;
			return progress === undefined ? { type: 'status', state: record.state } : { type: 'status', state: record.state, progress };
		}
		case 'ready': {
			const locale = text('locale');
			return locale === undefined ? undefined : { type: 'ready', locale, transcriber: text('transcriber') };
		}
		case 'text': {
			const committed = text('committed');
			const tentative = text('tentative');
			return committed === undefined || tentative === undefined ? undefined : { type: 'text', committed, tentative };
		}
		case 'final': {
			const final = text('text');
			return final === undefined ? undefined : { type: 'final', text: final };
		}
		case 'error': {
			const code = text('code');
			return code === undefined ? undefined : { type: 'error', code, message: text('message') };
		}
		default:
			return undefined;
	}
}

/** 補助プログラムの失敗の種類を {@link ParadisSpeechErrorCode} に寄せる。 */
export function paradisSpeechErrorCode(helperCode: string): ParadisSpeechErrorCode {
	switch (helperCode) {
		case 'unsupported': return ParadisSpeechErrorCode.Unsupported;
		case 'locale': return ParadisSpeechErrorCode.Locale;
		case 'assets': return ParadisSpeechErrorCode.Assets;
		case 'audio': return ParadisSpeechErrorCode.Audio;
		default: return ParadisSpeechErrorCode.Failed;
	}
}

/** 失敗を利用者に見せる文（upstream の「On-device speech-to-text model failed to load: {0}」の {0} に入る）。 */
export function paradisSpeechErrorMessage(code: ParadisSpeechErrorCode, detail?: string): string {
	switch (code) {
		case ParadisSpeechErrorCode.Unsupported:
			return localize('paradisSpeech.error.unsupported', "この Mac では macOS の音声認識を使えません。");
		case ParadisSpeechErrorCode.HelperMissing:
			return localize('paradisSpeech.error.helperMissing', "音声認識の補助プログラムがこの Para Code に入っていません。");
		case ParadisSpeechErrorCode.Locale:
			return localize('paradisSpeech.error.locale', "macOS の音声認識がこの言語に対応していません。");
		case ParadisSpeechErrorCode.Assets:
			return detail
				? localize('paradisSpeech.error.assetsDetail', "macOS の音声認識の言語データを用意できませんでした（{0}）。", detail)
				: localize('paradisSpeech.error.assets', "macOS の音声認識の言語データを用意できませんでした。");
		case ParadisSpeechErrorCode.Audio:
			return localize('paradisSpeech.error.audio', "マイクの音声を音声認識に渡せませんでした。");
		case ParadisSpeechErrorCode.Failed:
			return detail
				? localize('paradisSpeech.error.failedDetail', "音声認識が止まりました（{0}）。", detail)
				: localize('paradisSpeech.error.failed', "音声認識が止まりました。");
	}
}

/**
 * upstream の `language`（`ja-JP` などの BCP 47 か `auto`）を、補助プログラムの `--locale` に渡す値にする。
 * SpeechTranscriber には言語の自動判定が無いので、`auto` と空は OS の言語に任せる（補助プログラムが決める）。
 */
export function paradisSpeechHelperLocale(language: string | undefined): string {
	const value = language?.trim();
	return value && value.toLowerCase() !== 'auto' ? value : 'auto';
}

/** utility process の中の認識エンジン（renderer は IPC で呼ぶ）。upstream の口のうち、Para が使う分だけ。 */
export interface IParadisSpeechEngine {
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus>;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult>;
	getModelStatus(): Promise<ILocalTranscriptionModelStatus>;
	/** 補助プログラムを起動して、新しい書き起こしを始める。準備（言語データのダウンロード）は待たずに返る。 */
	start(options: { readonly locale: string }): Promise<void>;
	pushAudio(chunk: VSBuffer): Promise<void>;
	/** 話し終わり。最後の文で終わる。 */
	stop(): Promise<string>;
	/** 書き起こしを捨てて止める。 */
	cancel(): Promise<void>;
}
