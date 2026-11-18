import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, IconPlanOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanChipInjected } from './index.ts'
import css from './PlanModeControl.module.css'

/** Full plan-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type PlanChipProps =
  PropsRuntime<'conversation.input.plan'> & InjectFace<PlanChipInjected> & PropsLocale<'plan'>

/**
 * Mode menu over the host-computed `plan` projection: the trigger names the
 * effective target (`pending ? !active : active`, a folded host value, not
 * client optimism), and choosing the other mode executes /plan or /plan off.
 */
export function PlanChip({ useProjection, locked, exitPlanMode, enterPlanMode, t }: PlanChipProps) {
  const plan = useProjection('plan')
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<{ entering: boolean; detail: string } | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (plan === undefined) return null
  const target = plan.pending ? !plan.active : plan.active

  const run = (entering: boolean): void => {
    // No switching/locked guard: both disable the trigger, so no selection arrives.
    setSwitching(true)
    setError(null)
    void (entering ? enterPlanMode() : exitPlanMode()).then((failure) => {
      if (!aliveRef.current) return
      setSwitching(false)
      setError(failure === null ? null : { entering, detail: failure })
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setSwitching(false)
      setError({ entering, detail: reason instanceof Error ? reason.message : String(reason) })
    })
  }

  const option = (name: string, note: string): ReactNode => (
    <span className={css.option}>
      <span>{name}</span>
      <span className={css.note}>{note}</span>
    </span>
  )
  const items: MenuEntry[] = [
    { id: 'agent', label: option(t('mode.agent'), t('mode.agent.note')) },
    { id: 'plan', label: option(t('mode.plan'), t('mode.plan.note')), icon: <IconPlanOutlineRegular size={16} /> },
  ]
  const choose = (id: string): void => {
    setOpen(false)
    if (id === 'plan' && !target) run(true)
    if (id === 'agent' && target) run(false)
  }
  const name = target ? t('mode.plan') : t('mode.agent')

  return (
    <span className={css.wrap}>
      <Menu
        open={open}
        items={items}
        selectedId={target ? 'plan' : 'agent'}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={
          <button
            type="button"
            className={css.mode}
            data-plan={target ? '' : undefined}
            aria-label={t('mode.aria', { name })}
            title={target ? t('chip.on.title') : undefined}
            disabled={locked || switching}
            onClick={() => { setOpen(!open) }}
          >
            {target && <IconPlanOutlineRegular size={14} />}
            {name}
            <span className={css.modeChevron} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
      {error !== null && (
        <span className={css.error} role="status" title={error.detail}>
          {t(error.entering ? 'mode.enterFailed' : 'chip.exitFailed')}
        </span>
      )}
    </span>
  )
}
