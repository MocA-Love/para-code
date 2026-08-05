// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ペアリング済みPCの台帳。
 *
 * このアプリは複数のPCとペアリングを保ったまま、見る相手だけを切り替えられる。
 * 「どのPCと繋げるか」（資格情報）と「どのPCをいま見ているか」（アクティブ）をここで持ち、
 * 接続そのものは appState が PC ごとの MobileController に任せる。
 *
 * 端末ローカルの記録（ピン留め・アーカイブ）はPC単位に分けて保存する。ターミナルのキーは
 * UUID由来でPCをまたいでも衝突しないが、分けておくとそのPCとのペアリングを解除したときに
 * 一緒に片付けられる（他のPCの印を巻き添えにしない）。
 */

import { fromBase64Url as fromB64, toBase64Url as toB64 } from '@para/protocol';
import type { PairedCredentials } from './relayClient.js';
import type { KeyStore } from './store.js';

/** 台帳のSecureStoreキー。単一PC時代の `para.credentials` からはここへ移行する。 */
export const PCS_KEY = 'para.pcs';
export const ACTIVE_PC_KEY = 'para.activePc';
export const LEGACY_CREDENTIALS_KEY = 'para.credentials';
/** 一部が読めなかった台帳の退避先（読めた分で上書きする前に、元の中身をここへ残す）。 */
export const BROKEN_PCS_KEY = 'para.pcs.broken';

/** PCから名前が届かない（旧バージョンのPC）ときに使う名前。 */
export const FALLBACK_PC_NAME = 'Para Code';

/**
 * 表示名の上限（PC側 `PARADIS_MOBILE_PC_NAME_MAX_LENGTH` と同値）。
 * PC側の切り詰めを信用せず、受け取る側でも必ず切る。
 */
export const PC_NAME_MAX_LENGTH = 64;

/**
 * PCが名乗った名前・ユーザーが入力した名前を、一覧に出せる形へ整える。
 * 改行や双方向制御文字（U+202E など）を落とすのは、別のPCに化けた名前を見せる
 * なりすましを防ぐため（タブ名スプーフィングと同じ既知の手口）。
 * 表示できる文字が残らなければ undefined を返す。
 */
export function sanitizePcName(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	// 制御文字・ゼロ幅・双方向制御文字を落とす（エスケープ表記で書くこと。生の制御文字を
	// ソースへ埋めるとファイルが壊れる）。
	const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
	return cleaned.length > 0 ? cleaned.slice(0, PC_NAME_MAX_LENGTH) : undefined;
}

export interface PairedPc {
	/** リレー上のPC識別子（deviceId）。台帳とローカル記録のスコープキーを兼ねる。 */
	readonly id: string;
	readonly creds: PairedCredentials;
	/** 一覧に出す名前。 */
	readonly name: string;
	/**
	 * ユーザーが名前を決めたか。true の間はPCから届いた名前で上書きしない
	 * （手で付けた呼び分けを、PC側のホスト名が黙って消さないようにする）。
	 */
	readonly renamed: boolean;
	readonly addedAt: number;
}

interface StoredPc {
	id: string;
	name: string;
	renamed?: boolean;
	addedAt?: number;
	relayUrl: string;
	deviceId: string;
	mobileId: string;
	mobileToken: string;
	pcPublicKey: string;
}

function toStored(pc: PairedPc): StoredPc {
	return {
		id: pc.id,
		name: pc.name,
		renamed: pc.renamed,
		addedAt: pc.addedAt,
		relayUrl: pc.creds.relayUrl,
		deviceId: pc.creds.deviceId,
		mobileId: pc.creds.mobileId,
		mobileToken: pc.creds.mobileToken,
		pcPublicKey: toB64(pc.creds.pcPublicKey),
	};
}

function fromStored(raw: unknown): PairedPc | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const stored = raw as Partial<StoredPc>;
	if (typeof stored.relayUrl !== 'string' || typeof stored.deviceId !== 'string'
		|| typeof stored.mobileId !== 'string' || typeof stored.mobileToken !== 'string'
		|| typeof stored.pcPublicKey !== 'string') {
		return undefined;
	}
	let pcPublicKey: Uint8Array;
	try {
		pcPublicKey = fromB64(stored.pcPublicKey);
	} catch {
		return undefined;
	}
	return {
		// 台帳の id は deviceId と同じだが、古い記録で欠けていても deviceId から埋められる。
		id: typeof stored.id === 'string' && stored.id.length > 0 ? stored.id : stored.deviceId,
		creds: {
			relayUrl: stored.relayUrl,
			deviceId: stored.deviceId,
			mobileId: stored.mobileId,
			mobileToken: stored.mobileToken,
			pcPublicKey,
		},
		name: typeof stored.name === 'string' && stored.name.trim().length > 0 ? stored.name.trim() : FALLBACK_PC_NAME,
		renamed: stored.renamed === true,
		addedAt: typeof stored.addedAt === 'number' && Number.isFinite(stored.addedAt) ? stored.addedAt : 0,
	};
}

/**
 * 台帳を読む。単一PC時代の資格情報しか無ければ、それを1台目として移行した結果を返す
 * （移行したかどうかは `migratedFromSinglePc` で分かる。呼び出し側は保存し直す）。
 */
export async function loadPairedPcs(keyStore: KeyStore): Promise<{ pcs: PairedPc[]; migratedFromSinglePc: boolean; dropped: number }> {
	const raw = await keyStore.getItem(PCS_KEY);
	if (raw) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		const entries = Array.isArray(parsed) ? parsed : [];
		const pcs = entries.map(fromStored).filter((pc): pc is PairedPc => pc !== undefined);
		// 一部だけ壊れていた場合、そのまま保存し直すと健全なぶんまで失う。呼び出し側が
		// 「この起動では台帳を上書きしない」と判断できるよう、落とした件数を返す。
		const dropped = entries.length - pcs.length;
		if (dropped > 0) {
			console.warn(`[pcs] dropped ${dropped} unreadable paired PC entries`);
			// 読めた分だけで保存し直すと、壊れていた行は復旧できなくなる。ペアリングは
			// PC側でQRを出し直さないと戻せない情報なので、元の中身を退避してから進む。
			try {
				await keyStore.setItem(BROKEN_PCS_KEY, raw);
			} catch (error) {
				console.warn('[pcs] failed to keep a copy of the damaged ledger', error);
			}
		}
		return { pcs, migratedFromSinglePc: false, dropped };
	}
	const legacy = await keyStore.getItem(LEGACY_CREDENTIALS_KEY);
	if (!legacy) {
		return { pcs: [], migratedFromSinglePc: false, dropped: 0 };
	}
	let parsedLegacy: unknown;
	try {
		parsedLegacy = JSON.parse(legacy);
	} catch {
		return { pcs: [], migratedFromSinglePc: false, dropped: 0 };
	}
	const migrated = fromStored({ ...(parsedLegacy as object), name: FALLBACK_PC_NAME });
	if (migrated === undefined) {
		return { pcs: [], migratedFromSinglePc: false, dropped: 0 };
	}
	return { pcs: [migrated], migratedFromSinglePc: true, dropped: 0 };
}

/**
 * 単一PC時代の資格情報を消す。**台帳へ保存し終えてから呼ぶこと。**
 * 残したままだと、そのPCとのペアリングを解除しても mobileToken 一式が端末に残り、
 * リレー上の失効に失敗していれば有効な認証情報が手つかずで置き去りになる。
 */
export async function deleteLegacyCredentials(keyStore: KeyStore): Promise<void> {
	await keyStore.deleteItem(LEGACY_CREDENTIALS_KEY);
}

export async function savePairedPcs(keyStore: KeyStore, pcs: readonly PairedPc[]): Promise<void> {
	await keyStore.setItem(PCS_KEY, JSON.stringify(pcs.map(toStored)));
}

export async function loadActivePcId(keyStore: KeyStore): Promise<string | undefined> {
	const raw = await keyStore.getItem(ACTIVE_PC_KEY);
	return raw && raw.length > 0 ? raw : undefined;
}

export async function saveActivePcId(keyStore: KeyStore, id: string | undefined): Promise<void> {
	if (id === undefined) {
		await keyStore.deleteItem(ACTIVE_PC_KEY);
		return;
	}
	await keyStore.setItem(ACTIVE_PC_KEY, id);
}

/**
 * 台帳に無い名前を作る。PCが名前を送ってくれない場合の見分けが付くよう、
 * 2台目以降には連番を付ける（「Para Code」「Para Code 2」…）。
 */
export function nextFallbackPcName(existing: readonly PairedPc[]): string {
	const taken = new Set(existing.map(pc => pc.name));
	if (!taken.has(FALLBACK_PC_NAME)) {
		return FALLBACK_PC_NAME;
	}
	for (let index = 2; index < 100; index++) {
		const candidate = `${FALLBACK_PC_NAME} ${index}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
	return FALLBACK_PC_NAME;
}

/**
 * PCから届いた名前を台帳へ反映した結果を返す（変化が無ければ同じ配列を返す）。
 * ユーザーが自分で名前を付けたPCは書き換えない。
 */
export function applyReportedPcName(pcs: readonly PairedPc[], id: string, reported: unknown): readonly PairedPc[] {
	// PCが送ってくる値は信用しない（文字列とは限らず、長さの制限も向こう任せにしない）。
	const name = sanitizePcName(reported);
	if (!name) {
		return pcs;
	}
	const target = pcs.find(pc => pc.id === id);
	if (target === undefined || target.renamed || target.name === name) {
		return pcs;
	}
	return pcs.map(pc => (pc.id === id ? { ...pc, name } : pc));
}

/**
 * ピン留め・アーカイブなど、PCごとに分けて保存する記録の形。
 * 単一PC時代は文字列の配列だったので、その形も読めるようにしてある（移行時は
 * `migrateActivePcId` に入れたPCのぶんとして引き継ぐ）。
 */
export type ScopedKeyRecord = Record<string, string[]>;

/**
 * PC IDをキーにした記録は、必ずプロトタイプを持たないオブジェクトで作る。
 * 素の `{}` だと `__proto__` というキーが来たときに代入がプロトタイプ差し替えになり、
 * その記録は以後何も保存できなくなる。
 */
function emptyScopedKeyRecord(): ScopedKeyRecord {
	return Object.create(null) as ScopedKeyRecord;
}

export function parseScopedKeys(raw: string | null, migrateActivePcId: string | undefined): ScopedKeyRecord {
	const record = emptyScopedKeyRecord();
	if (!raw) {
		return record;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return record;
	}
	if (Array.isArray(parsed)) {
		// 単一PC時代の記録。いま見ているPCのものとして引き継ぐ（相手が1台しかいなかったため）。
		const keys = parsed.filter((key): key is string => typeof key === 'string');
		if (migrateActivePcId !== undefined && keys.length > 0) {
			record[migrateActivePcId] = keys;
		}
		return record;
	}
	if (parsed === null || typeof parsed !== 'object') {
		return record;
	}
	for (const [pcId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			record[pcId] = value.filter((key): key is string => typeof key === 'string');
		}
	}
	return record;
}

export function scopedKeysFor(record: ScopedKeyRecord, pcId: string | undefined): Set<string> {
	return new Set(pcId !== undefined ? record[pcId] ?? [] : []);
}

export function withScopedKeys(record: ScopedKeyRecord, pcId: string, keys: ReadonlySet<string>): ScopedKeyRecord {
	const next = Object.assign(emptyScopedKeyRecord(), record);
	if (keys.size === 0) {
		delete next[pcId];
	} else {
		next[pcId] = [...keys];
	}
	return next;
}
