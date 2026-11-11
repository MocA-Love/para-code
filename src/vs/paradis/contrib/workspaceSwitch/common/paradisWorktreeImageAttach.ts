/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース」の指示に添える画像（Q615）の決まりごと。ダイアログ・作成の流れ・起動コマンドの組み立てが同じ値を使う。

import { VSBuffer } from '../../../../base/common/buffer.js';

/** 添えられる枚数の上限。 */
export const PARADIS_WORKTREE_IMAGE_MAX_COUNT = 8;
/** 1 枚の大きさの上限（10 MB）。 */
export const PARADIS_WORKTREE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 添えられる形式。ターミナルに画像を貼るときの判定（png・jpeg・gif・webp）と同じ。 */
export type ParadisWorktreeImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const EXTENSION_BY_MIME: { readonly [mime in ParadisWorktreeImageMime]: string } = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
};

const MIME_BY_EXTENSION: ReadonlyMap<string, ParadisWorktreeImageMime> = new Map<string, ParadisWorktreeImageMime>([
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
]);

/** ダイアログで添えた画像。作成の要求に載せて、スペースを作った後にファイルへ書く。 */
export interface IParadisWorktreeImage {
	/** 利用者が見る名前（元のファイル名。⌘V のときは決まった名前）。 */
	readonly name: string;
	readonly mime: ParadisWorktreeImageMime;
	readonly data: VSBuffer;
}

/**
 * エージェントへの画像の渡し方（2026-11-12 に本物の CLI で確かめた結果）。
 * - `mention`: 指示の後ろに `@パス` を足す。Claude Code 2.1.322 は起動時の指示の `@パス` を読み、最初の要求に
 *   画像として載せる（`@` の無いパスはただの文字のまま送られ、画像にならない）。
 * - `flag`: `--image=<パス>,<パス>` を付ける。Codex 0.167.0 はカンマ区切りの複数を受け、TUI でも exec でも
 *   最初の要求に全部載せる。指示が空でも画像だけで始まる。
 * - `unsupported`: 渡せない。Gemini CLI 0.68.0 は `@パス` も read_file も git が無視するファイルを読まない
 *   （画像の置き場所は `.gitignore` で無視させている）。TUI には画像の札が出るのに要求には入らないので、添えさせない。
 */
export type ParadisAgentImageMode = 'mention' | 'flag' | 'unsupported';

const IMAGE_MODES: readonly ParadisAgentImageMode[] = ['mention', 'flag', 'unsupported'];

/** 画像の渡し方を決めるのに要る、エージェント定義の一部。 */
export interface IParadisAgentImageModeSource {
	readonly id: string;
	/** 設定 `paradis.workspaceSwitch.agents` の `images`。設定の値なので、知らない値も来うる。 */
	readonly images?: string;
}

/**
 * エージェント定義から画像の渡し方を決める。定義に `images` があればそれを使う。無ければ、確かめた CLI
 * （id が `claude`・`codex`）だけ渡し、それ以外（Gemini CLI・設定で足したエージェント）は渡さない。
 * `@` を読まない CLI に渡すと、指示の末尾に `@.para-code/…` の文字が残るだけになるため。
 */
export function paradisAgentImageMode(agent: IParadisAgentImageModeSource | undefined): ParadisAgentImageMode {
	if (!agent || agent.id === 'none') {
		return 'unsupported';
	}
	const configured = IMAGE_MODES.find(mode => mode === agent.images);
	if (configured) {
		return configured;
	}
	switch (agent.id) {
		case 'claude':
			return 'mention';
		case 'codex':
			return 'flag';
		default:
			return 'unsupported';
	}
}

/** ファイルの種類（`File.type`）と名前から形式を決める。添えられない形式なら undefined。 */
export function paradisWorktreeImageMime(type: string, name: string): ParadisWorktreeImageMime | undefined {
	const normalized = type.toLowerCase();
	const known = (Object.keys(EXTENSION_BY_MIME) as ParadisWorktreeImageMime[]).find(mime => mime === normalized);
	if (known) {
		return known;
	}
	if (normalized.length > 0) {
		return undefined;
	}
	// 種類の分からないファイル（OS が種類を付けないもの）は拡張子で見る
	const dot = name.lastIndexOf('.');
	return dot < 0 ? undefined : MIME_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase());
}

/** 添えようとしたファイルの、判定に要る情報。 */
export interface IParadisWorktreeImageCandidate {
	readonly name: string;
	readonly type: string;
	readonly size: number;
}

/** 添えなかった理由。 */
export type ParadisWorktreeImageRejection = 'type' | 'size' | 'count';

export interface IParadisWorktreeImageCheck {
	/** 添えるもの（候補の添字と決まった形式）。 */
	readonly accepted: readonly { readonly index: number; readonly mime: ParadisWorktreeImageMime }[];
	/** 添えなかったもの。 */
	readonly rejected: readonly { readonly index: number; readonly reason: ParadisWorktreeImageRejection }[];
}

/**
 * 添えようとしたファイルを上限に照らして分ける。形式・大きさで外れたものは枚数に数えない。
 * `existingCount` は既に添えてある枚数。
 */
export function paradisCheckWorktreeImages(existingCount: number, candidates: readonly IParadisWorktreeImageCandidate[]): IParadisWorktreeImageCheck {
	const accepted: { index: number; mime: ParadisWorktreeImageMime }[] = [];
	const rejected: { index: number; reason: ParadisWorktreeImageRejection }[] = [];
	candidates.forEach((candidate, index) => {
		const mime = paradisWorktreeImageMime(candidate.type, candidate.name);
		if (!mime) {
			rejected.push({ index, reason: 'type' });
		} else if (candidate.size > PARADIS_WORKTREE_IMAGE_MAX_BYTES) {
			rejected.push({ index, reason: 'size' });
		} else if (existingCount + accepted.length >= PARADIS_WORKTREE_IMAGE_MAX_COUNT) {
			rejected.push({ index, reason: 'count' });
		} else {
			accepted.push({ index, mime });
		}
	});
	return { accepted, rejected };
}

/**
 * スペースに書く画像のファイル名（`<時刻>-<順番>.<拡張子>`、順番は 1 から）。
 * ターミナルに画像を貼る仕組みは「数字だけの名前の .png」を 1 時間で消すので、`-` を挟んでその掃除から外し、
 * スペースを消すまで残す（エージェントを再開したときにも読めるように）。拡張子は中身の形式に合わせる
 * （CLI は拡張子から形式を決めるので、JPEG に .png を付けると API に弾かれうる）。
 */
export function paradisWorktreeImageFileName(time: number, index: number, mime: ParadisWorktreeImageMime): string {
	return `${Math.floor(time)}-${index + 1}.${EXTENSION_BY_MIME[mime]}`;
}

/** 起動コマンドに入れてよいパス（作業フォルダからの相対で、引用を崩す文字を含まない）。 */
export function paradisIsSafeWorktreeImagePath(path: string): boolean {
	return /^[\w.\/-]+$/.test(path) && !path.startsWith('-') && !path.split('/').includes('..');
}
