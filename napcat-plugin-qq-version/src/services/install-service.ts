/**
 * QQ 安装服务模块
 * 参考 NapCat-Installer 项目实现
 * 
 * - Linux (rootless): 下载 QQ 安装包 → dpkg -x / rpm2cpio 解压到 ~/Napcat/ → 更新版本配置
 * - Linux (系统级): 下载 QQ 安装包 → apt-get/dnf 安装 → 更新版本配置
 * - Windows/Mac: 不支持自动安装，返回下载链接提示用户手动安装
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import type { InstallProgress, InstallStage, QQDownloadLink, QQInstallInfo } from '../types';

// ==================== 安装进度管理 ====================

let installProgress: InstallProgress = {
    stage: 'idle',
    percent: 0,
    message: '就绪',
};

let installRunning = false;

/** 获取安装进度 */
export function getInstallProgress(): InstallProgress {
    return { ...installProgress };
}

/** 重置安装进度 */
export function resetInstallProgress(): void {
    installProgress = { stage: 'idle', percent: 0, message: '就绪' };
    installRunning = false;
}

/** 是否有安装任务正在运行 */
export function isInstallRunning(): boolean {
    return installRunning;
}

/** 更新安装进度 */
function updateProgress(stage: InstallStage, percent: number, message: string, extra?: Partial<InstallProgress>): void {
    installProgress = { stage, percent, message, ...extra };
    pluginState.logDebug(`安装进度: [${stage}] ${percent}% - ${message}`);
}

// ==================== 平台检测工具 ====================

/** 检测 Linux 包安装器类型 */
function detectPackageInstaller(): 'dpkg' | 'rpm' | 'none' {
    try {
        execSync('which dpkg', { stdio: 'ignore' });
        return 'dpkg';
    } catch {
        // ignore
    }
    try {
        execSync('which rpm', { stdio: 'ignore' });
        return 'rpm';
    } catch {
        // ignore
    }
    return 'none';
}

/** 检测 Linux 包管理器类型 */
function detectPackageManager(): 'apt-get' | 'dnf' | 'none' {
    try {
        execSync('which apt-get', { stdio: 'ignore' });
        return 'apt-get';
    } catch {
        // ignore
    }
    try {
        execSync('which dnf', { stdio: 'ignore' });
        return 'dnf';
    } catch {
        // ignore
    }
    return 'none';
}

/** 检测系统架构 */
function getSystemArch(): 'amd64' | 'arm64' | 'unknown' {
    const arch = process.arch;
    if (arch === 'x64') return 'amd64';
    if (arch === 'arm64') return 'arm64';
    return 'unknown';
}

/** 检测是否有 sudo 权限 */
function hasSudo(): boolean {
    try {
        execSync('sudo -n true 2>/dev/null', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** 检测是否为 root 用户 */
function isRoot(): boolean {
    try {
        return process.getuid?.() === 0;
    } catch {
        return false;
    }
}

/** 获取 sudo 前缀 */
function sudoPrefix(): string {
    if (isRoot()) return '';
    if (hasSudo()) return 'sudo ';
    return '';
}

// ==================== Docker 环境检测 ====================

/** Docker 容器中 QQ 的安装路径 */
const DOCKER_QQ_PATH = '/opt/QQ';
/** Docker 容器中 NapCat 的路径 */
const DOCKER_NAPCAT_PATH = '/app/napcat';
/** Docker 容器中 QQ 数据目录 */
const DOCKER_QQ_DATA_PATH = '/app/.config/QQ';

/**
 * 检测当前是否运行在 Docker 容器中
 * 通过多种方式检测：
 * 1. /.dockerenv 文件存在
 * 2. /proc/1/cgroup 包含 docker/containerd 关键字
 * 3. 环境变量 NAPCAT_UID 存在（NapCat-Docker 特有）
 * 4. /app/napcat 目录存在且 /opt/QQ 目录存在（NapCat-Docker 目录结构）
 */
function isDockerEnvironment(): boolean {
    try {
        // 方式1: 检查 /.dockerenv
        if (fs.existsSync('/.dockerenv')) return true;

        // 方式2: 检查 /proc/1/cgroup
        try {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
            if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
                return true;
            }
        } catch { /* ignore */ }

        // 方式3: 检查 NapCat-Docker 特有的环境变量
        if (process.env.NAPCAT_UID !== undefined || process.env.NAPCAT_GID !== undefined) {
            return true;
        }

        // 方式4: 检查 NapCat-Docker 特有的目录结构
        if (fs.existsSync(DOCKER_NAPCAT_PATH) && fs.existsSync(DOCKER_QQ_PATH) &&
            fs.existsSync(path.join(DOCKER_NAPCAT_PATH, 'napcat.mjs'))) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/** 缓存 Docker 检测结果 */
let _isDocker: boolean | null = null;
function isDocker(): boolean {
    if (_isDocker === null) {
        _isDocker = isDockerEnvironment();
    }
    return _isDocker;
}

// ==================== Rootless 模式检测 ====================

/**
 * Rootless 安装路径常量
 * 参考 NapCat-Installer: INSTALL_BASE_DIR="$HOME/Napcat"
 */
function getRootlessBaseDir(): string {
    const homeDir = process.env.HOME || '';
    return homeDir ? path.join(homeDir, 'Napcat') : '';
}

/**
 * 检测当前 QQ 是否运行在 rootless 模式
 * 通过检查 ~/Napcat/opt/QQ/ 目录是否存在来判断
 * 注意：Docker 环境不算 rootless 模式
 */
function isRootlessMode(): boolean {
    if (isDocker()) return false;
    const baseDir = getRootlessBaseDir();
    if (!baseDir) return false;
    const qqPath = path.join(baseDir, 'opt', 'QQ', 'qq');
    const packageJsonPath = path.join(baseDir, 'opt', 'QQ', 'resources', 'app', 'package.json');
    return fs.existsSync(qqPath) || fs.existsSync(packageJsonPath);
}

// ==================== 非入侵式模式检测 ====================

/**
 * 检测当前是否为非入侵式启动模式
 * 非入侵式模式通过 LD_PRELOAD=libnapcat_launcher.so 注入 NapCat，
 * 不修改 QQ 的 package.json 和 loadNapCat.js。
 * 
 * 检测方式：
 * 1. 检查 LD_PRELOAD 环境变量是否包含 libnapcat_launcher
 * 2. 检查 NapCat 所在目录（cwd 或 napcat 同级）是否存在 libnapcat_launcher.so
 * 3. 检查 /opt/QQ 存在但 package.json 的 main 未被修改为 loadNapCat.js
 */
function isNonInvasiveMode(): boolean {
    if (isDocker()) return false;
    if (isRootlessMode()) return false;

    try {
        // 方式1: 检查 LD_PRELOAD 环境变量
        const ldPreload = process.env.LD_PRELOAD || '';
        if (ldPreload.includes('libnapcat_launcher')) {
            return true;
        }

        // 方式2: 检查 cwd 或 napcat 同级目录下是否存在 libnapcat_launcher.so
        const cwd = process.cwd();
        const possibleSoPaths = [
            path.join(cwd, 'libnapcat_launcher.so'),
            path.join(cwd, '..', 'libnapcat_launcher.so'),
        ];

        // 如果 configPath 可用，也检查其附近
        if (pluginState.dataPath) {
            possibleSoPaths.push(
                path.join(pluginState.dataPath, '..', '..', 'libnapcat_launcher.so'),
                path.join(pluginState.dataPath, '..', '..', '..', 'libnapcat_launcher.so'),
            );
        }

        for (const soPath of possibleSoPaths) {
            try {
                if (fs.existsSync(soPath)) {
                    return true;
                }
            } catch { /* ignore */ }
        }

        // 方式3: 检查 /opt/QQ 存在但 package.json 的 main 未指向 loadNapCat.js
        // 这说明 QQ 是系统级安装的，但没有被入侵式修改
        const systemPackageJson = '/opt/QQ/resources/app/package.json';
        if (fs.existsSync(systemPackageJson)) {
            try {
                const pkgContent = JSON.parse(fs.readFileSync(systemPackageJson, 'utf-8'));
                // 如果 main 不是 loadNapCat.js，说明没有被入侵式修改
                // 同时 NapCat 正在运行（因为插件能加载），所以一定是非入侵式
                if (pkgContent.main && !pkgContent.main.includes('loadNapCat')) {
                    return true;
                }
            } catch { /* ignore */ }
        }

        return false;
    } catch {
        return false;
    }
}

/** 缓存非入侵式检测结果 */
let _isNonInvasive: boolean | null = null;
function isNonInvasive(): boolean {
    if (_isNonInvasive === null) {
        _isNonInvasive = isNonInvasiveMode();
    }
    return _isNonInvasive;
}

/**
 * 获取当前 NapCat 启动模式
 */
function getLaunchMode(): import('../types').LaunchMode {
    if (isDocker()) return 'docker';
    if (isNonInvasive()) return 'non-invasive';
    if (isRootlessMode()) return 'invasive';
    // 系统级安装且 package.json 被修改也是入侵式
    if (process.platform === 'linux') return 'invasive';
    return 'unknown';
}

/**
 * 从下载链接 URL 中解析 QQ 版本号
 * 例如: https://dldir1.qq.com/qqfile/qq/QQNT/xxx/linuxqq_3.2.25-45758_amd64.deb
 * 提取: 3.2.25-45758
 */
function parseVersionFromUrl(url: string): string | null {
    // 匹配 linuxqq_版本号_架构.格式
    const match = url.match(/linuxqq_([\d.]+-\d+)_/);
    if (match) return match[1];
    // 也尝试匹配 QQ-版本号 格式
    const match2 = url.match(/QQ[_-]([\d.]+-\d+)/i);
    if (match2) return match2[1];
    return null;
}

// ==================== QQ 版本配置更新 ====================

/**
 * 获取 QQ 版本配置目录的候选路径列表
 * Docker 环境: /app/.config/QQ/versions/
 * 普通环境: ~/.config/QQ/versions/
 */
function getQQVersionConfigPaths(): string[] {
    const paths: string[] = [];

    // Docker 环境优先检查 /app/.config/QQ
    if (isDocker()) {
        const dockerConfigDir = path.join(DOCKER_QQ_DATA_PATH, 'versions');
        paths.push(dockerConfigDir);
    }

    // 普通环境检查 ~/.config/QQ
    const homeDir = process.env.HOME || '';
    if (homeDir) {
        paths.push(path.join(homeDir, '.config', 'QQ', 'versions'));
    }

    return paths;
}

/**
 * 更新用户 QQ 版本配置文件
 * 参考 NapCat-Installer 的 update_linuxqq_config 函数
 * 
 * 修改 config.json 中的:
 * - baseVersion: 目标版本号
 * - curVersion: 目标版本号
 * - buildId: 构建号（版本号中 - 后面的数字）
 * 
 * Docker 环境: /app/.config/QQ/versions/config.json
 * 普通环境: ~/.config/QQ/versions/config.json
 */
function updateLinuxQQConfig(targetVersion: string): void {
    const buildId = targetVersion.split('-').pop() || '';
    const configPaths = getQQVersionConfigPaths();

    if (configPaths.length === 0) {
        pluginState.log('warn', '无法获取 QQ 版本配置路径，跳过版本配置更新');
        return;
    }

    let updated = false;

    for (const configDir of configPaths) {
        const configFile = path.join(configDir, 'config.json');

        if (!fs.existsSync(configDir)) {
            pluginState.logDebug(`版本配置目录不存在: ${configDir}，跳过`);
            continue;
        }

        if (!fs.existsSync(configFile)) {
            pluginState.logDebug(`版本配置文件不存在: ${configFile}，跳过`);
            continue;
        }

        try {
            pluginState.log('info', `正在更新 QQ 版本配置: ${configFile}`);
            pluginState.logDebug(`目标版本: ${targetVersion}, buildId: ${buildId}`);

            const configContent = fs.readFileSync(configFile, 'utf-8');
            const config = JSON.parse(configContent);

            config.baseVersion = targetVersion;
            config.curVersion = targetVersion;
            config.buildId = buildId;

            fs.writeFileSync(configFile, JSON.stringify(config, null, 4), 'utf-8');
            pluginState.log('info', `QQ 版本配置已更新: baseVersion=${targetVersion}, buildId=${buildId}`);
            updated = true;
        } catch (e) {
            pluginState.log('warn', `更新 QQ 版本配置失败 (${configFile}):`, e);
        }
    }

    if (!updated) {
        pluginState.log('warn', '未找到任何可更新的 QQ 版本配置文件，QQ 首次启动时会自动创建');
    }
}

// ==================== QQ 安装信息 ====================

/**
 * 获取 QQ 安装信息
 */
export function getQQInstallInfo(ctx: NapCatPluginContext): QQInstallInfo {
    const platform = process.platform;
    const arch = process.arch;

    let execPath = '';
    let installDir = '';
    let version = 'unknown';
    let build = 'unknown';

    try {
        const basicInfo = ctx.core.context.basicInfoWrapper;
        version = basicInfo.getFullQQVersion() || 'unknown';
        build = basicInfo.getQQBuildStr() || 'unknown';
    } catch {
        // ignore
    }

    // 尝试获取 QQ 可执行文件路径
    if (platform === 'linux') {
        // 优先检查 Docker 环境（/opt/QQ + /app/napcat）
        if (isDocker()) {
            const dockerQQPath = path.join(DOCKER_QQ_PATH, 'qq');
            if (fs.existsSync(dockerQQPath)) {
                execPath = dockerQQPath;
                installDir = DOCKER_QQ_PATH;
            } else if (fs.existsSync(DOCKER_QQ_PATH)) {
                installDir = DOCKER_QQ_PATH;
            }
        }
        // 再检查 rootless 安装路径（~/Napcat/opt/QQ/）
        if (!execPath) {
            const homeDir = process.env.HOME || '';
            if (homeDir) {
                const rootlessPath = path.join(homeDir, 'Napcat', 'opt', 'QQ', 'qq');
                if (fs.existsSync(rootlessPath)) {
                    execPath = rootlessPath;
                    installDir = path.dirname(rootlessPath);
                }
            }
        }
        // 再检查系统级安装路径
        if (!execPath) {
            const possiblePaths = ['/opt/QQ/qq', '/usr/share/qq/qq'];
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    execPath = p;
                    installDir = path.dirname(p);
                    break;
                }
            }
        }
    } else if (platform === 'win32') {
        // Windows 常见路径
        const possiblePaths = [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'QQ', 'QQ.exe'),
            path.join(process.env.ProgramFiles || '', 'Tencent', 'QQ', 'QQ.exe'),
            'C:\\Program Files\\Tencent\\QQ\\QQ.exe',
            'C:\\Program Files (x86)\\Tencent\\QQ\\QQ.exe',
        ];
        for (const p of possiblePaths) {
            if (p && fs.existsSync(p)) {
                execPath = p;
                installDir = path.dirname(p);
                break;
            }
        }
    } else if (platform === 'darwin') {
        if (fs.existsSync('/Applications/QQ.app')) {
            execPath = '/Applications/QQ.app';
            installDir = '/Applications';
        }
    }

    let platformStr: string;
    if (platform === 'win32') platformStr = 'windows';
    else if (platform === 'darwin') platformStr = 'mac';
    else platformStr = platform;

    return {
        execPath,
        installDir,
        version,
        build,
        platform: platformStr,
        arch,
        isRootless: platform === 'linux' ? isRootlessMode() : false,
        isDocker: isDocker(),
        launchMode: getLaunchMode(),
    };
}

// ==================== 文件下载 ====================

/**
 * 下载文件到指定路径，支持进度回调和重定向
 */
function downloadFile(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number, speed: number) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl: string, redirectCount = 0) => {
            if (redirectCount > 5) {
                reject(new Error('重定向次数过多'));
                return;
            }

            const client = requestUrl.startsWith('https') ? https : http;
            const req = client.get(requestUrl, (res) => {
                // 处理重定向
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    doRequest(res.headers.location, redirectCount + 1);
                    return;
                }

                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastTime = Date.now();
                let lastBytes = 0;

                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);

                res.on('data', (chunk: Buffer) => {
                    downloadedBytes += chunk.length;
                    const now = Date.now();
                    const elapsed = (now - lastTime) / 1000;
                    if (elapsed >= 0.5 && onProgress) {
                        const speed = (downloadedBytes - lastBytes) / elapsed;
                        onProgress(downloadedBytes, totalBytes, speed);
                        lastTime = now;
                        lastBytes = downloadedBytes;
                    }
                });

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });

                fileStream.on('error', (err) => {
                    fs.unlink(destPath, () => { /* ignore */ });
                    reject(err);
                });
            });

            req.on('error', (err) => {
                fs.unlink(destPath, () => { /* ignore */ });
                reject(err);
            });

            req.setTimeout(60000, () => {
                req.destroy(new Error('下载超时'));
            });
        };

        doRequest(url);
    });
}

// ==================== Linux 安装逻辑 ====================

/**
 * 在 Linux 上以 Rootless 模式安装 QQ
 * 参考 NapCat-Installer 的 install_linuxqq_rootless 逻辑
 * 
 * 核心思路：只更新 QQ 文件，不动 NapCat
 * 1. 下载 deb/rpm 包
 * 2. 解压到临时目录
 * 3. 用 cp -rf 将解压出的 QQ 文件覆盖到 ~/Napcat/（NapCat 文件不受影响）
 * 4. 更新 ~/.config/QQ/versions/config.json 版本配置
 */
async function installOnLinuxRootless(link: QQDownloadLink): Promise<void> {
    const arch = getSystemArch();
    if (arch === 'unknown') {
        throw new Error('不支持的系统架构');
    }

    const packageInstaller = detectPackageInstaller();

    // 验证下载链接格式与当前系统匹配
    if (link.format === 'deb' && packageInstaller !== 'dpkg') {
        throw new Error('当前系统不支持 deb 包解压（未检测到 dpkg）');
    }
    if (link.format === 'rpm') {
        // rpm 模式需要 rpm2cpio 和 cpio
        try {
            execSync('which rpm2cpio', { stdio: 'ignore' });
            execSync('which cpio', { stdio: 'ignore' });
        } catch {
            throw new Error('当前系统不支持 rpm 包解压（未检测到 rpm2cpio/cpio）');
        }
    }
    if (link.format !== 'deb' && link.format !== 'rpm') {
        throw new Error(`不支持的安装包格式: ${link.format}，Linux 仅支持 deb/rpm`);
    }

    const baseDir = getRootlessBaseDir();
    if (!baseDir) {
        throw new Error('无法获取 HOME 目录，无法确定 rootless 安装路径');
    }

    const tmpDir = '/tmp/napcat-qq-install';
    const extractDir = path.join(tmpDir, 'extract');  // 解压到临时子目录
    const pkgFileName = link.format === 'deb' ? 'QQ.deb' : 'QQ.rpm';
    const pkgFilePath = path.join(tmpDir, pkgFileName);

    // 从 URL 中解析版本号
    const targetVersion = parseVersionFromUrl(link.url);
    pluginState.logDebug(`从下载链接解析到版本号: ${targetVersion || '未知'}`);

    try {
        // 创建临时目录
        execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        fs.mkdirSync(extractDir, { recursive: true });

        // ===== 阶段1: 下载 =====
        updateProgress('downloading', 5, '开始下载 QQ 安装包...', {
            downloadedBytes: 0,
            totalBytes: 0,
            speed: 0,
        });

        await downloadFile(link.url, pkgFilePath, (downloaded, total, speed) => {
            const percent = total > 0 ? Math.min(Math.round((downloaded / total) * 50) + 5, 55) : 10;
            updateProgress('downloading', percent, '正在下载 QQ 安装包...', {
                downloadedBytes: downloaded,
                totalBytes: total,
                speed,
            });
        });

        // 验证文件是否下载成功
        if (!fs.existsSync(pkgFilePath)) {
            throw new Error('安装包下载失败：文件不存在');
        }

        const fileStats = fs.statSync(pkgFilePath);
        if (fileStats.size < 1024 * 100) {
            throw new Error('安装包下载失败：文件过小，可能下载不完整');
        }

        updateProgress('downloading', 55, '下载完成');

        // ===== 阶段2: 解压到临时目录 =====
        updateProgress('extracting', 58, '正在解压 QQ 安装包...');

        if (link.format === 'deb') {
            pluginState.log('info', `使用 dpkg -x 解压 deb 包到临时目录...`);
            execSync(`dpkg -x "${pkgFilePath}" "${extractDir}"`, {
                stdio: 'pipe',
                timeout: 300000,
            });
        } else if (link.format === 'rpm') {
            pluginState.log('info', `使用 rpm2cpio 解压 rpm 包到临时目录...`);
            execSync(`rpm2cpio "${pkgFilePath}" | (cd "${extractDir}" && cpio -idmv)`, {
                stdio: 'pipe',
                timeout: 300000,
                shell: '/bin/bash',
            });
        }

        // 验证解压结果：检查 opt/QQ 目录是否存在
        const extractedQQDir = path.join(extractDir, 'opt', 'QQ');
        if (!fs.existsSync(extractedQQDir)) {
            throw new Error('解压失败：未找到 opt/QQ 目录');
        }

        updateProgress('extracting', 65, '解压完成');

        // ===== 阶段3: 覆盖 QQ 文件到 ~/Napcat/（不动 NapCat） =====
        updateProgress('installing', 70, '正在更新 QQ 文件（不影响 NapCat）...');

        // 确保目标目录存在
        fs.mkdirSync(baseDir, { recursive: true });

        // 使用 cp -rf 将解压出的文件覆盖到 ~/Napcat/
        // 这会覆盖 QQ 自身的文件，NapCat 注入的文件（如 napcat/ 目录）不会被删除
        // 但 package.json 会被原版覆盖，需要后续重新修补
        pluginState.log('info', `正在将 QQ 文件覆盖到 ${baseDir}...`);
        execSync(`cp -rf "${extractDir}/." "${baseDir}/"`, {
            stdio: 'pipe',
            timeout: 120000,
        });

        updateProgress('installing', 82, '文件覆盖完成');

        // ===== 阶段4: 重新修补 NapCat 启动配置 =====
        // cp -rf 会用原版 package.json 覆盖 NapCat 修改过的版本
        // 需要重新将 main 指向 loadNapCat.js，参考 NapCat-Installer 的 modify_qq_config
        updateProgress('installing', 84, '正在修补 NapCat 启动配置...');
        const qqBasePath = path.join(baseDir, 'opt', 'QQ');
        const packageJsonPath = path.join(qqBasePath, 'resources', 'app', 'package.json');
        const targetFolder = path.join(qqBasePath, 'resources', 'app', 'app_launcher');
        const loadNapCatPath = path.join(qqBasePath, 'resources', 'app', 'loadNapCat.js');

        // 从实际安装的 package.json 中读取真实版本号（比从 URL 解析更可靠）
        let actualVersion = targetVersion;
        try {
            if (fs.existsSync(packageJsonPath)) {
                const pkgContent = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                if (pkgContent.version) {
                    actualVersion = pkgContent.version;
                    pluginState.log('info', `从 package.json 读取到实际 QQ 版本: ${actualVersion}`);
                }

                // 修改 package.json 的 main 字段指向 loadNapCat.js
                pkgContent.main = './loadNapCat.js';
                fs.writeFileSync(packageJsonPath, JSON.stringify(pkgContent, null, 4), 'utf-8');
                pluginState.log('info', 'package.json 已修补: main -> ./loadNapCat.js');
            } else {
                pluginState.log('warn', `package.json 不存在: ${packageJsonPath}`);
            }

            // 确保 loadNapCat.js 存在（如果被覆盖或丢失则重新生成）
            if (!fs.existsSync(loadNapCatPath)) {
                const loadScript = `(async () => {await import('file:///${targetFolder}/napcat/napcat.mjs');})();`;
                fs.writeFileSync(loadNapCatPath, loadScript, 'utf-8');
                pluginState.log('info', 'loadNapCat.js 已重新生成');
            } else {
                pluginState.log('info', 'loadNapCat.js 已存在，无需重新生成');
            }
        } catch (e) {
            pluginState.log('warn', '修补 NapCat 启动配置失败:', e);
        }

        // ===== 阶段5: 更新版本配置 =====
        updateProgress('installing', 88, '正在更新版本配置...');
        if (actualVersion) {
            updateLinuxQQConfig(actualVersion);
        } else {
            pluginState.log('warn', '无法获取 QQ 版本号，跳过版本配置更新');
        }

        // ===== 阶段5: 清理 =====
        updateProgress('installing', 93, '正在清理临时文件...');
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch {
            // 清理失败不影响安装结果
        }

        // ===== 阶段6: 完成 =====
        updateProgress('done', 100, 'QQ 安装完成！重启 NapCat 后生效。', {
            finishedAt: Date.now(),
        });

        pluginState.log('info', `QQ Rootless 更新完成，安装路径: ${baseDir}`);

    } catch (err) {
        // 清理临时文件
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch { /* ignore */ }

        const errMsg = err instanceof Error ? err.message : String(err);
        updateProgress('error', 0, '安装失败', { error: errMsg });
        throw err;
    }
}

/**
 * 在 Linux 上以系统级方式安装 QQ
 * 使用 apt-get / dnf 等包管理器安装
 */
async function installOnLinuxSystem(link: QQDownloadLink): Promise<void> {
    const arch = getSystemArch();
    if (arch === 'unknown') {
        throw new Error('不支持的系统架构');
    }

    const packageInstaller = detectPackageInstaller();
    const packageManager = detectPackageManager();

    // 验证下载链接格式与当前系统匹配
    if (link.format === 'deb' && packageInstaller !== 'dpkg') {
        throw new Error('当前系统不支持 deb 包安装（未检测到 dpkg）');
    }
    if (link.format === 'rpm' && packageInstaller !== 'rpm') {
        throw new Error('当前系统不支持 rpm 包安装（未检测到 rpm）');
    }
    if (link.format !== 'deb' && link.format !== 'rpm') {
        throw new Error(`不支持的安装包格式: ${link.format}，Linux 仅支持 deb/rpm`);
    }

    const tmpDir = '/tmp/napcat-qq-install';
    const pkgFileName = link.format === 'deb' ? 'QQ.deb' : 'QQ.rpm';
    const pkgFilePath = path.join(tmpDir, pkgFileName);

    // 从 URL 中解析版本号
    const targetVersion = parseVersionFromUrl(link.url);

    try {
        // 创建临时目录
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        // ===== 阶段1: 下载 =====
        updateProgress('downloading', 5, '开始下载 QQ 安装包...', {
            downloadedBytes: 0,
            totalBytes: 0,
            speed: 0,
        });

        await downloadFile(link.url, pkgFilePath, (downloaded, total, speed) => {
            const percent = total > 0 ? Math.min(Math.round((downloaded / total) * 50) + 5, 55) : 10;
            updateProgress('downloading', percent, '正在下载 QQ 安装包...', {
                downloadedBytes: downloaded,
                totalBytes: total,
                speed,
            });
        });

        // 验证文件是否下载成功
        if (!fs.existsSync(pkgFilePath)) {
            throw new Error('安装包下载失败：文件不存在');
        }

        const fileStats = fs.statSync(pkgFilePath);
        if (fileStats.size < 1024 * 100) {
            throw new Error('安装包下载失败：文件过小，可能下载不完整');
        }

        updateProgress('downloading', 55, '下载完成');

        // ===== 阶段2: 安装 =====
        updateProgress('installing', 60, '正在安装 QQ...');

        const sudo = sudoPrefix();

        if (link.format === 'deb') {
            // 始终使用 dpkg -i 安装 deb 包，再用 apt-get -f 修复依赖
            // 不能直接 apt-get install "path.deb"，因为 NapCat 进程输出会干扰 apt 的 file method 通信
            pluginState.log('info', '使用 dpkg -i 安装 deb 包...');
            try {
                execSync(`${sudo}dpkg -i "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            } catch (e) {
                // dpkg -i 可能因依赖缺失返回非零退出码，这是正常的
                pluginState.log('info', 'dpkg -i 完成（可能有依赖警告，将通过 apt-get -f 修复）');
            }
            updateProgress('installing', 80, 'deb 包安装完成');

            // 修复依赖
            updateProgress('installing', 85, '正在修复依赖...');
            try {
                if (packageManager === 'apt-get') {
                    execSync(`${sudo}apt-get install -y -f`, { stdio: 'pipe', timeout: 120000 });
                    try {
                        execSync(`${sudo}apt-get install -y libnss3 libgbm1`, { stdio: 'pipe', timeout: 60000 });
                    } catch { /* 非关键依赖，忽略 */ }
                    try {
                        execSync(`${sudo}apt-get install -y libasound2 || ${sudo}apt-get install -y libasound2t64`, { stdio: 'pipe', timeout: 60000 });
                    } catch { /* 非关键依赖，忽略 */ }
                }
            } catch (e) {
                pluginState.log('warn', '安装依赖时出现警告:', e);
            }
        } else if (link.format === 'rpm') {
            if (packageManager === 'dnf') {
                pluginState.log('info', '使用 dnf 安装 rpm 包...');
                execSync(`${sudo}dnf localinstall -y "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            } else {
                pluginState.log('info', '使用 rpm 安装 rpm 包...');
                execSync(`${sudo}rpm -Uvh --force "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            }
            updateProgress('installing', 85, 'rpm 包安装完成');
        }

        // ===== 阶段3: 更新版本配置 =====
        updateProgress('installing', 88, '正在更新版本配置...');
        if (targetVersion) {
            updateLinuxQQConfig(targetVersion);
        }

        updateProgress('installing', 90, '正在清理临时文件...');

        // 清理（使用 shell rm -rf 避免 Electron .asar 文件导致 fs.rmSync 报错）
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch {
            // 清理失败不影响安装结果
        }

        // ===== 阶段4: 完成 =====
        updateProgress('done', 100, 'QQ 安装完成！重启 NapCat 后生效。', {
            finishedAt: Date.now(),
        });

        pluginState.log('info', 'QQ 系统级安装完成');

    } catch (err) {
        // 清理临时文件（使用 shell rm -rf 避免 .asar 问题）
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch { /* ignore */ }

        const errMsg = err instanceof Error ? err.message : String(err);
        updateProgress('error', 0, '安装失败', { error: errMsg });
        throw err;
    }
}

// ==================== 非入侵式安装逻辑 ====================

/**
 * 在非入侵式模式下安装/更新 QQ
 * 参考 napcat-linux-installer 项目
 * 
 * 非入侵式模式特点：
 * - QQ 通过系统包管理器安装在 /opt/QQ（dpkg -i / dnf install）
 * - NapCat 在当前工作目录的 ./napcat/ 下
 * - 通过 LD_PRELOAD=./libnapcat_launcher.so qq 启动
 * - 不修改 QQ 的 package.json 和 loadNapCat.js
 * 
 * 安装流程（与系统级安装相同，但不需要修补 NapCat 启动配置）：
 * 1. 下载 deb/rpm 包
 * 2. 使用 apt-get/dnf/dpkg 安装
 * 3. 更新版本配置
 * （无需修补 package.json / loadNapCat.js，因为非入侵式不依赖它们）
 */
async function installOnLinuxNonInvasive(link: QQDownloadLink): Promise<void> {
    const arch = getSystemArch();
    if (arch === 'unknown') {
        throw new Error('不支持的系统架构');
    }

    const packageInstaller = detectPackageInstaller();
    const packageManager = detectPackageManager();

    // 验证下载链接格式与当前系统匹配
    if (link.format === 'deb' && packageInstaller !== 'dpkg') {
        throw new Error('当前系统不支持 deb 包安装（未检测到 dpkg）');
    }
    if (link.format === 'rpm' && packageInstaller !== 'rpm') {
        throw new Error('当前系统不支持 rpm 包安装（未检测到 rpm）');
    }
    if (link.format !== 'deb' && link.format !== 'rpm') {
        throw new Error(`不支持的安装包格式: ${link.format}，Linux 仅支持 deb/rpm`);
    }

    const tmpDir = '/tmp/napcat-qq-install';
    const pkgFileName = link.format === 'deb' ? 'QQ.deb' : 'QQ.rpm';
    const pkgFilePath = path.join(tmpDir, pkgFileName);

    // 从 URL 中解析版本号
    const targetVersion = parseVersionFromUrl(link.url);

    try {
        // 创建临时目录
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        // ===== 阶段1: 下载 =====
        updateProgress('downloading', 5, '开始下载 QQ 安装包 (非入侵式)...', {
            downloadedBytes: 0,
            totalBytes: 0,
            speed: 0,
        });

        await downloadFile(link.url, pkgFilePath, (downloaded, total, speed) => {
            const percent = total > 0 ? Math.min(Math.round((downloaded / total) * 50) + 5, 55) : 10;
            updateProgress('downloading', percent, '正在下载 QQ 安装包...', {
                downloadedBytes: downloaded,
                totalBytes: total,
                speed,
            });
        });

        // 验证文件是否下载成功
        if (!fs.existsSync(pkgFilePath)) {
            throw new Error('安装包下载失败：文件不存在');
        }

        const fileStats = fs.statSync(pkgFilePath);
        if (fileStats.size < 1024 * 100) {
            throw new Error('安装包下载失败：文件过小，可能下载不完整');
        }

        updateProgress('downloading', 55, '下载完成');

        // ===== 阶段2: 安装 =====
        updateProgress('installing', 60, '正在安装 QQ (非入侵式，不修改 QQ 启动配置)...');

        const sudo = sudoPrefix();

        if (link.format === 'deb') {
            // 始终使用 dpkg -i 安装 deb 包，再用 apt-get -f 修复依赖
            // 不能直接 apt-get install "path.deb"，因为 NapCat 进程输出会干扰 apt 的 file method 通信
            pluginState.log('info', '[非入侵式] 使用 dpkg -i 安装 deb 包...');
            try {
                execSync(`${sudo}dpkg -i "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            } catch (e) {
                // dpkg -i 可能因依赖缺失返回非零退出码，这是正常的
                pluginState.log('info', '[非入侵式] dpkg -i 完成（可能有依赖警告，将通过 apt-get -f 修复）');
            }
            updateProgress('installing', 80, 'deb 包安装完成');

            // 修复依赖
            updateProgress('installing', 85, '正在修复依赖...');
            try {
                if (packageManager === 'apt-get') {
                    execSync(`${sudo}apt-get install -y -f`, { stdio: 'pipe', timeout: 120000 });
                    try {
                        execSync(`${sudo}apt-get install -y libnss3 libgbm1`, { stdio: 'pipe', timeout: 60000 });
                    } catch { /* 非关键依赖，忽略 */ }
                    try {
                        execSync(`${sudo}apt-get install -y libasound2 || ${sudo}apt-get install -y libasound2t64`, { stdio: 'pipe', timeout: 60000 });
                    } catch { /* 非关键依赖，忽略 */ }
                }
            } catch (e) {
                pluginState.log('warn', '[非入侵式] 安装依赖时出现警告:', e);
            }
        } else if (link.format === 'rpm') {
            if (packageManager === 'dnf') {
                pluginState.log('info', '[非入侵式] 使用 dnf 安装 rpm 包...');
                execSync(`${sudo}dnf localinstall -y "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            } else {
                pluginState.log('info', '[非入侵式] 使用 rpm 安装 rpm 包...');
                execSync(`${sudo}rpm -Uvh --force "${pkgFilePath}"`, {
                    stdio: 'pipe',
                    timeout: 300000,
                });
            }
            updateProgress('installing', 85, 'rpm 包安装完成');
        }

        // ===== 阶段3: 更新版本配置 =====
        // 非入侵式模式不需要修补 package.json 和 loadNapCat.js
        pluginState.log('info', '[非入侵式] 无需修补 QQ 启动配置（LD_PRELOAD 模式不依赖 loadNapCat.js）');

        updateProgress('installing', 88, '正在更新版本配置...');
        if (targetVersion) {
            updateLinuxQQConfig(targetVersion);
        }

        updateProgress('installing', 90, '正在清理临时文件...');

        // 清理
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch {
            // 清理失败不影响安装结果
        }

        // ===== 阶段4: 完成 =====
        updateProgress('done', 100, 'QQ 安装完成！重启 NapCat 后生效。', {
            finishedAt: Date.now(),
        });

        pluginState.log('info', '[非入侵式] QQ 系统级安装完成（LD_PRELOAD 模式）');

    } catch (err) {
        // 清理临时文件
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch { /* ignore */ }

        const errMsg = err instanceof Error ? err.message : String(err);
        updateProgress('error', 0, '安装失败', { error: errMsg });
        throw err;
    }
}

// ==================== Docker 安装逻辑 ====================

/**
 * 在 Docker 容器中安装/更新 QQ
 * 参考 NapCat-Docker 的 Dockerfile 和 entrypoint.sh
 * 
 * Docker 环境特点：
 * - QQ 安装在 /opt/QQ（通过 dpkg -i 安装的 deb 包）
 * - NapCat 在 /app/napcat
 * - loadNapCat.js 指向 file:///app/napcat/napcat.mjs
 * - QQ 数据目录在 /app/.config/QQ
 * - 基础镜像基于 Ubuntu，有 dpkg 但可能没有 apt-get
 * 
 * 安装流程：
 * 1. 下载 deb 包
 * 2. 使用 dpkg -x 解压到临时目录（不使用 dpkg -i，避免依赖问题）
 * 3. 将解压出的 /opt/QQ 文件覆盖到 /opt/QQ/
 * 4. 修补 package.json 的 main 指向 loadNapCat.js
 * 5. 确保 loadNapCat.js 正确指向 /app/napcat/napcat.mjs
 * 6. 更新版本配置
 */
async function installOnDocker(link: QQDownloadLink): Promise<void> {
    const arch = getSystemArch();
    if (arch === 'unknown') {
        throw new Error('不支持的系统架构');
    }

    // Docker 环境只支持 deb 格式
    if (link.format !== 'deb') {
        throw new Error(`Docker 环境仅支持 deb 格式安装包，当前格式: ${link.format}`);
    }

    // 验证 dpkg 可用
    const packageInstaller = detectPackageInstaller();
    if (packageInstaller !== 'dpkg') {
        throw new Error('Docker 环境中未检测到 dpkg，无法解压 deb 包');
    }

    const tmpDir = '/tmp/napcat-qq-install';
    const extractDir = path.join(tmpDir, 'extract');
    const pkgFilePath = path.join(tmpDir, 'QQ.deb');

    // 从 URL 中解析版本号
    const targetVersion = parseVersionFromUrl(link.url);
    pluginState.logDebug(`[Docker] 从下载链接解析到版本号: ${targetVersion || '未知'}`);

    try {
        // 创建临时目录
        execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        fs.mkdirSync(extractDir, { recursive: true });

        // ===== 阶段1: 下载 =====
        updateProgress('downloading', 5, '开始下载 QQ 安装包 (Docker)...', {
            downloadedBytes: 0,
            totalBytes: 0,
            speed: 0,
        });

        await downloadFile(link.url, pkgFilePath, (downloaded, total, speed) => {
            const percent = total > 0 ? Math.min(Math.round((downloaded / total) * 50) + 5, 55) : 10;
            updateProgress('downloading', percent, '正在下载 QQ 安装包...', {
                downloadedBytes: downloaded,
                totalBytes: total,
                speed,
            });
        });

        // 验证文件是否下载成功
        if (!fs.existsSync(pkgFilePath)) {
            throw new Error('安装包下载失败：文件不存在');
        }

        const fileStats = fs.statSync(pkgFilePath);
        if (fileStats.size < 1024 * 100) {
            throw new Error('安装包下载失败：文件过小，可能下载不完整');
        }

        updateProgress('downloading', 55, '下载完成');

        // ===== 阶段2: 解压到临时目录 =====
        updateProgress('extracting', 58, '正在解压 QQ 安装包 (dpkg -x)...');

        pluginState.log('info', '[Docker] 使用 dpkg -x 解压 deb 包到临时目录...');
        execSync(`dpkg -x "${pkgFilePath}" "${extractDir}"`, {
            stdio: 'pipe',
            timeout: 300000,
        });

        // 验证解压结果
        const extractedQQDir = path.join(extractDir, 'opt', 'QQ');
        if (!fs.existsSync(extractedQQDir)) {
            throw new Error('解压失败：未找到 opt/QQ 目录');
        }

        updateProgress('extracting', 65, '解压完成');

        // ===== 阶段3: 覆盖 /opt/QQ 文件 =====
        updateProgress('installing', 70, '正在更新 QQ 文件 (Docker /opt/QQ)...');

        // 使用 cp -rf 将解压出的 QQ 文件覆盖到 /opt/QQ/
        const sudo = sudoPrefix();
        pluginState.log('info', `[Docker] 正在将 QQ 文件覆盖到 ${DOCKER_QQ_PATH}...`);
        execSync(`${sudo}cp -rf "${extractedQQDir}/." "${DOCKER_QQ_PATH}/"`, {
            stdio: 'pipe',
            timeout: 120000,
        });

        updateProgress('installing', 82, '文件覆盖完成');

        // ===== 阶段4: 修补 NapCat 启动配置 =====
        // Docker 中 loadNapCat.js 指向 file:///app/napcat/napcat.mjs
        // 参考 NapCat-Docker Dockerfile:
        //   echo "(async () => {await import('file:///app/napcat/napcat.mjs');})();" > /opt/QQ/resources/app/loadNapCat.js
        //   sed -i 's|"main": "[^"]*"|"main": "./loadNapCat.js"|' /opt/QQ/resources/app/package.json
        updateProgress('installing', 84, '正在修补 NapCat 启动配置 (Docker)...');

        const packageJsonPath = path.join(DOCKER_QQ_PATH, 'resources', 'app', 'package.json');
        const loadNapCatPath = path.join(DOCKER_QQ_PATH, 'resources', 'app', 'loadNapCat.js');

        // 从 package.json 读取实际版本号
        let actualVersion = targetVersion;
        try {
            if (fs.existsSync(packageJsonPath)) {
                const pkgContent = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                if (pkgContent.version) {
                    actualVersion = pkgContent.version;
                    pluginState.log('info', `[Docker] 从 package.json 读取到实际 QQ 版本: ${actualVersion}`);
                }

                // 修改 package.json 的 main 字段指向 loadNapCat.js
                pkgContent.main = './loadNapCat.js';
                fs.writeFileSync(packageJsonPath, JSON.stringify(pkgContent, null, 4), 'utf-8');
                pluginState.log('info', '[Docker] package.json 已修补: main -> ./loadNapCat.js');
            } else {
                pluginState.log('warn', `[Docker] package.json 不存在: ${packageJsonPath}`);
            }

            // 重新生成 loadNapCat.js，指向 Docker 中 NapCat 的路径
            const loadScript = `(async () => {await import('file:///${DOCKER_NAPCAT_PATH}/napcat.mjs');})();`;
            fs.writeFileSync(loadNapCatPath, loadScript, 'utf-8');
            pluginState.log('info', `[Docker] loadNapCat.js 已生成，指向 ${DOCKER_NAPCAT_PATH}/napcat.mjs`);
        } catch (e) {
            pluginState.log('warn', '[Docker] 修补 NapCat 启动配置失败:', e);
        }

        // ===== 阶段5: 更新版本配置 =====
        updateProgress('installing', 88, '正在更新版本配置...');
        if (actualVersion) {
            updateLinuxQQConfig(actualVersion);
        } else {
            pluginState.log('warn', '[Docker] 无法获取 QQ 版本号，跳过版本配置更新');
        }

        // ===== 阶段6: 清理 =====
        updateProgress('installing', 93, '正在清理临时文件...');
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch {
            // 清理失败不影响安装结果
        }

        // ===== 阶段7: 完成 =====
        updateProgress('done', 100, 'QQ 安装完成！重启 Docker 容器后生效。', {
            finishedAt: Date.now(),
        });

        pluginState.log('info', `[Docker] QQ 更新完成，安装路径: ${DOCKER_QQ_PATH}`);

    } catch (err) {
        // 清理临时文件
        try {
            execSync(`rm -rf "${tmpDir}"`, { stdio: 'ignore' });
        } catch { /* ignore */ }

        const errMsg = err instanceof Error ? err.message : String(err);
        updateProgress('error', 0, '安装失败', { error: errMsg });
        throw err;
    }
}

// ==================== 主入口 ====================

/**
 * 开始安装 QQ
 * - Docker: dpkg -x 解压覆盖 /opt/QQ + 修补 loadNapCat.js + 更新版本配置
 * - 非入侵式: apt-get/dnf 安装到 /opt/QQ + 更新版本配置（不修补启动配置）
 * - Linux (rootless 入侵式): dpkg -x 解压到 ~/Napcat/ + 修补启动配置 + 更新版本配置
 * - Linux (系统级入侵式): apt-get/dnf 安装 + 更新版本配置
 * - Windows/Mac: 抛出错误，提示用户手动安装
 */
export async function startInstall(ctx: NapCatPluginContext, link: QQDownloadLink): Promise<void> {
    if (installRunning) {
        throw new Error('已有安装任务正在进行中');
    }

    const platform = process.platform;

    // Windows 和 Mac 不支持自动安装
    if (platform === 'win32') {
        throw new Error('Windows 平台不支持自动安装，请手动下载安装');
    }
    if (platform === 'darwin') {
        throw new Error('macOS 平台不支持自动安装，请手动下载安装');
    }

    if (platform !== 'linux') {
        throw new Error(`不支持的平台: ${platform}`);
    }

    installRunning = true;
    resetInstallProgress();

    try {
        const docker = isDocker();
        const nonInvasive = isNonInvasive();
        const rootless = isRootlessMode();

        if (docker) {
            pluginState.log('info', '安装模式: Docker (/opt/QQ + /app/napcat)');
            await installOnDocker(link);
        } else if (nonInvasive) {
            pluginState.log('info', '安装模式: 非入侵式 (LD_PRELOAD, /opt/QQ)');
            await installOnLinuxNonInvasive(link);
        } else if (rootless) {
            pluginState.log('info', '安装模式: Rootless 入侵式 (~/Napcat/)');
            await installOnLinuxRootless(link);
        } else {
            pluginState.log('info', '安装模式: 系统级入侵式 (/opt/QQ/)');
            await installOnLinuxSystem(link);
        }
    } finally {
        installRunning = false;
    }
}
