import { useEffect, useRef, useState, type JSX } from 'react'
import type { OverlaySnapshot } from '../../../shared/ipc'

const INITIAL_SNAPSHOT: OverlaySnapshot = {
  subtitles: '',
  meetingStatus: 'Listo',
  meetingActive: false,
  outgoingStatus: 'Listo',
  outgoingText: '',
  talkLabel: 'Mantén pulsado para hablar',
  talkDisabled: true,
  holding: false,
}

export function OverlayWindow(): JSX.Element {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot>(INITIAL_SNAPSHOT)
  const subtitlesRef = useRef<HTMLDivElement | null>(null)
  const holdingRef = useRef(false)

  useEffect(() => {
    document.body.classList.add('overlay-body')
    return () => document.body.classList.remove('overlay-body')
  }, [])

  useEffect(() => {
    const bridge = window.audioDiagnostic
    if (!bridge) return
    return bridge.onOverlayState((next) => {
      setSnapshot(next)
      if (!next.holding) {
        holdingRef.current = false
      }
    })
  }, [])

  useEffect(() => {
    const node = subtitlesRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [snapshot.subtitles])

  function beginTalk(): void {
    if (holdingRef.current || snapshot.talkDisabled) return
    holdingRef.current = true
    window.audioDiagnostic?.sendOverlayCommand('talk-start')
  }

  function endTalk(): void {
    if (!holdingRef.current) return
    holdingRef.current = false
    window.audioDiagnostic?.sendOverlayCommand('talk-end')
  }

  return (
    <div className="overlay-shell">
      <div className="overlay-header">
        <span className="overlay-badge" data-active={snapshot.meetingActive ? 'true' : 'false'}>
          EN → ES: {snapshot.meetingStatus}
        </span>
        <span className="overlay-badge">
          ES → EN: {snapshot.outgoingStatus}
        </span>
      </div>

      <div ref={subtitlesRef} className="overlay-subtitles" aria-live="polite">
        {snapshot.subtitles || 'Los subtítulos en español aparecerán aquí…'}
      </div>

      {snapshot.outgoingText ? (
        <div className="overlay-outgoing" title={snapshot.outgoingText}>
          Tú (EN): {snapshot.outgoingText}
        </div>
      ) : null}

      <div className="overlay-controls">
        <button
          type="button"
          className="overlay-talk"
          data-holding={snapshot.holding ? 'true' : 'false'}
          disabled={snapshot.talkDisabled}
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
          {snapshot.talkLabel}
        </button>
      </div>
    </div>
  )
}
