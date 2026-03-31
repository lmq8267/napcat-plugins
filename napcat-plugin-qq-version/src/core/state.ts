/**
 * 状态管理模块
 * 插件全局状态类，封装配置、日志、上下文等
 */

import fs from 'fs';
import path from 'path';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { ActionMap } from 'napcat-types/napcat-onebot/action/index';
import type { NetworkAdapterConfig } from 'napcat-types/napcat-onebot/config/config';
import { DEFAULT_CONFIG, getDefaultConfig } from '../config';
import type { PluginConfig, GroupConfig } from '../types';

/** 日志前缀 - 修改为你的插件名称 */
const LOG_TAG = '[Plugin]';

// ==================== 类型安全的清洗辅助函数 ====================

/** 安全提取 boolean 值 */
function safeBool(obj: Record<string, unknown>, key: string): boolean | undefined {
    return typeof obj[key] === 'boolean' ? obj[key] as boolean : undefined;
}

/** 安全提取 string 值 */
function safeStr(obj: Record<string, unknown>, key: string): string | undefined {
    return typeof obj[key] === 'string' ? obj[key] as string : undefined;
}

/** 安全提取 number 值 */
function safeNum(obj: Record<string, unknown>, key: string): number | undefined {
    return typeof obj[key] === 'number' ? obj[key] as number : undefined;
}

/** 类型守卫：判断是否为对象 */
function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object';
}

/**
 * 配置清洗函数
 * 确保从文件读取的配置符合预期类型
 */
function sanitizeConfig(raw: unknown): PluginConfig {
    if (!isObject(raw)) return getDefaultConfig();
    const r = raw as Record<string, unknown>;
    const out: PluginConfig = getDefaultConfig();

    // 基础配置
    const enabled = safeBool(r, 'enabled');
    if (enabled !== undefined) out.enabled = enabled;

    const debug = safeBool(r, 'debug');
    if (debug !== undefined) out.debug = debug;

    const commandPrefix = safeStr(r, 'commandPrefix');
    if (commandPrefix !== undefined) out.commandPrefix = commandPrefix;

    const cooldownSeconds = safeNum(r, 'cooldownSeconds');
    if (cooldownSeconds !== undefined) out.cooldownSeconds = cooldownSeconds;

    // 群配置
    const rawGroupConfigs = r['groupConfigs'];
    if (isObject(rawGroupConfigs)) {
        out.groupConfigs = {};
        for (const groupId of Object.keys(rawGroupConfigs as Record<string, unknown>)) {
            const groupConfig = (rawGroupConfigs as Record<string, unknown>)[groupId];
            if (isObject(groupConfig)) {
                const gc = groupConfig as Record<string, unknown>;
                const cfg: GroupConfig = {};
                const gcEnabled = safeBool(gc, 'enabled');
                if (gcEnabled !== undefined) cfg.enabled = gcEnabled;
                out.groupConfigs![groupId] = cfg;
            }
        }
    }

    // TODO: 在这里添加你的配置项清洗逻辑

    return out;
}

/**
 * 插件全局状态类
 * 封装配置、日志、上下文等，提供统一的状态管理接口
 */
class PluginState {
    /** 日志器 */
    logger: PluginLogger | null = null;
    /** NapCat actions 对象，用于调用 API */
    actions: ActionMap | undefined;
    /** 适配器名称 */
    adapterName: string = '';
    /** 网络配置 */
    networkConfig: NetworkAdapterConfig | null = null;
    /** 插件配置 */
    config: PluginConfig = { ...DEFAULT_CONFIG };
    /** 配置文件路径 */
    configPath: string = '';
    /** 数据目录路径 */
    dataPath: string = '';
    /** 插件名称 */
    pluginName: string = '';
    /** 插件启动时间戳 */
    startTime: number = 0;
    /** 是否已初始化 */
    initialized: boolean = false;
    /** 统计信息 */
    stats: {
        processed: number;
        todayProcessed: number;
        lastUpdateDay: string;
    } = {
            processed: 0,
            todayProcessed: 0,
            lastUpdateDay: new Date().toDateString()
        };

    /**
     * 通用日志方法
     */
    log(level: 'info' | 'warn' | 'error', msg: string, ...args: unknown[]): void {
        if (!this.logger) return;
        this.logger[level](`${LOG_TAG} ${msg}`, ...args);
    }

    /**
     * 调试日志
     * 只有当 debug 配置开启时才输出
     */
    logDebug(msg: string, ...args: unknown[]): void {
        if (!this.config.debug) return;
        if (this.logger) {
            this.logger.info(`${LOG_TAG} [DEBUG] ${msg}`, ...args);
        }
    }

    /**
     * 调用 OneBot API
     * @param api API 名称
     * @param params 参数
     * @returns API 返回结果
     */
    async callApi(api: string, params: Record<string, unknown>): Promise<unknown> {
        if (!this.actions) {
            this.log('error', `调用 API ${api} 失败: actions 未初始化`);
            return null;
        }
        try {
            const result = await this.actions.call(api as 'get_status', params, this.adapterName, this.networkConfig!);
            return result;
        } catch (error) {
            this.log('error', `调用 API ${api} 失败:`, error);
            throw error;
        }
    }

    /**
     * 从 ctx 初始化状态
     */
    initFromContext(ctx: NapCatPluginContext): void {
        this.logger = ctx.logger;
        this.actions = ctx.actions;
        this.adapterName = ctx.adapterName || '';
        this.networkConfig = ctx.pluginManager?.config || null;
        this.configPath = ctx.configPath || '';
        this.pluginName = ctx.pluginName || '';
        this.dataPath = ctx.configPath ? path.dirname(ctx.configPath) : path.join(process.cwd(), 'data', 'napcat-plugin');
        this.startTime = Date.now();
    }

    /**
     * 获取运行时长（毫秒）
     */
    getUptime(): number {
        return Date.now() - this.startTime;
    }

    /**
     * 获取格式化的运行时长
     */
    getUptimeFormatted(): string {
        const uptime = this.getUptime();
        const seconds = Math.floor(uptime / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}天${hours % 24}小时`;
        if (hours > 0) return `${hours}小时${minutes % 60}分钟`;
        if (minutes > 0) return `${minutes}分钟${seconds % 60}秒`;
        return `${seconds}秒`;
    }

    /**
     * 增加处理计数
     */
    incrementProcessedCount(): void {
        const today = new Date().toDateString();
        if (this.stats.lastUpdateDay !== today) {
            this.stats.todayProcessed = 0;
            this.stats.lastUpdateDay = today;
        }
        this.stats.todayProcessed++;
        this.stats.processed++;
        this.saveConfig();
    }

    /**
     * 加载配置
     */
    loadConfig(ctx?: NapCatPluginContext): void {
        const configPath = ctx?.configPath || this.configPath;
        try {
            if (typeof configPath === 'string' && fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                this.config = { ...getDefaultConfig(), ...sanitizeConfig(raw) };
                // 加载统计信息
                if (raw.stats) {
                    this.stats = { ...this.stats, ...raw.stats };
                }
                this.logDebug('📄 已加载本地配置', { path: configPath });
            } else {
                this.config = getDefaultConfig();
                this.saveConfig(ctx);
                this.logDebug('📄 配置文件不存在，已创建默认配置', { path: configPath });
            }
        } catch (error) {
            this.log('error', '❌ 加载配置失败，使用默认配置:', error);
            this.config = getDefaultConfig();
        }
        this.initialized = true;
    }

    /**
     * 保存配置
     */
    saveConfig(ctx?: NapCatPluginContext, config?: PluginConfig): void {
        const configPath = ctx?.configPath || this.configPath;
        const configToSave = config || this.config;
        try {
            const configDir = path.dirname(String(configPath || './'));
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            // 合并统计信息一起保存
            const dataToSave = {
                ...configToSave,
                stats: this.stats
            };
            fs.writeFileSync(
                String(configPath),
                JSON.stringify(dataToSave, null, 2),
                'utf-8'
            );
            this.logDebug('💾 配置已保存', { path: configPath });
        } catch (error) {
            this.log('error', '❌ 保存配置失败:', error);
        }
    }

    /**
     * 获取配置（不包含敏感信息）
     */
    getConfig(): PluginConfig {
        return { ...this.config };
    }

    /**
     * 设置配置（合并更新）
     */
    setConfig(ctx: NapCatPluginContext, update: Partial<PluginConfig>): void {
        this.config = { ...this.config, ...update };
        this.saveConfig(ctx);
    }

    /**
     * 替换配置（完整替换）
     */
    replaceConfig(ctx: NapCatPluginContext, config: PluginConfig): void {
        this.config = sanitizeConfig(config);
        this.saveConfig(ctx);
    }

    /**
     * 更新群配置
     */
    updateGroupConfig(ctx: NapCatPluginContext, groupId: string, config: GroupConfig): void {
        if (!this.config.groupConfigs) {
            this.config.groupConfigs = {};
        }
        this.config.groupConfigs[groupId] = {
            ...this.config.groupConfigs[groupId],
            ...config
        };
        this.saveConfig(ctx);
    }

    /**
     * 检查群是否启用
     */
    isGroupEnabled(groupId: string): boolean {
        const groupConfig = this.config.groupConfigs?.[groupId];
        // 默认启用，除非明确设置为 false
        return groupConfig?.enabled !== false;
    }
}

/** 导出全局单例 */
export const pluginState = new PluginState();
