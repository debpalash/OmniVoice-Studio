# OmniVoice Studio 使用指南

> v0.2.7-fix2 修复版 | 适用于 Windows 国内用户

---

## 快速开始（一键启动）

项目已配置为**零全局依赖**启动——所有依赖均在项目目录内（`.venv`、`node_modules`），无需安装全局 Python 或 Node.js。

```
双击 start.bat           → 生产模式（后端 + 编译好的前端，无需 bun）
双击 start-dev.bat       → 开发模式（后端 + Vite 热重载，需要 bun）
```

启动后浏览器自动打开：
- 生产模式：http://127.0.0.1:3900
- 开发模式：http://127.0.0.1:3901
- API 文档：http://127.0.0.1:3900/docs

**语言切换：** 界面右上角有 🌐 中/EN 切换按钮，点击即可在中英文之间切换，选择会自动记住。

---

## 目录结构

```
E:\OmniVoice-Studio\
├── README.md                              # 项目说明
├── start.bat                              # 一键启动（生产模式）
├── start-dev.bat                          # 一键启动（开发模式）
├── backend/                                # Python 后端
│   ├── main.py                             # FastAPI 入口（端口 3900）
│   └── services/
│       └── model_manager.py               # 模型加载
├── frontend/                               # React 前端 (Tauri)
│   ├── vite.config.js                     # Vite 配置（端口 3901）
│   └── src-tauri/
│       └── src/
│           └── backend.rs                 # 后端进程管理
├── omnivoice/                              # OmniVoice Python 包
├── pyproject.toml                          # Python 项目配置
└── uv.lock                                 # 依赖锁定文件
```

---

## 一、安装运行（推荐普通用户）

### 方式 1：直接安装 MSI

双击 `OmniVoice_Studio_0.2.7_x64.msi`，按提示安装。

首次运行时会自动：
1. 下载 Python 3.11（如果系统没有）
2. 创建虚拟环境并安装依赖（5-10 分钟）
3. 下载模型权重（~5 GB）

**国内网络加速：** 启动前在 PowerShell 中设置环境变量：

```powershell
[Environment]::SetEnvironmentVariable("HF_ENDPOINT", "https://hf-mirror.com", "User")
[Environment]::SetEnvironmentVariable("UV_INDEX_URL", "https://mirrors.aliyun.com/pypi/simple/", "User")
```

设置后重新打开终端或重启电脑生效。

### 方式 2：一键启动（推荐开发者）

**前提条件：** 仅 `.venv` Python 虚拟环境（通过 `uv sync` 创建）。

**步骤：**

```powershell
# 双击 start.bat 直接启动，无需手动配置
```

或者从命令行：

```powershell
cd E:\OmniVoice-Studio
.\start.bat          # 生产模式（只需 .venv，无需 bun）
.\start-dev.bat      # 开发模式（需要 bun，Vite 热重载）
```

### 方式 3：从源码运行（完整开发环境）

**前提条件：**
- [Bun](https://bun.sh) >= 1.0
- [Rust](https://rustup.rs) >= 1.70
- [Python](https://python.org) >= 3.11（推荐通过 `uv` 管理）

```powershell
cd E:\OmniVoice-Studio

# 安装前端依赖
bun install

# 启动开发模式（前后端热重载）
bun run dev

# 仅构建桌面应用
bun run desktop
```

---

## 二、构建安装包

```powershell
cd E:\OmniVoice-Studio\frontend

# 构建 MSI（Windows）
bun run tauri build -- --bundles msi

# 产物在：frontend\src-tauri\target\release\bundle\msi\
```

如需跳过签名（本地用），构建完成后忽略 `TAURI_SIGNING_PRIVATE_KEY` 报错即可。

---

## 三、本版修复内容

相比官方 v0.2.7，本 Fork 包含以下修复：

| # | 文件 | 修复内容 |
|---|------|----------|
| 1 | `frontend/src-tauri/src/backend.rs` | Windows 平台 `kill_orphan_on_port` 实现 |
| 2 | `backend/main.py` | `HF_HUB_OFFLINE=1` 防受限网络超时 + Windows Triton 禁用 |
| 3 | `backend/services/model_manager.py` | 离线模式加载 + `_gpu_pool` NameError 修复 + 显式跳过 `torch.compile` |
| 4 | `frontend/vite.config.js` | `host: '127.0.0.1'` 强制 IPv4，防止 `localhost 拒绝连接` |
| 5 | `frontend/src/i18n/` | 完整中英文界面 + localStorage 语言记忆 + 右上角一键切换 |
| 6 | `start.bat` / `start-dev.bat` | 一键启动脚本，零全局依赖（仅用项目内 `.venv`） |

**常见问题已解决：**
- ❌ "name '\_gpu\_pool' is not defined" → ✅ 修复
- ❌ "Cannot find a working triton installation" → ✅ 修复（双重防护）
- ❌ "Could not import module AutoModel" → ✅ 修复
- ❌ 国内网络 httpx.ConnectTimeout → ✅ 修复
- ❌ localhost 拒绝连接 → ✅ 修复（IPv4 绑定）
- ❌ 语言偏好不记住 → ✅ 修复（localStorage 持久化）

---

## 四、更新 GitHub Fork

用到代理时，先设置 git 代理：

```powershell
git config http.proxy "socks5://127.0.0.1:10808"
git config https.proxy "socks5://127.0.0.1:10808"
```

推送代码：

```powershell
cd E:\OmniVoice-Studio
git add .
git commit -m "描述你的修改"
git push origin main
```

---

## 五、模型缓存位置

| 位置 | 路径 |
|------|------|
| 应用数据 | `%APPDATA%\OmniVoice` |
| 模型文件 | `%USERPROFILE%\.cache\huggingface\hub\` |
| 音频输出 | `%APPDATA%\OmniVoice\outputs\` |
| 后端日志 | `%LOCALAPPDATA%\OmniVoice\Logs\` |
| HF 自定义缓存 | `%LOCALAPPDATA%\OmniVoice\hf_cache\` |

---

## 六、常见问题

### 启动闪退
查看日志：`%LOCALAPPDATA%\OmniVoice\Logs\backend_err.log`

### 模型下载失败
```powershell
# 手动下载模型（需要先装 huggingface_hub）
pip install huggingface_hub
set HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download k2-fsa/OmniVoice
huggingface-cli download Systran/faster-whisper-large-v3
```

### 端口被占用
```powershell
# 查看 3900 端口占用
netstat -ano | findstr :3900
# 杀掉进程（替换 PID）
taskkill /PID <PID> /F
```

---

## 相关链接

- Fork 仓库：https://github.com/caaaaaleb/OmniVoice-Studio
- Release 下载：https://github.com/caaaaaleb/OmniVoice-Studio/releases
- 上游 PR：https://github.com/debpalash/OmniVoice-Studio/pull/85
- 官方仓库：https://github.com/debpalash/OmniVoice-Studio
