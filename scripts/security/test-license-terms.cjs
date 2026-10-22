const {test}=require('node:test'),assert=require('node:assert/strict');
const {expiryTime}=require('./license-term.cjs');
const seconds=iso=>Date.parse(iso)/1000;
test('seven license terms use UTC calendar months and clamp month ends and leap days',()=>{
  const start=seconds('2026-10-19T12:34:56Z');
  for(const [term,end] of Object.entries({'7d':'2026-10-26','14d':'2026-11-02','1m':'2026-11-19','3m':'2027-01-19','6m':'2027-04-19','1y':'2027-10-19','3y':'2029-10-19'}))
    assert.equal(expiryTime(term,start),seconds(end+'T12:34:56Z'),term);
  for(const [start,term,end] of [
    ['2027-01-31','1m','2027-02-28'],['2028-01-31','1m','2028-02-29'],
    ['2028-02-29','1y','2029-02-28'],['2028-02-29','3y','2031-02-28'],
    ['2026-08-31','6m','2027-02-28'],['2026-11-30','3m','2027-02-28'],
  ])assert.equal(expiryTime(term,seconds(start+'T23:59:59Z')),seconds(end+'T23:59:59Z'));
  assert.equal(expiryTime('perpetual',start),null);
  assert.equal(expiryTime('2027-01-01T00:00:00Z',start),seconds('2027-01-01T00:00:00Z'));
  for(const invalid of ['30d','2m','0d','1M','',null,['1m'],'2027-02-29T00:00:00Z','2026-11-01','2026-11-01T00:00:00+09:00'])
    assert.throws(()=>expiryTime(invalid,start));
});
