/** TTOken Code: the signed-in account's device key doubles as the TTOken Gateway route's API key. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from './index.ts'

/**
 * Mirror the account grant into one credential reference for each account provider lifetime.
 *
 * Signing in writes the device key that the account sign-in issued. Signing out, or a rejected
 * key, removes the reference only while it still holds that key, so a key the user entered
 * afterwards stays.
 * @param ctx - Host context owning the account and credential subscriptions.
 * @param refName - credential reference the Gateway route reads, such as `TTOKEN_API_KEY`.
 */
export function installTtokenAccountKey(ctx: Context, refName: string): void {
  const ref = credentialRef(refName)
  ctx.inject(['deepseekAccount', 'credentials'], (accountCtx) => {
    const account = accountCtx.deepseekAccount
    const credentials = accountCtx.credentials
    accountCtx.effect(() => {
      const lifetime = new AbortController()
      let mirrored: string | undefined
      void (async () => {
        try {
          for await (const _update of account.watch(lifetime.signal, true)) {
            if (lifetime.signal.aborted) break
            const token = (await account.getPlatformSession())?.token
            if (lifetime.signal.aborted) break
            if (token !== undefined && token !== mirrored) {
              if ((await credentials.resolve(ref))?.value !== token) await credentials.set(ref, token)
              mirrored = token
            } else if (token === undefined && mirrored !== undefined) {
              if ((await credentials.resolve(ref))?.value === mirrored) await credentials.unset(ref)
              mirrored = undefined
            }
          }
        } catch (_mirrorFailed) {
          // Sign-in keeps working; the Gateway route then needs a key entered by hand until the next start.
          if (!lifetime.signal.aborted) accountCtx.logger('ttoken-account-key').warn('Account key mirroring stopped')
        }
      })()
      return () => { lifetime.abort() }
    }, 'ttoken: account key mirror')
  })
}
