'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';

// Shared by the kiosk, admin, and login screens — three consumers is what
// justifies pulling this out of each screen's own file. Deliberately NOT a
// generic className-merge component: `size`/`variant`/`tone` are closed
// enums composed into complete, non-conflicting class strings internally.
// Tailwind has no "last class wins" cascade guarantee from JSX source order
// (that needs a resolver like tailwind-merge, which this repo doesn't
// depend on) — so letting callers pass arbitrary override classes that hit
// the same CSS property as an internal class (rounded-*, padding, text
// size, …) would silently produce whichever one Tailwind happened to emit
// last in the stylesheet, not whichever the caller intended. The optional
// `className` prop below is safe to use for non-conflicting layout-only
// utilities (margins, w-full-equivalent spacing) since nothing internal
// sets those.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'lg' | 'touch' | 'md';
export type ButtonTone = 'brand' | 'neutral'; // only read when variant="ghost"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ghost-only: red ("brand") or neutral gray text. Ignored otherwise. */
  tone?: ButtonTone;
  fullWidth?: boolean;
}

// Shared by every variant: press/hover physics, disabled state, and the
// focus-visible ring. Written as one literal string (not composed via
// template interpolation of JS variables) so Tailwind's build-time class
// scanner can see every token as raw text — see the equivalent comment on
// RED_TEXT_CLASS in app/kiosk/kiosk-client.tsx for why that distinction
// matters (a dynamically-interpolated class name is invisible to the
// scanner and silently produces no CSS).
const BASE_CLASS =
  'inline-flex items-center justify-center tracking-tight transition-all duration-150 ' +
  'active:scale-[0.98] active:brightness-95 disabled:opacity-50 disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-[#CF2030] ring-offset-white dark:ring-offset-neutral-900';

const SIZE_CLASS: Record<ButtonSize, string> = {
  // Kiosk primary CTAs ("First time here?", "Check in") — the biggest touch
  // target on the page; unchanged from their pre-Button min-height.
  lg: 'rounded-2xl px-6 min-h-[64px] text-lg',
  // Kiosk secondary touch actions ("Not you? Undo", "No — I'm new here") —
  // still a full touchscreen target, but not the page's primary CTA.
  touch: 'rounded-2xl px-6 min-h-[56px] text-base',
  // Admin dialog / roster panel / login — compact, mouse-oriented controls.
  // min-h-[48px] (Phase 2 Task 8 admin clarity pass): several admin buttons
  // measured under the 48px touch-target floor with padding alone (py-2.5 +
  // text-[15px] lands around 44-46px) — a floor set here, in the shared
  // component, rather than per call site, so it can never drift for a
  // future admin button that forgets to think about it.
  md: 'rounded-xl px-5 py-2.5 text-[15px] min-h-[48px]',
};

// Font weight is split out of SIZE_CLASS (rather than folded into it, the
// way it used to be) because the primary variant needs a different
// treatment — font-display font-bold, per the approved mockup showing the
// red CTA in the display face — than secondary/ghost (font-sans, a
// size-appropriate weight). Stacking two font-weight utilities on the same
// element for primary buttons would hit exactly the "no reliable last-one-
// wins from class order" problem this file's top docblock warns about, so
// the two are composed as alternatives (see the component body below)
// instead of ever appearing together in one class string.
const SIZE_WEIGHT_CLASS: Record<ButtonSize, string> = {
  lg: 'font-semibold',
  touch: 'font-medium',
  md: 'font-medium',
};

// Primary's text always goes through the display face at a fixed weight —
// font-bold (700), one of the two Unbounded weights actually loaded (see
// app/layout.tsx) — regardless of size, instead of SIZE_WEIGHT_CLASS's
// per-size sans weight.
const PRIMARY_TEXT_CLASS = 'font-display font-bold';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  // #CF2030 as a literal arbitrary-value class (not built from a JS
  // constant) for the same scanner-visibility reason as BASE_CLASS above.
  primary:
    'bg-[#CF2030] text-white ' +
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_2px_rgba(0,0,0,0.15)] ' +
    'hover:brightness-105',
  secondary:
    'border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 ' +
    'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800',
  // No background or border by design — GHOST_TONE_CLASS supplies the only
  // color, so it renders as a plain text action with a generous hit area
  // (inherited from SIZE_CLASS) rather than a visible box.
  ghost: '',
};

const GHOST_TONE_CLASS: Record<ButtonTone, string> = {
  // Same literal pair as RED_TEXT_CLASS elsewhere in the app — #CF2030 fails
  // WCAG as text on dark surfaces (~3.3:1 measured), #F0595F clears
  // ~5.4-5.9:1 against neutral-900/950.
  brand: 'text-[#CF2030] dark:text-[#F0595F] hover:opacity-75',
  neutral: 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-100',
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', tone = 'brand', fullWidth = false, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        BASE_CLASS,
        SIZE_CLASS[size],
        variant === 'primary' ? PRIMARY_TEXT_CLASS : SIZE_WEIGHT_CLASS[size],
        VARIANT_CLASS[variant],
        variant === 'ghost' && GHOST_TONE_CLASS[tone],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    />
  );
});
