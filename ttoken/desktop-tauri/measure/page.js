// Page helpers for the TTOken Code desktop measurements. Measure-Desktop.ps1 evaluates this through the DevTools
// protocol until it returns true, then calls window.__ttokenMeasure. Selectors use data attributes and ARIA roles of the Web
// client, so they hold in every interface language; the rail labels list all eight locales.
(() => {
  if (window.__ttokenMeasure !== undefined) return true
  // Chromium lists a page under the URL it is navigating to while the frame still holds its initial about:blank
  // document, so an early install could land there and be lost when the app document commits. The caller retries
  // until the app document has the helpers.
  if (location.protocol === 'about:') return false

  const COMPOSER = '[data-composer-input][contenteditable="true"]'
  const ASSISTANT_STEP = '[data-chat-flow-kind="assistant-step"]'
  const TURN_TAIL = '[data-chat-flow-key^="9:turn-tail"]'
  const RAIL_LABELS = {
    device: ['Device', '设备', 'デバイス', 'Dispositivo', 'Appareil', 'Gerät', 'Устройство'],
    issues: ['Issues'],
    home: ['Home', '首页', 'ホーム', 'Inicio', 'Accueil', 'Start', 'Главная', 'Início'],
  }

  const nextFrames = count => new Promise((resolve) => {
    const step = left => (left === 0 ? resolve() : requestAnimationFrame(() => { step(left - 1) }))
    step(count)
  })

  // Resolve with the predicate's first truthy value, checked once per animation frame.
  const waitFor = (predicate, timeoutMs, what) => new Promise((resolve, reject) => {
    const started = performance.now()
    const check = () => {
      const value = predicate()
      if (value) { resolve(value); return }
      if (performance.now() - started > timeoutMs) { reject(new Error(`timed out waiting for ${what}`)); return }
      requestAnimationFrame(check)
    }
    check()
  })

  // Viewport center of an element after scrolling it into view, for a trusted DevTools click.
  const center = (element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  // The transcript's scrolling element: the nearest ancestor of the chat flow whose content overflows it.
  const transcriptScroller = () => {
    let element = document.querySelector('[data-chat-flow]')
    while (element !== null && !(element.scrollHeight > element.clientHeight + 1
      && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))) element = element.parentElement
    if (element === null) throw new Error('no scrollable transcript is open')
    return element
  }

  const lastAssistantText = () => {
    const steps = document.querySelectorAll(ASSISTANT_STEP)
    return steps.length === 0 ? '' : steps[steps.length - 1].textContent ?? ''
  }

  // Composer readiness: the wall-clock time the composer first accepted input. `late` means it already did when the
  // watcher was installed, so the time is an upper bound.
  const composer = { at: undefined, late: false }
  if (document.querySelector(COMPOSER) !== null) {
    composer.at = Date.now()
    composer.late = true
  }
  else {
    const watch = () => {
      if (document.querySelector(COMPOSER) !== null) composer.at = Date.now()
      else requestAnimationFrame(watch)
    }
    requestAnimationFrame(watch)
  }

  // One session switch: from the trusted pointer press on the Session row until the target's last answer shows,
  // plus two frames for the rendering opportunity.
  let pendingSwitch

  window.__ttokenMeasure = {
    composerState: () => (composer.at === undefined ? null : { at: composer.at, late: composer.late }),

    sessionRow: (sessionId) => {
      const row = document.querySelector(`[role="treeitem"][data-row-key="session:${CSS.escape(sessionId)}"]`)
      return row === null ? null : center(row)
    },

    // Whether the Session is the one open in the main view; clicking its row then switches nothing.
    sessionSelected: (sessionId) => {
      const row = document.querySelector(`[role="treeitem"][data-row-key="session:${CSS.escape(sessionId)}"]`)
      return row !== null && row.getAttribute('aria-selected') === 'true'
    },

    // Forget every saved right-sidebar layout (ui-sidebar-right persistence.ts), so the next launch opens each
    // Session with the default sidebar. The layouts are written when they change, not when the page closes.
    clearSidebarLayouts: () => {
      const keys = []
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key !== null && key.startsWith('dsh.sidebar-right.v1.')) keys.push(key)
      }
      for (const key of keys) localStorage.removeItem(key)
      return keys.length
    },

    // The confirming (last) button of an open dialog, such as the Preview Notice, for setup runs.
    dialogButton: () => {
      const dialog = document.querySelector('[role="dialog"], dialog[open]')
      const buttons = dialog === null ? [] : dialog.querySelectorAll('button:not([disabled])')
      return buttons.length === 0 ? null : center(buttons[buttons.length - 1])
    },

    railButton: (name) => {
      const labels = RAIL_LABELS[name]
      const button = Array.from(document.querySelectorAll('nav button[aria-label]'))
        .find(candidate => labels.includes(candidate.getAttribute('aria-label')))
      return button === undefined ? null : center(button)
    },

    prepareSwitch: (marker, timeoutMs) => {
      const state = { start: undefined }
      addEventListener('pointerdown', (event) => {
        if (event.isTrusted && state.start === undefined) state.start = event.timeStamp
      }, { capture: true, once: true })
      pendingSwitch = waitFor(() => state.start !== undefined && lastAssistantText().includes(marker), timeoutMs, marker)
        .then(() => nextFrames(2))
        .then(() => performance.now() - state.start)
      // Keep an early failure from surfacing as an unhandled rejection before awaitSwitch reads it.
      pendingSwitch.catch(() => {})
      return true
    },

    awaitSwitch: () => pendingSwitch,

    turnCount: () => document.querySelectorAll(TURN_TAIL).length,

    // Scroll to the top of the transcript until its history start: reaching the history edge loads the previous
    // page, as it does for a user scrolling up. A page that has not loaded after three seconds is requested with
    // the edge's button.
    loadAllHistory: async (timeoutMs) => {
      const scroller = transcriptScroller()
      const started = performance.now()
      const more = () => document.querySelector('[data-chat-history] button:not([disabled])')
      let pages = 0
      while (more() !== null) {
        if (performance.now() - started > timeoutMs) throw new Error('timed out loading older turns')
        const before = document.querySelectorAll(TURN_TAIL).length
        const loaded = () => document.querySelectorAll(TURN_TAIL).length > before || more() === null
        scroller.scrollTop = 0
        try {
          await waitFor(loaded, 3000, 'older turns')
        } catch {
          more()?.click()
          await waitFor(loaded, 30000, 'older turns')
        }
        pages += 1
        await nextFrames(2)
      }
      return { pages, turns: document.querySelectorAll(TURN_TAIL).length }
    },

    // Scroll the transcript from its top to its bottom one viewport at a time, two frames per step.
    scrollTranscript: async () => {
      const scroller = transcriptScroller()
      scroller.scrollTop = 0
      await nextFrames(2)
      let steps = 0
      while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1 && steps < 10000) {
        scroller.scrollTop += scroller.clientHeight
        steps += 1
        await nextFrames(2)
      }
      return { steps, turns: document.querySelectorAll(TURN_TAIL).length, height: scroller.scrollHeight }
    },
  }
  return true
})()
