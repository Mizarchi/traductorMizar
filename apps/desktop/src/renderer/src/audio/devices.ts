const VIRTUAL_LABEL = /cable|virtual|loopback|voicemeeter|blackhole|stereo mix|mezcla estéreo/i

export interface ListedDevice {
  deviceId: string
  label: string
  kind: MediaDeviceKind
  virtualHint: boolean
}

export function listEndpoints(devices: MediaDeviceInfo[], kind: 'audioinput' | 'audiooutput'): ListedDevice[] {
  return devices
    .filter((device) => device.kind === kind)
    .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: device.kind,
      virtualHint: VIRTUAL_LABEL.test(device.label),
    }))
}

export function preferredPhysicalInput(devices: ListedDevice[]): string {
  const physical = devices.find((device) => device.label.length > 0 && !device.virtualHint)
  return physical?.deviceId ?? ''
}

export function deviceCaption(device: ListedDevice): string {
  const name = device.label.trim().length > 0 ? device.label : `Dispositivo sin nombre (${device.deviceId.slice(0, 8)})`
  return device.virtualHint ? `${name} — parece virtual` : name
}
