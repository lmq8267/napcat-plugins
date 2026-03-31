/**
 * GitHub 服务模块
 * 调用 GitHub API 获取 NapCatQQ Release 信息
 * 从 Release body 中解析 QQ 版本下载链接
 */

import https from 'https';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import type { GitHubRelease, QQDownloadLink, VersionMatchResult } from '../types';

/** GitHub API 基础 URL */
const GITHUB_API_BASE = 'https://api.github.com/repos/NapNeko/NapCatQQ';

/** 缓存过期时间（5 分钟） */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Release 缓存 */
let releaseCache: {
    data: GitHubRelease | null;
    timestamp: number;
    version: string;
} = {
    data: null,
    timestamp: 0,
    version: ''
};

/**
 * 发送 HTTPS GET 请求并返回 JSON
 */
function httpGetJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'NapCat-Plugin-QQ-Version'
            }
        }, (res) => {
            // 处理重定向
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpGetJson<T>(res.headers.location).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data) as T);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('Request timeout'));
        });
    });
}

/**
 * 获取当前 NapCat 版本号
 * 通过 OneBot API get_version_info 获取
 */
export function getNapCatVersion(): string {
    return cachedNapCatVersion || 'unknown';
}

/** 缓存的 NapCat 版本号 */
let cachedNapCatVersion: string = '';

/**
 * 初始化版本信息（在插件 init 时调用）
 * 通过 OneBot API get_version_info 获取 NapCat 版本
 */
export async function initVersionInfo(ctx: NapCatPluginContext): Promise<void> {
    try {
        const data = await ctx.actions.call(
            'get_version_info',
            void 0,
            ctx.adapterName,
            ctx.pluginManager.config
        ) as { app_name?: string; app_version?: string; protocol_version?: string };

        if (data?.app_version) {
            cachedNapCatVersion = data.app_version;
            pluginState.log('info', `NapCat 版本: ${cachedNapCatVersion}`);
        } else {
            pluginState.log('warn', '获取 NapCat 版本失败: app_version 为空');
        }
    } catch (e) {
        pluginState.log('warn', '通过 get_version_info 获取 NapCat 版本失败:', e);
    }
}

/**
 * 获取当前 QQ 版本信息
 */
export function getCurrentQQInfo(ctx: NapCatPluginContext): { version: string; build: string } {
    try {
        const basicInfo = ctx.core.context.basicInfoWrapper;
        return {
            version: basicInfo.getFullQQVersion() || 'unknown',
            build: basicInfo.getQQBuildStr() || 'unknown'
        };
    } catch (e) {
        pluginState.log('warn', '获取 QQ 版本信息失败:', e);
        return { version: 'unknown', build: 'unknown' };
    }
}

/**
 * 获取当前系统平台信息
 */
export function getCurrentPlatform(): { platform: string; arch: string } {
    return {
        platform: process.platform,
        arch: process.arch
    };
}

/**
 * 通过 GitHub API 获取与当前 NapCat 版本匹配的 Release
 * 优先精确匹配 tag，失败则获取 latest
 */
export async function fetchMatchingRelease(): Promise<GitHubRelease | null> {
    const currentVersion = cachedNapCatVersion || 'latest';

    // 检查缓存
    if (
        releaseCache.data &&
        releaseCache.version === currentVersion &&
        Date.now() - releaseCache.timestamp < CACHE_TTL_MS
    ) {
        pluginState.logDebug('使用缓存的 Release 数据');
        return releaseCache.data;
    }

    try {
        let release: GitHubRelease | null = null;

        // 如果有版本号，先尝试精确匹配
        if (cachedNapCatVersion && cachedNapCatVersion !== 'unknown') {
            const tagName = cachedNapCatVersion.startsWith('v') ? cachedNapCatVersion : `v${cachedNapCatVersion}`;
            pluginState.logDebug(`尝试获取 Release: tag=${tagName}`);

            try {
                release = await httpGetJson<GitHubRelease>(
                    `${GITHUB_API_BASE}/releases/tags/${tagName}`
                );
            } catch {
                // 精确匹配失败，尝试大写 V 前缀
                pluginState.logDebug(`tag ${tagName} 未找到，尝试大写 V 前缀`);
                try {
                    const tagNameUpper = `V${cachedNapCatVersion.replace(/^v/i, '')}`;
                    release = await httpGetJson<GitHubRelease>(
                        `${GITHUB_API_BASE}/releases/tags/${tagNameUpper}`
                    );
                } catch {
                    pluginState.logDebug('精确匹配失败，回退到 latest release');
                }
            }
        }

        // 如果精确匹配失败或没有版本号，获取 latest
        if (!release) {
            release = await httpGetJson<GitHubRelease>(
                `${GITHUB_API_BASE}/releases/latest`
            );
        }

        if (release) {
            // 更新缓存
            releaseCache = {
                data: release,
                timestamp: Date.now(),
                version: currentVersion
            };
            pluginState.logDebug(`获取到 Release: ${release.tag_name}`);
        }

        return release;
    } catch (e) {
        pluginState.log('error', '获取 GitHub Release 失败:', e);
        return null;
    }
}

/**
 * 从 Release body 中解析 QQ 下载链接
 * 
 * body 中的链接格式示例：
 * **[9.9.26-44343 X64 Win](https://dldir1.qq.com/qqfile/qq/QQNT/.../QQ9.9.26.44343_x64.exe)**
 * [LinuxX64 DEB 44343](https://dldir1.qq.com/qqfile/qq/QQNT/.../linuxqq_3.2.23-44343_amd64.deb)
 * [LinuxArm64 DEB 44343](https://dldir1.qq.com/qqfile/qq/QQNT/.../linuxqq_3.2.23-44343_arm64.deb)
 * [MAC DMG 40990](https://dldir1v6.qq.com/qqfile/qq/QQNT/.../QQ_v6.9.82.40990.dmg)
 */
export function parseDownloadLinks(body: string): QQDownloadLink[] {
    if (!body) return [];

    const links: QQDownloadLink[] = [];

    // 匹配 Markdown 链接: [label](url)
    // 可能被 ** 包裹: **[label](url)**
    const linkRegex = /\*{0,2}\[([^\]]+)\]\((https?:\/\/[^)]+)\)\*{0,2}/g;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(body)) !== null) {
        const label = match[1].trim();
        const url = match[2].trim();

        // 只匹配 QQ 下载链接（dldir*.qq.com）
        if (!url.includes('qq.com') || url.includes('github.com') || url.includes('aka.ms')) {
            continue;
        }

        // 排除非 QQ 安装包链接（如文档链接）
        if (url.includes('napneko.github.io')) {
            continue;
        }

        const link: QQDownloadLink = {
            label,
            url,
            platform: detectPlatform(label, url),
            arch: detectArch(label, url),
            format: detectFormat(url)
        };

        links.push(link);
    }

    return links;
}

/**
 * 从 Release body 中提取版本警告信息
 */
export function parseVersionWarning(body: string): string {
    if (!body) return '';

    // 匹配 **注意...** 或 **警告...** 行
    const warningRegex = /\*{2}(注意[^*]*)\*{2}/g;
    const warnings: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = warningRegex.exec(body)) !== null) {
        warnings.push(match[1].trim());
    }

    return warnings.join('\n');
}

/**
 * 检测平台类型
 */
function detectPlatform(label: string, url: string): QQDownloadLink['platform'] {
    const lowerLabel = label.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if (lowerLabel.includes('win') || lowerUrl.includes('_x64.exe') || lowerUrl.includes('_x86.exe')) {
        return 'windows';
    }
    if (lowerLabel.includes('linux') || lowerUrl.includes('linuxqq')) {
        return 'linux';
    }
    if (lowerLabel.includes('mac') || lowerUrl.includes('.dmg')) {
        return 'mac';
    }
    return 'unknown';
}

/**
 * 检测架构
 */
function detectArch(label: string, url: string): QQDownloadLink['arch'] {
    const lowerLabel = label.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if (lowerLabel.includes('arm64') || lowerLabel.includes('aarch64') ||
        lowerUrl.includes('arm64') || lowerUrl.includes('aarch64')) {
        return 'arm64';
    }
    if (lowerLabel.includes('x64') || lowerLabel.includes('x86_64') ||
        lowerUrl.includes('x64') || lowerUrl.includes('amd64') || lowerUrl.includes('x86_64')) {
        return 'x64';
    }
    return 'unknown';
}

/**
 * 检测包格式
 */
function detectFormat(url: string): QQDownloadLink['format'] {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.exe')) return 'exe';
    if (lowerUrl.endsWith('.deb')) return 'deb';
    if (lowerUrl.endsWith('.rpm')) return 'rpm';
    if (lowerUrl.endsWith('.dmg')) return 'dmg';
    return 'unknown';
}

/**
 * 检测 Linux 包安装器类型（参考 NapCat-Installer 的 detect_package_manager）
 * dpkg → 应使用 .deb 包
 * rpm  → 应使用 .rpm 包
 */
function detectPreferredFormat(): 'deb' | 'rpm' | null {
    if (process.platform !== 'linux') return null;
    try {
        const { execSync } = require('child_process');
        try {
            execSync('which dpkg', { stdio: 'ignore' });
            return 'deb';
        } catch { /* ignore */ }
        try {
            execSync('which rpm', { stdio: 'ignore' });
            return 'rpm';
        } catch { /* ignore */ }
    } catch { /* ignore */ }
    return null;
}

/**
 * 获取与当前平台匹配的下载链接
 * 参考 NapCat-Installer：根据系统包管理器自动选择最合适的单个安装包
 * - Linux: 检测 dpkg/rpm，只返回对应格式的包
 * - Windows/Mac: 返回对应平台的包
 */
export function filterLinksForCurrentPlatform(links: QQDownloadLink[]): QQDownloadLink[] {
    const { platform, arch } = getCurrentPlatform();

    let targetPlatform: QQDownloadLink['platform'] = 'unknown';
    let targetArch: QQDownloadLink['arch'] = 'unknown';

    // 映射 Node.js 平台到我们的平台类型
    if (platform === 'win32') targetPlatform = 'windows';
    else if (platform === 'linux') targetPlatform = 'linux';
    else if (platform === 'darwin') targetPlatform = 'mac';

    // 映射架构
    if (arch === 'x64' || arch === 'x86_64') targetArch = 'x64';
    else if (arch === 'arm64' || arch === 'aarch64') targetArch = 'arm64';

    // 先按平台和架构过滤
    let filtered = links.filter(link => {
        if (link.platform !== targetPlatform) return false;
        if (targetArch !== 'unknown' && link.arch !== 'unknown' && link.arch !== targetArch) return false;
        return true;
    });

    // Linux 平台：根据包管理器自动选择最合适的格式，只返回一个
    if (targetPlatform === 'linux' && filtered.length > 1) {
        const preferredFormat = detectPreferredFormat();
        if (preferredFormat) {
            const preferred = filtered.filter(link => link.format === preferredFormat);
            if (preferred.length > 0) {
                filtered = [preferred[0]];
            } else {
                // 没有匹配的格式，取第一个
                filtered = [filtered[0]];
            }
        } else {
            // 无法检测包管理器，默认取第一个
            filtered = [filtered[0]];
        }
    }

    // Windows/Mac 也只返回最合适的一个
    if ((targetPlatform === 'windows' || targetPlatform === 'mac') && filtered.length > 1) {
        filtered = [filtered[0]];
    }

    return filtered;
}

/**
 * 获取完整的版本匹配结果
 * 这是主要的对外接口
 */
export async function getVersionMatchResult(ctx: NapCatPluginContext): Promise<VersionMatchResult | null> {
    const release = await fetchMatchingRelease();
    if (!release) return null;

    const qqInfo = getCurrentQQInfo(ctx);
    const allLinks = parseDownloadLinks(release.body);
    const versionWarning = parseVersionWarning(release.body);

    return {
        napcatVersion: getNapCatVersion(),
        releaseTag: release.tag_name,
        publishedAt: release.published_at,
        releaseUrl: release.html_url,
        currentQQVersion: qqInfo.version,
        currentQQBuild: qqInfo.build,
        downloadLinks: allLinks,
        versionWarning
    };
}

/**
 * 获取当前平台推荐的下载链接
 */
export async function getRecommendedLinks(ctx: NapCatPluginContext): Promise<{
    result: VersionMatchResult | null;
    recommended: QQDownloadLink[];
}> {
    const result = await getVersionMatchResult(ctx);
    if (!result) return { result: null, recommended: [] };

    const recommended = filterLinksForCurrentPlatform(result.downloadLinks);
    return { result, recommended };
}

/**
 * 清除缓存（用于手动刷新）
 */
export function clearCache(): void {
    releaseCache = { data: null, timestamp: 0, version: '' };
    pluginState.logDebug('Release 缓存已清除');
}
