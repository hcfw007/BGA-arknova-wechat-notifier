import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { EMPTY_STATE, ObState } from '../src/helper/obState'
import { ObStateStore } from '../src/helper/obStateStore'

const workDir = mkdtempSync(join(tmpdir(), 'ob-state-store-'))

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function storePath(name: string): string {
  return join(workDir, name, 'ob-state.json')
}

function writeStateFile(path: string, raw: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, raw, 'utf-8')
}

describe('ObStateStore persistence', () => {
  it('starts empty when the state file is missing', () => {
    const store = new ObStateStore(storePath('missing/ob-state.json'))
    assert.deepEqual(store.load(), EMPTY_STATE)
  })

  it('starts empty when the state file is corrupt or not a state shape', () => {
    const corrupt = storePath('corrupt/ob-state.json')
    writeStateFile(corrupt, '{not json')
    assert.deepEqual(new ObStateStore(corrupt).load(), EMPTY_STATE)

    const notAShape = storePath('not-a-shape/ob-state.json')
    writeStateFile(notAShape, JSON.stringify({ tables: 'nope', players: 42 }))
    assert.deepEqual(new ObStateStore(notAShape).load(), EMPTY_STATE)

    const scalar = storePath('scalar/ob-state.json')
    writeStateFile(scalar, '42')
    assert.deepEqual(new ObStateStore(scalar).load(), EMPTY_STATE)
  })

  it('accepts the legacy v1 bare-array format on load', () => {
    const legacy = storePath('legacy/ob-state.json')
    writeStateFile(legacy, JSON.stringify([{ tableId: '1', subscribers: [{ type: 'room', id: 'r1' }] }]))
    assert.deepEqual(new ObStateStore(legacy).load(), {
      tables: [{ tableId: '1', subscribers: [{ type: 'room', id: 'r1' }] }],
      players: [],
    })
  })

  it('round-trips tables and players through save and load, creating missing directories', () => {
    const path = storePath('deep/nested/dir/ob-state.json')
    const store = new ObStateStore(path)
    const state: ObState = {
      tables: [{ tableId: '42', subscribers: [{ type: 'room', id: 'r1' }, { type: 'contact', id: 'c1' }] }],
      players: [{ playerId: '94073546', playerName: 'Theim', subscribers: [{ type: 'room', id: 'r1' }] }],
    }

    store.save(state)

    assert.deepEqual(store.load(), state)
    assert.ok(existsSync(path))
  })

  it('leaves no tmp file behind after the atomic rename', () => {
    const path = storePath('atomic/ob-state.json')
    const store = new ObStateStore(path)

    store.save(EMPTY_STATE)

    assert.ok(existsSync(path))
    assert.equal(existsSync(`${path}.tmp`), false)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), EMPTY_STATE)
  })

  it('swallows write errors instead of breaking the caller', () => {
    const path = storePath('blocked/ob-state.json')
    // save 先写 `${path}.tmp` 再 rename 覆盖；目标路径本身是目录时 rename 失败
    mkdirSync(path, { recursive: true })

    assert.doesNotThrow(() => new ObStateStore(path).save(EMPTY_STATE))
  })
})
