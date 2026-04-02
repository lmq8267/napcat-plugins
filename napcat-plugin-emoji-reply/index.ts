import type { PluginModule, NapCatPluginContext, PluginConfigSchema, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import fs from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

interface Config {
  enabled: boolean;
  targetUserIds: string[];
  selectedEmojiIds: string[];
  randomCount: number;
  groupIds: string[];
}

interface State {
  logs: LogEntry[];
  stats: {
    processedCount: number;
    todayProcessedCount: number;
    lastUpdateDay: string;
  };
}

interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface EmojiData {
  QSid: string;
  QDes: string;
  IQLid: string;
  AQLid: string;
  EMCode: string;
  isStatic?: '1';
  Input: string[];
}

let logger: PluginLogger;
let ctx: NapCatPluginContext;
let config: Config = {
  enabled: false,
  targetUserIds: [],
  selectedEmojiIds: [],
  randomCount: 1,
  groupIds: [],
};
let state: State = {
  logs: [],
  stats: {
    processedCount: 0,
    todayProcessedCount: 0,
    lastUpdateDay: new Date().toDateString(),
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export let plugin_config_ui: PluginConfigSchema = [];

let emojiList: EmojiData[] = [];

function log(level: 'info' | 'warn' | 'error', msg: string) {
  logger?.[level]?.(msg);
  state.logs.push({ time: Date.now(), level, msg });
  if (state.logs.length > 500) state.logs = state.logs.slice(-300);
}

function saveConfig() {
  try {
    fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    log('error', '保存配置失败：' + e);
  }
}

function saveState() {
  try {
    const statePath = path.join(path.dirname(ctx.configPath), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    log('error', '保存状态失败：' + e);
  }
}

function incrementProcessedCount() {
  state.stats.processedCount++;
  const today = new Date().toDateString();
  if (today !== state.stats.lastUpdateDay) {
    state.stats.todayProcessedCount = 0;
    state.stats.lastUpdateDay = today;
  }
  state.stats.todayProcessedCount++;
}

function isTargetUser(userId: string): boolean {
  if (config.targetUserIds.length === 0) {
    return false;
  }
  return config.targetUserIds.includes(userId);
}

function isTargetGroup(groupId: string): boolean {
  if (config.groupIds.length === 0) {
    return true;
  }
  return config.groupIds.includes(groupId);
}

function getRandomEmojis(): string[] {
  const { selectedEmojiIds, randomCount } = config;
  if (selectedEmojiIds.length === 0) {
    return [];
  }
  if (randomCount === 0 || randomCount >= selectedEmojiIds.length) {
    return [...selectedEmojiIds];
  }
  const shuffled = [...selectedEmojiIds].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, randomCount);
}

function getEmojiImageUrl(emojiId: string): string {
  const emoji = emojiList.find((e) => e.QSid === emojiId);
  const isStatic = emoji?.isStatic === '1';
  if (isStatic) {
    return `https://koishi.js.org/QFace/assets/qq_emoji/${emojiId}/png/${emojiId}.png`;
  }
  return `https://koishi.js.org/QFace/assets/qq_emoji/${emojiId}/apng/${emojiId}.png`;
}

async function sendEmojiReply(
  ctx: NapCatPluginContext,
  groupId: number,
  userId: string,
  messageId: number,
  emojiIds: string[],
  messageContent: string
): Promise<void> {
  try {
    // 为每个消息添加表情回应
    for (const emojiId of emojiIds) {
      await ctx.actions.call(
        'set_msg_emoji_like',
        {
          message_id: messageId,
          emoji_id: emojiId
        },
        ctx.adapterName,
        ctx.pluginManager.config
      );
    }
    
    const emojiInfo = emojiIds.map(id => {
      const emoji = emojiList.find(e => e.QSid === id);
      return emoji ? `[表情:${emoji.QDes} ${id}]` : `[表情:${id}]`;
    }).join(' ');
    log('info', `(｡･ω･｡) 已回应 ${userId} 的消息："${messageContent}" ${emojiInfo}`);
    incrementProcessedCount();
    saveState();
  } catch (error) {
    log('error', `(╥﹏╥) 添加表情回应失败：${error}`);
  }
}

async function handleMessage(event: any): Promise<void> {
  if (event.post_type !== 'message') {
    return;
  }

  if (event.message_type !== 'group') {
    return;
  }

  const { group_id, user_id, message, message_id } = event;

  if (!group_id || !user_id) {
    return;
  }

  const userId = String(user_id);
  const groupId = String(group_id);

  if (!isTargetGroup(groupId)) {
    return;
  }

  if (!isTargetUser(userId)) {
    return;
  }

  const emojisToSend = getRandomEmojis();
  if (emojisToSend.length === 0) {
    log('warn', '(；′⌒`) 未选择表情，无法回应');
    return;
  }

  let messageType = '文本';
  let messageContent = '';
    
  if (Array.isArray(message)) {
    const hasNonText = message.some((seg: any) => seg.type !== 'text');
    if (hasNonText) {
      const nonTextSeg = message.find((seg: any) => seg.type !== 'text');
      switch (nonTextSeg?.type) {
        case 'image': messageType = '图片'; break;
        case 'record': messageType = '语音'; break;
        case 'video': messageType = '视频'; break;
        case 'file': messageType = '文件'; break;
        default: messageType = nonTextSeg?.type || '未知';
      }
      messageContent = messageType;
    } else {
      messageContent = message
        .filter((seg: any) => seg.type === 'text')
        .map((seg: any) => seg.data?.text)
        .join('');
    }
  } else {
    messageContent = String(message || '');
  }

  await sendEmojiReply(ctx, Number(group_id), userId, message_id, emojisToSend, messageContent);
}

async function loadEmojiData(): Promise<EmojiData[]> {
  try {
    const response = await fetch('https://koishi.js.org/QFace/assets/qq_emoji/_index.json');
    const data = await response.json();
    
    return data.map((e: any) => ({
      QSid: e.emojiId,
      QDes: e.describe,
      IQLid: e.qcid?.toString() || '',
      AQLid: e.aniStickerId?.toString() || '',
      EMCode: e.qzoneCode || '',
      // 根据assets判断是否为静态：只有type 0(png)没有type 2(apng)时才是静态
      isStatic: e.assets?.some((a: any) => a.type === 2) ? undefined : '1',
      Input: [],
      isHide: e.isHide ? '1' : '0'
    }));
  } catch (e) {
    console.error('加载表情数据失败:', e);
    log('error', '加载表情数据失败: ' + String(e));
    
    // 回退到本地文件
    const emojiDataPath = path.join(__dirname, 'webui/emoji-data.json');
    if (fs.existsSync(emojiDataPath)) {
      const data = JSON.parse(fs.readFileSync(emojiDataPath, 'utf-8'));
      return data;
    }
  }
  return [];
}

const plugin_init: PluginModule['plugin_init'] = async (c: NapCatPluginContext) => {
  ctx = c;
  logger = ctx.logger;
  
  // 加载配置
  if (fs.existsSync(ctx.configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
      Object.assign(config, raw);
    } catch (e) {
      log('warn', '加载配置失败：' + e);
    }
  }

  const statePath = path.join(path.dirname(ctx.configPath), 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.logs = raw.logs || [];
      state.stats = raw.stats || state.stats;
    } catch (e) {
      log('warn', '加载状态失败：' + e);
    }
  }
  
  log('info', '随机回应表情插件初始化中...');

  // 加载表情数据
  emojiList = await loadEmojiData();
  log('info', `加载了 ${emojiList.length} 个表情`);

  try {
    const C = ctx.NapCatConfig;
    if (C) {
      plugin_config_ui = C.combine(
        C.html(`<div style="padding:16px;background:linear-gradient(135deg,rgba(251,114,153,0.1),rgba(251,114,153,0.05));border:1px solid rgba(251,114,153,0.3);border-radius:12px;margin-bottom:20px;box-shadow:0 2px 6px rgba(0,0,0,0.04)"><div style="display:flex;align-items:center;gap:12px;margin-bottom:8px"><div style="width:36px;height:36px;background:#FB7299;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px">😊</div><div><h3 style="margin:0;font-size:16px;font-weight:600;color:#374151">随机回应表情</h3><p style="margin:2px 0 0;font-size:12px;color:#9ca3af">napcat-plugin-emoji-reply</p></div></div><p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5">自动回应指定用户的消息，随机发送选中的 QQ 表情</p></div>`),
        C.html(`<div style="padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;display:flex;gap:10px;align-items:center"><div style="color:#6b7280;flex-shrink:0"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></div><div style="font-size:13px;color:#4b5563">所有配置请打开 <a href="#" onclick="window.open(window.location.origin+'/plugin/napcat-plugin-emoji-reply/page/config','_blank');return false" style="color:#FB7299;text-decoration:none;font-weight:600">WebUI 控制台</a> 进行管理</div></div>`)
      );
    }
  } catch (e) {
    log('warn', '配置 UI 初始化失败：' + e);
  }

  // 注册 WebUI 页面
  const router = (ctx as any).router;
  router.page({ path: 'config', title: '表情回应配置', icon: '😊', htmlFile: 'webui/config.html', description: '随机回应表情配置面板' });

  // 注册 API 路由
  const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const version = packageJson.version;
  
  router.getNoAuth('/status', (_req: any, res: any) => {
    res.json({ success: true, data: { ...state, config }, version });
  });

  router.getNoAuth('/config', (_req: any, res: any) => {
    res.json({ success: true, data: config });
  });

  router.postNoAuth('/config', (req: any, res: any) => {
    try {
      Object.assign(config, req.body);
      saveConfig();
      log('info', '(｡･ω･｡) 配置已保存');
      res.json({ success: true });
    } catch (e) {
      log('error', `(╥﹏╥) 保存配置失败：${e}`);
      res.status(500).json({ success: false, error: String(e) });
    }
  });

  router.getNoAuth('/emoji-list', (_req: any, res: any) => {
    res.json({ success: true, data: emojiList });
  });

  router.getNoAuth('/groups', async (_req: any, res: any) => {
    try {
      const groups = await ctx.actions.call(
        'get_group_list',
        {} as never,
        ctx.adapterName,
        ctx.pluginManager.config
      ) as Array<{ group_id: number; group_name: string; member_count: number; max_member_count: number }>;
      res.json({
        success: true,
        data: groups.map((g) => ({
          group_id: String(g.group_id),
          group_name: g.group_name,
          member_count: g.member_count,
          max_member_count: g.max_member_count,
        })),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: String(e) });
    }
  });

  router.getNoAuth('/logs', (_req: any, res: any) => {
    res.json({ success: true, data: state.logs });
  });

  router.postNoAuth('/logs/clear', (_req: any, res: any) => {
    state.logs = [];
    saveState();
    res.json({ success: true });
  });

  log('info', '(｡･ω･｡) 随机回应表情插件初始化完成');
};

const plugin_onmessage: PluginModule['plugin_onmessage'] = async (c: NapCatPluginContext, event: any) => {
  if (!config.enabled) {
    return;
  }
  await handleMessage(event);
};

const plugin_cleanup: PluginModule['plugin_cleanup'] = async () => {
  try {
    const statePath = path.join(path.dirname(ctx.configPath), 'state.json');  
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
      log('info', '(｡･ω･｡) 已清除插件数据');
    }
  } catch (e) {
    log('error', '清除数据失败：' + e);
  }
  log('info', '(｡･ω･｡) 随机回应表情插件已卸载');  
};

export const plugin_get_config = async () => config;

export const plugin_set_config = async (_c: NapCatPluginContext, cfg: Config) => {
  Object.assign(config, cfg);
  saveConfig();
};

export { plugin_init, plugin_onmessage, plugin_cleanup };
