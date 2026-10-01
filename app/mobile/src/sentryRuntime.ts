// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** `Sentry.init` のうち、開発ビルドかどうかで変わる部分。 */
export interface MobileSentryRuntime {
	/** false だと JS 側のクライアントはイベントもトランザクションも送らない。 */
	readonly enabled: boolean;
	/**
	 * false だとネイティブの SDK（iOS は sentry-cocoa）を起動しない。ネイティブのクラッシュ報告と
	 * App Hang の検知はこちらが持っているので、`enabled` だけでは止まらない。
	 */
	readonly enableNative: boolean;
	/**
	 * PC側（PARADIS_SENTRY_ENVIRONMENT）と揃える。'development' 固定だった頃は配布ビルドの実使用も
	 * 全部 development になり、実ユーザーの障害とローカル検証を区別できなかった。
	 */
	readonly environment: 'local' | 'production';
}

/**
 * Metro から読み込む開発ビルド（`__DEV__`）は Sentry へ送らない。ローカルでの検証が雑音として
 * 積み上がり、2026-10-01 に 105 件を手で ignore した。PC 版の開発ビルドも同じ扱い
 * （isParadisSentryDevelopmentBuild）。
 */
export function mobileSentryRuntime(isDevelopment: boolean): MobileSentryRuntime {
	return isDevelopment
		? { enabled: false, enableNative: false, environment: 'local' }
		: { enabled: true, enableNative: true, environment: 'production' };
}
