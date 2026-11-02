export const CODE_FONTS = ['Cascadia Mono', 'JetBrains Mono', 'Consolas', 'Cascadia Code', 'monospace'] as const
export const UI_FONTS = ['Geist', 'Segoe UI', 'Microsoft YaHei UI', 'JetBrains Mono', 'system-ui'] as const
export const codeFont = (family = 'Cascadia Mono') => `'${family}', 'JetBrains Mono', Consolas, 'Microsoft YaHei', 'Noto Sans Mono CJK SC', monospace`
export const uiFont = (family = 'Geist') => `'${family}', 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif`
