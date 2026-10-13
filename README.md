# Vanarasbots (`Vanaras.app`)

**Vanarasbots** is a native macOS multi-agent workspace where every AI agent is a customizable **Vanara** (cute monkey persona) powered by your choice of **Local URL** (LM Studio, Ollama, llama.cpp, vLLM), **OpenRouter**, **Google Gemini**, **OpenAI**, **Anthropic Claude**, or **Qwen**.

---

## Key Capabilities

1. **1:1 Bot DMs & Multi-Agent Group Squads**
   - Chat 1-on-1 with specialist Vanaras (`R1`, `R2`, `R3`, `R4`, `Waffle`, `Hanu`) or combine humans and multiple Vanara bots into shared group rooms (`Project Maaya`).
   - Customize each Vanara's monkey avatar, name, role, system instructions, provider endpoint, and model ID.
2. **Shared Cross-Thread Workspace Memory**
   - Pin architectural decisions and project constraints from any message (`⋯` -> Pin) or manage them in the **Shared Workspace Memory** ledger.
   - Shared facts are persisted to disk (`ui/.vanaras-workspace.json`) and automatically injected into every Vanara's context across 1:1 and Group chats.
3. **Grounded Local Project Mounting & Background Execution**
   - Mount any local directory so Vanaras inspect real file trees and manifests (`Cargo.toml`, `package.json`, `README.md`).
   - Run shell commands directly from chat (`/run <cmd>` or 1-click runnable command pills) with non-blocking background execution.
4. **Frictionless `@Mention` Auto-Complete, Hand-Offs & Deliverable Studio**
   - Type `@` in the composer to summon any Vanara into any conversation.
   - Click **`Let <Vanara> reply`** pills for 1-click bot-to-bot hand-offs, or click **`Collab`** to run an autonomous multi-monkey debate & synthesis into the **Deliverable Studio** (multi-file code & live HTML preview).

---

## Quick Start

### 1. Start the Local Workspace Engine
```bash
node ui/server.mjs
```

### 2. Build & Launch the Native macOS App (`Vanaras.app`)
```bash
./build-macos-app.sh
open Vanaras.app
```

### 3. Rust Engine Workspace
```bash
cargo check
```
