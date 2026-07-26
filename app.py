#!/usr/bin/env python3
"""chat_server.py — Flask + SocketIO 聊天服务器"""
import os
import json
import uuid
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from sqlalchemy import func
import requests
from werkzeug.utils import secure_filename
from config import HOST, PORT, SECRET_KEY, DB_PATH, HERMES_API_BASE
from models import db, User, Chat, Message, ChatUser, Topic
from hermes_adapter import get_adapter, create_bot_session, get_bot_session, append_bot_message, send_to_hermes, clear_hermes_session

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# 初始化数据库
app = Flask(__name__)
app.config["SECRET_KEY"] = SECRET_KEY
app.config["SQLALCHEMY_DATABASE_URI"] = (
    f"sqlite:///{os.path.abspath(DB_PATH)}"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
CORS(app)
db.init_app(app)

with app.app_context():
    db.create_all()

# SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# Sid → username 映射 (用于 disconnect 时正确识别用户)
_sid_to_user: dict[str, str] = {}
# Sid → rooms mapping for disconnect cleanup
_sid_rooms: dict[str, set] = {}
print(f"\n🚀 聊天服务器 running at http://0.0.0.0:{PORT}")


# ==================== API Routes ====================

# === Sid ↔ Username 注册 ===

@socketio.on("register")
def on_register(data: dict):
    sid = request.sid
    username = data.get("username", "")
    if not username:
        return
    _sid_to_user[sid] = username
    print(f"  📝 {username} 注册 sid={sid}")

@app.route("/")
def index():
    return render_template("chat.html")


@app.route("/chat")
def chat_page():
    return render_template("chat.html")


@app.route("/static/sw.js")
def service_worker():
    return app.send_static_file("sw.js"), 200, {"Content-Type": "application/javascript"}


# ---------- Auth ----------

@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    if not username:
        return jsonify(error="请输入用户名", code=400), 400
    user = db.session.execute(
        db.select(User).filter_by(username=username)
    ).scalar_one_or_none()
    if not user:
        user = User(username=username)
        db.session.add(user)
        db.session.commit()
    return jsonify(
        username=user.username,
        avatar=user.avatar or "",
        created_at=user.created_at.isoformat()
    )


@app.route("/api/user/me", methods=["GET"])
def me():
    username = request.args.get("username")
    user = db.session.execute(
        db.select(User).filter_by(username=username)
    ).scalar_one_or_none()
    if not user:
        return jsonify(error="用户不存在", code=404), 404
    return jsonify(
        username=user.username,
        avatar=user.avatar or "",
        created_at=user.created_at.isoformat()
    )


# ---------- Chats ----------

@app.route("/api/chats", methods=["GET"])
def list_chats():
    username = request.args.get("username", "")
    if not username:
        return jsonify([])
    chats = ChatUser.query.filter_by(username=username).all()
    result = []
    for cu in chats:
        chat = cu.chat
        last_msg = db.session.execute(
            db.select(Message)
            .where(Message.chat_id == chat.id)
            .order_by(Message.timestamp.desc())
            .limit(1)
        ).scalar_one_or_none()
        last_msg_preview = last_msg.content[:30] if last_msg else None
        last_ts = last_msg.timestamp.isoformat() if last_msg else ""
        unread = db.session.execute(
            db.select(func.count(Message.id)).where(
                Message.chat_id == chat.id,
                Message.sender != username,
                ~Message.is_read,
                Message.topic_id.is_(None)
            )
        ).scalar()
        result.append({
            "chat_id": chat.id,
            "name": chat.name,
            "chat_type": chat.chat_type,
            "last_message": last_msg_preview,
            "last_timestamp": last_ts,
            "unread_count": unread,
            "pinned": bool(chat.pinned),
        })
    # Sort: pinned first, then by last_timestamp descending
    pinned_items = [r for r in result if r["pinned"]]
    unpinned_items = [r for r in result if not r["pinned"]]
    pinned_items.sort(key=lambda x: x["last_timestamp"] or "", reverse=True)
    unpinned_items.sort(key=lambda x: x["last_timestamp"] or "", reverse=True)
    result = pinned_items + unpinned_items
    return jsonify(result)


@app.route("/api/chats/<int:chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    """删除对话（含所有消息、话题、成员）"""
    chat = db.session.get(Chat, chat_id)
    if not chat:
        return jsonify(error="聊天不存在"), 404
    Message.query.filter_by(chat_id=chat_id).delete()
    Topic.query.filter_by(chat_id=chat_id).delete()
    ChatUser.query.filter_by(chat_id=chat_id).delete()
    db.session.delete(chat)
    db.session.commit()
    clear_hermes_session(chat_id)
    return jsonify(ok=True)


@app.route("/api/chats/<int:chat_id>/pin", methods=["POST"])
def pin_chat(chat_id):
    chat = db.session.get(Chat, chat_id)
    if not chat:
        return jsonify(error="聊天不存在"), 404
    chat.pinned = True
    db.session.commit()
    return jsonify(ok=True, pinned=True)


@app.route("/api/chats/<int:chat_id>/unpin", methods=["POST"])
def unpin_chat(chat_id):
    chat = db.session.get(Chat, chat_id)
    if not chat:
        return jsonify(error="聊天不存在"), 404
    chat.pinned = False
    db.session.commit()
    return jsonify(ok=True, pinned=False)


@app.route("/api/chats", methods=["POST"])
def create_chat():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    chat_type = data.get("chat_type", "direct")
    creator = data.get("creator", "")
    if not creator:
        return jsonify(error="需要用户名", code=400), 400
    
    chat = Chat(
        name=name or "未命名聊天",
        chat_type=chat_type,
        created_by=creator,
    )
    db.session.add(chat)
    db.session.flush()
    cu = ChatUser(username=creator, chat_id=chat.id)
    db.session.add(cu)
    db.session.commit()
    return jsonify(chat_id=chat.id, name=chat.name), 201


@app.route("/api/chats/<int:chat_id>/users", methods=["POST"])
def add_user_to_chat(chat_id):
    data = request.get_json() or {}
    username = data.get("username", "")
    if not username:
        return jsonify(error="需要用户名", code=400), 400
    if ChatUser.query.filter_by(chat_id=chat_id, username=username).first():
        return jsonify(ok=True)
    cu = ChatUser(chat_id=chat_id, username=username)
    db.session.add(cu)
    db.session.commit()
    socketio.emit("user_joined", {"chat_id": chat_id, "username": username}, namespace="/")
    return jsonify(ok=True)


@app.route("/api/chats/<int:chat_id>/users", methods=["GET"])
def chat_users(chat_id):
    users = ChatUser.query.filter_by(chat_id=chat_id).all()
    return jsonify([u.username for u in users])


# ---------- Topics ----------

@app.route("/api/chats/<int:chat_id>/topics", methods=["GET"])
def list_topics(chat_id):
    topics = Topic.query.filter_by(chat_id=chat_id).order_by(Topic.created_at.desc()).all()
    return jsonify([
        {"topic_id": t.id, "name": t.name, "created_at": t.created_at.isoformat()}
        for t in topics
    ])


@app.route("/api/chats/<int:chat_id>/topics", methods=["POST"])
def create_topic(chat_id):
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        name = f"话题 {datetime.now().strftime('%H:%M')}"
    creator = data.get("creator", "system")
    
    topic = Topic(chat_id=chat_id, name=name, created_by=creator)
    db.session.add(topic)
    db.session.flush()
    
    # 加入一个系统消息作为话题开始
    sys_msg = Message(
        chat_id=chat_id,
        topic_id=topic.id,
        sender="system",
        content=f"话题「{name}」已创建",
        msg_type="system",
    )
    db.session.add(sys_msg)
    db.session.commit()
    
    socketio.emit("topic_created", {"chat_id": chat_id, "topic_id": topic.id, "name": name}, namespace="/")
    return jsonify(topic_id=topic.id, name=name), 201


# ---------- Messages ----------

@app.route("/api/chats/<int:chat_id>/messages", methods=["GET"])
def get_messages(chat_id):
    since = request.args.get("since", "")
    try:
        limit = int(request.args.get("limit", 50))
    except (ValueError, TypeError):
        limit = 50
    topic_id = request.args.get("topic_id", "")
    
    query = Message.query.filter_by(chat_id=chat_id)
    if topic_id:
        query = query.filter_by(topic_id=topic_id)
    if since:
        try:
            query = query.filter(Message.timestamp > datetime.fromisoformat(since))
        except (ValueError, TypeError):
            pass  # ignore malformed since parameter
    messages = query.order_by(Message.timestamp.desc()).limit(limit).all()
    
    return jsonify([
        {
            "id": m.id,
            "chat_id": m.chat_id,
            "topic_id": m.topic_id,
            "sender": m.sender,
            "content": m.content,
            "msg_type": m.msg_type,
            "file_name": m.file_name,
            "file_url": m.file_url,
            "timestamp": m.timestamp.isoformat(),
        }
        for m in reversed(messages)
    ])


@app.route("/api/messages/mark_read", methods=["POST"])
def mark_read():
    data = request.get_json() or {}
    chat_id = data.get("chat_id")
    sender = data.get("sender")
    if chat_id and sender:
        db.session.execute(
            Message.__table__.update().where(
                Message.chat_id == chat_id,
                Message.sender != sender,
                ~Message.is_read
            ).values(is_read=True)
        )
        db.session.commit()
        # Broadcast read acknowledgment to the chat room
        try:
            socketio.emit("messages_marked_read", {"chat_id": chat_id}, room=f"chat_{chat_id}")
        except Exception:
            pass
    return jsonify(ok=True)


# ---------- WebSocket Events ----------

@socketio.on("connect")
def ws_connect():
    print(f"  ✅ 客户端连接: {request.sid}")


@socketio.on("disconnect")
def ws_disconnect():
    sid = request.sid
    username = _sid_to_user.pop(sid, "unknown")
    
    # Clean up rooms tracked for this sid
    rooms = _sid_rooms.pop(sid, set())
    for room in rooms:
        try:
            emit("user_left", {"username": username, "room": room}, room=room, broadcast=True)
            leave_room(room)
        except Exception:
            pass
    print(f"  ❌ 客户端断开: {sid} ({username})")
    print("  📡 活跃 sid: " + str(list(_sid_to_user.keys())))


@socketio.on("join_chat")
def on_join_chat(data):
    chat_id = data.get("chat_id")
    topic_id = data.get("topic_id", None)
    room_name = f"chat_{chat_id}"
    join_room(room_name)
    # Track room membership for disconnect cleanup
    sid = request.sid
    _sid_rooms.setdefault(sid, set()).add(room_name)
    if topic_id:
        emit("topic_joined", {"topic_id": topic_id})
    username = _sid_to_user.get(sid, "unknown")
    print(f"  → 用户 {username} 加入聊天 {room_name}")


@socketio.on("leave_chat")
def on_leave_chat(data):
    chat_id = data.get("chat_id")
    room_name = f"chat_{chat_id}"
    leave_room(room_name)
    # Remove from tracking
    sid = request.sid
    if sid in _sid_rooms:
        _sid_rooms[sid].discard(room_name)
    username = _sid_to_user.get(sid, "unknown")
    emit("user_left", {"username": username, "room": room_name}, room=room_name, broadcast=True)
    print(f"  ← 用户 {username} 离开聊天 {room_name}")


@socketio.on("sendMessage")
def on_send_message(data):
    chat_id = data.get("chat_id")
    sender = data.get("sender")
    content = data.get("content", "").strip()
    msg_type = data.get("msg_type", "text")
    topic_id = data.get("topic_id")
    file_name = data.get("file_name")
    file_url = data.get("file_url")
    
    if not sender or not content:
        return
    
    msg = Message(
        chat_id=chat_id,
        topic_id=topic_id,
        sender=sender,
        content=content,
        msg_type=msg_type,
        file_name=file_name,
        file_url=file_url,
    )
    db.session.add(msg)
    db.session.commit()
    
    payload = {
        "id": msg.id,
        "chat_id": msg.chat_id,
        "topic_id": msg.topic_id,
        "sender": msg.sender,
        "content": msg.content,
        "msg_type": msg.msg_type,
        "file_name": msg.file_name,
        "file_url": msg.file_url,
        "timestamp": msg.timestamp.isoformat(),
    }
    
    emit("newMessage", payload, room=f"chat_{chat_id}")
    
    # 如果是 topic 消息，也通知该 topic 的所有用户
    if topic_id:
        emit("topicMessage", payload, room=f"chat_{chat_id}_topic_{topic_id}")
    
    # Hermes 自动回复：如果启用了 HERMES_AUTO_REPLY，检查用户是否开启了自动回复
    if os.environ.get("HERMES_AUTO_REPLY", "false").lower() == "true":
        try:
            if _should_auto_reply(chat_id, sender):
                socketio.start_background_task(_auto_reply, chat_id, sender, content, topic_id)
        except Exception as e:
            print(f"[AutoReply] Error: {e}")


# ---------- File Upload (NJU Box) ----------

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def _get_box_token():
    """从文件读取 NJU Box token，不存在则用空字符串。"""
    try:
        with open("/tmp/box_token_raw.txt", "r") as f:
            token = f.read().strip()
        return token if token else ""
    except FileNotFoundError:
        return ""


# 全局 requests Session 复用连接
_box_session = requests.Session()


def _upload_to_box(file_path, filename):
    """上传文件到 NJU Box，返回下载链接（可能为空）。"""
    token = _get_box_token()
    if not token:
        return ""

    repo_id = os.environ.get(
        "BOX_REPO_ID", "26fa0b5f-a7e0-429f-9d7f-8ecda8ef1a66"
    )
    try:
        # Step 1: 获取上传链接
        resp = _box_session.post(
            f"https://box.nju.edu.cn/api2/repos/{repo_id}/upload-link/",
            headers={"Authorization": f"Token {token}"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        upload_url = data.get("upload_url", "")
        if not upload_url:
            return ""

        # Step 2: 上传文件
        with open(file_path, "rb") as f:
            resp = _box_session.post(
                upload_url,
                files={"file": (filename, f, "application/octet-stream")},
                timeout=60,
            )
        if resp.status_code not in (200, 201):
            print(f"[Box] Upload failed: {resp.status_code}")
            return ""

        # Step 3: 获取文件路径并构造下载链接
        file_path_remote = f"/{filename}"
        resp = _box_session.get(
            f"https://box.nju.edu.cn/api2/repos/{repo_id}" + file_path_remote,
            headers={"Authorization": f"Token {token}"},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("download_url", "")

    except Exception as e:
        print(f"[Box] Error: {e}")
        return ""


# --- Hermes Auto Reply ---
# In-memory store for per-chat auto-reply settings
# Format: { chat_id: { username: {"auto_reply": bool, "hermes_enabled": bool} } }
_auto_reply_settings: dict[int, dict[str, dict]] = {}


def _should_auto_reply(chat_id: int, username: str) -> bool:
    """检查用户是否对该聊天开启了自动回复。"""
    chat_settings = _auto_reply_settings.get(chat_id, {})
    user_settings = chat_settings.get(username, {})
    return user_settings.get("auto_reply", False)


def _auto_reply(chat_id: int, sender: str, message: str, topic_id: int | None = None):
    """同步发送消息到 LLM provider 并回复（在后台线程中运行）。"""
    try:
        adapter = get_adapter()
        reply = adapter.send(sender, chat_id, message, topic_id)

        with app.app_context():
            reply_msg = Message(
                chat_id=chat_id,
                topic_id=topic_id,
                sender="hermes_agent",
                content=reply,
                msg_type="text",
            )
            db.session.add(reply_msg)
            db.session.commit()

            payload = {
                "id": reply_msg.id,
                "chat_id": reply_msg.chat_id,
                "topic_id": reply_msg.topic_id,
                "sender": reply_msg.sender,
                "content": reply_msg.content,
                "msg_type": reply_msg.msg_type,
                "timestamp": reply_msg.timestamp.isoformat(),
                "is_bot": True,
            }

        socketio.emit("newMessage", payload, room=f"chat_{chat_id}")
        if topic_id:
            socketio.emit("topicMessage", payload, room=f"chat_{chat_id}_topic_{topic_id}")

        print(f"[AutoReply] Reply to chat_{chat_id} topic_{topic_id}")
    except Exception as e:
        print(f"[AutoReply] Error: {e}")


# Auto-reply settings API
@app.route("/api/chats/<int:chat_id>/auto-reply-settings", methods=["GET"])
def get_auto_reply_settings(chat_id):
    username = request.args.get("username")
    if not username:
        return jsonify(error="需要用户名", code=400), 400
    chat_settings = _auto_reply_settings.get(chat_id, {})
    return jsonify(chat_settings.get(username, {"auto_reply": True, "hermes_enabled": True}))


@app.route("/api/chats/<int:chat_id>/auto-reply-settings", methods=["POST"])
def set_auto_reply_settings(chat_id):
    data = request.get_json() or {}
    username = data.get("username")
    if not username:
        return jsonify(error="需要用户名", code=400), 400
    auto_reply = data.get("auto_reply", True)
    hermes_enabled = data.get("hermes_enabled", True)
    if chat_id not in _auto_reply_settings:
        _auto_reply_settings[chat_id] = {}
    _auto_reply_settings[chat_id][username] = {
        "auto_reply": auto_reply,
        "hermes_enabled": hermes_enabled,
    }
    return jsonify(ok=True)



@app.route("/api/upload", methods=["POST"])
def upload_file():
    file = request.files.get("file")
    username = request.form.get("username", "")
    chat_id = request.form.get("chat_id", "")
    if not file or not username:
        return jsonify(error="需要文件名和用户名", code=400), 400
    
    # Save file locally first
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{secure_filename(file.filename)}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    # Defense-in-depth: verify final path is inside UPLOAD_DIR
    if not os.path.abspath(filepath).startswith(os.path.abspath(UPLOAD_DIR)):
        return jsonify(error="非法文件路径", code=400), 400
    file.save(filepath)
    
    # Try NJU Box upload
    box_download_url = ""
    if os.environ.get("BOX_REPO_ID"):
        box_download_url = _upload_to_box(filepath, filename)
    
    # Build accessible URL (local fallback)
    file_url = f"/static/uploads/{filename}"
    if box_download_url:
        file_url = box_download_url
    
    # Save message record (only if chat_id is valid)
    if chat_id and chat_id.isdigit():
        msg = Message(
            chat_id=int(chat_id),
            sender=username,
            content=file.filename,
            msg_type="file",
            file_name=file.filename,
            file_url=file_url,
        )
        db.session.add(msg)
        db.session.commit()
        
        # Broadcast file message to chat room
        payload = {
            "id": msg.id,
            "chat_id": msg.chat_id,
            "topic_id": None,
            "sender": msg.sender,
            "content": msg.content,
            "msg_type": msg.msg_type,
            "file_name": msg.file_name,
            "file_url": msg.file_url,
            "timestamp": msg.timestamp.isoformat(),
        }
        socketio.emit("newMessage", payload, room=f"chat_{msg.chat_id}")
    
    return jsonify({
        "ok": True,
        "url": file_url,
        "filename": file.filename,
        "file_name": file.filename,
        "uploaded_to_box": bool(box_download_url),
    })


@app.route("/static/uploads/<filename>")
def served_file(filename):
    from flask import send_from_directory
    return send_from_directory(UPLOAD_DIR, filename)


# ========== Bot API (直接对话) ==========

@app.route("/api/bot/health", methods=["GET"])
def bot_health():
    """检查 Hermes Gateway 健康状态"""
    try:
        health_url = f"{HERMES_API_BASE}/health"
        resp = requests.get(health_url, timeout=5)
        if resp.status_code == 200:
            return jsonify({"status": "ok"})
        else:
            return jsonify({"status": "error", "message": resp.text}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/bot/chat", methods=["POST"])
def create_bot_chat():
    """创建新的 Bot 对话会话"""
    data = request.get_json() or {}
    username = data.get("username", "user")
    name = data.get("name", "").strip()
    chat_name = name if name else "🤖 Hermes Bot"
    
    # 在数据库创建 Chat 记录，标记为 bot 类型
    chat = Chat(name=chat_name, chat_type="bot", created_by=username)
    db.session.add(chat)
    db.session.flush()  # 获取 chat.id
    
    # 把用户加入聊天（这样能在列表中显示）
    cu = ChatUser(chat_id=chat.id, username=username)
    db.session.add(cu)
    db.session.commit()
    
    # 用 DB 整数 ID 创建 BotSession
    session = create_bot_session(chat.id, username)
    return jsonify({"chat_id": chat.id, "user": session.user})


@app.route("/api/bot/chat/<int:chat_id>", methods=["GET"])
def get_bot_chat(chat_id):
    """验证 Bot 对话是否存在（用于刷新后恢复会话）"""
    chat = Chat.query.get(chat_id)
    if not chat or chat.chat_type != "bot":
        return jsonify({"error": "对话不存在"}), 404
    return jsonify({"chat_id": chat.id, "name": chat.name})


@app.route("/api/bot/send", methods=["POST"])
def bot_send():
    """发送消息给 Bot，获取回复"""
    data = request.get_json() or {}
    chat_id = data.get("chat_id")
    message = data.get("message", "").strip()

    if not message:
        return jsonify({"error": "消息不能为空"}), 400

    # Validate chat_id is numeric
    try:
        chat_id_int = int(chat_id)
    except (ValueError, TypeError):
        return jsonify({"error": "无效的 chat_id"}), 400

    sess = get_bot_session(chat_id_int)
    if not sess:
        # 自动创建会话（服务重启后内存丢失）
        sess = create_bot_session(chat_id_int)

    # 保存用户消息到数据库
    user_msg = Message(
        chat_id=chat_id_int,
        sender=sess.user,
        content=message,
        msg_type="text",
    )
    db.session.add(user_msg)
    db.session.commit()

    # 通过 WebSocket 广播用户消息
    user_payload = {
        "id": user_msg.id,
        "chat_id": user_msg.chat_id,
        "sender": user_msg.sender,
        "content": user_msg.content,
        "msg_type": user_msg.msg_type,
        "timestamp": user_msg.timestamp.isoformat(),
    }
    socketio.emit("newMessage", user_payload, room=f"chat_{chat_id}")

    # 通过 hermes CLI 发送（完整Agent能力），自动管理session
    system_prompt = _bot_system_prompts.get(chat_id_int)
    model = data.get("model")
    reply = send_to_hermes(chat_id_int, message, model=model, system_prompt=system_prompt)

    # 保存 bot 回复到数据库
    bot_msg = Message(
        chat_id=chat_id_int,
        sender="hermes_agent",
        content=reply,
        msg_type="text",
    )
    db.session.add(bot_msg)
    db.session.commit()

    # 通过 WebSocket 广播 bot 回复
    bot_payload = {
        "id": bot_msg.id,
        "chat_id": bot_msg.chat_id,
        "sender": bot_msg.sender,
        "content": bot_msg.content,
        "msg_type": bot_msg.msg_type,
        "timestamp": bot_msg.timestamp.isoformat(),
        "is_bot": True,
    }
    socketio.emit("newMessage", bot_payload, room=f"chat_{chat_id}")

    return jsonify({"chat_id": chat_id, "reply": reply})


@app.route("/api/bot/conversation/<chat_id>", methods=["GET"])
def bot_conversation(chat_id):
    """获取 Bot 对话历史（从数据库读取，重启不丢失）"""
    try:
        chat_id_int = int(chat_id)
    except (ValueError, TypeError):
        return jsonify({"error": "无效的 chat_id"}), 400
    messages = (
        Message.query
        .filter_by(chat_id=chat_id_int)
        .order_by(Message.timestamp.asc())
        .all()
    )
    return jsonify({
        "chat_id": chat_id,
        "conversation": [
            {
                "role": "assistant" if m.sender == "hermes_agent" else "user",
                "content": m.content,
            }
            for m in messages
        ],
    })


# ========== Bot Settings API ==========

# In-memory store for per-chat system prompts
_bot_system_prompts: dict[int, str] = {}


@app.route("/api/bot/<int:chat_id>/system-prompt", methods=["GET"])
def get_system_prompt(chat_id):
    """获取 Bot 的 System Prompt"""
    prompt = _bot_system_prompts.get(chat_id, "")
    return jsonify(system_prompt=prompt)


@app.route("/api/bot/<int:chat_id>/system-prompt", methods=["POST"])
def set_system_prompt(chat_id):
    """设置 Bot 的 System Prompt"""
    data = request.get_json() or {}
    prompt = data.get("system_prompt", "")
    _bot_system_prompts[chat_id] = prompt
    return jsonify(ok=True)


@app.route("/api/bot/<int:chat_id>/clear", methods=["POST"])
def clear_bot_session(chat_id):
    """清空 Bot 会话上下文"""
    data = request.get_json() or {}
    topic_id = data.get("topic_id")
    clear_hermes_session(chat_id, topic_id=topic_id)
    return jsonify(ok=True)


@app.route("/api/chats/<int:chat_id>/export", methods=["GET"])
def export_chat(chat_id):
    """导出聊天记录为 Markdown"""
    chat = db.session.get(Chat, chat_id)
    if not chat:
        return jsonify(error="聊天不存在"), 404

    messages = (
        Message.query
        .filter_by(chat_id=chat_id)
        .order_by(Message.timestamp.asc())
        .all()
    )

    title = f"{chat.name} - Hermes Chat"
    lines = [f"# {title}", "", f"*导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*", ""]

    for m in messages:
        if m.msg_type == "system":
            lines.append(f"> *{m.content}*")
        elif m.msg_type == "file":
            lines.append(f"**{m.sender}** *({m.timestamp.strftime('%H:%M')})*:")
            lines.append(f"📎 [{m.file_name or m.content}]({m.file_url or ''})")
        else:
            role = "🤖" if m.sender == "hermes_agent" else "👤"
            lines.append(f"**{role} {m.sender}** *({m.timestamp.strftime('%H:%M')})*:")
            lines.append("")
            lines.append(m.content)
        lines.append("")

    markdown = "\n".join(lines)
    return jsonify(title=f"{chat.name}.md", markdown=markdown)


# ========== WebSocket Events ==========

if __name__ == "__main__":
    socketio.run(app, host=HOST, port=PORT, debug=True, allow_unsafe_werkzeug=True)
