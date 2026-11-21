import { levelPercent } from './level'

const TONE_MS = 900
const TONE_HZ = 440

export interface ToneSuccess {
  ok: true
  routedTo: 'selected' | 'default'
  sinkId: string
  deviceLabel: string
}

export interface ToneFailure {
  ok: false
  error: unknown
}

export type ToneResult = ToneSuccess | ToneFailure

interface MonitorHandlers {
  onLevel: (percent: number) => void
  onEnded: () => void
}

/**
 * Dueña de las pistas y contextos de esta página.
 * El medidor no conecta el micrófono a los altavoces.
 */
export class LocalAudioSession {
  private monitorGeneration = 0
  private micStream: MediaStream | null = null
  private micContext: AudioContext | null = null
  private meterFrame = 0
  private toneContext: AudioContext | null = null
  private toneElement: HTMLAudioElement | null = null
  private toneStream: MediaStream | null = null
  private toneTimer = 0
  private toneRun = 0
  private finishToneWait: (() => void) | null = null

  async openMonitor(
    deviceId: string,
    handlers: MonitorHandlers,
  ): Promise<boolean> {
    this.stopMonitoring()
    const generation = this.monitorGeneration

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    })

    if (this.monitorGeneration !== generation) {
      this.stopStream(stream)
      return false
    }

    let context: AudioContext | null = null

    try {
      context = new AudioContext()

      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      this.micStream = stream
      this.micContext = context

      if (context.state === 'suspended') {
        await context.resume()
      }

      if (this.monitorGeneration !== generation) {
        this.stopStream(stream)

        if (context.state !== 'closed') {
          await context.close()
        }

        return false
      }

      const samples = new Uint8Array(analyser.fftSize)

      const tick = (): void => {
        if (this.monitorGeneration !== generation) return

        analyser.getByteTimeDomainData(samples)
        handlers.onLevel(levelPercent(samples))
        this.meterFrame = window.requestAnimationFrame(tick)
      }

      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (this.monitorGeneration !== generation) return

          this.stopMonitoring()
          handlers.onEnded()
        })
      }

      this.meterFrame = window.requestAnimationFrame(tick)
      return true
    } catch (error) {
      const cancelled = this.monitorGeneration !== generation

      this.stopStream(stream)

      if (!cancelled) {
        this.stopMonitoring()
      }

      if (context && context.state !== 'closed') {
        await context.close().catch(() => {})
      }

      if (cancelled) return false

      throw error
    }
  }

  async playTone(deviceId: string, deviceLabel: string): Promise<ToneResult> {
    this.stopTone()
    const run = ++this.toneRun
    if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') {
      return {
        ok: false,
        error: new Error('HTMLMediaElement.setSinkId no está en esta versión'),
      }
    }
    const context = new AudioContext()
    const destination = context.createMediaStreamDestination()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0.04
    oscillator.type = 'sine'
    oscillator.frequency.value = TONE_HZ
    oscillator.connect(gain)
    gain.connect(destination)
    const audio = new Audio()
    audio.srcObject = destination.stream
    this.toneContext = context
    this.toneElement = audio
    this.toneStream = destination.stream
    try {
      await audio.setSinkId(deviceId)
      if (audio.sinkId !== deviceId) {
        throw new Error(`setSinkId no dejó el identificador pedido. sinkId actual: «${audio.sinkId}»`)
      }
      oscillator.start()
      await audio.play()
      await this.waitForTone()
      if (this.toneRun !== run) {
        return { ok: false, error: new Error('El tono se detuvo antes de completar la reproducción') }
      }
      return { ok: true, routedTo: 'selected', sinkId: audio.sinkId, deviceLabel }
    } catch (error) {
      return { ok: false, error }
    } finally {
      this.stopTone()
    }
  }

  async playToneOnDefaultOutput(): Promise<ToneResult> {
    this.stopTone()
    const run = ++this.toneRun
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0.04
    oscillator.type = 'sine'
    oscillator.frequency.value = TONE_HZ
    oscillator.connect(gain)
    gain.connect(context.destination)
    this.toneContext = context
    try {
      oscillator.start()
      if (context.state === 'suspended') await context.resume()
      await this.waitForTone()
      if (this.toneRun !== run) {
        return { ok: false, error: new Error('El tono se detuvo antes de completar la reproducción') }
      }
      return {
        ok: true,
        routedTo: 'default',
        sinkId: '',
        deviceLabel: 'salida predeterminada del sistema',
      }
    } catch (error) {
      return { ok: false, error }
    } finally {
      this.stopTone()
    }
  }

  stopMonitoring(): void {
    this.monitorGeneration += 1
    if (this.meterFrame) {
      window.cancelAnimationFrame(this.meterFrame)
      this.meterFrame = 0
    }
    this.stopStream(this.micStream)
    this.micStream = null
    void this.micContext?.close()
    this.micContext = null
  }

  stopTone(): void {
    this.toneRun += 1
    this.finishCurrentToneWait()
    if (this.toneElement) {
      this.toneElement.pause()
      this.toneElement.srcObject = null
      this.toneElement = null
    }
    this.stopStream(this.toneStream)
    this.toneStream = null
    void this.toneContext?.close()
    this.toneContext = null
  }

  stopAll(): void {
    this.stopMonitoring()
    this.stopTone()
  }

  private waitForTone(): Promise<void> {
    return new Promise((resolve) => {
      this.finishToneWait = resolve
      this.toneTimer = window.setTimeout(resolve, TONE_MS)
    })
  }

  private finishCurrentToneWait(): void {
    if (this.toneTimer) {
      window.clearTimeout(this.toneTimer)
      this.toneTimer = 0
    }
    const finish = this.finishToneWait
    this.finishToneWait = null
    finish?.()
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) return
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }
}
