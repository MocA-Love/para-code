// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore

public class ParaContextMenuModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaContextMenu")

		View(ParaContextMenuView.self) {
			Events("onSelect")

			Prop("items") { (view: ParaContextMenuView, items: [ParaContextMenuItem]) in
				view.setItems(items)
			}
			Prop("title") { (view: ParaContextMenuView, title: String) in
				view.setTitle(title)
			}
			Prop("previewCornerRadius") { (view: ParaContextMenuView, radius: Double) in
				view.setPreviewCornerRadius(radius)
			}
			Prop("previewBackgroundColor") { (view: ParaContextMenuView, color: UIColor?) in
				view.setPreviewBackgroundColor(color)
			}
		}
	}
}
