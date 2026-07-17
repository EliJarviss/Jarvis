// Backend para Gemini (motor gratis). Traduce el formato de pedido/respuesta
// al mismo que ya usa api/chat.js (Claude), para que el frontend no note la diferencia.
//
// ETAPA 5 — qué cambió respecto de la versión anterior:
//  1. Modelos fijos en cadena. Se fue el alias flotante 'gemini-flash-latest', que hoy
//     apunta a gemini-3.5-flash: justo el modelo con el cupo gratuito más chico (20 al día).
//  2. Si un modelo se queda sin cupo, pasa solo al siguiente en vez de tirar error.
//  3. Filtra las partes de razonamiento interno (thought), que se estaban colando en la
//     respuesta y salían en pantalla como texto en inglés.
//  4. Más espacio de salida, así el razonamiento no se come la respuesta.
//  5. Mensajes de error en español.

// Los cupos del nivel gratuito son POR MODELO, así que encadenarlos los suma.
// Medidos en el panel de AI Studio (nivel gratuito, 14-07-2026):
//   gemini-3.1-flash-lite  -> 15 RPM / 500 RPD  <- principal
//   gemini-3.5-flash       ->  5 RPM /  20 RPD
//   gemini-2.5-flash       ->  5 RPM /  20 RPD
//   gemini-2.5-flash-lite  -> 10 RPM /  20 RPD
// Total aproximado: 560 mensajes por día.
const CADENA_MODELOS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

// Piso de tokens de salida. Los modelos con razonamiento gastan parte del presupuesto
// pensando: con 600 la respuesta real se quedaba sin lugar y llegaba cortada o vacía.
const MIN_TOKENS_SALIDA = 2000;

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

// Gemini devuelve su razonamiento interno como partes marcadas con thought: true.
// El código viejo las juntaba con la respuesta real: por eso aparecía texto suelto
// en inglés tipo "constraint: 3 sentences. No markdown...". Acá las descartamos.
function extraerTexto(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && p.thought !== true && typeof p.text === 'string')
    .map(p => p.text)
    .join(' ')
    .trim();
}

function clasificarError(status, data) {
  const msg = (data?.error?.message || '').toLowerCase();
  if (status === 429 || (data?.error?.status || '') === 'RESOURCE_EXHAUSTED') return 'cuota';
  if (status === 404 ||
      msg.includes('not found') ||
      msg.includes('no longer available') ||
      msg.includes('not supported')) return 'modelo';
  return 'fatal';
}

// Google manda cuánto esperar dentro de error.details, en formato "55s".
function segundosDeEspera(data) {
  const detalles = data?.error?.details;
  if (!Array.isArray(detalles)) return null;
  for (const d of detalles) {
    if (d && typeof d.retryDelay === 'string') {
      const n = parseFloat(d.retryDelay);
      if (!Number.isNaN(n) && n > 0) return Math.ceil(n);
    }
  }
  return null;
}

// Distingue "te quedaste sin cupo del día" de "vas muy rápido, espera unos segundos".
function esCupoDiario(data) {
  let crudo = '';
  try { crudo = JSON.stringify(data || {}).toLowerCase(); } catch (e) { return false; }
  return crudo.includes('perday') || crudo.includes('per day');
}

function mensajeDeCuota(data) {
  if (esCupoDiario(data)) {
    return 'Me quedé sin cupo gratuito de Google por hoy. Se reinicia a medianoche, hora del Pacífico. Si necesitas seguir ahora, di "activa modo trabajo" para usar Claude.';
  }
  const espera = segundosDeEspera(data);
  if (espera) {
    return `Estoy saturado. Espera ${espera} segundo${espera === 1 ? '' : 's'} y vuelve a intentar.`;
  }
  return 'Estoy saturado en este momento. Espera un minuto y vuelve a intentar.';
}

function mensajeFatal(status, data) {
  const detalle = data?.error?.message || '';
  if (status === 401 || status === 403) {
    return 'La clave de Google no está funcionando. Revisa GEMINI_API_KEY en Vercel.';
  }
  if (status === 400) {
    return 'Google rechazó el pedido' + (detalle ? ': ' + detalle : '.');
  }
  return 'Google devolvió un error' + (detalle ? ': ' + detalle : ' (código ' + status + ').');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Método no permitido' } });
  }

  const secretRecibido = req.headers['x-jarvis-secret'];
  if (!secretRecibido || secretRecibido !== process.env.JARVIS_APP_SECRET) {
    return res.status(401).json({ error: { message: 'No autorizado' } });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'Falta la variable GEMINI_API_KEY en Vercel.' } });
  }

  try {
    const { system, messages, max_tokens } = req.body;
    const systemText = extractSystemText(system);
    const contents = claudeMessagesToGeminiContents(messages || []);

    const tokensSalida = Math.max(Number(max_tokens) || 600, MIN_TOKENS_SALIDA);

    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: tokensSalida }
    };
    if (systemText) {
      geminiBody.systemInstruction = { parts: [{ text: systemText }] };
    }

    async function pedirAModelo(nombreModelo) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${nombreModelo}:generateContent`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify(geminiBody)
      });
    }

    let datosOk = null;
    let modeloUsado = null;
    let ultimaCuota = null;
    let huboProblemaDeModelo = false;

    for (const modelo of CADENA_MODELOS) {
      const r = await pedirAModelo(modelo);
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }

      if (r.ok) {
        datosOk = data;
        modeloUsado = modelo;
        break;
      }

      const tipo = clasificarError(r.status, data);
      if (tipo === 'cuota') {
        // sin cupo en este modelo: probamos el siguiente, que tiene su propio cupo
        ultimaCuota = data;
        continue;
      }
      if (tipo === 'modelo') {
        // Google renombró o retiró este modelo: seguimos con el próximo
        huboProblemaDeModelo = true;
        continue;
      }
      // cualquier otro error (clave mala, pedido inválido) no se arregla cambiando de modelo
      return res.status(r.status).json({ error: { message: mensajeFatal(r.status, data) } });
    }

    // Último recurso: si ninguno de los modelos fijos existe (Google los renombró a todos),
    // le preguntamos a Google qué tiene disponible esta cuenta. Solo si el problema fue de
    // nombres; si fue de cupo, pedir la lista no sirve de nada.
    if (!datosOk && huboProblemaDeModelo) {
      try {
        const listR = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
        });
        const listData = await listR.json();
        const candidato = (listData?.models || []).find(m =>
          /flash/i.test(m.name || '') &&
          (m.supportedGenerationMethods || []).includes('generateContent')
        );
        if (candidato) {
          const nombre = String(candidato.name).replace('models/', '');
          const r = await pedirAModelo(nombre);
          const data = await r.json().catch(() => null);
          if (r.ok) {
            datosOk = data;
            modeloUsado = nombre;
          }
        }
      } catch (e) { /* si esto también falla, cae al mensaje de abajo */ }
    }

    if (!datosOk) {
      if (ultimaCuota) {
        return res.status(429).json({ error: { message: mensajeDeCuota(ultimaCuota) } });
      }
      return res.status(502).json({ error: { message: 'No encontré ningún modelo de Gemini disponible en esta cuenta.' } });
    }

    const texto = extraerTexto(datosOk);

    // Si no quedó texto visible, avisamos por qué en vez de devolver una burbuja vacía
    if (!texto) {
      const razon = datosOk?.candidates?.[0]?.finishReason || '';
      if (razon === 'MAX_TOKENS') {
        return res.status(200).json({
          content: [{ type: 'text', text: 'Me quedé sin espacio para responder. Prueba con una pregunta más corta.' }]
        });
      }
      if (razon === 'SAFETY' || razon === 'PROHIBITED_CONTENT' || razon === 'BLOCKLIST') {
        return res.status(200).json({
          content: [{ type: 'text', text: 'No puedo responder eso. Probemos con otra cosa.' }]
        });
      }
      return res.status(200).json({
        content: [{ type: 'text', text: 'No obtuve respuesta. Intenta de nuevo.' }]
      });
    }

    // pista para depurar: en la pestaña Red del navegador se ve qué modelo respondió
    res.setHeader('x-jarvis-modelo', modeloUsado || 'desconocido');
    res.status(200).json({ content: [{ type: 'text', text: texto }] });
  } catch (e) {
    res.status(500).json({ error: { message: 'No se pudo conectar con Gemini: ' + e.message } });
  }
}
