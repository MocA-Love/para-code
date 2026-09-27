# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaIpadInput'
  s.version        = '1.0.0'
  s.summary        = 'Hardware keyboard shortcuts and pointer hover effects for the iPad layout'
  s.description    = 'Registers UIKeyCommands (shown in the Command-hold discoverability overlay) and wraps views in UIPointerInteraction so iPadOS draws the standard pointer effects.'
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
