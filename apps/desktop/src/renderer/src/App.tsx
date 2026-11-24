import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { deviceCaption, listEndpoints, preferredPhysicalInput, type ListedDevice } from './audio/devices'
import { MeetingTranslationPanel, type MeetingOverlayUpdate } from './translation/MeetingTranslationPanel'
import { TranslationPanel, type OutgoingOverlayUpdate } from './translation/TranslationPanel'
import {
  describeMediaError,
  describeMissingDevice,
  describeOutputSupport,
  describePlatformLimit,
  manualOutputSteps,
} from './audio/messages'
import { chooseOutputWithSystemPicker, probeOutputApis, type OutputApiProbe } from './audio/probe'
import { LocalAudioSession } from './audio/session'
import type { HostInfo, OverlaySnapshot } from '../../shared/ipc'

type Tone = 'info' | 'ok' | 'error'

interface Status {
  tone: Tone
  text: string
}

export function App(): JSX.Element {
  const sessionRef = useRef<LocalAudioSession | null>(null)
  if (!sessionRef.current) sessionRef.current = new LocalAudioSession()
  const session = sessionRef.current

  const [host, setHost] = useState<HostInfo | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [probe] = useState<OutputApiProbe>(() => probeOutputApis())
  const [inputs, setInputs] = useState<ListedDevice[]>([])
  const [outputs, setOutputs] = useState<ListedDevice[]>([])
  const [inputId, setInputId] = useState('')
  const [outputId, setOutputId] = useState('')
  const [labelsUnlocked, setLabelsUnlocked] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [level, setLevel] = useState(0)
  const [status, setStatus] = useState<Status>({
    tone: 'info',
    text: 'El medidor está apagado. Ninguna pista de micrófono está abierta.',
  })
  function prepareTranslation(): void {
    monitorOperationRef.current += 1
    session.stopAll()
    setMonitoring(false)
    setLevel(0)
  }
  const [busy, setBusy] = useState(false)
  const [outgoingActive, setOutgoingActive] = useState(false)
  const [incomingActive, setIncomingActive] = useState(false)
  const [translationStopSignal, setTranslationStopSignal] = useState(0)
  const anyActive = busy || outgoingActive || incomingActive

  const overlaySnapshotRef = useRef<OverlaySnapshot>({
    subtitles: '',
    meetingStatus: 'Listo',
    meetingActive: false,
    outgoingStatus: 'Listo',
    outgoingText: '',
    talkLabel: 'Mantén pulsado para hablar',
    talkDisabled: true,
    holding: false,
  })

  const handleMeetingOverlayUpdate = useCallback((update: MeetingOverlayUpdate): void => {
    overlaySnapshotRef.current = { ...overlaySnapshotRef.current, ...update }
    window.audioDiagnostic?.publishOverlayState(overlaySnapshotRef.current)
  }, [])

  const handleOutgoingOverlayUpdate = useCallback((update: OutgoingOverlayUpdate): void => {
    overlaySnapshotRef.current = { ...overlaySnapshotRef.current, ...update }
    window.audioDiagnostic?.publishOverlayState(overlaySnapshotRef.current)
  }, [])
  const inputIdRef = useRef('')
  const outputIdRef = useRef('')
  const inputsRef = useRef<ListedDevice[]>([])
  const outputsRef = useRef<ListedDevice[]>([])
  const monitorOperationRef = useRef(0)

  useEffect(() => {
    inputIdRef.current = inputId
  }, [inputId])
  useEffect(() => {
    outputIdRef.current = outputId
  }, [outputId])

  useEffect(() => {
    const bridge = window.audioDiagnostic
    if (!bridge) {
      setHostError('El preload no expuso audioDiagnostic. La página no tiene canal IPC.')
      return
    }
    void bridge.getHostInfo().then(setHost).catch((error: unknown) => {
      setHostError(error instanceof Error ? error.message : 'No se pudo leer el sistema')
    })

    const onPageHide = (): void => session.stopAll()
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      session.stopAll()
    }
  }, [session])

  async function refreshDevices(preferInput: boolean): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus({
        tone: 'error',
        text: 'Bloqueo real: navigator.mediaDevices.enumerateDevices no está disponible.',
      })
      return
    }
    const found = await navigator.mediaDevices.enumerateDevices()
    const nextInputs = listEndpoints(found, 'audioinput')
    const nextOutputs = listEndpoints(found, 'audiooutput')
    const previousInputs = inputsRef.current
    const previousOutputs = outputsRef.current
    inputsRef.current = nextInputs
    outputsRef.current = nextOutputs
    setInputs(nextInputs)
    setOutputs(nextOutputs)

    const currentInput = inputIdRef.current
    if (currentInput && !nextInputs.some((device) => device.deviceId === currentInput)) {
      const previous = previousInputs.find((device) => device.deviceId === currentInput)
      setTranslationStopSignal((value) => value + 1)
      session.stopMonitoring()
      setMonitoring(false)
      setLevel(0)
      setInputId('')
      inputIdRef.current = ''
      setStatus({
        tone: 'error',
        text: describeMissingDevice('entrada', previous?.label || currentInput),
      })
    } else if (preferInput && !currentInput) {
      const preferred = preferredPhysicalInput(nextInputs)
      setInputId(preferred)
      inputIdRef.current = preferred
    }

    const currentOutput = outputIdRef.current
    if (currentOutput && !nextOutputs.some((device) => device.deviceId === currentOutput)) {
      const previous = previousOutputs.find((device) => device.deviceId === currentOutput)
      setTranslationStopSignal((value) => value + 1)
      session.stopTone()
      setOutputId('')
      outputIdRef.current = ''
      setStatus({
        tone: 'error',
        text: describeMissingDevice('salida', previous?.label || currentOutput),
      })
    }
  }

  useEffect(() => {
    void refreshDevices(false)
    const onChange = (): void => {
      void refreshDevices(false)
    }
    navigator.mediaDevices?.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange)
  }, [session])

  const selectedInput = inputs.find((device) => device.deviceId === inputId) ?? null
  const selectedOutput = outputs.find((device) => device.deviceId === outputId) ?? null
  const unlabeled = labelsUnlocked && inputs.some((device) => device.label.length === 0)

  async function requestMicrophone(): Promise<void> {
    setBusy(true)
    try {
      await window.audioDiagnostic.armMicrophoneRequest()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      for (const track of stream.getTracks()) track.stop()
      setLabelsUnlocked(true)
      setMonitoring(false)
      setLevel(0)
      await refreshDevices(true)
      setStatus({
        tone: 'ok',
        text: 'Permiso concedido. Las pistas de esa solicitud ya se cerraron. El medidor sigue apagado.',
      })
    } catch (error) {
      setLabelsUnlocked(false)
      setStatus({ tone: 'error', text: describeMediaError(error, host) })
    } finally {
      setBusy(false)
    }
  }

  async function toggleMonitor(next: boolean): Promise<void> {
    const operation = ++monitorOperationRef.current

    if (!next) {
      session.stopMonitoring()
      setMonitoring(false)
      setLevel(0)
      setStatus({
        tone: 'info',
        text: 'Monitoreo apagado. Las pistas del micrófono se liberaron.',
      })
      return
    }

    if (!selectedInput) {
      setStatus({
        tone: 'error',
        text: 'Elige un micrófono físico antes de abrir el medidor.',
      })
      return
    }

    const device = selectedInput
    setBusy(true)

    try {
      await window.audioDiagnostic.armMicrophoneRequest()

      if (operation !== monitorOperationRef.current) return

      const opened = await session.openMonitor(device.deviceId, {
        onLevel: setLevel,
        onEnded: () => {
          if (operation !== monitorOperationRef.current) return

          setMonitoring(false)
          setLevel(0)
          setInputId('')
          inputIdRef.current = ''

          setStatus({
            tone: 'error',
            text: describeMissingDevice(
              'entrada',
              device.label || device.deviceId,
            ),
          })

          void refreshDevices(false)
        },
      })

      if (!opened || operation !== monitorOperationRef.current) return

      setMonitoring(true)
      setStatus({
        tone: 'info',
        text: `Medidor activo en «${deviceCaption(device)}». El micrófono no se envía a los altavoces.`,
      })
    } catch (error) {
      if (operation !== monitorOperationRef.current) return

      session.stopMonitoring()
      setMonitoring(false)
      setLevel(0)
      setStatus({
        tone: 'error',
        text: describeMediaError(error, host),
      })
    } finally {
      setBusy(false)
    }
  }

  async function playSelected(): Promise<void> {
    if (!probe.setSinkIdOnMediaElement) {
      setStatus({
        tone: 'error',
        text: `${describeOutputSupport(probe, host)} ${manualOutputSteps(host)}`,
      })
      return
    }

    if (!selectedOutput) {
      setStatus({
        tone: 'error',
        text: 'Elige una salida de la lista. Sin esa elección no se llama a setSinkId.',
      })
      return
    }

    const device = selectedOutput
    setBusy(true)

    try {
      await window.audioDiagnostic.armOutputRequest()

      const result = await session.playTone(
        device.deviceId,
        deviceCaption(device),
      )

      if (!result.ok) {
        setStatus({
          tone: 'error',
          text: `${describeMediaError(result.error, host)} ${manualOutputSteps(host)}`,
        })
        return
      }

      setStatus({
        tone: 'ok',
        text: `Tono de 440 Hz reproducido en «${result.deviceLabel}». sinkId confirmado: ${result.sinkId}.`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: describeMediaError(error, host),
      })
    } finally {
      setBusy(false)
    }
  }

  async function playDefault(): Promise<void> {
    setBusy(true)
    try {
      const result = await session.playToneOnDefaultOutput()
      if (!result.ok) {
        setStatus({ tone: 'error', text: describeMediaError(result.error, host) })
        return
      }
      setStatus({
        tone: 'info',
        text: 'Tono reproducido en la salida predeterminada del sistema. No se aplicó el dispositivo elegido en la lista.',
      })
    } finally {
      setBusy(false)
    }
  }

  async function pickOutput(): Promise<void> {
    if (!probe.selectAudioOutput) {
      setStatus({ tone: 'error', text: describeOutputSupport(probe, host) })
      return
    }
    setBusy(true)
    try {
      await window.audioDiagnostic.armOutputRequest()
      const picked = await chooseOutputWithSystemPicker()
      await refreshDevices(false)
      const listed = outputsRef.current.some((device) => device.deviceId === picked.deviceId)
      if (!listed) {
        setStatus({
          tone: 'error',
          text: `selectAudioOutput devolvió «${picked.label || picked.deviceId}», pero ese identificador no está entre las salidas enumeradas. No se marca como seleccionado. ${manualOutputSteps(host)}`,
        })
        return
      }
      setOutputId(picked.deviceId)
      outputIdRef.current = picked.deviceId
      setStatus({
        tone: 'ok',
        text: `El selector del sistema eligió «${picked.label || picked.deviceId}». Aún no se ha reproducido audio.`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: `${describeMediaError(error, host)} ${manualOutputSteps(host)}`,
      })
    } finally {
      setBusy(false)
    }
  }

  function releaseAll(): void {
    setTranslationStopSignal((value) => value + 1)
    monitorOperationRef.current += 1
    session.stopAll()
    setMonitoring(false)
    setLevel(0)
    setStatus({ tone: 'info', text: 'Todas las pistas se detuvieron y los contextos de audio se cerraron.' })
  }


  async function checkGeminiConnection(): Promise<void> {
    setBusy(true)

    try {
      setStatus({
        tone: 'info',
        text: 'Comprobando Gemini. No se enviara audio...',
      })

      await window.audioDiagnostic.checkGeminiConnection()

      setStatus({
        tone: 'ok',
        text: 'Gemini conectado: el backend creo una credencial temporal. No se envio audio.',
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error
          ? error.message
          : 'No se pudo comprobar Gemini.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Diagnóstico de audio local</h1>

      <TranslationPanel
        inputId={inputId}
        outputId={outputId}
        diagnosticBusy={busy}
        stopSignal={translationStopSignal}
        onPrepare={prepareTranslation}
        onActiveChange={setOutgoingActive}
        onOverlayUpdate={handleOutgoingOverlayUpdate}
      />

      <MeetingTranslationPanel
        inputs={inputs}
        outgoingInputId={inputId}
        outgoingOutput={selectedOutput}
        host={host}
        stopSignal={translationStopSignal}
        onActiveChange={setIncomingActive}
        onOverlayUpdate={handleMeetingOverlayUpdate}
      />

      <section>
        <h2>Conexion con Gemini</h2>
        <p>
          Comprueba el backend y las credenciales.
          Esta prueba no abre el microfono ni envia audio.
        </p>
        <button
          type="button"
          disabled={anyActive || !window.audioDiagnostic}
          onClick={() => void checkGeminiConnection()}
        >
          Comprobar conexion con Gemini
        </button>
      </section>
      <p className="lead">
        Enumera dispositivos, pide el micrófono con un botón y reproduce un tono en la salida que esta versión
        pueda seleccionar. No traduce ni se une a una reunión.
      </p>

      <section>
        <h2>Sistema</h2>
        {host ? (
          <>
            <p>
              Electron {host.electron} · Chromium {host.chrome}
            </p>
            <p>{describePlatformLimit(host)}</p>
          </>
        ) : (
          <p className="status error">{hostError ?? 'Leyendo la versión instalada…'}</p>
        )}
      </section>

      <section>
        <h2>Selección de salida en esta versión</h2>
        <table>
          <thead>
            <tr>
              <th>API</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            <ApiRow name="enumerateDevices" available={probe.enumerateDevices} />
            <ApiRow name="HTMLMediaElement.setSinkId" available={probe.setSinkIdOnMediaElement} />
            <ApiRow name="AudioContext.setSinkId" available={probe.setSinkIdOnAudioContext} />
            <ApiRow name="mediaDevices.selectAudioOutput" available={probe.selectAudioOutput} />
          </tbody>
        </table>
        <p>{describeOutputSupport(probe, host)}</p>
      </section>

      <section>
        <h2>Permiso del micrófono</h2>
        <p className="hint">
          Hasta que pulses el botón no se abre ninguna pista. Si Windows o el runtime lo niegan, el mensaje muestra
          el error real.
        </p>
        <div className="row">
          <button type="button" onClick={() => void requestMicrophone()} disabled={anyActive || !window.audioDiagnostic}>
            Solicitar permiso del micrófono
          </button>
          <button type="button" className="secondary" onClick={() => void refreshDevices(false)} disabled={busy}>
            Volver a enumerar
          </button>
        </div>
      </section>

      <section>
        <h2>Micrófono físico</h2>
        <label className="field">
          Entrada
          <select
            value={inputId}
            disabled={busy || outgoingActive}
            onChange={(event) => {
              const next = event.target.value
              monitorOperationRef.current += 1
              session.stopMonitoring()
              setMonitoring(false)
              setLevel(0)
              setInputId(next)
            }}
          >
            <option value="">Elige un micrófono</option>
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceCaption(device)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          {inputs.length === 0
            ? 'No hay entradas enumeradas. Conecta un micrófono o revisa el permiso.'
            : `${inputs.length} entrada(s), sin contar los alias default y communications.`}
          {unlabeled ? ' Hay dispositivos sin nombre: el sistema no entregó la etiqueta.' : ''}
        </p>
        {selectedInput?.virtualHint ? (
          <p className="status error">
            La entrada elegida parece un cable o un dispositivo virtual. Para este diagnóstico elige el micrófono
            físico.
          </p>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={monitoring}
            disabled={busy || outgoingActive || !selectedInput}
            onChange={(event) => void toggleMonitor(event.target.checked)}
          />
          Medidor de nivel
        </label>
        <div
          className="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={monitoring ? level : 0}
          aria-label="Nivel del micrófono"
        >
          <span style={{ width: monitoring ? `${level}%` : '0%' }} />
        </div>
        <p className="hint">{monitoring ? `Nivel relativo: ${level}` : 'Medidor apagado.'}</p>
      </section>

      <section>
        <h2>Salida del tono</h2>
        <label className="field">
          Salida
          <select value={outputId} disabled={busy || outgoingActive} onChange={(event) => setOutputId(event.target.value)}>
            <option value="">Elige una salida</option>
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceCaption(device)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          {outputs.length === 0
            ? 'No hay salidas enumeradas. Revisa el dispositivo de reproducción del sistema.'
            : `${outputs.length} salida(s), sin contar los alias default y communications.`}
        </p>
        <div className="row">
          <button type="button" onClick={() => void playSelected()} disabled={busy || outgoingActive || !probe.setSinkIdOnMediaElement}>
            Reproducir tono en la salida elegida
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void pickOutput()}
            disabled={busy || outgoingActive || !probe.selectAudioOutput}
          >
            Elegir con el selector del sistema
          </button>
          <button type="button" className="secondary" onClick={() => void playDefault()} disabled={busy || outgoingActive}>
            Reproducir tono en la salida predeterminada
          </button>
        </div>
      </section>

      <section>
        <h2>Cierre</h2>
        <button type="button" onClick={releaseAll}>
          Detener y liberar
        </button>
        <p className={`status ${status.tone}`}>{status.text}</p>
      </section>
    </main>
  )
}

function ApiRow({ name, available }: { name: string; available: boolean }): JSX.Element {
  return (
    <tr>
      <td>{name}</td>
      <td>{available ? 'Disponible' : 'Ausente'}</td>
    </tr>
  )
}
