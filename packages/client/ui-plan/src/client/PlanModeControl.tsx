import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlanOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanChipInjected } from './index.ts'
import css from './PlanModeControl.module.css'

/** Full plan-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type PlanChipProps =
  PropsRuntime<'conversation.input.plan'> & InjectFace<PlanChipInjected> & PropsLocale<'plan'>

/**
 * Agent and Plan buttons over the host-computed `plan` projection: the pressed
 * button is the effective target (`pending ? !active : active`, a folded host
 * value, not client optimism), and pressing the other executes /plan or /plan off.
 */
export function PlanChip({ useProjection, locked, exitPlanMode, enterPlanMode, t }: PlanChipProps) {
  const plan = useProjection('plan')
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
    // No switching/locked guard: both disable the buttons, so no press arrives.
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

  const segment = (planning: boolean) => {
    const pressed = planning === target
    return (
      <button
        type="button"
        className={css.segment}
        aria-pressed={pressed}
        title={t(planning ? 'mode.plan.note' : 'mode.agent.note')}
        disabled={locked || switching}
        onClick={() => { if (!pressed) run(planning) }}
      >
        {planning && <IconPlanOutlineRegular size={14} />}
        {t(planning ? 'mode.plan' : 'mode.agent')}
      </button>
    )
  }

  return (
    <span className={css.wrap}>
      <span className={css.modeGroup} role="group" aria-label={t('mode.aria', { name: t(target ? 'mode.plan' : 'mode.agent') })}>
        {segment(false)}
        {segment(true)}
      </span>
      {error !== null && (
        <span className={css.error} role="status" title={error.detail}>
          {t(error.entering ? 'mode.enterFailed' : 'chip.exitFailed')}
        </span>
      )}
    </span>
  )
}
