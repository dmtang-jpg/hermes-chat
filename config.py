import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# === 服务器设置 ===
HOST = "0.0.0.0"
PORT = 5005
SECRET_KEY = os.environ.get("CHAT_SECRET_KEY", "dev-secret-key-change-in-production")

# === 数据库 ===
DB_PATH = os.path.join(BASE_DIR, "chat.db")
SQLALCHEMY_DATABASE_URI = f"sqlite:///{DB_PATH}"
SQLALCHEMY_TRACK_MODIFICATIONS = False

# === NJU Box API (方案A: token) ===
BOX_REPO_ID = "26fa0b5f-a7e0-429f-9d7f-8ecda8ef1a66"
BOX_TOKEN_FILE = "/tmp/box_token_raw.txt"

# === LLM Provider 配置 ===
# 支持: "deepseek", "ollama"
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "deepseek")

# DeepSeek
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro")

# Ollama (本地)
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.6:35b-lowtemp")

# DeepSeek
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro")

# === Hermes Gateway (保留兼容) ===
HERMES_API_BASE = "http://127.0.0.1:8080"
