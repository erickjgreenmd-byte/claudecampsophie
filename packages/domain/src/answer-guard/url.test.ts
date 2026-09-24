import { describe, expect, it } from 'vitest';
import { base64, numeric, scan } from './test-helpers.ts';

const ANSWER = numeric('7');

// Spec P6 "Do not leak by ... shortened URLs"; P4 "No ads or affiliate links appear in child
// ... sessions". Any URL in child text is a finding regardless of the protected answers.
describe('AC_GRADING_08 / AC_MON_02 URL detector flags links in child text', () => {
  it.each([
    ['https URL', 'Read https://example.com/help first.'],
    ['http URL', 'See http://example.org'],
    ['upper-case scheme', 'SEE HTTPS://EXAMPLE.COM'],
    ['fullwidth scheme', '\uFF48\uFF54\uFF54\uFF50\uFF53://example.com'],
    ['www prefix', 'Visit www.example.org today.'],
    ['bit.ly', 'Go to bit.ly/3abcXYZ'],
    ['tinyurl', 'Go to tinyurl.com/abc123'],
    ['t.co', 'Go to t.co/xyz'],
    ['x.co', 'Go to x.co/abc'],
    ['any *.ly/ path', 'Go to foo.ly/bar'],
    ['affiliate shortener', 'Buy it at amzn.to/3xYz'],
    ['bare domain', 'Ask at homework-helper.net for answers.'],
    ['defanged scheme and dot', 'hxxps://example[.]com'],
    ['spelled-out dot', 'Type example dot com in the browser.'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data URI', 'data:text/html;base64,PGI+aGk8L2I+'],
    ['URL hidden in base64', `Code: ${base64('https://example.com/answers')}`],
  ])('flags %s', (_label, content) => {
    const result = scan(content, ANSWER);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.detector === 'url' || f.technique.startsWith('url'))).toBe(
      true,
    );
    expect(result.findings.every((f) => f.detector !== 'url' || f.answerIndex === null)).toBe(true);
  });

  it.each([
    ['e.g. add the tens first.'],
    ['It is 3.5 cm long.'],
    ['Mr. Lee says great job, Sam.'],
    ['Look at drawing.png again.'],
    ['Time: 3:30. Data: 4, 5, 6.'],
  ])('"%s" is not a URL', (content) => {
    expect(scan(content, ANSWER).findings).toEqual([]);
  });
});
