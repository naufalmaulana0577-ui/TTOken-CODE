import type { ReactNode } from 'react'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './icons/index.tsx'
import type { IconProps } from './icons/props.ts'

interface PermissionIconArtworkProps extends IconProps {
  strokeWidth: number
}

// TTOken Code artwork: an eye for reading, a pencil for workspace writes, an
// open padlock for full access, and a checked viewfinder for automatic review.
function ReadOnlyArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path vectorEffect="non-scaling-stroke" d="M1.75 8C3.35 5.1 5.45 3.5 8 3.5C10.55 3.5 12.65 5.1 14.25 8C12.65 10.9 10.55 12.5 8 12.5C5.45 12.5 3.35 10.9 1.75 8Z" stroke="currentColor" strokeLinejoin="round" />
      <circle vectorEffect="non-scaling-stroke" cx="8" cy="8" r="2" stroke="currentColor" />
    </svg>
  )
}

function WorkspaceWriteArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path vectorEffect="non-scaling-stroke" d="M2.75 13.25V10.5L10.35 2.9C10.94 2.31 11.89 2.31 12.47 2.9L13.1 3.53C13.69 4.11 13.69 5.06 13.1 5.65L5.5 13.25Z" stroke="currentColor" strokeLinejoin="round" />
      <path vectorEffect="non-scaling-stroke" d="M9 4.25L11.75 7" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

function FullAccessArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <rect vectorEffect="non-scaling-stroke" x="3" y="7.25" width="10" height="7" rx="2" stroke="currentColor" />
      <path vectorEffect="non-scaling-stroke" d="M5.5 7.25V4.75C5.5 3.37 6.62 2.25 8 2.25C9.13 2.25 10.08 3 10.39 4.03" stroke="currentColor" strokeLinecap="round" />
      <path vectorEffect="non-scaling-stroke" d="M8 10V11.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

function AutoReviewArtwork({ size = 16, className, strokeWidth }: PermissionIconArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
      <path vectorEffect="non-scaling-stroke" d="M2.25 5.25V3.75C2.25 2.92 2.92 2.25 3.75 2.25H5.25M10.75 2.25H12.25C13.08 2.25 13.75 2.92 13.75 3.75V5.25M13.75 10.75V12.25C13.75 13.08 13.08 13.75 12.25 13.75H10.75M5.25 13.75H3.75C2.92 13.75 2.25 13.08 2.25 12.25V10.75" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path vectorEffect="non-scaling-stroke" d="M5.5 8.1L7.25 9.85L10.5 6.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Render the read-only permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconReadOnlyRegular(props: IconProps): ReactNode {
  return <ReadOnlyArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the read-only permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconReadOnlyMedium(props: IconProps): ReactNode {
  return <ReadOnlyArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}

/**
 * Render the workspace-write permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconWorkspaceWriteRegular(props: IconProps): ReactNode {
  return <WorkspaceWriteArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the workspace-write permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconWorkspaceWriteMedium(props: IconProps): ReactNode {
  return <WorkspaceWriteArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}

/**
 * Render the full-access permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconFullAccessRegular(props: IconProps): ReactNode {
  return <FullAccessArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the full-access permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconFullAccessMedium(props: IconProps): ReactNode {
  return <FullAccessArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}

/**
 * Render the auto-review permission icon with a one-pixel stroke.
 * @param props - Size and optional class.
 * @returns The regular decorative permission glyph.
 */
export function PermissionIconAutoReviewRegular(props: IconProps): ReactNode {
  return <AutoReviewArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render the auto-review permission icon with a 1.3px stroke.
 * @param props - Size and optional class.
 * @returns The medium decorative permission glyph.
 */
export function PermissionIconAutoReviewMedium(props: IconProps): ReactNode {
  return <AutoReviewArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}
