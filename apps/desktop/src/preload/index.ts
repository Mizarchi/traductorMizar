import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  ARM_DISPLAY_AUDIO_CHANNEL,
  ARM_MICROPHONE_CHANNEL,
  ARM_OUTPUT_CHANNEL,
  HOST_INFO_CHANNEL,
  LIST_DISPLAY_SOURCES_CHANNEL,
  OVERLAY_CLOSE_CHANNEL,
  OVERLAY_COMMAND_CHANNEL,
  OVERLAY_OPEN_CHANNEL,
  OVERLAY_STATE_CHANNEL,
  type AudioDiagnosticApi,
  type DisplayCaptureSource,
  type GeminiSessionCredential,
  type HostInfo,
  type OverlayCommand,
  type OverlaySnapshot,
  type TargetLanguage,
} from '../shared/ipc'

function isHostInfo(value: unknown): value is HostInfo {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.electron === 'string' &&
    typeof record.chrome === 'string' &&
    typeof record.platform === 'string' &&
    typeof record.osRelease === 'string'
  )
}

function isDisplayCaptureSource(value: unknown): value is DisplayCaptureSource {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (record.kind === 'screen' || record.kind === 'window')
  )
}

async function invokeArmed(channel: string, ...args: unknown[]): Promise<void> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (result !== true) {
    throw new Error('El proceso principal no confirmó la solicitud')
  }
}

const api: AudioDiagnosticApi = {
  createGeminiSession: async (targetLanguage: TargetLanguage = 'en') => {
    const safeTarget: TargetLanguage = targetLanguage === 'es' ? 'es' : 'en'
    const result: unknown = await ipcRenderer.invoke(
      'gemini:create-session',
      safeTarget,
    )

    if (!result || typeof result !== 'object') {
      throw new Error('Respuesta de sesion no valida')
    }

    const value = result as Record<string, unknown>

    if (
      typeof value.token !== 'string' ||
      !value.token.startsWith('auth_tokens/') ||
      value.model !== 'gemini-3.5-live-translate-preview' ||
      value.targetLanguage !== safeTarget
    ) {
      throw new Error('Formato de credencial temporal no valido')
    }

    return {
      token: value.token,
      model: value.model,
      targetLanguage: safeTarget,
    } satisfies GeminiSessionCredential
  },

  checkGeminiConnection: () => invokeArmed('gemini:check'),
  getHostInfo: async () => {
    const result: unknown = await ipcRenderer.invoke(HOST_INFO_CHANNEL)
    if (!isHostInfo(result)) {
      throw new Error('El proceso principal devolvió un formato de sistema no válido')
    }
    return result
  },
  armMicrophoneRequest: () => invokeArmed(ARM_MICROPHONE_CHANNEL),
  armOutputRequest: () => invokeArmed(ARM_OUTPUT_CHANNEL),
  listDisplaySources: async () => {
    const result: unknown = await ipcRenderer.invoke(LIST_DISPLAY_SOURCES_CHANNEL)
    if (!Array.isArray(result) || !result.every(isDisplayCaptureSource)) {
      throw new Error('El proceso principal devolvió fuentes de captura no válidas')
    }
    return result
  },
  armDisplayAudioRequest: (sourceId: string) => {
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
      return Promise.reject(new Error('Selecciona una fuente de captura antes de iniciar.'))
    }
    return invokeArmed(ARM_DISPLAY_AUDIO_CHANNEL, sourceId)
  },
  openOverlayWindow: () => invokeArmed(OVERLAY_OPEN_CHANNEL),
  closeOverlayWindow: () => invokeArmed(OVERLAY_CLOSE_CHANNEL),
  publishOverlayState: (snapshot: OverlaySnapshot) => {
    ipcRenderer.send(OVERLAY_STATE_CHANNEL, snapshot)
  },
  onOverlayState: (listener: (snapshot: OverlaySnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: OverlaySnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(OVERLAY_STATE_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(OVERLAY_STATE_CHANNEL, handler)
    }
  },
  sendOverlayCommand: (command: OverlayCommand) => {
    ipcRenderer.send(OVERLAY_COMMAND_CHANNEL, command)
  },
  onOverlayCommand: (listener: (command: OverlayCommand) => void) => {
    const handler = (_event: IpcRendererEvent, command: OverlayCommand): void => {
      listener(command)
    }
    ipcRenderer.on(OVERLAY_COMMAND_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(OVERLAY_COMMAND_CHANNEL, handler)
    }
  },
}

contextBridge.exposeInMainWorld('audioDiagnostic', api)
