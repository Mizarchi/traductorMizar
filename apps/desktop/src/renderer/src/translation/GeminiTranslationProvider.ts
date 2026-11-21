export type TranslationState =
  | 'idle'
  | 'connecting'
  | 'translating'
  | 'stopping'
  | 'error'

interface TranslationHandlers {
  onState: (state: TranslationState) => void
  onText: (text: string) => void
  onError: (message: string) => void
}

interface StartOptions {
  inputId: string
  outputId: string
}

interface ServerMessage {
  setupComplete?: object
  error?: { code?: number }
  goAway?: object
  serverContent?: {
    interrupted?: boolean
    outputTranscription?: { text?: string }
    modelTurn?: {
      parts?: Array<{
        inlineData?: {
          mimeType?: string
          data?: string
        }
      }>
    }
  }
}

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

export class GeminiTranslationProvider {
  private generation = 0
  private state: TranslationState = 'idle'

  private socket: WebSocket | null = null
  private stream: MediaStream | null = null

  private inputContext: AudioContext | null = null
  private outputContext: AudioContext | null = null

  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private silentGain: GainNode | null = null

  private outputStream: MediaStream | null = null
  private player: HTMLAudioElement | null = null

  private playback = new Set<AudioBufferSourceNode>()
  private nextPlaybackTime = 0

  private cancelSetup: (() => void) | null = null
  private testTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly handlers: TranslationHandlers) {}

  async start(options: StartOptions): Promise<void> {
    if (this.state === 'connecting' || this.state === 'translating') {
      return
    }

    if (!options.inputId || !options.outputId) {
      this.handlers.onError('Selecciona un microfono y una salida.')
      return
    }

    this.release()
    const generation = ++this.generation
    this.setState('connecting')

    try {
      await window.audioDiagnostic.armMicrophoneRequest()

      if (generation !== this.generation) return

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: options.inputId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })

      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      this.stream = stream

      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (generation === this.generation) {
            this.fail('El microfono se desconecto.')
          }
        })
      }

      const input = new AudioContext({ sampleRate: 16000 })
      const output = new AudioContext({ sampleRate: 24000 })

      this.inputContext = input
      this.outputContext = output

      if (input.sampleRate !== 16000) {
        throw new Error(
          'No se pudo abrir el contexto de entrada a 16000 Hz.',
        )
      }

      await Promise.all([input.resume(), output.resume()])

      if (generation !== this.generation) return

      await window.audioDiagnostic.armOutputRequest()

      if (generation !== this.generation) return

      const destination = output.createMediaStreamDestination()
      const player = new Audio()

      this.outputStream = destination.stream
      this.player = player
      player.srcObject = destination.stream

      await player.setSinkId(options.outputId)

      if (generation !== this.generation) return

      await player.play()

      if (generation !== this.generation) return

      const credential =
        await window.audioDiagnostic.createGeminiSession()

      if (generation !== this.generation) return

      const endpoint =
        'wss://generativelanguage.googleapis.com/ws/' +
        'google.ai.generativelanguage.v1beta.' +
        'GenerativeService.BidiGenerateContentConstrained'

      const socket = new WebSocket(
        `${endpoint}?access_token=${encodeURIComponent(credential.token)}`,
      )

      this.socket = socket

      let messageQueue = Promise.resolve()

      await new Promise<void>((resolve, reject) => {
        let ready = false

        const timer = setTimeout(() => {
          reject(new Error('Gemini no confirmo la sesion a tiempo.'))
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
              model: `models/${credential.model}`,
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
                `Gemini rechazo la sesion. Codigo: ${
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
                'Gemini aviso que la sesion debe cerrarse. Deten y reinicia.',
              )
            }

            const content = message.serverContent

            if (content?.interrupted) {
              this.clearPlayback()
            }

            const transcript = content?.outputTranscription?.text

            if (typeof transcript === 'string') {
              this.handlers.onText(transcript)
            }

            for (const part of content?.modelTurn?.parts ?? []) {
              const inline = part.inlineData

              if (
                typeof inline?.data === 'string' &&
                inline.mimeType?.startsWith('audio/pcm')
              ) {
                this.playPcm(inline.data, destination)
              }
            }
          }).catch((error: unknown) => {
            if (generation !== this.generation) return

            const message = error instanceof Error
              ? error.message
              : 'No se pudo procesar la respuesta de Gemini.'

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
            'Fallo de conexion con Gemini. Revisa red, acceso y cuota.'

          if (!ready) {
            finishSetup()
            reject(new Error(message))
          } else {
            this.fail(message)
          }
        }

        socket.onclose = (event: CloseEvent) => {
          if (generation !== this.generation) return

          const message =
            `Gemini cerro la conexion. Codigo: ${event.code}.`

          if (!ready) {
            finishSetup()
            reject(new Error(message))
          } else {
            this.fail(message)
          }
        }
      })

      if (generation !== this.generation) return

      const source = input.createMediaStreamSource(stream)

      // Implementacion inicial para la beta.
      // Migrar a AudioWorklet antes de una version de produccion.
      const processor = input.createScriptProcessor(2048, 1, 1)
      const silentGain = input.createGain()

      this.source = source
      this.processor = processor
      this.silentGain = silentGain

      silentGain.gain.value = 0

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (
          generation !== this.generation ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return
        }

        if (socket.bufferedAmount > 1024 * 1024) {
          this.fail('La red no esta enviando el audio suficientemente rapido.')
          return
        }

        try {
          const samples = event.inputBuffer.getChannelData(0)

          socket.send(JSON.stringify({
            realtimeInput: {
              audio: {
                data: encodePcm(samples),
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          }))
        } catch {
          this.fail('No se pudo enviar el audio del microfono.')
        }
      }

      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(input.destination)

      this.setState('translating')

      // Limite deliberado para las primeras pruebas.
      this.testTimer = setTimeout(() => {
        if (generation === this.generation) {
          this.stop()
        }
      }, 120000)
    } catch (error) {
      if (generation !== this.generation) return

      this.fail(
        error instanceof Error
          ? error.message
          : 'No se pudo iniciar la traduccion.',
      )
    }
  }

  stop(): void {
    this.generation += 1
    this.setState('stopping')
    this.release()
    this.setState('idle')
  }

  private fail(message: string): void {
    this.generation += 1
    this.release()
    this.setState('error')
    this.handlers.onError(message)
  }

  private setState(state: TranslationState): void {
    this.state = state
    this.handlers.onState(state)
  }

  private playPcm(
    base64: string,
    destination: MediaStreamAudioDestinationNode,
  ): void {
    const context = this.outputContext

    if (!context) return

    const binary = atob(base64)

    if (binary.length === 0 || binary.length % 2 !== 0) return

    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }

    const view = new DataView(bytes.buffer)
    const buffer = context.createBuffer(1, bytes.length / 2, 24000)
    const channel = buffer.getChannelData(0)

    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 32768
    }

    if (this.nextPlaybackTime - context.currentTime > 15) {
      throw new Error('Se acumulo demasiado audio pendiente de reproducir.')
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(destination)

    this.playback.add(source)

    source.onended = () => {
      this.playback.delete(source)
      source.disconnect()
    }

    const start = Math.max(
      context.currentTime + 0.03,
      this.nextPlaybackTime,
    )

    source.start(start)
    this.nextPlaybackTime = start + buffer.duration
  }

  private clearPlayback(): void {
    for (const source of this.playback) {
      source.onended = null

      try {
        source.stop()
      } catch {}

      source.disconnect()
    }

    this.playback.clear()
    this.nextPlaybackTime = 0
  }

  private release(): void {
    if (this.testTimer) {
      clearTimeout(this.testTimer)
      this.testTimer = null
    }

    const cancelSetup = this.cancelSetup
    this.cancelSetup = null
    cancelSetup?.()

    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }

    this.source?.disconnect()
    this.source = null

    this.silentGain?.disconnect()
    this.silentGain = null

    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null

    if (this.socket) {
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null

      try {
        this.socket.close()
      } catch {}

      this.socket = null
    }

    this.clearPlayback()

    if (this.player) {
      this.player.pause()
      this.player.srcObject = null
      this.player = null
    }

    this.outputStream?.getTracks().forEach((track) => track.stop())
    this.outputStream = null

    if (this.inputContext) {
      void this.inputContext.close().catch(() => {})
      this.inputContext = null
    }

    if (this.outputContext) {
      void this.outputContext.close().catch(() => {})
      this.outputContext = null
    }
  }
}