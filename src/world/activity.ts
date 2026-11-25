import * as THREE from 'three'
import { HBF } from '../core/hbf-spec'
import { domainDieTable } from '../sim/store'
import type { Sim } from '../sim/sim'
import { DIE_PROGRAM_BPS, DIE_READ_BPS } from '../sim/sim'

/* ============================================================================
 * ACTIVITY — how busy each die is, smoothed for display.
 *
 * Per die, from the simulator's per-domain counters (host traffic and GC):
 *   read     bytes sensed per second / the die's 32-plane read bandwidth
 *   program  bytes programmed per second / its program bandwidth, shown on a
 *            square-root scale: programs use a few percent of a die, and on a
 *            linear scale they would never show
 *   erase    superblock erases per second, softly saturated
 * Each is 0..1. They feed the die shader (texture, one texel per die), the
 * UCIe lanes and the TSV columns. Rates use simulated time, so a die at 60 %
 * read utilisation looks the same at any playback speed.
 * ==========================================================================*/

export interface Activity {
  texture: THREE.DataTexture
  read: Float32Array
  program: Float32Array
  erase: Float32Array
  /** compute share of the last iteration, 0..1 */
  compute: number
  /** mean read utilisation over all dies, 0..1 */
  readMean: number
  update(sim: Sim, simDt: number, wallDt: number): void
  reset(): void
  /** after a jump in simulated time: forget the counters so the jump does not read as a burst */
  resync(sim: Sim): void
}

const N = HBF.stacksPerGpu * HBF.diesPerStack

export function createActivity(): Activity {
  const data = new Uint8Array(N * 4)
  const texture = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true
  const read = new Float32Array(N)
  const program = new Float32Array(N)
  const erase = new Float32Array(N)
  const lastErase = new Float64Array(N)

  const act: Activity = {
    texture,
    read,
    program,
    erase,
    compute: 0,
    readMean: 0,
    update(sim, simDt, wallDt) {
      const k = 1 - Math.exp(-wallDt * 4)
      const store = sim.store
      const w = store.width
      const table = domainDieTable(w)
      if (simDt > 0) {
        for (let d = 0; d < store.domains; d++) {
          const rd = sim.domRead[d] / simDt / (w * DIE_READ_BPS)
          const pr = sim.domWrite[d] / simDt / (w * DIE_PROGRAM_BPS)
          const dies = table[d]
          for (let j = 0; j < dies.length; j++) {
            const die = dies[j]
            read[die] += (Math.min(1, rd) - read[die]) * k
            program[die] += (Math.sqrt(Math.min(1, pr)) - program[die]) * k
          }
          sim.domRead[d] = 0
          sim.domWrite[d] = 0
        }
        // erases: compare per-domain cumulative counts
        for (let d = 0; d < store.domains; d++) {
          let e = 0
          const base = d * HBF.blocksPerPlane
          for (let b = store.weightRows; b < HBF.blocksPerPlane; b++) e += store.erase[base + b]
          const dies = table[d]
          for (let j = 0; j < dies.length; j++) {
            const die = dies[j]
            const delta = e - lastErase[die]
            lastErase[die] = e
            // one erase per simulated minute on a die reads as a faint flash
            const rate = Math.min(1, Math.sqrt((delta / simDt) * 60) * 0.15)
            erase[die] = Math.max(rate, erase[die] * Math.exp(-wallDt * 3))
          }
        }
        const it = sim.lastIter
        act.compute += ((it.t > 0 ? it.compute / it.t : 0) - act.compute) * k
      } else {
        for (let i = 0; i < N; i++) {
          read[i] *= 1 - k
          program[i] *= 1 - k
          erase[i] *= 1 - k
        }
        act.compute *= 1 - k
      }
      let sum = 0
      for (let i = 0; i < N; i++) sum += read[i]
      act.readMean = sum / N
      for (let i = 0; i < N; i++) {
        data[i * 4] = Math.round(read[i] * 255)
        data[i * 4 + 1] = Math.round(program[i] * 255)
        data[i * 4 + 2] = Math.round(erase[i] * 255)
        data[i * 4 + 3] = 255
      }
      texture.needsUpdate = true
    },
    resync(sim) {
      sim.domRead.fill(0)
      sim.domWrite.fill(0)
      const store = sim.store
      const table = domainDieTable(store.width)
      for (let d = 0; d < store.domains; d++) {
        let e = 0
        const base = d * HBF.blocksPerPlane
        for (let b = store.weightRows; b < HBF.blocksPerPlane; b++) e += store.erase[base + b]
        for (const die of table[d]) lastErase[die] = e
      }
    },
    reset() {
      read.fill(0)
      program.fill(0)
      erase.fill(0)
      lastErase.fill(0)
      act.compute = 0
      act.readMean = 0
    },
  }
  return act
}
