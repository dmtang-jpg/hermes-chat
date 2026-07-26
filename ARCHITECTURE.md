# 模块化聊天服务器 — 架构文档

## 技术栈
- **后端**: Python + Flask + Flask-SocketIO + Flask-SQLAlchemy
- **数据库**: SQLite
- **前端**: HTML + TypeScript/JavaScript + CSS（Telegram 深色主题）
- **通信**: WebSocket (SocketIO) + REST API

## 项目结构
```
chat/
├── app.py                 # 主服务器，Flask + SocketIO, 路由，WebSocket 事件
├── config.py              # 配置（服务器，数据库，NJU Box, Hermes API）
├── models.py              # 数据库模型（User, Chat, Message, ChatUser, Topic）
├── hermes_adapter.py      # Hermes Agent 适配器（HTTP/Gateway 通信）
├── requirements.txt       # Python 依赖
├── start.sh               # 启动脚本
├── templates/
│   └── chat.html          # 前端页面（登录，聊天，话题面板）
├── static/
│   ├── css/
│   │   └── style.css      # Telegram 深色主题样式
│   └── js/
│       └── app.js         # 前端 JS（WebSocket 连接，消息收发，文件上传）
└── uploads/               # 本地文件存储目录
```

## 核心模块

### 1. app.py — 后端服务

#### API 路由
- `GET /` — 登录页
- `POST /api/auth/login` — 用户登录
- `GET /api/user/me` — 获取当前用户信息
- `GET /api/chats` — 获取聊天列表
- `POST /api/chats` — 创建聊天
- `POST /api/chats/<chat_id>/users` — 添加用户到聊天
- `GET /api/chats/<chat_id>/users` — 获取聊天用户
- `GET /api/chats/<chat_id>/topics` — 获取话题列表
- `GET /api/chats/<chat_id>/messages` — 获取消息（支持 since, limit, topic_id 过滤）
- `POST /api/messages/mark_read` — 标记消息已读
- `GET /api/chats/<chat_id>/auto-reply-settings` — 获取自动回复设置
- `POST /api/chats/<chat_id>/auto-reply-settings` — 设置自动回复
- `POST /api/upload` — 文件上传（支持 NJU Box 上传）
- `GET /static/uploads/<filename>` — 提供本地上传文件服务

#### WebSocket 事件
- `register` — 客户端注册用户名
- `connect` / `disconnect` — 连接/断开
- `join_chat` / `leave_chat` — 加入/离开聊天
- `sendMessage` — 发送消息（文本/文件/话题消息，支持自动回复）
- 广播事件：`newMessage`, `topicMessage`, `user_joined`, `user_left`, `topic_created`, `topic_joined`

#### NJU Box 上传
- `_get_box_token()` — 从 `/tmp/box_token_raw.txt` 读取 token
- `_upload_to_box()` — 三步上传：获取上传链接 → 上传文件 → 获取下载链接
- 上传到本地 + NJU Box 双备份

#### Hermes 自动回复
- 异步发送消息到 Hermes Agent（`asyncio.create_task`）
- 支持 per-chat per-user 设置
- 通过 `hermes_adapter.py` 与 Agent 通信

### 2. hermes_adapter.py — Hermes Agent 适配器

#### 通信模式
- `api`（默认）— HTTP API 到 Hermes Gateway（`http://127.0.0.1:8000`）
- `gateway` — WebSocket/gRPC 到本地 Hermes Gateway

#### 类与方法
- `HermesAdapter(api_base, api_key, mode)` — 构造函数
- `HermesAdapter.send(user, chat_id, message, topic_id)` — 异步发送消息，返回回复文本
- `HermesAdapter.format_reply(message_id, user, reply, topic_id)` — 格式化为数据库消息记录
- `get_adapter()` — 获取全局适配器实例（延迟初始化）

#### 环境变量
- `HERMES_API_BASE` — Hermes API 地址（默认 `http://127.0.0.1:8000`）
- `HERMES_API_KEY` — API Key（Bearer token）
- `HERMES_ADAPTER_MODE` — 通信模式（`api` 或 `gateway`）
- `HERMES_AUTO_REPLY` — 启用自动回复（`true` 或 `false`）
- `HERMES_MODEL` — 使用的模型名称

### 3. models.py — 数据库模型

#### 模型定义
- `User` — 用户表（username, avatar, created_at）
- `Chat` — 聊天表（name, chat_type, is_group, created_by, created_at）
- `Message` — 消息表（chat_id, topic_id, sender, content, msg_type, file_name, file_url, is_read, timestamp）
- `ChatUser` — 聊天用户关系表（chat_id, username）
- `Topic` — 话题表（chat_id, name, created_by, created_at, archived）

### 4. config.py — 配置

- `HOST` — 服务器地址（默认 `0.0.0.0`）
- `PORT` — 端口（默认 `5005`）
- `SECRET_KEY` — Flask 密钥
- `DB_PATH` — SQLite 数据库路径
- `BOX_REPO_ID` — NJU Box 仓库 ID
- `BOX_TOKEN_FILE` — NJU Box token 文件路径
- `HERMES_API_BASE` — Hermes API 地址

### 5. 前端

#### chat.html
- 登录页面（用户名输入）
- 主聊天界面（消息列表，输入框）
- 话题面板（话题列表，创建话题）
- Telegram 深色主题（参考 `style.css`）

#### app.js
- WebSocket 连接（SocketIO）
- 消息收发（`sendMessage`, 监听 `newMessage`, `topicMessage`）
- 话题切换（`join_topic`, 监听 `topicMessage`）
- 文件上传（`uploadFile`, 调用 `/api/upload`，处理文件消息）
- 用户登录（`fetchLogin`, 存储用户名）
- 页面加载消息（`loadChatMessages`, 分页加载历史消息）

## 数据流

### 消息发送
1. 用户 A 发送消息 → `sendMessage` WebSocket 事件
2. 服务器保存消息到数据库 ✅
3. 广播消息到其他客户端 ✅
4. 如果是话题消息，广播到话题房间 ✅
5. 启用自动回复时，异步发送到 Hermes Agent ✅
6. Agent 回复后，创建新消息并广播 ✅

### 文件上传
1. 前端 `uploadFile` → `POST /api/upload`
2. 服务器保存到本地 `uploads/` 目录
3. 同时上传到 NJU Box（如果需要）
4. 创建文件消息记录 ✅
5. 返回文件 URL 给前端 ✅
6. 前端显示文件消息并允许下载 ✅

## 扩展点

### 新功能扩展
- **用户头像**: 添加 `/api/user/<username>/avatar` 路由
- **消息删除**: 添加 `DELETE /api/messages/<msg_id>` 路由
- **消息编辑**: 添加 `PUT /api/messages/<msg_id>` 路由
- **消息搜索**: 添加 `/api/chats/<chat_id>/search?q=` 路由
- **离线消息**: 添加 Redis/PubSub 支持离线消息队列
- **消息加密**: 添加端到端加密（E2EE）支持

### 插件化扩展
- **消息类型扩展**: 在 `msg_type` 中添加新类型（如 `poll`, `vote`, `code`）
- **通知扩展**: 在广播消息后添加通知回调
- **存储扩展**: 将 SQLite 替换为 PostgreSQL/MySQL/MongoDB
- **认证扩展**: 添加 OAuth2/JWT 认证支持
- **消息转发**: 支持消息转发到其他聊天/平台（Telegram/Slack/DingTalk）

## 部署与运维

### 启动方式
```bash
cd /home/dmt/workspace/chat
chmod +x start.sh
./start.sh
```

或通过 gunicorn:
```bash
pip install gevent flask-socketio
gunicorn --worker-class gevent --workers 4 --bind 0.0.0.0:5005 app:socketio
```

### 环境变量
- `HOST` — 服务器地址
- `PORT` — 端口（默认 `5005`）
- `HERMES_AUTO_REPLY` — 启用自动回复（`true`/`false`）
- `HERMES_API_KEY` — Hermes API Key
- `HERMES_ADAPTER_MODE` — `api` 或 `gateway`

### 日志
- 控制台输出：连接/断开/消息/AutoReply/Box 错误
- 级别：INFO（默认），ERROR（异常）

### 维护
- 数据库备份：`cp chat.db chat.db.bak.YYYYMMDD`
- 上传目录清理：`find uploads/ -mtime +30 -delete`
- 日志清理：`find logs/ -mtime +7 -delete`

## 安全
- SQLite 文件权限：`chmod 600 chat.db`
- 上传目录权限：`chmod 755 uploads/`
- JWT 认证（可扩展）
- CSRF 保护（flask-cors）
- 文件类型白名单（可扩展）
