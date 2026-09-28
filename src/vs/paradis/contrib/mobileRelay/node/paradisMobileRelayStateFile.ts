/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイル連携の鍵とペアリング台帳（userData の `paradis-mobile-relay.json`）の読み書き。
//
// 以前は読めない・壊れている・復号できないときに空の台帳と新しい鍵で黙って上書きしていたので、
// キーチェーンの一時的な拒否や書き込み途中のクラッシュだけで全スマホのペアリングが一度に外れた。
// ここでは「まだ無い（初回）」と「あるのに読めない」を分け、読めないファイルは上書きしない。

import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';

export interface IParadisRelayPairedMobile {
	readonly mobileId: string;
	readonly name: string;
	/** モバイルの長期公開鍵（base64url）。データ接続時のハンドシェイク相手鍵。 */
	readonly pubKey: string;
	/**
	 * モバイルの通知設定（アプリの設定画面から notify チャネルで同期される）。
	 * どれも「バナーを出さない」だけで、通知一覧へは常に届ける（`paradisNotifyDelivery.ts`）。
	 *
	 * `pcFocusQuiet` が「PC操作中は鳴らさない」。旧キー `suppressWhenPcFocused` を使い回さないのは、
	 * 旧いPara Codeがそのキーを「配信そのものを止める」と解釈するため。ディスクに旧キーで true を
	 * 残すと、PCを旧版へ巻き戻したときにその解釈が復活し、PCフォーカス中の通知がAPNsも含めて
	 * 捨てられる。旧キーは**書かず**、旧アプリから受け取ったときの読み取りだけに使う。
	 */
	notifyPrefs?: { agentDone?: boolean; agentQuestion?: boolean; pcFocusQuiet?: boolean; suppressWhenPcFocused?: boolean };
}

export interface IParadisRelayPersistedState {
	// encSecret: safeStorageで暗号化したpkcs8秘密鍵。pkcs8: 平文(旧形式/暗号化不可環境のフォールバック)。
	identity?: { pubKey: string; encSecret?: string; pkcs8?: string };
	device?: { deviceId: string; pcToken: string };
	mobiles: IParadisRelayPairedMobile[];
	/**
	 * リレーへの取り消しを待っているスマホ（W2-35。`paradisRelayRevokeOutbox.ts`）。読むときは
	 * `paradisSanitizeRevokeOutbox` で検証する（旧版の台帳には無い）。
	 */
	pendingRelayRevokes?: readonly unknown[];
}

/**
 * 保存した鍵と台帳を読めなかった理由。
 * - `unreadable`: ファイルはあるが読めない（権限・I/O）。一時的なこともあるので残したまま止める
 * - `corrupt`: JSON として壊れている／形が違う。退避してから、新しく作り直せる状態にする
 * - `undecryptable`: 台帳は読めたが鍵を復号できない（キーチェーンの拒否など）。残したまま止める
 */
export type ParadisRelayStoreProblem = 'unreadable' | 'corrupt' | 'undecryptable';

export type ParadisRelayStateReadResult =
	| { readonly kind: 'missing' }
	| { readonly kind: 'unreadable'; readonly error: unknown }
	| { readonly kind: 'corrupt' }
	| { readonly kind: 'ok'; readonly state: IParadisRelayPersistedState };

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 台帳の JSON を読み、形を確かめる。形が違えば undefined（壊れているとみなす）。
 * 余分な項目は捨てずに残す（新しい版が足した項目を、古い版の保存で消さないため）。
 */
export function paradisParseRelayState(raw: string): IParadisRelayPersistedState | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) {
		return undefined;
	}
	const mobiles = parsed.mobiles ?? [];
	if (!Array.isArray(mobiles) || !mobiles.every(mobile => isRecord(mobile) && isString(mobile.mobileId) && isString(mobile.name) && isString(mobile.pubKey))) {
		return undefined;
	}
	const device = parsed.device;
	if (device !== undefined && !(isRecord(device) && isString(device.deviceId) && isString(device.pcToken))) {
		return undefined;
	}
	const identity = parsed.identity;
	if (identity !== undefined && !(isRecord(identity) && isString(identity.pubKey)
		&& (identity.encSecret === undefined || isString(identity.encSecret))
		&& (identity.pkcs8 === undefined || isString(identity.pkcs8)))) {
		return undefined;
	}
	return { ...parsed, mobiles: mobiles as IParadisRelayPairedMobile[], device: device as IParadisRelayPersistedState['device'], identity: identity as IParadisRelayPersistedState['identity'] };
}

/** 台帳を読む。「まだ無い」「読めない」「壊れている」を分けて返す。 */
export async function paradisReadRelayState(filePath: string): Promise<ParadisRelayStateReadResult> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
			return { kind: 'missing' };
		}
		return { kind: 'unreadable', error };
	}
	const state = paradisParseRelayState(raw);
	return state ? { kind: 'ok', state } : { kind: 'corrupt' };
}

/** 退避先の名前。日時はファイル名に使えない `:` と `.` を落とす。 */
export function paradisRelayStateAsidePath(filePath: string, problem: ParadisRelayStoreProblem, now: Date): string {
	return `${filePath}.${problem}-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/** 退避したファイルを残す数。古いものから消す（読めない状態が繰り返されても増え続けないように）。 */
export const PARADIS_RELAY_STATE_ASIDE_KEEP = 3;

/**
 * 読めなかった台帳を日時付きの名前へ移す（消さない。キーチェーンが戻れば手で戻せるように）。
 * 移せたら退避先を返す。元のファイルがもう無い（別の読み込みが先に退避した）なら undefined で、
 * 呼び出し側は「無い」と同じに扱う。そのほかの理由で移せなければ投げる（上書きを諦める）。
 */
export async function paradisMoveRelayStateAside(filePath: string, problem: ParadisRelayStoreProblem, now: Date = new Date()): Promise<string | undefined> {
	const aside = paradisRelayStateAsidePath(filePath, problem, now);
	try {
		await fs.rename(filePath, aside);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	await paradisPruneRelayStateLeftovers(filePath).catch(() => undefined);
	return aside;
}

/**
 * 退避したファイルは新しい {@link PARADIS_RELAY_STATE_ASIDE_KEEP} 個だけ残し、書きかけで残った
 * 一時ファイル（`paradisWriteFileAtomic` の `.<名前>.paradis-*.tmp`）は消す。書き込みの最中に
 * 呼ばないこと（呼び出し側が読み書きを1本に並べている間に呼ぶ）。
 */
export async function paradisPruneRelayStateLeftovers(filePath: string, keep: number = PARADIS_RELAY_STATE_ASIDE_KEEP): Promise<void> {
	const directory = dirname(filePath);
	const name = basename(filePath);
	const entries = await fs.readdir(directory);
	const asidePattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:corrupt|unreadable|undecryptable)-(?<time>.+)$`);
	const temporaryPrefix = `.${name}.paradis-`;
	// 並べるのは名前の日時で（rename は元のファイルの更新時刻を保つので、更新時刻では退避の順にならない）
	const asides: { readonly path: string; readonly time: string }[] = [];
	for (const entry of entries) {
		const path = join(directory, entry);
		const time = asidePattern.exec(entry)?.groups?.time;
		if (entry.startsWith(temporaryPrefix) && entry.endsWith('.tmp')) {
			await fs.rm(path, { force: true });
		} else if (time !== undefined) {
			asides.push({ path, time });
		}
	}
	asides.sort((a, b) => b.time.localeCompare(a.time));
	for (const old of asides.slice(keep)) {
		await fs.rm(old.path, { force: true });
	}
}

/**
 * 台帳を原子的に書く（一時ファイルへ書いて fsync し、rename で置き換える）。書きかけで落ちても
 * 前の台帳が残る。秘密鍵を含むので権限は常に 0600、symlink は辿らず、置き換えられなければ
 * その場へ書かずに失敗させる。
 */
export async function paradisWriteRelayState(filePath: string, state: IParadisRelayPersistedState): Promise<void> {
	await paradisWriteFileAtomic(filePath, JSON.stringify(state), { forceMode: 0o600, rejectSymlink: true, fallbackToInPlace: false });
}
