// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Surrounding ScrollView must not terminate a drag after the slider has captured it. */
export function effortSliderGestureBehavior(disabled: boolean, effortCount: number): { readonly enabled: boolean; readonly allowTermination: boolean } {
	return { enabled: !disabled && effortCount > 1, allowTermination: false };
}
