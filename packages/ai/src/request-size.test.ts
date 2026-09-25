import { describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  createOpenAiResponsesClient,
  dataUrlBytes,
  encodeRequestBody,
  imagePartFromBytes,
  imagePartFromDataUrl,
  type ResponsesRequest,
} from './client.ts';
import { dataEnvelope, imagePart, PROMPTS } from './prompts.ts';
import { toStrictJsonSchema } from './schemas.ts';

/**
 * JOBS-R1-02: the extraction request of a multi-page scan is built with one copy of its images.
 * `imagePartFromBytes` and `encodeRequestBody` must produce exactly what `imagePart` and
 * `JSON.stringify(buildRequestBody(...))` produce, only with less memory. Synthetic bytes only.
 */

function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 131 + seed) % 256;
  return out;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function request(input: ResponsesRequest['input']): ResponsesRequest {
  return {
    model: 'gpt-5.6-terra',
    instructions: PROMPTS.extraction.instructions,
    input,
    outputName: PROMPTS.extraction.outputName,
    jsonSchema: toStrictJsonSchema(PROMPTS.extraction.outputSchema),
    maxOutputTokens: 4_000,
    timeoutMs: 45_000,
    metadata: { stage: 'extraction', prompt_version: PROMPTS.extraction.version },
  };
}

const plain = (r: ResponsesRequest) =>
  new TextEncoder().encode(JSON.stringify(buildRequestBody(r)));

describe('imagePartFromBytes', () => {
  it('equals imagePart over the base64 of the same bytes, for every length remainder and chunk edge', () => {
    for (const length of [0, 1, 2, 3, 4, 32_765, 32_766, 32_767, 65_532, 100_001]) {
      const bytes = bytesOf(length, length);
      expect(imagePartFromBytes('image/jpeg', bytes)).toEqual(
        imagePart('image/jpeg', base64(bytes)),
      );
      expect(imagePartFromBytes('image/png', bytes, 'low')).toEqual(
        imagePart('image/png', base64(bytes), 'low'),
      );
      // The two-step form the scan job uses (it drops the image bytes in between).
      const url = dataUrlBytes('image/jpeg', bytes);
      expect(url.length).toBe('data:image/jpeg;base64,'.length + 4 * Math.ceil(length / 3));
      expect(imagePartFromDataUrl(url)).toEqual(imagePart('image/jpeg', base64(bytes)));
    }
  });
});

describe('encodeRequestBody', () => {
  it('is byte-identical to the plain JSON encoding', () => {
    const cases: ResponsesRequest[] = [
      request([dataEnvelope({ pageNumbers: [1, 2], gradeLevel: 4 })]),
      request([
        dataEnvelope({ pageNumbers: [1, 2], gradeLevel: 4, note: 'ünïcødé "quoted" \\ \n' }),
        imagePartFromBytes('image/jpeg', bytesOf(40_000, 1)),
        imagePartFromBytes('image/png', bytesOf(3, 2), 'low'),
      ]),
      // A text part that happens to contain the placeholder: the plain encoding is used.
      request([
        dataEnvelope({ text: '__pencillift_image_0__' }),
        imagePartFromBytes('image/jpeg', bytesOf(10, 3)),
      ]),
      // An image part that is not a base64 data URL is left inside the JSON as it is.
      request([{ type: 'input_image', image_url: 'https://example.invalid/"x"', detail: 'high' }]),
    ];
    for (const r of cases) expect(encodeRequestBody(r)).toEqual(plain(r));
  });

  it('a scan at the 15 MiB bound makes a body of 4/3 of its pages plus the prompt, never more', () => {
    const MiB = 1024 * 1024;
    const pages = [4, 4, 4, 3].map((mb, i) =>
      imagePartFromBytes('image/jpeg', bytesOf(mb * MiB, i)),
    );
    const r = request([dataEnvelope({ pageNumbers: [1, 2, 3, 4], gradeLevel: 4 }), ...pages]);
    const body = encodeRequestBody(r);
    expect(body.length).toBeLessThanOrEqual(Math.ceil((15 * MiB * 4) / 3) + 64 * 1024);
    expect(body.length).toBeGreaterThan(20 * MiB);
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual(buildRequestBody(r));
  });

  it('the transport sends the encoded bytes', async () => {
    let sent: unknown;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      sent = init.body;
      return Promise.resolve(new Response(JSON.stringify({ status: 'completed', output: [] })));
    }) as unknown as typeof fetch;
    const client = createOpenAiResponsesClient({ apiKey: 'sk-test', fetchImpl, clock: () => 0 });
    const r = request([dataEnvelope({}), imagePartFromBytes('image/jpeg', bytesOf(100, 9))]);
    await client.create(r);
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent).toEqual(plain(r));
  });
});
