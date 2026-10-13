import { describe, expect, it } from 'vitest';
import { tapdHtmlMarkdown } from './tapd-html.ts';

describe('tapdHtmlMarkdown', () => {
  it('preserves readable block structure, lists, code and tables', () => {
    const result = tapdHtmlMarkdown(`
      <h2>Acceptance</h2>
      <p>Hello &amp; <strong>bold</strong><br>next</p>
      <ol start="3"><li>first</li><li>second</li></ol>
      <pre><code class="language-ts">const fence = \`\`\`;</code></pre>
      <table><thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>a|b</td><td>二</td></tr></tbody></table>
    `);

    expect(result).toEqual({
      body: [
        '## Acceptance',
        '',
        'Hello & **bold**  ',
        'next',
        '',
        '3. first',
        '4. second',
        '',
        '````ts',
        'const fence = ```;',
        '````',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| a\\|b | 二 |',
      ].join('\n'),
      unsupportedContent: false,
    });
  });

  it('keeps only safe absolute http links and omits active content', () => {
    const result = tapdHtmlMarkdown(`
      <p onclick="steal()"><a href="https://example.test/a b">safe</a>
      <a href="javascript:alert(1)">bad</a><script>alert(2)</script></p>
      <iframe src="https://attacker.test"></iframe><img src="https://attacker.test/x.png" alt="diagram">
    `);

    expect(result.body).toBe('[safe](https://example.test/a%20b) bad');
    expect(result.unsupportedContent).toBe(true);
  });

  it('marks images, embeds, unknown elements and unsafe links as lossy', () => {
    expect(tapdHtmlMarkdown('<p>before<img alt="flow">after</p>')).toEqual({
      body: 'beforeafter',
      unsupportedContent: true,
    });
    expect(tapdHtmlMarkdown('<video>fallback</video><custom>readable</custom>')).toEqual({
      body: 'fallbackreadable',
      unsupportedContent: true,
    });
  });

  it('bounds hostile deep input without throwing', () => {
    const html = '<div>'.repeat(80) + 'still readable' + '</div>'.repeat(80);
    const result = tapdHtmlMarkdown(html);
    expect(result.unsupportedContent).toBe(true);
    expect(result.body.length).toBeLessThan(100);
  });

  it('escapes table delimiters including existing backslashes', () => {
    const result = tapdHtmlMarkdown('<table><tr><td>a\\|b</td><td>c</td></tr></table>');
    expect(result.body).toBe('| a\\\\\\|b | c |\n| --- | --- |');
  });
});
