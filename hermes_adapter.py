"""
hermes_adapter.py — Hermes Agent 适配器
通过 hermes CLI 接入完整 Agent 能力（工具/记忆/skills）。
支持: Ollama 本地, DeepSeek V4 (直接API fallback)
"""
import os
import re
import uuid
import subprocess
import requests
from datetime import datetime

# === Provider 配置 (直接API fallback) ===
PROVIDERS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro"),
    },
    "ollama": {
        "base_url": "http://127.0.0.1:11434/v1",
        "api_key": "ollama",
        "model": os.environ.get("OLLAMA_MODEL", "qwen3.6:35b-lowtemp"),
    },
}

# 默认 provider (直接API fallback用)
DEFAULT_PROVIDER = os.environ.get("LLM_PROVIDER", "deepseek")

# Hermes CLI 路径
HERMES_CLI = os.environ.get("HERMES_CLI", "/home/dmt/.hermes/hermes-agent/venv/bin/hermes")
# 默认模型
HERMES_MODEL = os.environ.get("HERMES_MODEL", "deepseek/deepseek-v4-pro")
# 是否优先使用 hermes CLI (完整Agent能力)
USE_HERMES_CLI = os.environ.get("USE_HERMES_CLI", "true").lower() == "true"
# CLI 超时
HERMES_CLI_TIMEOUT = int(os.environ.get("HERMES_CLI_TIMEOUT", "120"))

# Claude Code CLI 路径
CLAUDE_CLI = os.environ.get("CLAUDE_CLI", "/home/dmt/.hermes/node/bin/claude")
CLAUDE_CLI_TIMEOUT = int(os.environ.get("CLAUDE_CLI_TIMEOUT", "120"))

# Claude 工作目录缓存 (per-chat 隔离上下文)
# key = "chat_{chat_id}" → Path
import shutil
_claude_workdirs: dict[str, str] = {}


def _get_claude_workdir(chat_id: int) -> str:
    """获取或创建 Claude 的工作目录（per-chat 上下文隔离）"""
    key = f"chat_{chat_id}"
    if key not in _claude_workdirs:
        wd = f"/tmp/claude_chat_{chat_id}"
        os.makedirs(wd, exist_ok=True)
        _claude_workdirs[key] = wd
    return _claude_workdirs[key]


def _run_claude_cli(message: str, chat_id: int, system_prompt: str = None):
    """调用 Claude Code CLI 发送消息，返回 response。
    
    Claude Code 在同一目录下自动维护上下文；
    System Prompt 写入 CLAUDE.md 文件。
    """
    workdir = _get_claude_workdir(chat_id)
    
    # 首次或 system_prompt 变更时写入 CLAUDE.md
    claude_md = os.path.join(workdir, "CLAUDE.md")
    if system_prompt and (not os.path.exists(claude_md) or 
                          open(claude_md).read() != system_prompt):
        with open(claude_md, "w") as f:
            f.write(system_prompt)
    
    # 生成稳定的 session ID（同一聊天始终复用同一个会话）
    session_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"hermes-chat-{chat_id}"))
    
    cmd = [CLAUDE_CLI, "-p", "--session-id", session_id, message]
    
    try:
        print(f"[ClaudeAdapter] Calling Claude CLI in {workdir}...")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CLAUDE_CLI_TIMEOUT,
            cwd=workdir,
            env={**os.environ, "TERM": "dumb"},
        )
        reply = result.stdout.strip()
        if not reply:
            reply = result.stderr.strip() or "(Claude 返回空回复)"
        
        # 清理 ANSI
        reply = re.sub(r'\x1b\[[0-9;]*m', '', reply)
        
        return reply
    
    except subprocess.TimeoutExpired:
        return f"⚠️ Claude 响应超时 ({CLAUDE_CLI_TIMEOUT}s)"
    except FileNotFoundError:
        return f"⚠️ Claude CLI 未找到: {CLAUDE_CLI}"
    except Exception as e:
        return f"⚠️ Claude CLI 错误: {e}"


# Hermes CLI session ID 缓存 (用于 auto-reply 路径的 --resume)
# key = "chat_{chat_id}_topic_{topic_id}" or "chat_{chat_id}"
_cli_session_cache: dict[str, str] = {}


def _run_hermes_cli(message, session_id=None, model=None):
    """调用 hermes CLI 发送消息，返回 (response, session_id)"""
    cmd = [HERMES_CLI, "chat", "-q", message, "-Q"]
    if session_id:
        cmd.extend(["--resume", session_id])
    if model:
        cmd.extend(["-m", model])
    else:
        cmd.extend(["-m", HERMES_MODEL])

    try:
        print(f"[HermesAdapter] Calling CLI: {' '.join(cmd[:6])}...")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=HERMES_CLI_TIMEOUT,
            env={**os.environ, "TERM": "dumb"},
        )
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        # session_id 在 stderr 中
        sid = None
        for line in stderr.split("\n"):
            if line.startswith("session_id:"):
                sid = line.split(":", 1)[1].strip()
                break

        # 回复在 stdout 中
        reply = stdout if stdout else "(Hermes 返回空回复)"

        # 去掉 ANSI 颜色码
        reply = re.sub(r'\x1b\[[0-9;]*m', '', reply)
        # 去掉 hermes CLI 的警告/提示信息
        reply = re.sub(r'^⚠️\s+Normalized model.*?\n', '', reply, flags=re.MULTILINE).strip()
        # 去掉 toolsets 警告泄漏
        reply = re.sub(r'Warning:\s+Unknown toolsets:.*?\n', '', reply)
        reply = re.sub(r'^Warning:\s+Unknown toolsets:.*$', '', reply, flags=re.MULTILINE)
        # 去掉模型名残渣（如 "deepseek." 单独一行）
        reply = re.sub(r'^(deepseek|ollama|xiaomi)\.\s*$', '', reply, flags=re.MULTILINE)
        # 去掉 resume 提示行
        reply = re.sub(r'\n?hermes --resume \S+', '', reply).strip()
        reply = re.sub(r'\n?Resume this session with:.*', '', reply, flags=re.DOTALL).strip()
        # 去掉 Session/Duration/Messages 统计行 (不用DOTALL避免吞掉正文)
        reply = re.sub(r'\n?Session:\s+\S+.*$', '', reply, flags=re.MULTILINE).strip()
        reply = re.sub(r'\n?Duration:\s+.*$', '', reply, flags=re.MULTILINE).strip()
        reply = re.sub(r'\n?Messages:\s+\d+.*$', '', reply, flags=re.MULTILINE).strip()

        if not reply:
            reply = "(Hermes 返回空回复)"

        return reply, sid

    except subprocess.TimeoutExpired:
        return f"⚠️ Hermes 响应超时 ({HERMES_CLI_TIMEOUT}s)", None
    except FileNotFoundError:
        return f"⚠️ Hermes CLI 未找到: {HERMES_CLI}", None
    except Exception as e:
        return f"⚠️ Hermes CLI 错误: {e}", None


class HermesAdapter:
    """适配器：优先用 hermes CLI（完整Agent），fallback到直接API。"""

    def __init__(self, provider_name=None):
        self.provider_name = provider_name or DEFAULT_PROVIDER
        self.provider = PROVIDERS.get(self.provider_name, PROVIDERS["deepseek"])
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.provider['api_key']}",
        })

    def _chat_completions(self, messages, temperature=0.7, max_tokens=2048):
        """同步调用 OpenAI-compatible /v1/chat/completions (fallback)"""
        url = f"{self.provider['base_url']}/chat/completions"
        payload = {
            "model": self.provider["model"],
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        try:
            resp = self.session.post(url, json=payload, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        except requests.exceptions.RequestException as e:
            print(f"[HermesAdapter] {self.provider_name} error: {e}")
            if self.provider_name != "ollama":
                print(f"[HermesAdapter] Trying ollama fallback...")
                try:
                    fallback = PROVIDERS["ollama"]
                    fallback_session = requests.Session()
                    fallback_session.headers.update({
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {fallback['api_key']}",
                    })
                    url = f"{fallback['base_url']}/chat/completions"
                    payload["model"] = fallback["model"]
                    resp = fallback_session.post(url, json=payload, timeout=120)
                    resp.raise_for_status()
                    return resp.json()["choices"][0]["message"]["content"]
                except Exception as e2:
                    print(f"[HermesAdapter] Ollama fallback also failed: {e2}")
            return f"⚠️ AI 服务暂时不可用: {e}"

    def send(self, user, chat_id, message, topic_id=None, history=None):
        """发送消息，优先用 hermes CLI，fallback 到直接 API"""
        # 优先用 hermes CLI
        if USE_HERMES_CLI:
            # 使用 topic_id 作为 session 的一部分，实现每个话题独立会话
            session_key = f"chat_{chat_id}_topic_{topic_id}" if topic_id else f"chat_{chat_id}"
            cached_sid = _cli_session_cache.get(session_key)
            response, new_sid = _run_hermes_cli(message, session_id=cached_sid)
            if new_sid:
                _cli_session_cache[session_key] = new_sid
            if not response.startswith("⚠️"):
                return response
            print(f"[HermesAdapter] CLI failed, falling back to API: {response}")

        # Fallback: 直接 API
        messages = [
            {"role": "system", "content": f"你是 Hermes，一个有用、友好、专业的AI助手。用户 '{user}' 正在和你对话。"},
        ]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})
        return self._chat_completions(messages)

    def send_with_history(self, messages):
        """直接发送完整消息列表（含 system prompt）"""
        return self._chat_completions(messages)


# 全局适配器实例（延迟初始化）
_adapter = None


def get_adapter():
    global _adapter
    if _adapter is None:
        _adapter = HermesAdapter()
    return _adapter


# === Bot 会话管理 ===

class BotSession:
    def __init__(self, chat_id, user="user"):
        self.user = user
        self.chat_id = int(chat_id)
        self.created = datetime.utcnow()
        self.history = [
            {"role": "system", "content": "你是 Hermes，一个有用、友好、专业的AI助手。"}
        ]
        # Hermes CLI session ID (用于 --resume)
        self.hermes_session_id = None

    def add_message(self, role, content):
        self.history.append({"role": role, "content": content})

    def get_messages(self):
        return self.history


# Bot 会话存储 (key = int chat_id)
_bot_sessions = {}


def create_bot_session(chat_id, user="user"):
    """创建 Bot 会话，chat_id 必须是数据库 Chat 记录的整数 ID"""
    sess = BotSession(chat_id, user)
    _bot_sessions[int(chat_id)] = sess
    return sess


def get_bot_session(chat_id):
    try:
        return _bot_sessions.get(int(chat_id))
    except (ValueError, TypeError):
        return None


def append_bot_message(chat_id, role, content):
    try:
        sess = _bot_sessions.get(int(chat_id))
    except (ValueError, TypeError):
        return
    if sess:
        sess.add_message(role, content)


# === Hermes CLI 会话管理 ===

def send_to_hermes(chat_id, message, model=None, topic_id=None, system_prompt=None):
    """通过 hermes CLI 发送消息，自动管理 session（按topic隔离）"""
    try:
        cid = int(chat_id)
    except (ValueError, TypeError):
        return "⚠️ 无效的 chat_id"
    
    # Per-topic session key for context isolation
    session_key = f"chat_{cid}"
    if topic_id:
        session_key = f"chat_{cid}_topic_{topic_id}"
    
    sess = _bot_sessions.get(session_key)
    is_new_session = not sess
    if is_new_session:
        sess = create_bot_session(cid, user=f"user_{session_key}")
        _bot_sessions[session_key] = sess

    sess.add_message("user", message)

    if USE_HERMES_CLI:
        # 如果是 claude 模型，走 Claude Code CLI
        if model and model.startswith("claude"):
            response = _run_claude_cli(message, cid, system_prompt=system_prompt)
            if not response.startswith("⚠️"):
                sess.add_message("assistant", response)
                return response
            print(f"[send_to_hermes] Claude CLI failed: {response}")
        else:
            cached_sid = _cli_session_cache.get(session_key)
            
            # Prepend system prompt on first message of a new session
            effective_message = message
            if is_new_session and system_prompt:
                effective_message = f"[系统设定]\n{system_prompt}\n\n---\n\n[用户消息]\n{message}"
            
            response, new_sid = _run_hermes_cli(effective_message, session_id=cached_sid, model=model)
            if new_sid:
                _cli_session_cache[session_key] = new_sid
            if not response.startswith("⚠️"):
                sess.add_message("assistant", response)
                return response
            print(f"[send_to_hermes] CLI failed, falling back to API: {response}")

    # Fallback: 直接 API
    adapter = get_adapter()
    response = adapter._chat_completions(sess.get_messages())
    sess.add_message("assistant", response)
    return response


def clear_hermes_session(chat_id, topic_id=None):
    """清空指定会话的上下文"""
    try:
        cid = int(chat_id)
    except (ValueError, TypeError):
        return
    session_key = f"chat_{cid}"
    if topic_id:
        session_key = f"chat_{cid}_topic_{topic_id}"
    _bot_sessions.pop(session_key, None)
    _cli_session_cache.pop(session_key, None)
    # 清理 Claude 工作目录
    claude_key = f"chat_{cid}"
    if claude_key in _claude_workdirs:
        wd = _claude_workdirs.pop(claude_key)
        shutil.rmtree(wd, ignore_errors=True)
    # 清理 Claude Code session 目录（~/.claude/projects/ 下的项目会话）
    claude_proj_dir = os.path.expanduser(f"~/.claude/projects/-tmp-claude-chat-{cid}")
    if os.path.exists(claude_proj_dir):
        shutil.rmtree(claude_proj_dir, ignore_errors=True)
