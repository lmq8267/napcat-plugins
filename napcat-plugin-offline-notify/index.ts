import type { PluginModule, NapCatPluginContext, PluginConfigSchema, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import fs from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACTION_TIMEOUT = 20000;  // ctx.actions.call 超时 20s
const FETCH_TIMEOUT = 15000;   // fetch 超时 15s
const CONSECUTIVE_FAILURE_THRESHOLD = 2; // 连续失败 N 次才判离线

interface Config {
  enabled: boolean;
  webhookUrl: string;
  checkMethods: string[];
  checkInterval: number;
  retryCount: number;
  customMessage: string;
}

interface State {
  status: 'online' | 'offline' | 'unknown';
  onlineTime: number;
  lastNotifyTime: number;
  nextCheckTime: number;
  logs: LogEntry[];
  checking: boolean;
  consecutiveFailures: number;
  lastCheckTime: number;
}

interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

let logger: PluginLogger;
let ctx: NapCatPluginContext;
let config: Config = {
  enabled: false,
  webhookUrl: '',
  checkMethods: ['kickedOffLine', 'getGroupList'],
  checkInterval: 5,
  retryCount: 2,
  customMessage: '【NapCat-离线通知】\n\n下线原因：{reason}\n\n下线时间：{time}'
};
let state: State = {
  status: 'unknown',
  onlineTime: 0,
  lastNotifyTime: 0,
  nextCheckTime: 0,
  logs: [],
  checking: false,
  consecutiveFailures: 0,
  lastCheckTime: 0,
};
let checkTimer: NodeJS.Timeout | null = null;

export let plugin_config_ui: PluginConfigSchema = [];

let lastTestResponse = '';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    )
  ]);
}

function log(level: 'info' | 'warn' | 'error', msg: string) {
  logger?.[level]?.(msg);
  state.logs.push({ time: Date.now(), level, msg });
  if (state.logs.length > 500) state.logs = state.logs.slice(-300);
}

function saveConfig() {
  try {
    fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    log('error', '保存配置失败: ' + e);
  }
}

function saveState() {
  try {
    const statePath = path.join(path.dirname(ctx.configPath), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    log('error', '保存状态失败: ' + e);
  }
}

async function sendNotify(reason: string) {
  if (!config.webhookUrl) {
    log('warn', '未配置企业微信机器人 Webhook URL');
    return { success: false, response: '未配置 Webhook URL' };
  }

  const now = Date.now();
  if (now - state.lastNotifyTime < 60000) {
    log('info', '距上次推送通知不足1分钟，跳过');
    return { success: false, response: '距上次推送通知不足1分钟' };
  }

  const time = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
  const content = config.customMessage
    .replace('{time}', time)
    .replace('{reason}', reason);

  for (let i = 0; i <= config.retryCount; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        const res = await fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content } }),
          signal: controller.signal
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { errcode: -1, errmsg: text }; }

        if (json.errcode === 0) {
          state.lastNotifyTime = now;
          saveState();
          log('info', `通知推送成功 - ${reason}`);
          return { success: true, response: text };
        }
        log('warn', `通知推送失败: ${json.errmsg || text}，重试 ${i + 1}/${config.retryCount}`);
        if (i === config.retryCount) return { success: false, response: json.errmsg || text };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if ((e as any)?.name === 'AbortError') {
        log('warn', `通知推送超时，重试 ${i + 1}/${config.retryCount}`);
      } else {
        log('error', `通知推送异常: ${errMsg}`);
      }
      if (i === config.retryCount) return { success: false, response: errMsg };
    }
    if (i < config.retryCount) await new Promise(r => setTimeout(r, 2000));
  }
  return { success: false, response: '未知错误' };
}

async function checkOnline() {
  // 并发保护：上次检测未完成则跳过
  if (state.checking) {
    log('warn', '上一次检测尚未完成，跳过本次定时检测');
    return;
  }

  const methods = config.checkMethods.filter(m => m !== 'kickedOffLine');
  if (methods.length === 0) return;

  state.checking = true;
  state.lastCheckTime = Date.now();
  saveState();

  let allFailed = true;

  if (methods.includes('getGroupList')) {
    try {
      const res = await withTimeout(
        ctx.actions.call('get_group_list', {} as never, ctx.adapterName, ctx.networkConfig),
        ACTION_TIMEOUT,
        'get_group_list'
      );
      if (res && Array.isArray(res) && res.length > 0) {
        allFailed = false;
      }
    } catch (e) {
      log('warn', '获取群列表失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (methods.includes('getRecentContact')) {
    try {
      const res = await withTimeout(
        ctx.actions.call('get_friend_list', {} as never, ctx.adapterName, ctx.networkConfig),
        ACTION_TIMEOUT,
        'get_friend_list'
      );
      if (res && Array.isArray(res) && res.length > 0) {
        allFailed = false;
      }
    } catch (e) {
      log('warn', '获取好友列表失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (allFailed) {
    state.consecutiveFailures++;
    log('warn', `检测失败 (连续 ${state.consecutiveFailures}/${CONSECUTIVE_FAILURE_THRESHOLD} 次)`);

    // 达到连续失败阈值 且 之前是在线/未知状态 才触发离线通知
    if (state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      if ((state.status === 'online' || state.status === 'unknown') && config.enabled) {
        await sendNotify('检测方式无响应');
      }
      state.status = 'offline';
    }
    // 未达阈值：保持当前状态，不切换
  } else {
    // 检测成功 → 重置失败计数
    state.consecutiveFailures = 0;
    if (state.status === 'offline' || state.status === 'unknown') {
      state.status = 'online';
      state.onlineTime = Date.now();
      saveState();
      log('info', '账号已恢复在线');
    }
  }

  if (config.enabled) {
    state.nextCheckTime = Date.now() + config.checkInterval * 60000;
  }
  state.checking = false;
  saveState();
}

function startCheck() {
  stopCheck();
  if (!config.enabled) return;
  const methods = config.checkMethods.filter(m => m !== 'kickedOffLine');
  if (methods.length === 0) return;

  checkTimer = setInterval(() => checkOnline(), config.checkInterval * 60000);
  state.nextCheckTime = Date.now() + config.checkInterval * 60000;
  saveState();
  log('info', `定时检测已启动，间隔 ${config.checkInterval} 分钟`);
}

function stopCheck() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

const plugin_init: PluginModule['plugin_init'] = async (c: NapCatPluginContext) => {
  ctx = c;
  logger = ctx.logger;
  log('info', '离线通知插件初始化中...');

  try {
    const C = ctx.NapCatConfig;
    if (C) {
      plugin_config_ui = C.combine(
        C.html(`<div style="padding:16px;background:linear-gradient(135deg,rgba(96,165,250,0.1),rgba(59,130,246,0.1));border:1px solid rgba(96,165,250,0.3);border-radius:12px;margin-bottom:20px;box-shadow:0 2px 6px rgba(0,0,0,0.04)"><div style="display:flex;align-items:center;gap:12px;margin-bottom:8px"><div style="width:36px;height:36px;background:#3B82F6;border-radius:8px;display:flex;align-items:center;justify-content:center">🔔</div><div><h3 style="margin:0;font-size:16px;font-weight:600;color:#374151">离线通知</h3><p style="margin:2px 0 0;font-size:12px;color:#9ca3af">napcat-plugin-offline-notify</p></div></div><p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5">监控帐号状态离线时采用企业微信机器人推送通知</p></div>`),
        C.html(`<div style="padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;display:flex;gap:10px;align-items:center"><div style="color:#6b7280;flex-shrink:0"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></div><div style="font-size:13px;color:#4b5563">所有配置请打开 <a href="#" onclick="window.open(window.location.origin+'/plugin/napcat-plugin-offline-notify/page/config','_blank');return false" style="color:#3B82F6;text-decoration:none;font-weight:600">WebUI 控制台</a> 进行管理</div></div>`)
      );
    }
  } catch (e) {
    log('warn', '配置 UI 初始化失败: ' + e);
  }
  
  const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const version = packageJson.version;

  const router = (ctx as any).router;
  router.page({ path: 'config', title: '离线通知配置', icon: '🔔', htmlFile: 'webui/config.html', description: '离线通知配置面板' });

  router.getNoAuth('/status', (_req: any, res: any) => {
    res.json({
      success: true,
      data: { ...state, config },
      version
    });
  });

  router.getNoAuth('/config', (_req, res) => {
    res.json({ success: true, data: config });
  });

  router.postNoAuth('/config', (req, res) => {
    try {
      const oldEnabled = config.enabled;
      Object.assign(config, req.body);
      saveConfig();

      if (config.enabled !== oldEnabled) {
        log('info', config.enabled ? '监控已启用' : '监控已关闭');
      }
      log('info', '配置已更新');

      stopCheck();
      startCheck();
      res.json({ success: true });
    } catch (e) {
      log('error', '保存配置失败: ' + e);
      res.json({ success: false, error: '保存失败: ' + e });
    }
  });

  router.postNoAuth('/test', async (_req, res) => {
    try {
      log('info', '开始测试通知');
      const time = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
      const content = `【NapCat-测试通知】\n\n这是一条测试消息，用于验证企业微信机器人配置是否正确\n\n测试时间：${time}`;

      if (!config.webhookUrl) {
        log('warn', '测试通知失败: 未配置 Webhook URL');
        res.json({ success: false, error: '未配置 Webhook URL' });
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        const result = await fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content } }),
          signal: controller.signal
        });
        const text = await result.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { errcode: -1, errmsg: text }; }

        lastTestResponse = text;
        if (json.errcode === 0) {
          log('info', '测试通知推送成功');
        } else {
          log('warn', `测试通知推送失败: ${json.errmsg || text}`);
        }
        res.json({ success: json.errcode === 0, response: text });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      log('error', '测试通知异常: ' + e);
      lastTestResponse = String(e);
      res.json({ success: false, error: '测试失败: ' + e });
    }
  });

  router.getNoAuth('/test-result', (_req, res) => {
    res.json({ success: true, data: lastTestResponse });
  });

  router.getNoAuth('/logs', (_req, res) => {
    res.json({ success: true, data: state.logs });
  });

  router.postNoAuth('/logs/clear', (_req, res) => {
    state.logs = [];
    saveState();
    res.json({ success: true });
  });

  router.postNoAuth('/check', async (_req, res) => {
    if (state.checking) {
      // 如果 checking 状态超过 5 分钟未恢复，视为 stale 并重置
      const staleThreshold = Date.now() - 300000;
      if (state.lastCheckTime > 0 && state.lastCheckTime < staleThreshold) {
        log('warn', '检测到 stale checking 状态，自动重置');
        state.checking = false;
        saveState();
      } else {
        res.json({ success: false, error: '检测进行中' });
        return;
      }
    }
    log('info', '手动触发立即检测');
    await checkOnline();
    const result = state.status === 'online' ? '在线' : (state.status === 'offline' ? '离线' : '未知');
    log('info', `检测完成，当前状态: ${result}`);
    res.json({ success: true, data: state });
  });

  if (fs.existsSync(ctx.configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
      Object.assign(config, raw);
    } catch (e) {
      log('warn', '加载配置失败: ' + e);
    }
  }

  const statePath = path.join(path.dirname(ctx.configPath), 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.logs = raw.logs || [];
      state.lastNotifyTime = raw.lastNotifyTime || 0;
      state.nextCheckTime = raw.nextCheckTime || 0;
      state.consecutiveFailures = raw.consecutiveFailures || 0;
      state.lastCheckTime = raw.lastCheckTime || 0;
      state.status = raw.status || 'unknown';
      state.checking = false; // 重启后强制重置，避免 stale 状态
    } catch (e) {
      log('warn', '加载状态失败: ' + e);
    }
  }

  ctx.core.event.on('KickedOffLine', async (tips: string) => {
    log('info', `收到 KickedOffLine 事件: ${tips}`);
    if (config.enabled && config.checkMethods.includes('kickedOffLine')) {
      await sendNotify(tips || '账号被踢下线');
    }
  });

  startCheck();
  // 首次检测不阻塞初始化，异步执行
  checkOnline().catch(e => log('error', '首次检测异常: ' + (e instanceof Error ? e.message : String(e))));
  log('info', '离线通知插件初始化完成');
};

const plugin_cleanup: PluginModule['plugin_cleanup'] = async () => {
  stopCheck();
  saveState();
  log('info', '离线通知插件已卸载');
};

export const plugin_get_config = async () => config;
export const plugin_set_config = async (_ctx: NapCatPluginContext, cfg: Config) => {
  Object.assign(config, cfg);
  saveConfig();
  stopCheck();
  startCheck();
  // 配置变更后重置失败计数，让插件以新配置重新开始检测
  state.consecutiveFailures = 0;
  saveState();
};

export { plugin_init, plugin_cleanup };
