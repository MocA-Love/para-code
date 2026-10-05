/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げに設定した辞書を、エージェントの読み上げ（aivis-mcp）にも使わせるための共有定義と判定。
// 実行は shared process（手元）と REH サーバー（SSH の接続先）の node 側（node/paradisAgentDictionarySync.ts）。
//
// aivis-mcp 2.5.3 の取り決め:
//   aivis-mcp --set-dictionary --provider elevenlabs --id <dictionary_id> [--version-id <version_id>]
//   aivis-mcp --set-dictionary --provider aivis --id <uuid>
//   aivis-mcp --clear-dictionary --provider elevenlabs|aivis
// 成功は標準出力に `ok` の 1 行で終了 0。失敗は標準エラーに `error: <理由>` で終了 1（設定は書き換えない）。
// 2.5.2 以下は知らない引数で別の動作をするおそれがあるので、版を確かめてから呼ぶ。
//
// aivis-mcp 側の辞書は、利用者が `tts-configure` などで別のものを選んでいることがある。Para Code が
// 消してよいのは、Para Code が書いた値がそのまま残っているときだけ（最後に書いた値を覚えておく）。

export const PARADIS_AGENT_DICTIONARY_CHANNEL = 'paradisAgentDictionary';

/** `--set-dictionary` / `--clear-dictionary` を持つ aivis-mcp の版。 */
export const PARADIS_AGENT_DICTIONARY_MIN_VERSION: readonly [number, number, number] = [2, 5, 3];

export type ParadisAgentDictionaryProvider = 'elevenlabs' | 'aivis';

export const PARADIS_AGENT_DICTIONARY_PROVIDERS: readonly ParadisAgentDictionaryProvider[] = ['elevenlabs', 'aivis'];

/** 辞書の ID（空文字は「辞書なし」）を読み上げのエンジンごとに持つ。 */
export type IParadisAgentDictionaryIds = Readonly<Record<ParadisAgentDictionaryProvider, string>>;

/** ウィンドウから node 側へ渡す、いまの設定。 */
export interface IParadisAgentDictionaryRequest {
	/** 「通知と同じ辞書をエージェントの読み上げにも使う」。 */
	readonly enabled: boolean;
	readonly dictionaries: IParadisAgentDictionaryIds;
}

/** Para Code が最後に aivis-mcp へ書いた辞書。書いていない（消した）エンジンは持たない。 */
export type IParadisAgentDictionaryWritten = Partial<Record<ParadisAgentDictionaryProvider, string>>;

/** aivis-mcp の設定に今入っている辞書。読めなければ undefined。 */
export type IParadisAgentDictionaryCurrent = Partial<Record<ParadisAgentDictionaryProvider, string>>;

export type ParadisAgentDictionaryStep =
	| { readonly kind: 'set'; readonly provider: ParadisAgentDictionaryProvider; readonly id: string }
	| { readonly kind: 'clear'; readonly provider: ParadisAgentDictionaryProvider }
	/** 書いた値が aivis-mcp 側でもう別のものに変わっていた。消さずに、覚えている値だけ忘れる。 */
	| { readonly kind: 'forget'; readonly provider: ParadisAgentDictionaryProvider };

export type ParadisAgentDictionarySyncStatus =
	/** すること無し（同じ値・消す必要が無い）。 */
	| 'unchanged'
	/** 書いた・消した。 */
	| 'applied'
	/** aivis-mcp が無い・2.5.3 より古い。何もしていない。 */
	| 'unsupported'
	/** 一部か全部が失敗した。 */
	| 'failed';

export interface IParadisAgentDictionarySyncResult {
	readonly status: ParadisAgentDictionarySyncStatus;
}

const ELEVENLABS_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** aivis-mcp が受け付ける ID の形か（ElevenLabs は英数字と `-` `_`、Aivis は UUID）。 */
export function paradisIsAgentDictionaryId(provider: ParadisAgentDictionaryProvider, id: string): boolean {
	return provider === 'aivis' ? UUID.test(id) : ELEVENLABS_ID.test(id);
}

/** 通知の読み上げの設定（`IParadisAivisSettings` の一部）から、aivis-mcp へ渡す設定を作る。 */
export function paradisAgentDictionaryRequestFromSettings(settings: { readonly shareDictionaryWithAgents?: boolean; readonly userDictionaryUuid?: string; readonly elevenLabsDictionaryId?: string }): IParadisAgentDictionaryRequest {
	return {
		enabled: settings.shareDictionaryWithAgents !== false,
		dictionaries: {
			elevenlabs: settings.elevenLabsDictionaryId || '',
			aivis: settings.userDictionaryUuid || '',
		},
	};
}

/** IPC 越しの値を、形の分かる要求に直す。壊れた値は「辞書なし」にする。 */
export function paradisNormalizeAgentDictionaryRequest(raw: unknown): IParadisAgentDictionaryRequest {
	const value = (raw && typeof raw === 'object' ? raw : {}) as { enabled?: unknown; dictionaries?: unknown };
	const dictionaries = (value.dictionaries && typeof value.dictionaries === 'object' ? value.dictionaries : {}) as Record<string, unknown>;
	const pick = (provider: ParadisAgentDictionaryProvider): string => {
		const id = dictionaries[provider];
		return typeof id === 'string' ? id.trim() : '';
	};
	return {
		enabled: value.enabled === true,
		dictionaries: { elevenlabs: pick('elevenlabs'), aivis: pick('aivis') },
	};
}

/**
 * 1 つのエンジンについて、aivis-mcp へ何をするかを決める。
 *
 * - 使う設定で辞書がある: Para Code が前回書いた値と同じ、または aivis-mcp に既に入っているなら何もしない。
 *   前回書いた値と同じなのに aivis-mcp 側で変わっていたら、利用者が変えたものとして上書きしない
 * - 使わない設定か、辞書が無い: Para Code が書いた値がそのまま残っているときだけ消す。別の値に
 *   変わっていたら消さずに、覚えている値を忘れる。aivis-mcp の設定が読めなければ何もしない
 */
export function paradisPlanAgentDictionaryStep(
	provider: ParadisAgentDictionaryProvider,
	request: IParadisAgentDictionaryRequest,
	written: IParadisAgentDictionaryWritten,
	current: IParadisAgentDictionaryCurrent | undefined,
): ParadisAgentDictionaryStep | undefined {
	const desired = request.enabled ? request.dictionaries[provider] : '';
	const last = written[provider];
	const now = current?.[provider];
	if (desired) {
		if (!paradisIsAgentDictionaryId(provider, desired) || desired === last || desired === now) {
			return undefined;
		}
		return { kind: 'set', provider, id: desired };
	}
	// aivis-mcp の設定が読めないとき（壊れている・読み途中）は、消すか忘れるかを決められないので覚えたままにする
	if (!last || current === undefined) {
		return undefined;
	}
	return now === last ? { kind: 'clear', provider } : { kind: 'forget', provider };
}

/** すべてのエンジンについての手順。 */
export function paradisPlanAgentDictionarySteps(
	request: IParadisAgentDictionaryRequest,
	written: IParadisAgentDictionaryWritten,
	current: IParadisAgentDictionaryCurrent | undefined,
): ParadisAgentDictionaryStep[] {
	const steps: ParadisAgentDictionaryStep[] = [];
	for (const provider of PARADIS_AGENT_DICTIONARY_PROVIDERS) {
		const step = paradisPlanAgentDictionaryStep(provider, request, written, current);
		if (step) {
			steps.push(step);
		}
	}
	return steps;
}

/**
 * aivis-mcp へ渡す引数。`forget` は aivis-mcp を呼ばないので undefined。
 * ElevenLabs の版（`--version-id`）は付けない（通知と同じく、合成のたびに最新の版を使わせる）。
 */
export function paradisAgentDictionaryArgs(step: ParadisAgentDictionaryStep): string[] | undefined {
	switch (step.kind) {
		case 'set':
			return paradisIsAgentDictionaryId(step.provider, step.id)
				? ['--set-dictionary', '--provider', step.provider, '--id', step.id]
				: undefined;
		case 'clear':
			return ['--clear-dictionary', '--provider', step.provider];
		case 'forget':
			return undefined;
	}
}

/** aivis-mcp の `config.json` から、今の辞書を読む（`elevenlabs.pronunciationDictionaryId`・`aivis.userDictionaryUuid`）。 */
export function paradisAgentDictionaryFromConfig(config: unknown): IParadisAgentDictionaryCurrent {
	const section = (key: string): Record<string, unknown> => {
		const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined;
		return value && typeof value === 'object' ? value as Record<string, unknown> : {};
	};
	const result: { -readonly [K in ParadisAgentDictionaryProvider]?: string } = {};
	const elevenlabs = section('elevenlabs').pronunciationDictionaryId;
	if (typeof elevenlabs === 'string' && elevenlabs) {
		result.elevenlabs = elevenlabs;
	}
	const aivis = section('aivis').userDictionaryUuid;
	if (typeof aivis === 'string' && aivis) {
		result.aivis = aivis;
	}
	return result;
}

/** 手順を当てた後の「最後に書いた値」。 */
export function paradisApplyAgentDictionaryStep(written: IParadisAgentDictionaryWritten, step: ParadisAgentDictionaryStep): IParadisAgentDictionaryWritten {
	const next: { -readonly [K in ParadisAgentDictionaryProvider]?: string } = { ...written };
	if (step.kind === 'set') {
		next[step.provider] = step.id;
	} else {
		delete next[step.provider];
	}
	return next;
}
