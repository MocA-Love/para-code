/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 名前付きブラウザプロファイルの台帳スキーマと、その純粋操作。
//
// 台帳は「表示名・色・時刻」だけを持つ。ログイン状態そのものは Chromium の persist:
// パーティション側にあり、ここには一切写さない（写すと二重の真実になり、片方だけ消える）。
// 名前の一致判定は MCP の `open_browser_profile("TEST")` からも使う。エージェントが送って
// くる名前は全角/半角や大小文字が揺れるので、NFKC 正規化 + caseless で突き合わせる。

import { paradisIsValidProfileId } from './paradisBrowserProfileId.js';

/** 台帳1件。 */
export interface IParadisBrowserProfile {
	/** 不透明な生成ID（12hex）。パーティション名の素になる。リネームしても変わらない。 */
	readonly id: string;
	/** ユーザーが付けた表示名。 */
	readonly name: string;
	/** 識別カラー（{@link PARADIS_BROWSER_PROFILE_COLORS} のいずれか）。 */
	readonly color: string;
	/** 作成時刻（epoch ms）。 */
	readonly createdAt: number;
	/** 最後にこのプロファイルでページを開いた時刻（epoch ms）。 */
	readonly lastUsedAt: number;
}

/**
 * 識別カラーの選択肢。承認済みモック（2-3.html）の6色をそのまま使う。
 * ここだけはテーマトークンではなく実データ（ユーザーが選んだ値）なので固定値でよい。
 */
export const PARADIS_BROWSER_PROFILE_COLORS: readonly string[] = [
	'#e2a33d',
	'#3fb950',
	'#a371f7',
	'#4daafc',
	'#f47067',
	'#8b8b8b',
];

/** 表示名の最大長（文字数）。 */
export const PARADIS_BROWSER_PROFILE_NAME_MAX_LENGTH = 64;

/**
 * 表示名を正規化する。前後の空白を落とし、連続空白（改行・タブを含む）を1つに畳み、
 * 64文字で切る。サロゲートペアの途中で割らないよう文字単位で数える。
 */
export function paradisNormalizeProfileName(name: string): string {
	const flattened = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
	const characters = Array.from(flattened);
	return characters.length > PARADIS_BROWSER_PROFILE_NAME_MAX_LENGTH
		? characters.slice(0, PARADIS_BROWSER_PROFILE_NAME_MAX_LENGTH).join('')
		: flattened;
}

/**
 * 名前の突き合わせキー。NFKC で全角/半角を寄せ、caseless にする。
 * 「TEST」「test」「ＴＥＳＴ」を同じものとして扱うため。
 */
export function paradisProfileNameKey(name: string): string {
	return paradisNormalizeProfileName(name).normalize('NFKC').toLowerCase();
}

/** 表示名でプロファイルを引く（MCP の `open_browser_profile` 用）。 */
export function paradisFindProfileByName(
	profiles: readonly IParadisBrowserProfile[],
	name: string,
): IParadisBrowserProfile | undefined {
	const key = paradisProfileNameKey(name);
	if (key.length === 0) {
		return undefined;
	}
	return profiles.find(profile => paradisProfileNameKey(profile.name) === key);
}

/** 同じ名前が既にあるか（`exceptId` はリネーム対象自身を除外するため）。 */
export function paradisIsDuplicateProfileName(
	profiles: readonly IParadisBrowserProfile[],
	name: string,
	exceptId?: string,
): boolean {
	const key = paradisProfileNameKey(name);
	return profiles.some(profile => profile.id !== exceptId && paradisProfileNameKey(profile.name) === key);
}

/** 台帳をストレージへ書く形にする。 */
export function paradisSerializeProfiles(profiles: readonly IParadisBrowserProfile[]): string {
	return JSON.stringify(profiles);
}

/**
 * 台帳を読み戻す。壊れた JSON・想定外の形は「空の台帳」として扱う。
 * ここで throw するとブラウザのナビバー全体が描けなくなるため、静かに縮退させる
 * （プロファイルが見えなくなるだけで、パーティション自体は消えない）。
 */
export function paradisDeserializeProfiles(raw: string | undefined): IParadisBrowserProfile[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const profiles: IParadisBrowserProfile[] = [];
	const seen = new Set<string>();
	for (const entry of parsed) {
		const profile = paradisReviveProfile(entry);
		if (profile && !seen.has(profile.id)) {
			seen.add(profile.id);
			profiles.push(profile);
		}
	}
	return profiles;
}

function paradisReviveProfile(entry: unknown): IParadisBrowserProfile | undefined {
	if (typeof entry !== 'object' || entry === null) {
		return undefined;
	}
	const candidate = entry as Partial<IParadisBrowserProfile>;
	if (!paradisIsValidProfileId(candidate.id)) {
		return undefined;
	}
	const name = typeof candidate.name === 'string' ? paradisNormalizeProfileName(candidate.name) : '';
	if (name.length === 0) {
		return undefined;
	}
	const color = typeof candidate.color === 'string' && candidate.color.length > 0
		? candidate.color
		: PARADIS_BROWSER_PROFILE_COLORS[0];
	const createdAt = typeof candidate.createdAt === 'number' && isFinite(candidate.createdAt) ? candidate.createdAt : 0;
	const lastUsedAt = typeof candidate.lastUsedAt === 'number' && isFinite(candidate.lastUsedAt) ? candidate.lastUsedAt : createdAt;
	return { id: candidate.id, name, color, createdAt, lastUsedAt };
}
