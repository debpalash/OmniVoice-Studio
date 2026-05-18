# OmniVoice Studio 使用指南

> v0.2.7-fix1 修复版 | 适用于 Windows 国内用户

---

## 目录结构

```
E:\OmniVoice-Studio\
├── README.md                              # 项目说明（中文）
├── 使用指南.md                             # 本文件
├── OmniVoice_Studio_0.2.7_x64.msi         # Windows 安装包 (~7 MB)
├── backend/                                # Python 后端
│   ├── main.py                             # FastAPI 入口
│   └── services/
│       └── model_manager.py               # 模型加载
├── frontend/                               # React 前端 (Tauri)
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

### 方式 2：从源码运行（开发者）

**前提条件：**
- [Bun](https://bun.sh) >= 1.0
- [Rust](https://rustup.rs) >= 1.70
- [Python](https://python.org) >= 3.11（推荐通过 `uv` 管理）

**步骤：**

```powershell
# 1. 进入项目目录
cd E:\OmniVoice-Studio

# 2. 安装前端依赖
bun install

# 3. 启动开发模式（前后端热重载）
bun run dev

# 4. 仅构建桌面应用
bun run desktop
```

启动后：
- 前端：http://localhost:3901
- 后端：http://localhost:3900
- API 文档：http://localhost:3900/docs

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
| 1 | `frontend/src-tauri/src/backend.rs` | Windows 平台 `kill_orphan_on_port` 实现，使用 `netstat -ano` + `taskkill /PID /F` 清理残留进程 |
| 2 | `backend/main.py` | 在所有 import 之前设置 `HF_HUB_OFFLINE=1`，防止受限网络下 httpx 超时 |
| 3 | `backend/services/model_manager.py` | 模型加载时强制离线模式 + `local_files_only=True`，加载完成后恢复原状态 |

**常见问题已解决：**
- ❌ "Could not import module AutoModel" → ✅ 修复（端口冲突）
- ❌ 国内网络 httpx.ConnectTimeout → ✅ 修复（离线模式）
- ❌ 重启后 localhost 拒绝连接 → ✅ 修复（残留进程清理）

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
