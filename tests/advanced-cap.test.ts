import { describe, expect, it } from 'vitest';
import { cardCap } from '../src/pages/advancedCap';

describe('cardCap', () => {
  it('stops the card 16 px above the bottom of the scroller', () => {
    expect(cardCap(768, 480)).toBe(272);
    expect(cardCap(820, 480)).toBe(324);
    expect(cardCap(1080, 537)).toBe(527);
  });
  it('never goes below the floor on a short window', () => {
    expect(cardCap(720, 480)).toBe(240);
    expect(cardCap(100, 480)).toBe(240);
  });
  it('takes the floor and the gap as parameters', () => {
    expect(cardCap(768, 480, 240, 0)).toBe(288);
    expect(cardCap(768, 480, 300, 16)).toBe(300);
  });
});
