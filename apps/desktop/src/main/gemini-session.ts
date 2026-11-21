import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface GeminiSessionCredential {
  token: string
  model: string
  targetLanguage: string
}

let pending: Promise<GeminiSessionCredential> | null = null

export function createGeminiSession(
  projectRoot: string,
): Promise<GeminiSessionCredential> {
  if (pending) {
    return Promise.reject(
      new Error('Ya se esta preparando una sesion de Gemini.'),
    )
  }

  const task = requestCredential(projectRoot)
  pending = task

  void task.then(
    () => { if (pending === task) pending = null },
    () => { if (pending === task) pending = null },
  )

  return task
}

async function requestCredential(
  projectRoot: string,
): Promise<GeminiSessionCredential> {
  if (process.platform !== 'win32') {
    throw new Error('Inicia la copia de Windows para traducir.')
  }

  const nodeDirectory = path.join(
    process.env['ProgramFiles'] || 'C:\\Program Files',
    'nodejs',
  )
  const executable = path.join(nodeDirectory, 'node.exe')
  const credentials = path.join(
    os.homedir(),
    '.traductor-mizar',
    'gemini.env',
  )
  const script = path.join(projectRoot, 'scripts', 'gemini-backend.mjs')

  if (![executable, credentials, script].every((file) => existsSync(file))) {
    throw new Error(
      'Falta Node, el archivo privado o el script del backend.',
    )
  }

  return new Promise((resolve, reject) => {
    const child = fork(script, ['--issue'], {
      execPath: executable,
      execArgv: [`--env-file=${credentials}`],
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        PATH: `${nodeDirectory}${path.delimiter}${process.env['PATH'] ?? ''}`,
      },
    })

    let settled = false

    const finish = (
      error: Error | null,
      credential?: GeminiSessionCredential,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (child.connected) child.disconnect()
      child.kill()

      if (error) reject(error)
      else if (credential) resolve(credential)
      else reject(new Error('No se recibio la credencial temporal.'))
    }

    const timer = setTimeout(() => {
      finish(new Error('Tiempo agotado al preparar Gemini.'))
    }, 30000)

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return

      const value = message as Record<string, unknown>

      if (value['type'] === 'credential-error') {
        const status = typeof value['status'] === 'number'
          ? ` HTTP ${value['status']}.`
          : ''

        finish(new Error(`No se pudo preparar Gemini.${status}`))
        return
      }

      if (
        value['type'] === 'credential' &&
        typeof value['token'] === 'string' &&
        value['token'].startsWith('auth_tokens/') &&
        value['model'] === 'gemini-3.5-live-translate-preview' &&
        value['targetLanguage'] === 'en'
      ) {
        finish(null, {
          token: value['token'],
          model: value['model'],
          targetLanguage: value['targetLanguage'],
        })
      }
    })

    child.once('error', () => {
      finish(new Error('No se pudo iniciar el backend de Gemini.'))
    })

    child.once('exit', () => {
      finish(new Error('El backend termino sin entregar una credencial.'))
    })
  })
}
