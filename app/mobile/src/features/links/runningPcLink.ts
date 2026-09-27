// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリが起動している間に OS から届いた PC の中の画面へのリンク（`/pc/…`。ウィジェット・Live Activity・
 * 外からのディープリンク）を、中継の画面（`/open-session?to=…`）経由に書き換える純関数（`app/+native-intent.tsx`）。
 *
 * 起動中のリンクは Expo Router が NAVIGATE で開く。NAVIGATE は、前面の画面と画面名が同じならそのルートを
 * 使い回して引数だけ差し替える（StackClient）。PC A の器が前面のときに PC B のリンクが届くと、A の器の
 * 引数だけが B に変わり、中身は A のまま残ってしまう。器を `pcId` で見分けさせる（`dangerouslySingular`）と
 * 今度は同じ PC の器を作り直さずに最前面へ並べ替えるようになり、並べ替えた後にネイティブの画面と JS の
 * 状態が食い違って、戻っても画面が変わらなくなった（2026-09-27、iPad シミュレータで再現）。
 *
 * 中継の画面はルートの Stack に積まれ、自分を閉じてから `openPcRoute`（`src/features/pc/pcOpenPlan.ts` の規則）で
 * 開き直す。すぐ下が器の Stack ならその中で開き（同じ画面が出ていれば閉じるだけ、同じ PC の器があればそこまで
 * 戻る）、そうでなければ自分を行き先に置き換える。使い回しも並べ替えも起きず、同じリンクを何度押しても器は増えない。
 * 起動時のリンク（アプリが閉じていた）は画面の状態をパスから組み立てるので、この問題は無く、書き換えない。
 */

/** 中継の画面へ行き先を渡すクエリの名前。 */
export const RELAY_TARGET_PARAM = 'to';

const APP_SCHEME = /^paracode-mobile:\/\//i;

/** 起動中に届いたリンク（`path` は URL でもパスでもよい）。PC の中の画面なら中継の画面への行き先、それ以外はそのまま。 */
export function relayRunningPcLink(path: string): string {
	const rest = APP_SCHEME.test(path) ? path.replace(APP_SCHEME, '') : path;
	const hashAt = rest.indexOf('#');
	const withoutHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
	const normalized = `/${withoutHash.replace(/^\/+/, '')}`;
	if (!isPcPath(normalized)) {
		return path;
	}
	return `/open-session?${RELAY_TARGET_PARAM}=${encodeURIComponent(normalized)}`;
}

/**
 * 中継の画面が受け取った行き先を使ってよいか（PC の中の画面だけ。ほかは無視してホームへ）。
 * `/pc/x/../../settings` のように PC の外へ出る書き方は通さない: 区切りが空・`.`・`..` のもの、符号化を
 * 戻すとそうなるもの（`%2e%2e` など）、戻すと `/` や `\` を含むもの、符号化が壊れているものは拒む。
 */
export function isPcPath(target: string): boolean {
	const end = target.search(/[?#]/);
	const pathname = (end >= 0 ? target.slice(0, end) : target).replace(/\/$/, '');
	const segments = pathname.split('/');
	if (segments[0] !== '' || segments[1] !== 'pc' || segments.length < 3) {
		return false;
	}
	return segments.slice(2).every(isPlainSegment);
}

function isPlainSegment(segment: string): boolean {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return false;
	}
	return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[/\\]/.test(decoded);
}
