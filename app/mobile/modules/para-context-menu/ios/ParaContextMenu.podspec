# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaContextMenu'
  s.version        = '1.0.0'
  s.summary        = 'Native context menu (UIContextMenuInteraction) around React Native views'
  s.description    = 'Wraps React Native children in a view that shows the standard iOS context menu on long press and, on iPad, on secondary click.'
  s.author         = 'Paradis'
  s.homepage       = 'https://paradis.ltd'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
