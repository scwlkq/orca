/**
 * Headless end-to-end coverage for mid-line Korean composition.
 *
 * The preedit overlay covers only the composing span. Committed text remains in the terminal
 * buffer and stays in its original cells, including Claude's task prompt shown under `/tasks`.
 * Composition is driven through CDP `Input.imeSetComposition`, so this runs without a native input
 * source; the row is written straight to the emulator because the defect is in the overlay layer.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import {
  sampleMidlinePreeditOcclusion,
  writeToActiveTerminal,
  type MidlinePreeditOcclusionSample
} from './terminal-ime-midline-occlusion-probe'
import { samplePreeditOverlay } from './terminal-ime-preedit-overlay-probe'

/**
 * Waits for the preedit to reach the overlay at a non-zero size, then samples once.
 *
 * Sampled once rather than polled: the pane runs a live shell that can repaint the row out from
 * under the composition, so only the frame the composition opened on carries the state the
 * assertion is about. The readiness gate is deliberately blind to the tail, so it holds identically
 * with and without the fix and the occlusion assertion is what discriminates.
 */
async function sampleOpenComposition(
  page: Page,
  expectedPreedit = '가'
): Promise<MidlinePreeditOcclusionSample> {
  await expect
    .poll(
      async () => {
        const overlay = await samplePreeditOverlay(page)
        return overlay.active && overlay.rect.width > 0 && overlay.text.startsWith(expectedPreedit)
      },
      { message: 'the preedit never reached the overlay at a non-zero size' }
    )
    .toBe(true)
  return sampleMidlinePreeditOcclusion(page)
}

/** Reads as one string so a failure prints what the overlay covered next to what it drew. */
function describeOcclusion(sample: MidlinePreeditOcclusionSample): string {
  return `covers ${JSON.stringify(sample.hiddenByOverlay)} / renders ${JSON.stringify(sample.overlayText)}`
}

test.describe('Terminal mid-line Korean preedit occlusion', () => {
  test('overlays only preedit width over the Claude task prompt', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      const placeholder = 'describe a task for a new session'
      await writeToActiveTerminal(
        orcaPage,
        [
          '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7',
          `\x1b[2m${placeholder}\x1b[22m`,
          '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
        ].join('')
      )
      await setImeComposition(arena.session, '아')

      const sample = await sampleOpenComposition(orcaPage, '아')
      expect(sample.cursorColumn, 'the cursor is not after the task prompt').toBe(2)
      expect(sample.rowTailFromCursor, 'the task prompt is not under the cursor').toBe(placeholder)
      expect(sample.overlayText).toBe('아')
      expect(sample.remainderText).toBeNull()
      expect(sample.preeditRect).not.toBeNull()
      expect(sample.overlayRect.width).toBeLessThanOrEqual(sample.preeditRect!.width + 1)
      expect(sample.hiddenByOverlay.length).toBeLessThan(placeholder.length)
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'claude-task-placeholder-preedit',
        !completed
      )
    }
  })

  test('covers only preedit width while keeping committed row text in place', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // The issue's repro: 안녕하세요, then CUB 6. Each Hangul syllable is two cells, so the
      // cursor lands on 하.
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요\x1b[6D')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.cursorColumn, 'the cursor is not sitting on 하').toBe(4)
      expect(sample.rowTailFromCursor, 'the row under the overlay is not the repro').toBe('하세요')
      expect(sample.coveredColumns, 'the overlay covers no grid columns to assert about').not.toBe(
        null
      )

      expect(sample.overlayText).toBe('가')
      expect(sample.remainderText).toBeNull()
      expect(sample.preeditRect).not.toBeNull()
      expect(sample.overlayRect.width).toBeLessThanOrEqual(sample.preeditRect!.width + 1)
      expect(sample.overlayRect.left).toBeCloseTo(
        sample.screenRect.left + sample.cursorColumn * sample.cellWidth,
        0
      )
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'korean-midline-preedit-occlusion',
        !completed
      )
    }
  })

  test('leaves the end-of-row composition untouched, with nothing covered to render', async ({
    orcaPage
  }, testInfo) => {
    // Passes before and after the fix by design: the guard is against over-correcting into
    // rendering a tail where the row has none.
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.rowTailFromCursor, 'text still sits after the cursor').toBe('')
      expect(
        describeOcclusion(sample),
        `an end-of-row composition covers no committed text — ${JSON.stringify(sample)}`
      ).toBe('covers "" / renders "가"')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-endofrow-preedit', !completed)
    }
  })
})
