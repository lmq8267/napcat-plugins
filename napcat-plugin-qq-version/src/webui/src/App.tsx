import ToastContainer from './components/ToastContainer'
import InstallPage from './pages/InstallPage'
import { useTheme } from './hooks/useTheme'
import { IconPackage, IconGithub } from './components/icons'

export type PageId = 'install'

function App() {
    useTheme()

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-[#0f0f11] text-gray-800 dark:text-gray-200 transition-colors duration-300">
            <ToastContainer />

            {/* 顶部导航栏 */}
            <header className="sticky top-0 z-30 bg-white/80 dark:bg-[#18181b]/80 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06]">
                <div className="max-w-5xl mx-auto px-4 sm:px-6">
                    <div className="flex items-center justify-between h-14">
                        <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white shadow-sm shadow-brand-500/20">
                                <IconPackage size={14} />
                            </div>
                            <span className="font-bold text-sm text-gray-900 dark:text-white tracking-tight">QQ Version</span>
                        </div>

                        <a
                            href="https://github.com/AQiaoYo/napcat-plugin-qq-version"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-all no-underline"
                        >
                            <IconGithub size={16} />
                        </a>
                    </div>
                </div>
            </header>

            <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
                <div className="page-enter">
                    <InstallPage />
                </div>
            </main>
        </div>
    )
}

export default App
