import { useEffect, useRef, useState, type JSX } from 'react'
import {
  GeminiTranslationProvider,
  type TranslationState,
} from './GeminiTranslationProvider'

interface TranslationPanelProps {
  inputId: string
  outputId: string
  diagnosticBusy: boolean
  stopSignal: number
  onPrepare: () => void
  onActiveChange: (active: boolean) => void
}

const stateLabels: Record<TranslationState, string> = {
  idle: 'Listo',
  connecting: 'Conectando',
  capturing: 'Escuchando',
  translating: 'Traduciendo',
  playing: 'Reproduciendo',
  stopping: 'Deteniendo',
  error: 'Error',
}

export function TranslationPanel({
  inputId,
  outputId,
  diagnosticBusy,
  stopSignal,
  onPrepare,
  onActiveChange,
}: TranslationPanelProps): JSX.Element {
  const providerRef = useRef<GeminiTranslationProvider | null>(null)
  const activeCallbackRef = useRef(onActiveChange)
  const lastStopSignal = useRef(stopSignal)

  const [state, setState] = useState<TranslationState>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [holding, setHolding] = useState(false)
  const holdingRef = useRef(false)

  activeCallbackRef.current = onActiveChange

  useEffect(() => {
    let mounted = true

    const provider = new GeminiTranslationProvider({
      onState: (next) => {
        if (!mounted) return

        setState(next)

        activeCallbackRef.current(
          next === 'connecting' ||
          next === 'capturing' ||
          next === 'translating' ||
          next === 'playing' ||
          next === 'stopping',
        )
      },

      onText: (fragment) => {
        if (!mounted) return

        setText((previous) => (previous + fragment).slice(-12000))
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
    if (lastStopSignal.current === stopSignal) return

    lastStopSignal.current = stopSignal
    providerRef.current?.stop()
  }, [stopSignal])

  const locked =
    state === 'connecting' ||
    state === 'translating' ||
    state === 'playing' ||
    state === 'stopping'

  const talkDisabled =
    locked ||
    (diagnosticBusy && state !== 'capturing') ||
    !inputId ||
    !outputId

  const talkLabel =
    state === 'playing'
      ? 'Reproduciendo traducción'
      : state === 'translating' || state === 'connecting'
        ? 'Traduciendo…'
        : 'Mantén pulsado para hablar'

  function beginTalk(): void {
    if (holdingRef.current || talkDisabled) return

    if (!inputId || !outputId) {
      setError('Selecciona un microfono y una salida en las listas.')
      return
    }

    holdingRef.current = true
    setHolding(true)
    setError('')
    setText('')
    onPrepare()
    providerRef.current?.startCapture({ inputId, outputId })
  }

  function endTalk(): void {
    if (!holdingRef.current) return

    holdingRef.current = false
    setHolding(false)
    providerRef.current?.stopCaptureAndTranslate()
  }

  function stop(): void {
    holdingRef.current = false
    setHolding(false)
    providerRef.current?.stop()
  }

  return (
    <section>
      <h2>Traduccion de voz: español → ingles</h2>

      <p>
        Selecciona el microfono y los auriculares en las listas de abajo.
        El microfono solo se abre mientras mantienes pulsado el boton.
        Al soltar, se apaga y ese audio se envia a Google.
      </p>

      <p>
        Usa auriculares y frases de prueba sin informacion sensible.
        Mientras se traduce y se reproduce, el microfono sigue apagado.
        La sesion de esta beta se cierra sola a los dos minutos.
      </p>

      <div className="row">
        <button
          type="button"
          className="talk"
          data-holding={holding ? 'true' : 'false'}
          disabled={talkDisabled}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            beginTalk()
          }}
          onPointerUp={endTalk}
          onPointerCancel={endTalk}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.repeat) return
            if (event.key !== ' ' && event.key !== 'Enter') return
            event.preventDefault()
            beginTalk()
          }}
          onKeyUp={(event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return
            event.preventDefault()
            endTalk()
          }}
          onBlur={endTalk}
        >
          {talkLabel}
        </button>

        <button
          type="button"
          className="secondary"
          disabled={state === 'idle' || state === 'error'}
          onClick={stop}
        >
          Detener
        </button>
      </div>

      <p role="status">Estado: {stateLabels[state]}</p>

      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}

      <h3>Texto traducido</h3>
      <p>{text || 'La traduccion aparecera aqui.'}</p>
    </section>
  )
}