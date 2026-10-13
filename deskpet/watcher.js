'use strict';

/**
 * 会话活动观察器（零侵入，只读）
 *
 * 数据来源：<dataDir>/v2/sessions/YYYY/MM/DD/<hh-mm-ss-session_xxx>/messages.jsonl
 * 每轮只做两件事：
 *   1. 找到最近活跃的 session 目录
 *   2. 读 messages.jsonl 末尾若干字节，解析出最后一条消息的 role
 *
 * 不写入、不修改、不删除运行时任何文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 定位运行时数据目录。
 * 自定义安装目录（比如装在 D:\Data 下）时环境变量未必存在，
 * 所以除了 env，还从 __dirname 往上逐层探测，直到找到带 v2/sessions 的那层。
 */
function resolveDataDir() {
  const fromEnv = [
    process.env.DESKPET_DATA_DIR,
    process.env.MINIMAX_DATA_DIR,
    process.env.MAVIS_DATA_DIR
  ].filter(Boolean);

  const home = path.join(os.homedir(), '.minimax');

  let dir = path.resolve(__dirname);
  const walked = [];
  for (let i = 0; i < 8; i++) {
    walked.push(dir);
    dir = path.dirname(dir);
  }

  const candidates = [...fromEnv, ...walked, home];

  for (const c of candidates) {
    if (!c) continue;
    if (
      fs.existsSync(path.join(c, 'v2', 'sessions')) ||
      fs.existsSync(path.join(c, 'sessions'))
    ) {
      return c;
    }
  }
  // 都探测不到就退回 home，至少不会崩
  return home;
}

const DATA_DIR = resolveDataDir();

const SESSIONS_ROOT = fs.existsSync(path.join(DATA_DIR, 'v2', 'sessions'))
  ? path.join(DATA_DIR, 'v2', 'sessions')
  : path.join(DATA_DIR, 'sessions');

// 超过这个时长没有任何消息写入 -> 睡着
const SLEEP_AFTER_MS = 150000;
// 超过这个时长且已经产出最终答复 -> 空闲
const IDLE_AFTER_MS = 20000;

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function dayDir(d) {
  return path.join(
    SESSIONS_ROOT,
    String(d.getFullYear()),
    pad(d.getMonth() + 1),
    pad(d.getDate())
  );
}

/** 从今天往回最多找 14 天，返回最近活跃的 messages.jsonl */
function newestSessionFile(maxDays = 14) {
  for (let i = 0; i < maxDays; i++) {
    const dir = dayDir(new Date(Date.now() - i * 86400000));
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let best = null;
    let bestT = 0;
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.includes('session_')) continue;
      const msgFile = path.join(dir, e.name, 'messages.jsonl');
      let t = 0;
      try {
        t = fs.statSync(msgFile).mtimeMs;
      } catch {
        continue;
      }
      if (t > bestT) {
        bestT = t;
        best = msgFile;
      }
    }
    if (best) return { file: best, mtime: bestT };
  }
  return null;
}

/**
 * 只读文件尾部若干字节，倒着找第一条能解析的完整 JSON。
 * 首行可能是被截断的半个 JSON，parse 失败就继续往前找。
 */
function readLastJson(file, chunk = 16 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(chunk, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s || s[0] !== '{') continue;
      try {
        return JSON.parse(s);
      } catch {
        /* 半个行，继续往前 */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const TOOL_LABELS = {
  bash: '跑命令',
  read: '读文件',
  edit: '改文件',
  write: '写文件',
  grep: '搜代码',
  glob: '找文件',
  web_fetch: '抓网页',
  web_search: '联网搜索',
  task: '派子任务',
  todowrite: '整理待办',
  ask_user: '问你问题'
};

function toolLabel(name) {
  if (!name) return null;
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  return name.length > 12 ? name.slice(0, 12) + '…' : name;
}

/** 把最后一条消息 + 时间差映射成桌宠状态 */
function deriveState(rec) {
  if (!rec) return { state: 'idle', age: Infinity, label: null };

  const age = Date.now() - rec.mtime;
  const last = readLastJson(rec.file);
  const msg = (last && last.message) || {};
  const role = msg.role;
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const hasTool = parts.some((p) => p && (p.type === 'toolCall' || p.name));
  const hasText = parts.some((p) => p && p.type === 'text' && String(p.text || '').trim());

  let state;
  let label = null;

  if (role === 'user') {
    // 刚收到指令，模型还没开始吐字
    state = 'thinking';
    label = '收到指令';
  } else if (role === 'toolResult') {
    // 工具报错时抖一下
    if (msg.isError === true || msg.is_error === true) {
      state = 'error';
      label = (toolLabel(msg.toolName) || '工具') + '出错了';
    } else {
      state = 'working';
      label = toolLabel(msg.toolName) || '干活中';
    }
  } else if (role === 'assistant') {
    if (hasTool) {
      const call = parts.find((p) => p && (p.type === 'toolCall' || p.name));
      state = 'typing';
      label = toolLabel(call && (call.name || call.toolName)) || '准备动手';
    } else if (hasText) {
      // 纯文本答复 = 这一轮说完了
      state = 'happy';
      label = '做完了';
    } else {
      state = 'working';
      label = '干活中';
    }
  } else {
    state = 'idle';
  }

  // 时间衰减：别让一个很久以前的 happy 一直挂着
  if (age > SLEEP_AFTER_MS) {
    state = 'sleeping';
    label = null;
  } else if (age > IDLE_AFTER_MS && (state === 'happy' || state === 'thinking')) {
    state = 'idle';
    label = null;
  }

  return { state, age, label };
}

/** 轮询启动，返回 stop 函数 */
function createWatcher(onTick, intervalMs = 1200) {
  let timer = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    let payload;
    try {
      payload = deriveState(newestSessionFile());
    } catch (e) {
      payload = { state: 'idle', age: Infinity, label: null };
    }
    try {
      onTick(payload);
    } catch {
      /* 渲染层异常不应中断轮询 */
    }
  };

  tick();
  timer = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}

module.exports = { createWatcher, deriveState, newestSessionFile, DATA_DIR };