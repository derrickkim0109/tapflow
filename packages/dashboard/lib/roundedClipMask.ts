/**
 * The `mask-image` that keeps a rounded screen canvas rounded, or `undefined` where none is needed.
 *
 * **Firefox on macOS drops the rounded clip of a large canvas that redraws continuously**: the
 * compositor promotes it to a native layer and trusts that layer to apply the clip, which on macOS
 * it does not (https://bugzilla.mozilla.org/show_bug.cgi?id=2068303). Confirmed on #908 with the
 * stream running: removing the mask squared the iOS screen's corners and adding it rounded them
 * again. An opaque mask keeps the canvas out of that promotion. Applied only where the defect was
 * seen: what a mask costs in other browsers was not measured, and they do not need it.
 */
export function roundedClipMask(userAgent: string): string | undefined {
  return userAgent.includes('Firefox/') && userAgent.includes('Macintosh') ? 'linear-gradient(#fff,#fff)' : undefined
}
