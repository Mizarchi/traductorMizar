/** Escala relativa para el medidor. No es una medida calibrada en dBFS. */
export function levelPercent(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const value of samples) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / samples.length)
  return Math.max(0, Math.min(100, Math.round(rms * 400)))
}
