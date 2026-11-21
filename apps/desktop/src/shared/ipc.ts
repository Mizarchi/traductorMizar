/** Canales cerrados: sin argumentos y sin acceso genérico al sistema. */
export const HOST_INFO_CHANNEL = 'host:get-info'
export const ARM_MICROPHONE_CHANNEL = 'media:arm-microphone'
export const ARM_OUTPUT_CHANNEL = 'media:arm-output'

export interface HostInfo {
  electron: string
  chrome: string
  platform: string
  osRelease: string
}

export interface AudioDiagnosticApi {
  createGeminiSession: () => Promise<GeminiSessionCredential>
  checkGeminiConnection: () => Promise<void>
  getHostInfo: () => Promise<HostInfo>
  armMicrophoneRequest: () => Promise<void>
  armOutputRequest: () => Promise<void>
}

export interface GeminiSessionCredential {
  token: string
  model: string
  targetLanguage: string
}
