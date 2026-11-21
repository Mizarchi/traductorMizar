export interface OutputApiProbe {
  enumerateDevices: boolean
  setSinkIdOnMediaElement: boolean
  setSinkIdOnAudioContext: boolean
  selectAudioOutput: boolean
}

type MediaDevicesWithPicker = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>
}

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>
}

export function probeOutputApis(): OutputApiProbe {
  const media = navigator.mediaDevices as MediaDevicesWithPicker | undefined
  const audioContextPrototype = AudioContext.prototype as AudioContextWithSink
  return {
    enumerateDevices: typeof media?.enumerateDevices === 'function',
    setSinkIdOnMediaElement: typeof HTMLMediaElement.prototype.setSinkId === 'function',
    setSinkIdOnAudioContext: typeof audioContextPrototype.setSinkId === 'function',
    selectAudioOutput: typeof media?.selectAudioOutput === 'function',
  }
}

export async function chooseOutputWithSystemPicker(): Promise<MediaDeviceInfo> {
  const media = navigator.mediaDevices as MediaDevicesWithPicker
  if (typeof media.selectAudioOutput !== 'function') {
    throw new Error('selectAudioOutput no está en esta versión')
  }
  return media.selectAudioOutput()
}
