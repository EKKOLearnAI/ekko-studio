const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
] as const

const INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
] as const

function clampSample(value: number): number {
  if (value > 32767) return 32767
  if (value < -32768) return -32768
  return value
}

function clampIndex(value: number): number {
  if (value < 0) return 0
  if (value > 88) return 88
  return value
}

function encodeNibble(sample: number, state: { predictor: number; index: number }): number {
  const step = STEP_TABLE[state.index]
  let diff = sample - state.predictor
  let nibble = 0
  if (diff < 0) {
    nibble = 8
    diff = -diff
  }

  let delta = step >> 3
  if (diff >= step) {
    nibble |= 4
    diff -= step
    delta += step
  }
  if (diff >= step >> 1) {
    nibble |= 2
    diff -= step >> 1
    delta += step >> 1
  }
  if (diff >= step >> 2) {
    nibble |= 1
    delta += step >> 2
  }

  state.predictor = clampSample((nibble & 8) ? state.predictor - delta : state.predictor + delta)
  state.index = clampIndex(state.index + INDEX_TABLE[nibble])
  return nibble & 0x0f
}

export function encodeMcuImaAdpcm(pcm: Buffer, sampleRate: number): Buffer {
  const sampleCount = Math.floor(pcm.length / 2)
  const header = Buffer.alloc(20)
  header.write('HADP', 0, 'ascii')
  header.writeUInt8(1, 4)
  header.writeUInt8(1, 5)
  header.writeUInt16LE(0, 6)
  header.writeUInt32LE(sampleRate >>> 0, 8)
  header.writeUInt32LE(sampleCount >>> 0, 12)

  if (sampleCount <= 0) return header

  const initial = pcm.readInt16LE(0)
  header.writeInt16LE(initial, 16)
  header.writeUInt8(0, 18)
  header.writeUInt8(0, 19)

  const encoded = Buffer.alloc(Math.ceil(Math.max(0, sampleCount - 1) / 2))
  const state = { predictor: initial, index: 0 }
  for (let i = 1; i < sampleCount; i += 1) {
    const nibble = encodeNibble(pcm.readInt16LE(i * 2), state)
    const offset = i - 1
    const byteIndex = offset >> 1
    if ((offset & 1) === 0) {
      encoded[byteIndex] = nibble
    } else {
      encoded[byteIndex] |= nibble << 4
    }
  }

  return Buffer.concat([header, encoded])
}

export interface DecodedMcuImaAdpcm {
  pcm: Buffer
  sampleRate: number
  channels: 1
}

export function decodeMcuImaAdpcm(encoded: Buffer): DecodedMcuImaAdpcm {
  if (encoded.length < 20) throw new Error('IMA-ADPCM chunk is missing its HADP header')
  if (encoded.toString('ascii', 0, 4) !== 'HADP') throw new Error('IMA-ADPCM chunk has invalid magic')
  if (encoded.readUInt8(4) !== 1) throw new Error('IMA-ADPCM chunk uses an unsupported HADP version')
  if (encoded.readUInt8(5) !== 1) throw new Error('IMA-ADPCM chunk must be mono')

  const sampleRate = encoded.readUInt32LE(8)
  const sampleCount = encoded.readUInt32LE(12)
  const payloadBytes = Math.ceil(Math.max(0, sampleCount - 1) / 2)
  if (encoded.length !== 20 + payloadBytes) {
    throw new Error('IMA-ADPCM chunk size does not match its sample count')
  }
  if (sampleCount === 0) return { pcm: Buffer.alloc(0), sampleRate, channels: 1 }

  const pcm = Buffer.allocUnsafe(sampleCount * 2)
  const state = {
    predictor: encoded.readInt16LE(16),
    index: encoded.readUInt8(18),
  }
  if (state.index > 88) throw new Error('IMA-ADPCM chunk has an invalid step index')
  pcm.writeInt16LE(state.predictor, 0)

  for (let sample = 1; sample < sampleCount; sample += 1) {
    const nibbleOffset = sample - 1
    const packed = encoded.readUInt8(20 + (nibbleOffset >> 1))
    const nibble = (nibbleOffset & 1) === 0 ? packed & 0x0f : packed >> 4
    const step = STEP_TABLE[state.index]
    let delta = step >> 3
    if (nibble & 1) delta += step >> 2
    if (nibble & 2) delta += step >> 1
    if (nibble & 4) delta += step

    state.predictor = clampSample((nibble & 8) ? state.predictor - delta : state.predictor + delta)
    state.index = clampIndex(state.index + INDEX_TABLE[nibble])
    pcm.writeInt16LE(state.predictor, sample * 2)
  }

  return { pcm, sampleRate, channels: 1 }
}
