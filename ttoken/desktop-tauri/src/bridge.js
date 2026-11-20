// Bridge between the TTOken Code shell and the Web client in the main window (decision D6).
//
// Tauri runs this before any page script, in the main frame only; the origin check below keeps it inert if the
// frame ever navigates elsewhere. This build exposes `dshDesktopBoot` and the WebSocket ticket hook. Without the
// other Desktop globals the client keeps its Web behavior.
(() => {
  const APP_ORIGIN = __TTOKEN_APP_ORIGIN__
  if (`${location.protocol}//${location.host}` !== APP_ORIGIN) return

  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
  const define = (name, value) => {
    Object.defineProperty(window, name, { value, configurable: false, enumerable: false, writable: false })
  }

  define('dshDesktopBoot', Object.freeze({
    ready: () => invoke('desktop_boot'),
    failed: message => invoke('desktop_boot_failed', { message: String(message) }),
  }))

  const CONNECTING = 0
  const CLOSED = 3

  // A WebSocket that obtains a one-time ticket from the shell before it connects. The client's socket factory is
  // synchronous, so this object reports CONNECTING while the ticket request is pending, then forwards the events of
  // the real socket.
  class TicketedWebSocket {
    #socket
    #closed = false
    #listeners = new Map()

    constructor(url) {
      invoke('desktop_ws_ticket').then((ticket) => {
        if (this.#closed) return
        const separator = url.includes('?') ? '&' : '?'
        const socket = new WebSocket(`${url}${separator}ttoken_ticket=${ticket}`)
        this.#socket = socket
        for (const type of ['open', 'message', 'error', 'close']) {
          socket.addEventListener(type, (event) => { this.#emit(type, event) })
        }
      }, () => {
        if (this.#closed) return
        this.#closed = true
        this.#emit('error', new Event('error'))
        this.#emit('close', new CloseEvent('close', { code: 1006, wasClean: false }))
      })
    }

    get readyState() {
      return this.#socket?.readyState ?? (this.#closed ? CLOSED : CONNECTING)
    }

    send(data) {
      if (this.#socket === undefined) throw new DOMException('WebSocket is not open', 'InvalidStateError')
      this.#socket.send(data)
    }

    close(code, reason) {
      if (this.#socket !== undefined) {
        this.#socket.close(code, reason)
        return
      }
      if (this.#closed) return
      this.#closed = true
      setTimeout(() => { this.#emit('close', new CloseEvent('close', { code: 1006, wasClean: false })) }, 0)
    }

    addEventListener(type, listener, options) {
      let listeners = this.#listeners.get(type)
      if (listeners === undefined) {
        listeners = new Map()
        this.#listeners.set(type, listeners)
      }
      listeners.set(listener, options?.once === true)
    }

    removeEventListener(type, listener) {
      this.#listeners.get(type)?.delete(listener)
    }

    #emit(type, event) {
      const listeners = this.#listeners.get(type)
      if (listeners === undefined) return
      for (const [listener, once] of [...listeners]) {
        if (once) listeners.delete(listener)
        try {
          listener(event)
        } catch (error) {
          reportError(error)
        }
      }
    }
  }

  // Smoke tests ask the page to report when the composer appears, and when it first accepts input (which needs an
  // open Workspace). Measurement runs leave this off, so both shells are observed by the same external probe.
  if (__TTOKEN_MARK_COMPOSER__) {
    const pending = new Map([
      ['composer-shown', '[data-composer-input]'],
      ['composer-ready', '[data-composer-input][contenteditable="true"]'],
    ])
    const poll = setInterval(() => {
      for (const [event, selector] of pending) {
        if (document.querySelector(selector) === null) continue
        pending.delete(event)
        invoke('desktop_mark', { event }).catch(() => {})
      }
      if (pending.size === 0) clearInterval(poll)
    }, 100)
  }

  // The Web entry assigns `__DSH_TRANSPORT__` after boot. Every assigned value keeps the ticket socket factory, so
  // the entry needs no change for this shell.
  const createWebSocket = url => new TicketedWebSocket(url)
  let transport
  Object.defineProperty(window, '__DSH_TRANSPORT__', {
    configurable: false,
    enumerable: false,
    get: () => transport,
    set: (value) => {
      transport = value === undefined || value === null ? value : Object.freeze({ ...value, createWebSocket })
    },
  })
})()
