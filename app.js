/* ═══════════════════════════════════════════════════════════════
   DynaLens PWA — Application Logic
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── State ───────────────────────────────────────────────────────
let currentImageBase64 = null;
let currentAnalysis = null;
let currentImageDataUrl = null;

// ── Chat state ──────────────────────────────────────────────────
let chatHistory = [];          // [{role, parts:[{text}|{inline_data}]}]
let chatPendingImage = null;   // {base64, mimeType, dataUrl} for next send
let chatBusy = false;

// ── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    registerSW();
    loadApiKey();
    renderKbDocs();
    renderHistory();
    setupFileInput();
    showInstallBannerIfNeeded();
});

// ── Service Worker ───────────────────────────────────────────────
function registerSW() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(console.warn);
    }
}


// ── Tab navigation ───────────────────────────────────────────────
function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.getElementById(`nav-${name}`).classList.add('active');
    if (name === 'history') renderHistory();
}

// ── File Input ───────────────────────────────────────────────────
function setupFileInput() {
    document.getElementById('fileInput').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            currentImageDataUrl = ev.target.result;
            // Show preview
            const img = document.getElementById('previewImg');
            img.src = ev.target.result;
            img.classList.remove('hidden');
            document.getElementById('dropzonePlaceholder').classList.add('hidden');
            // Extract base64 (strip prefix)
            currentImageBase64 = ev.target.result.split(',')[1];
            document.getElementById('analyzeBtn').disabled = false;
        };
        reader.readAsDataURL(file);
    });
}

// ── API Key ──────────────────────────────────────────────────────
function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) { showToast('La clave no puede estar vacía'); return; }
    localStorage.setItem('dynalens_api_key', key);
    showToast('✓ Clave guardada');
}
function loadApiKey() {
    const key = localStorage.getItem('dynalens_api_key') || '';
    document.getElementById('apiKeyInput').value = key;
}
function toggleApiKey() {
    const input = document.getElementById('apiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
}

// ── Knowledge Base ───────────────────────────────────────────────
function getKbDocs() {
    return JSON.parse(localStorage.getItem('dynalens_kb') || '[]');
}
function saveKbDocs(docs) {
    localStorage.setItem('dynalens_kb', JSON.stringify(docs));
}
function openAddDoc() {
    document.getElementById('docTitle').value = '';
    document.getElementById('docContent').value = '';
    document.getElementById('docModal').classList.remove('hidden');
}
function closeAddDoc() {
    document.getElementById('docModal').classList.add('hidden');
}
function saveDoc() {
    const title = document.getElementById('docTitle').value.trim();
    const content = document.getElementById('docContent').value.trim();
    if (!title || !content) { showToast('Completa título y contenido'); return; }
    const docs = getKbDocs();
    docs.push({ id: Date.now(), title, content, chunks: chunkText(content) });
    saveKbDocs(docs);
    renderKbDocs();
    closeAddDoc();
    showToast('✓ Documento guardado');
}
function deleteDoc(id) {
    const docs = getKbDocs().filter(d => d.id !== id);
    saveKbDocs(docs);
    renderKbDocs();
}
function renderKbDocs() {
    const list = document.getElementById('kbDocList');
    const docs = getKbDocs();
    if (!docs.length) { list.innerHTML = ''; return; }
    list.innerHTML = docs.map(d => `
    <div class="kb-doc-item">
      <div>
        <div class="kb-doc-title">${escHtml(d.title)}</div>
        <div class="kb-doc-meta">${d.chunks.length} fragmentos</div>
      </div>
      <button class="kb-doc-del" onclick="deleteDoc(${d.id})" aria-label="Eliminar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
        </svg>
      </button>
    </div>
  `).join('');
}

// TF-IDF-style context retrieval
function chunkText(text, size = 300, overlap = 50) {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += size - overlap) {
        chunks.push(words.slice(i, i + size).join(' '));
        if (i + size >= words.length) break;
    }
    return chunks;
}
function getRelevantContext(queryText, topK = 4) {
    const docs = getKbDocs();
    const allChunks = docs.flatMap(d => d.chunks || chunkText(d.content));
    if (!allChunks.length) return '';

    const stopWords = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'en', 'a', 'y', 'o', 'que',
        'es', 'se', 'por', 'con', 'del', 'the', 'a', 'is', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'with']);
    const tokenize = t => t.toLowerCase().replace(/[^a-záéíóúñ0-9\s]/gi, '')
        .split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

    const qTokens = tokenize(queryText);
    const scored = allChunks.map((chunk, i) => {
        const cTokens = tokenize(chunk);
        const score = qTokens.reduce((s, t) => s + cTokens.filter(ct => ct === t).length, 0);
        return { chunk, score };
    }).sort((a, b) => b.score - a.score).slice(0, topK).filter(x => x.score > 0);

    return scored.map(x => x.chunk).join('\n\n---\n\n');
}

// ── Analysis ─────────────────────────────────────────────────────
async function runAnalysis() {
    const apiKey = localStorage.getItem('dynalens_api_key') || '';
    if (!apiKey) {
        showToast('⚠️ Configura tu API key en Ajustes');
        showTab('settings');
        return;
    }
    if (!currentImageBase64) return;

    // Reset chat
    chatHistory = [];
    chatPendingImage = null;
    chatBusy = false;

    // Loading state
    document.getElementById('loadingCard').classList.remove('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    document.getElementById('chatSection').classList.add('hidden');
    document.getElementById('analyzeBtn').disabled = true;

    try {
        const kbContext = getRelevantContext(
            'dynatrace alert metric anomaly spike baseline deviation response time cpu memory'
        );
        const systemPrompt = buildSystemPrompt(kbContext);
        const mimeMatch = (currentImageDataUrl || '').match(/^data:(image\/[a-zA-Z+]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const imageDataUrl = `data:${mimeType};base64,${currentImageBase64}`;

        // Groq API (OpenAI-compatible) with Llama 3.2 90B Vision
        const firstUserContent = [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: 'Analiza esta captura de pantalla de Dynatrace y responde ÚnicaMENTE con JSON válido, sin markdown.' }
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.2-90b-vision-preview',
                max_tokens: 2048,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: firstUserContent }
                ]
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content || '';
        const analysis = parseAnalysis(raw, kbContext);
        currentAnalysis = analysis;

        // Store initial turn in OpenAI format
        chatHistory.push({ role: 'user', content: firstUserContent });
        chatHistory.push({ role: 'assistant', content: raw });

        renderResults(analysis);
        saveHistoryItem(analysis, currentImageDataUrl);
        openChat(analysis);

    } catch (err) {
        showToast(`❌ ${err.message}`);
        console.error(err);
    } finally {
        document.getElementById('loadingCard').classList.add('hidden');
        document.getElementById('analyzeBtn').disabled = false;
    }
}

// ── Chat Conversacional ───────────────────────────────────────────
function openChat(analysis) {
    const section = document.getElementById('chatSection');
    section.classList.remove('hidden');
    const msgs = document.getElementById('chatMessages');
    msgs.innerHTML = '';
    // Opening message from AI
    const sev = analysis.severity || 'unknown';
    const sevLabel = { ok: 'sin anomalías críticas', warning: 'con advertencias', critical: 'CRÍTICA', unknown: 'de estado desconocido' }[sev];
    const opening = `He completado el análisis inicial: situación ${sevLabel}. 

Para investigar la causa raíz necesito más contexto. ¿Puedes adjuntar otra captura? Por ejemplo:
• Vista de la traza distribuida del servicio afectado
• Gráfica de CPU/memoria del host en el mismo período
• Logs o eventos de Dynatrace relacionados

O cuestioname directamente: ¿qué ocurrió antes del pico?`;
    appendChatMsg('ai', opening);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function appendChatMsg(role, text, imageDataUrl) {
    const msgs = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    const avatar = role === 'ai' ? '🔭' : '👤';
    let bubbleContent = '';
    if (imageDataUrl) {
        bubbleContent += `<img class="chat-img-thumb" src="${imageDataUrl}" alt="imagen adjunta">`;
    }
    bubbleContent += escHtml(text).replace(/\n/g, '<br>');
    div.innerHTML = `
      <div class="chat-avatar">${avatar}</div>
      <div class="chat-bubble">${bubbleContent}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

function showTyping() {
    const msgs = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'chat-msg ai';
    div.id = 'chatTyping';
    div.innerHTML = `<div class="chat-avatar">🔭</div><div class="chat-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}
function hideTyping() {
    document.getElementById('chatTyping')?.remove();
}

function chatAttachImage() {
    document.getElementById('chatFileInput').click();
}

function onChatFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        const dataUrl = ev.target.result;
        const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const base64 = dataUrl.split(',')[1];
        chatPendingImage = { base64, mimeType, dataUrl };
        // Show pending preview
        const prev = document.getElementById('chatPendingImg');
        prev.classList.remove('hidden');
        prev.querySelector('img').src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

function clearChatPendingImg() {
    chatPendingImage = null;
    document.getElementById('chatPendingImg').classList.add('hidden');
}

async function sendChatMessage() {
    if (chatBusy) return;
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text && !chatPendingImage) return;

    const apiKey = localStorage.getItem('dynalens_api_key') || '';
    if (!apiKey) { showToast('⚠️ Configura la API key'); return; }

    chatBusy = true;
    document.getElementById('chatSendBtn').disabled = true;
    input.value = '';

    // Build user content (OpenAI format)
    const userContent = [];
    if (chatPendingImage) {
        const imgUrl = chatPendingImage.dataUrl;
        userContent.push({ type: 'image_url', image_url: { url: imgUrl } });
    }
    if (text) userContent.push({ type: 'text', text });

    appendChatMsg('user', text || '(imagen adjunta)', chatPendingImage?.dataUrl);
    clearChatPendingImg();
    showTyping();

    chatHistory.push({ role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? text : userContent });

    try {
        // Build full messages: system + history
        const messages = [
            { role: 'system', content: buildChatSystemPrompt() },
            ...chatHistory
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.2-90b-vision-preview',
                max_tokens: 1024,
                temperature: 0.3,
                messages
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const replyText = data.choices?.[0]?.message?.content || 'Sin respuesta.';
        chatHistory.push({ role: 'assistant', content: replyText });
        hideTyping();
        appendChatMsg('ai', replyText);

    } catch (err) {
        hideTyping();
        appendChatMsg('ai', `❌ Error: ${err.message}`);
    } finally {
        chatBusy = false;
        document.getElementById('chatSendBtn').disabled = false;
    }
}

function chatInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

function buildSystemPrompt(kbContext) {
    let prompt = `Eres un experto SRE especializado en Dynatrace. Analiza la captura de pantalla proporcionada.
Devuelve ÚNICAMENTE JSON válido con esta estructura exacta (sin markdown, sin texto extra):
{
  "severity": "ok|warning|critical|unknown",
  "service": "<nombre del servicio o null>",
  "host": "<nombre del host o null>",
  "summary": "<resumen en 2-3 frases en español de lo que muestra la gráfica/alerta>",
  "anomalies": [
    {
      "metricName": "<nombre de la métrica>",
      "deviation": "<desviación, ej: +340%>",
      "trend": "<símbolo de tendencia, ej: ↑ subiendo>",
      "description": "<qué significa este cambio>"
    }
  ],
  "recommendations": [
    "<acción recomendada 1 en español>",
    "<acción recomendada 2 en español>"
  ]
}
Reglas de severidad:
- "critical": alertas ROJAS, desviación >100% sobre baseline, incidentes P1
- "warning": alertas AMARILLAS/NARANJAS, desviación 20-100%, P2
- "ok": estado VERDE, dentro de baseline, sin anomalías
- "unknown": no se puede determinar`;

    if (kbContext) {
        prompt += `\n\nCONTEXTO DE BASE DE CONOCIMIENTO (úsalo para enriquecer recomendaciones):\n${kbContext}`;
    }
    return prompt;
}

function buildChatSystemPrompt() {
    return `Eres un experto SRE e investigador de incidencias especializado en Dynatrace. 
Ya has realizado el análisis inicial de una captura. Ahora estás en modo INVESTIGACIÓN DE CAUSA RAÍZ.

Tu objetivo es llegar a la causa raíz de la incidencia mediante diálogo con el ingeniero.
Sigue este proceso:
1. Haz preguntas específicas y pide capturas adicionales cuando necesites más información
2. Si el usuario adjunta una nueva imagen, analízala en el contexto de lo ya visto
3. Formula hipotésis de causa raíz y guía al ingeniero a confirmarlas o refutarlas
4. Cuando identifiques la causa raíz con alta confianza, concluye con: 
   "CAUSA RAÍZ IDENTIFICADA: [descripción]" y proporciona el plan de remediación

Reglas:
- Responde siempre en español
- Sé conciso pero técnico y preciso
- Si ves una nueva imagen, empieza mencionando qué observas en ella
- Propón siempre un siguiente paso claro o una pregunta concreta`;
}

function parseAnalysis(raw, kbContext) {
    let text = raw.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    try {
        const parsed = JSON.parse(text);
        return { ...parsed, kbContext, rawResponse: raw, analyzedAt: new Date().toISOString() };
    } catch {
        return {
            severity: 'unknown',
            service: null, host: null,
            summary: 'No se pudo parsear la respuesta estructurada. Revisa la respuesta en bruto.',
            anomalies: [],
            recommendations: ['Revisa la respuesta en bruto a continuación.'],
            kbContext, rawResponse: raw,
            analyzedAt: new Date().toISOString()
        };
    }
}

// ── Render Results ───────────────────────────────────────────────
function renderResults(a) {
    const sev = a.severity || 'unknown';
    const icons = { ok: '✅', warning: '⚠️', critical: '🚨', unknown: '❓' };
    const labels = { ok: 'TODO OK', warning: 'ADVERTENCIA', critical: 'CRÍTICO', unknown: 'DESCONOCIDO' };

    let html = `
    <div class="severity-banner ${sev === 'warning' ? 'warn' : sev}">
      <div class="severity-icon">${icons[sev] || '❓'}</div>
      <div>
        <div class="severity-label">${labels[sev] || sev.toUpperCase()}</div>
        <div class="severity-meta">${[a.service, a.host].filter(Boolean).join(' · ') || 'Servicio desconocido'}</div>
      </div>
    </div>`;

    // Summary
    html += resultCard('Resumen', svgAnalytics(), `<p class="result-text">${escHtml(a.summary)}</p>`);

    // Anomalies
    if (a.anomalies?.length) {
        const rows = a.anomalies.map(an => `
      <div class="anomaly-row">
        <div class="anomaly-trend">${escHtml(an.trend || '↑')}<span class="anomaly-deviation">${escHtml(an.deviation || '')}</span></div>
        <div><div class="anomaly-name">${escHtml(an.metricName)}</div><div class="anomaly-desc">${escHtml(an.description)}</div></div>
      </div>`).join('');
        html += resultCard('Anomalías detectadas', svgHeartbeat(), rows);
    }

    // KB Context
    if (a.kbContext) {
        const excerpts = a.kbContext.split('---').slice(0, 2).map(x =>
            `<div class="kb-excerpt">${escHtml(x.trim())}</div>`).join('');
        html += resultCard('Base de conocimiento', svgBooks(), excerpts);
    }

    // Recommendations
    if (a.recommendations?.length) {
        const recs = a.recommendations.map((r, i) =>
            `<div class="rec-item"><div class="rec-num">${i + 1}</div><div class="rec-text">${escHtml(r)}</div></div>`
        ).join('');
        html += resultCard('Acciones recomendadas', svgClipboard(), recs);
    }

    // Share bar
    html += `<div class="share-bar">
    <button class="btn btn-secondary btn-sm" onclick="shareReport()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      Compartir informe
    </button>
    <button class="btn btn-secondary btn-sm" onclick="toggleRawResponse()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      Respuesta bruta
    </button>
  </div>
  <div id="rawResponse" class="hidden">
    ${resultCard('Respuesta Gemini 2.5 Pro', svgTerminal(), `<pre style="font-size:0.75rem;color:#4CAF50;white-space:pre-wrap;word-break:break-all">${escHtml(a.rawResponse || '')}</pre>`)}
  </div>`;

    const section = document.getElementById('resultsSection');
    section.innerHTML = html;
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth' });
}

function resultCard(title, iconSvg, innerHtml) {
    return `<div class="result-card">
    <div class="result-card-title">${iconSvg} ${title}</div>
    ${innerHtml}
  </div>`;
}

function toggleRawResponse() {
    document.getElementById('rawResponse').classList.toggle('hidden');
}

// ── Share ────────────────────────────────────────────────────────
function shareReport() {
    if (!currentAnalysis) return;
    const a = currentAnalysis;
    const text = [
        `DynaLens — Análisis Dynatrace`,
        `Severidad: ${a.severity?.toUpperCase()}`,
        a.service ? `Servicio: ${a.service}` : null,
        a.host ? `Host: ${a.host}` : null,
        `\nResumen:\n${a.summary}`,
        `\nRecomendaciones:\n${a.recommendations?.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    ].filter(Boolean).join('\n');

    if (navigator.share) {
        navigator.share({ title: 'DynaLens Report', text }).catch(() => { });
    } else {
        navigator.clipboard.writeText(text).then(() => showToast('✓ Copiado al portapapeles'));
    }
}

// ── History ──────────────────────────────────────────────────────
function getHistory() {
    return JSON.parse(localStorage.getItem('dynalens_history') || '[]');
}
function saveHistoryItem(analysis, imageDataUrl) {
    const history = getHistory();
    history.unshift({
        id: Date.now(),
        analysis,
        thumb: imageDataUrl  // stored as full dataUrl; could compress but keep simple
    });
    if (history.length > 50) history.pop();  // cap at 50
    localStorage.setItem('dynalens_history', JSON.stringify(history));
}
function clearHistory() {
    if (!confirm('¿Borrar todo el historial?')) return;
    localStorage.removeItem('dynalens_history');
    renderHistory();
    showToast('Historial borrado');
}
function renderHistory() {
    const list = document.getElementById('historyList');
    const history = getHistory();
    if (!history.length) {
        list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <p>Aún no hay análisis guardados</p>
    </div>`;
        return;
    }
    list.innerHTML = history.map(item => {
        const a = item.analysis;
        const sev = a.severity || 'unknown';
        const labels = { ok: 'TODO OK', warning: 'ADVERTENCIA', critical: 'CRÍTICO', unknown: 'DESCONOCIDO' };
        const date = new Date(a.analyzedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
        const thumb = item.thumb
            ? `<img class="history-thumb" src="${item.thumb}" alt="thumb" />`
            : `<div class="history-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="21 15 16 10 5 21"/></svg></div>`;

        return `<div class="history-item" onclick='openHistoryItem(${item.id})'>
      ${thumb}
      <div class="history-info">
        <div class="history-sev ${sev === 'warning' ? 'warn' : sev}">${labels[sev] || sev}</div>
        <div class="history-service">${escHtml(a.service || 'Desconocido')}</div>
        <div class="history-summary">${escHtml(a.summary || '')}</div>
        <div class="history-date">${date}</div>
      </div>
      <div class="history-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`;
    }).join('');
}

function openHistoryItem(id) {
    const item = getHistory().find(h => h.id === id);
    if (!item) return;
    currentAnalysis = item.analysis;
    currentImageDataUrl = item.thumb;
    showTab('analyze');
    renderResults(item.analysis);
    if (item.thumb) {
        const img = document.getElementById('previewImg');
        img.src = item.thumb;
        img.classList.remove('hidden');
        document.getElementById('dropzonePlaceholder').classList.add('hidden');
    }
}

// ── Install Banner (iOS) ─────────────────────────────────────────
function showInstallBannerIfNeeded() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    const dismissed = localStorage.getItem('dynalens_install_dismissed');
    if (isIos && !isStandalone && !dismissed) {
        document.getElementById('installBanner').classList.remove('hidden');
    }
}
function dismissInstall() {
    localStorage.setItem('dynalens_install_dismissed', '1');
    document.getElementById('installBanner').classList.add('hidden');
}

// ── Toast ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ── Helpers ──────────────────────────────────────────────────────
function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline SVG icons
function svgAnalytics() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgHeartbeat() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgBooks() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`; }
function svgClipboard() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`; }
function svgTerminal() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`; }
