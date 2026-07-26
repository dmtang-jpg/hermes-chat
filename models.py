from datetime import datetime
from sqlalchemy import CheckConstraint
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    avatar = db.Column(db.String(256), default="")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Chat(db.Model):
    __tablename__ = "chats"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(128), nullable=False)
    chat_type = db.Column(db.Enum("direct", "group", "bot"), default="direct")
    __table_args__ = (
        CheckConstraint("chat_type IN ('direct','group','bot')", name="ck_chat_type"),
    )
    admin_id = db.Column(db.ForeignKey("users.id"))
    created_by = db.Column(db.String(64), nullable=False)  # creator username
    created_at = db.Column(db.DateTime, default=datetime.now)
    pinned = db.Column(db.Boolean, default=False)

    # relationships
    users = db.relationship("ChatUser", back_populates="chat")
    messages = db.relationship("Message", back_populates="chat")
    topics = db.relationship("Topic", back_populates="chat")

class Message(db.Model):
    __tablename__ = "messages"
    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chats.id"), nullable=False)
    topic_id = db.Column(db.Integer, db.ForeignKey("topics.id"), nullable=True)
    sender = db.Column(db.String(64), nullable=False)  # username
    content = db.Column(db.Text, default="")
    msg_type = db.Column(db.Enum("text", "image", "file", "system"), default="text")
    file_name = db.Column(db.String(256), nullable=True)
    file_url = db.Column(db.String(256), nullable=True)
    timestamp = db.Column(db.DateTime, default=datetime.now)
    is_read = db.Column(db.Boolean, default=False)
    __table_args__ = (
        CheckConstraint("msg_type IN ('text','image','file','system')", name="ck_msg_type"),
    )
    
    # relationships
    chat = db.relationship("Chat", back_populates="messages")
    topic = db.relationship("Topic", back_populates="messages")

class ChatUser(db.Model):
    __tablename__ = "chat_users"
    chat_id = db.Column(db.ForeignKey("chats.id"), primary_key=True)
    username = db.Column(db.String(64), primary_key=True)
    
    # relationship
    chat = db.relationship("Chat", back_populates="users")


class Topic(db.Model):
    __tablename__ = "topics"
    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.ForeignKey("chats.id"), nullable=False)
    name = db.Column(db.String(128), nullable=False)
    description = db.Column(db.Text, default="")
    created_by = db.Column(db.String(64), nullable=False)  # creator username
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # relationships
    chat = db.relationship("Chat", back_populates="topics")
    messages = db.relationship("Message", back_populates="topic")
