/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 左サイドバーの「資料」ビューが台帳を読むための、ウィンドウ → shared process のチャネルの形と、
// 一覧の絞り込み・検索・まとめ方の純関数。台帳を書くのは shared process の資料のサービスだけで、ウィンドウはチャネルで頼む。

import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisDocFingerprint, IParadisDocFolder, IParadisDocRecord, ParadisDocKind, ParadisDocOwnerLiveness, ParadisDocOwnerVia, ParadisDocRegisteredBy, paradisDocBelongsToFolder, paradisDocLastActivity } from './paradisAgentDocs.js';

/** ウィンドウから shared process の台帳へ頼むチャネル（向きは paradisAgentDocs と逆）。 */
export const PARADIS_AGENT_DOCS_VIEW_CHANNEL = 'paradisAgentDocsView';

/** チャネルの呼び出し。 */
export const ParadisAgentDocsViewCall = {
	/** 台帳の全件（{@link IParadisDocViewRecord} の配列）。 */
	List: 'list',
	/** 渡したペインのトークンで動いている会話。引数は `[tokens]`、答えは {@link IParadisDocPaneSessionInfo} の配列。 */
	PaneSessions: 'paneSessions',
	/** 利用者がプレビューで開いた資料を載せる。引数は `[hostId, path]`。 */
	RegisterOpened: 'registerOpened',
	/** 一覧から外す。引数は `[hostId, path]`。 */
	Remove: 'remove',
	/** まとめて一覧から外す。引数は `[hostId, paths]`。 */
	RemoveMany: 'removeMany',
	/** ウィンドウが取った指紋を預ける。引数は `[hostId, IParadisDocFingerprintUpdate[]]`。 */
	SetFingerprints: 'setFingerprints',
	/**
	 * 見つからなくなった資料の記録の場所を、移動先へ書き換える。引数は `[hostId, from, to, hash]`（hash はウィンドウが
	 * 移動先で確かめた中身のハッシュ。台帳の指紋と同じときだけ書き換える）。答えは書き換えたか。
	 */
	Relocate: 'relocate',
	/** ファイルの有無を記録する。引数は `[hostId, path, missing]`。 */
	SetMissing: 'setMissing',
	/** 持ち主のいない資料をペインの会話の資料にする。引数は `[hostId, path, token]`、答えは {@link ParadisDocAssignResult}。 */
	Assign: 'assign',
	/**
	 * ウィンドウが見張っているフォルダで資料（html・md）が作られた・変わった。引数は `[hostId, path, tokens]`
	 * （tokens はその資料のスペースのペイン）。作業中の会話が 1 つだけならその会話の資料にする。
	 */
	NoteChanged: 'noteChanged',
} as const;

/** チャネルの知らせ。 */
export const PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE = 'onDidChange';

/** ビューに渡す 1 件（書き込みの記録・前の持ち主は渡さない）。 */
export interface IParadisDocViewRecord {
	readonly hostId: string;
	readonly path: string;
	readonly kind: ParadisDocKind;
	readonly owner?: {
		readonly agent: ParadisAgentKind;
		readonly session: string;
		readonly cwd?: string;
		readonly via: ParadisDocOwnerVia;
	};
	/** 持ち主の会話の状態。持ち主がいなければ無い。 */
	readonly liveness?: ParadisDocOwnerLiveness;
	readonly registeredBy: ParadisDocRegisteredBy;
	/** 最後に動いた時刻（書き込み・持ち主の交代・初めて載った時刻の新しい方）。 */
	readonly lastActivity: number;
	readonly missingSince?: number;
	/** 自動で一覧から外すまでの日数の数え始め（{@link IParadisDocRecord.missingCountedFrom}）。 */
	readonly missingCountedFrom?: number;
	/** 最後に取った指紋（移動先の追従に使う）。 */
	readonly fingerprint?: IParadisDocFingerprint;
	/** 未回答のコメントの数（0 なら無い）。 */
	readonly openComments?: number;
}

/** ペインで動いている会話。 */
export interface IParadisDocPaneSessionInfo {
	readonly token: string;
	readonly agent: ParadisAgentKind;
	readonly session: string;
	readonly hostId: string;
}

/** 「このセッションの資料にする」の結果。 */
export type ParadisDocAssignResult = 'assigned' | 'owned' | 'unknown' | 'sessionUnknown' | 'hostMismatch';

/** 台帳の 1 件をビューに渡す形にする。 */
export function paradisDocViewRecord(record: IParadisDocRecord, liveness: ParadisDocOwnerLiveness | undefined, openComments = 0): IParadisDocViewRecord {
	const owner = record.owner;
	return {
		hostId: record.hostId,
		path: record.path,
		kind: record.kind,
		...(owner !== undefined ? { owner: { agent: owner.agent, session: owner.session, ...(owner.cwd !== undefined ? { cwd: owner.cwd } : {}), via: owner.via } } : {}),
		...(owner !== undefined && liveness !== undefined ? { liveness } : {}),
		registeredBy: record.registeredBy,
		lastActivity: paradisDocLastActivity(record),
		...(record.missingSince !== undefined ? { missingSince: record.missingSince } : {}),
		...(record.missingSince !== undefined && record.missingCountedFrom !== undefined ? { missingCountedFrom: record.missingCountedFrom } : {}),
		...(record.fingerprint !== undefined ? { fingerprint: record.fingerprint } : {}),
		...(openComments > 0 ? { openComments } : {}),
	};
}

/** このウィンドウの接続先の資料の、未回答のコメントの合計（「資料」アイコンのバッジ）。 */
export function paradisDocsOpenCommentTotal(records: readonly IParadisDocViewRecord[], hostId: string | undefined): number {
	return records.reduce((total, record) => record.hostId === hostId ? total + (record.openComments ?? 0) : total, 0);
}

// --- 絞り込み ----------------------------------------------------------------------------------

/** 範囲。session = このセッション（表示中の資料、無ければ選んでいるターミナルの会話）、space = このスペース、all = すべて。 */
export type ParadisDocsScope = 'session' | 'space' | 'all';

/** まとめ方。 */
export type ParadisDocsGrouping = 'session' | 'date' | 'folder';

export interface IParadisDocsFilter {
	readonly scope: ParadisDocsScope;
	/** このウィンドウの接続先の印。ほかの機械の資料はこのウィンドウでは開けないので出さない。 */
	readonly hostId: string;
	/** scope が session のときの会話。分からなければ何も出さない。 */
	readonly session?: string;
	/** scope が space のときのスペースのフォルダ。分からなければ何も出さない。 */
	readonly folder?: IParadisDocFolder;
	readonly html: boolean;
	readonly md: boolean;
	/** 検索の語（ファイル名とパスに含むもの。大文字小文字を区別しない）。 */
	readonly query: string;
}

/** ファイル名（パスの末尾）。 */
export function paradisDocFileName(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index >= 0 ? path.slice(index + 1) : path;
}

/** 親のフォルダのパス。 */
export function paradisDocParentPath(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index > 0 ? path.slice(0, index) : path.slice(0, index + 1);
}

/** 絞り込む。並びは最後に動いた順（新しい順）。 */
export function paradisFilterDocs(records: readonly IParadisDocViewRecord[], filter: IParadisDocsFilter): IParadisDocViewRecord[] {
	const words = filter.query.trim().toLowerCase().split(/\s+/).filter(word => word.length > 0);
	return records.filter(record => {
		if (record.hostId !== filter.hostId) {
			return false;
		}
		if (filter.scope === 'session' && (filter.session === undefined || record.owner?.session !== filter.session)) {
			return false;
		}
		if (filter.scope === 'space' && (filter.folder === undefined || !paradisDocBelongsToFolder(asRecord(record), filter.folder))) {
			return false;
		}
		if (record.kind === 'html' ? !filter.html : !filter.md) {
			return false;
		}
		const haystack = record.path.toLowerCase();
		return words.every(word => haystack.includes(word));
	}).sort((a, b) => b.lastActivity - a.lastActivity);
}

/** paradisDocBelongsToFolder が見る欄だけを持つ台帳の形にする。 */
function asRecord(record: IParadisDocViewRecord): IParadisDocRecord {
	return {
		hostId: record.hostId,
		path: record.path,
		kind: record.kind,
		...(record.owner !== undefined ? { owner: { ...record.owner, since: 0 } } : {}),
		previousOwners: [],
		writes: [],
		registeredBy: record.registeredBy,
		firstSeen: record.lastActivity,
	};
}

// --- 状態 ------------------------------------------------------------------------------------

/** 持ち主の状態の札。live = 動作中、ended = 終了済み、unknown = 状態不明、none = 作成元が分からない。 */
export type ParadisDocOwnerStatus = ParadisDocOwnerLiveness | 'none';

export function paradisDocOwnerStatus(record: IParadisDocViewRecord): ParadisDocOwnerStatus {
	return record.owner === undefined ? 'none' : record.liveness ?? 'unknown';
}

// --- まとめ方 ----------------------------------------------------------------------------------

/** 日付の組。 */
export type ParadisDocDateBucket = 'today' | 'yesterday' | 'week' | 'older';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 最後に動いた時刻の日付の組（`now` の日の 0 時を基準にする。日付はその機械の時刻帯）。 */
export function paradisDocDateBucket(time: number, now: number): ParadisDocDateBucket {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const start = midnight.getTime();
	if (time >= start) {
		return 'today';
	}
	if (time >= start - DAY_MS) {
		return 'yesterday';
	}
	return time >= start - 6 * DAY_MS ? 'week' : 'older';
}

/**
 * 組の 1 つ。`records` はファイルのある資料、`missing` は見つからない資料（組の末尾に畳んだ 1 行で出す）。
 * kind が missing の組は、ファイルのある資料が 1 つも無い組の見つからない資料を集めたもの（見出しは出さず、一覧の最後に置く）。
 */
export type ParadisDocsGroup = (
	| { readonly kind: 'session'; readonly agent: ParadisAgentKind; readonly session: string; readonly status: ParadisDocOwnerStatus; readonly cwd?: string }
	| { readonly kind: 'unowned' }
	| { readonly kind: 'date'; readonly bucket: ParadisDocDateBucket }
	| { readonly kind: 'folder'; readonly folder: string }
	| { readonly kind: 'missing' }
) & { readonly key: string; readonly records: readonly IParadisDocViewRecord[]; readonly missing: readonly IParadisDocViewRecord[] };

const DATE_ORDER: readonly ParadisDocDateBucket[] = ['today', 'yesterday', 'week', 'older'];

/** 一覧の最後に置く、見つからない資料だけの組のキー。 */
export const PARADIS_DOCS_MISSING_GROUP_KEY = 'missing';

function groupKeyOf(record: IParadisDocViewRecord, grouping: ParadisDocsGrouping, now: number): string {
	if (grouping === 'session') {
		return record.owner !== undefined ? `session:${record.owner.session}` : 'unowned';
	}
	return grouping === 'date' ? `date:${paradisDocDateBucket(record.lastActivity, now)}` : `folder:${paradisDocParentPath(record.path)}`;
}

/**
 * 絞り込んだ一覧（新しい順）をまとめる。
 * - session: 会話ごと。会話の並びはいちばん新しく動いた資料の順。持ち主のいない資料は最後の「作成元が分からない」の組
 * - date: 今日・昨日・今週・それより前
 * - folder: 親のフォルダごと（フォルダのパスの順）
 * 組の中は渡された順（新しい順）のまま。組の並びと数は、ファイルのある資料だけで決める。見つからない資料は、同じ組に
 * ファイルのある資料があればその組の `missing` に、無ければ最後の missing の組に入れる（資料が 1 つも残っていない
 * 会話・日付・フォルダの見出しは出さない）。
 */
export function paradisGroupDocs(records: readonly IParadisDocViewRecord[], grouping: ParadisDocsGrouping, now: number): ParadisDocsGroup[] {
	const present = records.filter(record => record.missingSince === undefined);
	const lists = new Map<string, IParadisDocViewRecord[]>();
	for (const record of present) {
		const key = groupKeyOf(record, grouping, now);
		const list = lists.get(key) ?? [];
		list.push(record);
		lists.set(key, list);
	}
	const missing = new Map<string, IParadisDocViewRecord[]>();
	const orphaned: IParadisDocViewRecord[] = [];
	for (const record of records) {
		if (record.missingSince !== undefined) {
			const key = groupKeyOf(record, grouping, now);
			if (lists.has(key)) {
				missing.set(key, [...(missing.get(key) ?? []), record]);
			} else {
				orphaned.push(record);
			}
		}
	}
	const rest = (key: string) => ({ key, records: lists.get(key)!, missing: missing.get(key) ?? [] });
	let groups: ParadisDocsGroup[];
	if (grouping === 'session') {
		groups = [...lists.keys()].filter(key => key !== 'unowned').map(key => {
			const first = lists.get(key)![0];
			const owner = first.owner!;
			return { kind: 'session', agent: owner.agent, session: owner.session, status: paradisDocOwnerStatus(first), ...(owner.cwd !== undefined ? { cwd: owner.cwd } : {}), ...rest(key) };
		});
		if (lists.has('unowned')) {
			groups.push({ kind: 'unowned', ...rest('unowned') });
		}
	} else if (grouping === 'date') {
		groups = DATE_ORDER.filter(bucket => lists.has(`date:${bucket}`)).map(bucket => ({ kind: 'date', bucket, ...rest(`date:${bucket}`) }));
	} else {
		groups = [...lists.keys()].map(key => key.slice('folder:'.length)).sort((a, b) => a.localeCompare(b)).map(folder => ({ kind: 'folder', folder, ...rest(`folder:${folder}`) }));
	}
	if (orphaned.length > 0) {
		groups.push({ kind: 'missing', key: PARADIS_DOCS_MISSING_GROUP_KEY, records: [], missing: orphaned });
	}
	return groups;
}
