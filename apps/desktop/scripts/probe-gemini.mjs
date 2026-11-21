const key = process.env.GEMINI_API_KEY?.trim()

if (!key) {
  console.error('Falta GEMINI_API_KEY en el archivo privado.')
  process.exit(1)
}

const model = 'gemini-3.5-live-translate-preview'
const endpoint =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

let finished = false
let socket
let timer

function finish(ok, message) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  console.log(message)

  try {
    socket?.close()
  } catch {}

  process.exitCode = ok ? 0 : 1
  setTimeout(() => process.exit(ok ? 0 : 1), 500)
}

function safeMessage(value) {
  return String(value ?? '')
    .split(key).join('[CLAVE OCULTA]')
    .replace(/AIza[0-9A-Za-z_-]+/g, '[CLAVE OCULTA]')
    .slice(0, 1200)
}

try {
  socket = new WebSocket(`${endpoint}?key=${encodeURIComponent(key)}`)

  timer = setTimeout(() => {
    finish(false, 'Tiempo agotado: no se confirmo la sesion en 25 segundos.')
  }, 25000)

  socket.addEventListener('open', () => {
    console.log('Conexion abierta. Comprobando configuracion de traduccion...')

    socket.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
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
    }))
  })

  socket.addEventListener('message', async (event) => {
    try {
      const text = typeof event.data === 'string'
        ? event.data
        : await event.data.text()

      const message = JSON.parse(text)

      if (message.error) {
        finish(false,
          `API rechazo la solicitud: ${message.error.code ?? ''} ` +
          safeMessage(message.error.message))
        return
      }

      if ('setupComplete' in message) {
        finish(true,
          'ACCESO CONFIRMADO: sesion de traduccion hacia ingles aceptada. ' +
          'No se envio audio.')
      }
    } catch {
      finish(false, 'No se pudo interpretar la respuesta del servidor.')
    }
  })

  socket.addEventListener('error', () => {
    finish(false,
      'Error de conexion WebSocket. Revisa internet y la respuesta de cierre si aparece.')
  })

  socket.addEventListener('close', (event) => {
    if (!finished) {
      finish(false,
        `Conexion cerrada. Codigo: ${event.code}. Motivo: ` +
        safeMessage(event.reason))
    }
  })
} catch {
  finish(false, 'No se pudo iniciar la conexion. No se mostraran credenciales.')
}
