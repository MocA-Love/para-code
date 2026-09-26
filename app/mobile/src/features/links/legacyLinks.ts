// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 作り直し前のルートへのリンクを、いまのルートへ書き換える（`app/+native-intent.tsx` から呼ぶ純関数）。
 *
 * 外から届く旧ルートは、以前の版の Live Activity の `paracode-mobile:///agent`（どのエージェントかを URL に
 * 持たない）。更新前に出ていた Live Activity は古い URL のまま残るので、ここで受け続ける。`/agent` は
 * 「エージェントの画面を開く」で、どのエージェントかはアプリの状態で決まっていたので、状態が揃ってから
 * 行き先を決める中継の画面（`/open-session`、最大 8 秒待つ）へ送る。クエリ（`latest`: 会話を最新まで送る
 * 一度限りの印）は引き継ぐ。いまの Live Activity は PC・スペース・ターミナルを載せた `/widget/session` で
 * セッションを直接開き、情報が足りないときだけ中継の画面へ落ちる（`widgetLinks.ts`）。
 *
 * ほかの旧ルートはアプリの中からしか開かれていなかったが、残っていても「Unmatched Route」にならないよう、
 * 近い画面へ寄せておく（スペースを決められない画面はホーム）。
 *
 * ホーム画面・ロック画面のウィジェットのリンク（`/widget/…`）も、ここでいまのルートへ書き換える
 * （対応表は `widgetLinks.ts`）。
 */

import { redirectWidgetLink, WIDGET_LINK_PREFIX } from './widgetLinks.js';

/** 中継の画面（要対応のセッションへ、無ければホームへ置き換える）。 */
export const OPEN_SESSION_PATH = '/open-session';

const LEGACY_PATHS: Readonly<Record<string, string>> = {
	'/agent': OPEN_SESSION_PATH,
	'/terminal': OPEN_SESSION_PATH,
	'/agent-activity': OPEN_SESSION_PATH,
	'/agent-activity-detail': OPEN_SESSION_PATH,
	'/browser': OPEN_SESSION_PATH,
	'/scm': '/',
	'/files': '/',
	'/archive': '/',
	'/agent-launch': '/',
	'/space-note': '/',
	'/terminal-settings': '/settings/terminal',
	'/notification-settings': '/settings/notifications',
	'/presets': '/settings/presets',
	'/changelog': '/settings/changelog',
	'/pc-detail': '/settings/pcs',
	'/usage': '/settings/usage',
	'/ratelimit': '/settings/usage',
	'/ccusage': '/settings/usage/cost',
	'/github-usage': '/settings/usage/github',
	'/rtk': '/settings/usage/rtk',
	'/system': '/settings/usage/system',
	'/morph-lab': '/settings',
	'/morph-native': '/settings',
	'/morph-native-detail': '/settings',
};

/** 中継の画面へ引き継ぐクエリ（ほかは捨てる）。 */
const KEPT_QUERY = new Set(['latest']);

const APP_SCHEME = /^paracode-mobile:\/\//i;

/**
 * 旧ルートなら書き換えた行き先（`/open-session?latest=…` など）、そうでなければ undefined（そのまま開く）。
 * `path` は URL（`paracode-mobile:///agent`・`paracode-mobile://agent`）でもパス（`/agent`）でもよい。
 * ほかのスキーム（開発用クライアントの URL など）は触らない。
 */
export function redirectLegacyLink(path: string): string | undefined {
	let rest: string;
	if (APP_SCHEME.test(path)) {
		rest = path.replace(APP_SCHEME, '');
	} else if (path.startsWith('/')) {
		rest = path;
	} else {
		return undefined;
	}
	const hashAt = rest.indexOf('#');
	const withoutHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
	const queryAt = withoutHash.indexOf('?');
	const rawPath = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
	const query = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : '';
	const pathname = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
	if (pathname.startsWith(WIDGET_LINK_PREFIX)) {
		return redirectWidgetLink(pathname, query);
	}
	const target = LEGACY_PATHS[pathname];
	if (target === undefined) {
		return undefined;
	}
	if (target !== OPEN_SESSION_PATH || query.length === 0) {
		return target;
	}
	const kept = query.split('&').filter(pair => KEPT_QUERY.has(pair.split('=')[0] ?? '') && pair.includes('=') && pair.split('=')[1] !== '');
	return kept.length > 0 ? `${target}?${kept.join('&')}` : target;
}
