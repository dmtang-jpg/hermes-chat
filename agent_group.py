"""
agent_group.py — Multi-Agent Group Chat Extension
================================================
Self-contained module. Import once in app.py.
Provides:
- Agent CRUD API (GET/POST/PATCH/DELETE /api/chats/<chat_id>/agents)
- Agent group chat with @mentions and max 5 rounds
"""
from flask import Blueprint, request, jsonify
from models import db, Chat, Message, Agent
from flask_socketio import emit
import re

agent_bp = Blueprint('agent_bp', __name__)


# ── Agent CRUD ──

@agent_bp.route("/api/chats/<int:chat_id>/agents", methods=["GET"])
def list_agents(chat_id):
    agents = Agent.query.filter_by(chat_id=chat_id).order_by(Agent.created_at.asc()).all()
    return jsonify([{
        "id": a.id, "name": a.name, "model": a.model,
        "system_prompt": a.system_prompt, "auto_reply": a.auto_reply
    } for a in agents])


@agent_bp.route("/api/chats/<int:chat_id>/agents", methods=["POST"])
def add_agent(chat_id):
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify(error="Need agent name", code=400), 400
    agent = Agent(
        chat_id=chat_id, name=name,
        model=data.get("model", "deepseek/deepseek-v4-pro"),
        system_prompt=data.get("system_prompt", ""),
        auto_reply=data.get("auto_reply", True)
    )
    db.session.add(agent)
    db.session.commit()
    emit("agent_added", {"chat_id": chat_id, "agent": {"id": agent.id, "name": agent.name, "model": agent.model}}, namespace="/")
    return jsonify(agent_id=agent.id, name=agent.name), 201


@agent_bp.route("/api/chats/<int:chat_id>/agents/<int:agent_id>", methods=["PATCH"])
def update_agent(chat_id, agent_id):
    agent = Agent.query.filter_by(id=agent_id, chat_id=chat_id).first()
    if not agent:
        return jsonify(error="Agent not found"), 404
    data = request.get_json() or {}
    for k in ["name", "model", "system_prompt", "auto_reply"]:
        if k in data:
            setattr(agent, k, data[k])
    db.session.commit()
    return jsonify(ok=True)


@agent_bp.route("/api/chats/<int:chat_id>/agents/<int:agent_id>", methods=["DELETE"])
def remove_agent(chat_id, agent_id):
    agent = Agent.query.filter_by(id=agent_id, chat_id=chat_id).first()
    if not agent:
        return jsonify(error="Agent not found"), 404
    db.session.delete(agent)
    db.session.commit()
    emit("agent_removed", {"chat_id": chat_id, "agent_id": agent_id}, namespace="/")
    return jsonify(ok=True)


# ── Agent Group Discussion ──

def trigger_group_agents(socketio, chat_id, trigger_sender, trigger_content, topic_id=None):
    """
    Trigger all agents in a chat to discuss.
    Each agent sees the full context and can @mention others.
    Max 5 rounds of agent-to-agent conversation.
    """
    agents = Agent.query.filter_by(chat_id=chat_id, auto_reply=True).order_by(Agent.created_at.asc()).all()
    if not agents:
        return

    chat_name = (Chat.query.get(chat_id).name if Chat.query.get(chat_id) else "Group")
    from hermes_adapter import _run_hermes_cli, _cli_session_cache

    agent_names = [a.name for a in agents]
    NL = chr(10)

    def get_context():
        q = Message.query.filter_by(chat_id=chat_id)
        if topic_id:
            q = q.filter_by(topic_id=topic_id)
        msgs = q.order_by(Message.timestamp.desc()).limit(40).all()
        return [{
            "role": "assistant" if m.sender.startswith("agent_") or m.sender == "hermes_agent" else "user",
            "content": "[{}] {}".format(m.sender, m.content)
        } for m in reversed(msgs)]

    for round_num in range(5):
        replied = False
        context = get_context()

        for agent in agents:
            sender = "agent_{}".format(agent.name)
            sys_prompt = agent.system_prompt or "You are {}, in a group discussion.".format(agent.name)
            mention_str = ", ".join(["@{}".format(n) for n in agent_names if n != agent.name])

            visible = [m for m in context if not m["content"].startswith("[{}]".format(sender))]
            ctx_lines = ['{}: {}'.format(m["role"], m["content"]) for m in visible[-15:]]
            ctx_text = NL.join(ctx_lines)

            full = "[System]\n{}\n\n[Group: {}]\nParticipants: {}\nYou are {}. Mention others with: {}\n\n[Discussion]\n{}\n\nReply as {}. Keep it concise (30-150 chars). @mention to address specific people. If you have nothing to add, reply \"[PASS]\". Do NOT add labels like \"As {}\".".format(
                sys_prompt, chat_name, ", ".join(agent_names), agent.name,
                mention_str, ctx_text, agent.name, agent.name
            )

            try:
                skey = "agent_{}_{}".format(chat_id, agent.id)
                sid = _cli_session_cache.get(skey)
                resp, nsid = _run_hermes_cli(full, session_id=sid, model=agent.model)
                if nsid:
                    _cli_session_cache[skey] = nsid

                resp = re.sub(r'\x1b\[[0-9;]*m', '', resp)
                resp = re.sub(r'^Warning:.*?\n', '', resp, flags=re.MULTILINE)
                resp = resp.strip()
                if not resp or resp.startswith("\u26a0"):
                    resp = "[PASS]"
                if len(resp) > 300:
                    resp = resp[:300] + "..."

                if resp.strip() == "[PASS]":
                    continue

                msg = Message(chat_id=chat_id, topic_id=topic_id,
                              sender=sender, content=resp, msg_type="text")
                db.session.add(msg)
                db.session.commit()

                socketio.emit("newMessage", {
                    "id": msg.id, "chat_id": msg.chat_id, "sender": msg.sender,
                    "content": resp, "msg_type": "text",
                    "timestamp": msg.timestamp.isoformat(),
                    "is_agent": True, "agent_name": agent.name,
                }, room="chat_{}".format(chat_id))

                context.append({"role": "assistant", "content": "[{}] {}".format(sender, resp)})
                replied = True

            except Exception as e:
                print("[AgentGroup] R{} {} error: {}".format(round_num, agent.name, e))

        if not replied:
            break
