// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ファイルの一覧のアイコン（`fs.icon-theme.v1`）の判定。React・ネイティブに依存しない純関数で、
 * `fileIconTheme.test.ts` で固定している。
 *
 * 名前からアイコンを決める規則は PC と同じ関数（`paradisMobileFileIconTheme.ts` を直接 import する）。
 * PC のエクスプローラーの CSS の詳細度を点数にしたもので、ファイル名 > 長い拡張子 > 短い拡張子 > 言語 > 既定。
 */

import {
	PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT,
	paradisParseMobileIconThemeManifest,
	paradisResolveMobileFileIcon,
	paradisSanitizeMobileIconSvg,
	type IParadisMobileIconThemeManifest,
	type ParadisMobileIconTarget,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileFileIconTheme.js';

export type IconThemeManifest = IParadisMobileIconThemeManifest;
export type IconTarget = ParadisMobileIconTarget;
export { paradisResolveMobileFileIcon as resolveFileIcon, paradisSanitizeMobileIconSvg as sanitizeIconSvg };

/** `iconSvgs` で 1 回に頼む ID の数（PC の上限と同じ）。 */
export const ICON_SVG_BATCH = PARADIS_MOBILE_ICON_SVG_REQUEST_LIMIT;

/**
 * 1 台の PC のアイコンのテーマの写し。
 * `svgs` の値が `null` のアイコンは PC に SVG が無い（フォント・PNG・検査で捨てた）ので既定のアイコンで描く。
 */
export interface IconThemeEntry {
	readonly revision: string;
	readonly themeId: string;
	/** SVG のアイコンを持つテーマか（Seti などフォントだけのテーマ・テーマ無しは false）。 */
	readonly supported: boolean;
	readonly manifest: IconThemeManifest | undefined;
	readonly svgs: Readonly<Record<string, string | null>>;
}

export function iconTargetOf(dir: boolean, expanded: boolean | undefined): IconTarget {
	return !dir ? 'file' : expanded === true ? 'folderExpanded' : 'folder';
}

/** その名前に使うアイコンの ID（テーマが無い・未対応・どの規則にも当たらなければ undefined）。 */
export function iconIdFor(entry: IconThemeEntry | undefined, name: string, parentName: string | undefined, target: IconTarget): string | undefined {
	return entry?.manifest !== undefined ? paradisResolveMobileFileIcon(entry.manifest, name, parentName, target) : undefined;
}

export type IconThemeReply =
	| { readonly kind: 'notModified'; readonly revision: string }
	| { readonly kind: 'theme'; readonly revision: string; readonly themeId: string; readonly supported: boolean; readonly manifest: IconThemeManifest | undefined };

/** PC の `iconTheme` の応答を読む。形が違えば undefined。 */
export function parseIconThemeReply(value: unknown): IconThemeReply | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const reply = value as { revision?: unknown; themeId?: unknown; notModified?: unknown; supported?: unknown; manifest?: unknown };
	if (typeof reply.revision !== 'string' || reply.revision.length === 0) {
		return undefined;
	}
	if (reply.notModified === true) {
		return { kind: 'notModified', revision: reply.revision };
	}
	const manifest = reply.supported === true ? paradisParseMobileIconThemeManifest(reply.manifest) : undefined;
	return {
		kind: 'theme',
		revision: reply.revision,
		themeId: typeof reply.themeId === 'string' ? reply.themeId : '',
		supported: manifest !== undefined,
		manifest,
	};
}

/** 届いたテーマを写しに当てる。版が変わったら SVG は捨てる（同じ ID でも中身が違いうる）。 */
export function applyIconThemeReply(previous: IconThemeEntry | undefined, reply: IconThemeReply): IconThemeEntry | undefined {
	if (reply.kind === 'notModified') {
		return previous?.revision === reply.revision ? previous : undefined;
	}
	return {
		revision: reply.revision,
		themeId: reply.themeId,
		supported: reply.supported,
		manifest: reply.manifest,
		svgs: previous?.revision === reply.revision ? previous.svgs : {},
	};
}

export interface IconSvgsReply {
	readonly revision: string;
	/** PC の版が変わっていた（対応表から取り直す）。 */
	readonly stale: boolean;
	/** 届いた SVG（アプリでも検査し直す）と、無いと分かったアイコン（`null`）。頼んだのに返らなかった ID は含めない。 */
	readonly svgs: Readonly<Record<string, string | null>>;
}

/** PC の `iconSvgs` の応答を読む。頼んでいない ID は捨てる。 */
export function parseIconSvgsReply(value: unknown, requested: readonly string[]): IconSvgsReply | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const reply = value as { revision?: unknown; stale?: unknown; svgs?: unknown; missing?: unknown };
	if (typeof reply.revision !== 'string') {
		return undefined;
	}
	const wanted = new Set(requested);
	const svgs: Record<string, string | null> = {};
	if (Array.isArray(reply.missing)) {
		for (const id of reply.missing) {
			if (typeof id === 'string' && wanted.has(id)) {
				svgs[id] = null;
			}
		}
	}
	if (reply.svgs !== null && typeof reply.svgs === 'object') {
		for (const [id, svg] of Object.entries(reply.svgs as Record<string, unknown>)) {
			if (wanted.has(id)) {
				svgs[id] = typeof svg === 'string' ? paradisSanitizeMobileIconSvg(svg) ?? null : null;
			}
		}
	}
	return { revision: reply.revision, stale: reply.stale === true, svgs };
}

/** 端末に置く写しの形（版を変えたら読み捨てる）。 */
const CACHE_VERSION = 1;

export function serializeIconTheme(entry: IconThemeEntry): string {
	return JSON.stringify({ v: CACHE_VERSION, ...entry });
}

export function parseStoredIconTheme(text: string): IconThemeEntry | undefined {
	try {
		const value = JSON.parse(text) as { v?: unknown; revision?: unknown; themeId?: unknown; supported?: unknown; manifest?: unknown; svgs?: unknown };
		if (value.v !== CACHE_VERSION || typeof value.revision !== 'string' || typeof value.themeId !== 'string') {
			return undefined;
		}
		const manifest = value.supported === true ? paradisParseMobileIconThemeManifest(value.manifest) : undefined;
		const svgs: Record<string, string | null> = {};
		if (manifest !== undefined && value.svgs !== null && typeof value.svgs === 'object') {
			for (const [id, svg] of Object.entries(value.svgs as Record<string, unknown>)) {
				svgs[id] = typeof svg === 'string' ? paradisSanitizeMobileIconSvg(svg) ?? null : null;
			}
		}
		return { revision: value.revision, themeId: value.themeId, supported: manifest !== undefined, manifest, svgs };
	} catch {
		return undefined;
	}
}
