/**
 * lingflow-panel — client half.
 *
 * Two contributions, one feature:
 *   sidebar.panellist  id  'lingflow-panel'  the icon in the DSH sidebar
 *   main               key 'lingflow-panel'  the workspace panel it opens
 *
 * The panel body is the real LingFlow page — the very file the desktop window
 * loads — so the sidebar and the window are the same UI by construction and
 * every future change to ui/ shows up here without touching this file.
 *
 * Everything LingFlow does not have lives in a thin bar *above* the page:
 * connection state, reload, restart the shared service, open the desktop
 * window, and a diagnostics drawer. Keeping that chrome outside the framed page
 * is what lets the page stay byte-for-byte the window's UI.
 *
 * The guest is pointed at the same-origin host route `/lingflow-panel/api/frame`,
 * which answers with a 302 to the shared service with the token in the fragment.
 * The renderer therefore never holds the token; the host also decides whether
 * the service has to be started first.
 *
 * Loaded as a plain script (no build step, no JSX): the host supplies `require`
 * and only `react` is guaranteed.
 */

window.__ModuleLoader__.load({
  id: 'lingflow-panel',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /* ============================================================== constants */

    const NS = 'lingflow-panel'
    const PANEL_ID = 'lingflow-panel'
    const PANEL_ORDER = 60

    const API = '/lingflow-panel/api'
    const FRAME_PATH = API + '/frame'

    // The host route is loopback and cheap; this cadence is fast enough to notice
    // a service restart (and therefore a reload of the frame) within seconds.
    const STATUS_POLL_MS = 5000
    const BOOT_RETRY_MS = 4000
    const REQUEST_TIMEOUT_MS = 10000
    // How long a guest may stay blank before the other embedding strategy is
    // tried. A blocked frame never fires load, so this is the only signal.
    const FRAME_SETTLE_MS = 12000
    const TOAST_MS = 6000
    const LOG_BATCH_MS = 150
    const LOG_MAX_ENTRIES = 60

    const STORE_MODE = 'lingflow-panel.render-mode'
    const STORE_DIAG = 'lingflow-panel.diag-open'

    const BACKGROUND = '#0e1116'
    const BAR = '#141a24'
    const BORDER = 'rgba(120, 140, 190, 0.22)'
    const TEXT = '#e6e9ef'
    const MUTED = '#9aa4b2'
    const ACCENT = '#4d6bfe'
    const GOOD = '#3ecf8e'
    const WARN = '#f0b03a'
    const BAD = '#e2706f'

    const ZH = {
      nav: 'LingFlow',
      probing: '连接中…',
      online: '在线',
      offline: '服务未连接',
      failed: '界面加载失败',
      connecting: '正在连接 LingFlow 服务…',
      offlineHint: '侧边栏会自动拉起服务；如果一直停在这里，用下面的「诊断」看原因。',
      reload: '刷新',
      reloadTitle: '重新加载 LingFlow 页面',
      restart: '重启服务',
      restartTitle: '重启共享服务（仅当服务由侧边栏拉起时可用）',
      restarting: '重启中…',
      desktop: '独立窗口',
      desktopTitle: '打开 LingFlow 独立窗口（与本面板共用同一个服务）',
      diagnose: '诊断',
      diagnoseTitle: '显示连接详情与最近的失败原因',
      retry: '重试',
      close: '收起',
      copy: '复制诊断',
      copied: '已复制',
      renderMode: '渲染方式',
      renderFrame: '网页框架',
      renderWeb: '桌面视图',
      switchRender: '切换',
      frameAddress: '页面地址',
      serviceLine: '服务',
      codeLine: '代码',
      bridgeLine: '桌面桥',
      bridgeYes: '可用（webview）',
      bridgeNo: '不可用（iframe）',
      logsLine: '日志',
      eventsLine: '最近事件',
      noEvents: '（暂无）',
      codeStale: '代码已更新，刷新后生效',
      frameFailedHint:
        '两种嵌入方式都没有加载出界面。可以点「刷新」再试，或用「独立窗口」直接打开。',
      openFailed: '打不开独立窗口：',
      restartDone: '服务已重启',
      restartBlocked: '服务由独立窗口托管，请在那里重启',
      onlineAt: '在线 · 端口',
    }
    const EN = {
      nav: 'LingFlow',
      probing: 'Connecting…',
      online: 'Online',
      offline: 'Service offline',
      failed: 'View failed to load',
      connecting: 'Connecting to the LingFlow service…',
      offlineHint:
        'The sidebar starts the service on demand; open Diagnostics if it stays here.',
      reload: 'Reload',
      reloadTitle: 'Reload the LingFlow page',
      restart: 'Restart',
      restartTitle: 'Restart the shared service (only when the sidebar started it)',
      restarting: 'Restarting…',
      desktop: 'Window',
      desktopTitle: 'Open the LingFlow desktop window (same shared service)',
      diagnose: 'Diagnostics',
      diagnoseTitle: 'Show connection details and the last failure',
      retry: 'Retry',
      close: 'Hide',
      copy: 'Copy diagnostics',
      copied: 'Copied',
      renderMode: 'Render mode',
      renderFrame: 'Frame',
      renderWeb: 'Desktop view',
      switchRender: 'Switch',
      frameAddress: 'View URL',
      serviceLine: 'Service',
      codeLine: 'Code',
      bridgeLine: 'Desktop bridge',
      bridgeYes: 'available (webview)',
      bridgeNo: 'unavailable (iframe)',
      logsLine: 'Logs',
      eventsLine: 'Recent events',
      noEvents: '(none)',
      codeStale: 'Code changed on disk; reload to pick it up',
      frameFailedHint:
        'Neither embedding strategy loaded the view. Try Reload, or open the desktop window.',
      openFailed: 'Could not open the desktop window: ',
      restartDone: 'Service restarted',
      restartBlocked: 'The service belongs to the desktop window; restart it there',
      onlineAt: 'Online · port',
    }

    /* ================================================================ locale -- */

    let localeService = null

    function translate(key) {
      const fallback = ZH[key] || key
      try {
        const snapshot =
          localeService && typeof localeService.getSnapshot === 'function'
            ? localeService.getSnapshot()
            : null
        const active =
          snapshot && typeof snapshot.active === 'string' ? snapshot.active : 'zh'
        const dict = String(active).toLowerCase().startsWith('en') ? EN : ZH
        return typeof dict[key] === 'string' ? dict[key] : fallback
      } catch (failure) {
        return fallback
      }
    }

    /* ================================================================ helpers -- */

    function messageOf(failure) {
      return String((failure && failure.message) || failure || '未知错误')
    }

    function readStored(key) {
      try {
        return globalThis.localStorage.getItem(key)
      } catch (failure) {
        return null
      }
    }

    function writeStored(key, value) {
      try {
        globalThis.localStorage.setItem(key, value)
      } catch (failure) {
        // Private mode or a storage quota: the choice just does not survive.
      }
    }

    async function request(path, method, body) {
      const controller =
        typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller
        ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : undefined
      try {
        const init = {
          method: method || 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: controller ? controller.signal : undefined,
        }
        if (body !== undefined) {
          // The host rejects writes that are not JSON, which is what keeps a
          // foreign page from driving the panel through a form post.
          init.headers = Object.assign({}, init.headers, {
            'Content-Type': 'application/json',
          })
          init.body = JSON.stringify(body)
        }
        const response = await fetch(path, init)
        const text = await response.text()
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch (failure) {
          parsed = null
        }
        return { status: response.status, body: parsed, text }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    function readError(result) {
      if (result && result.body && typeof result.body.error === 'string' && result.body.error)
        return result.body.error
      if (result && typeof result.text === 'string' && result.text.trim())
        return result.text.trim().slice(0, 300)
      return 'HTTP ' + (result ? result.status : '?')
    }

    function detectBridge() {
      try {
        const bridge = globalThis.dshDesktop && globalThis.dshDesktop.browser
        if (!bridge) return null
        if (typeof bridge.acquire !== 'function') return null
        if (typeof bridge.release !== 'function') return null
        return bridge
      } catch (failure) {
        return null
      }
    }

    // The old check looked for `webview` on document.body, which is never true
    // and made every diagnosis report "webviewTag: no" even in the desktop shell
    // that does enable the tag. Only a created element can answer this.
    function hasWebviewTag() {
      try {
        const element = document.createElement('webview')
        return typeof element.loadURL === 'function' || typeof element.setAttribute === 'function' && element.tagName.toLowerCase() === 'webview'
      } catch (failure) {
        return false
      }
    }

    function isLoopbackHost(hostname) {
      const host = String(hostname || '')
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
    }

    function frameUrl() {
      try {
        return new URL(FRAME_PATH, globalThis.location.href).href
      } catch (failure) {
        return FRAME_PATH
      }
    }

    function stamp(at) {
      try {
        const date = new Date(at)
        const pad = (value) => String(value).padStart(2, '0')
        return (
          pad(date.getHours()) +
          ':' +
          pad(date.getMinutes()) +
          ':' +
          pad(date.getSeconds())
        )
      } catch (failure) {
        return ''
      }
    }

    /**
     * Client-side breadcrumbs.
     *
     * A blank panel cannot be debugged from the outside: the renderer has no
     * console the operator can read. Every step therefore also goes to the host,
     * which appends it to a file next to the service's own state, so a white
     * screen leaves a trace that can be read from disk afterwards.
     */
    function createLogger() {
      const entries = []
      let queue = []
      let timer
      let inFlight = false

      const flush = async () => {
        if (inFlight || queue.length === 0) return
        inFlight = true
        const batch = queue
        queue = []
        try {
          await request(API + '/log', 'POST', {
            events: batch,
            userAgent: (globalThis.navigator && globalThis.navigator.userAgent) || '',
            href: (globalThis.location && globalThis.location.href) || '',
          })
        } catch (failure) {
          // Logging must never be the reason the panel fails.
        }
        inFlight = false
        if (queue.length > 0) schedule()
      }

      const schedule = () => {
        if (timer !== undefined || inFlight) return
        timer = setTimeout(() => {
          timer = undefined
          void flush()
        }, LOG_BATCH_MS)
      }

      const push = (event, detail) => {
        const entry = {
          at: Date.now(),
          event: String(event).slice(0, 60),
          detail: detail === undefined || detail === null ? null : String(detail).slice(0, 500),
        }
        entries.push(entry)
        if (entries.length > LOG_MAX_ENTRIES) entries.splice(0, entries.length - LOG_MAX_ENTRIES)
        queue.push(entry)
        if (queue.length > 24) queue.splice(0, queue.length - 24)
        schedule()
      }

      return { push, recent: () => entries.slice() }
    }

    /* ================================================================== icon -- */

    function Glyph(props) {
      const size = (props && props.size) || 16
      const active = !!(props && props.active)
      const stroke = active ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 3.5, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 15, y: 3.5, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 9, y: 15.5, width: 6, height: 5, rx: 1.5 }),
        h('path', { d: 'M6 8.5v2.9c0 .9.7 1.6 1.6 1.6h8.8c.9 0 1.6-.7 1.6-1.6V8.5' }),
        h('path', { d: 'M12 13v2.5' }),
      )
    }

    /* ============================================================ guest views -- */

    const FRAME_STYLE = {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 'none',
      display: 'block',
      background: BACKGROUND,
    }

    const GUEST_ALLOW =
      'clipboard-write; clipboard-read; fullscreen; autoplay; microphone; camera'

    /**
     * Desktop shell: the same `<webview>` handshake DSH's own browser uses.
     *
     * The shell hands out a lease for a dedicated session partition; the guest
     * starts on the lease's blank URL and is navigated afterwards. Unlike a
     * plain frame this keeps the framed page in its own process.
     */
    function WebviewGuest({ bridge, url, onReady, onFail, log }) {
      const mount = useRef(null)

      useEffect(() => {
        const container = mount.current
        if (!container) return undefined
        let disposed = false
        let guest = null
        let lease = null
        let loaded = false
        let retryTimer
        let startTimer

        const fail = (reason) => {
          if (disposed || loaded) return
          loaded = true
          log('webview-fail', reason)
          onFail(reason)
        }
        const settle = () => {
          if (disposed || loaded) return
          loaded = true
          log('webview-loaded', String(guest && guest.getURL && guest.getURL()))
          onReady()
        }
        const release = async (id) => {
          try {
            await bridge.release(id)
          } catch (failure) {
            // The shell already dropped the lease; nothing to undo.
          }
        }
        // The frame route redirects to the service, so the origin that lands is
        // the service's, not ours. Any loopback http page counts as landed.
        const landed = () => {
          try {
            const current = guest && typeof guest.getURL === 'function' ? guest.getURL() : ''
            const parsed = new URL(current)
            return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
          } catch (failure) {
            return false
          }
        }
        const isAbort = (error) => {
          if (!error) return false
          if (error.code === 'ERR_ABORTED' || error.errno === -3) return true
          return /ERR_ABORTED|\(-3\)/.test(String(error.message || error))
        }
        const load = (attempt) => {
          const element = guest
          if (disposed || !element) return
          Promise.resolve()
            .then(() => element.loadURL(url))
            .then(
              () => {
                if (!disposed && landed()) settle()
              },
              (error) => {
                if (disposed || guest !== element || loaded) return
                const text = String((error && error.message) || error)
                const temporary =
                  isAbort(error) ||
                  /ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ERR_TIMED_OUT|ERR_NETWORK_CHANGED/.test(
                    text,
                  )
                if (temporary && attempt < 2) {
                  log('webview-retry', attempt + ':' + text.slice(0, 120))
                  retryTimer = setTimeout(() => load(attempt + 1), attempt === 0 ? 200 : 600)
                  return
                }
                fail(text.slice(0, 200))
              },
            )
        }
        const open = async () => {
          const reservation = await bridge.acquire(PANEL_ID)
          log('webview-lease', String(reservation && reservation.lease))
          if (disposed) {
            await release(reservation.lease)
            return
          }
          lease = reservation.lease
          guest = document.createElement('webview')
          Object.keys(FRAME_STYLE).forEach((key) => {
            guest.style[key] = FRAME_STYLE[key]
          })
          guest.dataset.sidebarBrowserFrame = 'webview'
          guest.setAttribute('name', lease)
          guest.setAttribute('partition', reservation.partition)
          guest.setAttribute('allowpopups', '')
          let started = false
          const begin = () => {
            if (disposed || started) return
            started = true
            clearTimeout(startTimer)
            log('webview-navigate', url)
            load(0)
          }
          guest.addEventListener('dom-ready', begin, { once: true })
          guest.addEventListener('did-finish-load', () => {
            if (!disposed && landed()) settle()
          })
          guest.addEventListener('did-fail-load', (event) => {
            if (disposed || !event || !event.isMainFrame) return
            fail('did-fail-load ' + String(event.errorCode || '') + ' ' + String(event.errorDescription || ''))
          })
          guest.addEventListener('render-process-gone', () => fail('render-process-gone'))
          // The shell accepts the lease's blank URL before navigation.
          guest.setAttribute('src', 'about:blank#' + lease)
          container.appendChild(guest)
          // If the blank bootstrap never reports dom-ready, navigate anyway.
          startTimer = setTimeout(begin, 1500)
        }
        void open().catch((failure) => fail('acquire: ' + messageOf(failure)))

        return () => {
          disposed = true
          clearTimeout(retryTimer)
          clearTimeout(startTimer)
          if (guest && guest.remove) guest.remove()
          if (lease) void release(lease)
        }
      }, [bridge, url, onFail, onReady, log])

      return h('div', { style: FRAME_STYLE, ref: mount })
    }

    /** Browser (or webview-less shell): a plain frame. */
    function IframeGuest({ url, onReady, log }) {
      const loaded = useCallback(() => {
        log('iframe-loaded', url)
        onReady()
      }, [log, onReady, url])
      return h('iframe', {
        key: url,
        src: url,
        title: translate('nav'),
        allow: GUEST_ALLOW,
        referrerPolicy: 'no-referrer',
        onLoad: loaded,
        style: FRAME_STYLE,
      })
    }

    /* ================================================================= styles -- */

    const ROOT_STYLE = {
      position: 'relative',
      height: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      // DSH reserves room for the window controls above the panel; when the
      // variable is absent this is simply zero.
      paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
      background: BACKGROUND,
      color: TEXT,
      overflow: 'hidden',
    }

    const BAR_STYLE = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 30,
      padding: '0 8px',
      background: BAR,
      borderBottom: '1px solid ' + BORDER,
      font:
        '12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      color: MUTED,
      userSelect: 'none',
    }

    const DOT_STYLE = {
      width: 7,
      height: 7,
      borderRadius: '50%',
      flex: '0 0 auto',
      background: MUTED,
    }

    const BUTTON_STYLE = {
      appearance: 'none',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1,
      height: 22,
      padding: '0 9px',
      borderRadius: 6,
      color: TEXT,
      border: '1px solid ' + BORDER,
      background: 'rgba(255, 255, 255, 0.04)',
      whiteSpace: 'nowrap',
    }

    const DISABLED_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
      cursor: 'default',
      color: 'rgba(154, 164, 178, 0.55)',
      background: 'transparent',
    })

    const STAGE_STYLE = {
      position: 'relative',
      flex: '1 1 auto',
      minHeight: 0,
      display: 'flex',
    }

    const STATE_STYLE = {
      margin: 'auto',
      maxWidth: 480,
      padding: '0 24px',
      textAlign: 'center',
      font:
        '13px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      color: MUTED,
    }

    const TITLE_STYLE = {
      margin: '0 0 6px',
      fontSize: 14,
      fontWeight: 600,
      color: TEXT,
    }

    const DETAIL_STYLE = {
      margin: '0 0 14px',
      fontSize: 12,
      color: MUTED,
      overflowWrap: 'anywhere',
    }

    const DIAG_STYLE = {
      flex: '0 0 auto',
      maxHeight: 220,
      overflow: 'auto',
      padding: '8px 10px 10px',
      background: 'rgba(255, 255, 255, 0.02)',
      borderBottom: '1px solid ' + BORDER,
      font:
        '11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      color: MUTED,
    }

    const ROW_STYLE = {
      display: 'flex',
      gap: 6,
      alignItems: 'baseline',
      marginBottom: 2,
    }

    const KEY_STYLE = {
      flex: '0 0 auto',
      minWidth: 68,
      color: 'rgba(154, 164, 178, 0.75)',
    }

    /* ============================================================ chrome bits -- */

    function ToolButton(props) {
      const disabled = !!(props && props.disabled)
      return h(
        'button',
        {
          type: 'button',
          title: props.title || '',
          disabled,
          onClick: disabled ? undefined : props.onClick,
          style: disabled ? DISABLED_BUTTON_STYLE : BUTTON_STYLE,
        },
        props.children,
      )
    }

    function phaseColor(phase) {
      if (phase === 'ready') return GOOD
      if (phase === 'offline') return WARN
      if (phase === 'error') return BAD
      return MUTED
    }

    function phaseLabel(phase) {
      if (phase === 'ready') return translate('online')
      if (phase === 'offline') return translate('offline')
      if (phase === 'error') return translate('failed')
      return translate('probing')
    }

    function Toolbar(props) {
      const { phase, service, busy, onReload, onRestart, onDesktop, onDiag, diagOpen } = props
      const owned = !!(service && service.mode === 'owned')
      const parts = []
      parts.push(
        h('span', {
          key: 'dot',
          style: Object.assign({}, DOT_STYLE, { background: phaseColor(phase) }),
        }),
      )
      const label =
        phase === 'ready' && service && service.port
          ? translate('onlineAt') + ' ' + service.port
          : phaseLabel(phase)
      parts.push(h('span', { key: 'label', style: { whiteSpace: 'nowrap' } }, label))
      parts.push(h('span', { key: 'grow', style: { flex: '1 1 auto' } }))
      parts.push(
        h(
          ToolButton,
          { key: 'reload', title: translate('reloadTitle'), onClick: onReload },
          translate('reload'),
        ),
      )
      parts.push(
        h(
          ToolButton,
          {
            key: 'restart',
            title: owned ? translate('restartTitle') : translate('restartBlocked'),
            disabled: !owned || busy === 'restart',
            onClick: onRestart,
          },
          busy === 'restart' ? translate('restarting') : translate('restart'),
        ),
      )
      parts.push(
        h(
          ToolButton,
          { key: 'desktop', title: translate('desktopTitle'), onClick: onDesktop },
          translate('desktop'),
        ),
      )
      parts.push(
        h(
          ToolButton,
          { key: 'diag', title: translate('diagnoseTitle'), onClick: onDiag },
          translate(diagOpen ? 'close' : 'diagnose'),
        ),
      )
      return h('div', { style: BAR_STYLE }, parts)
    }

    function DiagRow({ label, children }) {
      return h('div', { style: ROW_STYLE }, h('span', { style: KEY_STYLE }, label), h('span', { style: { overflowWrap: 'anywhere' } }, children))
    }

    function Diagnostics(props) {
      const { phase, service, code, bridge, mode, logs, events, note, onSwitchRender, onCopy, copied, errorText } = props
      const children = []
      children.push(
        h(
          DiagRow,
          { key: 'render', label: translate('renderMode') },
          h(
            'span',
            null,
            mode === 'webview' ? translate('renderWeb') : translate('renderFrame'),
            ' · ',
            h(
              'button',
              {
                type: 'button',
                onClick: onSwitchRender,
                style: Object.assign({}, BUTTON_STYLE, { height: 18, padding: '0 6px', fontSize: 11 }),
              },
              translate('switchRender'),
            ),
          ),
        ),
      )
      children.push(
        h(DiagRow, { key: 'url', label: translate('frameAddress') }, FRAME_PATH),
      )
      children.push(
        h(
          DiagRow,
          { key: 'service', label: translate('serviceLine') },
          service
            ? String(service.mode) + ' · :' + String(service.port) + ' · pid ' + String(service.pid) + ' · ' + (service.authorized ? 'auth ok' : 'auth ?')
            : '—',
        ),
      )
      children.push(
        h(
          DiagRow,
          { key: 'code', label: translate('codeLine') },
          code
            ? 'latest ' + String(code.latest) + (code.changed ? ' · ' + translate('codeStale') : '') + (code.autoReloaded ? ' · auto-reloaded' : '')
            : '—',
        ),
      )
      children.push(
        h(
          DiagRow,
          { key: 'bridge', label: translate('bridgeLine') },
          bridge ? translate('bridgeYes') : translate('bridgeNo'),
        ),
      )
      if (logs && logs.client)
        children.push(h(DiagRow, { key: 'logs', label: translate('logsLine') }, logs.client))
      if (errorText) children.push(h(DiagRow, { key: 'error', label: 'error' }, errorText))
      if (note) children.push(h(DiagRow, { key: 'note', label: 'note' }, note))
      children.push(
        h(
          'div',
          { key: 'actions', style: { display: 'flex', gap: 6, margin: '6px 0 4px' } },
          h(
            ToolButton,
            { onClick: onCopy },
            translate(copied ? 'copied' : 'copy'),
          ),
        ),
      )
      children.push(
        h('div', { key: 'events-title', style: { margin: '2px 0' } }, translate('eventsLine')),
      )
      if (!events || events.length === 0)
        children.push(h('div', { key: 'events-empty' }, translate('noEvents')))
      else
        for (const entry of events.slice(-14))
          children.push(
            h(
              'div',
              { key: 'ev-' + entry.at + '-' + entry.event },
              stamp(entry.at) + ' ' + entry.event + (entry.detail ? ' · ' + entry.detail : ''),
            ),
          )
      return h('div', { style: DIAG_STYLE }, children)
    }

    /* ================================================================== panel -- */

    function LingFlowPanel() {
      const [phase, setPhase] = useState('probing')
      const [status, setStatus] = useState(null)
      const [errorText, setErrorText] = useState('')
      const [frameKey, setFrameKey] = useState(0)
      const [frameReady, setFrameReady] = useState(false)
      const [mode, setModeState] = useState(() =>
        readStored(STORE_MODE) === 'webview' ? 'webview' : 'iframe',
      )
      const [diagOpen, setDiagOpen] = useState(() => readStored(STORE_DIAG) === '1')
      const [toast, setToast] = useState('')
      const [busy, setBusy] = useState('')
      const [copied, setCopied] = useState(false)
      const [, bumpEvents] = useState(0)

      const bridgeRef = useRef(undefined)
      if (bridgeRef.current === undefined) bridgeRef.current = detectBridge()
      const loggerRef = useRef(null)
      if (loggerRef.current === null) loggerRef.current = createLogger()
      const logger = loggerRef.current

      const signatureRef = useRef('')
      const stampRef = useRef(0)
      const startsRef = useRef(0)
      const aliveRef = useRef(true)
      const phaseRef = useRef(phase)
      phaseRef.current = phase

      const setMode = useCallback((next) => {
        writeStored(STORE_MODE, next)
        setModeState(next)
      }, [])

      const remember = useCallback(
        (event, detail) => {
          logger.push(event, detail)
          bumpEvents((value) => value + 1)
        },
        [logger],
      )

      useEffect(() => {
        let active = true
        const userAgent =
          (globalThis.navigator && globalThis.navigator.userAgent) || ''
        remember(
          'mount',
          JSON.stringify({
            mode,
            bridge: bridgeRef.current ? 'yes' : 'no',
            webviewTag: hasWebviewTag() ? 'yes' : 'no',
            // The ancestor origin is what a framing page must allow: inside the
            // desktop shell it is dsh-app://app, which is not an http origin.
            ancestor: String(
              (globalThis.location &&
                globalThis.location.ancestorOrigins &&
                globalThis.location.ancestorOrigins[0]) ||
                '',
            ).slice(0, 120),
            ua: userAgent.slice(0, 120),
            href: String((globalThis.location && globalThis.location.href) || '').slice(0, 120),
          }),
        )
        // A view that got here through an <iframe> must not silently look blank:
        // the parent's CSP would drop the frame without any error event.
        return () => {
          active = false
        }
        // Mount only: `mode` is captured for the first breadcrumb.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(''), TOAST_MS)
        return () => clearTimeout(timer)
      }, [toast])

      const applyStatus = useCallback(
        (body) => {
          const service = body.service || null
          const code = body.code || null
          setStatus({ service, code, logs: body.logs || null, frame: body.frame || null })
          const signature =
            service && service.pid ? String(service.pid) + ':' + String(service.startedAt || '') : ''
          // A new process (code reload, crash recovery) means the old guest holds
          // a dead origin: remount it. The redirect hands out the new token.
          if (signatureRef.current && signature && signature !== signatureRef.current) {
            remember('service-changed', signature)
            setFrameReady(false)
            setFrameKey((value) => value + 1)
          }
          if (signature) signatureRef.current = signature
          // Same process, newer code on disk: the service reads ui/ per request,
          // so remounting the guest is enough to show the edit.
          const latest = Number(code && code.latest) || 0
          if (latest > 0) {
            if (stampRef.current && latest > stampRef.current) {
              remember('code-changed', String(latest))
              setFrameReady(false)
              setFrameKey((value) => value + 1)
            }
            stampRef.current = latest
          }
        },
        [remember],
      )

      /**
       * Ask the host whether the shared service is up. The host starts it on
       * demand, so "offline" here means "not started yet", not "broken".
       */
      const probe = useCallback(async () => {
        let result
        try {
          result = await request(API + '/status')
        } catch (failure) {
          const reason = '无法连接面板宿主：' + messageOf(failure)
          remember('status-error', reason)
          return { online: false, error: reason }
        }
        const body = result.body
        if (!body || body.ok !== true) {
          const reason = readError(result)
          remember('status-invalid', reason)
          return { online: false, error: reason }
        }
        applyStatus(body)
        if (!body.online) return { online: false, error: body.error || '' }
        return { online: true, error: '' }
      }, [applyStatus, remember])

      const startOnce = useCallback(async () => {
        // One start attempt per mount is enough: the host is idempotent, but a
        // loop here would fight a service that is still finishing its start-up.
        if (startsRef.current > 2) return
        startsRef.current += 1
        remember('start-request')
        try {
          const result = await request(API + '/start', 'POST', {})
          remember('start-result', readError(result) || 'ok')
        } catch (failure) {
          remember('start-failed', messageOf(failure))
        }
      }, [remember])

      const attempt = useCallback(async () => {
        const first = await probe()
        if (!aliveRef.current) return
        if (first.online) {
          setErrorText('')
          setPhase('ready')
          return
        }
        await startOnce()
        if (!aliveRef.current) return
        const second = await probe()
        if (!aliveRef.current) return
        if (second.online) {
          setErrorText('')
          setPhase('ready')
          return
        }
        setErrorText(second.error || '')
        // Do not overwrite an embedding failure with a connection state: both
        // mean "no view", but only one of them tells the reader what to do.
        if (phaseRef.current !== 'error') setPhase('offline')
      }, [probe, startOnce])

      useEffect(() => {
        aliveRef.current = true
        let timer
        let stopped = false
        const tick = async () => {
          if (stopped) return
          if (typeof document !== 'undefined' && document.hidden) {
            timer = setTimeout(tick, STATUS_POLL_MS)
            return
          }
          await attempt()
          if (stopped) return
          timer = setTimeout(
            tick,
            phaseRef.current === 'ready' ? STATUS_POLL_MS : BOOT_RETRY_MS,
          )
        }
        void tick()
        return () => {
          stopped = true
          aliveRef.current = false
          clearTimeout(timer)
        }
      }, [attempt])

      const reload = useCallback(
        (reason) => {
          remember('reload', reason)
          setFrameReady(false)
          setErrorText('')
          if (phaseRef.current === 'error') setPhase('probing')
          setFrameKey((value) => value + 1)
        },
        [remember],
      )

      const onFrameReady = useCallback(() => {
        setFrameReady(true)
        setErrorText('')
        setPhase('ready')
      }, [])

      const onFrameFail = useCallback(
        (reason) => {
          remember('frame-failed', reason)
          setFrameReady(false)
          if (mode === 'iframe') {
            // A blocked frame reports nothing; a blocked webview reports a load
            // error. Try the other strategy once before declaring failure.
            remember('fallback-webview')
            setMode('webview')
            setFrameKey((value) => value + 1)
            return
          }
          setPhase('error')
          setErrorText(reason || translate('frameFailedHint'))
        },
        [mode, remember, setMode],
      )

      // Watchdog: a guest that never reports load is the failure mode that looks
      // like a white rectangle, so escalation is time-based, not event-based.
      useEffect(() => {
        if (phase !== 'ready' || frameReady) return undefined
        const timer = setTimeout(() => {
          if (mode === 'iframe') {
            remember('frame-timeout', 'iframe')
            remember('fallback-webview')
            setMode('webview')
            setFrameKey((value) => value + 1)
            return
          }
          remember('frame-timeout', 'webview')
          setPhase('error')
          setErrorText(translate('frameFailedHint'))
        }, FRAME_SETTLE_MS)
        return () => clearTimeout(timer)
      }, [phase, frameReady, mode, frameKey, remember, setMode])

      const restart = useCallback(async () => {
        setBusy('restart')
        remember('restart-request')
        try {
          const result = await request(API + '/restart', 'POST', {})
          if (result.body && result.body.ok) {
            remember('restart-ok')
            applyStatus(result.body)
            setFrameReady(false)
            setFrameKey((value) => value + 1)
            setToast(translate('restartDone'))
          } else {
            remember('restart-failed', readError(result))
            setToast(readError(result))
          }
        } catch (failure) {
          remember('restart-failed', messageOf(failure))
          setToast(messageOf(failure))
        } finally {
          setBusy('')
        }
      }, [applyStatus, remember])

      const openDesktop = useCallback(async () => {
        setBusy('desktop')
        remember('desktop-request')
        try {
          const result = await request(API + '/open', 'POST', {})
          if (result.body && result.body.ok === false) {
            remember('desktop-failed', readError(result))
            setToast(translate('openFailed') + readError(result))
          } else {
            remember('desktop-opened', JSON.stringify(result.body && result.body.pid))
          }
        } catch (failure) {
          remember('desktop-failed', messageOf(failure))
          setToast(translate('openFailed') + messageOf(failure))
        } finally {
          setBusy('')
        }
      }, [remember])

      const copyDiagnostics = useCallback(async () => {
        const payload = JSON.stringify(
          {
            at: new Date().toISOString(),
            mode,
            phase,
            error: errorText,
            status,
            events: logger.recent(),
          },
          null,
          2,
        )
        try {
          if (globalThis.navigator && globalThis.navigator.clipboard)
            await globalThis.navigator.clipboard.writeText(payload)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
          remember('diagnostics-copied')
        } catch (failure) {
          remember('diagnostics-copy-failed', messageOf(failure))
          remember('diagnostics', payload.slice(0, 400))
        }
      }, [errorText, logger, mode, phase, remember, status])

      const toggleDiag = useCallback(() => {
        setDiagOpen((open) => {
          writeStored(STORE_DIAG, open ? '0' : '1')
          return !open
        })
      }, [])

      const switchRender = useCallback(() => {
        const next = mode === 'webview' ? 'iframe' : 'webview'
        remember('render-switch', next)
        setMode(next)
        setFrameReady(false)
        setErrorText('')
        setPhase('probing')
        setFrameKey((value) => value + 1)
      }, [mode, remember, setMode])

      const url = frameUrl()
      const showFrame = phase === 'ready' && !errorText

      let stage = null
      if (showFrame && mode === 'webview' && bridgeRef.current) {
        stage = h(WebviewGuest, {
          key: 'webview-' + frameKey,
          bridge: bridgeRef.current,
          url,
          log: remember,
          onReady: onFrameReady,
          onFail: onFrameFail,
        })
      } else if (showFrame && mode === 'webview') {
        // No desktop bridge: the webview branch cannot exist, so fall back rather
        // than waiting for the watchdog to notice.
        stage = h(IframeGuest, {
          key: 'frame-fallback-' + frameKey,
          url,
          log: remember,
          onReady: onFrameReady,
        })
      } else if (showFrame) {
        stage = h(IframeGuest, {
          key: 'frame-' + frameKey,
          url,
          log: remember,
          onReady: onFrameReady,
        })
      } else {
        stage = h(
          'div',
          { style: STATE_STYLE },
          h('p', { style: TITLE_STYLE }, translate(phase === 'error' ? 'failed' : phase === 'offline' ? 'offline' : 'connecting')),
          h(
            'p',
            { style: DETAIL_STYLE },
            errorText || (phase === 'offline' ? translate('offlineHint') : ''),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
            h(
              ToolButton,
              { onClick: () => reload('state-retry') },
              translate('retry'),
            ),
            h(
              ToolButton,
              { onClick: toggleDiag },
              translate('diagnose'),
            ),
          ),
        )
      }

      const children = [
        h(Toolbar, {
          key: 'bar',
          phase,
          service: status && status.service,
          busy,
          diagOpen,
          onReload: () => reload('toolbar'),
          onRestart: restart,
          onDesktop: openDesktop,
          onDiag: toggleDiag,
        }),
      ]
      if (toast)
        children.push(
          h(
            'div',
            {
              key: 'toast',
              style: {
                flex: '0 0 auto',
                padding: '5px 10px',
                fontSize: 12,
                color: WARN,
                background: 'rgba(240, 176, 58, 0.08)',
                borderBottom: '1px solid ' + BORDER,
              },
            },
            toast,
          ),
        )
      if (diagOpen)
        children.push(
          h(Diagnostics, {
            key: 'diag',
            phase,
            service: status && status.service,
            code: status && status.code,
            logs: status && status.logs,
            bridge: bridgeRef.current,
            mode,
            events: logger.recent(),
            note: toast,
            errorText,
            copied,
            onSwitchRender: switchRender,
            onCopy: copyDiagnostics,
          }),
        )
      children.push(h('div', { key: 'stage', style: STAGE_STYLE }, stage))

      return h('div', { style: ROOT_STYLE }, children)
    }

    /* ================================================================== apply -- */

    function apply(ctx) {
      try {
        localeService = ctx.get('locale') || null
      } catch (failure) {
        localeService = null
      }

      try {
        if (localeService && typeof localeService.register === 'function') {
          localeService.register(NS, 'zh', ZH)
          localeService.register(NS, 'en', EN)
        }
      } catch (failure) {
        // A namespace clash must not take the panel down.
        console.warn('[lingflow-panel] locale registration skipped:', messageOf(failure))
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => translate('nav'),
            locale: NS,
          },
          (owner) =>
            h(Glyph, {
              size: (owner && owner.size) || 16,
              active: !!(owner && owner.active),
            }),
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          LingFlowPanel,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
