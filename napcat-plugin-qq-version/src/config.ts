/**
 * 插件配置模块
 * 定义默认配置和 WebUI 配置 Schema
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

/** 默认配置 */
export const DEFAULT_CONFIG: PluginConfig = {
    debug: false,
};

/**
 * 初始化 WebUI 配置 Schema
 * 使用 NapCat 提供的构建器生成配置界面
 * 
 * 可用的 UI 组件：
 * - ctx.NapCatConfig.boolean(key, label, defaultValue?, description?, reactive?) - 开关
 * - ctx.NapCatConfig.text(key, label, defaultValue?, description?, reactive?) - 文本输入
 * - ctx.NapCatConfig.number(key, label, defaultValue?, description?, reactive?) - 数字输入
 * - ctx.NapCatConfig.select(key, label, options, defaultValue?, description?, reactive?) - 下拉选择
 * - ctx.NapCatConfig.html(htmlString) - 自定义 HTML
 * - ctx.NapCatConfig.combine(...schemas) - 组合多个配置项
 */
export function initConfigUI(ctx: NapCatPluginContext) {
    const schema = ctx.NapCatConfig.combine(
        // 调试模式
        ctx.NapCatConfig.boolean('debug', '调试模式', false, '启用后将输出详细的调试日志')
    );

    return schema;
}

/**
 * 获取默认配置的副本
 */
export function getDefaultConfig(): PluginConfig {
    return {
        ...DEFAULT_CONFIG,
    };
}
