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

    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(geminiBody)
    });

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
