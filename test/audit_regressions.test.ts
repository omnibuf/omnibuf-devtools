import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stringifyBlindJSON } from '@omnibuf/core';
import { formatDecodedJson } from '../src/decoder/tree.js';
import { normalizeHeaders } from '../src/protocol/detect.js';

describe('Audit Regressions - omnibuf-devtools', () => {
  it('ES-15a: formatDecodedJson emits unquoted 64-bit bigint literals matching stringifyBlindJSON', () => {
    const maxUint64 = 18446744073709551615n;

    assert.equal(formatDecodedJson(maxUint64, 0), stringifyBlindJSON(maxUint64));
    assert.equal(formatDecodedJson(maxUint64, 0), '18446744073709551615');

    const objJson = formatDecodedJson({ id: maxUint64 }, 2);
    assert.equal(
      objJson.includes('"18446744073709551615"'),
      false,
      `Expected unquoted 64-bit integer in JSON output, got:\n${objJson}`,
    );
    assert.equal(objJson, stringifyBlindJSON({ id: maxUint64 }, 2));
  });

  it('ES-15b: normalizeHeaders does not collide with Object.prototype / Function.prototype.toString on prototype header names', () => {
    const ctorHeaders = normalizeHeaders([{ name: 'constructor', value: 'custom' }]);
    assert.equal(
      ctorHeaders['constructor'],
      'custom',
      `Expected "custom" without Function.prototype.toString concatenation, got ${JSON.stringify(ctorHeaders['constructor'])}`,
    );

    const protoHeaders = normalizeHeaders([{ name: '__proto__', value: 'custom' }]);
    assert.equal(protoHeaders['__proto__'], 'custom');
  });
});
