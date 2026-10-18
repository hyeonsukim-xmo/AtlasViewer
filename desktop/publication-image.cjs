// Deliberately limited to the preview worker's opaque RGB PNGs. No metadata survives.
const zlib=require('node:zlib');
const S=require('./publication-protocol.cjs');
const SIGNATURE=Buffer.from('89504e470d0a1a0a','hex'),MAX_IMAGE=16*1024*1024;
function dimensions(width,height){S.check(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=2048&&height<=2048,'PUBLICATION_IMAGE_INVALID');}
function chunk(type,data){const name=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(zlib.crc32(Buffer.concat([name,data])),out.length-4);return out;}
function encode({width,height,pixels}){
  dimensions(width,height);S.check(pixels.length===width*height*3);
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const stride=width*3,raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++)pixels.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);
  return Buffer.concat([SIGNATURE,chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
}
function decode(bytes){
  const valid=ok=>S.check(ok,'PUBLICATION_IMAGE_INVALID');valid(Buffer.isBuffer(bytes)&&bytes.length<=MAX_IMAGE&&bytes.subarray(0,8).equals(SIGNATURE));
  let offset=8,width,height,ended=false;const parts=[];
  while(offset<bytes.length){
    valid(offset+12<=bytes.length);const length=bytes.readUInt32BE(offset),end=offset+12+length;valid(end<=bytes.length);
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    valid(zlib.crc32(bytes.subarray(offset+4,end-4))===bytes.readUInt32BE(end-4));
    if(type==='IHDR'){valid(offset===8&&length===13);width=data.readUInt32BE();height=data.readUInt32BE(4);dimensions(width,height);valid(data.subarray(8).equals(Buffer.from([8,2,0,0,0])));}
    else if(type==='IDAT'){valid(!!width&&!ended&&parts.length<256);parts.push(data);}
    else if(type==='IEND'){valid(length===0&&parts.length>0&&end===bytes.length);ended=true;}
    else valid(false);
    offset=end;
  }
  valid(ended);const stride=width*3,expected=(stride+1)*height;
  const inflated=zlib.inflateSync(Buffer.concat(parts),{maxOutputLength:expected,info:true});
  valid(inflated.engine.bytesWritten===parts.reduce((n,p)=>n+p.length,0));const raw=inflated.buffer;valid(raw.length===expected);
  const pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)];valid(filter<=4);
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=3?pixels[i-3]:0,b=y?pixels[i-stride]:0,c=y&&x>=3?pixels[i-stride-3]:0,p=a+b-c;
      const pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c),predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;
      pixels[i]=(raw[y*(stride+1)+x+1]+predictor)&255;
    }
  }
  return {width,height,pixels};
}
function redact(image,rects){
  S.check(Array.isArray(rects)&&rects.length<=64,'PUBLICATION_IMAGE_INVALID');const pixels=Buffer.from(image.pixels);
  for(const r of rects){require('./security/license-protocol.cjs').fields(r,['x','y','width','height']);Object.values(r).forEach(v=>S.check(Number.isInteger(v)&&v>=0));
    S.check(r.width>0&&r.height>0&&r.x+r.width<=image.width&&r.y+r.height<=image.height);
    for(let y=r.y;y<r.y+r.height;y++)pixels.fill(0,(y*image.width+r.x)*3,(y*image.width+r.x+r.width)*3);
  }
  return encode({...image,pixels});
}
module.exports={MAX_IMAGE,decode,encode,redact};
