# MiniMax Code 桌宠

一只住在桌面右下角的二维桌宠，跟着 MiniMax Code 的会话活动切换表情。

纯只读观察：不写入、不修改、不删除运行时任何文件。唯一落盘的是托盘旁的
`pet-pos.json`（记住你把它拖到哪儿了），存在 Electron 的 userData 目录里。

## 启动

```powershell
cd deskpet
npm start
```

## 退出

托盘图标右键 → 退出。（直接关窗口不会退出，桌宠要常驻。）

## 交互

| 操作 | 效果 |
| --- | --- |
| 拖动身体 | 全身可拖，松手记住位置 |
| 单击 / 双击 | 戳一下，强制开心动画 |
| 右键 | 菜单：戳一下 / 回到右下角 / 退出 |

窗口默认整窗鼠标穿透，不会挡着你干活；指针移到桌宠身上时才临时接管。

## 状态是怎么判出来的

读 `<dataDir>/v2/sessions/YYYY/MM/DD/<会话目录>/messages.jsonl` 的**最后一条消息**：

| 最后一条 | 状态 | 气泡 |
| --- | --- | --- |
| `role: user` | thinking（收到指令） | 收到指令 |
| `role: assistant` 且含 toolCall | typing（准备动手） | 动手前的工具名 |
| `role: toolResult` | working（干活中） | 工具名（跑命令 / 读文件…） |
| `role: toolResult` 且 `isError` | error（抖） | xx出错了 |
| `role: assistant` 纯文本 | happy（做完） | 做完了 |

再叠一层时间衰减：超过 20 秒没动静且已出最终答复 → idle；超过 150 秒 → sleeping（冒 z）。

数据目录定位顺序：`DESKPET_DATA_DIR` → `MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR`
→ 从本目录逐层向上探测带 `v2/sessions` 的那一层 → `~/.minimax`。
自定义安装位置也能跑，不用改代码。

## 形象

一只高清 Q 版二维形象，取自 MiniMax 官方角色：白色贝雷帽（带粉色蝴蝶结）、
橙粉渐变长发、琥珀色大眼睛、米色格纹裙、白袜粉鞋，手里攥着一颗橙色海螺。
**非像素风**，是插画质感的透明 PNG。

形象是 6 张独立立绘，放在 `assets/`：

| 文件 | 状态 |
| --- | --- |
| `pet-flat-idle.png` | idle |
| `pet-flat-thinking.png` | thinking |
| `pet-flat-working.png` | working / typing |
| `pet-flat-happy.png` | happy |
| `pet-flat-error.png` | error |
| `pet-flat-sleeping.png` | sleeping |

6 张统一 **364x584 画布、脚底对齐、水平居中**，所以切表情时角色不会跳动、
不会忽大忽小。

### 素材流水线

原始图在上级目录 `../pet-flat-*.jpg`。模型给的「透明背景」不可信（有浅灰棋盘格、
有纯灰底、有 24bpp 没 alpha 的），所以背景必须自己抠：

```powershell
node ..\pettools\process-pet.js .\assets ..\pet-flat-idle.jpg ..\pet-flat-thinking.jpg `
  ..\pet-flat-working.jpg ..\pet-flat-happy.jpg ..\pet-flat-error.jpg ..\pet-flat-sleeping.jpg
```

流程：四边采样聚类出背景色 → 洪泛填充 → 边缘羽化 → 取包围盒 →
多图共用缩放比例重新采样（脚底对齐 + 水平居中 + 统一画布）。
角色的白色区域都被深色描边完全包围，所以不会被洪泛误删。

`contact-sheet.png` 是六姿态对照图，方便一眼看出对齐有没有崩。

### 渲染分层

```
#bodywrap   水平居中（只做 translateX，不参与动画）
#body       身体动画目标，transform-origin 在脚底
  .sprite   6 张图叠在一起，只有一张带 .on
#fx         特效层，不跟身体一起 transform
#shadow     地面阴影，跟身体动作同步
```

身体动作走 CSS `@keyframes`（呼吸 / 歪头 / 轻点 / 跳跃 / 抖 / 慢呼吸），
特效层单独跑（思考的点点、睡觉的 z、开心的星光、报错的感叹号），
所以特效不会被身体的 transform 带动。

改形象只需换 `assets/pet-flat-*.png`，**保持 364x584 画布和脚底基线一致**即可，
其余代码不用动。状态到精灵的映射在 `pet.js` 的 `STATES` 表里。

## 已确认 / 未确认

已实机截图确认：透明窗口、置顶（能盖住任务栏）、六个状态的角色与特效都能正确
切换、CSS 动画在跑、气泡跟随真实会话活动（截图见 `states-sheet.png` / `fx-sheet.png`）。

## 安全边界

这个项目只做两件事：读 session 目录、写一个记位置的小 json。
它不会读取你的文件内容做分析（只看 `messages.jsonl` 的 role 和工具名），
没有任何网络请求。