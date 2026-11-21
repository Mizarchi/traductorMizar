/// <reference types="vite/client" />

import type { AudioDiagnosticApi } from '../../shared/ipc'

declare global {
  interface Window {
    audioDiagnostic: AudioDiagnosticApi
  }
}

export {}
