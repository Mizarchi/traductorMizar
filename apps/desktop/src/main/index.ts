import { createGeminiSession } from './gemini-session'
import { checkGeminiBackend } from './gemini-check'
import { app, BrowserWindow, desktopCapturer, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import {
  ARM_DISPLAY_AUDIO_CHANNEL,
  ARM_MICROPHONE_CHANNEL,
  ARM_OUTPUT_CHANNEL,
  HOST_INFO_CHANNEL,
  LIST_DISPLAY_SOURCES_CHANNEL,
  type DisplayCaptureSource,
  type HostInfo,
  type TargetLanguage,
} from '../shared/ipc'

const probeMode = process.argv.includes('--probe')

function rendererDevUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  return url && url.length > 0 ? url : null
}

function isTrustedUrl(url: string): boolean {
  const devUrl = rendererDevUrl()
  if (devUrl && (url === devUrl || url.startsWith(`${devUrl}/`))) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'file:') return false
  const filePath = path.resolve(fileURLToPath(parsed))
  const rendererRoot = path.resolve(__dirname, '../renderer')
  return filePath === rendererRoot || filePath.startsWith(`${rendererRoot}${path.sep}`)
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url
  if (!url || !isTrustedUrl(url)) {
    throw new Error('Origen no permitido')
  }
}

function readHostInfo(): HostInfo {
  return {
    electron: process.versions.electron ?? 'desconocida',
    chrome: process.versions.chrome ?? 'desconocida',
    platform: process.platform,
    osRelease: os.release(),
  }
}

let microphoneArmed = false
let outputArmed = false
let pendingDisplaySourceId: string | null = null

function parseTargetLanguage(args: unknown[]): TargetLanguage {
  if (args.length === 0) return 'en'
  if (args.length === 1 && (args[0] === 'en' || args[0] === 'es')) {
    return args[0]
  }
  throw new Error('Idioma de destino no permitido')
}

function registerIpc(): void {
  ipcMain.handle(
    'gemini:create-session',
    async (event, ...args: unknown[]) => {
      assertTrustedSender(event)
      const targetLanguage = parseTargetLanguage(args)

      return createGeminiSession(app.getAppPath(), targetLanguage)
    },
  )
  ipcMain.handle('gemini:check', async (event, ...args: unknown[]) => {
    rejectArguments(args)
    assertTrustedSender(event)
    await checkGeminiBackend(app.getAppPath())
    return true
  })

  ipcMain.handle(HOST_INFO_CHANNEL, (event, ...args: unknown[]) => {
    rejectArguments(args)
    assertTrustedSender(event)
    return readHostInfo()
  })
  ipcMain.handle(ARM_MICROPHONE_CHANNEL, (event, ...args: unknown[]) => {
    rejectArguments(args)
    assertTrustedSender(event)
    microphoneArmed = true
    return true
  })
  ipcMain.handle(ARM_OUTPUT_CHANNEL, (event, ...args: unknown[]) => {
    rejectArguments(args)
    assertTrustedSender(event)
    outputArmed = true
    return true
  })
  ipcMain.handle(LIST_DISPLAY_SOURCES_CHANNEL, async (event, ...args: unknown[]) => {
    rejectArguments(args)
    assertTrustedSender(event)
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    })
    return sources.map((source): DisplayCaptureSource => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    }))
  })
  ipcMain.handle(ARM_DISPLAY_AUDIO_CHANNEL, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (process.platform !== 'win32') {
      throw new Error('El loopback de sistema solo esta disponible en Windows.')
    }
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].trim().length === 0) {
      throw new Error('Debes indicar explicitamente una fuente de captura.')
    }
    pendingDisplaySourceId = args[0]
    return true
  })
}

function rejectArguments(args: unknown[]): void {
  if (args.length > 0) {
    throw new Error('Este canal no acepta argumentos')
  }
}

function registerPermissions(): void {
  const current = session.defaultSession
  current.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents.getURL()
    if (!isTrustedUrl(url)) {
      callback(false)
      return
    }
    if (permission === 'speaker-selection') {
      callback(outputArmed)
      return
    }
    if (permission === 'media') {
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
      const audioOnly =
        !Array.isArray(mediaTypes) || (mediaTypes.length > 0 && mediaTypes.every((kind) => kind === 'audio'))
      callback(microphoneArmed && audioOnly)
      return
    }
    callback(false)
  })
  current.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const pageUrl = webContents?.getURL() ?? requestingOrigin
    if (!isTrustedUrl(pageUrl) && !isTrustedUrl(requestingOrigin)) return false
    if (permission === 'speaker-selection') return outputArmed
    if (permission === 'media') {
      const mediaType = 'mediaType' in details ? details.mediaType : undefined
      const audio = mediaType === 'audio' || mediaType === undefined
      return microphoneArmed && audio
    }
    return false
  })
  current.setDisplayMediaRequestHandler(async (request, callback) => {
    const url = request.frame?.url ?? ''
    const requestedId = pendingDisplaySourceId
    pendingDisplaySourceId = null

    if (!isTrustedUrl(url) || !requestedId || process.platform !== 'win32') {
      callback(null)
      return
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      })
      const matched = sources.find((source) => source.id === requestedId)
      if (!matched) {
        callback(null)
        return
      }
      callback({ video: matched, audio: 'loopback' })
    } catch {
      callback(null)
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 860,
    minWidth: 720,
    minHeight: 640,
    show: false,
    title: 'Diagnóstico de audio local',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })

  if (!probeMode) {
    win.once('ready-to-show', () => win.show())
  }

  const devUrl = rendererDevUrl()
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

async function runProbe(win: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => resolve())
    } else {
      resolve()
    }
  })
  const report = await win.webContents.executeJavaScript(
    `JSON.stringify({
      setSinkIdOnMediaElement: typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function',
      setSinkIdOnAudioContext: typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function',
      selectAudioOutput: typeof navigator.mediaDevices?.selectAudioOutput === 'function',
      enumerateDevices: typeof navigator.mediaDevices?.enumerateDevices === 'function'
    })`,
    true,
  )
  process.stdout.write(`${report}\n`)
  app.exit(0)
}

void app.whenReady().then(() => {
  registerPermissions()
  registerIpc()
  const win = createWindow()
  if (probeMode) {
    void runProbe(win).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      app.exit(1)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!probeMode) app.quit()
})
