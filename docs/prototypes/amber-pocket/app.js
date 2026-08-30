(() => {
  const screens = new Map(
    [...document.querySelectorAll('[data-screen]')].map((screen) => [screen.dataset.screen, screen]),
  )
  const appShell = document.getElementById('appShell')
  const bottomNav = document.getElementById('bottomNav')
  const terminalInput = document.getElementById('terminalInput')
  const terminalOutput = document.getElementById('terminalOutput')
  const terminalWrap = document.getElementById('terminalWrap')
  const terminalNotice = document.getElementById('terminalNotice')
  const actionsTitle = document.getElementById('actionsTitle')
  const toast = document.getElementById('toast')
  const createForm = document.getElementById('createForm')
  const createButton = createForm.querySelector('[type="submit"]')
  const sheetTriggers = new Map()
  let currentScreen = 'sessions'
  let currentSession = 'api-refactor'
  let openSheetId = null
  let ctrlArmed = false
  let toastTimer = 0

  const sessions = {
    'api-refactor': { kind: 'Pi', state: 'waiting for input', workspace: 'amber-ide / core' },
    'release-0.4': { kind: 'Codex', state: 'working', workspace: 'amber-ide / release' },
    'tenant-rollout': { kind: 'Grok', state: 'working', workspace: 'inyeon / deploy' },
    'memory-audit': { kind: 'Claude', state: 'suspended to free memory', workspace: 'amber-ide / daemon' },
    'deploy-logs': { kind: 'Shell', state: 'quiet', workspace: 'amber-ide / core' },
  }

  function setScreen(next, { push = true } = {}) {
    if (!screens.has(next)) return
    currentScreen = next
    for (const [name, screen] of screens) {
      const active = name === next
      screen.hidden = !active
      screen.classList.toggle('is-active', active)
      if (active) {
        screen.classList.remove('screen-entering')
        requestAnimationFrame(() => screen.classList.add('screen-entering'))
      }
    }

    const focus = next === 'focus'
    appShell.classList.toggle('is-focus-mode', focus)
    bottomNav.hidden = focus
    document.querySelectorAll('[data-nav]').forEach((button) => {
      const active = button.dataset.nav === next
      button.classList.toggle('is-active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })

    if (focus) {
      terminalWrap.focus({ preventScroll: true })
      terminalInput.focus({ preventScroll: true })
    }

    if (push) {
      history.pushState({ amberPocket: next, session: currentSession }, '', `#${next}`)
    }
  }

  function openSession(name) {
    currentSession = name
    const session = sessions[name] ?? sessions['api-refactor']
    document.getElementById('focusTitle').textContent = name
    document.getElementById('focusState').innerHTML = `<span class="status-mark ${session.state.includes('waiting') ? 'waiting' : session.state.includes('suspended') ? 'suspended' : session.state === 'quiet' ? 'quiet' : 'working'}" aria-hidden="true"></span>teapot-dev / ${session.kind} ${session.state}`
    actionsTitle.textContent = name
    document.querySelector('#actionsSheet .sheet-header p').textContent = `${session.kind} / ${session.workspace}`
    terminalNotice.textContent = session.kind === 'Shell'
      ? 'Following desktop grid without PTY reflow'
      : 'Phone grid borrowed at 44 columns'
    setScreen('focus')
  }

  function showToast(message) {
    window.clearTimeout(toastTimer)
    toast.textContent = message
    toast.hidden = false
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 2600)
  }

  function openSheet(id, trigger = document.activeElement) {
    const sheet = document.getElementById(id)
    if (!sheet) return
    if (openSheetId) closeSheet(openSheetId, false)
    openSheetId = id
    sheetTriggers.set(id, trigger)
    sheet.hidden = false
    const first = sheet.querySelector('button:not(.sheet-backdrop), input')
    window.setTimeout(() => first?.focus({ preventScroll: true }), 10)
    history.pushState({ amberPocket: currentScreen, sheet: id }, '', `#${currentScreen}/${id}`)
  }

  function closeSheet(id = openSheetId, restore = true) {
    if (!id) return
    const sheet = document.getElementById(id)
    if (!sheet) return
    sheet.hidden = true
    openSheetId = null
    if (restore) sheetTriggers.get(id)?.focus({ preventScroll: true })
  }

  function sendText(text) {
    const cursor = terminalOutput.querySelector('.term-cursor')
    const escaped = text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
    cursor.insertAdjacentHTML('beforebegin', escaped)
    terminalOutput.scrollTop = terminalOutput.scrollHeight
    showToast('Sent as terminal input')
    terminalInput.focus({ preventScroll: true })
  }

  function keyLabel(key) {
    const labels = {
      esc: 'Esc',
      tab: 'Tab',
      'shift-tab': 'Shift Tab',
      left: 'Left arrow',
      down: 'Down arrow',
      up: 'Up arrow',
      right: 'Right arrow',
      enter: 'Enter',
      slash: 'Slash',
      interrupt: 'Ctrl C',
    }
    return labels[key] ?? key
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button')
    if (!target) return

    if (target.dataset.nav) {
      setScreen(target.dataset.nav)
      return
    }

    if (target.dataset.openSession) {
      openSession(target.dataset.openSession)
      return
    }

    if (target.dataset.openSheet) {
      openSheet(target.dataset.openSheet, target)
      return
    }

    if (target.dataset.sessionActions) {
      currentSession = target.dataset.sessionActions
      const session = sessions[currentSession]
      actionsTitle.textContent = currentSession
      document.querySelector('#actionsSheet .sheet-header p').textContent = `${session.kind} / ${session.workspace}`
      openSheet('actionsSheet', target)
      return
    }

    if (target.hasAttribute('data-close-sheet')) {
      closeSheet()
      return
    }

    if (target.dataset.sendText) {
      sendText(target.dataset.sendText)
      return
    }

    if (target.dataset.key) {
      if (target.dataset.key === 'ctrl') {
        ctrlArmed = !ctrlArmed
        target.classList.toggle('is-armed', ctrlArmed)
        target.setAttribute('aria-pressed', String(ctrlArmed))
        showToast(ctrlArmed ? 'Ctrl armed for the next key' : 'Ctrl released')
      } else {
        showToast(`${ctrlArmed ? 'Ctrl plus ' : ''}${keyLabel(target.dataset.key)} sent`)
        if (ctrlArmed) {
          ctrlArmed = false
          const ctrl = document.querySelector('[data-key="ctrl"]')
          ctrl.classList.remove('is-armed')
          ctrl.setAttribute('aria-pressed', 'false')
        }
        terminalInput.focus({ preventScroll: true })
      }
      return
    }

    if (target.dataset.action) {
      const label = target.querySelector('span')?.textContent ?? target.textContent
      closeSheet()
      if (target.dataset.action === 'close') showToast(`Confirmation would open for ${currentSession}`)
      else showToast(`${label} selected`)
    }
  })

  document.querySelectorAll('[data-workspace]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspace = button.dataset.workspace
      document.querySelectorAll('[data-workspace]').forEach((item) => {
        const active = item === button
        item.classList.toggle('is-active', active)
        item.setAttribute('aria-pressed', String(active))
      })
      document.querySelectorAll('[data-workspace-row]').forEach((row) => {
        row.hidden = workspace !== 'all' && row.dataset.workspaceRow !== workspace
      })
    })
  })

  document.querySelectorAll('input[name="kind"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) createButton.textContent = `Create ${radio.value} session`
    })
  })

  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = new FormData(createForm)
    closeSheet()
    showToast(`Create ${data.get('kind')} session requested`)
  })

  document.getElementById('focusBack').addEventListener('click', () => {
    setScreen('sessions')
  })

  document.getElementById('machineButton').addEventListener('click', (event) => {
    openSheet('machineSheet', event.currentTarget)
  })

  document.getElementById('machineAction').addEventListener('click', (event) => {
    openSheet('machineSheet', event.currentTarget)
  })

  terminalWrap.addEventListener('click', () => {
    terminalInput.focus({ preventScroll: true })
  })

  terminalInput.addEventListener('input', () => {
    if (terminalInput.value.length > 0) {
      sendText(terminalInput.value)
      terminalInput.value = ''
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (openSheetId) closeSheet()
      else if (currentScreen === 'focus') setScreen('sessions')
    }
  })

  // Keep the whole mobile shell inside the visual viewport. On iOS and Android
  // the layout viewport commonly stays full-height while the software keyboard
  // overlays its bottom; binding to `visualViewport` makes flexbox spend the
  // remaining height on the terminal and keeps the key deck directly above the
  // keyboard. This is prototype-only geometry: production pins PTY rows and
  // moves rendered xterm pixels instead of changing the shared grid.
  const syncVisualViewport = () => {
    const viewport = window.visualViewport
    const mobile = window.matchMedia('(max-width: 780px)').matches
    if (!viewport || !mobile) {
      appShell.style.removeProperty('--visible-viewport-height')
      appShell.style.removeProperty('--visible-viewport-top')
      appShell.classList.remove('keyboard-open')
      return
    }
    const covered = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
    const keyboard = covered > 120
    appShell.style.setProperty('--visible-viewport-height', `${viewport.height}px`)
    appShell.style.setProperty('--visible-viewport-top', `${viewport.offsetTop}px`)
    appShell.classList.toggle('keyboard-open', keyboard)
    if (keyboard && currentScreen === 'focus') terminalOutput.scrollTop = terminalOutput.scrollHeight
  }
  window.visualViewport?.addEventListener('resize', syncVisualViewport)
  window.visualViewport?.addEventListener('scroll', syncVisualViewport)
  window.addEventListener('resize', syncVisualViewport)

  window.addEventListener('popstate', (event) => {
    if (openSheetId) {
      closeSheet(openSheetId)
      return
    }
    const next = event.state?.amberPocket
    setScreen(screens.has(next) ? next : 'sessions', { push: false })
  })

  const [requested, requestedSheet] = location.hash.replace('#', '').split('/')
  setScreen(screens.has(requested) ? requested : 'sessions', { push: false })
  syncVisualViewport()
  if (requestedSheet && document.getElementById(requestedSheet)) {
    openSheet(requestedSheet, document.body)
  }
})()
