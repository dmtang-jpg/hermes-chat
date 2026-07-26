// ===== Hermes Chat Client — Mobile-First =====
// 借鉴 Telegram (底部面板/长按菜单/滑动/FAB) + 飞书 (富文本卡片/内联操作)

// == State ==
const state = {
  username: localStorage.getItem('chat_username') || '',
  sidToUser: {},
  ws: null,
  currentChatId: null,
  currentTopicId: null,
  currentTopicName: null,
  chatList: [],
  chatMessages: {},
  connected: false,
  uploadFile: null,
  serverHost: window.location.hostname || 'localhost',
  botChats: new Set(),
  botSending: false,
  chatModels: (() => { try { return JSON.parse(localStorage.getItem('chat_models') || '{}'); } catch { return {}; } })(),
  _defaultModel: 'deepseek/deepseek-v4-pro',
  // Mobile context menu state
  contextTarget: null,
  contextMsgId: null,
  contextMsgText: null,
  // Swipe state
  swipeStartX: 0,
  swipeStartY: 0,
};

function getCurrentModel() {
  return state.chatModels[state.currentChatId] || state._defaultModel;
}
function setCurrentModel(model) {
  state.chatModels[state.currentChatId] = model;
  localStorage.setItem('chat_models', JSON.stringify(state.chatModels));
}
const MODEL_MAP = { 'deepseek': 'deepseek/deepseek-v4-pro', 'claude': 'claude/sonnet', 'ollama': 'ollama/qwen3.6:35b-lowtemp' };
const MODEL_NAMES = Object.keys(MODEL_MAP).join('|');
function isMobile() { return window.innerWidth <= 768; }

// DOM cache
const DOM = {};
const DOM_IDS = [
  'loginScreen','mainApp','usernameInput','loginBtn','userAvatar','userName',
  'chatList','btnNewChat','messagesArea','activeChat','emptyState',
  'chatTitle','chatSubtitle','btnTopics','btnSettings',
  'messageInput','sendBtn','fileInput','filePreview','btnUpload',
  'rightPanel','panelTitle','panelContent','btnClosePanel',
  'topicIndicator','topicName','btnBackToMain','backBtn',
  'newChatModal','newChatName','newChatType','btnCreateChat',
  'btnLogout','modelSelect','btnBookmarks','btnSettingsGlobal','sidebarSearch',
  // Bottom sheet
  'bottomSheetOverlay','bottomSheet','bottomSheetTitle','bottomSheetBody','bottomSheetClose',
  // Context menu
  'contextMenu',
  // FAB + Toast
  'scrollFab','toast',
];
function cacheDOM() {
  for (const id of DOM_IDS) DOM[id] = document.getElementById(id);
}
cacheDOM();

// ========== Toast ==========
let _toastTimer;
function showToast(msg, duration=2000) {
  const t = DOM.toast;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ========== Login ==========
function doLogin() {
  const username = DOM.usernameInput.value.trim();
  if (!username) return;
  state.username = username;
  localStorage.setItem('chat_username', username);
  DOM.userName.textContent = username;
  DOM.userAvatar.textContent = username[0].toUpperCase();
  DOM.loginScreen.style.display = 'none';
  DOM.mainApp.style.display = 'flex';
  connectWS();
  loadChatList();
}

DOM.loginBtn.addEventListener('click', doLogin);
DOM.usernameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ========== WebSocket ==========
function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  state.ws = io(protocol + '//' + host, { transports: ['websocket', 'polling'] });
  
  state.ws.on('connect', () => {
    state.connected = true;
    if (state.currentChatId) {
      state.ws.emit('join_chat', { chat_id: state.currentChatId });
    }
  });
  
  state.ws.on('disconnect', () => { state.connected = false; });
  state.ws.on('newMessage', (msg) => {
    if (msg.sender === state.username) return;
    onNewMessage(msg);
  });
  state.ws.on('topicMessage', onNewMessage);
  state.ws.on('user_joined', onUserJoined);
  state.ws.on('user_left', onUserLeft);
  state.ws.on('topic_created', onTopicCreated);
  state.ws.on('messages_marked_read', () => loadChatList());
}

function onNewMessage(msg) {
  const chatId = msg.chat_id;
  if (!state.chatMessages[chatId]) state.chatMessages[chatId] = [];
  state.chatMessages[chatId].push(msg);
  if (msg.topic_id) loadTopicsForChat(chatId);
  if (state.currentChatId == chatId) {
    appendMessage(msg);
    scrollToBottom();
  }
  updateChatPreview(chatId, msg);
  renderChatList();
}

function onUserJoined(data) {
  if (state.currentChatId == data.chat_id) renderSystemMessage(`${data.username} 加入了聊天`);
}
function onUserLeft(data) {
  if (state.currentChatId == data.room.replace('chat_', '')) renderSystemMessage(`${data.username} 离开了话题`);
}
function onTopicCreated(data) {
  if (state.currentChatId == data.chat_id) loadTopicsForChat(data.chat_id);
}

// ========== Bottom Sheet (mobile replacement for right panel) ==========
function openBottomSheet(title, contentHtml) {
  DOM.bottomSheetTitle.textContent = title;
  DOM.bottomSheetBody.innerHTML = contentHtml;
  DOM.bottomSheetOverlay.classList.add('active');
  DOM.bottomSheet.classList.add('active');
}
function closeBottomSheet() {
  DOM.bottomSheetOverlay.classList.remove('active');
  DOM.bottomSheet.classList.remove('active');
}
DOM.bottomSheetOverlay.addEventListener('click', closeBottomSheet);
DOM.bottomSheetClose.addEventListener('click', closeBottomSheet);
// Swipe down to dismiss
let _sheetStartY = 0;
DOM.bottomSheet.addEventListener('touchstart', e => {
  _sheetStartY = e.touches[0].clientY;
}, {passive: true});
DOM.bottomSheet.addEventListener('touchmove', e => {
  const dy = e.touches[0].clientY - _sheetStartY;
  if (dy > 60 && DOM.bottomSheet.scrollTop <= 0) {
    closeBottomSheet();
  }
}, {passive: true});

// ========== Context Menu (long-press on message cards) ==========
let _longPressTimer;
function showContextMenu(x, y, msgId, text, isBot) {
  state.contextMsgId = msgId;
  state.contextMsgText = text;
  const menu = DOM.contextMenu;
  // Show quote/copy/bookmark for bot messages; copy only for own
  menu.querySelector('[data-action="quote"]').style.display = isBot ? 'flex' : 'none';
  menu.querySelector('[data-action="bookmark"]').style.display = isBot ? 'flex' : 'none';
  menu.querySelector('[data-action="delete-msg"]').style.display = isBot ? 'none' : 'flex';
  
  // Position menu (keep within viewport)
  menu.classList.add('show');
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - mw - 10) + 'px';
  menu.style.top = Math.min(y, vh - mh - 10) + 'px';
}
function hideContextMenu() {
  DOM.contextMenu.classList.remove('show');
}

// Context menu actions
DOM.contextMenu.addEventListener('click', e => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;
  const action = item.dataset.action;
  hideContextMenu();
  
  switch (action) {
    case 'quote':
      if (state.contextMsgText) {
        const quoted = state.contextMsgText.split('\n').map(l => `> ${l}`).join('\n');
        DOM.messageInput.value = quoted + '\n\n';
        DOM.messageInput.focus();
        DOM.messageInput.style.height = 'auto';
        DOM.messageInput.style.height = Math.min(DOM.messageInput.scrollHeight, 120) + 'px';
      }
      break;
    case 'copy':
      if (state.contextMsgText) {
        navigator.clipboard.writeText(state.contextMsgText).then(() => showToast('已复制'));
      }
      break;
    case 'bookmark':
      if (state.contextMsgId) bookmarkMessage(state.contextMsgId);
      break;
    case 'delete-msg':
      // Own message — remove the message-bubble (not a .message-card)
      const card = document.getElementById(state.contextMsgId);
      if (card) {
        card.remove();
      }
      showToast('已删除');
      break;
  }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.context-menu')) hideContextMenu();
});

// ========== Long-press detection ==========
function initLongPress(el, msgId, text, isBot) {
  let startX, startY, moved;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
    clearTimeout(_longPressTimer);
    _longPressTimer = setTimeout(() => {
      if (!moved) {
        showContextMenu(startX, startY, msgId, text, isBot);
        navigator.vibrate?.(15); // Haptic feedback
      }
    }, 500);
  }, {passive: true});
  el.addEventListener('touchmove', () => { moved = true; });
  el.addEventListener('touchend', () => clearTimeout(_longPressTimer));
  el.addEventListener('touchcancel', () => clearTimeout(_longPressTimer));
}

// ========== Scroll-to-bottom FAB ==========
let _scrollFabInited = false;
function initScrollFab() {
  if (_scrollFabInited || window.innerWidth > 768) return;
  _scrollFabInited = true;
  const area = DOM.messagesArea;
  const fab = DOM.scrollFab;
  let scrollDebounce;
  area.addEventListener('scroll', () => {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
      fab.classList.toggle('visible', distFromBottom > 200);
    }, 100);
  }, {passive: true});
}
DOM.scrollFab.addEventListener('click', () => {
  scrollToBottom();
  DOM.scrollFab.classList.remove('visible');
});
initScrollFab();

// ========== Send Message ==========
async function sendMessage() {
  const content = DOM.messageInput.value.trim();
  if ((!content && !state.uploadFile) || !state.currentChatId) return;
  
  if (state.botChats.has(state.currentChatId)) {
    if (state.botSending) return;
    state.botSending = true;
    DOM.sendBtn.disabled = true;
    
    const userMsg = {
      chat_id: state.currentChatId,
      sender: state.username,
      content: content,
      msg_type: 'text',
      timestamp: new Date().toISOString(),
    };
    appendMessage(userMsg);
    scrollToBottom();
    
    DOM.messageInput.value = '';
    DOM.messageInput.style.height = 'auto';
    
    const typingId = 'typing-' + Date.now();
    appendTypingIndicator(typingId);
    scrollToBottom();
    
    try {
      const resp = await fetch('/api/bot/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: state.currentChatId, message: content, model: getCurrentModel(), topic_id: state.currentTopicId })
      });
      
      removeTypingIndicator(typingId);
      
      if (resp.ok) {
        const data = await resp.json();
        const botMsg = {
          chat_id: state.currentChatId,
          sender: 'hermes_agent',
          content: data.reply,
          msg_type: 'text',
          timestamp: new Date().toISOString(),
          is_bot: true,
        };
        appendMessage(botMsg);
        scrollToBottom();
        
        if (!state.chatMessages[state.currentChatId]) state.chatMessages[state.currentChatId] = [];
        state.chatMessages[state.currentChatId].push(userMsg, botMsg);
        updateChatPreview(state.currentChatId, botMsg);
      } else {
        renderSystemMessage('❌ Bot 响应失败，请重试');
      }
    } catch (e) {
      removeTypingIndicator(typingId);
      renderSystemMessage('❌ 网络错误: ' + e.message);
    } finally {
      state.botSending = false;
      DOM.sendBtn.disabled = false;
    }
    return;
  }
  
  // Normal chat (WebSocket)
  if (!state.ws || !state.connected) return;
  state.ws.emit('sendMessage', {
    chat_id: state.currentChatId,
    sender: state.username,
    content: content,
    msg_type: 'text',
    topic_id: state.currentTopicId,
  });
  DOM.messageInput.value = '';
  DOM.messageInput.style.height = 'auto';
  clearFileInput();
}

DOM.sendBtn.addEventListener('click', sendMessage);
DOM.messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // Check slash commands FIRST before sending
    const text = DOM.messageInput.value.trim();
    
    if (text === '/clear') {
      e.preventDefault();
      DOM.messageInput.value = '';
      if (state.currentChatId && state.botChats.has(state.currentChatId)) {
        fetch(`/api/bot/${state.currentChatId}/clear`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({topic_id: state.currentTopicId})
        }).then(() => appendSystemMessage('上下文已清空'));
      }
      return;
    }
    
    const modelMatch = text.match(new RegExp(`^/model\\s+(${MODEL_NAMES})$`, 'i'));
    if (modelMatch) {
      e.preventDefault();
      DOM.messageInput.value = '';
      const key = modelMatch[1].toLowerCase();
      if (MODEL_MAP[key]) {
        setCurrentModel(MODEL_MAP[key]);
        DOM.modelSelect.value = getCurrentModel();
        appendSystemMessage(`已切换模型: ${key}`);
      }
      return;
    }
    
    if (text === '/export') {
      e.preventDefault();
      DOM.messageInput.value = '';
      if (state.currentChatId) {
        fetch(`/api/chats/${state.currentChatId}/export`)
          .then(r => r.json()).then(d => {
            const blob = new Blob([d.markdown], {type:'text/markdown'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = d.title; a.click();
            appendSystemMessage('已下载');
          });
      }
      return;
    }
    
    e.preventDefault();
    sendMessage();
  }
});
DOM.modelSelect.addEventListener('change', () => setCurrentModel(DOM.modelSelect.value));
function syncModelDropdown() { DOM.modelSelect.value = getCurrentModel(); }

// Auto-resize textarea
DOM.messageInput.addEventListener('input', () => {
  DOM.messageInput.style.height = 'auto';
  DOM.messageInput.style.height = Math.min(DOM.messageInput.scrollHeight, 120) + 'px';
});

// File upload button
DOM.btnUpload.addEventListener('click', () => DOM.fileInput.click());

// ========== Chat List ==========
async function loadChatList() {
  try {
    const resp = await fetch(`/api/chats?username=${encodeURIComponent(state.username)}`);
    if (resp.ok) {
      state.chatList = await resp.json();
      state.botChats.clear();
      for (const chat of state.chatList) {
        if (chat.chat_type === 'bot') state.botChats.add(chat.chat_id);
      }
      renderChatList();
    }
  } catch (e) { console.error('Failed to load chat list:', e); }
}

// Search filter
DOM.sidebarSearch.addEventListener('input', () => {
  const q = DOM.sidebarSearch.value.toLowerCase();
  const items = DOM.chatList.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = (item.querySelector('.chat-item-name')?.textContent || '').toLowerCase();
    item.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
  });
});

function renderChatList() {
  DOM.chatList.innerHTML = '';
  for (const chat of state.chatList) {
    const div = document.createElement('div');
    const isActive = state.currentChatId == chat.chat_id;
    div.className = 'chat-item' + (isActive ? ' active' : '') + (chat.pinned ? ' pinned' : '');
    div.dataset.chatId = chat.chat_id;
    const isBotChat = chat.chat_type === 'bot' || state.botChats.has(chat.chat_id);
    const pinIcon = chat.pinned ? '<i class="fa-solid fa-thumbtack pin-icon active"></i>' : '';
    
    div.innerHTML = `
      <div class="chat-item-avatar" style="background:${isBotChat ? '#6366f1' : `hsl(${chat.chat_id * 37 % 360}, 40%, 30%)`}">
        ${isBotChat ? '🤖' : escapeHtml(chat.name[0] || '?')}
      </div>
      <div class="chat-item-content">
        <div class="chat-item-name">${pinIcon}${escapeHtml(chat.name)}</div>
        <div class="chat-item-preview">${escapeHtml(chat.last_message || '没有消息')}</div>
      </div>
      <div class="chat-item-meta">
        <div class="chat-item-time">${formatTime(chat.last_timestamp)}</div>
        ${chat.unread_count > 0 ? `<div class="chat-item-unread">${chat.unread_count}</div>` : ''}
      </div>
      <div class="chat-item-actions">
        <button class="btn-chat-action pin-btn" title="${chat.pinned ? '取消置顶' : '置顶'}" data-action="pin">
          <i class="fa-solid fa-thumbtack"></i>
        </button>
        <button class="btn-chat-action del-btn" title="删除对话" data-action="delete">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;
    
    // Main click → switch
    div.addEventListener('click', e => {
      if (!e.target.closest('.btn-chat-action')) switchChat(chat.chat_id);
    });
    
    // Pin
    div.querySelector('.pin-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      togglePin(chat.chat_id);
    });
    // Delete
    div.querySelector('.del-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      deleteChat(chat.chat_id);
    });
    
    // Swipe-left to reveal actions (mobile)
    initChatItemSwipe(div);
    
    DOM.chatList.appendChild(div);
  }
}

// Swipe gesture on chat items
function initChatItemSwipe(el) {
  let startX = 0, startY = 0, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiped = false;
    el.style.transition = 'none';
  }, {passive: true});
  el.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && dx < -30 && !swiped) {
      swiped = true;
      // Reveal actions
      const actions = el.querySelector('.chat-item-actions');
      if (actions) actions.style.display = 'flex';
    }
  }, {passive: true});
  el.addEventListener('touchend', () => {
    el.style.transition = '';
    // Auto-hide after 3s
    setTimeout(() => {
      const actions = el.querySelector('.chat-item-actions');
      if (actions && !el.matches(':hover')) actions.style.display = 'none';
    }, 3000);
  });
}

function updateChatPreview(chatId, msg) {
  const idx = state.chatList.findIndex(c => c.chat_id == chatId);
  if (idx >= 0) {
    state.chatList[idx].last_message = (msg.content || '').substring(0, 30);
    state.chatList[idx].last_timestamp = msg.timestamp;
  }
  renderChatList();
}

// ========== Delete / Pin ==========
async function deleteChat(chatId) {
  if (!confirm('确定删除该对话？所有消息将被清除且无法恢复。')) return;
  try {
    const resp = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
    if (resp.ok) {
      state.chatList = state.chatList.filter(c => c.chat_id != chatId);
      state.botChats.delete(chatId);
      delete state.chatMessages[chatId];
      if (state.currentChatId == chatId) {
        state.currentChatId = null;
        DOM.activeChat.style.display = 'none';
        DOM.emptyState.style.display = 'flex';
      }
      renderChatList();
    }
  } catch (e) { console.error('Delete chat failed:', e); }
}

async function togglePin(chatId) {
  const chat = state.chatList.find(c => c.chat_id == chatId);
  if (!chat) return;
  const action = chat.pinned ? 'unpin' : 'pin';
  try {
    const resp = await fetch(`/api/chats/${chatId}/${action}`, { method: 'POST' });
    if (resp.ok) {
      chat.pinned = !chat.pinned;
      state.chatList.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.last_timestamp || '').localeCompare(a.last_timestamp || '');
      });
      renderChatList();
      showToast(chat.pinned ? '已置顶' : '已取消置顶');
    }
  } catch (e) { console.error('Pin toggle failed:', e); }
}

// ========== Switch Chat ==========
async function switchChat(chatId) {
  try {
    state.currentChatId = chatId;
    state.currentTopicId = null;
    
    if (state.ws && state.connected) {
      state.ws.emit('join_chat', { chat_id: chatId });
    }
    
    syncModelDropdown();
    await loadChatMessages(chatId);
    
    const chat = state.chatList.find(c => c.chat_id == chatId);
    DOM.chatTitle.textContent = chat ? chat.name : '聊天';
    DOM.chatSubtitle.textContent = chat ? (chat.chat_type === 'bot' ? '🤖 AI Bot' : '直接聊天') : '';
    
    DOM.emptyState.style.display = 'none';
    DOM.activeChat.style.display = 'flex';
    DOM.activeChat.style.flexDirection = 'column';
    
    // Hide panels
    DOM.rightPanel.style.display = 'none';
    closeBottomSheet();
    
    // Mobile: hide sidebar
    if (isMobile()) {
      DOM.sidebar.classList.add('hidden');
    }
    
    markRead(chatId);
    renderChatList();
    DOM.messageInput.focus();
  } catch (err) { console.error('switchChat error:', err); }
}

// ========== Messages ==========
async function loadChatMessages(chatId, topicId = null, limit = 50) {
  try {
    let url = `/api/chats/${chatId}/messages?limit=${limit}`;
    if (topicId) url += `&topic_id=${topicId}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const msgs = await resp.json();
      state.chatMessages[chatId] = msgs;
      if (state.currentChatId == chatId) {
        renderMessages(msgs);
        scrollToBottom();
      }
    }
  } catch (e) { console.error('Failed to load messages:', e); }
}

function renderMessages(msgs) {
  DOM.messagesArea.innerHTML = '';
  let lastDate = null;
  
  for (const msg of msgs) {
    // Date separator
    const msgDate = new Date(msg.timestamp).toDateString();
    if (msgDate !== lastDate) {
      const dateDiv = document.createElement('div');
      dateDiv.className = 'date-separator';
      dateDiv.innerHTML = `<span>${formatDate(msg.timestamp)}</span>`;
      DOM.messagesArea.appendChild(dateDiv);
      lastDate = msgDate;
    }
    appendMessageToDOM(msg, true);
  }
}

function appendMessage(msg) {
  appendMessageToDOM(msg, true);
}

// Simple markdown → HTML
function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => 
    `<pre class="md-code"><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Numbered lists
  html = html.replace(/^(\d+\.\s[^\n]+(?:\n\d+\.\s[^\n]+)*)/gm, (match) => {
    const items = match.split('\n').filter(l => /^\d+\.\s/.test(l))
      .map(l => `<li>${l.replace(/^\d+\.\s/, '')}</li>`).join('');
    return `<ol class="md-list">${items}</ol>`;
  });
  // Bullet lists
  html = html.replace(/^([-*]\s[^\n]+(?:\n[-*]\s[^\n]+)*)/gm, (match) => {
    const items = match.split('\n').filter(l => /^[-*]\s/.test(l))
      .map(l => `<li>${l.replace(/^[-*]\s/, '')}</li>`).join('');
    return `<ul class="md-list">${items}</ul>`;
  });
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  // Auto-link URLs (after markdown processing, before wrapping in <p>)
  html = linkifyUrls(html);
  return `<p>${html}</p>`;
}

// Auto-convert plain-text URLs to clickable <a> links
// Skips URLs already inside <a href>, <img src, <pre>, <code> tags
function linkifyUrls(html) {
  // Split by safe blocks (<a>, <pre>, <code>, <img) to avoid double-linking
  const safeBlocks = [];
  const placeholder = '\x00LINKIFYBLOCK\x00';
  let idx = 0;
  html = html.replace(/<(a|pre|code|img)\b[\s\S]*?<\/\1>/gi, (match) => {
    safeBlocks.push(match);
    return placeholder + (idx++) + placeholder;
  });
  // Also protect self-closing img
  html = html.replace(/(<img\b[^>]*\/?>)/gi, (match) => {
    safeBlocks.push(match);
    return placeholder + (idx++) + placeholder;
  });
  
  // Convert URLs in remaining text
  html = html.replace(
    /(https?:\/\/[^\s<>"')\]}，。；：！？、]+(?:\/[^\s<>"')\]}，。；：！？、]*)?)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="auto-link">$1</a>'
  );
  
  // Restore safe blocks
  html = html.replace(new RegExp(placeholder + '(\\d+)' + placeholder, 'g'), (_, n) => safeBlocks[+n] || '');
  return html;
}

function appendMessageToDOM(msg, isNewSender) {
  const isOwn = msg.sender === state.username;
  const isBot = msg.is_bot || msg.sender === 'Hermes' || msg.sender === 'hermes_agent';
  const div = document.createElement('div');
  
  const avatarHtml = isBot && isNewSender
    ? `<span class="msg-avatar" style="background:#6366f1;width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:14px;margin-right:6px;vertical-align:middle;flex-shrink:0;">🤖</span>`
    : '';
  
  const authorLabel = isNewSender && !isOwn && msg.sender && msg.sender !== 'system'
    ? `<div class="message-author" style="color:${isBot ? '#6366f1' : getAvatarColor(msg.sender)}">${avatarHtml}${escapeHtml(msg.sender)}${isBot ? ' <span style="font-size:10px;background:#6366f1;color:white;padding:1px 6px;border-radius:8px;margin-left:4px;">AI</span>' : ''}</div>`
    : '';
  
  const timeStr = formatTime(msg.timestamp);
  
  if (msg.msg_type === 'text') {
    if (isBot) {
      const modelLabel = (getCurrentModel() || 'AI').split('/').pop();
      const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      div.className = 'message-card';
      div.innerHTML = `
        <div class="card-header">
          <span class="card-model">🤖 ${modelLabel}</span>
          <div class="card-header-actions">
            <button class="card-action-btn" onclick="quoteMessage('${msgId}')" title="引用回复">
              <i class="fa-solid fa-reply"></i>
            </button>
            <button class="card-action-btn" onclick="copyCardContent('${msgId}')" title="复制">
              <i class="fa-regular fa-copy"></i>
            </button>
            <button class="card-action-btn" onclick="bookmarkMessage('${msgId}')" title="收藏">
              <i class="fa-regular fa-bookmark"></i>
            </button>
          </div>
        </div>
        <div class="card-body" id="${msgId}">${renderMarkdown(msg.content)}</div>
        <div class="card-footer">
          <span class="message-time">${timeStr}</span>
        </div>
      `;
      // Long-press context menu (mobile)
      if (isMobile()) {
        const body = div.querySelector('.card-body');
        const rawText = (body?.innerText || body?.textContent || msg.content || '').trim();
        initLongPress(div, msgId, rawText, true);
      }
    } else {
      div.className = 'message-bubble ' + (isOwn ? 'own' : 'other');
      div.innerHTML = `
        ${authorLabel}
        <div class="message-content">${linkifyUrls(escapeHtml(msg.content))}</div>
        <div class="message-time">${timeStr}</div>
      `;
      // Long-press for own messages too (copy/delete)
      if (isMobile() && isOwn) {
        const msgId = 'own-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        div.id = msgId;
        initLongPress(div, msgId, msg.content, false);
      }
    }
  } else if (msg.msg_type === 'file') {
    const isImage = msg.file_name && /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(msg.file_name);
    const icon = isImage ? 'fa-image' : 'fa-file';
    const fileUrl = msg.file_url || '';
    div.className = 'message-card file-card';
    div.innerHTML = `
      <div class="file-card-body">
        ${isImage && fileUrl ? `<img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(msg.file_name)}" class="file-preview-img" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div class="file-info">
          <i class="fa-solid ${icon} file-icon"></i>
          <span class="file-name">${escapeHtml(msg.file_name || msg.content || '文件')}</span>
          ${fileUrl ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener" class="file-download"><i class="fa-solid fa-download"></i></a>` : ''}
        </div>
      </div>
      <div class="card-footer">
        <span class="message-time">${timeStr}</span>
      </div>
    `;
  } else {
    div.className = 'message-bubble system';
    div.innerHTML = escapeHtml(msg.content);
  }
  
  DOM.messagesArea.appendChild(div);
}

// Typing indicator
function appendTypingIndicator(id) {
  const div = document.createElement('div');
  div.className = 'message-row bot-typing';
  div.id = id;
  div.innerHTML = `
    <div class="msg-avatar" style="background:#6366f1">🤖</div>
    <div class="msg-body">
      <div class="msg-sender">Hermes</div>
      <div class="msg-content typing-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  DOM.messagesArea.appendChild(div);
}
function removeTypingIndicator(id) {
  document.getElementById(id)?.remove();
}
function renderSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message-bubble system';
  div.textContent = text;
  DOM.messagesArea.appendChild(div);
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    DOM.messagesArea.scrollTop = DOM.messagesArea.scrollHeight;
  });
}

// ========== Topics ==========
async function loadTopicsForChat(chatId) {
  try {
    const resp = await fetch(`/api/chats/${chatId}/topics`);
    if (resp.ok) {
      const topics = await resp.json();
      // Render in right panel (desktop) or bottom sheet (mobile)
      if (isMobile()) {
        renderTopicsInSheet(topics, chatId);
      } else {
        renderTopicsPanel(topics, chatId);
      }
    }
  } catch (e) { console.error('Failed to load topics:', e); }
}

function renderTopicsInSheet(topics, chatId) {
  let html = `<div class="panel-list-item" onclick="switchToMainTopic(${chatId})" style="${state.currentTopicId === null ? 'background:var(--accent-light);color:var(--accent);font-weight:500;' : ''}">
    <i class="fa-solid fa-comment-dots"></i> 主话题
    <span style="margin-left:auto;color:var(--text-muted)">${topics.length} 个话题</span>
  </div>`;
  for (const topic of topics) {
    html += `<div class="panel-list-item${state.currentTopicId == topic.topic_id ? ' active' : ''}" onclick="switchToTopic(${chatId}, ${topic.topic_id}, '${escapeHtml(topic.name)}')">
      <i class="fa-solid fa-hashtag"></i> ${escapeHtml(topic.name)}
      <span style="margin-left:auto;color:var(--text-muted)">${formatTime(topic.created_at)}</span>
    </div>`;
  }
  html += `<button class="add-topic-btn" onclick="createNewTopic(${chatId})">+ 新建话题</button>`;
  openBottomSheet('话题列表', html);
}

// Global functions for onclick in bottom sheet
window.switchToMainTopic = function(chatId) {
  state.currentTopicId = null;
  state.currentTopicName = null;
  updateTopicIndicator();
  loadChatMessages(chatId, null);
  closeBottomSheet();
};
window.switchToTopic = function(chatId, topicId, name) {
  state.currentTopicId = topicId;
  state.currentTopicName = name;
  updateTopicIndicator();
  loadChatMessages(chatId, topicId);
  closeBottomSheet();
};
window.createNewTopic = async function(chatId) {
  const name = prompt('话题名称:');
  if (!name) return;
  try {
    const resp = await fetch(`/api/chats/${chatId}/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, creator: state.username })
    });
    if (resp.ok) {
      const data = await resp.json();
      state.currentTopicId = data.topic_id;
      state.currentTopicName = name;
      updateTopicIndicator();
      loadChatMessages(chatId, state.currentTopicId);
      closeBottomSheet();
    }
  } catch (e) { console.error('Failed to create topic:', e); }
};

function renderTopicsPanel(topics, chatId) {
  DOM.panelTitle.textContent = '话题列表';
  DOM.panelContent.innerHTML = '';
  
  const allDiv = document.createElement('div');
  allDiv.className = 'panel-list-item' + (state.currentTopicId === null ? ' active' : '');
  allDiv.innerHTML = `<i class="fa-solid fa-comment-dots"></i> 主话题 <span style="margin-left:auto;color:var(--text-muted)">${topics.length} 个话题</span>`;
  allDiv.addEventListener('click', () => {
    state.currentTopicId = null; state.currentTopicName = null;
    updateTopicIndicator();
    loadChatMessages(chatId, null);
  });
  DOM.panelContent.appendChild(allDiv);
  
  for (const topic of topics) {
    const div = document.createElement('div');
    div.className = 'panel-list-item' + (state.currentTopicId == topic.topic_id ? ' active' : '');
    div.innerHTML = `<i class="fa-solid fa-hashtag"></i> ${escapeHtml(topic.name)} <span style="margin-left:auto;color:var(--text-muted)">${formatTime(topic.created_at)}</span>`;
    div.addEventListener('click', () => {
      state.currentTopicId = topic.topic_id; state.currentTopicName = topic.name;
      updateTopicIndicator();
      loadChatMessages(chatId, state.currentTopicId);
    });
    DOM.panelContent.appendChild(div);
  }
  
  const addBtn = document.createElement('button');
  addBtn.className = 'add-topic-btn';
  addBtn.textContent = '+ 新建话题';
  addBtn.addEventListener('click', () => window.createNewTopic(chatId));
  DOM.panelContent.appendChild(addBtn);
}

function updateTopicIndicator() {
  if (state.currentTopicId) {
    DOM.topicIndicator.style.display = 'flex';
    DOM.topicName.textContent = '# ' + (state.currentTopicName || ('话题 #' + state.currentTopicId));
  } else {
    DOM.topicIndicator.style.display = 'none';
  }
}

DOM.btnBackToMain.addEventListener('click', () => {
  state.currentTopicId = null;
  state.currentTopicName = null;
  updateTopicIndicator();
  loadChatMessages(state.currentChatId, null);
});

// ========== Topics button ==========
DOM.btnTopics.addEventListener('click', () => {
  if (!state.currentChatId) return;
  loadTopicsForChat(state.currentChatId);
  if (isMobile()) return; // Already opened bottom sheet
  DOM.rightPanel.style.display = 'block';
});

// ========== Settings ==========
DOM.btnSettings.addEventListener('click', () => showSettings());
DOM.addEventListener('click', e => {
  if (e.target.closest('#btnSettingsGlobal')) showSettings();
});

function showSettings() {
  if (!state.currentChatId) return;
  const isBot = state.botChats.has(state.currentChatId);
  const title = isBot ? 'Bot 设置' : '聊天设置';
  
  if (isBot) {
    fetch(`/api/bot/${state.currentChatId}/system-prompt`)
      .then(r => r.json()).then(d => {
        const content = `
          <div class="settings-section">
            <h4>System Prompt</h4>
            <p class="settings-hint">设定Bot的人设和能力</p>
            <textarea id="sysPromptInput" class="settings-textarea" placeholder="例如：你是电磁材料专家，擅长分析吸波材料...">${escapeHtml(d.system_prompt || '')}</textarea>
            <button id="saveSysPrompt" class="btn-primary" style="margin-top:8px;width:100%;">保存</button>
          </div>
          <div class="settings-section" style="margin-top:16px;">
            <h4>会话管理</h4>
            <button id="clearSessionBtn" class="btn-danger" style="width:100%;">🔄 清空上下文</button>
            <button id="exportBtn" class="btn-secondary" style="width:100%;margin-top:8px;">📥 导出 Markdown</button>
          </div>
        `;
        
        if (isMobile()) {
          openBottomSheet(title, content);
          setTimeout(() => {
            document.getElementById('saveSysPrompt')?.addEventListener('click', () => {
              const prompt = document.getElementById('sysPromptInput').value;
              fetch(`/api/bot/${state.currentChatId}/system-prompt`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({system_prompt: prompt})
              }).then(() => { closeBottomSheet(); showToast('已保存'); });
            });
            document.getElementById('clearSessionBtn')?.addEventListener('click', () => {
              if (!confirm('确定要清空当前Bot的对话上下文吗？')) return;
              fetch(`/api/bot/${state.currentChatId}/clear`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({topic_id: state.currentTopicId})
              }).then(() => { closeBottomSheet(); appendSystemMessage('上下文已清空'); });
            });
            document.getElementById('exportBtn')?.addEventListener('click', () => {
              fetch(`/api/chats/${state.currentChatId}/export`)
                .then(r => r.json()).then(d => {
                  const blob = new Blob([d.markdown], {type:'text/markdown'});
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = d.title; a.click();
                });
            });
          }, 100);
        } else {
          DOM.rightPanel.style.display = 'block';
          DOM.panelTitle.textContent = title;
          DOM.panelContent.innerHTML = content;
          document.getElementById('saveSysPrompt').onclick = () => {
            const prompt = document.getElementById('sysPromptInput').value;
            fetch(`/api/bot/${state.currentChatId}/system-prompt`, {
              method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({system_prompt: prompt})
            }).then(() => DOM.rightPanel.style.display = 'none');
          };
          document.getElementById('clearSessionBtn').onclick = () => {
            if (!confirm('确定要清空当前Bot的对话上下文吗？')) return;
            fetch(`/api/bot/${state.currentChatId}/clear`, {
              method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({topic_id: state.currentTopicId})
            }).then(() => { DOM.rightPanel.style.display = 'none'; appendSystemMessage('上下文已清空'); });
          };
          document.getElementById('exportBtn').onclick = () => {
            fetch(`/api/chats/${state.currentChatId}/export`)
              .then(r => r.json()).then(d => {
                const blob = new Blob([d.markdown], {type:'text/markdown'});
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = d.title; a.click();
              });
          };
        }
      });
  } else {
    const content = `
      <div class="settings-section">
        <button id="exportBtn" class="btn-secondary" style="width:100%;">📥 导出 Markdown</button>
      </div>
    `;
    if (isMobile()) {
      openBottomSheet(title, content);
      setTimeout(() => {
        document.getElementById('exportBtn')?.addEventListener('click', () => {
          fetch(`/api/chats/${state.currentChatId}/export`)
            .then(r => r.json()).then(d => {
              const blob = new Blob([d.markdown], {type:'text/markdown'});
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = d.title; a.click();
            });
        });
      }, 100);
    } else {
      DOM.rightPanel.style.display = 'block';
      DOM.panelTitle.textContent = title;
      DOM.panelContent.innerHTML = content;
      document.getElementById('exportBtn').onclick = () => {
        fetch(`/api/chats/${state.currentChatId}/export`)
          .then(r => r.json()).then(d => {
            const blob = new Blob([d.markdown], {type:'text/markdown'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = d.title; a.click();
          });
      };
    }
  }
}

// ========== Bookmarks ==========
DOM.btnBookmarks.addEventListener('click', () => showBookmarks());

function showBookmarks() {
  let bookmarks = [];
  try { bookmarks = JSON.parse(localStorage.getItem('chat_bookmarks') || '[]'); } catch {}
  
  if (bookmarks.length === 0) {
    const msg = '<p style="color:var(--text-muted);text-align:center;margin-top:40px;">暂无收藏</p>' +
      '<p style="color:var(--text-secondary);font-size:13px;text-align:center;">长按或点击机器人回复右上角的 📑 按钮收藏</p>';
    if (isMobile()) {
      openBottomSheet('📑 收藏', msg);
    } else {
      DOM.rightPanel.style.display = 'block';
      DOM.panelTitle.textContent = '📑 收藏';
      DOM.panelContent.innerHTML = msg;
    }
    return;
  }
  
  const listHtml = bookmarks.map((b, i) => `
    <div class="bookmark-item" onclick="switchChat(${b.chat_id}); ${isMobile() ? 'closeBottomSheet();' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-size:12px;color:var(--accent);">${escapeHtml(b.chat_name || '未知聊天')}</span>
        <button class="btn-sm" onclick="event.stopPropagation();removeBookmark('${b.id}', this)" style="font-size:11px;">删除</button>
      </div>
      <div style="font-size:13px;color:var(--text-primary);white-space:pre-wrap;line-height:1.5;max-height:80px;overflow:hidden;">${escapeHtml(b.text)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${formatTime(b.timestamp)}</div>
    </div>
  `).join('');
  
  if (isMobile()) {
    openBottomSheet('📑 收藏', listHtml);
  } else {
    DOM.rightPanel.style.display = 'block';
    DOM.panelTitle.textContent = '📑 收藏';
    DOM.panelContent.innerHTML = listHtml;
  }
}

function removeBookmark(msgId, btnEl) {
  let bookmarks = JSON.parse(localStorage.getItem('chat_bookmarks') || '[]');
  bookmarks = bookmarks.filter(b => b.id !== msgId);
  _safeSetItem('chat_bookmarks', JSON.stringify(bookmarks));
  if (btnEl) btnEl.closest('.bookmark-item')?.remove();
  // Update card icon
  const btn = document.querySelector(`.card-header-actions button[onclick*="${msgId}"][onclick*="bookmark"]`);
  if (btn) btn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
  if (bookmarks.length === 0) showBookmarks();
  showToast('已取消收藏');
}

// ========== Message Card Actions ==========
function copyCardContent(msgId) {
  const body = document.getElementById(msgId);
  if (!body) return;
  const text = body.innerText || body.textContent;
  navigator.clipboard.writeText(text).then(() => showToast('已复制')).catch(() => showToast('复制失败'));
}

function quoteMessage(msgId) {
  const body = document.getElementById(msgId);
  if (!body) return;
  const text = body.innerText || body.textContent;
  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
  DOM.messageInput.value = quoted + '\n\n';
  DOM.messageInput.focus();
  DOM.messageInput.style.height = 'auto';
  DOM.messageInput.style.height = Math.min(DOM.messageInput.scrollHeight, 120) + 'px';
}

function bookmarkMessage(msgId) {
  const body = document.getElementById(msgId);
  if (!body) return;
  const text = body.innerText || body.textContent;
  let bookmarks = [];
  try { bookmarks = JSON.parse(localStorage.getItem('chat_bookmarks') || '[]'); } catch {}
  const existing = bookmarks.find(b => b.id === msgId);
  
  if (existing) {
    bookmarks = bookmarks.filter(b => b.id !== msgId);
    _safeSetItem('chat_bookmarks', JSON.stringify(bookmarks));
    showToast('已取消收藏');
    // Update icon
    const btn = document.querySelector(`.card-header-actions button[onclick*="${msgId}"][onclick*="bookmark"]`);
    if (btn) btn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
  } else {
    bookmarks.push({
      id: msgId,
      text: text.substring(0, 200),
      chat_id: state.currentChatId,
      chat_name: state.chatList.find(c => c.chat_id == state.currentChatId)?.name || '',
      timestamp: new Date().toISOString(),
    });
    _safeSetItem('chat_bookmarks', JSON.stringify(bookmarks));
    showToast('已收藏 📑');
    const btn = document.querySelector(`.card-header-actions button[onclick*="${msgId}"][onclick*="bookmark"]`);
    if (btn) btn.innerHTML = '<i class="fa-solid fa-bookmark" style="color:var(--orange)"></i>';
  }
}

// ========== Create Chat ==========
DOM.btnNewChat.addEventListener('click', () => {
  DOM.newChatName.value = '';
  DOM.newChatModal.style.display = 'flex';
});

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

DOM.btnCreateChat.addEventListener('click', async () => {
  const name = DOM.newChatName.value.trim();
  if (!name) return;
  
  try {
    const resp = await fetch('/api/bot/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: state.username, name: name})
    });
    if (resp.ok) {
      const data = await resp.json();
      const botChatId = data.chat_id;
      state.botChats.add(botChatId);
      
      state.chatList.unshift({
        chat_id: botChatId,
        name: '🤖 ' + (name || 'Hermes Bot'),
        chat_type: 'bot',
        last_message: '开始对话...',
        last_timestamp: new Date().toISOString(),
        unread_count: 0,
      });
      renderChatList();
      closeModal('newChatModal');
      await switchChat(botChatId);
    }
  } catch (e) { console.error('Failed to create bot chat:', e); }
});

// ========== Back / Logout ==========
DOM.backBtn.addEventListener('click', () => {
  DOM.sidebar.classList.remove('hidden');
  DOM.activeChat.style.display = 'none';
  DOM.emptyState.style.display = 'flex';
  closeBottomSheet();
});

DOM.btnLogout.addEventListener('click', () => {
  if (state.ws) state.ws.disconnect();
  localStorage.removeItem('chat_username');
  location.reload();
});

DOM.btnClosePanel.addEventListener('click', () => {
  DOM.rightPanel.style.display = 'none';
});

// ========== File Upload ==========
DOM.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await uploadAndSendFile(file);
});

function clearFileInput() {
  state.uploadFile = null;
  DOM.fileInput.value = '';
  DOM.filePreview.style.display = 'none';
}

// Clipboard paste & drag-drop
document.addEventListener('paste', async (e) => {
  if (!state.currentChatId) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      await uploadAndSendFile(item.getAsFile());
    }
  }
});

DOM.messagesArea.addEventListener('dragover', e => {
  e.preventDefault(); e.stopPropagation();
  DOM.messagesArea.classList.add('drag-over');
});
DOM.messagesArea.addEventListener('dragleave', e => {
  e.preventDefault(); e.stopPropagation();
  DOM.messagesArea.classList.remove('drag-over');
});
DOM.messagesArea.addEventListener('drop', async e => {
  e.preventDefault(); e.stopPropagation();
  DOM.messagesArea.classList.remove('drag-over');
  if (!state.currentChatId) return;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  for (const file of files) await uploadAndSendFile(file);
});

async function uploadAndSendFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('username', state.username);
  formData.append('chat_id', state.currentChatId);
  
  DOM.filePreview.textContent = '📤 上传中...';
  DOM.filePreview.style.display = 'inline';
  
  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: formData });
    if (resp.ok) {
      const data = await resp.json();
      const fileMsg = {
        chat_id: state.currentChatId,
        sender: state.username,
        content: file.name,
        msg_type: 'file',
        file_name: file.name,
        file_url: data.url,
        timestamp: new Date().toISOString(),
      };
      if (!state.chatMessages[state.currentChatId]) state.chatMessages[state.currentChatId] = [];
      state.chatMessages[state.currentChatId].push(fileMsg);
      appendMessage(fileMsg);
      scrollToBottom();
      updateChatPreview(state.currentChatId, fileMsg);
    }
  } catch (e) { console.error('Upload failed:', e); }
  DOM.filePreview.style.display = 'none';
}

// ========== Mark Read ==========
async function markRead(chatId) {
  try {
    await fetch('/api/messages/mark_read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, sender: state.username })
    });
  } catch (e) {}
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message-bubble system';
  div.textContent = text;
  DOM.messagesArea.appendChild(div);
}

// ========== Utilities ==========
function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  } else {
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  }
}

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return '今天';
  if (isYesterday) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function diffMinutes(iso1, iso2) {
  return Math.abs(new Date(iso1) - new Date(iso2)) / 60000;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Safe localStorage wrapper
function _safeSetItem(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) { showToast('存储空间不足，请清理旧数据'); return false; }
}

function getAvatarColor(name) {
  const colors = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4'];
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ========== Init ==========
if (state.username) {
  DOM.userName.textContent = state.username;
  DOM.userAvatar.textContent = state.username[0].toUpperCase();
  DOM.loginScreen.style.display = 'none';
  DOM.mainApp.style.display = 'flex';
  connectWS();
  loadChatList();
}

// Pull-to-refresh on chat list (mobile)
let pullStartY = 0, pulling = false;
DOM.chatList.addEventListener('touchstart', e => {
  if (DOM.chatList.scrollTop <= 0) {
    pullStartY = e.touches[0].clientY;
    pulling = true;
  }
}, {passive: true});
DOM.chatList.addEventListener('touchmove', e => {
  if (!pulling) return;
  const dy = e.touches[0].clientY - pullStartY;
  if (dy > 80) {
    pulling = false;
    loadChatList().then(() => showToast('已刷新'));
  }
}, {passive: true});
DOM.chatList.addEventListener('touchend', () => { pulling = false; });

// Handle window resize — re-evaluate layout
window.addEventListener('resize', () => {
  if (!isMobile()) {
    DOM.sidebar.classList.remove('hidden');
    closeBottomSheet();
  }
  initScrollFab();
});

// Keyboard shortcut: Escape closes panels
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeBottomSheet();
    DOM.rightPanel.style.display = 'none';
    hideContextMenu();
  }
});
