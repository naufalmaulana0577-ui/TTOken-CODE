/** Platform Web currency formatting for account balances; source amounts retain decimal precision. */
import { Big } from 'big.js'

/**
 * Format a balance using Platform Web's two-decimal and sub-cent display rules.
 * @param amount - validated decimal balance string.
 * @param symbol - currency symbol.
 * @returns signed currency text with grouped digits.
 */
export function formatBalance(amount: string, symbol: '¥' | '$' | 'Rp'): string {
  const value = new Big(amount)
  if (symbol === 'Rp') return formatRupiah(value)
  if (value.eq(0)) return `${symbol}0.00`
  if (value.lt(0)) return `-${symbol}${value.gt(-0.01) ? '0.01' : addCommas(value.abs().toFixed(2))}`
  if (value.lt('0.01')) return `<${symbol}0.01`
  return `${symbol}${addCommas(value.round(2, Big.roundDown).toFixed(2))}`
}

/**
 * TTOken Code: the symbol of a wallet currency.
 * @param currency - wallet currency.
 * @returns the symbol {@link formatBalance} accepts.
 */
export function currencySymbol(currency: 'CNY' | 'USD' | 'IDR'): '¥' | '$' | 'Rp' {
  return currency === 'IDR' ? 'Rp' : currency === 'CNY' ? '¥' : '$'
}

/**
 * TTOken Code: whole rupiah with dot grouping, rounded toward zero, such as `Rp 48.500`.
 * @param value - balance in rupiah.
 * @returns signed rupiah text.
 */
function formatRupiah(value: Big): string {
  const whole = value.round(0, Big.roundDown)
  const digits = whole.abs().toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${whole.lt(0) ? '-' : ''}Rp ${digits}`
}

function addCommas(value: string): string {
  const [integer, fraction] = value.split('.')
  return `${Number(integer).toLocaleString()}.${fraction}`
}
