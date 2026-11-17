import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import axios, { AxiosResponse } from 'axios'
import { BgaResponseError } from '../src/helper/bgaResponse'
import { handshake } from '../src/helper/bgaSession'

function httpReturning(data: unknown, setCookie: string[] = []) {
  const http = axios.create()
  http.defaults.adapter = async config => ({ config, data, status: 200, statusText: 'OK', headers: { 'set-cookie': setCookie } } as AxiosResponse)
  return http
}

describe('BGA handshake', () => {
  it('merges cookies and extracts the request token', async () => {
    const credentials = await handshake(httpReturning(`requestToken: '${'c'.repeat(64)}'`, ['PHPSESSID=new; Path=/']), 'https://en.boardgamearena.com/table?table=1', 'TournoiEnCours=1; PHPSESSID=old')
    assert.deepEqual(credentials, { cookie: 'TournoiEnCours=1; PHPSESSID=new', token: 'c'.repeat(64) })
  })

  it('rejects pages without a token as a typed invalid response without echoing the URL', async () => {
    for (const data of ['<html>login</html>', null, { status: 1 }]) {
      await assert.rejects(
        handshake(httpReturning(data), 'https://en.boardgamearena.com/table?table=1&token=secret'),
        (error: unknown) => error instanceof BgaResponseError
          && error.reason === 'invalid_response'
          && error.retryable
          && error.details.stage === 'handshake'
          && !error.message.includes('secret'),
      )
    }
  })
})
