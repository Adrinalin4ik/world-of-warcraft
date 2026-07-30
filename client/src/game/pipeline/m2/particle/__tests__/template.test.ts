/**
 * @jest-environment node
 */
import { modelOwnsSubmeshes } from '../template';

describe('modelOwnsSubmeshes', () => {
  it('is false when the model has no particle emitters', () => {
    expect(modelOwnsSubmeshes(0)).toBe(false);
  });

  it('is true when the model has any particle emitter', () => {
    expect(modelOwnsSubmeshes(1)).toBe(true);
    expect(modelOwnsSubmeshes(4)).toBe(true);
  });

  it('treats a negative or absent count as no emitters', () => {
    expect(modelOwnsSubmeshes(-1)).toBe(false);
    expect(modelOwnsSubmeshes(undefined as any)).toBe(false);
  });
});
