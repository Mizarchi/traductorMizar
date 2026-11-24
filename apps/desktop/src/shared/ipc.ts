/** Canales cerrados: sin acceso genérico al sistema. */
export const HOST_INFO_CHANNEL = 'host:get-info'
export const ARM_MICROPHONE_CHANNEL = 'media:arm-microphone'
export const ARM_OUTPUT_CHANNEL = 'media:arm-output'
export const LIST_DISPLAY_SOURCES_CHANNEL = 'media:list-display-sources'
export const ARM_DISPLAY_AUDIO_CHANNEL = 'media:arm-display-audio'
export const OVERLAY_OPEN_CHANNEL = 'overlay:open'
export const OVERLAY_CLOSE_CHANNEL = 'overlay:close'
export const OVERLAY_STATE_CHANNEL = 'overlay:state'
export const OVERLAY_COMMAND_CHANNEL = 'overlay:command'

export type TargetLanguage = 'en' | 'es'

export type OverlayCommand = 'talk-start' | 'talk-end' | 'talk-stop'

export interface OverlaySnapshot {
  subtitles: string
  meetingStatus: string
  meetingActive: boolean
  outgoingStatus: string
  outgoingText: string
  talkLabel: string
  talkDisabled: boolean
  holding: boolean
}

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
  openOverlayWindow: () => Promise<void>
  closeOverlayWindow: () => Promise<void>
  publishOverlayState: (snapshot: OverlaySnapshot) => void
  onOverlayState: (listener: (snapshot: OverlaySnapshot) => void) => () => void
  sendOverlayCommand: (command: OverlayCommand) => void
  onOverlayCommand: (listener: (command: OverlayCommand) => void) => () => void
}

export interface GeminiSessionCredential {
  token: string
  model: string
  targetLanguage: TargetLanguage
}
