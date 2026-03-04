/* ═══════════════════════════════════════════════════════════════
   DynaLens PWA — Application Logic v2.0
   Guided Root Cause Investigation Engine
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── State ───────────────────────────────────────────────────────
let currentImageBase64 = null;
let currentAnalysis = null;
let currentImageDataUrl = null;

// ── Chat state ──────────────────────────────────────────────────
let chatHistory = [];
let chatPendingImage = null;
let chatBusy = false;

// ── Investigation State ──────────────────────────────────────────
let investigationState = {
    phase: 0,
    totalPhases: 5,
    screensVisited: [],      // list of screenType strings
    hypotheses: [],          // current hypothesis strings
    confidence: 0,           // 0-100
    rootCauseFound: false,
    serviceName: null,
    hostName: null
};

// ── Dynatrace Navigation Knowledge Graph ─────────────────────────
const DYNATRACE_SCREENS = {
    'problems-list': 'Lista de Problemas (Davis AI)',
    'problem-detail': 'Detalle de Problema',
    'service-overview': 'Vista de Servicio',
    'distributed-traces': 'Trazas Distribuidas',
    'trace-detail': 'Detalle de Traza',
    'host-metrics': 'Métricas de Host',
    'logs': 'Logs & Events',
    'davis-ai': 'Davis AI / Análisis Automático',
    'infrastructure': 'Infraestructura',
    'process-groups': 'Grupos de Procesos',
    'code-level': 'Insights a Nivel de Código',
    'database': 'Base de Datos',
    'custom': 'Pantalla Personalizada/Desconocida'
};

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
            const img = document.getElementById('previewImg');
            img.src = ev.target.result;
            img.classList.remove('hidden');
            document.getElementById('dropzonePlaceholder').classList.add('hidden');
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
        'es', 'se', 'por', 'con', 'del', 'the', 'is', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'with']);
    const tokenize = t => t.toLowerCase().replace(/[^a-záéíóúñ0-9\s]/gi, '')
        .split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
    const qTokens = tokenize(queryText);
    const scored = allChunks.map((chunk) => {
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

    // Reset investigation state
    investigationState = {
        phase: 1,
        totalPhases: 5,
        screensVisited: [],
        hypotheses: [],
        confidence: 0,
        rootCauseFound: false,
        serviceName: null,
        hostName: null
    };
    chatHistory = [];
    chatPendingImage = null;
    chatBusy = false;

    // Loading state
    document.getElementById('loadingCard').classList.remove('hidden');
    document.getElementById('resultsSection').classList.add('hidden');
    document.getElementById('nextStepsSection').classList.add('hidden');
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

        const firstUserContent = [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: 'Analiza esta captura de pantalla de Dynatrace. Responde ÚNICAMENTE con JSON válido, sin markdown ni texto adicional.' }
        ];

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
                max_tokens: 3000,
                temperature: 0.1,
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

        // Update investigation state from analysis
        if (analysis.screenType) {
            investigationState.screensVisited.push(analysis.screenType);
        }
        if (analysis.service) investigationState.serviceName = analysis.service;
        if (analysis.host) investigationState.hostName = analysis.host;
        investigationState.confidence = 15; // Starting confidence after first screen

        // Store initial turn
        chatHistory.push({ role: 'user', content: firstUserContent });
        chatHistory.push({ role: 'assistant', content: raw });

        renderResults(analysis);
        renderNextSteps(analysis);
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

// ── Build System Prompt (Initial Analysis) ───────────────────────
function buildSystemPrompt(kbContext) {
    let prompt = `Eres un experto SRE e investigador de incidencias especializado en Dynatrace con 10 años de experiencia.
Analiza la captura de pantalla y devuelve ÚNICAMENTE JSON válido con esta estructura exacta (sin markdown, sin texto extra):
{
  "severity": "ok|warning|critical|unknown",
  "screenType": "problems-list|problem-detail|service-overview|distributed-traces|trace-detail|host-metrics|logs|davis-ai|infrastructure|process-groups|code-level|database|custom",
  "service": "<nombre del servicio o null>",
  "host": "<nombre del host o null>",
  "summary": "<resumen detallado en 3-4 frases: qué muestra la pantalla, qué ha pasado, cuándo, qué métricas están afectadas>",
  "problem": "<descripción técnica precisa del problema observable en esta pantalla>",
  "anomalies": [
    {
      "metricName": "<nombre exacto de la métrica>",
      "currentValue": "<valor actual visible>",
      "baselineValue": "<valor baseline si visible o 'no visible'>",
      "deviation": "<desviación, ej: +340%>",
      "trend": "<símbolo + descripción, ej: ↑ subiendo rápido>",
      "description": "<qué significa este cambio y por qué es relevante para la investigación>"
    }
  ],
  "nextScreens": [
    {
      "priority": 1,
      "screen": "<nombre de la pantalla Dynatrace>",
      "screenType": "<tipo de pantalla: service-overview|distributed-traces|host-metrics|logs|process-groups|code-level|database>",
      "why": "<razón técnica específica de por qué ir a esta pantalla para avanzar en la investigación>",
      "navigationSteps": [
        "<Paso 1 exacto de navegación en Dynatrace>",
        "<Paso 2 exacto>",
        "<Paso 3 exacto si aplica>"
      ],
      "whatToLookFor": "<qué buscar específicamente en esa pantalla para confirmar o descartar hipótesis>"
    },
    {
      "priority": 2,
      "screen": "<segunda pantalla recomendada>",
      "screenType": "<tipo>",
      "why": "<razón>",
      "navigationSteps": ["<paso>"],
      "whatToLookFor": "<qué buscar>"
    }
  ],
  "hypothesis": "<hipótesis de causa raíz más probable basada en esta primera pantalla>",
  "recommendations": [
    "<acción inmediata recomendada 1>",
    "<acción inmediata recomendada 2>"
  ]
}

REGLAS CRÍTICAS:
- "screenType": identifica exactamente qué pantalla de Dynatrace es (problems-list si ves lista de problemas de Davis, service-overview si ves métricas de un servicio, etc.)
- "nextScreens": SIEMPRE proporciona 2-3 pantallas con navegación ESPECÍFICA y EXACTA (menú > submenú > elemento). Si ves un servicio llamado "OrderService", di exactamente "Applications & Microservices → Services → busca 'OrderService' → haz clic".
- "summary": sé muy específico sobre valores, timestamps y métricas visibles
- "hypothesis": formula una hipótesis técnica concreta, no genérica
- Severidad: "critical"=alertas rojas/P1, "warning"=naranja/P2, "ok"=verde/sin alertas, "unknown"=no determinable`;

    if (kbContext) {
        prompt += `\n\nCONTEXTO DE BASE DE CONOCIMIENTO (enriquece recomendaciones y navegación):\n${kbContext}`;
    }
    return prompt;
}

// ── Build Chat System Prompt (Investigation) ─────────────────────
function buildChatSystemPrompt() {
    const screensVisited = investigationState.screensVisited.map(s => DYNATRACE_SCREENS[s] || s).join(', ');
    const phase = investigationState.phase;
    const confidence = investigationState.confidence;
    const hypotheses = investigationState.hypotheses.length
        ? investigationState.hypotheses.join('; ')
        : 'Pendiente de más datos';
    const service = investigationState.serviceName || 'desconocido';
    const host = investigationState.hostName || 'desconocido';

    return `Eres un experto SRE e investigador de incidencias especializado en Dynatrace con 10 años de experiencia.
Estás guiando a un usuario NO experto en Dynatrace para encontrar la causa raíz de un incidente. El usuario NECESITA instrucciones exactas de navegación porque no conoce la herramienta.

ESTADO ACTUAL DE LA INVESTIGACIÓN:
- Fase: ${phase} de 5
- Pantallas ya analizadas: ${screensVisited || 'ninguna aún'}
- Servicio afectado: ${service}
- Host: ${host}
- Hipótesis actual: ${hypotheses}
- Confianza en causa raíz: ${confidence}%

INSTRUCCIONES DE COMPORTAMIENTO:
1. Si el usuario adjunta una NUEVA imagen: analízala en profundidad, di exactamente qué ves (valores, timestamps, errores, nombres), avanza la investigación y actualiza la hipótesis.
2. Siempre da el SIGUIENTE PASO EXACTO en Dynatrace con navegación específica (menús exactos, nombres de pestañas, qué buscar).
3. Sé ESPECÍFICO: no digas "revisa los logs", di "Ve a Observe & Explore → Logs → filtra por 'service.name = ${service}' → busca errores SQL o TimeoutException en el rango horario del incidente"
4. Cuando la confianza llegue a ~80%, declara la CAUSA RAÍZ con formato especial.
5. Si el usuario pregunta algo sin imagen, responde y luego guía al siguiente paso.

FORMATO DE RESPUESTA OBLIGATORIO (usa markdown):
- Empieza siempre con lo que ves en la imagen (si hay una nueva)
- Explica qué significa para la investigación
- Actualiza la hipótesis
- Da el siguiente paso en formato:
  **📍 SIGUIENTE PASO:** [nombre pantalla]
  [navegación exacta paso a paso]
  **🔍 Busca específicamente:** [qué buscar]
- Si encuentras la causa raíz, usa:
  **🎯 CAUSA RAÍZ IDENTIFICADA:** [descripción]
  **📋 PLAN DE REMEDIACIÓN:** [pasos]

REGLA DE ORO: El usuario no sabe nada de Dynatrace. Cada respuesta debe contener instrucciones tan claras que pueda seguirlas sin conocimiento previo.
Responde SIEMPRE en español.`;
}

// ── Render Next Steps ────────────────────────────────────────────
function renderNextSteps(analysis) {
    const section = document.getElementById('nextStepsSection');
    if (!analysis.nextScreens || !analysis.nextScreens.length) {
        section.classList.add('hidden');
        return;
    }

    const cards = analysis.nextScreens.map((ns, i) => {
        const steps = (ns.navigationSteps || []).map(s => `<li>${escHtml(s)}</li>`).join('');
        const priorityLabel = i === 0 ? '🔴 PRIORITARIO' : i === 1 ? '🟡 ALTERNATIVO' : '🔵 ADICIONAL';
        return `
        <div class="next-step-card ${i === 0 ? 'primary' : ''}">
          <div class="next-step-header">
            <span class="next-step-priority">${priorityLabel}</span>
            <span class="next-step-screen">${escHtml(ns.screen || '')}</span>
          </div>
          <p class="next-step-why"><strong>¿Por qué?</strong> ${escHtml(ns.why || '')}</p>
          <div class="next-step-nav">
            <div class="next-step-nav-title">📍 Cómo llegar:</div>
            <ol class="next-step-nav-list">${steps}</ol>
          </div>
          ${ns.whatToLookFor ? `<div class="next-step-look"><strong>🔍 Busca:</strong> ${escHtml(ns.whatToLookFor)}</div>` : ''}
        </div>`;
    }).join('');

    section.innerHTML = `
      <div class="next-steps-container">
        <div class="next-steps-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          Próximos Pasos en Dynatrace
        </div>
        <p class="next-steps-subtitle">Sigue estos pasos, haz una foto y adjúntala al chat para continuar la investigación</p>
        <div class="next-steps-grid">${cards}</div>
      </div>`;
    section.classList.remove('hidden');
}

// ── Chat Conversacional ───────────────────────────────────────────
function openChat(analysis) {
    const section = document.getElementById('chatSection');
    section.classList.remove('hidden');
    const msgs = document.getElementById('chatMessages');
    msgs.innerHTML = '';

    const sev = analysis.severity || 'unknown';
    const sevLabel = { ok: 'sin anomalías críticas', warning: 'con advertencias activas', critical: '**CRÍTICA** 🚨', unknown: 'de estado a confirmar' }[sev] || '';
    const screenLabel = DYNATRACE_SCREENS[analysis.screenType] || 'pantalla desconocida';
    const service = analysis.service ? ` del servicio **${analysis.service}**` : '';

    let opening = `He analizado la captura. Estoy viendo la **${screenLabel}**${service} — situación ${sevLabel}.\n\n`;

    if (analysis.problem) {
        opening += `**📊 Problema detectado:** ${analysis.problem}\n\n`;
    }

    if (analysis.hypothesis) {
        opening += `**🧪 Hipótesis inicial:** ${analysis.hypothesis}\n\n`;
    }

    if (analysis.nextScreens && analysis.nextScreens.length > 0) {
        const ns = analysis.nextScreens[0];
        opening += `**📍 SIGUIENTE PASO RECOMENDADO:**\n`;
        opening += `Necesito que vayas a **${ns.screen}** para ${ns.why}\n\n`;
        if (ns.navigationSteps && ns.navigationSteps.length) {
            opening += `**Cómo llegar:**\n`;
            ns.navigationSteps.forEach((step, i) => {
                opening += `${i + 1}. ${step}\n`;
            });
            opening += '\n';
        }
        if (ns.whatToLookFor) {
            opening += `**🔍 Una vez allí, busca:** ${ns.whatToLookFor}\n\n`;
        }
    }

    opening += `*Haz la foto de esa pantalla, adjúntala aquí y continuaremos la investigación.*`;

    updatePhaseBanner();
    appendChatMsg('ai', opening);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Phase Banner ─────────────────────────────────────────────────
function updatePhaseBanner() {
    const banner = document.getElementById('investigationPhase');
    if (!banner) return;
    const { phase, totalPhases, confidence, hypotheses, rootCauseFound } = investigationState;
    const hypoText = hypotheses.length ? hypotheses[hypotheses.length - 1] : 'Recopilando datos...';
    const shortHypo = hypoText.length > 50 ? hypoText.substring(0, 47) + '...' : hypoText;

    banner.innerHTML = `
      <div class="phase-info">
        <span class="phase-label">${rootCauseFound ? '🎯 CAUSA RAÍZ' : `🔍 Fase ${phase}/${totalPhases}`}</span>
        <span class="phase-hypo">${escHtml(shortHypo)}</span>
      </div>
      <div class="confidence-section">
        <span class="confidence-label">Confianza ${confidence}%</span>
        <div class="confidence-bar"><div class="confidence-fill ${confidence >= 80 ? 'high' : confidence >= 50 ? 'medium' : 'low'}" style="width:${confidence}%"></div></div>
      </div>`;
    banner.classList.remove('hidden');
}

// ── Render Chat Message ───────────────────────────────────────────
function appendChatMsg(role, text, imageDataUrl, screenLabel) {
    const msgs = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    const avatar = role === 'ai' ? '🔭' : '👤';
    let bubbleContent = '';
    if (imageDataUrl) {
        bubbleContent += `<div class="chat-img-container">
          <img class="chat-img-thumb" src="${imageDataUrl}" alt="imagen adjunta">
          ${screenLabel ? `<span class="chat-img-label">${escHtml(screenLabel)}</span>` : ''}
        </div>`;
    }
    bubbleContent += renderMarkdown(text);
    div.innerHTML = `
      <div class="chat-avatar">${avatar}</div>
      <div class="chat-bubble">${bubbleContent}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

// ── Typing indicator ─────────────────────────────────────────────
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

// ── Chat File Attachment ─────────────────────────────────────────
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

// ── Send Chat Message ────────────────────────────────────────────
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

    // Build user content
    const userContent = [];
    let pendingDataUrl = null;
    if (chatPendingImage) {
        pendingDataUrl = chatPendingImage.dataUrl;
        userContent.push({ type: 'image_url', image_url: { url: pendingDataUrl } });
        // Advance investigation phase when new image is provided
        investigationState.phase = Math.min(investigationState.phase + 1, investigationState.totalPhases);
    }
    if (text) userContent.push({ type: 'text', text });

    appendChatMsg('user', text || '(nueva captura adjunta)', pendingDataUrl);
    clearChatPendingImg();
    showTyping();

    chatHistory.push({
        role: 'user',
        content: userContent.length === 1 && userContent[0].type === 'text' ? text : userContent
    });

    try {
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
                model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
                max_tokens: 2000,
                temperature: 0.2,
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

        // Extract investigation metadata from reply
        updateInvestigationFromReply(replyText);

        hideTyping();
        appendChatMsg('ai', replyText);
        updatePhaseBanner();

    } catch (err) {
        hideTyping();
        appendChatMsg('ai', `❌ Error: ${err.message}`);
    } finally {
        chatBusy = false;
        document.getElementById('chatSendBtn').disabled = false;
    }
}

// ── Extract investigation metadata from AI reply ─────────────────
function updateInvestigationFromReply(replyText) {
    // Check for root cause declaration
    if (replyText.includes('CAUSA RAÍZ IDENTIFICADA') || replyText.includes('CAUSA RAIZ IDENTIFICADA')) {
        investigationState.rootCauseFound = true;
        investigationState.confidence = 95;
        investigationState.phase = investigationState.totalPhases;
        return;
    }

    // Try to infer confidence increase from context clues
    const lowerReply = replyText.toLowerCase();
    let confidenceDelta = 10;
    if (lowerReply.includes('confirma') || lowerReply.includes('confirmar') || lowerReply.includes('evidencia clara')) confidenceDelta = 20;
    if (lowerReply.includes('descarta') || lowerReply.includes('no coincide')) confidenceDelta = 5;
    if (lowerReply.includes('alta probabilidad') || lowerReply.includes('muy probable')) confidenceDelta = 25;

    investigationState.confidence = Math.min(investigationState.confidence + confidenceDelta, 90);

    // Extract any new hypothesis mentioned
    const hypothesisMatch = replyText.match(/hipótesis[:\s]+([^.\n]+)/i) ||
        replyText.match(/probablemente[:\s]+([^.\n]+)/i) ||
        replyText.match(/causa probable[:\s]+([^.\n]+)/i);
    if (hypothesisMatch) {
        investigationState.hypotheses.push(hypothesisMatch[1].trim());
        // Keep only last 3
        if (investigationState.hypotheses.length > 3) investigationState.hypotheses.shift();
    }
}

// ── Keyboard shortcut ────────────────────────────────────────────
function chatInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

// ── Markdown Renderer ────────────────────────────────────────────
function renderMarkdown(text) {
    if (!text) return '';

    let html = escHtml(text);

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    // Inline code: `text`
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Numbered list items
    html = html.replace(/^(\d+)\.\s+(.+)$/gm, (_, num, content) =>
        `<div class="md-list-item"><span class="md-list-num">${num}.</span><span>${content}</span></div>`);

    // Bullet list items
    html = html.replace(/^[-•]\s+(.+)$/gm, (_, content) =>
        `<div class="md-list-item"><span class="md-bullet">•</span><span>${content}</span></div>`);

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
}

// ── Parse Analysis Response ───────────────────────────────────────
function parseAnalysis(raw, kbContext) {
    let text = raw.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    try {
        const parsed = JSON.parse(text);
        return { ...parsed, kbContext, rawResponse: raw, analyzedAt: new Date().toISOString() };
    } catch {
        return {
            severity: 'unknown',
            screenType: 'custom',
            service: null, host: null,
            summary: 'No se pudo parsear la respuesta estructurada.',
            problem: 'Respuesta no parseada.',
            anomalies: [],
            nextScreens: [],
            hypothesis: 'No determinado',
            recommendations: ['Revisa la respuesta en bruto.'],
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
    const screenLabel = DYNATRACE_SCREENS[a.screenType] || 'Pantalla Dynatrace';

    let html = `
    <div class="severity-banner ${sev === 'warning' ? 'warn' : sev}">
      <div class="severity-icon">${icons[sev] || '❓'}</div>
      <div>
        <div class="severity-label">${labels[sev] || sev.toUpperCase()}</div>
        <div class="severity-meta">${[a.service, a.host].filter(Boolean).join(' · ') || 'Servicio desconocido'}</div>
      </div>
      <div class="screen-badge">${escHtml(screenLabel)}</div>
    </div>`;

    // Summary
    html += resultCard('Resumen del Problema', svgAnalytics(), `<p class="result-text">${escHtml(a.summary)}</p>${a.problem ? `<p class="result-problem">${escHtml(a.problem)}</p>` : ''}`);

    // Hypothesis
    if (a.hypothesis) {
        html += resultCard('Hipótesis Inicial', svgHypothesis(),
            `<div class="hypothesis-box"><span class="hypothesis-icon">🧪</span><p>${escHtml(a.hypothesis)}</p></div>`);
    }

    // Anomalies
    if (a.anomalies?.length) {
        const rows = a.anomalies.map(an => `
      <div class="anomaly-row">
        <div class="anomaly-trend">${escHtml(an.trend || '↑')}<span class="anomaly-deviation">${escHtml(an.deviation || '')}</span></div>
        <div>
          <div class="anomaly-name">${escHtml(an.metricName)}</div>
          ${an.currentValue ? `<div class="anomaly-values">Actual: <strong>${escHtml(an.currentValue)}</strong>${an.baselineValue && an.baselineValue !== 'no visible' ? ` · Baseline: ${escHtml(an.baselineValue)}` : ''}</div>` : ''}
          <div class="anomaly-desc">${escHtml(an.description)}</div>
        </div>
      </div>`).join('');
        html += resultCard('Anomalías Detectadas', svgHeartbeat(), rows);
    }

    // KB Context
    if (a.kbContext) {
        const excerpts = a.kbContext.split('---').slice(0, 2).map(x =>
            `<div class="kb-excerpt">${escHtml(x.trim())}</div>`).join('');
        html += resultCard('Base de Conocimiento', svgBooks(), excerpts);
    }

    // Recommendations
    if (a.recommendations?.length) {
        const recs = a.recommendations.map((r, i) =>
            `<div class="rec-item"><div class="rec-num">${i + 1}</div><div class="rec-text">${escHtml(r)}</div></div>`
        ).join('');
        html += resultCard('Acciones Inmediatas', svgClipboard(), recs);
    }

    // Share bar
    html += `<div class="share-bar">
    <button class="btn btn-secondary btn-sm" onclick="shareReport()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      Compartir
    </button>
    <button class="btn btn-secondary btn-sm" onclick="toggleRawResponse()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      Respuesta bruta
    </button>
  </div>
  <div id="rawResponse" class="hidden">
    ${resultCard('JSON Completo del Análisis', svgTerminal(), `<pre class="raw-pre">${escHtml(a.rawResponse || '')}</pre>`)}
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
        `Pantalla: ${DYNATRACE_SCREENS[a.screenType] || a.screenType}`,
        a.service ? `Servicio: ${a.service}` : null,
        a.host ? `Host: ${a.host}` : null,
        `\nResumen:\n${a.summary}`,
        a.hypothesis ? `\nHipótesis: ${a.hypothesis}` : null,
        `\nAcciones:\n${a.recommendations?.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
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
    history.unshift({ id: Date.now(), analysis, thumb: imageDataUrl });
    if (history.length > 50) history.pop();
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
        const screenLabel = DYNATRACE_SCREENS[a.screenType] || '';
        const thumb = item.thumb
            ? `<img class="history-thumb" src="${item.thumb}" alt="thumb" />`
            : `<div class="history-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="21 15 16 10 5 21"/></svg></div>`;
        return `<div class="history-item" onclick='openHistoryItem(${item.id})'>
      ${thumb}
      <div class="history-info">
        <div class="history-sev ${sev === 'warning' ? 'warn' : sev}">${labels[sev] || sev}</div>
        ${screenLabel ? `<div class="history-screen">${escHtml(screenLabel)}</div>` : ''}
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

// SVG Icons
function svgAnalytics() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgHeartbeat() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgBooks() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`; }
function svgClipboard() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`; }
function svgTerminal() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`; }
function svgHypothesis() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`; }
