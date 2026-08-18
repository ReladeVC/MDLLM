// MD LLM Client v5.2.0 - Refactored: shared helpers, removed duplication
(function() {
    'use strict';

    const $ = (s, c = document) => c.querySelector(s);
    const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
    const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);

    // ========== TOAST ==========
    function showToast(msg, type, dur) {}

    const escapeHtml = s => s ? String(s).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m])) : '';

    // ========== SHARED HELPERS ==========
    // Цвет процента контекста
    const ctxPercentColor = p => p >= 80 ? '#ff6b6b' : p >= 60 ? '#ff9500' : '#6e6e73';
    // HTML метрик генерации
    const buildMetricsHtml = m => {
        if (!m) return '';
        const tps = m.tokens_per_second ? m.tokens_per_second.toFixed(2) : '0.00';
        const time = m.time_seconds ? m.time_seconds.toFixed(2) : '0.00';
        const toks = m.completion_tokens || 0;
        return `<div style="color:#6e6e73;font-size:11px;margin-top:6px;">⚡${tps} т/с • ⏱️${time}с • ${toks} ток.</div>`;
    };
    // Сборка тела SSE-запроса
    const buildStreamBody = (agent, history, imgs, think) => ({
        messages: history,
        system_prompt: agent.prompt,
        temperature: agent.temp !== undefined ? agent.temp : modelGenParams.temperature,
        max_tokens: modelGenParams.max_tokens,
        top_p: modelGenParams.top_p,
        repeat_penalty: modelGenParams.repeat_penalty,
        top_k: modelGenParams.top_k,
        frequency_penalty: modelGenParams.frequency_penalty,
        presence_penalty: modelGenParams.presence_penalty,
        think: think,
        images: imgs || []
    });
    // Обновление exactContext/ExactSpeed и DOM после стрима
    const finalizeStreamUsage = usage => {
        if (usage && usage.completion_tokens) {
            exactContext = usage.prompt_tokens + usage.completion_tokens;
            exactSpeed = usage.tokens_per_second;
            const seEl = $('#liveSpeed');
            if (seEl && usage.tokens_per_second) seEl.textContent = usage.tokens_per_second.toFixed(1);
            const ceEl = $('#liveContext');
            if (ceEl) {
                ceEl.textContent = exactContext;
                const cpEl = $('#liveContextPercent');
                if (cpEl) {
                    const p = Math.min(100, Math.floor((exactContext / modelGenParams.n_ctx) * 100));
                    cpEl.textContent = `(${p}%)`;
                    cpEl.style.color = ctxPercentColor(p);
                }
            }
        } else {
            exactContext = null;
            exactSpeed = null;
            estimateCurrentContext();
        }
    };
    // Поиск типа агента по ID
    const findAgentType = id => {
        if (assistants.some(a => a.id === id)) return 'assistant';
        if (agents.some(a => a.id === id)) return 'agent';
        return null;
    };
    // Универсальная функция загрузки (модель/vision)
    const setLoadingState = (btnSel, badgeSel, loading, text) => {
        const btn = $(btnSel), badge = $(badgeSel);
        if (!btn || !badge) return;
        if (loading) {
            btn.classList.add('loading');
            let spinner = btn.querySelector('.model-spinner');
            if (!spinner) { spinner = document.createElement('span'); spinner.className = 'model-spinner'; btn.insertBefore(spinner, badge); }
            if (text) badge.textContent = text;
        } else {
            btn.classList.remove('loading');
            const spinner = btn.querySelector('.model-spinner');
            if (spinner) spinner.remove();
        }
    };
    // Позиционирование дропдауна под кнопкой
    const positionDropdown = (btnSel, ddSel) => {
        const b = $(btnSel), d = $(ddSel);
        if (!b || !d) return;
        const r = b.getBoundingClientRect();
        d.style.top = (r.bottom + 8) + 'px';
        d.style.left = (r.left + 340 > window.innerWidth) ? (window.innerWidth - 360) + 'px' : r.left + 'px';
    };

    // ========== CROP MODAL ==========
    const openCropModal = file => new Promise(resolve => {
        const modal = $('#cropModal'), canvas = $('#cropCanvas'), container = $('#cropCanvasContainer');
        if (!modal || !canvas || !container) { resolve(null); return; }
        const ctx = canvas.getContext('2d');
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                const cw = container.clientWidth, ch = container.clientHeight;
                canvas.width = cw; canvas.height = ch;
                let imgX = 0, imgY = 0, scale = 1;
                let dragging = false, lastX = 0, lastY = 0;
                const circleR = Math.min(cw, ch) / 2;
                const cx = cw / 2, cy = ch / 2;
                const fitScale = (circleR * 2) / Math.max(img.width, img.height);
                scale = fitScale;
                imgX = cx - (img.width * scale) / 2;
                imgY = cy - (img.height * scale) / 2;
                const draw = () => {
                    ctx.clearRect(0, 0, cw, ch);
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
                    ctx.clip();
                    ctx.drawImage(img, imgX, imgY, img.width * scale, img.height * scale);
                    ctx.restore();
                };
                draw();
                const getPos = e => {
                    const r = container.getBoundingClientRect();
                    const p = e.touches ? e.touches[0] : e;
                    return { x: p.clientX - r.left, y: p.clientY - r.top };
                };
                const onDown = e => { e.preventDefault(); dragging = true; const p = getPos(e); lastX = p.x; lastY = p.y; container.style.cursor = 'grabbing'; };
                const onMove = e => {
                    if (!dragging) return;
                    e.preventDefault();
                    const p = getPos(e);
                    imgX += p.x - lastX;
                    imgY += p.y - lastY;
                    lastX = p.x; lastY = p.y;
                    draw();
                };
                const onUp = () => { dragging = false; container.style.cursor = 'grab'; };
                const onWheel = e => {
                    e.preventDefault();
                    const r = container.getBoundingClientRect();
                    const mx = (e.clientX - r.left), my = (e.clientY - r.top);
                    const zoom = e.deltaY < 0 ? 1.08 : 0.92;
                    const newScale = Math.max(fitScale * 0.5, Math.min(scale * zoom, fitScale * 5));
                    const ratio = newScale / scale;
                    imgX = mx - (mx - imgX) * ratio;
                    imgY = my - (my - imgY) * ratio;
                    scale = newScale;
                    draw();
                };
                container.addEventListener('mousedown', onDown);
                container.addEventListener('mousemove', onMove);
                container.addEventListener('mouseup', onUp);
                container.addEventListener('mouseleave', onUp);
                container.addEventListener('touchstart', onDown, { passive: false });
                container.addEventListener('touchmove', onMove, { passive: false });
                container.addEventListener('touchend', onUp);
                container.addEventListener('wheel', onWheel, { passive: false });
                const cleanup = () => {
                    container.removeEventListener('mousedown', onDown);
                    container.removeEventListener('mousemove', onMove);
                    container.removeEventListener('mouseup', onUp);
                    container.removeEventListener('mouseleave', onUp);
                    container.removeEventListener('touchstart', onDown);
                    container.removeEventListener('touchmove', onMove);
                    container.removeEventListener('touchend', onUp);
                    container.removeEventListener('wheel', onWheel);
                };
                $('#cropConfirmBtn').onclick = () => {
                    const out = document.createElement('canvas');
                    out.width = 512; out.height = 512;
                    const octx = out.getContext('2d');
                    octx.beginPath();
                    octx.arc(256, 256, 256, 0, Math.PI * 2);
                    octx.clip();
                    const srcX = (cx - circleR - imgX) / scale;
                    const srcY = (cy - circleR - imgY) / scale;
                    const srcS = (circleR * 2) / scale;
                    octx.drawImage(img, srcX, srcY, srcS, srcS, 0, 0, 512, 512);
                    cleanup(); modal.classList.add('hidden'); modal.classList.remove('flex');
                    resolve(out.toDataURL('image/jpeg', 0.85));
                };
                const closeModal = () => { cleanup(); modal.classList.add('hidden'); modal.classList.remove('flex'); resolve(null); };
                $('#cropCancelBtn').onclick = closeModal;
                modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        const chatEl = $('#chatMessages');
        if (chatEl) {
            const r = chatEl.getBoundingClientRect();
            modal.style.left = r.left + 'px';
            modal.style.width = r.width + 'px';
        }
        modal.classList.remove('hidden'); modal.classList.add('flex');
    });

    // ========== STATE ==========
    let chatList = [], currentChatId = null;
    let assistants = [], agents = [], selectedIds = [];
    let waiting = false, abortCtrl = null;
    let userScrolledUp = false;
    let noAutoScroll = false;
    let userSettings = { name: 'Вы', avatar: null };
    let chatWallpaper = '';

    function fadeOutTyping(el) {
        if (!el || el.classList.contains('hidden')) return;
        el.classList.add('fade-out');
        setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fade-out'); }, 400);
    }
    let assistantSettings = { name: 'MD LLM', avatar: null };
    let modelGenParams = {
        temperature: 0.7, top_p: 0.95, max_tokens: 2048, n_ctx: 8192,
        repeat_penalty: 1.1, top_k: 40, frequency_penalty: 0, presence_penalty: 0,
        n_batch: 4096, n_threads: 4, n_threads_batch: 4,
        n_gpu_layers: -1, flash_attn: true
    };
    let selectedModel = null, modalMode = null, modalId = null;
    let streamStartTime = 0, speedUpdateInterval = null, systemStatsInterval = null;
    let streamingAnswerText = '', streamingHistoryTokens = 0;
    let exactContext = null, exactSpeed = null;

    // Vision State
    let pendingImages = [];
    let currentMmproj = null;
    let visionActive = false;

    // ========== API HELPERS ==========
    async function api(url, opts = {}) {
        try {
            const r = await fetch(url, opts);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            console.error(`API Error ${url}:`, e);
            return { success: false, error: e.message };
        }
    }

    async function saveData(k, d) {
        try { 
            await api('/api/save_data', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ key: k, data: d }) 
            }); 
        } catch (e) { console.warn("Save failed", e); }
    }

    async function loadData(k, def) {
        try { 
            const r = await api(`/api/load_data/${k}`); 
            return r.success && r.data !== null ? r.data : def; 
        } catch { return def; }
    }

    // ========== STORAGE ==========
    async function loadStorage() {
        try {
            const cacheKey = 'md_llm_cache';
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                try {
                    const c = JSON.parse(cached);
                    if (c.chatList) chatList = c.chatList;
                    if (c.assistants) assistants = c.assistants;
                    if (c.agents) agents = c.agents;
                    if (c.selectedIds) selectedIds = c.selectedIds;
                    if (c.userSettings) userSettings = c.userSettings;
                    if (c.assistantSettings) assistantSettings = c.assistantSettings;
                    if (!chatList.find(c => c.id === currentChatId)) currentChatId = chatList[0]?.id;
                    renderChatList();
                    renderMessages();
                    updateActiveDisplay();
                } catch {}
            }

            const [chatListData, assistantsData, agentsData, userData, assistantData, savedSelectedIds] = await Promise.all([
                loadData('chatList', chatList.length ? chatList : [{ id: 'default', name: '\u041d\u043e\u0432\u044b\u0439 \u0447\u0430\u0442', messages: [] }]),
                loadData('assistants', assistants.length ? assistants : [{ id: 'default', name: '\u0410\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442', prompt: '\u0422\u044b \u043f\u043e\u043b\u0435\u0437\u043d\u044b\u0439 AI.', temp: 0.7 }]),
                loadData('agents', agents),
                loadData('userSettings', userSettings),
                loadData('assistantSettings', assistantSettings),
                loadData('selectedIds', selectedIds)
            ]);
            chatList = chatListData;
            assistants = assistantsData;
            agents = agentsData;
            userSettings = userData;
            assistantSettings = assistantData;
            if (savedSelectedIds && savedSelectedIds.length) selectedIds = savedSelectedIds;

            api('/api/gen_params').then(r => { if (r.success && r.params) Object.assign(modelGenParams, r.params); }).catch(() => {});

            if (!chatList.find(c => c.id === currentChatId)) currentChatId = chatList[0]?.id;

            const activeChat = chatList.find(c => c.id === currentChatId);
            if (activeChat && activeChat.messages.length) {
                const lastMsg = activeChat.messages[activeChat.messages.length - 1];
                if (lastMsg.role === 'assistant' && lastMsg.metrics && lastMsg.metrics.prompt_tokens) {
                    exactContext = lastMsg.metrics.prompt_tokens + (lastMsg.metrics.completion_tokens || 0);
                    exactSpeed = lastMsg.metrics.tokens_per_second || null;
                }
            }

            const thinkSaved = localStorage.getItem('thinkMode');
            if (thinkSaved !== null) {
                const t = $('#thinkModeToggle'); if (t) t.checked = thinkSaved === 'true';
            }
            
            forceSyncParams();
            renderChatList();
            renderMessages();
            updateActiveDisplay();
            updateLiveStatusBar();
            const defer = (fn, ms) => setTimeout(fn, ms || 0);
            defer(() => renderAssistantsDropdown(), 0);
            defer(() => startSystemStatsPolling(), 100);
            defer(() => initVisionUI(), 100);
            defer(() => { syncParamUI(); initAgentProfileModal(); }, 200);
        } catch (e) {
            console.error("Storage Load Error:", e);
            showToast("Ошибка загрузки данных", "error");
        }
    }

    const _dirtyKeys = new Set();
    function markDirty(...keys) { keys.forEach(k => _dirtyKeys.add(k)); }

    async function saveStorage() {
        const dd = $('#assistantsAgentsDropdown'); if (dd) delete dd.dataset.rendered;
        if (!_dirtyKeys.size) return;
        const toSave = [..._dirtyKeys];
        _dirtyKeys.clear();
        try { localStorage.setItem('md_llm_cache', JSON.stringify({ chatList, assistants, agents, userSettings, assistantSettings, selectedIds })); } catch(e) {}
        await Promise.all(toSave.map(k => {
            const data = { chatList, assistants, agents, userSettings, assistantSettings, modelGenParams, chatWallpaper, selectedIds }[k];
            return data !== undefined ? saveData(k, data) : Promise.resolve();
        }));
    }

    // ========== PARAMS ==========
    const pm = [
        { s: 'paramTemperature', d: 'tempValueDisplay', k: 'temperature', f: true },
        { s: 'paramTopP', d: 'topPValueDisplay', k: 'top_p', f: true },
        { s: 'paramMaxTokens', d: 'maxTokensValueDisplay', k: 'max_tokens', f: false },
        { s: 'paramContextSize', d: 'ctxSizeValueDisplay', k: 'n_ctx', f: false },
        { s: 'paramNBatch', d: 'nBatchValueDisplay', k: 'n_batch', f: false },
        { s: 'paramRepeatPenalty', d: 'repeatPenaltyValueDisplay', k: 'repeat_penalty', f: true },
        { s: 'paramTopK', d: 'topKValueDisplay', k: 'top_k', f: false },
        { s: 'paramNGpuLayers', d: 'nGpuLayersValueDisplay', k: 'n_gpu_layers', f: false }
    ];

    function syncParamUI() {
        pm.forEach(p => {
            const sl = $(`#${p.s}`), di = $(`#${p.d}`);
            if (sl && di) {
                const upd = () => { let v = parseFloat(sl.value); if (!p.f) v = Math.round(v); di.innerText = p.f ? v.toFixed(2) : v; };
                sl.addEventListener('input', upd); upd();
            }
        });
        const fl = $('#flashAttnToggle'); if (fl) fl.checked = modelGenParams.flash_attn !== false;
    }

    function forceSyncParams() {
        pm.forEach(p => {
            const sl = $(`#${p.s}`), di = $(`#${p.d}`);
            if (sl) { const v = modelGenParams[p.k] ?? 0; sl.value = v; if (di) di.innerText = p.f ? parseFloat(v).toFixed(2) : v; }
        });
        const fl = $('#flashAttnToggle'); if (fl) fl.checked = modelGenParams.flash_attn !== false;
    }

    function collectParams() {
        pm.forEach(p => { const sl = $(`#${p.s}`); if (sl) modelGenParams[p.k] = p.f ? parseFloat(sl.value) : parseInt(sl.value); });
        const fl = $('#flashAttnToggle'); if (fl) modelGenParams.flash_attn = fl.checked;
    }

    async function saveGenParams() {
        collectParams();
        try { 
            await api('/api/gen_params', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ params: modelGenParams }) 
            }); 
            showToast('Сохранено', 'success'); 
            updateLiveStatusBar(); 
        } catch (e) { showToast('Ошибка', 'error'); }
    }

    async function loadGenParams() {
        try { 
            const r = await api('/api/gen_params'); 
            if (r.success && r.params) { 
                Object.assign(modelGenParams, r.params); 
                forceSyncParams(); 
                updateLiveStatusBar(); 
            } 
        } catch { }
    }

    // ========== STATS & VISION ==========
    async function fetchSystemStats() {
        try {
            const r = await api('/api/system_stats');
            if (!r.success || !r.stats) return;
            const s = r.stats;
            const ru = $('#liveRamUsed'), rt = $('#liveRamTotal');
            if (ru && rt && s.ram) {
                ru.textContent = s.ram.used_mb || 0;
                rt.textContent = s.ram.total_mb || 0;
            }
            const vs = $('#vramStatus'), vu = $('#liveVramUsed'), vt = $('#liveVramTotal');
            if (s.gpus && s.gpus.length > 0) {
                const g = s.gpus[0];
                if (vs) vs.style.display = 'flex';
                if (vu) vu.textContent = g.mem_used_mb || 0;
                if (vt) vt.textContent = g.mem_total_mb || 0;
            } else { if (vs) vs.style.display = 'none'; }
        } catch { }
    }

    function startSystemStatsPolling() {
        fetchSystemStats();
        if (systemStatsInterval) clearInterval(systemStatsInterval);
        systemStatsInterval = setInterval(fetchSystemStats, 5000);
    }

    function updateLiveStatusBar(ct = null, sp = null) {
        const ce = $('#liveContext'), cm = $('#liveContextMax'), cp = $('#liveContextPercent'), se = $('#liveSpeed');
        if (cm) cm.textContent = modelGenParams.n_ctx;
        if (ct !== null) {
            exactContext = ct;
            if (ce) ce.textContent = ct;
            const p = Math.min(100, Math.floor((ct / modelGenParams.n_ctx) * 100));
            if (cp) { cp.textContent = `(${p}%)`; cp.style.color = ctxPercentColor(p); }
        } else estimateCurrentContext();
        if (sp !== null && se) { exactSpeed = sp; se.textContent = sp.toFixed(1); }
        else if (exactSpeed !== null && se) se.textContent = exactSpeed.toFixed(1);
    }

    function estimateCurrentContext() {
        const ce = $('#liveContext'), cp = $('#liveContextPercent');
        if (!ce) return;
        if (exactContext !== null) {
            ce.textContent = exactContext;
            const p = Math.min(100, Math.floor((exactContext / modelGenParams.n_ctx) * 100));
            if (cp) { cp.textContent = `(${p}%)`; cp.style.color = ctxPercentColor(p); }
            return;
        }
        const chat = getChat();
        if (!chat) return;
        if (!chat.messages.length) { ce.textContent = '0'; if (cp) cp.textContent = '(0%)'; return; }
        let tc = 0;
        chat.messages.forEach(m => {
            const c = m.content;
            if (typeof c === 'string') tc += c.length;
            else if (Array.isArray(c)) c.forEach(p => { if (p.text) tc += p.text.length; });
        });
        const est = Math.ceil(tc / 4);
        ce.textContent = est;
        const p = Math.min(100, Math.floor((est / modelGenParams.n_ctx) * 100));
        if (cp) { cp.textContent = `(${p}%)`; cp.style.color = ctxPercentColor(p); }
    }

    let speedElCache = null, contextElCache = null, contextPercentElCache = null;

    function startSpeedTracking(historyTokens) {
        streamStartTime = performance.now();
        streamingAnswerText = '';
        streamingHistoryTokens = historyTokens || 0;
        speedElCache = $('#liveSpeed');
        contextElCache = $('#liveContext');
        contextPercentElCache = $('#liveContextPercent');
        if (speedUpdateInterval) clearInterval(speedUpdateInterval);
        speedUpdateInterval = setInterval(() => {
            if (!streamStartTime) return;
            const el = (performance.now() - streamStartTime) / 1000;
            if (el < 0.3) return;
            const estTokens = Math.ceil(streamingAnswerText.length / 4);
            const speed = estTokens / el;
            if (speedElCache) speedElCache.textContent = speed.toFixed(1);
            if (contextElCache) {
                const total = streamingHistoryTokens + estTokens;
                contextElCache.textContent = total;
                if (contextPercentElCache) {
                    const p = Math.min(100, Math.floor((total / modelGenParams.n_ctx) * 100));
                    contextPercentElCache.textContent = `(${p}%)`;
                    contextPercentElCache.style.color = ctxPercentColor(p);
                }
            }
        }, 200);
    }

    function stopSpeedTracking() {
        if (speedUpdateInterval) { clearInterval(speedUpdateInterval); speedUpdateInterval = null; }
        speedElCache = null; contextElCache = null; contextPercentElCache = null;
    }

    function initVisionUI() {
        const btn = $('#visionUploadBtn'), inp = $('#visionFileInput');
        if (btn && inp) {
            btn.onclick = () => { if (!btn.classList.contains('has-images')) inp.click(); };
            inp.onchange = async e => {
                const files = Array.from(e.target.files || []);
                for (const f of files) {
                    if (!f.type.startsWith('image/')) continue;
                    if (pendingImages.length >= 5) { showToast('Макс. 5 изображений', 'warning'); break; }
                    try { pendingImages.push(await fileToBase64(f)); } catch { showToast('Ошибка чтения', 'error'); }
                }
                inp.value = '';
                updateVisionPreview();
            };
        }
    }

    function fileToBase64(file) {
        return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    }

    function updateVisionPreview() {
        const c = $('#visionPreviewContainer'), b = $('#visionUploadBtn');
        if (!b) return;
        if (!pendingImages.length) { if (c) { c.style.display = 'none'; c.innerHTML = ''; } b.classList.remove('has-images'); b.innerHTML = '<svg class="w-5 h-5"><use href="#icon-paperclip"></use></svg>'; return; }
        b.classList.add('has-images');
        const lastImg = pendingImages[pendingImages.length - 1];
        b.innerHTML = `<div class="paperclip-preview"><img src="${lastImg}" alt="preview"><button class="paperclip-remove" title="Удалить">✕</button></div>`;
        if (pendingImages.length > 1) {
            const badge = document.createElement('span');
            badge.className = 'paperclip-count';
            badge.textContent = pendingImages.length;
            b.appendChild(badge);
        }
        const removeBtn = b.querySelector('.paperclip-remove');
        if (removeBtn) removeBtn.onclick = e => { e.stopPropagation(); pendingImages = []; updateVisionPreview(); };
        b.onclick = () => { if (pendingImages.length) { pendingImages = []; updateVisionPreview(); } else { $('#visionFileInput')?.click(); } };
    }

    function toggleVisionBtn(show) {
        const btn = $('#visionUploadBtn');
        if (btn) btn.style.display = show ? 'flex' : 'none';
    }

    // ========== MODEL LOADING ANIMATION ==========
    function setModelLoading(loading, text) { setLoadingState('#changeModelBtn', '#currentModelBadge', loading, text); }
    function setVisionLoading(loading, text) { setLoadingState('#changeVisionBtn', '#currentVisionBadge', loading, text); }

    function updateVisionBadge() {
        const b = $('#visionBadge');
        if (b) { if (visionActive) b.classList.remove('hidden'); else b.classList.add('hidden'); }
    }

    // ========== MODELS LOGIC ==========
    async function loadModelsList() {
        try {
            const d = await api('/api/models');
            const c = $('#modelListItems'); 
            if (c) {
                c.innerHTML = '';
                const cur = d.current_model;
                let models = (d.models || []).slice().sort((a, b) => (typeof a === 'object' ? a.size_gb : 0) - (typeof b === 'object' ? b.size_gb : 0));
                if (!models.length) c.innerHTML = '<div style="text-align:center;color:#6e6e73;padding:16px;">Нет моделей</div>';
                else models.forEach(m => {
                    const name = typeof m === 'string' ? m : m.name;
                    const info = typeof m === 'object' ? (m.size_gb + 'GB') : '';
                    const isActive = name === cur;
                    const div = document.createElement('div');
                    div.className = 'model-item flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors' + (isActive ? ' bg-white/10 border border-white/20' : '');
                    div.innerHTML = `
                        <div class="flex items-center gap-2 truncate flex-1">
                            <label class="toggle-switch compact" onclick="event.stopPropagation()">
                                <input type="checkbox" class="model-toggle" data-model="${escapeHtml(name)}" ${isActive ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="truncate text-sm">${escapeHtml(name)}</span>
                        </div>
                        <span style="color:#6e6e73;font-size:11px;flex-shrink:0;">${info}</span>
                    `;
                    div.onclick = (e) => {
                        if (e.target.closest('.toggle-switch')) return;
                        const checkbox = div.querySelector('.model-toggle');
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                    };
                    c.appendChild(div);
                });
                $$('.model-toggle', c).forEach(toggle => {
                    toggle.addEventListener('change', async (e) => {
                        const modelName = e.target.dataset.model;
                        if (e.target.checked) {
                            $$('.model-toggle').forEach(other => { if (other !== toggle) other.checked = false; });
                            await doLoadModel(modelName);
                        } else { await doUnloadModel(); }
                    });
                });
            }
            const badge = $('#currentModelBadge');
            if (badge) { const name = d.current_model || (window.i18n?.t('header.selectModel') || 'Выберите модель'); badge.innerText = name.length > 25 ? name.slice(0, 22) + '...' : name; }
            const gb = $('#gpuStatusBadge');
            if (gb) {
                if (d.model_loaded) {
                    gb.innerText = d.gpu_enabled ? 'GPU' : 'CPU';
                    gb.classList.remove('hidden');
                    gb.style.background = d.gpu_enabled ? '' : 'linear-gradient(135deg, #ff9500, #cc7700)';
                } else {
                    gb.classList.add('hidden');
                }
            }
            const gpuT = $('#gpuToggle');
            if (gpuT) gpuT.checked = d.gpu_enabled;
            
            // Vision List Logic
            const visionList = $('#visionListItems');
            const visionBadge = $('#currentVisionBadge');
            if (visionList) {
                visionList.innerHTML = '';
                if (d.mmproj_files && d.mmproj_files.length > 0) {
                     const noneDiv = document.createElement('div');
                    const isNoneActive = !d.current_mmproj;
                    noneDiv.className = 'model-item flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors' + (isNoneActive ? ' bg-white/10 border border-white/20' : '');
                    noneDiv.innerHTML = `<div class="flex items-center gap-2 truncate flex-1"><label class="toggle-switch compact" onclick="event.stopPropagation()"><input type="checkbox" class="vision-toggle" data-filename="" ${isNoneActive ? 'checked' : ''}><span class="toggle-slider"></span></label><span class="truncate text-sm" style="color:#34c759">🚫 ${window.i18n?.t('header.noVision') || 'Без Vision'}</span></div>`;
                    noneDiv.onclick = (ev) => { if (ev.target.closest('.toggle-switch')) return; const cb = noneDiv.querySelector('.vision-toggle'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); };
                    visionList.appendChild(noneDiv);
                    d.mmproj_files.forEach(f => {
                        const isActive = d.current_mmproj === f.name;
                        const row = document.createElement('div');
                        row.className = 'model-item flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors mt-1' + (isActive ? ' bg-white/10 border border-white/20' : '');
                        row.innerHTML = `<div class="flex items-center gap-2 truncate flex-1"><label class="toggle-switch compact" onclick="event.stopPropagation()"><input type="checkbox" class="vision-toggle" data-filename="${escapeHtml(f.name)}" ${isActive ? 'checked' : ''}><span class="toggle-slider"></span></label><span class="truncate text-sm">👁️ ${escapeHtml(f.name)}</span></div><span style="color:#6e6e73;font-size:11px;flex-shrink:0;">${f.size_mb}MB</span>`;
                        row.onclick = (ev) => { if (ev.target.closest('.toggle-switch')) return; const cb = row.querySelector('.vision-toggle'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); };
                        visionList.appendChild(row);
                    });
                    $$('.vision-toggle', visionList).forEach(toggle => {
                        toggle.addEventListener('change', async (e) => {
                            const fn = e.target.dataset.filename;
                            $$('.vision-toggle', visionList).forEach(other => { if (other !== toggle) other.checked = false; });
                            if (!e.target.checked) { const noneToggle = $('.vision-toggle[data-filename=""]', visionList); if (noneToggle) noneToggle.checked = true; if (fn !== '') await doUnloadVision(); } 
                            else if (fn === '') { await doUnloadVision(); } 
                            else { await doLoadVision(fn); }
                        });
                    });
                } else { visionList.innerHTML = `<div style="text-align:center;color:#6e6e73;padding:16px;">${window.i18n?.t('status.noVisionModules') || 'Нет vision модулей'}</div>`; }
            }
            if (visionBadge) {
                if (d.current_mmproj) {
                    const shortName = d.current_mmproj.replace('mmproj-', '').replace('.gguf', '');
                    visionBadge.innerText = shortName.length > 18 ? shortName.slice(0, 15) + '...' : shortName;
                    visionBadge.style.color = '#34c759';
                } else { visionBadge.innerText = window.i18n?.t('header.noVision') || 'Без Vision'; visionBadge.style.color = '#34c759'; }
            }
            if (d.model_loaded && d.current_model) selectedModel = d.current_model;
            currentMmproj = d.current_mmproj || null;
            visionActive = d.vision_active || false;
            toggleVisionBtn(visionActive);
            updateVisionBadge();
        } catch (e) { showToast('Ошибка моделей', 'error'); }
    }

    async function doLoadModel(modelName) {
        const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
        setModelLoading(true, i18nT('status.loading'));
        showToast(`${i18nT('status.loading')} ${modelName}...`, 'info', 1000);
        try {
            await api('/api/unload_model', { method: 'POST' });
            const r = await api('/api/load_model', { 
                method: 'POST', headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ model_name: modelName, use_gpu: true, n_ctx: modelGenParams.n_ctx, n_batch: modelGenParams.n_batch, n_gpu_layers: modelGenParams.n_gpu_layers, flash_attn: modelGenParams.flash_attn }) 
            });
            if (r.success) { 
                selectedModel = modelName;
                showToast(`✅ ${modelName.split('.')[0]} (${r.gpu_enabled ? 'GPU' : 'CPU'})`, 'success'); 
                await loadModelsList(); 
            } else { showToast(`❌ ${r.error}`, 'error', 4000); }
        } catch (e) { showToast('❌ ' + e.message, 'error'); }
        setModelLoading(false);
    }

    async function doUnloadModel() {
        const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
        setModelLoading(true, i18nT('status.unload'));
        try {
            await api('/api/unload_model', { method: 'POST' });
            selectedModel = null;
            showToast(i18nT('status.modelUnloaded'), 'info');
            await loadModelsList();
        } catch (e) { showToast(i18nT('status.error'), 'error'); }
        setModelLoading(false);
    }

    async function doLoadVision(filename) {
        const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
        setVisionLoading(true, `${i18nT('status.loading')} Vision...`);
        try {
            const r = await api('/api/load_mmproj', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: filename }) });
            if (r.success) {
                currentMmproj = filename; visionActive = true;
                toggleVisionBtn(true); updateVisionBadge();
                showToast('✅ Vision: ' + filename, 'success');
                await loadModelsList();
            } else throw new Error(r.error);
        } catch (err) { showToast('❌ Vision: ' + err.message, 'error'); await loadModelsList(); }
        setVisionLoading(false);
    }

    async function doUnloadVision() {
        const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
        setVisionLoading(true, `${i18nT('status.unload')} Vision`);
        try {
            await api('/api/load_mmproj', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: '' }) });
            currentMmproj = null; visionActive = false;
            toggleVisionBtn(false); updateVisionBadge();
            showToast(i18nT('header.noVision'), 'info');
            await loadModelsList();
        } catch (err) { showToast(i18nT('status.error') + ' Vision', 'error'); }
        setVisionLoading(false);
    }

    function positionModelDropdown() { positionDropdown('#changeModelBtn', '#modelDropdownContainer'); }
    function positionVisionDropdown() { positionDropdown('#changeVisionBtn', '#visionDropdownContainer'); }

    // ========== CHAT LOGIC ==========
    const getChat = () => chatList.find(c => c.id === currentChatId);
    function getSelectedIds() { return selectedIds; }
    function setSelectedIds(ids) { selectedIds = ids; }
    function addChat(n = 'Новый чат') { if (abortCtrl) abortCtrl.abort(); waiting = false; exactContext = null; exactSpeed = null; const prevChat = getChat(); if (prevChat) { const c = $('#chatMessages'); if (c) prevChat._scrollPos = c.scrollTop; } const id = Date.now().toString(); chatList.unshift({ id, name: n, messages: [] }); currentChatId = id; markDirty('chatList'); renderChatList(); renderMessages(); saveStorage(); }
    function deleteChat(id) { if (abortCtrl) abortCtrl.abort(); waiting = false; exactContext = null; exactSpeed = null; if (chatList.length === 1) return; chatList = chatList.filter(c => c.id !== id); if (currentChatId === id) currentChatId = chatList[0].id; markDirty('chatList'); renderChatList(); renderMessages(); saveStorage(); }
    function renameChat(id, name) { const c = chatList.find(x => x.id === id); if (c && name) { c.name = name; markDirty('chatList'); renderChatList(); saveStorage(); } }

    function moveChatToTop(id) {
        const idx = chatList.findIndex(c => c.id === id);
        if (idx > 0) {
            const chat = chatList.splice(idx, 1)[0];
            chatList.unshift(chat);
            markDirty('chatList');
            renderChatList();
            saveStorage();
        }
    }

    function generateChatName(chat) {
        if (!chat || !chat.messages.length || chat.messages.length < 2) return;
        
        const msgs = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-6);
        if (msgs.length < 2) return;
        
        api('/api/generate_name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: msgs })
        }).then(r => {
            if (r.success && r.name) {
                chat.name = r.name;
                markDirty('chatList');
                renderChatList();
                saveStorage();
            }
        }).catch(() => {});
    }

    let hoverGlowFrame = null;
    let hoverGlowTarget = null;
    let activeGlowFrame = null;
    let activeGlowTarget = null;
    let btnGlow = '';
    function runGlow(el) {
        if (!btnGlow || !el) return null;
        const m = btnGlow.match(/#[0-9a-fA-F]{6}/g);
        if (!m || m.length < 2) return null;
        const rgb1 = [parseInt(m[0].slice(1,3),16), parseInt(m[0].slice(3,5),16), parseInt(m[0].slice(5,7),16)];
        const rgb2 = [parseInt(m[1].slice(1,3),16), parseInt(m[1].slice(3,5),16), parseInt(m[1].slice(5,7),16)];
        function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
        function lerpColor(c1, c2, t) { return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`; }
        const POINTS = 8, RINGS = 2;
        let t = 0, alive = true, id = null;
        function animate() {
            if (!alive) return;
            t += 0.02;
            if (t > 1) t -= 1;
            const shadows = [];
            for (let ring = 1; ring <= RINGS; ring++) {
                const dist = ring * 2, blur = ring * 3;
                const opacity = 1 - (ring - 1) / RINGS;
                for (let i = 0; i < POINTS; i++) {
                    const angle = (i / POINTS) * Math.PI * 2;
                    const phase = (t + i / POINTS) % 1;
                    const blend = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
                    const c = lerpColor(rgb1, rgb2, blend);
                    const x = Math.cos(angle) * dist, y = Math.sin(angle) * dist;
                    shadows.push(`${x.toFixed(1)}px ${y.toFixed(1)}px ${blur}px color-mix(in srgb, ${c} ${Math.round(opacity * 60)}%, transparent)`);
                }
            }
            el.style.boxShadow = shadows.join(', ');
            id = requestAnimationFrame(animate);
        }
        animate();
        return { stop() { alive = false; if (id) cancelAnimationFrame(id); el.style.boxShadow = ''; } };
    }
    function startChatGlow(el) {
        if (hoverGlowFrame) hoverGlowFrame.stop();
        hoverGlowTarget = el;
        hoverGlowFrame = runGlow(el);
    }
    function stopChatGlow() {
        if (hoverGlowFrame) hoverGlowFrame.stop();
        hoverGlowFrame = null;
        hoverGlowTarget = null;
    }
    function glowActiveChat() {
        if (activeGlowFrame) activeGlowFrame.stop();
        activeGlowTarget = document.querySelector('.chat-item.active');
        activeGlowFrame = runGlow(activeGlowTarget);
    }

    function renderChatList() {
        const c = $('#chatList'); if (!c) return;
        c.innerHTML = chatList.map(ch => `<div class="chat-item ${currentChatId === ch.id ? 'active' : ''}" data-id="${ch.id}"><span class="truncate flex-1 chat-name-span px-2">${escapeHtml(ch.name)}</span><div class="chat-item-buttons flex gap-1"><button class="rename-chat" data-id="${ch.id}"><i class="fas fa-pen"></i></button><button class="del-chat" data-id="${ch.id}"><i class="fas fa-trash"></i></button></div></div>`).join('');
        $$('.rename-chat').forEach(b => b.onclick = e => { e.stopPropagation(); startEditChatName(b.closest('.chat-item').querySelector('.chat-name-span'), b.dataset.id); });
        $$('.del-chat').forEach(b => b.onclick = e => { e.stopPropagation(); deleteChat(b.dataset.id); });
        $$('.chat-item').forEach(item => {
            const span = item.querySelector('.chat-name-span');
            if (span) span.onclick = e => { e.stopPropagation(); const id = item.dataset.id; if (id && currentChatId !== id) { const prevChat = getChat(); if (prevChat) { const c = $('#chatMessages'); if (c) prevChat._scrollPos = c.scrollTop; } exactContext = null; exactSpeed = null; currentChatId = id; renderChatList(); renderMessages(); } };
            item.addEventListener('mouseenter', () => startChatGlow(item));
            item.addEventListener('mouseleave', () => stopChatGlow());
        });
        glowActiveChat();
    }

    function startEditChatName(el, id) {
        const cur = el.innerText; const inp = document.createElement('input'); inp.type = 'text'; inp.value = cur; inp.className = 'inline-input'; if (isMobile) inp.style.fontSize = '16px';
        el.innerHTML = ''; el.appendChild(inp); inp.focus(); inp.select();
        const save = () => { const n = inp.value.trim(); if (n && n !== cur) renameChat(id, n); else el.innerText = cur; };
        inp.addEventListener('blur', save); inp.addEventListener('keypress', e => { if (e.key === 'Enter') inp.blur(); });
    }

    let mdRenderPending = false;
    let mdRenderTimer = null;
    let mdLatestEl = null;
    let mdLatestText = null;
    let mdRenderRafId = null;
    let mdLastRenderTime = 0;
    function scheduleMarkdownRender(el, text, isStreaming) {
        if (!isStreaming) { if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; } if (mdRenderRafId) { cancelAnimationFrame(mdRenderRafId); mdRenderRafId = null; } mdRenderPending = false; el.innerHTML = parseMarkdown(text, false); return; }
        el.innerHTML = parseMarkdown(text, true);
    }

    function parseMarkdown(text, isStreaming = false) {
        if (!text) return '';
        let result = '', i = 0, len = text.length;

        function parseInline(s) {
            let r = '', j = 0, sl = s.length;
            while (j < sl) {
                if (s[j] === '*' && j + 1 < sl && s[j + 1] === '*') { const end = s.indexOf('**', j + 2); if (end !== -1) { r += '<strong>' + escapeHtml(s.substring(j + 2, end)) + '</strong>'; j = end + 2; continue; } }
                else if (s[j] === '*' && (j + 1 >= sl || s[j + 1] !== '*')) { const end = s.indexOf('*', j + 1); if (end !== -1 && end !== j + 1) { r += '<em>' + escapeHtml(s.substring(j + 1, end)) + '</em>'; j = end + 1; continue; } }
                else if (s[j] === '`') { const end = s.indexOf('`', j + 1); if (end !== -1) { r += '<code>' + escapeHtml(s.substring(j + 1, end)) + '</code>'; j = end + 1; continue; } }
                r += escapeHtml(s[j]); j++;
            }
            return r;
        }
        while (i < len) {
            if (text[i] === '`' && i + 2 < len && text[i + 1] === '`' && text[i + 2] === '`') {
                i += 3; let lang = ''; while (i < len && text[i] !== '\n' && text[i] !== '\r') { lang += text[i]; i++; } lang = lang.trim() || 'text';
                while (i < len && (text[i] === '\n' || text[i] === '\r')) i++;
                let code = '', closed = false;
                while (i < len) { if (text[i] === '`' && i + 2 < len && text[i + 1] === '`' && text[i + 2] === '`') { closed = true; break; } code += text[i]; i++; }
                const cid = 'c' + Math.random().toString(36).substr(2, 9);
                const sb = isStreaming && !closed;
                result += `<div class="code-block-wrapper${sb ? ' streaming-code-block' : ''}"><div class="code-block-header"><span class="code-language">${escapeHtml(lang)}</span><div class="code-block-buttons"><button onclick="(function(){const el=document.getElementById('${cid}');if(el){navigator.clipboard.writeText(el.textContent);event.target.innerHTML='✓';setTimeout(()=>{event.target.innerHTML='📋'},1500)}})()">📋</button></div></div><div class="code-block-content"><pre><code class="language-${escapeHtml(lang)}" id="${cid}">${escapeHtml(code)}${sb ? '<span class="streaming-cursor"></span>' : ''}</code></pre></div></div>`;
                if (closed) i += 3;
            } else if (text[i] === '#' && (i === 0 || text[i - 1] === '\n')) {
                let h = 0, j = i; while (j < len && text[j] === '#') { h++; j++; }
                if (h <= 6 && (j >= len || text[j] === ' ')) { if (j < len && text[j] === ' ') j++; let ht = ''; while (j < len && text[j] !== '\n') { ht += text[j]; j++; } result += `<h${Math.min(h, 3)}>${parseInline(ht)}</h${Math.min(h, 3)}>`; i = j; continue; }
                result += escapeHtml(text[i]); i++;
            } else if (text[i] === '*' && i + 1 < len && text[i + 1] === '*') { const end = text.indexOf('**', i + 2); if (end !== -1) { result += '<strong>' + escapeHtml(text.substring(i + 2, end)) + '</strong>'; i = end + 2; continue; } result += escapeHtml(text[i]); i++; }
            else if (text[i] === '*' && (i + 1 >= len || text[i + 1] !== '*')) { const end = text.indexOf('*', i + 1); if (end !== -1 && end !== i + 1) { result += '<em>' + escapeHtml(text.substring(i + 1, end)) + '</em>'; i = end + 1; continue; } result += escapeHtml(text[i]); i++; }
            else if (text[i] === '`') { const end = text.indexOf('`', i + 1); if (end !== -1) { result += '<code>' + escapeHtml(text.substring(i + 1, end)) + '</code>'; i = end + 1; continue; } result += escapeHtml(text[i]); i++; }
            else if (text[i] === '\n') { result += '<br>'; i++; }
            else { result += escapeHtml(text[i]); i++; }
        }
        return result;
    }

    function isLikelyComplete(text) { if (!text) return false; const t = text.trimEnd(); if (!t) return false; return /[.!?)}\]>"'`]\s*$/.test(t) || /```\s*$/.test(t); }
    function showContinueButton(idx) {
        const c = $('#chatMessages'); if (!c) return;
        const acts = $$('.message-actions', c);
        for (const a of acts) {
            if (a.querySelector(`.copy-msg[data-idx="${idx}"]`)) {
                if (a.querySelector('.continue-btn')) return;
                const b = document.createElement('button'); b.className = 'continue-btn'; b.title = 'Продолжить'; b.innerHTML = '<i class="fas fa-play"></i> Продолжить';
                b.onclick = e => { e.stopPropagation(); continueGeneration(); };
                a.appendChild(b); return;
            }
        }
    }

    async function continueGeneration() {
        const chat = getChat(); if (!chat || !chat.messages.length || waiting) return;
        let li = -1; for (let i = chat.messages.length - 1; i >= 0; i--) { if (chat.messages[i].role === 'assistant' && chat.messages[i].content) { li = i; break; } }
        if (li === -1) return;
        const last = chat.messages[li];
        const existing = typeof last.content === 'string' ? last.content : (last.content || '');
        const cb = document.querySelector('.continue-btn'); if (cb) cb.remove();
        waiting = true;
        const sb = $('#stopBtn'), ty = $('#typingIndicatorContainer');
        if (sb) sb.disabled = false;
        if (ty) { ty.classList.remove('hidden'); ty.classList.remove('fade-out'); ty.classList.add('fade-in'); ty.querySelector('.typing-text').textContent = 'Продолжение'; }
        abortCtrl = new AbortController();
        const history = chat.messages.map(m => ({ role: m.role, content: m.content }));
        const aid = last.agent_id || getSelectedIds()[0];
        const agent = assistants.find(a => a.id === aid) || agents.find(a => a.id === aid);
        if (!agent) { waiting = false; if (sb) sb.disabled = true; fadeOutTyping(ty); return; }
        const c = $('#chatMessages');
        try {
            const td = document.createElement('div'); td.className = 'message-group message-group-assistant'; td.id = 'live-stream-message';
            const agAv = agent.avatar || assistantSettings.avatar;
            const ah = agAv ? `<img src="${agAv}" class="avatar-img" data-profile="assistant">` : '<div class="avatar-placeholder" data-profile="assistant"><i class="fas fa-robot"></i></div>';
            td.innerHTML = `<div class="avatar-wrapper">${ah}</div><div class="message-wrapper"><div style="margin-bottom:4px;"><span class="name-badge">${escapeHtml(agent.name || assistantSettings.name)}</span></div><div class="message-assistant"><div class="message-content" id="live-stream-content"></div></div></div>`;
            c.appendChild(td); if (!noAutoScroll) setTimeout(() => c.scrollTop = c.scrollHeight, 50);
            const ce = $('#live-stream-content'); let answer = existing, usage = null;
            if (ce) ce.innerHTML = parseMarkdown(answer, true);
            const thinkEnabled = $('#thinkModeToggle')?.checked ?? false;
            const body = buildStreamBody(agent, history, [], thinkEnabled);
            let historyTokens = 0;
            history.forEach(m => { const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); historyTokens += Math.ceil(txt.length / 4); });
            startSpeedTracking(historyTokens);
            await streamSSE(body, (token) => {
                answer += token; streamingAnswerText = answer;
                if (ce) scheduleMarkdownRender(ce, answer, true);
                if (!userScrolledUp && !noAutoScroll && c.scrollHeight - c.scrollTop - c.clientHeight < 150) c.scrollTop = c.scrollHeight;
            }, (u) => { if (u) usage = u; }, abortCtrl.signal);
            td.remove();
            const cont = answer.substring(existing.length);
            if (cont.trim()) {
                chat.messages[li].content = answer; if (usage) chat.messages[li].metrics = usage;
            markDirty('chatList'); saveStorage();
            moveChatToTop(currentChatId);
            generateChatName(chat);
                const allGroups = $$('.message-group-assistant', c);
                const target = allGroups[li] || allGroups[allGroups.length - 1];
                if (target) {
                    const mc = target.querySelector('.message-content');
                    if (mc) mc.innerHTML = parseMarkdown(answer, false);
                    const mw = target.querySelector('.message-wrapper');
                    if (mw) {
                        const oldMet = mw.querySelector('div[style*="margin-top:6px"]');
                        if (oldMet) oldMet.remove();
                        if (usage) {
                            const ma = mw.querySelector('.message-assistant');
                            if (ma) ma.insertAdjacentHTML('beforeend', buildMetricsHtml(usage));
                        }
                    }
                    target.style.animation = 'fadeInUp 0.3s ease-out';
                }
                if (typeof hljs !== 'undefined') { const cbs = $$('#chatMessages pre code:not([data-hl])'); let bi = 0; function hlBatch() { const e2 = Math.min(bi + 5, cbs.length); for (let j = bi; j < e2; j++) { try { hljs.highlightElement(cbs[j]); } catch(e) {} cbs[j].dataset.hl = '1'; } bi = e2; if (bi < cbs.length) setTimeout(hlBatch, 0); } if (cbs.length) setTimeout(hlBatch, 0); }
                if (!isLikelyComplete(answer)) showContinueButton(li);
            }
        } catch (e) {
            const te = $('#live-stream-message'); if (te) te.remove();
            if (e.name === 'AbortError') showToast('Прервано', 'info'); else showToast('Ошибка: ' + e.message, 'error');
        } finally {
            waiting = false; if (sb) sb.disabled = true;
            if (ty) { fadeOutTyping(ty); ty.querySelector('.typing-text').textContent = 'AI Печатает'; }
            abortCtrl = null; stopSpeedTracking();
            finalizeStreamUsage(usage);
            attachMessageHandlers();
        }
    }

    function renderMessages() {
        if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; }
        if (mdRenderRafId) { cancelAnimationFrame(mdRenderRafId); mdRenderRafId = null; }
        mdRenderPending = false;
        const chat = getChat(), c = $('#chatMessages'); if (!chat || !c) return;
        c.innerHTML = '';
        const agentIds = new Set();
        chat.messages.forEach(m => { if (m.role === 'assistant' && m.agent_id) agentIds.add(m.agent_id); });
        const wasCompare = agentIds.size > 1;
        if (wasCompare) { c.classList.add('compare-mode'); renderCompareMode(chat, c); }
        else { c.classList.remove('compare-mode'); renderNormalMode(chat, c); }
        attachMessageHandlers();
        if (typeof hljs !== 'undefined') try { $$('pre code').forEach(b => { if (!b.dataset.hl) { hljs.highlightElement(b); b.dataset.hl = '1'; } }); } catch { }
        if (!noAutoScroll) {
            if (chat._scrollPos !== undefined) { setTimeout(() => { c.scrollTop = chat._scrollPos; }, 0); }
            else { setTimeout(() => c.scrollTop = c.scrollHeight, 50); }
        }
        noAutoScroll = false;
        estimateCurrentContext();
    }

    function renderNormalMode(chat, con) {
        if (!chat.messages.length) { con.innerHTML = '<div style="text-align:center;color:#6e6e73;margin-top:80px;"><div style="font-size:60px;margin-bottom:16px;">💬</div><div style="font-size:18px;font-weight:500;">Начните диалог</div></div>'; return; }
        chat.messages.forEach((m, i) => appendMessage(con, m, i));
    }

    function renderCompareMode(chat, con) {
        if (!chat.messages.length) { con.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#6e6e73;margin-top:80px;"><div style="font-size:60px;margin-bottom:16px;">⚖️</div><div style="font-size:18px;font-weight:500;">Режим сравнения</div></div>'; return; }
        chat.messages.forEach((m, i) => { if (m.role === 'user') appendMessage(con, m, i); });
        const ar = {};
        chat.messages.forEach((m, i) => { if (m.role === 'assistant' && m.agent_id) { if (!ar[m.agent_id]) ar[m.agent_id] = []; ar[m.agent_id].push({ msg: m, idx: i }); } });
        Object.keys(ar).forEach(aid => {
            const msgs = ar[aid]; if (!msgs || !msgs.length) return;
            const ag = assistants.find(a => a.id === aid) || agents.find(a => a.id === aid);
            const an = ag ? ag.name : 'Unknown';
            const agAv = ag?.avatar || assistantSettings.avatar;
            const agType = assistants.some(a => a.id === aid) ? 'assistant' : 'agent';
            const ah = agAv
                ? `<div class="avatar-wrapper" data-agent-profile="${aid}" data-agent-type="${agType}" style="cursor:pointer"><img src="${agAv}" class="avatar-img"></div>`
                : `<div class="avatar-wrapper" data-agent-profile="${aid}" data-agent-type="${agType}" style="cursor:pointer"><div class="avatar-placeholder"><i class="fas fa-robot"></i></div></div>`;
            const col = document.createElement('div'); col.className = 'compare-column'; col.dataset.agentId = aid;
            let cc = `<div class="compare-column-header">${ah}<span>${escapeHtml(an)}</span></div>`;
            msgs.forEach(({ msg, idx }) => {
                const met = buildMetricsHtml(msg.metrics);
                const ct = typeof msg.content === 'string' ? parseMarkdown(msg.content, false) : parseMarkdown(msg.content || '', false);
                const act = `<div class="message-actions"><button class="copy-msg" data-idx="${idx}"><i class="fas fa-copy"></i></button><button class="del-assistant" data-idx="${idx}"><i class="fas fa-trash"></i></button></div>`;
                cc += `<div class="message-group message-group-assistant"><div class="message-wrapper" style="max-width:100%"><div class="message-assistant"><div class="message-content">${ct}</div>${met}</div>${act}</div></div>`;
            });
            col.innerHTML = cc; con.appendChild(col);
        });
        $$('[data-agent-profile]', con).forEach(el => {
            el.onclick = e => { e.stopPropagation(); openAgentProfile(el.dataset.agentType, el.dataset.agentProfile); };
        });
    }

    function appendMessage(con, m, idx) {
        const iu = m.role === 'user';
        let av, displayName, profileType, agentId, agentType;
        if (iu) {
            av = userSettings.avatar;
            displayName = userSettings.name;
            profileType = 'user';
        } else {
            const agent = m.agent_id ? (assistants.find(a => a.id === m.agent_id) || agents.find(a => a.id === m.agent_id)) : null;
            av = agent?.avatar || assistantSettings.avatar;
            displayName = agent?.name || assistantSettings.name;
            profileType = 'assistant';
            agentId = m.agent_id || null;
            agentType = agentId ? findAgentType(agentId) : null;
        }
        const agentAttrs = (!iu && agentId && agentType) ? ` data-agent-id="${agentId}" data-agent-type="${agentType}"` : ((!iu && agentId) ? ` data-agent-id="${agentId}"` : '');
        const ah = av ? `<img src="${av}" class="avatar-img" data-profile="${profileType}"${agentAttrs} loading="lazy">` : `<div class="avatar-placeholder" data-profile="${profileType}"${agentAttrs}><i class="fas ${iu ? 'fa-user' : 'fa-robot'}"></i></div>`;
        let met = '';
        if (!iu && m.metrics) { met = buildMetricsHtml(m.metrics); }
        let contentHtml = '';
        const rawContent = m.content;
        if (Array.isArray(rawContent)) {
            rawContent.forEach(part => {
                if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                    contentHtml += `<div class="chat-image-wrapper"><img src="${part.image_url.url}" class="chat-image" loading="lazy" onclick="window.open(this.src,'_blank')"></div>`;
                } else if (part.type === 'text' && part.text) {
                    contentHtml += parseMarkdown(part.text, false);
                }
            });
        } else if (typeof rawContent === 'string') {
            if (m.images && m.images.length > 0) {
                m.images.forEach(img => { contentHtml += `<div class="chat-image-wrapper"><img src="${img}" class="chat-image" loading="lazy" onclick="window.open(this.src,'_blank')"></div>`; });
            }
            contentHtml += iu ? escapeHtml(rawContent).replace(/\n/g, '<br>') : parseMarkdown(rawContent, false);
        }
        const act = iu
            ? `<div class="message-actions message-actions-user"><button class="copy-msg" data-idx="${idx}"><i class="fas fa-copy"></i></button><button class="edit-msg" data-idx="${idx}"><i class="fas fa-pen"></i></button><button class="regen-msg" data-idx="${idx}"><i class="fas fa-redo"></i></button><button class="del-user" data-idx="${idx}"><i class="fas fa-trash"></i></button></div>`
            : `<div class="message-actions"><button class="copy-msg" data-idx="${idx}"><i class="fas fa-copy"></i></button><button class="del-assistant" data-idx="${idx}"><i class="fas fa-trash"></i></button></div>`;
        const nameAttrs = (!iu && agentId && agentType) ? ` data-agent-id="${agentId}" data-agent-type="${agentType}"` : ((!iu && agentId) ? ` data-agent-id="${agentId}"` : '');
        const div = document.createElement('div'); div.className = `message-group message-group-${iu ? 'user' : 'assistant'}`;
        if (iu) div.innerHTML = `<div class="message-wrapper" style="text-align:right;"><div style="margin-bottom:4px;"><span class="cursor-pointer name-badge" data-profile="user">${escapeHtml(displayName)}</span></div><div class="user-text-block message-content" style="display:inline-block;text-align:left;">${contentHtml}</div>${act}</div><div class="avatar-wrapper" data-profile="user">${ah}</div>`;
        else div.innerHTML = `<div class="avatar-wrapper" data-profile="assistant">${ah}</div><div class="message-wrapper"><div style="margin-bottom:4px;"><span class="cursor-pointer name-badge" data-profile="assistant"${nameAttrs}>${escapeHtml(displayName)}</span></div><div class="message-assistant"><div class="message-content">${contentHtml}</div>${met}</div>${act}</div>`;
        con.appendChild(div);
    }

    function attachMessageHandlers() {
        $$('.copy-msg').forEach(b => b.onclick = e => { e.stopPropagation(); const c = getChat(), m = c.messages[parseInt(b.dataset.idx)]; if (m) { const txt = typeof m.content === 'string' ? m.content : (m.content || ''); navigator.clipboard.writeText(txt); showToast('Скопировано', 'success', 1200); } });
        $$('.del-assistant').forEach(b => b.onclick = e => { e.stopPropagation(); const c = getChat(); c.messages.splice(parseInt(b.dataset.idx), 1); markDirty('chatList'); renderMessages(); saveStorage(); });
        $$('.edit-msg').forEach(b => b.onclick = e => { e.stopPropagation(); const w = b.closest('.message-group')?.querySelector('.user-text-block'); if (w) startEditMsg(currentChatId, parseInt(b.dataset.idx), w); });
        $$('.regen-msg').forEach(b => b.onclick = e => { e.stopPropagation(); regenResponse(currentChatId, parseInt(b.dataset.idx)); });
        $$('.del-user').forEach(b => b.onclick = e => { e.stopPropagation(); const c = getChat(); c.messages = c.messages.slice(0, parseInt(b.dataset.idx)); markDirty('chatList'); renderMessages(); saveStorage(); });
    }

    // Event delegation для аватарок и name-badge — привязывается один раз
    let avatarDelegationBound = false;
    function bindAvatarDelegation() {
        if (avatarDelegationBound) return;
        avatarDelegationBound = true;
        const c = $('#chatMessages');
        if (!c) return;
        c.addEventListener('click', e => {
            // Аватарки
            const av = e.target.closest('.avatar-img, .avatar-placeholder');
            if (av) {
                e.stopPropagation();
                let aid = av.dataset.agentId || av.closest('[data-agent-profile]')?.dataset.agentProfile;
                let atype = av.dataset.agentType || av.closest('[data-agent-profile]')?.dataset.agentType;
                if (aid && !atype) atype = findAgentType(aid);
                if (aid && atype) { openAgentProfile(atype, aid); }
                else { const p = av.dataset.profile || av.closest('[data-profile]')?.dataset.profile; if (p) openProfile(p); }
                return;
            }
            // Имена агентов/ассистентов
            const nb = e.target.closest('.name-badge');
            if (nb) {
                e.stopPropagation();
                let aid = nb.dataset.agentId;
                let atype = nb.dataset.agentType;
                if (aid && !atype) atype = findAgentType(aid);
                if (aid && atype) { openAgentProfile(atype, aid); }
                else { openProfile(nb.dataset.profile); }
            }
        });
    }

    function startEditMsg(cid, idx, el) {
        const chat = chatList.find(c => c.id === cid), msg = chat?.messages[idx]; if (!msg || msg.role !== 'user') return;
        const orig = typeof msg.content === 'string' ? msg.content : '';
        const ta = document.createElement('textarea'); ta.value = orig; ta.className = 'inline-textarea'; ta.style.minHeight = '80px'; if (isMobile) ta.style.fontSize = '16px';
        const btnWrap = document.createElement('div'); btnWrap.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
        const sendBtn = document.createElement('button'); sendBtn.textContent = 'Отправить'; sendBtn.className = 'btn-apple px-4 py-1.5 rounded-lg text-xs';
        const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Отмена'; cancelBtn.className = 'btn-secondary px-4 py-1.5 rounded-lg text-xs';
        btnWrap.appendChild(sendBtn); btnWrap.appendChild(cancelBtn);
        el.innerHTML = ''; el.appendChild(ta); el.appendChild(btnWrap); ta.focus(); ta.select();
        let saved = false;
        const save = () => { if (saved) return; saved = true; const n = ta.value.trim(); if (n && n !== orig) { chat.messages[idx].content = n; chat.messages = chat.messages.slice(0, idx + 1); markDirty('chatList'); saveStorage(); noAutoScroll = true; regenResponse(cid, idx); } else { el.innerText = orig; renderMessages(); } };
        const cancel = () => { saved = true; noAutoScroll = true; el.innerText = orig; renderMessages(); };
        sendBtn.addEventListener('click', (e) => { e.stopPropagation(); save(); });
        cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
        ta.addEventListener('blur', save);
        ta.addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
    }

    async function regenResponse(cid, idx) {
        const chat = chatList.find(c => c.id === cid); if (!chat) return;
        chat.messages = chat.messages.slice(0, idx + 1);
        markDirty('chatList'); renderMessages(); saveStorage();
        const lastUserMsg = chat.messages[idx];
        let text = '';
        pendingImages = [];
        if (typeof lastUserMsg.content === 'string') {
            text = lastUserMsg.content;
            if (lastUserMsg.images && lastUserMsg.images.length) {
                pendingImages = [...lastUserMsg.images];
            }
        } else if (Array.isArray(lastUserMsg.content)) {
            const textParts = lastUserMsg.content.filter(p => p.type === 'text').map(p => p.text);
            text = textParts.join('\n');
            const imgParts = lastUserMsg.content.filter(p => p.type === 'image_url' && p.image_url && p.image_url.url);
            if (imgParts.length) pendingImages = imgParts.map(p => p.image_url.url);
        }
        updateVisionPreview();
        await sendMessage(text || ' ', true);
    }

    // ========== WEBSOCKET STREAMING HELPER ==========
    async function streamSSE(body, onToken, onDone, signal) {
        const resp = await fetch('/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: signal
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let doneCalled = false;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                if (!doneCalled) { onDone(null); doneCalled = true; }
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (const line of parts) {
                if (!line.startsWith('data: ')) continue;
                const d = line.slice(6).trim();
                if (d === '[DONE]') { if (!doneCalled) { onDone(null); doneCalled = true; } continue; }
                try {
                    const j = JSON.parse(d);
                    if (j.content) onToken(j.content);
                    if (j.usage) { onDone(j.usage); doneCalled = true; }
                } catch(e) { }
            }
        }
        reader.releaseLock();
    }

    // ========== SEND MESSAGE (FIXED: LIVE CONTEXT + SPEED) ==========
    async function sendMessage(text, skipAdd = false) {
        if (waiting || (!text && !pendingImages.length)) return;
        userScrolledUp = false;
        let chat = getChat(); if (!chat) return;
        
        const imgs = [...pendingImages];
        pendingImages = []; 
        updateVisionPreview();

        if (!skipAdd) {
            if (imgs.length > 0) {
                const contentParts = [];
                imgs.forEach(b64 => contentParts.push({ type: 'image_url', image_url: { url: b64 } }));
                if (text) contentParts.push({ type: 'text', text: text });
                chat.messages.push({ role: 'user', content: contentParts, images: imgs });
            } else {
                chat.messages.push({ role: 'user', content: text });
            }
        markDirty('chatList'); renderMessages(); saveStorage();
            if (chat.name === 'Новый чат' || chat.name === '') { 
                chat.name = (text || 'Изображение').replace(/[*_`#]/g, '').trim().slice(0, 30) || 'Диалог'; 
                markDirty('chatList'); renderChatList(); saveStorage(); 
            }
        }

        // Сворачиваем поле ввода
        const input = $('#userInput');
        if (input) { input.value = ''; input.style.height = 'auto'; }

            let eff = [...getSelectedIds()];
        const useDefaultProfile = !eff.length;

        waiting = true;
        const sb = $('#stopBtn'), ty = $('#typingIndicatorContainer');
        if (sb) sb.disabled = false; 
        if (ty) { ty.classList.remove('hidden'); ty.classList.remove('fade-out'); ty.classList.add('fade-in'); }
        
        if (input) { input.disabled = true; input.style.opacity = '0.5'; }

        abortCtrl = new AbortController();
        const history = chat.messages.map(m => ({ role: m.role, content: m.content }));
        
        const c = $('#chatMessages');
        const thinkEnabled = $('#thinkModeToggle')?.checked ?? false;
        let usg = null;

        try {
            const isCompare = eff.length > 1;

            if (isCompare) {
                c.classList.add('compare-mode');
                const userMsgs = chat.messages.filter(m => m.role === 'user');
                if (!c.querySelector('.message-group-user')) {
                    userMsgs.forEach((m, i) => appendMessage(c, m, chat.messages.indexOf(m)));
                }
                for (const agentId of eff) {
                    const col = document.createElement('div');
                    col.className = 'compare-column';
                    col.dataset.agentId = agentId;
                    col.id = 'compare-col-' + agentId;
                    const ag = assistants.find(a => a.id === agentId) || agents.find(a => a.id === agentId);
                    const agName = ag ? ag.name : 'Unknown';
                    const agAvatar = ag?.avatar || assistantSettings.avatar;
                    const ah = agAvatar ? `<img src="${agAvatar}" class="avatar-img">` : '<div class="avatar-placeholder"><i class="fas fa-robot"></i></div>';
                    col.innerHTML = `<div class="compare-column-header">${ah}<span>${escapeHtml(agName)}</span></div><div class="compare-stream-area" id="stream-area-${agentId}"></div>`;
                    c.appendChild(col);
                }
            }

            const agentList = useDefaultProfile
                ? [{ id: '__mdllm__', name: assistantSettings.name, prompt: '', temp: modelGenParams.temperature, avatar: assistantSettings.avatar }]
                : eff.map(aid => {
                    const found = assistants.find(a => a.id === aid) || agents.find(a => a.id === aid);
                    return found || null;
                }).filter(Boolean);

            if (!agentList.length) { showToast('Нет ассистентов', 'warning'); waiting = false; if (sb) sb.disabled = true; if (input) { input.disabled = false; input.style.opacity = '1'; } fadeOutTyping(ty); return; }

            let historyTokens = 0;
            history.forEach(m => {
                const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                historyTokens += Math.ceil(txt.length / 4);
            });

            if (isCompare) {
                const agentPromises = agentList.map(item => {
                    const agentId = item.id;
                    const dn = item.name || assistantSettings.name;
                    const av = item.avatar || assistantSettings.avatar;
                    const agentType = findAgentType(agentId);
                    const agentAttrs = agentType ? ` data-agent-id="${agentId}" data-agent-type="${agentType}"` : '';
                    const ah = av ? `<img src="${av}" class="avatar-img" data-profile="assistant"${agentAttrs}>` : `<div class="avatar-placeholder" data-profile="assistant"${agentAttrs}><i class="fas fa-robot"></i></div>`;

                    const td = document.createElement('div');
                    td.className = 'message-group message-group-assistant';
                    td.id = 'live-stream-message-' + agentId;
                    td.innerHTML = `
                        <div class="avatar-wrapper">${ah}</div>
                        <div class="message-wrapper">
                            <div class="message-assistant">
                                <div class="message-content" id="live-stream-content-${agentId}"></div>
                            </div>
                        </div>`;

                    const area = $('#stream-area-' + agentId);
                    if (area) area.appendChild(td);

                    const ce = document.getElementById('live-stream-content-' + agentId);
                    const body = buildStreamBody(item, history, imgs, thinkEnabled);

                    let ans = '';
                    let usage = null;

                    return streamSSE(body, (token) => {
                        ans += token;
                        streamingAnswerText = ans;
                        streamingHistoryTokens = historyTokens;
                        if (ce) scheduleMarkdownRender(ce, ans, true);
                        if (!userScrolledUp && !noAutoScroll && c.scrollHeight - c.scrollTop - c.clientHeight < 150) c.scrollTop = c.scrollHeight;
                    }, (u) => { if (u) usage = u; }, abortCtrl.signal).then(() => {
                        td.id = '';
                        if (ans.trim()) {
                            const msg = { role: 'assistant', content: ans.trim() };
                            if (!useDefaultProfile && agentId !== '__mdllm__') msg.agent_id = agentId;
                            if (usage) msg.metrics = usage;
                            chat.messages.push(msg);
                            const msgIdx = chat.messages.length - 1;
                            const metHtml = buildMetricsHtml(usage);
                            const actHtml = `<div class="message-actions"><button class="copy-msg" data-idx="${msgIdx}"><i class="fas fa-copy"></i></button><button class="del-assistant" data-idx="${msgIdx}"><i class="fas fa-trash"></i></button></div>`;
                            const mw = td.querySelector('.message-wrapper');
                            if (mw) {
                                const mc = mw.querySelector('.message-content');
                                if (mc) mc.innerHTML = parseMarkdown(ans.trim(), false);
                                const ma = mw.querySelector('.message-assistant');
                                if (ma) { const old = ma.querySelector('.message-content'); if (old) old.id = ''; ma.insertAdjacentHTML('beforeend', metHtml); }
                                mw.insertAdjacentHTML('beforeend', actHtml);
                            }
                            td.style.animation = 'fadeInUp 0.3s ease-out';
                            $$('.copy-msg', td).forEach(b => b.onclick = e => { e.stopPropagation(); navigator.clipboard.writeText(ans.trim()); showToast('Скопировано', 'success', 1200); });
                            $$('.del-assistant', td).forEach(b => b.onclick = e => { e.stopPropagation(); chat.messages.splice(parseInt(b.dataset.idx), 1); markDirty('chatList'); renderMessages(); saveStorage(); });
                        }
                        return { agentId, ans, usage };
                    }).catch(e => {
                        td.id = '';
                        if (e.name !== 'AbortError') showToast(`${dn}: ${e.message}`, 'error');
                        return { agentId, ans: '', usage: null };
                    });
                });

                startSpeedTracking(historyTokens);
                await Promise.all(agentPromises);

            } else {
                for (const item of agentList) {
                    if (abortCtrl?.signal?.aborted) break;

                    const agentId = item.id;

                    const dn = item.name || assistantSettings.name;
                    const av = item.avatar || assistantSettings.avatar;
                    const agentType = findAgentType(agentId);
                    const agentAttrs = agentType ? ` data-agent-id="${agentId}" data-agent-type="${agentType}"` : '';
                    const ah = av ? `<img src="${av}" class="avatar-img" data-profile="assistant"${agentAttrs}>` : `<div class="avatar-placeholder" data-profile="assistant"${agentAttrs}><i class="fas fa-robot"></i></div>`;

                    const td = document.createElement('div'); 
                    td.className = 'message-group message-group-assistant';
                    td.id = 'live-stream-message-' + agentId;
                    
                    const nameHtml = `<div style="margin-bottom:4px;"><span class="name-badge"${agentAttrs}>${escapeHtml(dn)}</span></div>`;
                    td.innerHTML = `
                        <div class="avatar-wrapper">${ah}</div>
                        <div class="message-wrapper">
                            ${nameHtml}
                            <div class="message-assistant">
                                <div class="message-content" id="live-stream-content-${agentId}"></div>
                            </div>
                        </div>`;
                    
                    c.appendChild(td);
                    if (!noAutoScroll) setTimeout(() => c.scrollTop = c.scrollHeight, 50);

                    const ce = document.getElementById('live-stream-content-' + agentId); 
                    let ans = '';
                    usg = null;
                    
                    const body = buildStreamBody(item, history, imgs, thinkEnabled);

                    startSpeedTracking(historyTokens);

                    await streamSSE(body, (token) => {
                        ans += token;
                        streamingAnswerText = ans;
                        if (ce) scheduleMarkdownRender(ce, ans, true);
                        if (!userScrolledUp && !noAutoScroll && c.scrollHeight - c.scrollTop - c.clientHeight < 150) c.scrollTop = c.scrollHeight;
                    }, (usage) => { if (usage) usg = usage; }, abortCtrl.signal);

                    td.id = '';
                    if (ans.trim()) {
                        const msg = { role: 'assistant', content: ans.trim() };
                        if (!useDefaultProfile && agentId !== '__mdllm__') msg.agent_id = agentId;
                        if (usg) msg.metrics = usg;
                        chat.messages.push(msg);
                        const msgIdx = chat.messages.length - 1;
                        const metHtml = buildMetricsHtml(usg);
                        const actHtml = `<div class="message-actions"><button class="copy-msg" data-idx="${msgIdx}"><i class="fas fa-copy"></i></button><button class="del-assistant" data-idx="${msgIdx}"><i class="fas fa-trash"></i></button></div>`;
                        const mw = td.querySelector('.message-wrapper');
                        if (mw) {
                            const mc = mw.querySelector('.message-content');
                            if (mc) mc.innerHTML = parseMarkdown(ans.trim(), false);
                            const ma = mw.querySelector('.message-assistant');
                            if (ma) { const old = ma.querySelector('.message-content'); if (old) old.id = ''; ma.insertAdjacentHTML('beforeend', metHtml); }
                            mw.insertAdjacentHTML('beforeend', actHtml);
                        }
                        td.style.animation = 'fadeInUp 0.3s ease-out';
                        $$('.copy-msg', td).forEach(b => b.onclick = e => { e.stopPropagation(); navigator.clipboard.writeText(ans.trim()); showToast('Скопировано', 'success', 1200); });
                        $$('.del-assistant', td).forEach(b => b.onclick = e => { e.stopPropagation(); chat.messages.splice(parseInt(b.dataset.idx), 1); markDirty('chatList'); renderMessages(); saveStorage(); });
                    }
                }
            }
            markDirty('chatList'); saveStorage();
            moveChatToTop(currentChatId);
            generateChatName(chat);
            if (typeof hljs !== 'undefined') {
                const codeBlocks = $$('#chatMessages pre code:not([data-hl])');
                let idx = 0;
                const batchSize = 5;
                function highlightBatch() {
                    const end = Math.min(idx + batchSize, codeBlocks.length);
                    for (let i = idx; i < end; i++) {
                        try { hljs.highlightElement(codeBlocks[i]); } catch(e) {}
                        codeBlocks[i].dataset.hl = '1';
                    }
                    idx = end;
                    if (idx < codeBlocks.length) setTimeout(highlightBatch, 0);
                }
                if (codeBlocks.length) setTimeout(highlightBatch, 0);
            }
            if (chat.messages.length > 0) {
                const lastMsg = chat.messages[chat.messages.length - 1];
                if (lastMsg.role === 'assistant' && !isLikelyComplete(lastMsg.content)) {
                    showContinueButton(chat.messages.length - 1);
                }
            }
            attachMessageHandlers();
        } catch (e) {
            $$('.message-group', c).forEach(el => { if (el.id && el.id.startsWith('live-stream-message-')) el.remove(); });
            if (e.name === 'AbortError') showToast('Прервано', 'info'); 
            else showToast('Ошибка: ' + e.message, 'error');
        } finally {
            waiting = false; 
            if (sb) sb.disabled = true;
            if (input) { 
                input.disabled = false; 
                input.style.opacity = '1'; 
                input.style.height = 'auto'; 
                input.focus(); 
            }
            if (ty) { fadeOutTyping(ty); ty.querySelector('.typing-text').textContent = 'AI Печатает'; }
            abortCtrl = null; 
            stopSpeedTracking();
            attachMessageHandlers();
            finalizeStreamUsage(usg);
        }
    }

    // ========== ASSISTANTS DRAG & DROP ==========
    function updateActiveDisplay() {
        const ids = getSelectedIds();
        const names = ids.map(id => { const a = assistants.find(x => x.id === id) || agents.find(x => x.id === id); return a?.name; }).filter(Boolean);
        const el = $('#activeAssistantName'); if (el) el.innerText = names.length ? (names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`) : assistantSettings.name;
        const b = $('#selectedCountBadge'); if (b) b.innerText = '';
    }

    let saveStorageTimer = null;
    function scheduleSave() {
        if (saveStorageTimer) clearTimeout(saveStorageTimer);
        saveStorageTimer = setTimeout(() => { saveStorageTimer = null; saveStorage(); }, 300);
    }

    function reorderDropdownItems() {
        $$('.assistants-column').forEach(col => {
            const items = Array.from(col.querySelectorAll('.assistant-item'));
            items.sort((a, b) => {
                const aToggle = a.querySelector('.toggle-switch input');
                const bToggle = b.querySelector('.toggle-switch input');
                const aOn = aToggle ? aToggle.checked : false;
                const bOn = bToggle ? bToggle.checked : false;
                return (aOn === bOn) ? 0 : aOn ? -1 : 1;
            });
            items.forEach(item => col.appendChild(item));
        });
    }

    function toggleSelect(id) {
        let ids = getSelectedIds();
        if (ids.includes(id)) ids = ids.filter(i => i !== id);
        else { if (ids.length >= 10) { showToast('Макс. 10', 'warning'); return; } ids.push(id); }
        setSelectedIds(ids);
        markDirty('chatList', 'selectedIds');
        updateActiveDisplay();
        reorderDropdownItems();
        updateDeselectButtons();
        scheduleSave();
    }

    function updateDeselectButtons() {
        const hasSelAgents = agents.some(a => getSelectedIds().includes(a.id));
        const hasSelAssistants = assistants.some(a => getSelectedIds().includes(a.id));
        const dd = $('#assistantsAgentsDropdown');
        if (!dd) return;
        dd.querySelectorAll('.deselect-all-btn').forEach(b => {
            const type = b.dataset.type;
            const disabled = type === 'agent' ? !hasSelAgents : !hasSelAssistants;
            b.disabled = disabled;
        });
    }

    let draggedItem = null;
    function handleDragStart(e) { draggedItem = this; e.dataTransfer.effectAllowed = 'move'; this.classList.add('dragging'); }
    function handleDragOver(e) { if (e.preventDefault) e.preventDefault(); return false; }
    function handleDragEnter(e) { this.classList.add('bg-[#3a3a3c]'); }
    function handleDragLeave(e) { this.classList.remove('bg-[#3a3a3c]'); }
    function handleDrop(e) {
        if (e.stopPropagation) e.stopPropagation();
        if (draggedItem !== this) {
            const list = this.parentNode;
            const allItems = Array.from(list.children);
            const fromIndex = allItems.indexOf(draggedItem);
            const toIndex = allItems.indexOf(this);
            if (fromIndex < toIndex) this.after(draggedItem); else this.before(draggedItem);
            updateAgentOrderFromDOM();
        }
        this.classList.remove('bg-[#3a3a3c]');
        draggedItem.classList.remove('dragging');
        return false;
    }
    function handleDragEnd(e) { this.classList.remove('dragging'); $$('.assistant-item').forEach(item => item.classList.remove('bg-[#3a3a3c]')); }

    function updateAgentOrderFromDOM() {
        const cols = $$('.assistants-column');
        if (cols.length < 2) return;
        const agentCol = cols[0]; const assistantCol = cols[1];
        const newAgents = []; const newAssistants = [];
        $$('.agent-toggle', agentCol).forEach(toggle => { const id = toggle.dataset.id; const item = agents.find(a => a.id === id); if (item) newAgents.push(item); });
        $$('.assistant-toggle', assistantCol).forEach(toggle => { const id = toggle.dataset.id; const item = assistants.find(a => a.id === id); if (item) newAssistants.push(item); });
        agents = newAgents; assistants = newAssistants;
        scheduleSave();
    }

    function renderAssistantsDropdown() {
        const c = $('#assistantsAgentsDropdown'); if (!c) return;
        const ri = (items, type) => {
            const sorted = [...items].sort((a, b) => {
                const aSel = getSelectedIds().includes(a.id) ? 0 : 1;
                const bSel = getSelectedIds().includes(b.id) ? 0 : 1;
                return aSel - bSel;
            });
            return sorted.map(a => {
            const sel = getSelectedIds().includes(a.id);
            const av = a.avatar;
            const avHtml = av
                ? `<div class="assistant-mini-avatar" data-type="${type}" data-id="${a.id}"><img src="${av}" alt=""></div>`
                : `<div class="assistant-mini-avatar" data-type="${type}" data-id="${a.id}"><i class="fas ${type === 'assistant' ? 'fa-robot' : 'fa-bolt'} mini-avatar-icon"></i></div>`;
            return `<div class="assistant-item" draggable="true">${avHtml}<div class="assistant-toggle-wrapper"><label class="toggle-switch"><input type="checkbox" class="${type}-toggle" data-id="${a.id}" ${sel ? 'checked' : ''}><span class="toggle-slider"></span></label><span class="truncate">${escapeHtml(a.name)}</span></div><div class="assistant-item-actions"><button class="edit-assistant" data-type="${type}" data-id="${a.id}"><i class="fas fa-pen"></i></button><button class="delete-assistant" data-type="${type}" data-id="${a.id}"><i class="fas fa-trash"></i></button></div></div>`;
        }).join('');
        };
        const hasSelAgents = agents.some(a => getSelectedIds().includes(a.id));
        const hasSelAssistants = assistants.some(a => getSelectedIds().includes(a.id));
        c.innerHTML = `<div class="assistants-columns"><div class="assistants-column"><div class="assistants-column-header"><div class="assistants-header-icon"><div class="assistants-icon-circle"><svg class="w-4 h-4"><use href="#icon-users"></use></svg></div></div><div class="assistants-header-title"><span data-i18n="agents.agents">${window.i18n?.t('agents.agents') || 'Агенты'}</span></div><div class="assistants-header-actions"><button class="deselect-all-btn" data-type="agent" title="${window.i18n?.t('settings.all') || 'Отключить всех'}" ${!hasSelAgents ? 'disabled' : ''}><i class="fas fa-times"></i></button><button id="newAgentBtn"><i class="fas fa-plus"></i></button></div></div>${ri(agents, 'agent') || `<div style="color:#6e6e73;font-size:12px;padding:8px;">${window.i18n?.t('agents.empty') || 'Пусто'}</div>`}</div><div class="assistants-column"><div class="assistants-column-header"><div class="assistants-header-icon"><div class="assistants-icon-circle"><svg class="w-4 h-4"><use href="#icon-person"></use></svg></div></div><div class="assistants-header-title"><span data-i18n="agents.assistants">${window.i18n?.t('agents.assistants') || 'Ассистенты'}</span></div><div class="assistants-header-actions"><button class="deselect-all-btn" data-type="assistant" title="${window.i18n?.t('settings.all') || 'Отключить всех'}" ${!hasSelAssistants ? 'disabled' : ''}><i class="fas fa-times"></i></button><button id="newAssistantBtn"><i class="fas fa-plus"></i></button></div></div>${ri(assistants, 'assistant') || `<div style="color:#6e6e73;font-size:12px;padding:8px;">${window.i18n?.t('agents.empty') || 'Пусто'}</div>`}</div></div>`;
        $$('.assistant-item', c).forEach(item => {
            item.addEventListener('dragstart', handleDragStart);
            item.addEventListener('dragover', handleDragOver);
            item.addEventListener('dragenter', handleDragEnter);
            item.addEventListener('dragleave', handleDragLeave);
            item.addEventListener('drop', handleDrop);
            item.addEventListener('dragend', handleDragEnd);
        });
        $$('.assistant-toggle,.agent-toggle', c).forEach(t => t.onclick = e => { e.stopPropagation(); toggleSelect(t.dataset.id); });
        $$('.edit-assistant', c).forEach(b => b.onclick = e => { e.stopPropagation(); const { type, id } = b.dataset; const item = type === 'assistant' ? assistants.find(x => x.id === id) : agents.find(x => x.id === id); if (item) openModal(type, id, item.name, item.prompt, item.temp); });
        $$('.deselect-all-btn', c).forEach(b => b.onclick = e => { e.stopPropagation(); const type = b.dataset.type; const items = type === 'agent' ? agents : assistants; const ids = getSelectedIds().filter(id => !items.some(a => a.id === id)); setSelectedIds(ids); markDirty('selectedIds'); renderAssistantsDropdown(); updateActiveDisplay(); saveStorage(); });
        $$('.delete-assistant', c).forEach(b => b.onclick = e => { e.stopPropagation(); const { type, id } = b.dataset; if (id === 'default') return; if (type === 'assistant') assistants = assistants.filter(a => a.id !== id); else agents = agents.filter(a => a.id !== id); const ids = getSelectedIds().filter(i => i !== id); setSelectedIds(ids); markDirty('assistants', 'agents', 'selectedIds'); renderAssistantsDropdown(); updateActiveDisplay(); saveStorage(); });
        $$('.assistant-mini-avatar', c).forEach(av => av.onclick = e => { e.stopPropagation(); openAgentProfile(av.dataset.type, av.dataset.id); });
        $('#newAssistantBtn')?.addEventListener('click', e => { e.stopPropagation(); openModal('assistant'); });
        $('#newAgentBtn')?.addEventListener('click', e => { e.stopPropagation(); openModal('agent'); });
        c.dataset.rendered = '1';
    }

    function openModal(type, id = null, name = '', prompt = '', temp = 0.7) {
        modalMode = type; modalId = id;
        const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
        const titleKey = id ? (type === 'assistant' ? 'modal.newAssistant' : 'modal.newAgent') : (type === 'assistant' ? 'modal.newAssistant' : 'modal.newAgent');
        const typeLabel = type === 'assistant' ? i18nT('agents.assistants') : i18nT('agents.agents');
        const t = $('#modalTitle'); if (t) t.innerHTML = `<div class="assistants-icon-circle" style="width:28px;height:28px;"><svg class="w-4 h-4" style="color:#ff453a;"><use href="#${type === 'assistant' ? 'icon-person' : 'icon-users'}"></use></svg></div><span class="text-gradient">${id ? i18nT('modal.newAssistant') : i18nT('modal.newAssistant')} ${typeLabel}</span>`;
        if ($('#modalName')) $('#modalName').value = name;
        if ($('#modalPrompt')) $('#modalPrompt').value = prompt;
        const ts = $('#modalTempSlider'), tv = $('#modalTempValue');
        if (ts) { ts.value = temp !== undefined ? temp : 0.7; if (tv) tv.textContent = parseFloat(ts.value).toFixed(2); ts.oninput = () => { if (tv) tv.textContent = parseFloat(ts.value).toFixed(2); }; }
        const m = $('#modalOverlay'); if (m) { m.classList.remove('hidden'); m.classList.add('flex', 'overlay-in'); const card = m.querySelector('.modal-apple'); if (card) { card.classList.remove('modal-close'); card.classList.add('modal-open'); } }
    }

    function openProfile(type) {
        const iu = type === 'user';
        const t = $('#profileModalTitle'); if (t) t.innerHTML = `<div class="assistants-icon-circle" style="width:28px;height:28px;"><svg class="w-4 h-4" style="color:#ff453a;"><use href="#${iu ? 'icon-person' : 'icon-person'}"></use></svg></div><span class="text-gradient">Профиль ${iu ? 'пользователя' : 'ассистента'}</span>`;
        if ($('#profileNameInput')) $('#profileNameInput').value = iu ? userSettings.name : assistantSettings.name;
        const av = iu ? userSettings.avatar : assistantSettings.avatar;
        const img = $('#profileAvatarImg'), ph = $('#profileAvatarPlaceholder');
        if (av && img && ph) { img.src = av; img.classList.remove('hidden'); ph.classList.add('hidden'); } else if (img && ph) { img.classList.add('hidden'); ph.classList.remove('hidden'); }
        const m = $('#profileModal'); if (m) { m.classList.remove('hidden'); m.classList.add('flex', 'overlay-in'); m.dataset.profileType = type; const card = m.querySelector('.modal-apple'); if (card) { card.classList.remove('modal-close'); card.classList.add('modal-open'); } }
    }

    function closeModal(id) { const m = $(id); if (m) { const card = m.querySelector('.modal-apple'); if (card) { card.classList.remove('modal-open'); card.classList.add('modal-close'); } m.classList.remove('overlay-in'); m.classList.add('overlay-out'); setTimeout(() => { m.classList.add('hidden'); m.classList.remove('flex', 'overlay-out'); if (card) card.classList.remove('modal-close'); }, 300); } }

    // ========== AGENT PROFILE MODAL ==========
    let agentProfileType = null, agentProfileId = null, agentProfileTempAvatar = null;

    function openAgentProfile(type, id) {
        const items = type === 'assistant' ? assistants : agents;
        const item = items.find(a => a.id === id);
        if (!item) return;
        agentProfileType = type; agentProfileId = id; agentProfileTempAvatar = null;
        const title = $('#agentProfileTitle');
        if (title) title.innerHTML = `<div class="assistants-icon-circle" style="width:28px;height:28px;"><svg class="w-4 h-4" style="color:#ff453a;"><use href="#${type === 'assistant' ? 'icon-person' : 'icon-users'}"></use></svg></div><span class="text-gradient">${escapeHtml(item.name)}</span>`;
        if ($('#agentNameInput')) $('#agentNameInput').value = item.name;
        const img = $('#agentAvatarImg'), ph = $('#agentAvatarPlaceholder');
        if (item.avatar && img && ph) { img.src = item.avatar; img.classList.remove('hidden'); ph.classList.add('hidden'); }
        else if (img && ph) { img.classList.add('hidden'); ph.classList.remove('hidden'); }
        const m = $('#agentProfileModal'); if (m) { m.classList.remove('hidden'); m.classList.add('flex', 'overlay-in'); const card = m.querySelector('.modal-apple'); if (card) { card.classList.remove('modal-close'); card.classList.add('modal-open'); } }
    }

    function initAgentProfileModal() {
        $('#agentAvatarPreview')?.addEventListener('click', () => $('#agentAvatarFileInput')?.click());
        $('#agentAvatarFileInput')?.addEventListener('change', async e => {
            const f = e.target.files[0]; if (!f) return;
            const cropped = await openCropModal(f);
            if (!cropped) return;
            const img = $('#agentAvatarImg'), ph = $('#agentAvatarPlaceholder');
            if (img && ph) { img.src = cropped; img.classList.remove('hidden'); ph.classList.add('hidden'); }
            agentProfileTempAvatar = cropped;
            e.target.value = '';
        });
        $('#agentRemoveAvatarBtn')?.addEventListener('click', () => {
            const img = $('#agentAvatarImg'), ph = $('#agentAvatarPlaceholder');
            if (img && ph) { img.classList.add('hidden'); ph.classList.remove('hidden'); }
            agentProfileTempAvatar = '';
        });
        $('#agentProfileConfirm')?.addEventListener('click', async () => {
            const n = $('#agentNameInput')?.value.trim();
            if (!n) { showToast('Введите имя', 'warning'); return; }
            const items = agentProfileType === 'assistant' ? assistants : agents;
            const item = items.find(a => a.id === agentProfileId);
            if (!item) return;
            item.name = n;
            if (agentProfileTempAvatar === '') item.avatar = null;
            else if (agentProfileTempAvatar) item.avatar = agentProfileTempAvatar;
            markDirty(agentProfileType === 'assistant' ? 'assistants' : 'agents');
            renderAssistantsDropdown();
            updateActiveDisplay();
            renderMessages();
            saveStorage();
            closeModal('#agentProfileModal');
            showToast('Профиль сохранён', 'success');
        });
    }

    async function exportData() {
        markDirty('chatList', 'assistants', 'agents', 'selectedIds', 'userSettings', 'assistantSettings', 'modelGenParams');
        await saveStorage();
        const data = {
            version: '2.0',
            exported_at: new Date().toISOString(),
            chatList, assistants, agents,
            userSettings, assistantSettings, modelGenParams,
            thinkMode: localStorage.getItem('thinkMode') === 'true'
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = 'md-llm-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click(); URL.revokeObjectURL(url);
        showToast('Экспорт выполнен', 'success');
    }

    function exportCurrentChat() {
        const chat = getChat();
        if (!chat) { showToast('Нет открытого чата', 'warning'); return; }
        const data = {
            version: '2.0',
            type: 'single_chat',
            exported_at: new Date().toISOString(),
            chat
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        const safeName = chat.name.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_').slice(0, 40);
        a.download = 'chat-' + safeName + '-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click(); URL.revokeObjectURL(url);
        showToast('Чат экспортирован', 'success');
    }

    async function importData(file) {
        const r = new FileReader();
        r.onload = async e => {
            try {
                const d = JSON.parse(e.target.result);
                if (d.type === 'single_chat' && d.chat) {
                    const existing = chatList.find(c => c.id === d.chat.id);
                    if (existing) {
                        existing.name = d.chat.name;
                        existing.messages = d.chat.messages;
                    } else {
                        chatList.unshift(d.chat);
                    }
                    currentChatId = d.chat.id;
                    markDirty('chatList');
                    renderChatList(); renderMessages(); updateActiveDisplay();
                    saveStorage();
                    showToast('Чат импортирован', 'success');
                    return;
                }
                if (d.chatList) chatList = d.chatList;
                if (d.assistants) assistants = d.assistants;
                if (d.agents) agents = d.agents;
                if (d.userSettings) userSettings = d.userSettings;
                if (d.assistantSettings) assistantSettings = d.assistantSettings;
                if (d.selectedIds) selectedIds = d.selectedIds;
                if (d.modelGenParams) Object.assign(modelGenParams, d.modelGenParams);
                if (d.thinkMode !== undefined) {
                    localStorage.setItem('thinkMode', d.thinkMode);
                    const t = $('#thinkModeToggle'); if (t) t.checked = d.thinkMode;
                }
                if (!chatList.length) chatList = [{ id: 'default', name: 'Новый чат', messages: [] }];
                currentChatId = chatList[0].id;
                markDirty('chatList', 'assistants', 'agents', 'selectedIds', 'userSettings', 'assistantSettings', 'modelGenParams');
                renderChatList(); renderMessages(); updateActiveDisplay();
                renderAssistantsDropdown(); forceSyncParams();
                saveStorage();
                showToast('Импорт выполнен', 'success');
            } catch { showToast('Ошибка импорта', 'error'); }
        };
        r.readAsText(file);
    }

    // ========== INITIALIZATION ==========
    async function init() {
        console.log("MD LLM Client Initializing...");
        await loadStorage();
        bindAvatarDelegation();

        // Core Buttons
        $('#sendBtn')?.addEventListener('click', () => { const i = $('#userInput'), t = i?.value.trim(); if ((t || pendingImages.length) && !waiting) { i.value = ''; sendMessage(t); } });
        $('#stopBtn')?.addEventListener('click', () => { if (abortCtrl) abortCtrl.abort(); waiting = false; });
        $('#newChatBtn')?.addEventListener('click', () => addChat());
        $('#scrollUpBtn')?.addEventListener('click', () => { const c = $('#chatMessages'); if (c) c.scrollTop = 0; });
        $('#scrollDownBtn')?.addEventListener('click', () => { const c = $('#chatMessages'); if (c) c.scrollTop = c.scrollHeight; });

        // Settings Menu
        try { chatWallpaper = localStorage.getItem('chatWallpaper') || ''; } catch(e) {}
        if (!chatWallpaper) { try { const r = await loadData('chatWallpaper', ''); if (r) chatWallpaper = r; } catch(e) {} }
        let chatColor = localStorage.getItem('chatColor') || '';
        let uiAccent = localStorage.getItem('uiAccent') || '';
        let btnAccent = localStorage.getItem('btnAccent') || '';
        let textGradient = localStorage.getItem('textGradient') || '';
        btnGlow = localStorage.getItem('btnGlow') || '';

        const chatPalette = [
            '#0f0f11','#1a1a2e','#16213e','#0f3460','#1b262c','#2d132c',
            '#1e1e2f','#1a1a2e','#2b2024','#2e1a1a','#1e2d1e','#1a2e2a',
            '#2e2a1a','#1a1e2e','#2a1a2e','#1e2a1a','#2a2e1a','#1a2e1e',
            '#2e1e2a','#1a2a2e','#2a1e1e','#1e1a2a','#2e2a2e','#1a1a1e',
            '#242432','#1c2c1c','#2c1c1c','#1c1c2c','#2c2c1c','#1c2c2c',
            '#121215','#1e1e28','#141420','#1a1a24','#0e0e16','#161622',
            '#1c1c26','#14141e','#1a1a22','#10101a','#181824','#12121c',
        ];
        const uiPalette = [
            { color: '#008080', border: 'rgba(0,128,128,0.4)', bg: '#0a1616', bg2: 'rgba(10,30,30,0.95)', bg3: 'rgba(15,40,40,0.6)', bg4: 'rgba(20,50,50,0.3)', panel: 'rgba(10,30,30,0.8)' },
            { color: '#6A5ACD', border: 'rgba(106,90,205,0.4)', bg: '#0e0c18', bg2: 'rgba(20,16,35,0.95)', bg3: 'rgba(28,22,48,0.6)', bg4: 'rgba(36,28,60,0.3)', panel: 'rgba(20,16,35,0.8)' },
            { color: '#8B0000', border: 'rgba(139,0,0,0.4)', bg: '#180a0a', bg2: 'rgba(30,12,12,0.95)', bg3: 'rgba(40,16,16,0.6)', bg4: 'rgba(50,20,20,0.3)', panel: 'rgba(30,12,12,0.8)' },
            { color: '#808000', border: 'rgba(128,128,0,0.4)', bg: '#141408', bg2: 'rgba(26,26,10,0.95)', bg3: 'rgba(36,36,14,0.6)', bg4: 'rgba(46,46,18,0.3)', panel: 'rgba(26,26,10,0.8)' },
            { color: '#228B22', border: 'rgba(34,139,34,0.4)', bg: '#0c160c', bg2: 'rgba(14,28,14,0.95)', bg3: 'rgba(18,38,18,0.6)', bg4: 'rgba(22,48,22,0.3)', panel: 'rgba(14,28,14,0.8)' },
            { color: '#B76E79', border: 'rgba(183,110,121,0.4)', bg: '#180e10', bg2: 'rgba(30,16,18,0.95)', bg3: 'rgba(40,20,24,0.6)', bg4: 'rgba(50,26,30,0.3)', panel: 'rgba(30,16,18,0.8)' },
            { color: '#0047AB', border: 'rgba(0,71,171,0.4)', bg: '#0a0e18', bg2: 'rgba(12,18,32,0.95)', bg3: 'rgba(16,24,42,0.6)', bg4: 'rgba(20,30,52,0.3)', panel: 'rgba(12,18,32,0.8)' },
            { color: '#C9A84C', border: 'rgba(201,168,76,0.4)', bg: '#161208', bg2: 'rgba(28,24,12,0.95)', bg3: 'rgba(38,32,16,0.6)', bg4: 'rgba(48,40,20,0.3)', panel: 'rgba(28,24,12,0.8)' },
            { color: '#006400', border: 'rgba(0,100,0,0.4)', bg: '#081408', bg2: 'rgba(12,24,12,0.95)', bg3: 'rgba(16,32,16,0.6)', bg4: 'rgba(20,40,20,0.3)', panel: 'rgba(12,24,12,0.8)' },
            { color: '#4B0082', border: 'rgba(75,0,130,0.4)', bg: '#10081a', bg2: 'rgba(18,10,30,0.95)', bg3: 'rgba(24,14,40,0.6)', bg4: 'rgba(30,18,50,0.3)', panel: 'rgba(18,10,30,0.8)' },
            { color: '#800020', border: 'rgba(128,0,32,0.4)', bg: '#1a0a0e', bg2: 'rgba(28,10,16,0.95)', bg3: 'rgba(36,14,22,0.6)', bg4: 'rgba(44,18,28,0.3)', panel: 'rgba(28,10,16,0.8)' },
            { color: '#FF6347', border: 'rgba(255,99,71,0.3)', bg: '#1e100e', bg2: 'rgba(32,18,14,0.95)', bg3: 'rgba(42,24,18,0.6)', bg4: 'rgba(52,30,22,0.3)', panel: 'rgba(32,18,14,0.8)' },
            { color: '#4682B4', border: 'rgba(70,130,180,0.3)', bg: '#0e1418', bg2: 'rgba(16,22,28,0.95)', bg3: 'rgba(20,28,36,0.6)', bg4: 'rgba(24,34,44,0.3)', panel: 'rgba(16,22,28,0.8)' },
            { color: '#2E8B57', border: 'rgba(46,139,87,0.3)', bg: '#0c1610', bg2: 'rgba(14,24,18,0.95)', bg3: 'rgba(18,32,22,0.6)', bg4: 'rgba(22,40,26,0.3)', panel: 'rgba(14,24,18,0.8)' },
            { color: '#DAA520', border: 'rgba(218,165,32,0.3)', bg: '#181408', bg2: 'rgba(26,22,10,0.95)', bg3: 'rgba(34,28,14,0.6)', bg4: 'rgba(42,34,18,0.3)', panel: 'rgba(26,22,10,0.8)' },
            { color: '#9932CC', border: 'rgba(153,50,204,0.3)', bg: '#140a1a', bg2: 'rgba(22,14,28,0.95)', bg3: 'rgba(28,18,36,0.6)', bg4: 'rgba(34,22,44,0.3)', panel: 'rgba(22,14,28,0.8)' },
            { color: '#DC143C', border: 'rgba(220,20,60,0.3)', bg: '#1e0a0e', bg2: 'rgba(32,12,16,0.95)', bg3: 'rgba(40,16,20,0.6)', bg4: 'rgba(48,20,24,0.3)', panel: 'rgba(32,12,16,0.8)' },
            { color: '#00CED1', border: 'rgba(0,206,209,0.3)', bg: '#0a1818', bg2: 'rgba(14,26,28,0.95)', bg3: 'rgba(18,34,36,0.6)', bg4: 'rgba(22,42,44,0.3)', panel: 'rgba(14,26,28,0.8)' },
            { color: '#FF8C00', border: 'rgba(255,140,0,0.3)', bg: '#1e1408', bg2: 'rgba(32,22,10,0.95)', bg3: 'rgba(42,28,14,0.6)', bg4: 'rgba(52,34,18,0.3)', panel: 'rgba(32,22,10,0.8)' },
            { color: '#556B2F', border: 'rgba(85,107,47,0.3)', bg: '#101408', bg2: 'rgba(18,22,10,0.95)', bg3: 'rgba(22,28,14,0.6)', bg4: 'rgba(26,34,18,0.3)', panel: 'rgba(18,22,10,0.8)' },
            { color: '#CD853F', border: 'rgba(205,133,63,0.3)', bg: '#181208', bg2: 'rgba(28,20,10,0.95)', bg3: 'rgba(36,26,14,0.6)', bg4: 'rgba(44,32,18,0.3)', panel: 'rgba(28,20,10,0.8)' },
            { color: '#708090', border: 'rgba(112,128,144,0.3)', bg: '#101214', bg2: 'rgba(18,20,22,0.95)', bg3: 'rgba(24,26,28,0.6)', bg4: 'rgba(30,32,34,0.3)', panel: 'rgba(18,20,22,0.8)' },
            { color: '#483D8B', border: 'rgba(72,61,139,0.3)', bg: '#0e0c18', bg2: 'rgba(16,14,28,0.95)', bg3: 'rgba(20,18,36,0.6)', bg4: 'rgba(24,22,44,0.3)', panel: 'rgba(16,14,28,0.8)' },
            { color: '#2F4F4F', border: 'rgba(47,79,79,0.3)', bg: '#0c1212', bg2: 'rgba(14,20,20,0.95)', bg3: 'rgba(18,26,26,0.6)', bg4: 'rgba(22,32,32,0.3)', panel: 'rgba(14,20,20,0.8)' },
            { color: '#8B4513', border: 'rgba(139,69,19,0.3)', bg: '#181008', bg2: 'rgba(28,18,10,0.95)', bg3: 'rgba(36,24,14,0.6)', bg4: 'rgba(44,30,18,0.3)', panel: 'rgba(28,18,10,0.8)' },
            { color: '#191970', border: 'rgba(25,25,112,0.3)', bg: '#0a0a18', bg2: 'rgba(14,14,28,0.95)', bg3: 'rgba(18,18,36,0.6)', bg4: 'rgba(22,22,44,0.3)', panel: 'rgba(14,14,28,0.8)' },
            { color: '#006D6F', border: 'rgba(0,109,111,0.3)', bg: '#0a1414', bg2: 'rgba(12,22,22,0.95)', bg3: 'rgba(16,28,28,0.6)', bg4: 'rgba(20,34,34,0.3)', panel: 'rgba(12,22,22,0.8)' },
            { color: '#8B0045', border: 'rgba(139,0,69,0.3)', bg: '#180a10', bg2: 'rgba(28,12,18,0.95)', bg3: 'rgba(36,16,22,0.6)', bg4: 'rgba(44,20,26,0.3)', panel: 'rgba(28,12,18,0.8)' },
            { color: '#36454F', border: 'rgba(54,69,79,0.3)', bg: '#0e1012', bg2: 'rgba(16,18,20,0.95)', bg3: 'rgba(20,22,26,0.6)', bg4: 'rgba(24,26,32,0.3)', panel: 'rgba(16,18,20,0.8)' },
            { color: '#BC8F8F', border: 'rgba(188,143,143,0.3)', bg: '#1a1210', bg2: 'rgba(28,20,18,0.95)', bg3: 'rgba(36,26,22,0.6)', bg4: 'rgba(44,32,26,0.3)', panel: 'rgba(28,20,18,0.8)' },
            { color: '#6B8E23', border: 'rgba(107,142,35,0.3)', bg: '#101808', bg2: 'rgba(18,26,10,0.95)', bg3: 'rgba(22,32,14,0.6)', bg4: 'rgba(26,38,18,0.3)', panel: 'rgba(18,26,10,0.8)' },
            { color: '#1a1a2e', border: 'rgba(26,26,46,0.4)', bg: '#0a0a14', bg2: 'rgba(14,14,28,0.95)', bg3: 'rgba(18,18,34,0.6)', bg4: 'rgba(22,22,40,0.3)', panel: 'rgba(14,14,28,0.8)' },
            { color: '#2d1b3d', border: 'rgba(45,27,61,0.4)', bg: '#100a18', bg2: 'rgba(18,14,30,0.95)', bg3: 'rgba(24,18,38,0.6)', bg4: 'rgba(30,22,46,0.3)', panel: 'rgba(18,14,30,0.8)' },
            { color: '#1b3a2d', border: 'rgba(27,58,45,0.4)', bg: '#0a1410', bg2: 'rgba(14,24,18,0.95)', bg3: 'rgba(18,30,22,0.6)', bg4: 'rgba(22,36,26,0.3)', panel: 'rgba(14,24,18,0.8)' },
            { color: '#3d1b2d', border: 'rgba(61,27,45,0.4)', bg: '#140a10', bg2: 'rgba(24,14,20,0.95)', bg3: 'rgba(30,18,24,0.6)', bg4: 'rgba(36,22,28,0.3)', panel: 'rgba(24,14,20,0.8)' },
            { color: '#2d3a1b', border: 'rgba(45,58,27,0.4)', bg: '#10140a', bg2: 'rgba(18,24,14,0.95)', bg3: 'rgba(22,30,18,0.6)', bg4: 'rgba(26,36,22,0.3)', panel: 'rgba(18,24,14,0.8)' },
            { color: '#1b2d3a', border: 'rgba(27,45,58,0.4)', bg: '#0a1014', bg2: 'rgba(14,18,24,0.95)', bg3: 'rgba(18,22,30,0.6)', bg4: 'rgba(22,26,36,0.3)', panel: 'rgba(14,18,24,0.8)' },
            { color: '#3a1b2d', border: 'rgba(58,27,45,0.4)', bg: '#140a10', bg2: 'rgba(24,14,20,0.95)', bg3: 'rgba(30,18,24,0.6)', bg4: 'rgba(36,22,28,0.3)', panel: 'rgba(24,14,20,0.8)' },
            { color: '#2a1a3a', border: 'rgba(42,26,58,0.4)', bg: '#100a18', bg2: 'rgba(18,14,30,0.95)', bg3: 'rgba(24,18,38,0.6)', bg4: 'rgba(30,22,46,0.3)', panel: 'rgba(18,14,30,0.8)' },
            { color: '#1a2a3a', border: 'rgba(26,42,58,0.4)', bg: '#0a1018', bg2: 'rgba(14,18,30,0.95)', bg3: 'rgba(18,22,38,0.6)', bg4: 'rgba(22,26,46,0.3)', panel: 'rgba(14,18,30,0.8)' },
            { color: '#3a2a1a', border: 'rgba(58,42,26,0.4)', bg: '#18100a', bg2: 'rgba(30,18,14,0.95)', bg3: 'rgba(38,22,18,0.6)', bg4: 'rgba(46,26,22,0.3)', panel: 'rgba(30,18,14,0.8)' },
            { color: '#1a3a2a', border: 'rgba(26,58,42,0.4)', bg: '#0a1810', bg2: 'rgba(14,30,18,0.95)', bg3: 'rgba(18,38,22,0.6)', bg4: 'rgba(22,46,26,0.3)', panel: 'rgba(14,30,18,0.8)' },
            { color: '#2a3a1a', border: 'rgba(42,58,26,0.4)', bg: '#10180a', bg2: 'rgba(18,30,14,0.95)', bg3: 'rgba(22,38,18,0.6)', bg4: 'rgba(26,46,22,0.3)', panel: 'rgba(18,30,14,0.8)' },
        ];
        const uiColors = [
            '#008080','#6A5ACD','#8B0000','#808000','#228B22','#B76E79',
            '#0047AB','#C9A84C','#006400','#4B0082','#800020','#FF6347',
            '#4682B4','#2E8B57','#DAA520','#9932CC','#DC143C','#00CED1',
            '#FF8C00','#556B2F','#CD853F','#708090','#483D8B','#2F4F4F',
            '#8B4513','#191970','#006D6F','#8B0045','#36454F','#BC8F8F',
            '#1a1a2e','#2d1b3d','#1b3a2d','#3d1b2d','#2d3a1b','#1b2d3a',
            '#3a1b2d','#2a1a3a','#1a2a3a','#3a2a1a','#1a3a2a','#2a3a1a',
        ];
        const btnPalette = [
            '#1a3a5c','#1a4a2a','#5c3a1a','#3d2b5c','#5c1a3d','#1a3a5c',
            '#5c1a1a','#3a1a5c','#1a4a6b','#5c5a1a','#8b2020','#2d5a3a',
            '#1a3a5c','#8b2020','#6e6e73','#2d5a3a','#1a4a6b','#5c5a1a',
            '#5c1a3d','#5c3a1a','#3d4a2a','#1a4a6b','#3d2b5c','#1a4a3a',
            '#2a3a6b','#4a2a5c','#5c2a3d','#5c1a1a','#5c4a3a','#3d4a2a',
            'linear-gradient(135deg, #1a3a5c, #16213e)',
            'linear-gradient(135deg, #1a4a2a, #0f3460)',
            'linear-gradient(135deg, #5c3a1a, #2d132c)',
            'linear-gradient(135deg, #3d2b5c, #1e1e2f)',
            'linear-gradient(135deg, #5c1a3d, #2b2024)',
            'linear-gradient(135deg, #1a3a5c, #2e1a1a)',
            'linear-gradient(135deg, #5c1a1a, #1e2d1e)',
            'linear-gradient(135deg, #3a1a5c, #1a2e2a)',
            'linear-gradient(135deg, #1a4a6b, #2e2a1a)',
            'linear-gradient(135deg, #5c5a1a, #1a1a2e)',
            'linear-gradient(135deg, #8b2020, #1e1e2f)',
            'linear-gradient(135deg, #2d5a3a, #16213e)',
        ];
        const uiAccents = [
            { name: 'Стандартный', color: '#0a84ff', border: 'rgba(72,72,74,0.6)', bg: '#0f0f11', bg2: 'rgba(20,20,22,0.95)', bg3: 'rgba(28,28,30,0.6)', bg4: 'rgba(44,44,46,0.3)', panel: 'rgba(20,20,22,0.8)' },
            { name: 'Морская волна', color: '#008080', border: 'rgba(0,128,128,0.4)', bg: '#0a1616', bg2: 'rgba(10,30,30,0.95)', bg3: 'rgba(15,40,40,0.6)', bg4: 'rgba(20,50,50,0.3)', panel: 'rgba(10,30,30,0.8)' },
            { name: 'Индиго', color: '#6A5ACD', border: 'rgba(106,90,205,0.4)', bg: '#0e0c18', bg2: 'rgba(20,16,35,0.95)', bg3: 'rgba(28,22,48,0.6)', bg4: 'rgba(36,28,60,0.3)', panel: 'rgba(20,16,35,0.8)' },
            { name: 'Бордо', color: '#8B0000', border: 'rgba(139,0,0,0.4)', bg: '#180a0a', bg2: 'rgba(30,12,12,0.95)', bg3: 'rgba(40,16,16,0.6)', bg4: 'rgba(50,20,20,0.3)', panel: 'rgba(30,12,12,0.8)' },
            { name: 'Оливковый', color: '#808000', border: 'rgba(128,128,0,0.4)', bg: '#141408', bg2: 'rgba(26,26,10,0.95)', bg3: 'rgba(36,36,14,0.6)', bg4: 'rgba(46,46,18,0.3)', panel: 'rgba(26,26,10,0.8)' },
            { name: 'Лесной', color: '#228B22', border: 'rgba(34,139,34,0.4)', bg: '#0c160c', bg2: 'rgba(14,28,14,0.95)', bg3: 'rgba(18,38,18,0.6)', bg4: 'rgba(22,48,22,0.3)', panel: 'rgba(14,28,14,0.8)' },
            { name: 'Розовое золото', color: '#B76E79', border: 'rgba(183,110,121,0.4)', bg: '#180e10', bg2: 'rgba(30,16,18,0.95)', bg3: 'rgba(40,20,24,0.6)', bg4: 'rgba(50,26,30,0.3)', panel: 'rgba(30,16,18,0.8)' },
            { name: 'Кобальт', color: '#0047AB', border: 'rgba(0,71,171,0.4)', bg: '#0a0e18', bg2: 'rgba(12,18,32,0.95)', bg3: 'rgba(16,24,42,0.6)', bg4: 'rgba(20,30,52,0.3)', panel: 'rgba(12,18,32,0.8)' },
            { name: 'Графит', color: '#696969', border: 'rgba(105,105,105,0.4)', bg: '#121212', bg2: 'rgba(22,22,22,0.95)', bg3: 'rgba(30,30,30,0.6)', bg4: 'rgba(40,40,40,0.3)', panel: 'rgba(22,22,22,0.8)' },
            { name: 'Шампанское', color: '#C9A84C', border: 'rgba(201,168,76,0.4)', bg: '#161208', bg2: 'rgba(28,24,12,0.95)', bg3: 'rgba(38,32,16,0.6)', bg4: 'rgba(48,40,20,0.3)', panel: 'rgba(28,24,12,0.8)' },
        ];
        const btnColors = [
            { name: 'Синий', color: '#0a84ff' },
            { name: 'Изумрудный', color: '#34c759' },
            { name: 'Оранжевый', color: '#ff9500' },
            { name: 'Красный', color: '#ff3b30' },
            { name: 'Фиолетовый', color: '#af52de' },
            { name: 'Розовый', color: '#ff2d55' },
            { name: 'Бирюзовый', color: '#5ac8fa' },
            { name: 'Жёлтый', color: '#ffcc00' },
            { name: 'Коричневый', color: '#a2845e' },
            { name: 'Серый', color: '#8e8e93' },
        ];
        const textGradients = [
            'linear-gradient(135deg, #ff453a, #ff9500)',
            'linear-gradient(135deg, #0a84ff, #8b5cf6)',
            'linear-gradient(135deg, #34c759, #30d158)',
            'linear-gradient(135deg, #ff9500, #ff2d55)',
            'linear-gradient(135deg, #8b5cf6, #ec4899)',
            'linear-gradient(135deg, #0a84ff, #34c759)',
            'linear-gradient(135deg, #ff3b30, #ffcc00)',
            'linear-gradient(135deg, #af52de, #ff2d55)',
            'linear-gradient(135deg, #5ac8fa, #0a84ff)',
            'linear-gradient(135deg, #ffcc00, #ff9500)',
            'linear-gradient(135deg, #34c759, #0a84ff)',
            'linear-gradient(135deg, #ff2d55, #af52de)',
            'linear-gradient(135deg, #0a84ff, #5ac8fa)',
            'linear-gradient(135deg, #ff9500, #ff453a)',
            'linear-gradient(135deg, #8b5cf6, #0a84ff)',
            'linear-gradient(135deg, #ec4899, #8b5cf6)',
            'linear-gradient(135deg, #30d158, #34c759)',
            'linear-gradient(135deg, #ffcc00, #34c759)',
            'linear-gradient(135deg, #ff453a, #ff2d55)',
            'linear-gradient(135deg, #0a84ff, #ff9500)',
            'linear-gradient(135deg, #af52de, #0a84ff)',
            'linear-gradient(135deg, #5ac8fa, #34c759)',
            'linear-gradient(135deg, #ff2d55, #ff9500)',
            'linear-gradient(135deg, #34c759, #ffcc00)',
            'linear-gradient(135deg, #8b5cf6, #ff2d55)',
            'linear-gradient(135deg, #ff9500, #34c759)',
            'linear-gradient(135deg, #0a84ff, #ec4899)',
            'linear-gradient(135deg, #ff453a, #8b5cf6)',
            'linear-gradient(135deg, #30d158, #0a84ff)',
            'linear-gradient(135deg, #ffcc00, #ff2d55)',
            'linear-gradient(135deg, #1a3a5c, #16213e)',
            'linear-gradient(135deg, #008080, #2F4F4F)',
            'linear-gradient(135deg, #6A5ACD, #483D8B)',
            'linear-gradient(135deg, #8B0000, #800020)',
            'linear-gradient(135deg, #228B22, #556B2F)',
            'linear-gradient(135deg, #B76E79, #8B4513)',
            'linear-gradient(135deg, #0047AB, #191970)',
            'linear-gradient(135deg, #C9A84C, #808000)',
            'linear-gradient(135deg, #4B0082, #36454F)',
            'linear-gradient(135deg, #800020, #BC8F8F)',
            'linear-gradient(135deg, #2F4F4F, #006D6F)',
            'linear-gradient(135deg, #191970, #483D8B)',
        ];
        let glowAnimFrame = null;
        let iconGlowFrame = null;

        function applyTextGradient() {
            const r = document.documentElement;
            if (textGradient) {
                r.style.setProperty('--text-gradient', textGradient);
            } else {
                r.style.setProperty('--text-gradient', 'linear-gradient(135deg, #ff453a, #ff9500)');
            }
            const grad = textGradient || 'linear-gradient(135deg, #ff453a, #ff9500)';
            const m = grad.match(/#[0-9a-fA-F]{6}/);
            if (m) {
                r.style.setProperty('--text-gradient-color', m[0]);
                const icon = $('#activeAssistantName')?.previousElementSibling; if (icon) icon.style.color = m[0];
            }
        }

        function applyWallpaper() {
            const c = $('#chatMessages');
            if (!c) return;
            if (chatWallpaper) {
                c.style.background = `url(${chatWallpaper}) center/cover no-repeat`;
            } else {
                c.style.background = chatColor || '';
            }
        }
        function applyChatColor() { applyWallpaper(); }
        function applyUiAccent() {
            const r = document.documentElement;
            if (uiAccent) {
                const u = uiPalette.find(a => a.color === uiAccent);
                if (u) {
                    r.style.setProperty('--ui-bg', u.bg);
                    r.style.setProperty('--ui-bg2', u.bg2);
                    r.style.setProperty('--ui-bg3', u.bg3);
                    r.style.setProperty('--ui-bg4', u.bg4);
                    r.style.setProperty('--ui-panel', u.panel);
                    r.style.setProperty('--accent-border', u.border);
                }
            } else {
                r.style.removeProperty('--ui-bg'); r.style.removeProperty('--ui-bg2');
                r.style.removeProperty('--ui-bg3'); r.style.removeProperty('--ui-bg4');
                r.style.removeProperty('--ui-panel'); r.style.removeProperty('--accent-border');
            }
        }
        function applyBtnAccent() {
            const r = document.documentElement;
            if (btnAccent) { r.style.setProperty('--btn-accent', btnAccent); }
            else { r.style.setProperty('--btn-accent', '#3a3a3c'); }
        }
        function applyBtnGlow() {
            if (glowAnimFrame) { cancelAnimationFrame(glowAnimFrame); glowAnimFrame = null; }
            const allBtns = document.querySelectorAll('.model-select-btn, #sendBtn, #langToggleBtn, #sidebarIcon');
            allBtns.forEach(btn => { btn.style.boxShadow = ''; });
            const r = document.documentElement;
            r.style.setProperty('--btn-glow', btnGlow || 'linear-gradient(135deg, #ff453a, #ff9500)');
            if (!btnGlow) return;
            const m = btnGlow.match(/#[0-9a-fA-F]{6}/g);
            if (!m || m.length < 2) return;
            const c1 = m[0], c2 = m[1];
            function hexToRgb(hex) { return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)]; }
            const rgb1 = hexToRgb(c1), rgb2 = hexToRgb(c2);
            function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
            function lerpColor(c1, c2, t) { return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`; }
            const POINTS = 8, RINGS = 2;
            let t = 0;
            function animate() {
                t += 0.01;
                if (t > 1) t -= 1;
                const shadows = [];
                for (let ring = 1; ring <= RINGS; ring++) {
                    const dist = ring * 2, blur = ring * 3;
                    const opacity = 1 - (ring - 1) / RINGS;
                    for (let i = 0; i < POINTS; i++) {
                        const angle = (i / POINTS) * Math.PI * 2;
                        const phase = (t + i / POINTS) % 1;
                        const blend = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
                        const c = lerpColor(rgb1, rgb2, blend);
                        const x = Math.cos(angle) * dist, y = Math.sin(angle) * dist;
                        shadows.push(`${x.toFixed(1)}px ${y.toFixed(1)}px ${blur}px color-mix(in srgb, ${c} ${Math.round(opacity * 60)}%, transparent)`);
                    }
                }
                const shadowStr = shadows.join(', ');
                allBtns.forEach(btn => { btn.style.boxShadow = shadowStr; });
                glowAnimFrame = requestAnimationFrame(animate);
            }
            animate();
        }
        function applyIconGlow() {
            if (iconGlowFrame) { cancelAnimationFrame(iconGlowFrame); iconGlowFrame = null; }
            const icon = document.querySelector('#sidebarIcon');
            if (!icon) return;
            const grad = textGradients[0];
            const m = grad.match(/#[0-9a-fA-F]{6}/g);
            if (!m || m.length < 2) return;
            const rgb1 = [parseInt(m[0].slice(1,3),16), parseInt(m[0].slice(3,5),16), parseInt(m[0].slice(5,7),16)];
            const rgb2 = [parseInt(m[1].slice(1,3),16), parseInt(m[1].slice(3,5),16), parseInt(m[1].slice(5,7),16)];
            function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
            function lerpColor(c1, c2, t) { return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`; }
            const POINTS = 8, RINGS = 2;
            let t = 0;
            function animate() {
                t += 0.01;
                if (t > 1) t -= 1;
                const shadows = [];
                for (let ring = 1; ring <= RINGS; ring++) {
                    const dist = ring * 2, blur = ring * 3;
                    const opacity = 1 - (ring - 1) / RINGS;
                    for (let i = 0; i < POINTS; i++) {
                        const angle = (i / POINTS) * Math.PI * 2;
                        const phase = (t + i / POINTS) % 1;
                        const blend = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
                        const c = lerpColor(rgb1, rgb2, blend);
                        const x = Math.cos(angle) * dist, y = Math.sin(angle) * dist;
                        shadows.push(`${x.toFixed(1)}px ${y.toFixed(1)}px ${blur}px color-mix(in srgb, ${c} ${Math.round(opacity * 60)}%, transparent)`);
                    }
                }
                icon.style.boxShadow = shadows.join(', ');
                iconGlowFrame = requestAnimationFrame(animate);
            }
            animate();
        }
        applyWallpaper(); applyChatColor(); applyUiAccent(); applyBtnAccent(); applyTextGradient(); applyBtnGlow();
        if (!btnGlow) applyIconGlow();
        glowActiveChat();

        let hoverAnimFrames = {};
        function startGlowAnim(btn) {
            const m = btnGlow.match(/#[0-9a-fA-F]{6}/g);
            if (!m || m.length < 2) return;
            const rgb1 = [parseInt(m[0].slice(1,3),16), parseInt(m[0].slice(3,5),16), parseInt(m[0].slice(5,7),16)];
            const rgb2 = [parseInt(m[1].slice(1,3),16), parseInt(m[1].slice(3,5),16), parseInt(m[1].slice(5,7),16)];
            function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
            function lerpColor(c1, c2, t) { return `rgb(${lerp(c1[0],c2[0],t)},${lerp(c1[1],c2[1],t)},${lerp(c1[2],c2[2],t)})`; }
            const POINTS = 8, RINGS = 2;
            let t = 0;
            function animate() {
                t += 0.01;
                if (t > 1) t -= 1;
                const shadows = [];
                for (let ring = 1; ring <= RINGS; ring++) {
                    const dist = ring * 2, blur = ring * 3;
                    const opacity = 1 - (ring - 1) / RINGS;
                    for (let i = 0; i < POINTS; i++) {
                        const angle = (i / POINTS) * Math.PI * 2;
                        const phase = (t + i / POINTS) % 1;
                        const blend = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
                        const c = lerpColor(rgb1, rgb2, blend);
                        const x = Math.cos(angle) * dist, y = Math.sin(angle) * dist;
                        shadows.push(`${x.toFixed(1)}px ${y.toFixed(1)}px ${blur}px color-mix(in srgb, ${c} ${Math.round(opacity * 60)}%, transparent)`);
                    }
                }
                btn.style.boxShadow = shadows.join(', ');
                hoverAnimFrames[btn.id] = requestAnimationFrame(animate);
            }
            animate();
        }
        function stopGlowAnim(btn) {
            if (hoverAnimFrames[btn.id]) { cancelAnimationFrame(hoverAnimFrames[btn.id]); delete hoverAnimFrames[btn.id]; }
            btn.style.boxShadow = '';
        }
        document.querySelectorAll('.square-btn-hover').forEach(btn => {
            btn.addEventListener('mouseenter', () => {
                if (btnAccent) btn.style.background = btnAccent;
                if (btnGlow) startGlowAnim(btn);
            });
            btn.addEventListener('mouseleave', () => {
                stopGlowAnim(btn);
                btn.style.background = '';
            });
        });

        function makePalette(colors, active, type) {
            return `<div class="color-palette">${colors.map(c => `<div class="color-dot ${active === c ? 'active' : ''}" data-color="${c}" data-type="${type}" style="background:${c};" title="${c}"></div>`).join('')}</div>`;
        }

        function updateSettingsIcons() {
            const color = (textGradient.match(/#[0-9a-fA-F]{6}/) || ['#ff453a'])[0];
            const dd = $('#settingsMenuDropdown');
            if (!dd) return;
            dd.querySelectorAll('i.fas').forEach(icon => { if (!icon.closest('.color-palette')) icon.style.color = color; });
        }

        const settingsMenuBtn = $('#settingsMenuBtn');
        const settingsDropdown = $('#settingsMenuDropdown');
        if (settingsMenuBtn && settingsDropdown) {
            const i18nT = window.i18n?.t.bind(window.i18n) || (k => k);
            const gradColor = (textGradient.match(/#[0-9a-fA-F]{6}/) || ['#ff453a'])[0];
            settingsDropdown.innerHTML = `
                <div class="settings-dropdown-item has-sub" data-sub="btnGlowSub"><i class="fas fa-lightbulb" style="color:${gradColor}"></i><span data-i18n="settings.buttonHighlight">${i18nT('settings.buttonHighlight')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-dropdown-item has-sub" data-sub="uiColorSub"><i class="fas fa-paint-brush" style="color:${gradColor}"></i><span data-i18n="settings.theme">${i18nT('settings.theme')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-dropdown-item has-sub" data-sub="textGradSub"><i class="fas fa-font" style="color:${gradColor}"></i><span data-i18n="settings.textGradient">${i18nT('settings.textGradient')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-dropdown-item has-sub" data-sub="btnColorSub"><i class="fas fa-hand-pointer" style="color:${gradColor}"></i><span data-i18n="settings.buttonColor">${i18nT('settings.buttonColor')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-dropdown-item has-sub" data-sub="chatColorSub"><i class="fas fa-palette" style="color:${gradColor}"></i><span data-i18n="settings.chatColor">${i18nT('settings.chatColor')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-dropdown-item has-sub" data-sub="wallpaperSub"><i class="fas fa-image" style="color:${gradColor}"></i><span data-i18n="settings.wallpaper">${i18nT('settings.wallpaper')}</span><i class="fas fa-chevron-right sub-arrow"></i></div>
                <div class="settings-separator"></div>
                <div class="settings-dropdown-item" id="resetAllBtn"><i class="fas fa-trash" style="color:${gradColor}"></i><span data-i18n="settings.resetAll">${i18nT('settings.resetAll')}</span></div>
                <div id="wallpaperSub" class="settings-submenu">
                    <div class="settings-submenu-title"><i class="fas fa-arrow-left sub-back" style="color:${gradColor}"></i><span data-i18n="settings.wallpaper">${i18nT('settings.wallpaper')}</span></div>
                    <div class="settings-dropdown-item" id="setWallpaperBtn"><i class="fas fa-upload" style="color:${gradColor}"></i><span data-i18n="settings.uploadWallpaper">${i18nT('settings.uploadWallpaper')}</span></div>
                    <div class="settings-dropdown-item" id="resetWallpaperBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetWallpaper">${i18nT('settings.resetWallpaper')}</span></div>
                </div>
                <div id="chatColorSub" class="settings-submenu">
                    ${makePalette(chatPalette, chatColor, 'chat')}
                    <div class="settings-separator"></div>
                    <div class="settings-dropdown-item" id="resetChatColorBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetColor">${i18nT('settings.resetColor')}</span></div>
                </div>
                <div id="uiColorSub" class="settings-submenu">
                    ${makePalette(uiColors, uiAccent, 'ui')}
                    <div class="settings-separator"></div>
                    <div class="settings-dropdown-item" id="resetUiAccentBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetColor">${i18nT('settings.resetColor')}</span></div>
                </div>
                <div id="btnColorSub" class="settings-submenu">
                    ${makePalette(btnPalette, btnAccent, 'btn')}
                    <div class="settings-separator"></div>
                    <div class="settings-dropdown-item" id="resetBtnAccentBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetColor">${i18nT('settings.resetColor')}</span></div>
                </div>
                <div id="btnGlowSub" class="settings-submenu">
                    <div class="color-palette">${textGradients.map((g, i) => `<div class="color-dot btn-glow-dot ${btnGlow === g ? 'active' : ''}" data-gradient="${g}" data-idx="${i}" style="background:${g};" title="${i18nT('settings.buttonHighlight')} ${i + 1}"></div>`).join('')}</div>
                    <div class="settings-separator"></div>
                    <div class="settings-dropdown-item" id="resetBtnGlowBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetHighlight">${i18nT('settings.resetHighlight')}</span></div>
                </div>
                <div id="textGradSub" class="settings-submenu">
                    <div class="color-palette">${textGradients.map((g, i) => `<div class="color-dot text-grad-dot ${textGradient === g || (!textGradient && i === 0) ? 'active' : ''}" data-gradient="${g}" data-idx="${i}" style="background:${g};" title="${i18nT('settings.textGradient')} ${i + 1}"></div>`).join('')}</div>
                    <div class="settings-separator"></div>
                    <div class="settings-dropdown-item" id="resetTextGradBtn"><i class="fas fa-undo" style="color:${gradColor}"></i><span data-i18n="settings.resetGradient">${i18nT('settings.resetGradient')}</span></div>
                </div>
            `;
            settingsMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsDropdown.classList.toggle('show'); hideAllSubs(); });
            document.addEventListener('click', () => { settingsDropdown.classList.remove('show'); hideAllSubs(); });
            settingsDropdown.addEventListener('click', (e) => e.stopPropagation());

            function hideAllSubs() { settingsDropdown.querySelectorAll('.settings-submenu').forEach(s => s.classList.remove('show')); }

            settingsDropdown.querySelectorAll('.has-sub').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const subId = item.dataset.sub;
                    hideAllSubs();
                    const sub = settingsDropdown.querySelector('#' + subId);
                    if (sub) sub.classList.add('show');
                });
            });
            settingsDropdown.querySelectorAll('.sub-back').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); hideAllSubs(); });
            });

            const wallInput = document.createElement('input');
            wallInput.type = 'file'; wallInput.accept = 'image/*'; wallInput.style.display = 'none';
            document.body.appendChild(wallInput);
            $('#setWallpaperBtn')?.addEventListener('click', () => { settingsDropdown.classList.remove('show'); hideAllSubs(); wallInput.click(); });
            wallInput.addEventListener('change', () => {
                const file = wallInput.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = async (e) => {
                    chatWallpaper = e.target.result;
                    try { localStorage.setItem('chatWallpaper', chatWallpaper); } catch(e) {}
                    markDirty('chatWallpaper');
                    saveStorage();
                    applyWallpaper();
                    showToast('Обои установлены', 'success');
                };
                reader.readAsDataURL(file); wallInput.value = '';
            });
            $('#resetWallpaperBtn')?.addEventListener('click', () => { chatWallpaper = ''; try { localStorage.removeItem('chatWallpaper'); } catch(e) {} markDirty('chatWallpaper'); saveStorage(); applyWallpaper(); showToast('Обои сброшены', 'success'); });

            settingsDropdown.querySelectorAll('.color-dot[data-type]').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const type = item.dataset.type, color = item.dataset.color;
                    if (type === 'chat') { chatColor = color; localStorage.setItem('chatColor', chatColor); applyChatColor(); }
                    else if (type === 'ui') { uiAccent = color; localStorage.setItem('uiAccent', uiAccent); applyUiAccent(); }
                    else if (type === 'btn') { btnAccent = color; localStorage.setItem('btnAccent', btnAccent); applyBtnAccent(); }
                    item.closest('.color-palette').querySelectorAll('.color-dot').forEach(c => c.classList.remove('active'));
                    item.classList.add('active');
                    updateSettingsIcons();
                });
            });
            settingsDropdown.querySelectorAll('.text-grad-dot').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    textGradient = item.dataset.gradient;
                    localStorage.setItem('textGradient', textGradient);
                    applyTextGradient();
                    item.closest('.color-palette').querySelectorAll('.color-dot').forEach(c => c.classList.remove('active'));
                    updateSettingsIcons();
                    item.classList.add('active');
                });
            });
            settingsDropdown.querySelectorAll('.btn-glow-dot').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    btnGlow = item.dataset.gradient;
                    localStorage.setItem('btnGlow', btnGlow);
                    applyBtnGlow(); setTimeout(() => glowActiveChat(), 50);
                    item.closest('.color-palette').querySelectorAll('.color-dot').forEach(c => c.classList.remove('active'));
                    item.classList.add('active');
                    updateSettingsIcons();
                });
            });
            $('#resetChatColorBtn')?.addEventListener('click', () => { chatColor = ''; localStorage.removeItem('chatColor'); applyChatColor(); settingsDropdown.querySelectorAll('[data-type="chat"]').forEach(c => c.classList.remove('active')); updateSettingsIcons(); showToast('Цвет чата сброшен', 'success'); });
            $('#resetUiAccentBtn')?.addEventListener('click', () => { uiAccent = ''; localStorage.removeItem('uiAccent'); applyUiAccent(); settingsDropdown.querySelectorAll('[data-type="ui"]').forEach(c => c.classList.remove('active')); updateSettingsIcons(); showToast('Цвет интерфейса сброшен', 'success'); });
            $('#resetBtnAccentBtn')?.addEventListener('click', () => { btnAccent = ''; localStorage.removeItem('btnAccent'); applyBtnAccent(); settingsDropdown.querySelectorAll('[data-type="btn"]').forEach(c => c.classList.remove('active')); updateSettingsIcons(); });
            $('#resetTextGradBtn')?.addEventListener('click', () => { textGradient = ''; localStorage.removeItem('textGradient'); applyTextGradient(); settingsDropdown.querySelectorAll('.text-grad-dot').forEach(c => c.classList.remove('active')); settingsDropdown.querySelector('.text-grad-dot[data-idx="0"]')?.classList.add('active'); updateSettingsIcons(); showToast('Градиент сброшен', 'success'); });
            $('#resetBtnGlowBtn')?.addEventListener('click', () => { btnGlow = ''; localStorage.removeItem('btnGlow'); applyBtnGlow(); applyIconGlow(); if (activeGlowFrame) activeGlowFrame.stop(); activeGlowFrame = null; settingsDropdown.querySelectorAll('.btn-glow-dot').forEach(c => c.classList.remove('active')); settingsDropdown.querySelector('.btn-glow-dot[data-idx="0"]')?.classList.add('active'); updateSettingsIcons(); showToast('Подсветка сброшена', 'success'); });
            $('#resetAllBtn')?.addEventListener('click', () => {
                chatWallpaper = ''; chatColor = ''; uiAccent = ''; btnAccent = ''; textGradient = ''; btnGlow = '';
                localStorage.removeItem('chatWallpaper');
                localStorage.removeItem('chatColor');
                localStorage.removeItem('uiAccent');
                localStorage.removeItem('btnAccent');
                localStorage.removeItem('textGradient');
                localStorage.removeItem('btnGlow');
                markDirty('chatWallpaper');
                saveStorage();
                applyWallpaper(); applyChatColor(); applyUiAccent(); applyBtnAccent(); applyTextGradient(); applyBtnGlow(); applyIconGlow();
                if (activeGlowFrame) activeGlowFrame.stop(); activeGlowFrame = null;
                setTimeout(() => glowActiveChat(), 50);
                settingsDropdown.querySelectorAll('.color-dot').forEach(c => c.classList.remove('active'));
                updateSettingsIcons();
            });
        }

        // Toggle Settings (Think/GPU) dropdown
        const toggleBtn = $('#toggleSettingsBtn');
        const toggleDrop = $('#toggleSettingsDropdown');
        if (toggleBtn && toggleDrop) {
            toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDrop.classList.toggle('show'); });
            document.addEventListener('click', () => toggleDrop.classList.remove('show'));
            toggleDrop.addEventListener('click', (e) => e.stopPropagation());
        }
        
        // Scroll detection
        const chatEl = $('#chatMessages');
        if (chatEl) {
            chatEl.addEventListener('scroll', () => {
                const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 30;
                userScrolledUp = !atBottom;
                const chat = getChat();
                if (chat) chat._scrollPos = chatEl.scrollTop;
            }, { passive: true });
        }
        
        // Input Handling
        const input = $('#userInput');
        if (input) {
            input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !waiting) { e.preventDefault(); const t = input.value.trim(); if (t || pendingImages.length) { input.value = ''; sendMessage(t); } } });
                input.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px'; this.style.overflowY = this.scrollHeight > 100 ? 'auto' : 'hidden'; estimateCurrentContext(); });
        }

        // Dropdowns
        $('#changeModelBtn')?.addEventListener('click', e => { 
            e.stopPropagation(); 
            const dd = $('#modelDropdownContainer'); 
            if (dd) { 
                if (dd.classList.contains('show')) dd.classList.remove('show'); 
                else { positionModelDropdown(); dd.classList.add('show'); loadModelsList(); } 
            } 
        });
        
        $('#changeVisionBtn')?.addEventListener('click', e => { 
            e.stopPropagation(); 
            const dd = $('#visionDropdownContainer'); 
            if (dd) { 
                if (dd.classList.contains('show')) dd.classList.remove('show'); 
                else { positionVisionDropdown(); dd.classList.add('show'); loadModelsList(); } 
            } 
        });

        $('#assistantsAgentsBtn')?.addEventListener('click', e => { e.stopPropagation(); const dd = $('#assistantsAgentsDropdown'); if (dd) { dd.classList.toggle('show'); if (dd.classList.contains('show') && !dd.dataset.rendered) renderAssistantsDropdown(); } });
        $('#settingsGearBtn')?.addEventListener('click', e => { e.stopPropagation(); $('#settingsPanel')?.classList.toggle('show'); });
        $('#exportDataBtn')?.addEventListener('click', e => { e.stopPropagation(); exportData(); });
        $('#exportChatBtn')?.addEventListener('click', e => { e.stopPropagation(); exportCurrentChat(); });
        $('#importDataBtn')?.addEventListener('click', e => { e.stopPropagation(); $('#importFileInput')?.click(); });
        $('#importFileInput')?.addEventListener('change', e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; });

        // GPU Toggle - reload model on switch
        $('#gpuToggle')?.addEventListener('change', async (e) => {
            const gpuEnabled = e.target.checked;
            const modeLabel = gpuEnabled ? 'GPU' : 'CPU';
            setModelLoading(true, 'Переключение на ' + modeLabel + '...');
            showToast(gpuEnabled ? 'Переключение на GPU...' : 'Переключение на CPU...', 'info', 1500);
            try {
                const r = await api('/api/toggle_gpu', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gpu_enabled: gpuEnabled })
                });
                if (r.success) {
                    showToast('Загружено в режиме ' + modeLabel, 'success');
                    await loadModelsList();
                } else {
                    showToast('Ошибка: ' + (r.error || 'Unknown'), 'error', 4000);
                    e.target.checked = !gpuEnabled;
                }
            } catch (err) {
                showToast('Ошибка переключения', 'error');
                e.target.checked = !gpuEnabled;
            }
            setModelLoading(false);
        });
        
        // Params
        $('#paramsHeaderBtn')?.addEventListener('click', async () => {
            await loadGenParams();
            const panel = $('#paramsPanel');
            const btn = $('#paramsHeaderBtn');
            if (panel && btn) {
                const r = btn.getBoundingClientRect();
                panel.style.transformOrigin = `${r.left + r.width / 2}px ${r.top}px`;
                panel.classList.add('open');
            }
            const ov = $('#paramsOverlay'); if (ov) ov.classList.add('active');
        });
        $('#paramsOverlay')?.addEventListener('click', closeParams);
        $('#paramsApplyBtn')?.addEventListener('click', async () => { await saveGenParams(); closeParams(); });
        $('#paramsResetBtn')?.addEventListener('click', () => { 
            modelGenParams = { temperature: 0.7, top_p: 0.95, max_tokens: 2048, n_ctx: 8192, repeat_penalty: 1.1, top_k: 40, frequency_penalty: 0, presence_penalty: 0, n_batch: 4096, n_threads: 4, n_threads_batch: 4, n_gpu_layers: -1, flash_attn: true }; 
            forceSyncParams(); showToast('Сброшено', 'info'); updateLiveStatusBar(); 
        });
        function closeParams() {
            const panel = $('#paramsPanel');
            const btn = $('#paramsHeaderBtn');
            if (panel && btn) {
                const r = btn.getBoundingClientRect();
                panel.style.transformOrigin = `${r.left + r.width / 2}px ${r.top}px`;
            }
            if (panel) panel.classList.remove('open');
            const ov = $('#paramsOverlay'); if (ov) ov.classList.remove('active');
        }

        // Modals
        $('#modalConfirm')?.addEventListener('click', () => {
            const n = $('#modalName')?.value.trim(), p = $('#modalPrompt')?.value.trim(), temp = parseFloat($('#modalTempSlider')?.value) || 0.7;
            if (!n || !p) { showToast('Заполните поля', 'warning'); return; }
            if (modalMode === 'assistant') { if (modalId) { const i = assistants.findIndex(a => a.id === modalId); if (i !== -1) assistants[i] = { ...assistants[i], name: n, prompt: p, temp }; } else assistants.push({ id: Date.now().toString(), name: n, prompt: p, temp }); markDirty('assistants'); }
            else { if (modalId) { const i = agents.findIndex(a => a.id === modalId); if (i !== -1) agents[i] = { ...agents[i], name: n, prompt: p, temp }; } else agents.push({ id: Date.now().toString(), name: n, prompt: p, temp }); markDirty('agents'); }
            renderAssistantsDropdown(); updateActiveDisplay(); saveStorage(); closeModal('#modalOverlay');
        });

        // Profile
        $('#profileAvatarPreview')?.addEventListener('click', () => $('#profileAvatarInput')?.click());
        $('#profileAvatarInput')?.addEventListener('change', async e => {
            const f = e.target.files[0]; if (!f) return;
            const cropped = await openCropModal(f);
            if (!cropped) return;
            const img = $('#profileAvatarImg'), ph = $('#profileAvatarPlaceholder');
            if (img && ph) { img.src = cropped; img.classList.remove('hidden'); ph.classList.add('hidden'); }
            const m = $('#profileModal');
            if (m) m.dataset.tempAvatar = cropped;
            e.target.value = '';
        });
        $('#profileRemoveAvatarBtn')?.addEventListener('click', () => { const img = $('#profileAvatarImg'), ph = $('#profileAvatarPlaceholder'); if (img && ph) { img.classList.add('hidden'); ph.classList.remove('hidden'); } const m = $('#profileModal'); if (m) m.dataset.tempAvatar = 'null'; });
        $('#profileModalConfirm')?.addEventListener('click', async () => {
            const n = $('#profileNameInput')?.value.trim(); if (!n) { showToast('Введите имя', 'warning'); return; }
            const m = $('#profileModal'), type = m?.dataset.profileType; let temp = m?.dataset.tempAvatar, final = null;
            if (temp === 'null') final = null; else if (temp && temp !== 'undefined') final = temp; else final = type === 'user' ? userSettings.avatar : assistantSettings.avatar;
            if (type === 'user') { userSettings = { name: n, avatar: final }; markDirty('userSettings'); } else { assistantSettings = { name: n, avatar: final }; markDirty('assistantSettings'); }
            renderMessages(); saveStorage(); if (m) delete m.dataset.tempAvatar; closeModal('#profileModal'); showToast('Профиль сохранён', 'success');
        });

        // Global Clicks
        document.addEventListener('click', e => {
            const sp = $('#settingsPanel'), sg = $('#settingsGearBtn'); if (sp && sp.classList.contains('show') && !sp.contains(e.target) && !sg?.contains(e.target)) sp.classList.remove('show');
            const sm = $('#settingsMenuDropdown'), smb = $('#settingsMenuBtn'); if (sm && sm.classList.contains('show') && !sm.contains(e.target) && !smb?.contains(e.target)) sm.classList.remove('show');
            const mdd = $('#modelDropdownContainer'), mb = $('#changeModelBtn'); if (mdd && mdd.classList.contains('show') && !mdd.contains(e.target) && !mb?.contains(e.target)) mdd.classList.remove('show');
            const vdd = $('#visionDropdownContainer'), vb = $('#changeVisionBtn'); if (vdd && vdd.classList.contains('show') && !vdd.contains(e.target) && !vb?.contains(e.target)) vdd.classList.remove('show');
            const add = $('#assistantsAgentsDropdown'), adb = $('#assistantsAgentsBtn'); const apm = $('#agentProfileModal'); const mom = $('#modalOverlay'); if (add && add.classList.contains('show') && !add.contains(e.target) && !adb?.contains(e.target) && !(apm && !apm.classList.contains('hidden')) && !(mom && !mom.classList.contains('hidden'))) add.classList.remove('show');
            ['#modalOverlay', '#profileModal', '#agentProfileModal'].forEach(sel => {
                const m = $(sel);
                if (m && !m.classList.contains('hidden') && e.target === m) closeModal(sel);
            });
        });

        document.addEventListener('keydown', e => { 
            if (e.key === 'Escape') { 
                closeModal('#modalOverlay'); closeModal('#profileModal'); closeModal('#agentProfileModal'); closeParams(); 
                $('#modelDropdownContainer')?.classList.remove('show'); 
                $('#visionDropdownContainer')?.classList.remove('show'); 
                $('#settingsMenuDropdown')?.classList.remove('show'); 
                $('#assistantsAgentsDropdown')?.classList.remove('show'); 
            } 
        });

        $('#chatSearchInput')?.addEventListener('input', debounce(e => {
            const q = e.target.value.toLowerCase().trim(), c = $('#chatList'); if (!c) return;
            $$('.chat-item', c).forEach(item => { const id = item.dataset.id, chat = chatList.find(ch => ch.id === id); if (!chat) { item.style.display = 'none'; return; } if (!q) { item.style.display = ''; return; } const nm = chat.name.toLowerCase().includes(q); const cm = chat.messages.some(m => { const ct = typeof m.content === 'string' ? m.content : ''; return ct.toLowerCase().includes(q); }); item.style.display = (nm || cm) ? '' : 'none'; });
        }, 300));

        if (isMobile) {
            const toggle = document.createElement('button'); toggle.id = 'mobileMenuToggle'; toggle.className = 'mobile-menu-toggle btn-apple'; toggle.innerHTML = '<i class="fas fa-bars"></i>'; document.body.appendChild(toggle);
            toggle.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
            document.addEventListener('click', e => { const s = $('#sidebar'); if (s?.classList.contains('open') && !s.contains(e.target) && !toggle.contains(e.target)) s.classList.remove('open'); });
        }

        $('#activeAssistantName')?.addEventListener('click', () => {
            const ids = getSelectedIds();
            if (ids.length > 0) {
                const firstId = ids[0];
                const found = assistants.find(a => a.id === firstId) || agents.find(a => a.id === firstId);
                if (found) {
                    const type = assistants.some(a => a.id === firstId) ? 'assistant' : 'agent';
                    openAgentProfile(type, firstId);
                    return;
                }
            }
            openProfile('assistant');
        });
        setTimeout(loadModelsList, 80);
        setInterval(() => { if (!waiting) estimateCurrentContext(); }, 2000);
    }

    function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

    // Update model/vision badges when language changes
    function updateBadgesOnLanguageChange() {
        const modelBadge = $('#currentModelBadge');
        const visionBadge = $('#currentVisionBadge');
        if (modelBadge && !selectedModel) {
            modelBadge.innerText = window.i18n?.t('header.selectModel') || 'Выберите модель';
        }
        if (visionBadge && !currentMmproj) {
            visionBadge.innerText = window.i18n?.t('header.noVision') || 'Без Vision';
            visionBadge.style.color = '#34c759';
        }
    }

    window.addEventListener('languageChanged', () => {
        updateBadgesOnLanguageChange();
        loadModelsList();
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();