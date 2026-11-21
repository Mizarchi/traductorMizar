import http from 'node:http'
import { randomBytes } from 'node:crypto'

const apiKey = process.env.GEMINI_API_KEY?.trim()

if (!apiKey) {
  console.error('Falta GEMINI_API_KEY en el archivo privado.')
  process.exit(1)
}

const localSecret = randomBytes(32).toString('hex')
let creatingSession = false
let shuttingDown = false

function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

async function createTemporaryToken() {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        bidiGenerateContentSetup: {
          model: 'models/gemini-3.5-live-translate-preview',
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: 'en',
              echoTargetLanguage: false,
            },
          },
        },
      }),
    },
  )

  if (!response.ok) {
    const error = new Error('Google rechazo la creacion de la credencial.')
    error.upstreamStatus = response.status
    await response.body?.cancel()
    throw error
  }

  const data = await response.json()

  if (typeof data.name !== 'string' || !data.name.startsWith('auth_tokens/')) {
    throw new Error('Google devolvio una credencial con formato inesperado.')
  }

  return {
    token: data.name,
    expireTime: data.expireTime ?? null,
    model: 'gemini-3.5-live-translate-preview',
    targetLanguage: 'en',
  }
}

const server = http.createServer(async (req, res) => {
  if (shuttingDown) {
    respond(res, 503, { error: 'Backend cerrandose.' })
    return
  }

  // Este backend lo utilizara Electron main, no una pagina web.
  // No se habilita CORS y se rechazan solicitudes con Origin.
  if (req.headers.origin !== undefined) {
    respond(res, 403, { error: 'Origen web no permitido.' })
    return
  }

  if (req.headers.authorization !== `Bearer ${localSecret}`) {
    respond(res, 401, { error: 'Solicitud local no autorizada.' })
    return
  }

  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    Number(req.headers['content-length'] ?? 0) !== 0

  if (hasBody) {
    respond(res, 400, { error: 'Este endpoint no acepta contenido.' })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    respond(res, 200, { ok: true })
    return
  }

  if (req.method !== 'POST' || req.url !== '/session') {
    respond(res, 404, { error: 'Ruta no disponible.' })
    return
  }

  if (creatingSession) {
    respond(res, 409, { error: 'Ya hay una solicitud en curso.' })
    return
  }

  creatingSession = true

  try {
    const session = await createTemporaryToken()

    if (!res.destroyed) {
      respond(res, 200, session)
    }
  } catch (error) {
    if (!res.destroyed) {
      respond(res, 502, {
        error: 'No se pudo crear la credencial temporal.',
        upstreamStatus: Number.isInteger(error?.upstreamStatus)
          ? error.upstreamStatus
          : null,
      })
    }
  } finally {
    creatingSession = false
  }
})

server.requestTimeout = 30000
server.headersTimeout = 10000

function shutdown() {
  shuttingDown = true
  server.close()
  server.closeAllConnections()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('disconnect', shutdown)

server.on('error', () => {
  console.error('No se pudo iniciar el backend local.')
  process.exitCode = 1
})

server.listen(0, '127.0.0.1', async () => {
  const address = server.address()

  if (!address || typeof address === 'string') {
    shutdown()
    process.exitCode = 1
    return
  }

  const baseUrl = `http://127.0.0.1:${address.port}`

  if (process.argv.includes('--issue')) {
    if (!process.send) {
      console.error('Este modo requiere un canal privado con Electron.')
      process.exitCode = 1
      shutdown()
      return
    }

    try {
      const credential = await createTemporaryToken()

      process.send(
        { type: 'credential', ...credential },
        () => {
          shutdown()

          if (process.connected) {
            process.disconnect()
          }
        },
      )
    } catch (error) {
      process.send(
        {
          type: 'credential-error',
          status: Number.isInteger(error?.upstreamStatus)
            ? error.upstreamStatus
            : null,
        },
        () => {
          shutdown()

          if (process.connected) {
            process.disconnect()
          }
        },
      )
    }

    return
  }

  if (process.argv.includes('--check')) {
    try {
      const response = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localSecret}`,
        },
        signal: AbortSignal.timeout(25000),
      })

      const result = await response.json()

      if (!response.ok) {
        console.error(
          'PRUEBA FALLIDA. Estado local:',
          response.status,
          'Estado de Google:',
          result.upstreamStatus ?? 'no disponible',
        )
        process.exitCode = 1
      } else if (typeof result.token === 'string') {
        console.log('BACKEND OK: credencial temporal creada.')
        console.log('Destino configurado: ingles.')
        console.log('No se envio audio ni se mostro ninguna credencial.')
      } else {
        console.error('PRUEBA FALLIDA: respuesta inesperada.')
        process.exitCode = 1
      }
    } catch {
      console.error('PRUEBA FALLIDA: conexion o tiempo de espera.')
      process.exitCode = 1
    } finally {
      shutdown()
    }

    return
  }

  if (process.send) {
    process.send({
      type: 'backend-ready',
      baseUrl,
      localSecret,
    })
  } else {
    console.log('Backend local iniciado. Ctrl+C para detener.')
    console.log('Utiliza --check para ejecutar la comprobacion.')
  }
})
