import type { HostInfo } from '../../../shared/ipc'
import type { OutputApiProbe } from './probe'

export function describeMediaError(error: unknown, host: HostInfo | null): string {
  const raw = rawError(error)
  if (!(error instanceof DOMException)) {
    return raw
  }
  const guidance: Record<string, string> = {
    NotAllowedError: permissionDeniedText(host),
    NotFoundError:
      'No hay ningún dispositivo que cumpla la petición. Conecta un micrófono o elige otra entrada de la lista.',
    NotReadableError:
      'El dispositivo está ocupado o en modo exclusivo por otro programa. Ciérralo y vuelve a solicitar el permiso.',
    OverconstrainedError:
      'El dispositivo elegido ya no está disponible o no acepta esas restricciones. Suele ocurrir al desconectarlo.',
    AbortError: 'La solicitud de audio se interrumpió antes de completarse.',
    SecurityError: 'El contexto de la página no permite acceder al dispositivo.',
    NotSupportedError: 'Esta versión del runtime no admite la operación pedida.',
  }
  const explanation = guidance[error.name] ?? 'El runtime rechazó la operación de audio.'
  return `${explanation} Detalle: ${raw}`
}

export function describeMissingDevice(kind: 'entrada' | 'salida', label: string): string {
  const name = label.trim().length > 0 ? label : 'sin nombre'
  return `La ${kind} «${name}» ya no aparece entre los dispositivos. Se desconectó o el sistema la retiró. La selección quedó limpia y las pistas asociadas se detuvieron.`
}

export function describeOutputSupport(probe: OutputApiProbe, host: HostInfo | null): string {
  const version = host ? `Electron ${host.electron}, Chromium ${host.chrome}` : 'esta ejecución'
  if (!probe.setSinkIdOnMediaElement && !probe.selectAudioOutput) {
    return `Bloqueo real en ${version}: no existen HTMLMediaElement.setSinkId ni navigator.mediaDevices.selectAudioOutput. La aplicación no puede elegir la salida. ${manualOutputSteps(host)}`
  }
  if (!probe.selectAudioOutput) {
    return `Bloqueo parcial en ${version}: navigator.mediaDevices.selectAudioOutput no está disponible, así que no hay selector del sistema. La lista de salidas y setSinkId sí se pueden usar.`
  }
  if (!probe.setSinkIdOnMediaElement) {
    return `Bloqueo parcial en ${version}: HTMLMediaElement.setSinkId no está disponible. El selector del sistema puede devolver un dispositivo, pero esta página no puede enrutar el tono hacia él. ${manualOutputSteps(host)}`
  }
  return `En ${version} están disponibles setSinkId y selectAudioOutput. El tono declara éxito solo si setSinkId resuelve con el identificador elegido.`
}

export function manualOutputSteps(host: HostInfo | null): string {
  if (host?.platform === 'win32') {
    return 'Alternativa manual: Configuración → Sistema → Sonido → Salida, elige el dispositivo (para la beta, CABLE Input) y pulsa «Reproducir tono en la salida predeterminada». Ese botón usa la salida de Windows, no la selección de la lista.'
  }
  if (host?.platform === 'linux') {
    return 'Alternativa manual: esta sesión es Linux. Ajusta la salida en el mezclador de PulseAudio o PipeWire y pulsa «Reproducir tono en la salida predeterminada». Un cable virtual instalado en Windows no aparece dentro de WSL.'
  }
  return 'Alternativa manual: elige la salida en el mezclador del sistema y pulsa «Reproducir tono en la salida predeterminada».'
}

export function describePlatformLimit(host: HostInfo): string {
  if (host.platform === 'linux') {
    return `Proceso Linux (${host.osRelease}). Los dispositivos son los de esta sesión (en WSL2, el audio de WSLg), no los de WASAPI ni un cable virtual instalado en Windows 11. Para la prueba con Zoom, ejecuta la misma aplicación en Windows, fuera de WSL.`
  }
  if (host.platform === 'win32') {
    return `Proceso Windows (${host.osRelease}). El permiso del micrófono también depende de Configuración → Privacidad y seguridad → Micrófono: acceso activado y aplicaciones de escritorio permitidas. En desarrollo el programa aparece como Electron.`
  }
  return `Plataforma ${host.platform} (${host.osRelease}). Esta beta de diagnóstico está pensada para comprobarse en Windows 11.`
}

function permissionDeniedText(host: HostInfo | null): string {
  if (host?.platform === 'win32') {
    return 'Permiso de micrófono denegado. En Windows 11 abre Configuración → Privacidad y seguridad → Micrófono, activa el acceso y permite las aplicaciones de escritorio. Si Electron está bloqueado, actívalo y pulsa de nuevo el botón.'
  }
  if (host?.platform === 'linux') {
    return 'Permiso de micrófono denegado por el runtime o por el portal de audio de esta sesión Linux. Concede el acceso al navegador o a Electron y pulsa de nuevo el botón. Esto no cambia los permisos del Windows anfitrión.'
  }
  return 'Permiso de micrófono denegado. Concede el acceso en el sistema y pulsa de nuevo el botón.'
}

function rawError(error: unknown): string {
  if (error instanceof DOMException || error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return 'Error desconocido'
}
