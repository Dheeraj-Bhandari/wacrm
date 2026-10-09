import { describe, it, expect } from 'vitest';
import { interpolatePreview } from './dry-run';

describe('interpolatePreview', () => {
  it('substitutes {{message.text}}', () => {
    expect(interpolatePreview('You said: {{message.text}}', { messageText: 'hi' })).toBe(
      'You said: hi',
    );
  });

  it('substitutes {{vars.*}} and tolerates whitespace', () => {
    expect(interpolatePreview('{{ vars.name }}', { vars: { name: 'Jane' } })).toBe('Jane');
  });

  it('blanks unknown tokens', () => {
    expect(interpolatePreview('a {{nope}} b', {})).toBe('a  b');
  });

  it('handles empty/undefined input safely', () => {
    expect(interpolatePreview('', {})).toBe('');
    expect(interpolatePreview(undefined as unknown as string, {})).toBe('');
  });
});
