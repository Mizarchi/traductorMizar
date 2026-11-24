export type MeetingTranslationState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'stopping'
  | 'error'

export type MeetingCaptureSource =
  | { mode: 'device'; deviceId: string }
  | { mode: 'system-loopback'; sourceId: string }

interface MeetingTranslationHandlers {
  onState: (state: MeetingTranslationState) => void
  onText: (text: string) => void
  onLevel: (level: number) => void
  onError: (message: string) => void
}

interface ServerMessage {
  setupComplete?: object
  error?: { code?: number }
  goAway?: object
  serverContent?: {
    outputTranscription?: { text?: string }
  }
}

const SESSION_LIMIT_MS = 120000

function encodePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)

  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    const pcm = Math.round(value * (value < 0 ? 32768 : 32767))
    view.setInt16(i * 2, pcm, true)
  }

  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function measureLevel(samples: Float32Array): number {
  let sum = 0

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]
    sum += sample * sample
  }

  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return Math.min(100, Math.round(rms * 260))
}

/**
 * Segunda sesion independiente de Gemini Live Translate (ingles -> espanol).
 * Solo extrae subtitulos (outputTranscription) y descarta el audio entrante
 * del proveedor sin crear ningun grafo de reproduccion local.
 */
export class MeetingTranslationProvider {
  private generation = 0
  private state: MeetingTranslationState = 'idle'

  private socket: WebSocket | null = null
  private stream: MediaStream | null = null
  private inputContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null

  private cancelSetup: (() => void) | null = null
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private trackCleanups: Array<() => void> = []

  constructor(private readonly handlers: MeetingTranslationHandlers) {}

  start(capture: MeetingCaptureSource): void {
    if (
      this.state === 'connecting' ||
      this.state === 'listening' ||
      this.state === 'stopping'
    ) {
      return
    }

    const generation = ++this.generation
    this.setState('connecting')
    void this.run(capture, generation)
  }

  stop(): void {
    this.generation += 1
    this.setState('stopping')
    this.release()
    this.handlers.onLevel(0)
    this.setState('idle')
  }

  private async run(
    capture: MeetingCaptureSource,
    generation: number,
  ): Promise<void> {
    try {
      const stream = await this.openCaptureStream(capture, generation)

      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      this.stream = stream

      for (const track of stream.getAudioTracks()) {
        const onEnded = (): void => {
          if (generation === this.generation) {
            this.fail('La fuente de audio de la reunion se desconecto o se detuvo.')
          }
        }
        track.addEventListener('ended', onEnded)
        this.trackCleanups.push(() => track.removeEventListener('ended', onEnded))
      }

      const credential = await window.audioDiagnostic.createGeminiSession('es')

      if (generation !== this.generation) return

      const socket = await this.connectSocket(credential.token, credential.model, generation)

      if (generation !== this.generation) return

      const input = new AudioContext({ sampleRate: 16000 })
      this.inputContext = input

      if (input.sampleRate !== 16000) {
        throw new Error('No se pudo abrir el contexto de captura entrante a 16000 Hz.')
      }

      await input.resume()

      if (generation !== this.generation) return

      const sourceNode = input.createMediaStreamSource(stream)
      const processor = input.createScriptProcessor(2048, 1, 1)
      const silentGain = input.createGain()
      silentGain.gain.value = 0

      this.sourceNode = sourceNode
      this.processor = processor
      this.silentGain = silentGain

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (generation !== this.generation) return
        if (socket.readyState !== WebSocket.OPEN) return

        const samples = event.inputBuffer.getChannelData(0)
        this.handlers.onLevel(measureLevel(samples))

        try {
          socket.send(JSON.stringify({
            realtimeInput: {
              audio: {
                data: encodePcm(samples),
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          }))
        } catch {
          if (generation === this.generation) {
            this.fail('No se pudo enviar el audio de la reunion a Gemini.')
          }
        }
      }

      sourceNode.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(input.destination)

      if (generation !== this.generation) return

      this.setState('listening')

      this.sessionTimer = setTimeout(() => {
        if (generation === this.generation) {
          this.stop()
        }
      }, SESSION_LIMIT_MS)
    } catch (error) {
      if (generation !== this.generation) return

      this.fail(
        error instanceof Error
          ? error.message
          : 'No se pudo iniciar la traduccion entrante de la reunion.',
      )
    }
  }

  private async openCaptureStream(
    capture: MeetingCaptureSource,
    generation: number,
  ): Promise<MediaStream> {
    if (capture.mode === 'device') {
      if (!capture.deviceId) {
        throw new Error('Selecciona una entrada virtual dedicada para la reunion.')
      }

      await window.audioDiagnostic.armMicrophoneRequest()

      if (generation !== this.generation) {
        throw new Error('Inicio cancelado.')
      }

      return navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: capture.deviceId },
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      })
    }

    if (!capture.sourceId) {
      throw new Error('Selecciona explicitamente una fuente de captura de sistema.')
    }

    await window.audioDiagnostic.armDisplayAudioRequest(capture.sourceId)

    if (generation !== this.generation) {
      throw new Error('Inicio cancelado.')
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    })

    // Descartamos las pistas de video de inmediato: solo necesitamos el audio loopback.
    for (const track of displayStream.getVideoTracks()) {
      track.stop()
      displayStream.removeTrack(track)
    }

    if (displayStream.getAudioTracks().length === 0) {
      displayStream.getTracks().forEach((track) => track.stop())
      throw new Error(
        'Windows/Electron no entrego pista de audio loopback para la fuente elegida. Usa una ruta virtual dedicada.',
      )
    }

    return displayStream
  }

  private async connectSocket(
    token: string,
    model: string,
    generation: number,
  ): Promise<WebSocket> {
    const endpoint =
      'wss://generativelanguage.googleapis.com/ws/' +
      'google.ai.generativelanguage.v1beta.' +
      'GenerativeService.BidiGenerateContentConstrained'

    const socket = new WebSocket(
      `${endpoint}?access_token=${encodeURIComponent(token)}`,
    )

    this.socket = socket

    let messageQueue = Promise.resolve()

    await new Promise<void>((resolve, reject) => {
      let ready = false

      const timer = setTimeout(() => {
        reject(new Error('Gemini (EN -> ES) no confirmo la sesion a tiempo.'))
      }, 20000)

      const finishSetup = (): void => {
        clearTimeout(timer)
        this.cancelSetup = null
      }

      this.cancelSetup = () => {
        finishSetup()
        reject(new Error('Inicio cancelado.'))
      }

      socket.onopen = () => {
        if (generation !== this.generation) return

        socket.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            generationConfig: {
              // El modelo Live Translate requiere AUDIO aunque no lo reproduzcamos;
              // los subtitulos llegan en serverContent.outputTranscription.
              responseModalities: ['AUDIO'],
              translationConfig: {
                targetLanguageCode: 'es',
                echoTargetLanguage: false,
              },
            },
          },
        }))
      }

      socket.onmessage = (event: MessageEvent) => {
        messageQueue = messageQueue.then(async () => {
          if (generation !== this.generation) return

          const text = typeof event.data === 'string'
            ? event.data
            : await (event.data as Blob).text()

          if (generation !== this.generation) return

          const message = JSON.parse(text) as ServerMessage

          if (message.error) {
            throw new Error(
              `Gemini (EN -> ES) rechazo la sesion. Codigo: ${
                message.error.code ?? 'no disponible'
              }.`,
            )
          }

          if ('setupComplete' in message && !ready) {
            ready = true
            finishSetup()
            resolve()
          }

          if (message.goAway) {
            throw new Error(
              'Gemini (EN -> ES) aviso que la sesion debe cerrarse. Deten y reinicia.',
            )
          }

          const transcript = message.serverContent?.outputTranscription?.text

          if (typeof transcript === 'string' && transcript.length > 0) {
            this.handlers.onText(transcript)
          }
          // El audio PCM de salida (modelTurn.parts[].inlineData) se ignora a proposito:
          // esta primera version solo muestra subtitulos en espanol.
        }).catch((error: unknown) => {
          if (generation !== this.generation) return

          const message = error instanceof Error
            ? error.message
            : 'No se pudo procesar la respuesta de Gemini (EN -> ES).'

          if (!ready) {
            finishSetup()
            reject(new Error(message))
          } else {
            this.fail(message)
          }
        })
      }

      socket.onerror = () => {
        if (generation !== this.generation) return

        const message =
          'Fallo de conexion con Gemini (EN -> ES). Revisa red, acceso y cuota.'

        if (!ready) {
          finishSetup()
          reject(new Error(message))
        } else {
          this.fail(message)
        }
      }

      socket.onclose = (event: CloseEvent) => {
        if (generation !== this.generation) return

        const message = `Gemini (EN -> ES) cerro la conexion. Codigo: ${event.code}.`

        if (!ready) {
          finishSetup()
          reject(new Error(message))
        } else {
          this.fail(message)
        }
      }
    })

    return socket
  }

  private fail(message: string): void {
    this.generation += 1
    this.release()
    this.handlers.onLevel(0)
    this.setState('error')
    this.handlers.onError(message)
  }

  private setState(state: MeetingTranslationState): void {
    this.state = state
    this.handlers.onState(state)
  }

  private release(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer)
      this.sessionTimer = null
    }

    const cancelSetup = this.cancelSetup
    this.cancelSetup = null
    cancelSetup?.()

    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }

    this.sourceNode?.disconnect()
    this.sourceNode = null

    this.silentGain?.disconnect()
    this.silentGain = null

    for (const cleanup of this.trackCleanups) {
      cleanup()
    }
    this.trackCleanups = []

    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null

    if (this.inputContext) {
      void this.inputContext.close().catch(() => {})
      this.inputContext = null
    }

    if (this.socket) {
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null

      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({
            realtimeInput: { audioStreamEnd: true },
          }))
        }
      } catch {}

      try {
        this.socket.close()
      } catch {}

      this.socket = null
    }
  }
}
