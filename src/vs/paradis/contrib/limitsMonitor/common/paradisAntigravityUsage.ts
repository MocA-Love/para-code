/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `agy -p "/usage" --output-format json` の出力を、使用量パネルの枠へ読み替える純関数。
// 取りに行く側は node/paradisAntigravityUsage.ts。
//
// 出力（agy 1.5.6 で実測）は1つの JSON で、`command.data.groups[].buckets[]` に枠が入る:
//   { "status": "SUCCESS", "command": { "name": "usage", "data": { "groups": [
//     { "name": "Gemini Models", "buckets": [{ "id": "gemini-weekly", "window": "weekly",
//       "remaining_fraction": 0.91, "reset_time": "2026-11-18T16:44:24Z" }] }, ... ] } } }
// `response` のタブ区切りの文は人が読む用なので使わない。0 や空の値は項目ごと省かれる（実測で
// `description` が無い bucket があった）ので、`remaining_fraction` が無くリセットの時刻だけある枠は
// 使い切った（残り 0）とみなす。

import { localize } from '../../../../nls.js';
import { IParadisLimitsWindow } from './paradisLimitsMonitor.js';

interface IAntigravityUsageBucket {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly window?: unknown;
	readonly remaining_fraction?: unknown;
	readonly reset_time?: unknown;
	readonly disabled?: unknown;
}

interface IAntigravityUsageGroup {
	readonly name?: unknown;
	readonly buckets?: unknown;
}

interface IAntigravityUsageOutput {
	readonly status?: unknown;
	readonly error?: unknown;
	readonly command?: { readonly name?: unknown; readonly data?: { readonly groups?: unknown } };
}

export type ParadisAntigravityUsageResult =
	| { readonly kind: 'ok'; readonly windows: readonly IParadisLimitsWindow[] }
	/** サインインしていない（agy がログインの URL を出して待った）。 */
	| { readonly kind: 'signed_out' }
	| { readonly kind: 'error'; readonly detail: string };

/** agy がログインを求めたときに stderr へ出す文。これが出たら、待たずに止める。 */
const SIGN_IN_PROMPT = /Authentication required/i;

/** agy の出力（stdout と stderr）がログインを求めているか。 */
export function paradisAntigravityNeedsSignIn(stdout: string, stderr: string): boolean {
	return SIGN_IN_PROMPT.test(stderr) || SIGN_IN_PROMPT.test(stdout);
}

/** 枠の名前。知っている bucket は短い名前に、知らないものはグループ名のまま出す。 */
function bucketLabel(bucket: IAntigravityUsageBucket, group: IAntigravityUsageGroup): string {
	switch (bucket.id) {
		case 'gemini-weekly':
			return localize('paradis.limitsMonitor.antigravityGemini', "Gemini");
		case '3p-weekly':
			return localize('paradis.limitsMonitor.antigravityThirdParty', "Claude・GPT");
	}
	if (typeof group.name === 'string' && group.name.trim().length > 0) {
		return group.name.trim();
	}
	return typeof bucket.name === 'string' && bucket.name.trim().length > 0 ? bucket.name.trim() : '?';
}

function parseWindow(bucket: IAntigravityUsageBucket, group: IAntigravityUsageGroup): IParadisLimitsWindow | undefined {
	if (bucket.disabled === true) {
		return undefined;
	}
	const resetsAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
	let remaining: number;
	if (typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)) {
		remaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
	} else if (Number.isFinite(resetsAt)) {
		// 0 は項目ごと省かれる（上の説明）。
		remaining = 0;
	} else {
		return undefined;
	}
	const usedPercent = Math.round((1 - remaining) * 1000) / 10;
	return {
		usedPercent,
		label: bucketLabel(bucket, group),
		...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
	};
}

/** 出力の中の JSON（1行の JSON の前後に別の行が混じっても読む）。 */
function parseOutputJson(stdout: string): IAntigravityUsageOutput | undefined {
	const candidates = [stdout.trim(), ...stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{')).reverse()];
	for (const candidate of candidates) {
		if (candidate.length === 0) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(candidate);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return value as IAntigravityUsageOutput;
			}
		} catch {
			// 次の候補へ
		}
	}
	return undefined;
}

/**
 * `agy -p "/usage" --output-format json` の出力を読む。
 *
 * @param stdout agy の標準出力
 * @param stderr agy の標準エラー（ログインを求めているかを見るだけ）
 */
export function paradisParseAntigravityUsage(stdout: string, stderr: string): ParadisAntigravityUsageResult {
	const output = parseOutputJson(stdout);
	// 取れた値を先に見る（ログインの文が混じっていても、値が出ていればそれを使う）。
	if (output?.status !== 'SUCCESS' && paradisAntigravityNeedsSignIn(stdout, stderr)) {
		return { kind: 'signed_out' };
	}
	if (!output) {
		return { kind: 'error', detail: 'agy did not print JSON for /usage' };
	}
	if (output.status !== 'SUCCESS') {
		const error = typeof output.error === 'string' ? output.error : '';
		if (/authentication/i.test(error)) {
			return { kind: 'signed_out' };
		}
		return { kind: 'error', detail: error.length > 0 ? `agy /usage failed: ${error}` : 'agy /usage failed' };
	}
	if (output.command?.name !== 'usage' || !Array.isArray(output.command.data?.groups)) {
		return { kind: 'error', detail: 'agy /usage printed an unexpected shape' };
	}
	const windows: IParadisLimitsWindow[] = [];
	for (const group of output.command.data.groups as readonly IAntigravityUsageGroup[]) {
		if (!group || typeof group !== 'object' || !Array.isArray(group.buckets)) {
			continue;
		}
		for (const bucket of group.buckets as readonly IAntigravityUsageBucket[]) {
			if (!bucket || typeof bucket !== 'object') {
				continue;
			}
			const window = parseWindow(bucket, group);
			if (window) {
				windows.push(window);
			}
		}
	}
	return { kind: 'ok', windows };
}
