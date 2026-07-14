// Backend para Gemini (motor gratis). Traduce el formato de pedido/respuesta
// al mismo que ya usa api/chat.js (Claude), para que el frontend no note la diferencia.

function claudeMessagesToGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]).map(block => {
      if (block.type === 'image') {
        return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
      }
      return { text: block.text || '' };
    })
  }));
}

function extractSystemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => b.text || '').join('\n');
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Metodo no permitido' } });
  }

  const secretRecibido = req.headers['x-jarvis-secret'];
  if (!secretRecibido || secretRecibido !== process.env.JARVIS_APP_SECRET) {
    return res.status(401).json({ error: { message: 'No autorizado' } });
  }

  try {
    const { system, messages, max_tokens } = req.body;
    const systemText = extractSystemText(system);
    const contents = claudeMessagesToGeminiContents(messages || []);

    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 600 }
    };
    if (systemText) {
      geminiBody.systemInstruction = { parts: [{ text: systemText }] };
    }

    // Buscamos un modelo Flash que esté disponible en esta cuenta, sin depender de un nombre fijo.
    // Probamos una lista de candidatos en orden; si ninguno anda, preguntamos a Google cuáles hay.
    const candidatos = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest-001'];

    async function pedirAModelo(nombreModelo){
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${nombreModelo}:generateContent`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(geminiBody)
      });
      return r;
    }

    let response = null;
    let modeloUsado = null;
    for(const cand of candidatos){
      const r = await pedirAModelo(cand);
      if(r.ok){ response = r; modeloUsado = cand; break; }
      // si falla por modelo inexistente/no disponible seguimos probando; otros errores los cortamos
      const errData = await r.clone().json().catch(() => ({}));
      const msg = (errData?.error?.message || '').toLowerCase();
      const esProblemaDeModelo = msg.includes('not found') || msg.includes('no longer available') || msg.includes('not supported');
      if(!esProblemaDeModelo){ response = r; modeloUsado = cand; break; }
    }

    // si ninguno de la lista anduvo, le preguntamos a Google qué modelos tiene esta cuenta
    if(!response){
      const listR = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
      });
      const listData = await listR.json();
      const flashDisponible = (listData?.models || []).find(m =>
        /flash/i.test(m.name || '') &&
        (m.supportedGenerationMethods || []).includes('generateContent')
      );
      if(flashDisponible){
        const nombre = flashDisponible.name.replace('models/', '');
        response = await pedirAModelo(nombre);
        modeloUsado = nombre;
      }
    }

    if(!response){
      return res.status(502).json({ error: { message: 'No encontre ningun modelo de Gemini disponible en esta cuenta.' } });
    }

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || 'Error al hablar con Gemini';
      return res.status(response.status).json({ error: { message: msg } });
    }

    // traducimos la respuesta de Gemini al mismo formato que ya devuelve Claude
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join(' ').trim() || 'No obtuve respuesta, proba de nuevo.';

    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (e) {
    res.status(500).json({ error: { message: 'No se pudo conectar con Gemini: ' + e.message } });
  }
}
