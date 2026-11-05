import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/fira-code/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import './styles/tailwind.css'
import './styles/workbench.css'
import './styles/extra.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
