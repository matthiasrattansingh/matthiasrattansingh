import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { databentoProvider, parseOhlcvNdjson, parseDbnPrice } from '../src/server/providers/databento.ts';
import { customHttpProvider } from '../src/server/providers/customHttp.ts';
import { DEFAULT_SETTINGS, readEnv } from '../src/server/settings.ts';
import type { AppSettings } from '../src/shared/types.ts';

const NOW = Date.parse('2026-10-06T14:00:00Z');

describe('Databento adapter (fixture responses)', () => {
  it('parses pretty and fixed-point JSON records', () => {
    assert.equal(parseDbnPrice('2.345600000'), 2.3456);
    assert.equal(parseDbnPrice('2345600000'), 2.3456);
    const bars = parseOhlcvNdjson(
      [
        '{"hd":{"ts_event":"2026-10-06T13:49:00.000000000Z","rtype":33,"publisher_id":1,"instrument_id":1},"open":"2.3400","high":"2.3500","low":"2.3390","close":"2.345600000","volume":"12","symbol":"HOX6"}',
        '{"hd":{"ts_event":"1791294540000000000","rtype":33},"close":"60120000000","symbol":"BZZ6"}',
      ].join('\n'),
      60,
    );
    assert.equal(bars[0].close, 2.3456);
    assert.equal(new Date(bars[0].closeTsMs).toISOString(), '2026-10-06T13:50:00.000Z'); // bar end
    assert.equal(bars[1].close, 60.12);
  });

  it('maps bars to exact contracts and ignores unrequested symbols', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes('metadata.get_dataset_range')) return new Response(JSON.stringify({ start: '2010-06-06T00:00:00Z', end: '2026-10-06T13:55:00.000000000Z' }));
      return new Response(
        [
          '{"hd":{"ts_event":"2026-10-06T13:48:00.000000000Z"},"close":"2.3400","symbol":"HOX6"}',
          '{"hd":{"ts_event":"2026-10-06T13:49:00.000000000Z"},"close":"2.3456","symbol":"HOX6"}',
          '{"hd":{"ts_event":"2026-10-06T13:49:00.000000000Z"},"close":"60.12","symbol":"BZZ6"}',
          '{"hd":{"ts_event":"2026-10-06T13:49:00.000000000Z"},"close":"61.00","symbol":"BZF7"}',
        ].join('\n'),
      );
    }) as unknown as typeof fetch;
    const res = await databentoProvider.fetchLatest(['HOX2026', 'BZZ2026'], { env: readEnv({ DATABENTO_API_KEY: 'db-test-key' }), settings: DEFAULT_SETTINGS, fetchImpl, nowMs: NOW });
    assert.deepEqual(
      res.quotes.map((q) => [q.contract, q.price, q.exchangeTs, q.providerSymbol]),
      [
        ['HOX2026', 2.3456, '2026-10-06T13:50:00.000Z', 'HOX6'],
        ['BZZ2026', 60.12, '2026-10-06T13:50:00.000Z', 'BZZ6'],
      ],
    );
    assert.ok(res.errors.some((e) => /unrequested symbol BZF7/.test(e)));
    assert.ok(calls[1].includes('symbols=HOX6%2CBZZ6') && calls[1].includes('stype_in=raw_symbol'));
  });

  it('redacts the API key from errors', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ detail: 'bad key db-secret-123' }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
      databentoProvider.fetchLatest(['HOX2026'], { env: readEnv({ DATABENTO_API_KEY: 'db-secret-123' }), settings: DEFAULT_SETTINGS, fetchImpl, nowMs: NOW }),
      (e: Error) => !e.message.includes('db-secret-123') && e.message.includes('***'),
    );
  });
});

describe('custom HTTP/JSON adapter (local fixture server)', () => {
  let server: Server;
  let base = '';
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      const sym = url.searchParams.get('symbol');
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key'] !== 'custom-secret') {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      if (sym === 'HOX26') res.end(JSON.stringify({ data: { symbol: 'HOX26', last: 2.3456, time: '2026-10-06T09:50:00-04:00' } }));
      else if (sym === 'BZZ26') res.end(JSON.stringify({ data: { symbol: 'BZ1!', last: 60.1, time: '2026-10-06T13:50:00Z' } })); // continuous substitute
      else res.end(JSON.stringify({ data: { symbol: sym, last: 59, time: '2026-10-06 09:50:00' } })); // no offset
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('accepts only the exact requested contract and requires timestamps with offsets', async () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      provider: 'custom-http',
      customHttp: { ...DEFAULT_SETTINGS.customHttp, urlTemplate: `${base}/quote?symbol={symbol}`, pricePath: 'data.last', timestampPath: 'data.time', symbolPath: 'data.symbol', authHeader: 'x-api-key', delayMinutes: 10, sourceLabel: 'Fixture API' },
    };
    const res = await customHttpProvider.fetchLatest(['HOX2026', 'BZZ2026', 'CLX2026'], { env: readEnv({ CUSTOM_QUOTE_API_KEY: 'custom-secret' }), settings, fetchImpl: fetch, nowMs: NOW });
    assert.equal(res.quotes.length, 1);
    assert.deepEqual([res.quotes[0].contract, res.quotes[0].price, res.quotes[0].exchangeTs, res.quotes[0].delayMinutes], ['HOX2026', 2.3456, '2026-10-06T13:50:00.000Z', 10]);
    assert.ok(res.errors.some((e) => /BZZ2026.*refusing to substitute/.test(e)));
    assert.ok(res.errors.some((e) => /CLX2026.*UTC offset/.test(e)));
    assert.ok(res.errors.every((e) => !e.includes('custom-secret')));
  });
});
