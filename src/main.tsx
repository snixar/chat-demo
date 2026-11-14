import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { isNativeApp } from './services/native.js'
import './app/theme.css'
import './app/global.css'

// 原生壳全屏绘制到系统栏下方，需要按安全区留白
if (isNativeApp()) {
  document.body.classList.add('is-native-app')
}

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
