import { useEffect, useRef, useState, type JSX } from 'react'
import { deviceCaption, type ListedDevice } from '../audio/devices'
import type { DisplayCaptureSource, HostInfo } from '../../../shared/ipc'
import {
  MeetingTranslationProvider,
  type MeetingCaptureSource,
  type MeetingTranslationState,
} from './MeetingTranslationProvider'

type CaptureMode = 'device' | 'system-loopback'

const MAX_SUBTITLE_CHARS = 240
const MAX_SUBTITLE_LINES = 3

function appendSlidingSubtitle(previous: string, fragment: string): string {
  const combined = (previous + fragment).replace(/\n{3,}/g, '\n\n')
  const lines = combined.split('\n')
  let trimmed = lines.length > MAX_SUBTITLE_LINES
    ? lines.slice(-MAX_SUBTITLE_LINES).join('\n')
    : combined

  if (trimmed.length > MAX_SUBTITLE_CHARS) {
    const start = trimmed.length - MAX_SUBTITLE_CHARS
    const breakAt = trimmed.indexOf(' ', start)
    trimmed = breakAt > start ? trimmed.slice(breakAt + 1) : trimmed.slice(start)
  }

  return trimmed.replace(/^\n+/, '')
}

export interface MeetingOverlayUpdate {
  subtitles: string
  meetingStatus: string
  meetingActive: boolean
}

interface MeetingTranslationPanelProps {
  inputs: ListedDevice[]
  outgoingInputId: string
  outgoingOutput: ListedDevice | null
  host: HostInfo | null
  stopSignal: number
  onActiveChange: (active: boolean) => void
  onOverlayUpdate: (update: MeetingOverlayUpdate) => void
}

const stateLabels: Record<MeetingTranslationState, string> = {
  idle: 'Listo',
  connecting: 'Conectando',
  listening: 'Escuchando reunión',
  stopping: 'Deteniendo',
  error: 'Error',
}

export function MeetingTranslationPanel({
  inputs,
  outgoingInputId,
  outgoingOutput,
  host,
  stopSignal,
  onActiveChange,
  onOverlayUpdate,
}: MeetingTranslationPanelProps): JSX.Element {
  const providerRef = useRef<MeetingTranslationProvider | null>(null)
  const activeCallbackRef = useRef(onActiveChange)
  const overlayCallbackRef = useRef(onOverlayUpdate)
  const subtitlesRef = useRef<HTMLDivElement | null>(null)
  const lastStopSignal = useRef(stopSignal)

  const [mode, setMode] = useState<CaptureMode>('device')
  const [meetingInputId, setMeetingInputId] = useState('')
  const [displaySources, setDisplaySources] = useState<DisplayCaptureSource[]>([])
  const [displaySourceId, setDisplaySourceId] = useState('')
  const [loadingSources, setLoadingSources] = useState(false)

  const [state, setState] = useState<MeetingTranslationState>('idle')
  const [subtitles, setSubtitles] = useState('')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')

  activeCallbackRef.current = onActiveChange
  overlayCallbackRef.current = onOverlayUpdate

  useEffect(() => {
    let mounted = true

    const provider = new MeetingTranslationProvider({
      onState: (next) => {
        if (!mounted) return
        setState(next)
        activeCallbackRef.current(
          next === 'connecting' || next === 'listening' || next === 'stopping',
        )
      },
      onText: (fragment) => {
        if (!mounted) return
        setSubtitles((previous) => appendSlidingSubtitle(previous, fragment))
      },
      onLevel: (nextLevel) => {
        if (mounted) setLevel(nextLevel)
      },
      onError: (message) => {
        if (mounted) setError(message)
      },
    })

    providerRef.current = provider

    return () => {
      mounted = false
      provider.stop()
      providerRef.current = null
    }
  }, [])

  useEffect(() => {
    const node = subtitlesRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [subtitles])

  useEffect(() => {
    overlayCallbackRef.current({
      subtitles,
      meetingStatus: stateLabels[state],
      meetingActive: state === 'connecting' || state === 'listening',
    })
  }, [subtitles, state])

  useEffect(() => {
    if (lastStopSignal.current === stopSignal) return
    lastStopSignal.current = stopSignal
    providerRef.current?.stop()
  }, [stopSignal])

  // Si el dispositivo seleccionado desaparece, detenemos la sesion entrante y limpiamos la seleccion.
  useEffect(() => {
    if (meetingInputId && !inputs.some((device) => device.deviceId === meetingInputId)) {
      if (mode === 'device') {
        providerRef.current?.stop()
        setError('La entrada de audio de la reunión se desconectó y la captura se detuvo.')
      }
      setMeetingInputId('')
    }
  }, [inputs, meetingInputId, mode])

  const active = state === 'connecting' || state === 'listening' || state === 'stopping'
  const selectedMeetingInput = inputs.find((device) => device.deviceId === meetingInputId) ?? null
  const isWindows = host?.platform === 'win32'

  // Guardias anti-retorno y no-mezcla
  const sameAsPhysicalMic =
    mode === 'device' &&
    meetingInputId.length > 0 &&
    outgoingInputId.length > 0 &&
    meetingInputId === outgoingInputId

  const sameVirtualCableLoop =
    mode === 'device' &&
    selectedMeetingInput !== null &&
    outgoingOutput !== null &&
    /cable output\b/i.test(selectedMeetingInput.label) &&
    /cable input\b/i.test(outgoingOutput.label) &&
    !/cable-[a-z]/i.test(selectedMeetingInput.label) &&
    !/cable-[a-z]/i.test(outgoingOutput.label)

  const loopbackOutputRisk =
    mode === 'system-loopback' &&
    (!outgoingOutput || !outgoingOutput.virtualHint)

  const canStart =
    !active &&
    !loadingSources &&
    (mode === 'device'
      ? meetingInputId.length > 0 && !sameAsPhysicalMic && !sameVirtualCableLoop
      : isWindows && displaySourceId.length > 0 && !loopbackOutputRisk)

  async function refreshDisplaySources(): Promise<void> {
    if (!window.audioDiagnostic) return
    setLoadingSources(true)
    setError('')
    try {
      const found = await window.audioDiagnostic.listDisplaySources()
      setDisplaySources(found)
      if (!found.some((source) => source.id === displaySourceId)) {
        // Nunca seleccionamos silenciosamente la primera fuente.
        setDisplaySourceId('')
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudieron listar las fuentes de pantalla/ventana.',
      )
    } finally {
      setLoadingSources(false)
    }
  }

  function startListening(): void {
    if (!canStart) return

    setError('')

    const capture: MeetingCaptureSource =
      mode === 'device'
        ? { mode: 'device', deviceId: meetingInputId }
        : { mode: 'system-loopback', sourceId: displaySourceId }

    providerRef.current?.start(capture)
  }

  function stopListening(): void {
    providerRef.current?.stop()
  }

  return (
    <section>
      <h2>Traducción de la reunión: inglés → español (solo subtítulos)</h2>

      <p>
        Usa una segunda sesión independiente de Gemini para el audio del entrevistador.
        Esta primera versión muestra subtítulos en español y <strong>no reproduce voz española</strong>.
        Nota: Gemini Live Translate sigue generando audio en el servidor aunque esta aplicación
        lo descarta sin reproducirlo.
      </p>

      <label className="field">
        Modo de captura de la reunión
        <select
          value={mode}
          disabled={active}
          onChange={(event) => {
            setMode(event.target.value as CaptureMode)
            setError('')
          }}
        >
          <option value="device">
            Dispositivo virtual dedicado (getUserMedia — aislamiento total)
          </option>
          <option value="system-loopback">
            Audio del sistema de Windows (loopback via getDisplayMedia)
          </option>
        </select>
      </label>

      {mode === 'device' ? (
        <>
          <label className="field">
            Entrada de audio de la reunión (ej. CABLE-B Output o Voicemeeter)
            <select
              value={meetingInputId}
              disabled={active}
              onChange={(event) => setMeetingInputId(event.target.value)}
            >
              <option value="">Elige explícitamente la entrada de la reunión</option>
              {inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {deviceCaption(device)}
                </option>
              ))}
            </select>
          </label>

          {sameAsPhysicalMic ? (
            <p className="status error" role="alert">
              Bloqueado: esta entrada es la misma que el micrófono físico de español → inglés.
              No mezcles tu micrófono físico con el audio de la reunión.
            </p>
          ) : null}

          {sameVirtualCableLoop ? (
            <p className="status error" role="alert">
              Bloqueo anti-retorno: «{selectedMeetingInput?.label}» es el otro extremo del mismo
              cable virtual que usa la salida de español → inglés («{outgoingOutput?.label}»).
              Usa «Audio del sistema de Windows (loopback)» o un segundo cable virtual distinto.
            </p>
          ) : null}

          {selectedMeetingInput && !selectedMeetingInput.virtualHint && !sameAsPhysicalMic ? (
            <p className="status">
              Aviso: la entrada elegida no parece un dispositivo virtual. Asegúrate de que solo
              recibe el audio de la reunión (por ejemplo, desde un segundo cable virtual o Voicemeeter)
              y no tu voz ni el cable de salida en inglés.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="hint">
            El loopback de Windows captura todo el audio del dispositivo de reproducción
            predeterminado (no aísla una sola aplicación). Para evitar que tu propia traducción
            en inglés vuelva a entrar aquí, la salida de español → inglés debe ir a un cable virtual
            (como CABLE Input), nunca a tus auriculares predeterminados.
          </p>

          {!isWindows ? (
            <p className="status error" role="alert">
              Bloqueo de plataforma: el audio loopback via getDisplayMedia en Electron solo está
              soportado en Windows. Usa la copia de Windows o un dispositivo virtual dedicado.
            </p>
          ) : null}

          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={active || loadingSources || !window.audioDiagnostic}
              onClick={() => void refreshDisplaySources()}
            >
              {loadingSources ? 'Listando fuentes…' : 'Listar fuentes de captura'}
            </button>
          </div>

          <label className="field">
            Fuente explícita para iniciar el loopback de sistema
            <select
              value={displaySourceId}
              disabled={active || displaySources.length === 0}
              onChange={(event) => setDisplaySourceId(event.target.value)}
            >
              <option value="">
                {displaySources.length === 0
                  ? 'Pulsa «Listar fuentes de captura» primero'
                  : 'Elige explícitamente una pantalla o ventana'}
              </option>
              {displaySources.map((source) => (
                <option key={source.id} value={source.id}>
                  [{source.kind === 'screen' ? 'Pantalla' : 'Ventana'}] {source.name}
                </option>
              ))}
            </select>
          </label>

          {loopbackOutputRisk ? (
            <p className="status error" role="alert">
              Bloqueo anti-retorno: para usar loopback de sistema sin recapturar tu propia traducción
              al inglés, primero selecciona un dispositivo virtual (ej. CABLE Input) como salida de
              español → inglés abajo, o cambia a «Dispositivo virtual dedicado».
            </p>
          ) : null}
        </>
      )}

      <div className="row">
        <button type="button" disabled={!canStart} onClick={startListening}>
          Iniciar subtítulos (EN → ES)
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!active}
          onClick={stopListening}
        >
          Detener reunión
        </button>
        <button
          type="button"
          className="secondary"
          disabled={subtitles.length === 0}
          onClick={() => setSubtitles('')}
        >
          Limpiar subtítulos
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!window.audioDiagnostic}
          onClick={() => void window.audioDiagnostic.openOverlayWindow()}
        >
          Abrir ventana flotante
        </button>
      </div>

      <p role="status">Estado (EN → ES): {stateLabels[state]}</p>

      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={active ? level : 0}
        aria-label="Nivel del audio de la reunión"
      >
        <span style={{ width: active ? `${level}%` : '0%' }} />
      </div>
      <p className="hint">
        {active
          ? `Nivel de entrada de la reunión: ${level} (comprueba que no sube cuando hablas tú en español → inglés)`
          : 'Captura de la reunión apagada.'}
      </p>

      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}

      <h3>Subtítulos en español</h3>
      <div ref={subtitlesRef} className="subtitles" aria-live="polite">
        {subtitles || 'Los subtítulos en español aparecerán aquí.'}
      </div>
    </section>
  )
}
