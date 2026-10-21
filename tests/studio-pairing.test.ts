import assert from 'node:assert/strict';
import { test } from 'node:test';
import { studioPairingKey } from '../src/server/studio-pairing.ts';

test('pairing accepts one bounded handshake credential and preserves legacy clients without accepting ambiguity',()=>{
  const key='a'.repeat(43);const clean=new URL('http://bridge.invalid/connect');
  assert.equal(studioPairingKey(clean,`content-studio-key.${key}`),key);
  assert.equal(studioPairingKey(new URL(`http://bridge.invalid/connect?key=${key}`),undefined),key);
  for(const protocol of [undefined,'bad','content-studio-key.short',`content-studio-key.${key},other`,[`content-studio-key.${key}`]]) assert.equal(studioPairingKey(clean,protocol),null);
  assert.equal(studioPairingKey(new URL(`http://bridge.invalid/connect?key=${key}`),`content-studio-key.${key}`),null);
  assert.equal(studioPairingKey(new URL(`http://bridge.invalid/connect?other=${key}`),undefined),null);
});
