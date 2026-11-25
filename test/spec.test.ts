import { describe, expect, it } from 'vitest'
import {
  HBF,
  THICKNESS_UM,
  blockBytes,
  channelOfDie,
  dieBytes,
  planeBytes,
  stackArrayProgramBps,
  stackArrayReadBps,
  stackBytes,
  stackHeightUm,
  ucieChannelRawBps,
  ucieStackEffectiveBps,
} from '../src/core/hbf-spec'

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

describe('HBF device arithmetic', () => {
  it('builds a 512 GiB stack from HBFlex geometry, matching OCP Table 3', () => {
    expect(blockBytes()).toBe(2 * MiB)
    expect(planeBytes()).toBe(1 * GiB)
    expect(dieBytes()).toBe(32 * GiB)
    expect(stackBytes()).toBe(512 * GiB)
  })

  it('derives the array-limited read bandwidth from planes, page size and tR', () => {
    // 512 planes x 4 KiB / 4 µs = 524.288 GB/s = 488.28 GiB/s. HBFlex quotes "488 GB/s per
    // stack, or 2.93 TB/s across six": the digits match the GiB/s figure, so the unit is ambiguous.
    expect(stackArrayReadBps()).toBeCloseTo(524.288e9, 0)
    expect(stackArrayReadBps() / GiB).toBeCloseTo(488.28, 1)
  })

  it('programs about 19x slower than it reads', () => {
    expect(stackArrayReadBps() / stackArrayProgramBps()).toBeCloseTo(HBF.programUs / HBF.readUs, 6)
  })

  it('reproduces OCP Table 2: 256 GB/s raw per channel, 3,072 GB/s effective per stack', () => {
    expect(ucieChannelRawBps()).toBe(256e9)
    expect(ucieStackEffectiveBps()).toBe(3072e9)
  })

  it('splits the 775 µm OCP height into layers that add back up to it', () => {
    expect(stackHeightUm()).toBeCloseTo(HBF.heightUm, 0)
    expect(THICKNESS_UM.coreDie).toBeGreaterThan(THICKNESS_UM.bond)
  })

  it('gives every die one host channel and uses every channel once', () => {
    const seen = new Set<number>()
    for (let d = 0; d < HBF.diesPerStack; d++) seen.add(channelOfDie(d))
    expect(seen.size).toBe(HBF.channelsPerStack)
  })
})
