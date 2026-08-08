// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore

public class ParaPlusMenuModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaPlusMenu")

		View(ParaPlusMenuView.self) {
			Events("onSelect")

			Prop("items") { (view: ParaPlusMenuView, items: [ParaPlusMenuItem]) in
				view.setItems(items)
			}
			Prop("accessibilityTitle") { (view: ParaPlusMenuView, label: String) in
				view.setAccessibilityTitle(label)
			}
			Prop("symbol") { (view: ParaPlusMenuView, name: String) in
				view.setSymbol(name)
			}
		}
	}
}
