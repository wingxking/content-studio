import { expect,it } from 'vitest';
import { companionFrameSchema,companionUrl } from '../src/studio/companion-client';
import { companionProtocol } from '../../src/contracts/studio-ui';

it('adds a separate UI path without altering the original execution URL or exposing pairing in public links',()=>{
  const original='ws://localhost:19527/connect?key='+'p'.repeat(40);const result=new URL(companionUrl(original));
  expect(result.pathname).toBe('/ui/connect');expect(result.searchParams.get('key')).toBe('p'.repeat(40));expect(original).toContain('/connect?');
  expect(()=>companionUrl('ws://localhost:9527')).toThrow();
});
it('validates UI frames independently of the strict V1 draft execution contract',()=>{
  expect(companionFrameSchema.parse({protocol:companionProtocol,version:1,type:'ping'}).type).toBe('ping');
  expect(()=>companionFrameSchema.parse({protocol:companionProtocol,version:2,type:'ping'})).toThrow();
  expect(()=>companionFrameSchema.parse({protocol:companionProtocol,version:1,type:'ping',token:'not-public'})).toThrow();
});
