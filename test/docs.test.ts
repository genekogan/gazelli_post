import { expect, it } from 'vitest';
import skill from '../SKILL.md?raw';
import servedSkill from '../public/skill.md?raw';
import vectors from './vectors.json';
it('embeds exact generated vectors in the published self-contained guide', () => {
  const block = skill.split('<!-- TEST_VECTORS_START -->')[1].split('<!-- TEST_VECTORS_END -->')[0];
  const parsed = JSON.parse(block.split('```json\n')[1].split('```')[0]);
  expect(parsed).toEqual(vectors);
  expect(servedSkill).toBe(skill);
});
