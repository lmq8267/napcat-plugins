/** WebUI 前端类型定义 */

export interface PluginStatus {
    pluginName: string
    uptime: number
    uptimeFormatted: string
    config: PluginConfig
    stats: {
        processed: number
        todayProcessed: number
        lastUpdateDay: string
    }
}

export interface PluginConfig {
    debug: boolean
}

export interface GroupConfig {
    enabled?: boolean
}

export interface GroupInfo {
    group_id: number
    group_name: string
    member_count: number
    max_member_count: number
    enabled: boolean
}

export interface ApiResponse<T = unknown> {
    code: number
    data?: T
    message?: string
}

// ==================== QQ 版本与安装相关 ====================

export interface QQDownloadLink {
    label: string
    url: string
    platform: 'windows' | 'linux' | 'mac' | 'unknown'
    arch: 'x64' | 'arm64' | 'unknown'
    format: 'exe' | 'deb' | 'rpm' | 'dmg' | 'unknown'
}

export interface VersionMatchResult {
    napcatVersion: string
    releaseTag: string
    publishedAt: string
    releaseUrl: string
    currentQQVersion: string
    currentQQBuild: string
    downloadLinks: QQDownloadLink[]
    versionWarning: string
}

export interface VersionRecommended extends VersionMatchResult {
    platform: { platform: string; arch: string }
    isAlreadyInstalled: boolean
}

export type LaunchMode = 'invasive' | 'non-invasive' | 'docker' | 'unknown'

export interface QQInstallInfo {
    execPath: string
    installDir: string
    version: string
    build: string
    platform: string
    arch: string
    isRootless: boolean
    isDocker: boolean
    launchMode: LaunchMode
}

export type InstallStage = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error'

export interface InstallProgress {
    stage: InstallStage
    percent: number
    message: string
    speed?: number
    downloadedBytes?: number
    totalBytes?: number
    error?: string
    finishedAt?: number
}
