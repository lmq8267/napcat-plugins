import { useState, useEffect, useCallback } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { PluginConfig } from '../types'
import { IconSettings, IconTerminal } from '../components/icons'

export default function ConfigPage() {
    const [config, setConfig] = useState<PluginConfig | null>(null)
    const [saving, setSaving] = useState(false)

    const fetchConfig = useCallback(async () => {
        try {
            const res = await noAuthFetch<PluginConfig>('/config')
            if (res.code === 0 && res.data) setConfig(res.data)
        } catch { showToast('获取配置失败', 'error') }
    }, [])

    useEffect(() => { fetchConfig() }, [fetchConfig])

    const saveConfig = useCallback(async (update: Partial<PluginConfig>) => {
        if (!config) return
        setSaving(true)
        try {
            const newConfig = { ...config, ...update }
            await noAuthFetch('/config', {
                method: 'POST',
                body: JSON.stringify(newConfig),
            })
            setConfig(newConfig)
            showToast('配置已保存', 'success')
        } catch {
            showToast('保存失败', 'error')
        } finally {
            setSaving(false)
        }
    }, [config])

    const updateField = <K extends keyof PluginConfig>(key: K, value: PluginConfig[K]) => {
        if (!config) return
        const updated = { ...config, [key]: value }
        setConfig(updated)
        saveConfig({ [key]: value })
    }

    if (!config) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner !w-6 !h-6 text-brand-500" />
                    <span className="text-xs text-gray-400">加载配置中...</span>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-5">
            <div className="rounded-xl border border-gray-200/70 dark:border-white/[0.06] bg-white dark:bg-white/[0.03] overflow-hidden">
                {/* 卡片头 */}
                <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-100 dark:border-white/[0.04]">
                    <div className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-white/[0.06] flex items-center justify-center text-gray-500 dark:text-gray-400">
                        <IconSettings size={14} />
                    </div>
                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">基础配置</span>
                </div>

                {/* 配置项 */}
                <div className="divide-y divide-gray-100 dark:divide-white/[0.04]">
                    <div className="flex items-center justify-between px-5 py-4">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center text-violet-500">
                                <IconTerminal size={15} />
                            </div>
                            <div>
                                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">调试模式</div>
                                <div className="text-xs text-gray-400 mt-0.5">启用后输出详细日志到控制台</div>
                            </div>
                        </div>
                        <label className="toggle">
                            <input type="checkbox" checked={config.debug} onChange={(e) => updateField('debug', e.target.checked)} />
                            <div className="slider" />
                        </label>
                    </div>
                </div>
            </div>

            {saving && (
                <div className="fixed bottom-4 right-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium shadow-lg shadow-brand-500/20 animate-pulse">
                    <div className="loading-spinner !w-3 !h-3 !border-[1.5px] !border-white !border-t-transparent" />
                    保存中...
                </div>
            )}
        </div>
    )
}
