export type TranslationState =
  | 'idle'
  | 'connecting'
  | 'capturing'
  | 'translating'
  | 'playing'
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
    turnComplete?: boolean
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

const SAMPLE_RATE = 16000
const MIN_SAMPLES = 1600
const MAX_SAMPLES = SAMPLE_RATE * 60
const SEND_FRAME = 1600
const SEND_INTERVAL_MS = 75
const CAPTURE_TAIL_MS = 400
const TRAILING_SILENCE_SAMPLES = SAMPLE_RATE * 2
const PLAYBACK_IDLE_GRACE_MS = 2500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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
  private destination: MediaStreamAudioDestinationNode | null = null
  private outputId = ''

  private playback = new Set<AudioBufferSourceNode>()
  private nextPlaybackTime = 0

  private cancelSetup: (() => void) | null = null
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private idleFinishTimer: ReturnType<typeof setTimeout> | null = null
  private trackCleanups: Array<() => void> = []

  private sessionTask: Promise<void> | null = null
  private options: StartOptions | null = null

  private capturePhase: 'off' | 'opening' | 'live' | 'closing' = 'off'
  private captureEpoch = 0
  private chunks: Float32Array[] = []
  private sampleCount = 0
  private turnEnded = false
  private sendingInput = false
  private receivedOutput = false

  constructor(private readonly handlers: TranslationHandlers) {}

  startCapture(options: StartOptions): void {
    if (
      this.capturePhase !== 'off' ||
      this.state === 'connecting' ||
      this.state === 'translating' ||
      this.state === 'playing' ||
      this.state === 'stopping'
    ) {
      return
    }

    if (!options.inputId || !options.outputId) {
      this.handlers.onError('Selecciona un microfono y una salida.')
      return
    }

    this.options = options
    this.capturePhase = 'opening'
    const epoch = ++this.captureEpoch
    this.chunks = []
    this.sampleCount = 0
    this.turnEnded = false
    this.sendingInput = false
    this.receivedOutput = false
    this.clearIdleFinishTimer()
    this.setState('capturing')

    void this.ensureSession(options).catch(() => {})
    void this.openCapture(options, epoch)
  }

  stopCaptureAndTranslate(): void {
    if (this.capturePhase === 'off' || this.capturePhase === 'closing') return

    const wasLive = this.capturePhase === 'live'
    const epoch = this.captureEpoch
    const generation = this.generation

    this.capturePhase = 'closing'
    this.setState('translating')

    const finalize = (): void => {
      this.releaseTimer = null
      if (this.captureEpoch !== epoch || this.generation !== generation) return

      this.capturePhase = 'off'
      this.captureEpoch += 1

      const chunks = this.chunks
      this.chunks = []
      this.sampleCount = 0

      void this.finishCapture(chunks, generation)
    }

    if (wasLive) {
      this.releaseTimer = setTimeout(finalize, CAPTURE_TAIL_MS)
    } else {
      finalize()
    }
  }

  stop(): void {
    this.generation += 1
    this.setState('stopping')
    this.release()
    this.setState('idle')
  }

  private async openCapture(
    options: StartOptions,
    epoch: number,
  ): Promise<void> {
    const generation = this.generation

    try {
      await window.audioDiagnostic.armMicrophoneRequest()

      if (!this.captureIsCurrent(epoch, generation)) return

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: options.inputId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })

      if (!this.captureIsCurrent(epoch, generation)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      this.stream = stream

      for (const track of stream.getTracks()) {
        const onEnded = (): void => {
          if (this.captureIsCurrent(epoch, generation)) {
            this.fail('El microfono se desconecto.')
          }
        }
        track.addEventListener('ended', onEnded)
        this.trackCleanups.push(() => track.removeEventListener('ended', onEnded))
      }

      const input = new AudioContext({ sampleRate: 16000 })
      this.inputContext = input

      if (input.sampleRate !== 16000) {
        throw new Error(
          'No se pudo abrir el contexto de entrada a 16000 Hz.',
        )
      }

      await input.resume()

      if (!this.captureIsCurrent(epoch, generation)) {
        this.detachInputGraph()
        return
      }

      const source = input.createMediaStreamSource(stream)

      // ScriptProcessor sigue siendo el grafo de esta beta.
      // Se destruye por completo antes de enviar audio a Gemini.
      const processor = input.createScriptProcessor(2048, 1, 1)
      const silentGain = input.createGain()

      this.source = source
      this.processor = processor
      this.silentGain = silentGain
      silentGain.gain.value = 0

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.captureIsCurrent(epoch, generation)) return

        const samples = event.inputBuffer.getChannelData(0)
        const copy = new Float32Array(samples.length)
        copy.set(samples)
        this.chunks.push(copy)
        this.sampleCount += copy.length

        if (this.sampleCount >= MAX_SAMPLES) {
          this.stopCaptureAndTranslate()
        }
      }

      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(input.destination)

      if (!this.captureIsCurrent(epoch, generation)) {
        this.detachInputGraph()
        return
      }

      this.capturePhase = 'live'
    } catch (error) {
      if (!this.captureIsCurrent(epoch, generation)) return

      this.fail(
        error instanceof Error
          ? error.message
          : 'No se pudo abrir el microfono.',
      )
    }
  }

  private async finishCapture(
    chunks: Float32Array[],
    generation: number,
  ): Promise<void> {
    await this.teardownCapture()

    if (generation !== this.generation || this.state !== 'translating') return

    const total = chunks.reduce((count, chunk) => count + chunk.length, 0)

    if (total < MIN_SAMPLES) {
      this.setState('idle')
      return
    }

    const options = this.options

    if (!options) {
      this.fail('No hay dispositivos seleccionados.')
      return
    }

    try {
      await this.ensureSession(options)
    } catch (error) {
      if (generation !== this.generation || this.state !== 'translating') return

      this.fail(
        error instanceof Error
          ? error.message
          : 'No se pudo preparar Gemini.',
      )
      return
    }

    if (generation !== this.generation || this.state !== 'translating') return

    const socket = this.socket

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.fail('La sesion de Gemini no esta lista.')
      return
    }

    if (!this.destination) {
      this.fail('La salida de audio no esta lista.')
      return
    }

    this.turnEnded = false
    this.sendingInput = true
    this.receivedOutput = false
    this.clearIdleFinishTimer()
    this.armTurnTimer(generation)

    const payloadChunks = [
      ...chunks,
      new Float32Array(TRAILING_SILENCE_SAMPLES),
    ]

    try {
      let chunkIndex = 0
      let chunkOffset = 0

      while (chunkIndex < payloadChunks.length) {
        if (generation !== this.generation) return
        if (socket.readyState !== WebSocket.OPEN) return

        const frame = new Float32Array(SEND_FRAME)
        let written = 0

        while (written < SEND_FRAME && chunkIndex < payloadChunks.length) {
          const chunk = payloadChunks[chunkIndex]

          if (chunkOffset >= chunk.length) {
            chunkIndex += 1
            chunkOffset = 0
            continue
          }

          const take = Math.min(SEND_FRAME - written, chunk.length - chunkOffset)
          frame.set(chunk.subarray(chunkOffset, chunkOffset + take), written)
          written += take
          chunkOffset += take

          if (chunkOffset >= chunk.length) {
            chunkIndex += 1
            chunkOffset = 0
          }
        }

        if (written === 0) break

        socket.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: encodePcm(frame.subarray(0, written)),
              mimeType: 'audio/pcm;rate=16000',
            },
          },
        }))

        if (chunkIndex < payloadChunks.length) {
          await sleep(SEND_INTERVAL_MS)
        }
      }

      if (generation !== this.generation) return
      if (socket.readyState !== WebSocket.OPEN) return

      socket.send(JSON.stringify({
        realtimeInput: { audioStreamEnd: true },
      }))

      this.sendingInput = false
      this.armTurnTimer(generation)
      this.finishTurnIfIdle()
      this.scheduleIdleFinishIfNeeded(generation)
    } catch {
      this.sendingInput = false
      if (generation === this.generation) {
        this.fail('No se pudo enviar el audio a Gemini.')
      }
    }
  }

  private ensureSession(options: StartOptions): Promise<void> {
    this.options = options

    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.outputContext &&
      this.player &&
      this.destination
    ) {
      return this.applyOutput(options.outputId)
    }

    if (!this.sessionTask) {
      const generation = this.generation

      this.sessionTask = this.connect(options, generation).then(
        () => {
          if (this.generation !== generation) {
            this.sessionTask = null
          }
        },
        (error: unknown) => {
          this.sessionTask = null

          if (this.generation === generation) {
            this.fail(
              error instanceof Error
                ? error.message
                : 'No se pudo preparar Gemini.',
            )
          }

          throw error
        },
      )
    }

    return this.sessionTask
  }

  private async applyOutput(outputId: string): Promise<void> {
    const player = this.player

    if (!player || this.outputId === outputId) return

    await window.audioDiagnostic.armOutputRequest()
    await player.setSinkId(outputId)
    if (player.sinkId !== outputId) {
      throw new Error('No se pudo confirmar la salida de audio seleccionada.')
    }
    this.outputId = outputId
  }

  private async connect(
    options: StartOptions,
    generation: number,
  ): Promise<void> {
    await window.audioDiagnostic.armOutputRequest()

    if (generation !== this.generation) return

    const output = new AudioContext({ sampleRate: 24000 })
    this.outputContext = output
    await output.resume()

    if (generation !== this.generation) return

    const destination = output.createMediaStreamDestination()
    const player = new Audio()

    this.destination = destination
    this.outputStream = destination.stream
    this.player = player
    player.srcObject = destination.stream

    await player.setSinkId(options.outputId)
    if (player.sinkId !== options.outputId) {
      throw new Error('No se pudo enrutar la reproduccion a la salida elegida.')
    }
    this.outputId = options.outputId

    if (generation !== this.generation) return

    await player.play()

    if (generation !== this.generation) return

    const credential = await window.audioDiagnostic.createGeminiSession()

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
            this.receivedOutput = true
            this.clearIdleFinishTimer()
            this.armTurnTimer(generation)
            this.handlers.onText(transcript)
          }

          for (const part of content?.modelTurn?.parts ?? []) {
            const inline = part.inlineData

            if (
              typeof inline?.data === 'string' &&
              inline.mimeType?.startsWith('audio/pcm')
            ) {
              this.receivedOutput = true
              this.clearIdleFinishTimer()
              this.armTurnTimer(generation)
              this.playPcm(inline.data, generation)
            }
          }

          if (content?.turnComplete) {
            this.turnEnded = true
            this.clearIdleFinishTimer()
            this.finishTurnIfIdle()
          } else if (typeof transcript === 'string') {
            this.scheduleIdleFinishIfNeeded(generation)
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

        const message = `Gemini cerro la conexion. Codigo: ${event.code}.`

        if (!ready) {
          finishSetup()
          reject(new Error(message))
        } else {
          this.fail(message)
        }
      }
    })

    if (generation !== this.generation) return
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

  private captureIsCurrent(epoch: number, generation: number): boolean {
    return epoch === this.captureEpoch && generation === this.generation
  }

  private armTurnTimer(generation: number): void {
    if (this.turnTimer) clearTimeout(this.turnTimer)

    this.turnTimer = setTimeout(() => {
      if (
        generation === this.generation &&
        (this.state === 'translating' || this.state === 'playing')
      ) {
        this.fail('Gemini no respondio a tiempo.')
      }
    }, 45000)
  }

  private clearIdleFinishTimer(): void {
    if (this.idleFinishTimer) {
      clearTimeout(this.idleFinishTimer)
      this.idleFinishTimer = null
    }
  }

  private scheduleIdleFinishIfNeeded(generation: number): void {
    if (generation !== this.generation) return
    if (this.sendingInput || !this.receivedOutput) return
    if (this.playback.size > 0) return
    if (this.state !== 'translating' && this.state !== 'playing') return

    this.clearIdleFinishTimer()

    this.idleFinishTimer = setTimeout(() => {
      this.idleFinishTimer = null
      if (generation !== this.generation) return
      if (this.sendingInput || this.playback.size > 0) return
      if (this.state !== 'translating' && this.state !== 'playing') return

      this.turnEnded = true
      this.finishTurnIfIdle()
    }, PLAYBACK_IDLE_GRACE_MS)
  }

  private finishTurnIfIdle(): void {
    if (!this.turnEnded) return
    if (this.sendingInput) return
    if (this.playback.size > 0) return
    if (this.state !== 'translating' && this.state !== 'playing') return

    this.turnEnded = false
    this.receivedOutput = false
    this.clearIdleFinishTimer()

    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }

    this.setState('idle')
  }

  private playPcm(base64: string, generation: number): void {
    if (this.state !== 'translating' && this.state !== 'playing') return

    const context = this.outputContext
    const destination = this.destination

    if (!context || !destination) return

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
      this.finishTurnIfIdle()
      this.scheduleIdleFinishIfNeeded(generation)
    }

    const start = Math.max(
      context.currentTime + 0.03,
      this.nextPlaybackTime,
    )

    source.start(start)
    this.nextPlaybackTime = start + buffer.duration

    if (this.state === 'translating') {
      this.setState('playing')
    }
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

  private detachInputGraph(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }

    this.source?.disconnect()
    this.source = null

    this.silentGain?.disconnect()
    this.silentGain = null

    for (const cleanup of this.trackCleanups) {
      cleanup()
    }
    this.trackCleanups = []

    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  private async teardownCapture(): Promise<void> {
    this.detachInputGraph()

    const input = this.inputContext
    this.inputContext = null

    if (input && input.state !== 'closed') {
      await input.close().catch(() => {})
    }
  }

  private release(): void {
    this.capturePhase = 'off'
    this.captureEpoch += 1
    this.chunks = []
    this.sampleCount = 0
    this.turnEnded = false
    this.sendingInput = false
    this.receivedOutput = false
    this.sessionTask = null
    this.options = null
    this.outputId = ''

    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }

    this.clearIdleFinishTimer()

    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }

    const cancelSetup = this.cancelSetup
    this.cancelSetup = null
    cancelSetup?.()

    this.detachInputGraph()

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

    this.destination = null

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
