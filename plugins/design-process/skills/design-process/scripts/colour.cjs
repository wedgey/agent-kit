const toLin=(L,C,h)=>{h=h*Math.PI/180;const A=C*Math.cos(h),B=C*Math.sin(h);const l=(L+0.3963377774*A+0.2158037573*B)**3,m=(L-0.1055613458*A-0.0638541728*B)**3,s=(L-0.0894841775*A-1.291485548*B)**3;return[4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.707614701*s]};
const inG=(L,C,h)=>toLin(L,C,h).every(v=>v>=-1e-4&&v<=1+1e-4);
const enc=v=>{v=Math.min(1,Math.max(0,v));return v<=0.0031308?12.92*v:1.055*v**(1/2.4)-0.055};
const hex=(L,C,h)=>'#'+toLin(L,C,h).map(v=>Math.round(enc(v)*255).toString(16).padStart(2,'0')).join('');
const fromHex=x=>{const[r,g,b]=[1,3,5].map(i=>parseInt(x.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b),m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b),s=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);const L=0.2104542553*l+0.793617785*m-0.0040720468*s,A=1.9779984951*l-2.428592205*m+0.4505937099*s,B=0.0259040371*l+0.7827717662*m-0.808675766*s;return[L,Math.hypot(A,B),(Math.atan2(B,A)*180/Math.PI+360)%360]};
const Y=c=>{let rgb;if(c[0]==='#')rgb=[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);else rgb=toLin(...c).map(v=>Math.min(1,Math.max(0,v)));return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]};
const cr=(a,b)=>{const[x,y]=[Y(a),Y(b)].sort((p,q)=>q-p);return((x+.05)/(y+.05)).toFixed(2)};
const maxC=(L,h)=>{let c=0;while(inG(L,c+0.001,h))c+=0.001;return c.toFixed(3)};
// need(fg, bg, min, what): throws below min (4.5 text, 3 marks). OKC(L%, C, h): hex, throws outside sRGB.
const need = (fg, bg, min, what) => { const r = +cr(fg, bg); if (r < min) throw new Error(`${what}: ${fg} on ${bg} = ${r} < ${min}`); return r; };
const OKC = (L, C, h) => { if (!inG(L / 100, C, h)) throw new Error(`out of sRGB: oklch(${L}% ${C} ${h})`); return hex(L / 100, C, h); };
const fit = (L, C, h) => OKC(L, +Math.min(C, +maxC(L / 100, h) - 0.002).toFixed(3), h);
module.exports = { hex, fromHex, cr, maxC, inG, need, OKC, fit };
if (require.main === module) {
  console.assert(cr('#ffffff', '#000000') === '21.00', 'contrast');
  console.assert(OKC(42, 0.07, 205) === '#05585f', 'oklch→hex');
  let threw = false; try { OKC(42, 0.2, 205); } catch { threw = true; } console.assert(threw, 'gamut');
  console.log('colour.cjs self-check ok');
}
