import { contextBridge, ipcRenderer } from 'electron'
import {
  ARM_MICROPHONE_CHANNEL,
  ARM_OUTPUT_CHANNEL,
  HOST_INFO_CHANNEL,
  type AudioDiagnosticApi,
  type GeminiSessionCredential,
  type HostInfo,
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

async function invokeArmed(channel: string): Promise<void> {
  const result: unknown = await ipcRenderer.invoke(channel)
  if (result !== true) {
    throw new Error('El proceso principal no confirmó la solicitud')
  }
}

const api: AudioDiagnosticApi = {
  createGeminiSession: async () => {
    const result: unknown = await ipcRenderer.invoke(
      'gemini:create-session',
    )

    if (!result || typeof result !== 'object') {
      throw new Error('Respuesta de sesion no valida')
    }

    const value = result as Record<string, unknown>

    if (
      typeof value.token !== 'string' ||
      !value.token.startsWith('auth_tokens/') ||
      value.model !== 'gemini-3.5-live-translate-preview' ||
      value.targetLanguage !== 'en'
    ) {
      throw new Error('Formato de credencial temporal no valido')
    }

    return {
      token: value.token,
      model: value.model,
      targetLanguage: value.targetLanguage,
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
}

contextBridge.exposeInMainWorld('audioDiagnostic', api)
