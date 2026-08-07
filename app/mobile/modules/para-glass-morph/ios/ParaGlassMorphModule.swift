// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore

public class ParaGlassMorphModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaGlassMorph")

		View(ParaGlassMorphView.self)
	}
}
