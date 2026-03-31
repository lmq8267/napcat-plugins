/**
 * 类型定义文件
 * 定义插件所需的所有接口和类型
 */

/**
 * 插件主配置接口
 * 根据你的插件需求添加配置项
 */
export interface PluginConfig {
    /** 调试模式：启用后输出详细日志 */
    debug: boolean;
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
    // TODO: 在这里添加群级别的配置项
}

/**
 * API 响应格式
 */
export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}

// ==================== 消息段类型 ====================

/**
 * 文本消息段
 */
export interface TextSegment {
    type: 'text';
    data: { text: string };
}

/**
 * 图片消息段
 */
export interface ImageSegment {
    type: 'image';
    data: { file: string };
}

/**
 * @消息段
 */
export interface AtSegment {
    type: 'at';
    data: { qq: string };
}

/**
 * 回复消息段
 */
export interface ReplySegment {
    type: 'reply';
    data: { id: string };
}

/**
 * 通用消息段类型
 */
export type MessageSegment = TextSegment | ImageSegment | AtSegment | ReplySegment | { type: string; data: Record<string, unknown> };

/**
 * 合并转发消息节点
 */
export interface ForwardNode {
    type: 'node';
    data: {
        user_id: string;
        nickname: string;
        content: MessageSegment[];
    };
}

// ==================== GitHub Release 相关类型 ====================

/**
 * GitHub Release 信息（精简）
 */
export interface GitHubRelease {
    /** Release 标签名，如 v4.15.17 */
    tag_name: string;
    /** Release 名称 */
    name: string;
    /** Release 说明（Markdown） */
    body: string;
    /** 发布时间 */
    published_at: string;
    /** 是否为预发布 */
    prerelease: boolean;
    /** Release 网页链接 */
    html_url: string;
}

/**
 * QQ 下载链接信息
 */
export interface QQDownloadLink {
    /** 平台描述，如 "9.9.26-44343 X64 Win" */
    label: string;
    /** 下载链接 */
    url: string;
    /** 平台类型 */
    platform: 'windows' | 'linux' | 'mac' | 'unknown';
    /** 架构 */
    arch: 'x64' | 'arm64' | 'unknown';
    /** 包格式 */
    format: 'exe' | 'deb' | 'rpm' | 'dmg' | 'unknown';
}

/**
 * NapCat 版本与 QQ 版本匹配结果
 */
export interface VersionMatchResult {
    /** 当前 NapCat 版本 */
    napcatVersion: string;
    /** 匹配的 Release 标签 */
    releaseTag: string;
    /** Release 发布时间 */
    publishedAt: string;
    /** Release 网页链接 */
    releaseUrl: string;
    /** 当前 QQ 版本 */
    currentQQVersion: string;
    /** 当前 QQ Build 号 */
    currentQQBuild: string;
    /** 推荐的 QQ 下载链接列表 */
    downloadLinks: QQDownloadLink[];
    /** Release body 中的版本警告信息 */
    versionWarning: string;
}

// ==================== QQ 安装相关类型 ====================

/**
 * 安装任务阶段
 */
export type InstallStage = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';

/**
 * 安装任务进度
 */
export interface InstallProgress {
    /** 当前阶段 */
    stage: InstallStage;
    /** 总进度百分比 0-100 */
    percent: number;
    /** 当前阶段描述 */
    message: string;
    /** 下载速度（字节/秒），仅下载阶段有效 */
    speed?: number;
    /** 已下载大小（字节） */
    downloadedBytes?: number;
    /** 文件总大小（字节） */
    totalBytes?: number;
    /** 错误信息（仅 error 阶段） */
    error?: string;
    /** 安装完成时间戳 */
    finishedAt?: number;
}

/**
 * NapCat 启动模式
 * - invasive: 入侵式，修改 QQ 的 package.json 指向 loadNapCat.js
 * - non-invasive: 非入侵式，通过 LD_PRELOAD=libnapcat_launcher.so 注入
 * - docker: Docker 容器模式
 * - unknown: 未知
 */
export type LaunchMode = 'invasive' | 'non-invasive' | 'docker' | 'unknown';

/**
 * QQ 安装路径信息
 */
export interface QQInstallInfo {
    /** QQ 可执行文件路径 */
    execPath: string;
    /** QQ 安装根目录 */
    installDir: string;
    /** 当前 QQ 版本 */
    version: string;
    /** 当前 QQ Build 号 */
    build: string;
    /** 运行平台 */
    platform: string;
    /** 架构 */
    arch: string;
    /** 是否为 rootless 模式（QQ 安装在 ~/Napcat/opt/QQ/） */
    isRootless: boolean;
    /** 是否运行在 Docker 容器中 */
    isDocker: boolean;
    /** NapCat 启动模式 */
    launchMode: LaunchMode;
}
