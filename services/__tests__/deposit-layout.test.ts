// Deposit-modal responsive layout rules (codex P2: the 560px desktop
// minimum clipped short/landscape viewports classified as desktop by a
// width-only check).

import { describe, expect, test } from 'bun:test';

import {
  DEPOSIT_MOBILE_MAX_WIDTH,
  DEPOSIT_ROOMY_MIN_VIEWPORT_HEIGHT,
  depositCardMaxHeight,
  shouldUseRoomyDepositLayout,
} from '@/services/deposit-layout';

describe('shouldUseRoomyDepositLayout', () => {
  test('phone in landscape (844×390) is NOT roomy despite the desktop width', () => {
    expect(shouldUseRoomyDepositLayout(844, 390)).toBe(false);
  });

  test('short desktop window (580×500) is NOT roomy', () => {
    expect(shouldUseRoomyDepositLayout(580, 500)).toBe(false);
  });

  test('regular desktop viewport is roomy', () => {
    expect(shouldUseRoomyDepositLayout(1280, 800)).toBe(true);
  });

  test('narrow (mobile-width) viewports are never roomy regardless of height', () => {
    expect(shouldUseRoomyDepositLayout(DEPOSIT_MOBILE_MAX_WIDTH, 2000)).toBe(false);
    expect(shouldUseRoomyDepositLayout(390, 844)).toBe(false);
  });

  test('boundary: exactly the minimum height qualifies, one less does not', () => {
    expect(shouldUseRoomyDepositLayout(800, DEPOSIT_ROOMY_MIN_VIEWPORT_HEIGHT)).toBe(true);
    expect(shouldUseRoomyDepositLayout(800, DEPOSIT_ROOMY_MIN_VIEWPORT_HEIGHT - 1)).toBe(false);
  });
});

describe('depositCardMaxHeight', () => {
  test('caps to the viewport with breathing room', () => {
    expect(depositCardMaxHeight(800)).toBe(776);
    expect(depositCardMaxHeight(390)).toBe(366);
  });
  test('never collapses below a usable floor', () => {
    expect(depositCardMaxHeight(100)).toBe(280);
  });
});
