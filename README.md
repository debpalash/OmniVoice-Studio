<div align="center">
  <img src="docs/logo.png" alt="OmniVoice Logo" width="120" />
  <h1>OmniVoice Studio</h1>
  <h3>开源的 ElevenLabs 替代品</h3>
  <p>实时听写 · 零样本语音克隆 · 影视级视频配音 — 全部在你电脑上运行<br/>开源、无需 API Key、完全本地化 · <b>646 种语言</b></p>

  <p>
    <a href="https://github.com/debpalash/OmniVoice-Studio/stargazers"><img src="https://img.shields.io/github/stars/debpalash/OmniVoice-Studio?style=flat-square&color=f59e0b" alt="Stars" /></a>
    <a href="https://github.com/caaaaaleb/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/github/v/release/caaaaaleb/OmniVoice-Studio?style=flat-square&color=10b981" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License" /></a>
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#功能特性">功能特性</a> ·
    <a href="#tts-引擎">TTS 引擎</a> ·
    <a href="#版本说明">版本说明</a> ·
    <a href="#参与贡献">参与贡献</a>
  </p>

  <p>
    <a href="https://github.com/caaaaaleb/OmniVoice-Studio/releases/download/v0.2.7-fix1/OmniVoice_Studio_0.2.7_x64.msi"><img src="https://img.shields.io/badge/Windows-MSI_(x64)_v0.2.7_fix1-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="下载 Windows MSI" /></a>
    <a href="https://github.com/debpalash/OmniVoice-Studio/releases/latest"><img src="https://img.shields.io/badge/官方原版-下载页-181717?style=for-the-badge&logo=github&logoColor=white" alt="官方原版" /></a>
  </p>
</div>

<br/>

<div align="center">
  <img src=".github/assets/social-preview.png" alt="OmniVoice Studio — 开源的 ElevenLabs 替代品" width="100%"/>
</div>

> [!WARNING]
> **OmniVoice Studio 处于活跃开发阶段。** 版本之间可能会有 breaking changes。如需最新功能和修复，建议从源码运行。

---

## 版本说明

### 🛠️ v0.2.7-fix1（本 Fork 修复版）

基于官方 v0.2.7，额外包含以下关键修复：

| 修复项 | 说明 |
|--------|------|
| **Windows 端口冲突** | 实现了 `kill_orphan_on_port` Windows 版本（原版为空函数）。使用 `netstat -ano` + `taskkill /PID /F` 清理残留后端进程，解决 "Could not import module AutoModel" 错误 |
| **离线模式** | 在 `main.py`（所有 import 之前）和 `model_manager.py` 中设置 `HF_HUB_OFFLINE=1`，确保在国内受限网络环境下不从 HuggingFace 拉取文件 |
| **local_files_only** | `OmniVoice.from_pretrained()` 增加 `local_files_only=True` 参数，双重保障离线加载 |

**适用场景：** 国内用户、受限网络环境、Windows 平台遇到后端启动失败的情况。

**修复详情：** [PR #85](https://github.com/debpalash/OmniVoice-Studio/pull/85) | [Release 下载](https://github.com/caaaaaleb/OmniVoice-Studio/releases/tag/v0.2.7-fix1)

> [!NOTE]
> 本版本为**精简安装包**（~7 MB），首次运行仍需联网下载 Python 依赖和模型文件。建议配合 [hf-mirror.com](https://hf-mirror.com) 镜像使用。

---

## 功能特性

<table>
<tr>
  <td align="center" width="33%">
    <h3>🎙️ 语音克隆</h3>
    <p>3 秒音频 → 复刻任何声音<br/><b>646 种语言</b>，零样本</p>
  </td>
  <td align="center" width="33%">
    <h3>🎨 声音设计</h3>
    <p>性别、年龄、口音、音高、语速、<br/>情感、方言 — <b>精细调节</b></p>
  </td>
  <td align="center" width="33%">
    <h3>🎬 视频配音</h3>
    <p>YouTube 链接或本地文件 → 转录 →<br/>翻译 → 重新配音 → <b>导出 MP4</b></p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>⌨️ 听写悬浮窗</h3>
    <p>全局快捷键，<b>任意应用</b>中唤起<br/>实时转录、自动粘贴</p>
  </td>
  <td align="center" valign="top">
    <h3>🔊 人声分离</h3>
    <p>Demucs 驱动，分离语音<br/>和背景音乐</p>
  </td>
  <td align="center" valign="top">
    <h3>👥 说话人识别</h3>
    <p>Pyannote + WhisperX<br/><b>自动识别</b>谁在说话</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>📦 批量处理</h3>
    <p>丢进 <b>50 个视频</b>，走开<br/>每个任务独立进度条</p>
  </td>
  <td align="center" valign="top">
    <h3>🤖 MCP 服务</h3>
    <p>在 <b>Claude</b>、Cursor 等<br/>MCP 客户端中使用 OmniVoice</p>
  </td>
  <td align="center" valign="top">
    <h3>🛡️ AI 水印</h3>
    <p>AudioSeal (Meta) 隐形水印<br/>抗压缩，可验证</p>
  </td>
</tr>
<tr>
  <td align="center" valign="top">
    <h3>🔐 100% 本地</h3>
    <p>无需密钥、无需云端、<br/><b>无需注册账号</b></p>
  </td>
  <td align="center" valign="top">
    <h3>⚡ GPU 自动检测</h3>
    <p>CUDA · MPS · ROCm · CPU<br/>≤8 GB 显存？<b>自动卸载</b></p>
  </td>
  <td align="center" valign="top">
    <h3>🧩 可扩展</h3>
    <p>继承 <code>TTSBackend</code><br/><b>~50 行代码</b>接入新引擎</p>
  </td>
</tr>
</table>

---

## 快速开始

<table>
<tr>
<td width="33%" align="center">
<h3>🖥️ 桌面应用</h3>
<sub><b>最简单</b> · ~2 分钟</sub>
<br/><br/>
<a href="https://github.com/caaaaaleb/OmniVoice-Studio/releases/download/v0.2.7-fix1/OmniVoice_Studio_0.2.7_x64.msi"><img src="https://img.shields.io/badge/下载-Windows_MSI_(修复版)-10b981?style=for-the-badge" alt="下载"/></a>
<br/><br/>
<sub>首次启动自动安装 Python 环境并下载模型<br/>在启动画面可以看到进度</sub>
</td>
<td width="33%" align="center">
<h3>🐳 Docker</h3>
<sub><b>一条命令</b> · ~3 分钟</sub>
<br/><br/>
<code>docker pull ghcr.io/debpalash/omnivoice-studio</code>
<br/><br/>
<sub>预构建镜像，支持 CPU + NVIDIA GPU</sub>
</td>
<td width="33%" align="center">
<h3>⚡ 源码运行</h3>
<sub><b>完全可控</b> · ~5 分钟</sub>
<br/><br/>
<code>git clone → bun install → bun run dev</code>
<br/><br/>
<sub>热重载，完整代码访问<br/>适合开发者</sub>
</td>
</tr>
</table>

---

### 🖥️ 方式一 — 桌面应用

在 [Releases](https://github.com/caaaaaleb/OmniVoice-Studio/releases) 页面下载安装包（~7 MB）。安装、启动即可。应用会自动安装 Python 环境和下载模型权重。

<details>
<summary><b>Windows — 首次启动需要 5–10 分钟</b></summary>
<br/>

首次运行会引导安装 Python 虚拟环境、下载依赖和 ffmpeg。启动画面会显示每一步的进度。后续启动只需几秒。
</details>

<details>
<summary><b>macOS — 提示"app 已损坏无法打开"</b></summary>
<br/>

将应用拖入 `/Applications` 后，在终端运行：

```bash
xattr -cr /Applications/OmniVoice\ Studio.app
```

然后正常打开即可，只需操作一次。
</details>

<details>
<summary><b>国内网络 — 下载慢或连不上</b></summary>
<br/>

桌面应用首次启动时需要从 GitHub 和 HuggingFace 下载文件。如果网络受限：

1. 设置 HuggingFace 镜像：启动前设置环境变量 `HF_ENDPOINT=https://hf-mirror.com`
2. 设置 PyPI 镜像：设置 `UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/`
3. 或直接从源码运行，配合代理使用

如果后端报 "Could not import module AutoModel" 错误，请使用本 Fork 的[修复版](https://github.com/caaaaaleb/OmniVoice-Studio/releases/tag/v0.2.7-fix1)。
</details>

---

### 🐳 方式二 — Docker

从 GitHub Container Registry 拉取预构建镜像：

```bash
docker pull ghcr.io/debpalash/omnivoice-studio:latest
```

**运行（CPU）：**
```bash
docker run -d --name omnivoice \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  ghcr.io/debpalash/omnivoice-studio:latest
```

**运行（NVIDIA GPU）：**
```bash
docker run -d --name omnivoice --gpus all \
  -p 127.0.0.1:3900:3900 \
  -v omnivoice-data:/app/omnivoice_data \
  ghcr.io/debpalash/omnivoice-studio:latest
```

**使用 Docker Compose（推荐）：**
```bash
# CPU
docker compose -f deploy/docker-compose.yml --profile cpu up -d

# GPU (NVIDIA)
docker compose -f deploy/docker-compose.yml --profile gpu up -d
```

---

### ⚡ 方式三 — 源码运行

```bash
git clone https://github.com/caaaaaleb/OmniVoice-Studio.git && cd OmniVoice-Studio
bun install && bun run dev
```

打开 [localhost:3901](http://localhost:3901) 即可使用。前后端均支持热重载。

```bash
bun run desktop    # 构建原生桌面应用
```

| 服务 | 地址 | 技术栈 |
|------|------|--------|
| **后端** | `localhost:3900` | FastAPI · WhisperX · Demucs · OmniVoice |
| **前端** | `localhost:3901` | React · Vite · 波形时间线 · 玻璃拟态 UI |
| **API 文档** | [`localhost:3900/docs`](http://localhost:3900/docs) | Scalar — 交互式 API 文档 |

> [!NOTE]
> 首次运行会下载模型权重（~2.4 GB），无需注册。建议设置 `HF_ENDPOINT=https://hf-mirror.com` 加速下载。

---

## 系统要求

| | **最低配置** | **推荐配置** |
|---|---|---|
| **操作系统** | Windows 10, macOS 12+, Ubuntu 20.04+ | 任意现代 64 位系统 |
| **内存** | 8 GB | 16 GB+ |
| **显存 (GPU)** | 4 GB（自动将 TTS 卸载到 CPU） | 8 GB+ (NVIDIA RTX 3060+) |
| **磁盘** | 10 GB（模型 + 缓存） | 20 GB+ SSD |
| **Python** | 3.10+（由 `uv` 管理） | 3.11–3.12 |
| **GPU** | 可选 — CPU 也能跑 | NVIDIA CUDA · Apple Silicon MPS · AMD ROCm |

---

### TTS 引擎

| 引擎 | 语言数 | 克隆 | Instruct | Linux | macOS ARM | Windows | 许可证 |
|------|:------:|:----:|:--------:|:-----:|:---------:|:-------:|:------:|
| **OmniVoice** (默认) | 600+ | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | 内置 |
| **CosyVoice 3** | 9 + 18 方言 | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **MLX-Audio** | 多语言 | 视引擎 | 视引擎 | ❌ | ✅ 原生 | ❌ | 视引擎 |
| **VoxCPM2** | 30 | ✅ | ✅ | ✅ CUDA/CPU | ✅ MPS | ✅ CUDA/CPU | Apache-2.0 |
| **MOSS-TTS-Nano** | 20 | ✅ | ❌ | ✅ CUDA/CPU | ✅ CPU | ✅ CUDA/CPU | Apache-2.0 |
| **KittenTTS** | 英语 | ❌ | ❌ | ✅ CPU | ✅ CPU | ✅ CPU | MIT |

---

## 架构

```
┌─────────────────────────────────────────────────┐
│                  前端 (React)                     │
│  DubTab · VoicePreview · BatchQueue · Gallery    │
├─────────────────────────────────────────────────┤
│                后端 (FastAPI)                     │
│   97 个 API 接口 · SSE 流式传输 · SQLite          │
├──────────┬──────────┬──────────┬────────────────┤
│ WhisperX │  Demucs  │OmniVoice │   Pyannote     │
│   语音识别 │  音源分离  │   TTS    │   说话人识别    │
└──────────┴──────────┴──────────┴────────────────┘
         CUDA / MPS / ROCm / CPU（自动检测）
```

---

## 参与贡献

欢迎提交 Bug 修复、新引擎适配、UI 改进、文档翻译等各类贡献。

- 📖 阅读 [贡献指南](CONTRIBUTING.md)（英文）
- 🐛 查看 [good first issues](https://github.com/debpalash/OmniVoice-Studio/labels/good%20first%20issue)
- 💬 加入 [Discord](https://discord.gg/bzQavDfVV9) 讨论想法

本 Fork 专注于改善国内用户和 Windows 平台的体验。如有问题或建议，欢迎提 [Issue](https://github.com/caaaaaleb/OmniVoice-Studio/issues)。

---

## FAQ

<details>
<summary><b>效果真的能和 ElevenLabs 比吗？</b></summary>
<br/>
语音克隆和配音方面——可以的。OmniVoice 使用最先进的扩散 TTS 模型，支持 646 种语言（ElevenLabs 只支持 32 种）。大多数场景下质量相当。ElevenLabs 的优势在于成熟的云 API 和预设语音库；OmniVoice 的优势在于隐私、成本、语言覆盖度和可定制性。
</details>

<details>
<summary><b>支持苹果芯片（M1/M2/M3/M4）吗？</b></summary>
<br/>
支持。MPS 加速自动检测。Apple 设备上还有 MLX 优化的 Whisper 模型，转录速度更快。
</details>

<details>
<summary><b>需要多少显存？</b></summary>
<br/>
<b>最低 4 GB。</b> ≤8 GB 显存时，TTS 模型会自动在转录期间卸载到 CPU。8 GB+ 时全部在 GPU 上运行。没有 GPU？CPU 模式也能跑，只是 TTS 大约慢 3 倍。
</details>

<details>
<summary><b>支持哪些语言？</b></summary>
<br/>
TTS 支持 646 种语言（OmniVoice 模型）。语音识别（WhisperX）支持 99 种语言。翻译覆盖范围取决于目标语言组合。
</details>

<details>
<summary><b>Windows 上启动报 "Could not import module AutoModel" 怎么办？</b></summary>
<br/>
这是端口冲突问题。旧的后端进程残留在端口上，新进程无法绑定。请使用本 Fork 的<a href="https://github.com/caaaaaleb/OmniVoice-Studio/releases/tag/v0.2.7-fix1">修复版</a>，已解决此问题。或者手动杀掉残留的 Python 进程后重试。
</details>

---

## 许可证

OmniVoice Studio 基于 [**Functional Source License (FSL-1.1-ALv2)**](https://fsl.software/)。

个人、教育、研究、内部团队和非商业用途**免费**。每个版本在发布两年后自动转为 Apache 2.0。商业使用需获取商业许可证。

详见 [`LICENSE`](LICENSE)。

---

## 致谢

| 项目 | 作用 |
|------|------|
| [**OmniVoice (k2-fsa)**](https://github.com/k2-fsa/OmniVoice) | 零样本扩散 TTS 引擎——核心语音合成模型 |
| [**WhisperX**](https://github.com/m-bain/whisperX) | 词级语音识别和对齐 |
| [**Demucs (Meta)**](https://github.com/facebookresearch/demucs) | 音源分离，人声提取 |
| [**Pyannote**](https://github.com/pyannote/pyannote-audio) | 说话人识别 |
| [**CTranslate2**](https://github.com/OpenNMT/CTranslate2) | 优化的 CPU/GPU Transformer 推理 |
| [**AudioSeal (Meta)**](https://github.com/facebookresearch/audioseal) | 隐形神经网络音频水印 |
| [**Tauri**](https://tauri.app) | 原生桌面应用框架 |

---

<div align="center">
<br/>
⭐ <b>给项目点个 Star</b> 让更多人发现它<br/>
💬 <a href="https://discord.gg/bzQavDfVV9"><b>加入 Discord</b></a> 分享你的作品

<br/>
<br/>

  <a href="https://star-history.com/#debpalash/OmniVoice-Studio&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date" />
      <img alt="Star History" src="https://api.star-history.com/svg?repos=debpalash/OmniVoice-Studio&type=Date&theme=dark" width="600" />
    </picture>
  </a>
</div>
