# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaGlassMorph'
  s.version        = '1.0.0'
  s.summary        = 'Liquid Glass morph shape for the home plus menu'
  s.description    = 'Renders a Liquid Glass shape that morphs between the header pill and the plus menu panel using SwiftUI glassEffectID.'
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
