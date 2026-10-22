const P=require('../../desktop/security/license-protocol.cjs');
const months={'1m':1,'3m':3,'6m':6,'1y':12,'3y':36};
function expiryTime(value,now=Math.floor(Date.now()/1000)) {
  P.check(typeof value==='string');P.integer(now);
  if(value==='perpetual')return null;
  if(value==='7d' || value==='14d')return now+Number(value.slice(0,-1))*86400;
  if(Object.hasOwn(months,value)){
    const date=new Date(now*1000),day=date.getUTCDate();
    date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months[value]);
    const last=new Date(date);last.setUTCMonth(last.getUTCMonth()+1,0);
    date.setUTCDate(Math.min(day,last.getUTCDate()));return date.getTime()/1000;
  }
  P.check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value.replace('Z','.000Z'),
    'Expiry must be 7d, 14d, 1m, 3m, 6m, 1y, 3y, perpetual or an explicit UTC date/time');
  return Date.parse(value)/1000;
}
module.exports={expiryTime};
