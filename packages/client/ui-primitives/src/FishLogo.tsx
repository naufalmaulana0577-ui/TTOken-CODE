import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 56, height: 48 }

/** The fish silhouette path data, exported for consumers that compose their own svg (entrance effects, masks) around the same geometry. */
export const FISH_LOGO_PATH = 'M8 0H48A8 8 0 0 1 56 8V8A8 8 0 0 1 48 16H8A8 8 0 0 1 0 8V8A8 8 0 0 1 8 0ZM15 4H15A9 9 0 0 1 24 13V39A9 9 0 0 1 15 48H15A9 9 0 0 1 6 39V13A9 9 0 0 1 15 4ZM41 4H41A9 9 0 0 1 50 13V21A9 9 0 0 1 41 30H41A9 9 0 0 1 32 21V13A9 9 0 0 1 41 4Z'

/**
 * Render the fish logo.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="#FFB21A" />
      <path d="M36 37H46A4 4 0 0 1 50 41V41A4 4 0 0 1 46 45H36A4 4 0 0 1 32 41V41A4 4 0 0 1 36 37Z" fill="currentColor" />
    </svg>
  )
}
