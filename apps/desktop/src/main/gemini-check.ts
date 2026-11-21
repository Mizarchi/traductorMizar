import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pending: Promise<void> | null = null

export function checkGeminiBackend(projectRoot: string): Promise<void> {
  if (pending) return pending

  const task = runCheck(projectRoot)
  pending = task

  void task.then(
    () => { if (pending === task) pending = null },
    () => { if (pending === task) pending = null },
  )

  return task
}

async function runCheck(projectRoot: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Ejecuta esta comprobacion en la copia de Windows.')
  }

  const nodeDirectory = path.join(
    process.env['ProgramFiles'] || 'C:\\Program Files',
    'nodejs',
  )
  const nodeExecutable = path.join(nodeDirectory, 'node.exe')
  const credentials = path.join(
    os.homedir(),
    '.traductor-mizar',
    'gemini.env',
  )
  const script = path.join(projectRoot, 'scripts', 'gemini-backend.mjs')

  if (!existsSync(nodeExecutable)) {
    throw new Error('No se encuentra Node de Windows.')
  }

  if (!existsSync(credentials)) {
    throw new Error('No se encuentra el archivo privado gemini.env.')
  }

  if (!existsSync(script)) {
    throw new Error('Falta copiar scripts/gemini-backend.mjs a Windows.')
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      nodeExecutable,
      [`--env-file=${credentials}`, script, '--check'],
      {
        cwd: projectRoot,
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 65536,
        env: {
          ...process.env,
          PATH: `${nodeDirectory}${path.delimiter}${process.env['PATH'] ?? ''}`,
        },
      },
      (error, stdout) => {
        if (!error && stdout.includes('BACKEND OK:')) {
          resolve()
          return
        }

        reject(new Error(
          'La comprobacion de Gemini fallo. Ejecuta la prueba --check ' +
          'desde la terminal para obtener el estado del error.',
        ))
      },
    )
  })
}
