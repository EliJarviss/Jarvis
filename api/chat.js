// Esta funcion vive en el servidor de Vercel, nunca en el navegador.
// Es la unica que conoce la clave secreta de Anthropic.
// Recibe exactamente lo mismo que el frontend le mandaba antes a Anthropic
// (model, max_tokens, system, messages), le agrega la clave, y devuelve la respuesta tal cual.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Metodo no permitido' } });
  }

  // solo acepta pedidos que traigan la clave secreta compartida con el frontend de Jarvis
  const secretRecibido = req.headers['x-jarvis-secret'];
  if (!secretRecibido || secretRecibido !== process.env.JARVIS_APP_SECRET) {
    return res.status(401).json({ error: { message: 'No autorizado' } });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: 'No se pudo conectar con Claude: ' + e.message } });
  }
}
