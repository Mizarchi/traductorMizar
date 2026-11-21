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
  idle: 'Detenida',
  connecting: 'Conectando',
  translating: 'Traduciendo',
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

  activeCallbackRef.current = onActiveChange

  useEffect(() => {
    let mounted = true

    const provider = new GeminiTranslationProvider({
      onState: (next) => {
        if (!mounted) return

        setState(next)

        activeCallbackRef.current(
          next === 'connecting' ||
          next === 'translating' ||
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

  const active =
    state === 'connecting' ||
    state === 'translating' ||
    state === 'stopping'

  async function start(): Promise<void> {
    const provider = providerRef.current

    if (!provider || active || diagnosticBusy) return

    if (!inputId || !outputId) {
      setError('Selecciona un microfono y una salida en las listas.')
      return
    }

    setError('')
    setText('')
    onPrepare()

    await provider.start({ inputId, outputId })
  }

  function stop(): void {
    providerRef.current?.stop()
  }

  return (
    <section>
      <h2>Traduccion de voz: español → ingles</h2>

      <p>
        Selecciona el microfono y los auriculares en las listas de abajo.
        Al iniciar, tu audio se enviara a Google para traducirlo.
      </p>

      <p>
        Usa auriculares y frases de prueba sin informacion sensible.
        Esta beta se detiene automaticamente a los dos minutos.
      </p>

      <div className="row">
        <button
          type="button"
          disabled={
            active ||
            diagnosticBusy ||
            !inputId ||
            !outputId
          }
          onClick={() => void start()}
        >
          Iniciar traduccion
        </button>

        <button
          type="button"
          disabled={!active}
          onClick={stop}
        >
          Detener traduccion
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