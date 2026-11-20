/**
 * Parent channel for a Desktop Host started by the Tauri shell.
 *
 * The Electron shell starts the Host with a Node IPC channel. The Tauri shell is not a Node process, so it
 * listens on a local socket (a Unix socket on macOS and Linux, a named pipe on Windows) and passes its address
 * in `TTOKEN_SHELL_CHANNEL`. The shell preloads this module with `node --import`; it gives `process` the parts
 * of the IPC API the Host uses: `send`, `connected`, `disconnect`, and the `message` and `disconnect` events.
 * Each message is one JSON document on its own line, the same documents Node IPC carries in its `json`
 * serialization, so the Host's message handling does not change.
 *
 * Without `TTOKEN_SHELL_CHANNEL` this module does nothing, and a Host started with a real IPC channel keeps it.
 */

import { connect } from 'node:net'

/** Longest accepted incoming line; shell messages are small control records. */
const MAX_LINE_CHARS = 1024 * 1024

const address = process.env.TTOKEN_SHELL_CHANNEL
if (address !== undefined && address !== '' && process.send === undefined) {
  // Plugin and package-manager subprocesses inherit the Host environment; the channel belongs to the Host only.
  delete process.env.TTOKEN_SHELL_CHANNEL
  const socket = connect(address)
  socket.setEncoding('utf8')
  let connected = true
  let pending = ''

  const disconnected = () => {
    if (!connected) return
    connected = false
    process.emit('disconnect')
  }

  socket.on('data', (chunk) => {
    pending += chunk
    for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch (_invalidJson) {
        // A malformed record means the two ends disagree on the framing; nothing later on the stream is trustworthy.
        socket.destroy(new Error('ttoken shell channel: received a line that is not JSON'))
        return
      }
      process.emit('message', message)
    }
    if (pending.length > MAX_LINE_CHARS) socket.destroy(new Error('ttoken shell channel: incoming line is too long'))
  })
  socket.on('error', (error) => {
    console.error(`ttoken shell channel: ${error.message}`)
  })
  socket.on('close', disconnected)

  Object.defineProperty(process, 'connected', { configurable: true, enumerable: true, get: () => connected })

  process.send = (message, ...rest) => {
    const callback = typeof rest.at(-1) === 'function' ? rest.at(-1) : undefined
    const fail = (error) => {
      if (callback === undefined) process.nextTick(() => { process.emit('error', error) })
      else process.nextTick(callback, error)
      return false
    }
    if (!connected) return fail(Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }))
    let line
    try {
      line = `${JSON.stringify(message)}\n`
    } catch (error) {
      return fail(error)
    }
    return socket.write(line, (error) => { callback?.(error ?? null) })
  }

  process.disconnect = () => {
    if (!connected) throw Object.assign(new Error('IPC channel is already disconnected'), { code: 'ERR_IPC_DISCONNECTED' })
    socket.end()
    process.nextTick(disconnected)
  }
}
