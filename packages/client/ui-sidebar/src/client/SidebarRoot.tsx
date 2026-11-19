/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 * Through the browser's hookContext, the shell also hands it the scroller hook
 * that continues wheel scrolling over the sidebar viewport into its list.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconPanelLeftOutlineRegular, IconPinFillRegular, IconPlusOutlineMedium, focusWithoutRing, isBehindModal, isDarwinDesktop,
  Toast, Tooltip, useModalLayer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected, SidebarSectionHookContext,
  SidebarSectionOwnerProps,
} from './contract/slots.ts'
import { createScrollHandoff } from './scroll-handoff.ts'
import css from './SidebarRoot.module.css'
import {
  TTOKEN_CHAT_VIEW, TTOKEN_FOOT_PANELS, TTOKEN_ISSUES_VIEW, TTOKEN_REVIEW_PANEL, TtokenDeviceIcon, TtokenHomeIcon, TtokenIssuesIcon,
  TtokenRailButton, requestConversationView, useDeviceAvailable, useShownConversationView,
} from './ttoken-nav.tsx'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/** Format complete-build metadata for the local brand badge. */
function localBuildVersion(): string | undefined {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return undefined
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  return version
    + (commit === undefined ? '' : `-${commit}`)
    + (process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : '')
}

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick' | 'setPinned'>
  & { readonly unpinLabel: string; readonly unpinTooltip: string; readonly canUnpin: boolean }
  & PropsRenderFactories

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

/** Each panel row subscribes only to its own selection state. */
function PanelRow({
  id, label, wide, unpinLabel, unpinTooltip, canUnpin, usePanelInfo, selectPanel, setPinned, trackEntryClick, renderFactorySlot,
}: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  const trailing = useId()
  return (
    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.panelRow}
          aria-label={label}
          aria-describedby={trailing}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            const entry = officialEntry(id)
            if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
            selectPanel(id)
          }}
        >
          <span className={css.panelGlyph} aria-hidden="true">
            {renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}
          </span>
          {wide && (
            <span className={clsx(css.panelTitle, css.wide)}>
              {label}
            </span>
          )}
          <span id={trailing} className={css.panelTrailing}>{renderFactorySlot('sidebar.panel.trailing', { id, wide, active })}</span>
        </button>
      </Tooltip>
      {wide && canUnpin && <Tooltip label={unpinTooltip} side="bottom" align="end" delayMs={500} portal>
        <button type="button" className={css.panelUnpin} aria-label={unpinLabel} onClick={(event) => {
          // Unpin is rendered only while this navigation also renders More.
          const navigation = event.currentTarget.closest('nav') as HTMLElement
          const more = navigation.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
          focusWithoutRing(more)
          setPinned(id, false)
        }}>
          <IconPinFillRegular size={14} />
        </button>
      </Tooltip>}
    </div>
  )
}

// TTOken Code: the rail lists every panel, so the panel list's More menu is not offered.

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  drawer,
  startSession,
  toggleSidebar,
  selectPanel,
  setPinned,
  trackEntryClick,
  useRemoteAccess,
  usePanels,
  deviceNav,
  openDevice,
  showConversation,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
  renderFactorySlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const deviceAvailable = useDeviceAvailable(deviceNav)
  const shownView = useShownConversationView()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  // A closed drawer retains its content with the rail phase already settled.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (drawer || !collapsed) { setSettled(collapsed); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed, drawer])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled)
  const [scrollHandoff] = useState(createScrollHandoff)
  const sectionHookContext = useMemo<SidebarSectionHookContext>(
    () => ({ useSectionScroller: scrollHandoff.useSectionScroller }), [scrollHandoff],
  )
  // TTOken Code: New Session stays in the rail, also while the Windows sidebar is collapsed.
  const openNewSession = (): void => {
    trackEntryClick({ menu_name: 'new_session', position: 'sidebar' })
    startSession()
  }
  // The Windows caption menus occupy the strip to the right of these controls
  // (that is what --dsh-windows-menu-start reserves), so a right-side bubble
  // lands under their text. Below the caption is the only clear side.
  const captionTooltipSide = windowsTitlebar ? 'bottom' : 'right'
  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (drawer || !collapsed) lastWideWidth.current = width

  // A closed drawer returns to the static rail; only a live collapse fades it in.
  const animateRail = useRef(!collapsed)
  if (drawer || !collapsed) animateRail.current = !collapsed

  // Scrollbars in the column follow the pointer: .quietBars rebinds them away
  // whenever the pointer is outside, and its stylesheet owns the delay and
  // fade, so a pointer that returns before the fade starts sees no change.
  const column = useRef<HTMLDivElement>(null)
  const sidebarFocus = useRef<Element | null>(null)
  useModalLayer(column, drawer && !collapsed, toggleSidebar)
  useLayoutEffect(() => {
    if (!collapsed) return
    const controlled = sidebarFocus.current?.getAttribute('aria-controls')?.split(/\s+/) ?? []
    const ownsMenuFocus = controlled.some(id => document.getElementById(id)?.contains(document.activeElement))
    if (sidebarFocus.current !== document.activeElement && !ownsMenuFocus) return
    const opener = drawer
      ? column.current?.ownerDocument.querySelector<HTMLElement>('[data-sidebar-opener]')
      : column.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')
    if (opener != null && !isBehindModal(opener)) focusWithoutRing(opener, { preventScroll: true })
  }, [drawer, collapsed])
  const [pointerInside, setPointerInside] = useState(false)
  // Inside is decided by the column's BOX, not by DOM containment, for every
  // pointer move that reaches the column. ui-settings renders its
  // full-viewport panel as a fixed-position DESCENDANT of this column, and the
  // column's menus and tooltips are React portals, so a pointer over them
  // fires no `pointerleave` here while their moves still bubble to it. The
  // element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPointerInside(event.clientX >= rect.left && event.clientX < rect.right
      && event.clientY >= rect.top && event.clientY < rect.bottom)
  }

  const buildVersion = localBuildVersion()
  // The local-build fallbacks copy the badge text; the brand button below
  // skips New Session for clicks inside them. The click still bubbles, so
  // document-level outside-click listeners see it.
  // Each successful copy bumps the key so a repeated copy replays the toast.
  const [copiedToast, setCopiedToast] = useState<number | null>(null)
  const copyVersion = (version: string) => (): void => {
    void writeClipboard(version).then((ok) => {
      if (ok) setCopiedToast(seq => (seq ?? 0) + 1)
    })
  }

  const darwinDesktop = isDarwinDesktop()
  // TTOken Code: the toggle rests as the mark at the rail's top in both widths
  // and swaps in the panel icon on hover; the Windows caption row keeps a plain
  // panel icon.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide} portal={drawer}>
      <button
        data-sidebar-toggle
        data-modal-autofocus={drawer || undefined}
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {!windowsTitlebar && (
          <span className={css.railMark} aria-hidden="true">
            {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
          </span>
        )}
        {/* Rail icons render at 18 (figma rail spec); the Windows caption row keeps 16. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  // TTOken Code: the column is an ink icon rail beside the Session panel. The
  // rail carries the TTOken mark, New Session, the navigation, the foot panels,
  // and Settings in both widths. The panel carries the product name and the
  // Workspace browser; collapsed, it stays mounted but hidden, so the browser
  // keeps its state and its search shortcut. The rail lists every panel, so
  // panel pins are not offered.
  const navPanels = panels.filter(({ id }) => !TTOKEN_FOOT_PANELS.includes(id))
  const footPanels = panels.filter(({ id }) => TTOKEN_FOOT_PANELS.includes(id))
  const issuesAvailable = panels.some(({ id }) => id === TTOKEN_REVIEW_PANEL)
  const issuesShown = activePanelId === null && shownView === TTOKEN_ISSUES_VIEW
  const showView = (view: string): void => {
    showConversation?.()
    requestConversationView(view)
  }
  const railRow = ({ id, label }: SidebarPanelMetadata) => (
    <PanelRow
      key={id}
      id={id}
      label={label}
      wide={false}
      unpinLabel={t('panels.unpin', { name: label })}
      unpinTooltip={t('panels.unpinTooltip')}
      canUnpin={false}
      setPinned={setPinned}
      usePanelInfo={usePanelInfo}
      selectPanel={selectPanel}
      trackEntryClick={trackEntryClick}
      renderFactorySlot={renderFactorySlot}
    />
  )

  return (
    <div
      ref={column}
      onFocusCapture={(event) => { sidebarFocus.current = event.target }}
      role={drawer ? 'dialog' : undefined}
      data-shortcut-modal={drawer ? 'sidebar' : undefined}
      aria-modal={drawer && !collapsed ? true : undefined}
      aria-label={drawer ? t('navigation.label') : undefined}
      tabIndex={drawer ? -1 : undefined}
      className={clsx(
        css.root, css.ttokenRoot, !wide && css.collapsed, !wide && animateRail.current && css.railIn,
        !drawer && collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={trackPointer}
      onPointerMove={trackPointer}
      onPointerLeave={() => { setPointerInside(false) }}
    >
      {/* Windows keeps the toggle in its caption row, outside the rail's ink. */}
      {windowsTitlebar && toggle}
      <div className={css.ttokenRail}>
        {/* macOS keeps the traffic lights above the rail. */}
        {darwinDesktop && <div className={css.ttokenRailStrip} />}
        <div className={css.ttokenRailBrand}>
          {/* The mark is the toggle, so it keeps focus across both widths; Windows keeps its toggle in the caption row. */}
          {windowsTitlebar
            ? (
              <span className={css.ttokenRailMark} aria-hidden="true">
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
              </span>
            )
            : toggle}
        </div>
        {canStartSession && (
          <div className={css.ttokenRailNew}>
            {renderSlot('sidebar.session.action', { wide: false }, {
              children: (
                <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500} side="right">
                  <button
                    type="button"
                    className={css.ttokenNewSession}
                    aria-label={t('session.new.label')}
                    aria-keyshortcuts={newShortcut?.aria}
                    onClick={openNewSession}
                  >
                    <IconPlusOutlineMedium size={18} />
                  </button>
                </Tooltip>
              ),
            })}
          </div>
        )}
        <nav className={css.ttokenRailNav} aria-label={t('panels.label')}>
          <TtokenRailButton
            label={t('ttoken.home')}
            icon={<TtokenHomeIcon />}
            active={activePanelId === null && !issuesShown}
            onPress={() => { showView(TTOKEN_CHAT_VIEW) }}
          />
          {navPanels.map(railRow)}
          {issuesAvailable && (
            <TtokenRailButton
              label={t('ttoken.issues')}
              icon={<TtokenIssuesIcon />}
              active={issuesShown}
              onPress={() => { showView(TTOKEN_ISSUES_VIEW) }}
            />
          )}
          {deviceAvailable && openDevice !== undefined && (
            <TtokenRailButton
              label={t('ttoken.device')}
              icon={<TtokenDeviceIcon />}
              onPress={() => { showConversation?.(); openDevice() }}
            />
          )}
        </nav>
        <div className={css.ttokenRailFoot}>
          {footPanels.map(railRow)}
          <div className={css.footerActions}>
            {renderSlot('sidebar.footer.action', { wide: false })}
          </div>
          <div className={css.settingsArea}>
            {renderSlot('sidebar.settings', { wide: false })}
          </div>
        </div>
      </div>
      <div className={clsx(css.ttokenPanel, wide && css.wide)}>
        {/* macOS hiddenInset titlebar: the strip clears the traffic lights. */}
        {wide && darwinDesktop && <div className={css.topStrip} data-window-drag />}
        {wide && (
          <div className={clsx(css.logoRow, css.ttokenPanelHead)} data-window-drag>
            <span className={css.brandName}>
              {renderSlot('sidebar.brand.name', {}, {
                fallback: buildVersion === undefined
                  ? <span className={css.fallbackBrandName}>{t('brand.localBuild')}</span>
                  : (
                    <span className={clsx(css.localBuildBrand, css.copyVersion)} data-copy-version onClick={copyVersion(buildVersion)}>
                      <span className={css.localBuildTitle}>{t('brand.localBuild')}</span>
                      <span className={css.buildVersion}>{buildVersion}</span>
                    </span>
                  ),
              })}
            </span>
          </div>
        )}
        <div className={css.scrollRegion}>
          <div
            ref={scrollHandoff.bindViewportRef}
            className={css.scrollArea}
            data-sidebar-scrollport={wide ? '' : undefined}
          >
            <div className={css.regionArea}>
              {renderSlot('sidebar.workspaces', {
                wide,
                expandSidebar: () => { if (collapsed) toggleSidebar() },
              }, { hookContext: sectionHookContext })}
            </div>
          </div>
          <span className={css.scrollFade} aria-hidden="true" />
        </div>
      </div>

      {copiedToast !== null && (
        <Toast key={copiedToast} tone="success" text={t('version.copied')} onDone={() => { setCopiedToast(null) }} />
      )}
    </div>
  )
}
