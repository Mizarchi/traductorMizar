/** Canales cerrados: sin acceso genérico al sistema. */
export const HOST_INFO_CHANNEL = 'host:get-info'
export const ARM_MICROPHONE_CHANNEL = 'media:arm-microphone'
export const ARM_OUTPUT_CHANNEL = 'media:arm-output'
export const LIST_DISPLAY_SOURCES_CHANNEL = 'media:list-display-sources'
export const ARM_DISPLAY_AUDIO_CHANNEL = 'media:arm-display-audio'

export type TargetLanguage = 'en' | 'es'

export interface HostInfo {
  electron: string
  chrome: string
  platform: string
  osRelease: string
}

export interface DisplayCaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
}

export interface AudioDiagnosticApi {
  createGeminiSession: (targetLanguage?: TargetLanguage) => Promise<GeminiSessionCredential>
  checkGeminiConnection: () => Promise<void>
  getHostInfo: () => Promise<HostInfo>
  armMicrophoneRequest: () => Promise<void>
  armOutputRequest: () => Promise<void>
  listDisplaySources: () => Promise<DisplayCaptureSource[]>
  armDisplayAudioRequest: (sourceId: string) => Promise<void>
}

export interface GeminiSessionCredential {
  token: string
  model: string
  targetLanguage: TargetLanguage
}
