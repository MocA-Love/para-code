// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Sentryへ送るrelease名の組み立て。
 *
 * 既定では `CFBundleShortVersionString`（Xcodeの `MARKETING_VERSION`）がそのまま release になる。
 * ところが `app/mobile/ios/` は `app/.gitignore` で無視される prebuild 成果物で、`app.json` の
 * `version` を上げても再prebuildしない限り追従しない。実際に 0.2.x を配信している間、Sentry上の
 * releaseは全て `@0.1.0` のままで、**どのアプリ版で起きたエラーか判別できなかった**（更新履歴の
 * バージョンとも突き合わせられない）。
 *
 * そこで正本を `app.json` の `version` に移す。ビルド番号はネイティブ側の値をそのまま残す
 * （バイナリを一意に指し、こちらは配信ごとに正しく上がっているため）。
 */

/** release名の組み立てに必要な入力だけを取る（expo-constants に依存させないため）。 */
export interface MobileReleaseInput {
	/** `app.json` の `expo.version`。 */
	readonly version: string | undefined;
	/** ネイティブのビルド番号（iOSは `CFBundleVersion`）。 */
	readonly buildNumber: string | undefined;
	/** `app.json` の `expo.ios.bundleIdentifier`。 */
	readonly bundleIdentifier: string | undefined;
}

/** bundleIdentifier が取れなかった場合の既定（`app.json` と同じ値）。 */
const FALLBACK_BUNDLE_ID = 'ltd.paradis.paracode.mobile';

/**
 * `<bundleId>@<version>+<build>` を返す。version が取れない場合だけ `undefined` を返し、
 * SDKの既定（ネイティブ由来）に委ねる。
 */
export function mobileSentryRelease(input: MobileReleaseInput): string | undefined {
	if (input.version === undefined || input.version === '') {
		return undefined;
	}
	const bundleId = input.bundleIdentifier !== undefined && input.bundleIdentifier !== ''
		? input.bundleIdentifier
		: FALLBACK_BUNDLE_ID;
	const build = input.buildNumber !== undefined && input.buildNumber !== '' ? `+${input.buildNumber}` : '';
	return `${bundleId}@${input.version}${build}`;
}
